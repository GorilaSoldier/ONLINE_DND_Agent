/**
 * 战斗地图主逻辑：数据加载、token 创建、交互状态机、事件绑定、对外 API
 * 状态：idle → selected（选中己方）→ moving（移动中）→ targeting（选目标施放）/ jumping（跳跃落点）
 * 架构（v2 拆分）：
 *   state.js        共享状态（唯一数据源）
 *   rules.js        规则结算（推离/扶起/死亡豁免/先攻/借机）
 *   enemy.js        敌人回合 AI
 *   combat-loop.js  回合推进 + 行动经济 + 胜负判定
 *   combat-ui.js    日志/状态栏/资源条/先攻条/横幅
 *   main.js（本文件）初始化 + 交互事件 + applyResult 结算入口
 */

import { loadMapConfig, loadImage, renderMap, computeMapDimensions, pixelToCell, highlightCells, clearHighlights, cellToPixel } from './map.js';
import { createToken, moveToken, selectToken, deselectToken, updateTokenPosition, getMoveCells, updateTokenHp, spawnFloatingText } from './token.js';
import { calculateReachableCells, filterByRadius, reconstructPath, cellKey } from './movement.js';
import { resolveAttack, resolveSpell, resolveSelfAction, hpMax, hpCur } from './actions.js';
import { combatState, API_BASE, ADVENTURE_ID, CHAPTER_ID } from './state.js';
import { appendCombatLog, currentTurnLabel, updateStatus, updateResourceBar, renderInitiativeBar, addUnconsciousMarker, removeUnconsciousMarker, escapeHtml } from './combat-ui.js';
import { resolveShove, resolveRevive, cellsAdjacent, sleep } from './rules.js';
import { getPlayerToken, trySpendCost, spendCost, playerMoveCellsLeft, actionCostOf, startCombat, endPlayerTurn, endCombat, checkVictory, isTestingMap } from './combat-loop.js';
import { findTokenAt, moveEnemyToward } from './enemy.js';
import { initFog, revealAround, revealAttacker, updateTokenVisibility, isTokenVisible } from './fog.js';
import { CELL_METERS, MELEE_RANGE_CELLS, RANGED_RANGE_CELLS } from './constants.js';
import { applyEquipmentEffects } from '../character/equipment-effects.js';

const S = combatState;

const GLOBAL_NPC_JSON = `${API_BASE}/data/adventures/${ADVENTURE_ID}/global/npcs.json?t=${Date.now()}`;
const NPC_JSON = `${API_BASE}/data/adventures/${ADVENTURE_ID}/chapters/${CHAPTER_ID}/npcs.json?t=${Date.now()}`;
const SPELLS_JSON = `${API_BASE}/data/spells.json?t=${Date.now()}`;

let interactionsSetup = false;

/* ══════════ 数据加载 ══════════ */

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return await res.json();
}

async function loadCombatData() {
  try {
    // 合并全局 + 章节 NPC 数据（与 combat-map.html loadAllData 的合并规则一致）：
    // 战斗模板（goblin-ambusher 的 combat/attacks 等）定义在 global/npcs.json 的 _templates，
    // 章节文件只有实例条目（goblin-ambusher-1 通过 template 字段引用）。
    // 若只读章节文件，模板合并会落空 → 敌人 attacks 为空 → AI 攻击时 TypeError
    const globalData = await loadJson(GLOBAL_NPC_JSON).catch(() => ({}));
    const npcData = await loadJson(NPC_JSON);
    S.npcCatalog = { ...(globalData.npcs || {}), ...(npcData.npcs || {}) };
    S.npcTemplates = { ...(globalData._templates || {}), ...(npcData._templates || {}) };
  } catch (e) { console.warn('加载 NPC 目录失败:', e); S.npcCatalog = {}; }
  try {
    const spellData = await loadJson(SPELLS_JSON);
    S.spellLookup = {};
    const add = (cat) => { if (cat) Object.entries(cat).forEach(([id, s]) => { S.spellLookup[id] = s; }); };
    add(spellData.actions?.normal);
    add(spellData.actions?.class);
    add(spellData.passive);
    add(spellData.cantrips);
    add(spellData.spells?.level_1);
  } catch (e) { console.warn('加载法术目录失败:', e); S.spellLookup = {}; }
  try {
    const eqData = await loadJson(`${API_BASE}/api/equipment`);
    S.equipmentCatalog = eqData || {};
  } catch (e) { console.warn('加载装备目录失败:', e); S.equipmentCatalog = {}; }
}

/* 角色卡装备效果（AC/攻击/照明）统一由 js/character/equipment-effects.js 换算 */

async function loadCharacter(charId) {
  try {
    const res = await fetch(`${API_BASE}/api/characters/${charId}`);
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch (e) {
    console.warn('加载角色失败，使用默认数据:', e);
    return null;
  }
}

/* ══════════ token 创建 ══════════ */

function createPlayerToken(char, spawn) {
  const moveSpeed = char?.background?.attributes?.move_speed || '9m';
  return createToken({
    id: char?.id || 'hero',
    name: char?.name || '英雄',
    portrait: char?.portrait || (char?.name || '英').slice(0, 1),
    faction: 'player',
    col: spawn.col,
    row: spawn.row,
    moveSpeed,
    level: char?.level ?? 1,
    ac: char?.combat?.ac ?? 12,
    hpCur: hpCur(char),
    hpMax: hpMax(char),
    // 死亡豁免（5e RAW）：HP=0 进入昏迷，每回合掷 d20
    //   ≥10 成功 +1 / ≤9 失败 +1 / 自然1 失败 +2 / 自然20 立即回 1 HP 苏醒
    //   3 成功 → 稳定（下回合自动回 1 HP 苏醒）；3 失败 → 死亡
    //   昏迷中受伤 +1 失败；5 尺内近战命中昏迷目标自动暴击 +2 失败
    downed: false, // 是否处于昏迷（HP=0 但未死）
    deathSaves: { successes: 0, failures: 0, stable: false },
  }, S.mapConfig);
}

/** 敌人 token：按 npcId 从 npcCatalog 取数据（支持模板复用）
 *  M6 之前写死 goblin-ambusher-{i+1}，M6 改为接受任意 npcId 参数 */
function createEnemyToken(npcId, spawn, index = 0) {
  const npc = S.npcCatalog[npcId] || { id: npcId, name: npcId };
  // 合并模板基础数据 + 实例数据（实例 name 覆盖模板 name）
  const tmpl = npc.template ? (S.npcTemplates[npc.template] || {}) : {};
  const merged = { ...tmpl, ...npc };
  const combat = merged.combat || {};
  const hp = combat.hp || {};
  const attacks = (combat.attacks || []).map(a => ({
    name: a.name || '攻击',
    bonus: a.bonus || 0,
    damage: a.damage || '1d4',
    type: a.type || '挥砍',
    kind: a.kind || null,        // 'melee' | 'ranged'（数据驱动 AI 选攻击，不再按武器名硬编码）
  }));
  return createToken({
    id: npcId,
    name: merged.name || `地精${index + 1}`,
    // 不传 portrait：token.js 自动取 name 首字（斯/格/克/弗，个体名区分）
    faction: 'enemy',
    col: spawn.col,
    row: spawn.row,
    moveSpeed: combat.move_speed || '9m',
    level: combat.level ?? 1,
    hpCur: hp.cur ?? 7,
    hpMax: hp.max ?? 7,
    ac: combat.ac ?? 15,
    attacks,
    npcId,
  }, S.mapConfig);
}

/* ══════════ 范围与目标高亮 ══════════ */

/* ── 移动范围（复用原有逻辑；玩家战斗中按剩余移动力） ── */
function showMovementRange(token) {
  const moveCells = token.data.faction === 'player'
    ? playerMoveCellsLeft(token)
    : getMoveCells(token);
  if (moveCells <= 0.01) {
    S.currentRange = new Map();
    clearHighlights(S.layers.highlightLayer);
    return;
  }
  const radiusCells = moveCells;
  const reachable = calculateReachableCells(
    { col: token.data.col, row: token.data.row },
    moveCells,
    S.mapConfig.obstacleSet,
    S.mapConfig.grid_cols,
    S.mapConfig.grid_rows
  );
  S.currentRange = filterByRadius(reachable, { col: token.data.col, row: token.data.row }, radiusCells);
  // 被任何 token 占据的格不显示蓝色（不可达）；仅为显示排除，不重算路径
  for (const t of S.tokens) {
    if (t.data.dead) continue;
    const key = cellKey(t.data.col, t.data.row);
    if (key !== cellKey(token.data.col, token.data.row)) S.currentRange.delete(key);
  }
  highlightCells(S.layers.highlightLayer, S.currentRange, S.mapConfig);
}

/**
 * 显示指定半径的范围圆（半径以"格"为单位）
 * @param {string} color css 颜色（默认红色 = 攻击/法术射程）
 */
function showRangeCircleBy(token, radiusCells, color = 'rgba(196, 75, 75, 0.75)') {
  hideRangeCircle();
  const cellW = S.mapConfig.widthPx / S.mapConfig.grid_cols;
  const cellH = S.mapConfig.heightPx / S.mapConfig.grid_rows;
  // 半径 = (格数 + 0.5) × 格宽：圆心在 token 格中心，补半格让圆恰好触及第 n 格的外边界
  // （只乘 1 倍时圆只画到相邻格中心，视觉上仅覆盖半格）
  const rx = (radiusCells + 0.5) * cellW;
  const ry = (radiusCells + 0.5) * cellH;
  const pos = cellToPixel(S.mapConfig, token.data.col, token.data.row);

  const el = document.createElement('div');
  el.className = 'range-circle';
  el.style.cssText = `
    position: absolute;
    left: ${pos.x - rx}px;
    top: ${pos.y - ry}px;
    width: ${rx * 2}px;
    height: ${ry * 2}px;
    border-radius: 50%;
    border: 2px dashed ${color};
    background: rgba(196, 75, 75, 0.05);
    pointer-events: none;
    z-index: 4;
  `;
  document.getElementById('combat-map-container').appendChild(el);
  S.rangeCircle = el;
}

function showRangeCircle(token) {
  const moveCells = token.data.faction === 'player'
    ? playerMoveCellsLeft(token)
    : getMoveCells(token);
  showRangeCircleBy(token, moveCells);
}

function hideRangeCircle() {
  if (S.rangeCircle) {
    S.rangeCircle.remove();
    S.rangeCircle = null;
  }
}

/* ── 目标高亮（可点击敌人加红圈） ── */
function clearTargetables() {
  for (const t of S.targetableTokens) {
    if (t.circle) t.circle.style.boxShadow = '';
  }
  S.targetableTokens = [];
}

function showTargetables() {
  clearTargetables();
  if (!S.pendingAction || !S.selectedToken) return;
  const radiusCells = getActionRangeCells(S.pendingAction);
  // 判定是否为自身/友善目标法术（触碰治疗、增益等可对自己施放）
  const spell = S.pendingAction.type === 'spell' ? S.spellLookup[S.pendingAction.spellId] : null;
  const selfTargetable = spell && (spell.range === '触碰' || spell.range === '自身');
  // 治疗法术（effect 以 "heal" 开头）只针对自己/队友；扶起队友（"revive"）只针对倒地队友；
  // 伤害法术/攻击只针对敌人
  // 原实现不区分治疗/伤害，导致治愈术高亮敌人 → 玩家可对敌人"加血"（错误）
  const effectStr = String(spell?.effect || '').trim().toLowerCase();
  const isHealSpell = effectStr.startsWith('heal');
  const isReviveSpell = effectStr.startsWith('revive');
  // 扶起队友：不能对自己（自己倒地时无法动作），只能对倒地且未死的己方
  const selfCastable = selfTargetable && !isReviveSpell;
  for (const t of S.tokens) {
    // 雾中敌人不可选中（不渲染/不可点/不可为目标）
    if (t.data.faction === 'enemy' && !isTokenVisible(t)) continue;
    if (t === S.selectedToken) {
      // 自身目标法术（治愈术触碰等）可对自己施放（但扶起队友不可）
      if (selfCastable) {
        t.circle.style.boxShadow = '0 0 0 3px rgba(126, 237, 159, 0.9), 0 0 12px rgba(126, 237, 159, 0.6)';
        S.targetableTokens.push(t);
      }
      continue;
    }
    // 治疗法术：高亮己方/友军；扶起队友：高亮倒地且未死的己方；伤害法术/攻击：高亮敌人
    const isAlly = t.data.faction === 'player' || t.data.faction === 'ally';
    if (isHealSpell) {
      if (!isAlly) continue; // 治疗只针对己方
    } else if (isReviveSpell) {
      // 扶起队友：只针对倒地未死的己方（活着的不需要扶，死了的扶不起来）
      if (!isAlly) continue;
      if (!t.data.downed || t.data.dead) continue;
    } else {
      if (t.data.faction !== 'enemy') continue; // 伤害/攻击只针对敌人
    }
    const dc = Math.abs(t.data.col - S.selectedToken.data.col);
    const dr = Math.abs(t.data.row - S.selectedToken.data.row);
    // 5e 网格：≤1 格射程（近战/触碰/推离）含 8 方向相邻（含斜角，Chebyshev 距离 ≤ 1）
    //          > 1 格射程按欧氏距离圆判定（与法术球面半径一致）
    // 原实现用 Math.hypot 判 ≤1，导致斜角相邻敌人（dist=√2≈1.414）漏掉，推离/近战打不到
    const inRange = radiusCells <= 1
      ? (Math.max(dc, dr) <= 1 && (dc + dr > 0))
      : (Math.hypot(dc, dr) <= radiusCells + 1e-6);
    if (inRange) {
      // 治疗目标用绿色高亮；伤害目标用红白高亮（区分视觉）
      t.circle.style.boxShadow = isHealSpell
        ? '0 0 0 3px rgba(126, 237, 159, 0.9), 0 0 12px rgba(126, 237, 159, 0.6)'
        : '0 0 0 3px rgba(255, 255, 255, 0.9), 0 0 12px rgba(255, 80, 80, 0.9)';
      S.targetableTokens.push(t);
    }
  }
  if (S.targetableTokens.length === 0) {
    updateStatus('射程内没有可作用的目标');
  }
}

/* ── 动作射程（米 → 格） ── */
function getActionRangeCells(action) {
  if (action.type === 'attack') {
    // 射程归一化为全局常量（近战 1 格 / 远程 6 格），不再读角色卡 melee_range/ranged_range
    return action.kind === 'melee' ? MELEE_RANGE_CELLS : RANGED_RANGE_CELLS;
  }
  if (action.type === 'spell') {
    const spell = S.spellLookup[action.spellId];
    if (spell?.id === 'shove') return 1; // 推离：近战距离 1 格
    const range = String(spell?.range || '').trim();
    if (range === '触碰') return 1;
    if (range === '自身') return 0;
    const m = range.match(/(\d+(?:\.\d+)?)\s*米?/);
    return m ? parseFloat(m[1]) / CELL_METERS : 0;
  }
  return 0;
}

/* ══════════ 结算（applyResult：所有伤害/治疗/状态落地的统一入口） ══════════ */
function applyResult(result, targetToken, options = {}) {
  // options.attackKind: 'melee' | 'ranged' | 'spell' | undefined（默认致命）
  // options.attacker: 攻击者 token（用于判断是否玩家发起）
  const { attackKind, attacker } = options;
  // 伤害 → 扣目标 HP + 飘字
  if (result.damage > 0 && targetToken) {
    const wasDowned = targetToken.data.downed === true && !targetToken.data.dead;
    targetToken.data.hpCur = Math.max(0, (targetToken.data.hpCur ?? 0) - result.damage);
    updateTokenHp(targetToken);
    spawnFloatingText(targetToken, `-${result.damage}`, '#ff6b6b');

    // 玩家走死亡豁免流程；敌人保持 HP=0 即死（杂兵惯例）
    if (targetToken.data.faction === 'player') {
      if (targetToken.data.hpCur <= 0 && !targetToken.data.dead) {
        if (!wasDowned) {
          // 首次倒下：进入昏迷，初始化死亡豁免计数
          targetToken.data.downed = true;
          targetToken.data.deathSaves = { successes: 0, failures: 0, stable: false };
          targetToken.element.style.opacity = '0.55';
          renderInitiativeBar();
          appendCombatLog(`${targetToken.data.name} 倒下，进入昏迷状态！`, 'system', currentTurnLabel());
        } else {
          // 昏迷中受伤：失败 +1，暴击（含 5 尺近战昏迷自动暴击）+2
          const ds = targetToken.data.deathSaves || (targetToken.data.deathSaves = { successes: 0, failures: 0, stable: false });
          // 5e RAW：稳定状态下受伤 → 失去稳定状态，恢复死亡豁免流程
          if (ds.stable) {
            ds.stable = false;
            appendCombatLog(`${targetToken.data.name} 稳定状态被伤害打断`, 'system', currentTurnLabel());
          }
          const add = result.crit ? 2 : 1;
          ds.failures += add;
          appendCombatLog(`${targetToken.data.name} 昏迷中受伤，死亡豁免失败 +${add}（累计 ${ds.failures}/3）`, 'system', currentTurnLabel());
          if (ds.failures >= 3) {
            targetToken.data.dead = true;
            targetToken.data.downed = false;
            targetToken.element.style.opacity = '0.35';
            renderInitiativeBar();
            appendCombatLog(`${targetToken.data.name} 死亡豁免失败累计 3 次，已经死亡...`, 'system', currentTurnLabel());
            // 玩家死亡 → 战斗败北
            setTimeout(() => endCombat(false), 1200);
          }
        }
      }
    } else {
      // 敌人：HP=0 默认死亡（杂兵惯例），但非致命开关 ON + 近战 + 玩家发起 → 强制昏迷
      if (targetToken.data.hpCur <= 0) {
        const useNonlethal = S.nonlethalEnabled
          && attackKind === 'melee'
          && attacker?.data?.faction === 'player'
          && targetToken.data.faction !== 'player';
        if (useNonlethal) {
          // 非致命打击：留 1 滴血昏迷
          targetToken.data.hpCur = 1;
          targetToken.data.dead = false;
          targetToken.data.downed = true;
          targetToken.data.unconscious = true;  // 昏迷标记（区别于倒地玩家）
          targetToken.element.style.opacity = '0.55';
          addUnconsciousMarker(targetToken);
          updateTokenHp(targetToken);
          renderInitiativeBar();
          appendCombatLog(`${targetToken.data.name} 被非致命打击击倒，陷入昏迷（留 1 HP）！`, 'system', currentTurnLabel());
        } else {
          targetToken.element.style.opacity = '0.35';
          targetToken.data.dead = true;
          renderInitiativeBar(); // 头像条标记死亡变灰
        }
      }
    }
  }
  // 治疗 → 加目标 HP + 飘字（targetToken 为治疗目标，可能是自己或队友）
  const healTarget = targetToken || S.selectedToken;
  if (result.heal > 0 && healTarget) {
    healTarget.data.hpCur = Math.min(
      healTarget.data.hpMax ?? 100,
      (healTarget.data.hpCur ?? 0) + result.heal
    );
    updateTokenHp(healTarget);
    spawnFloatingText(healTarget, `+${result.heal}`, '#7bed9f');
    // 玩家昏迷中治疗 → 苏醒，重置死亡豁免计数（5e RAW：任何治疗即苏醒）
    if (healTarget.data.faction === 'player'
        && healTarget.data.downed && !healTarget.data.dead
        && healTarget.data.hpCur > 0) {
      healTarget.data.downed = false;
      healTarget.data.deathSaves = { successes: 0, failures: 0, stable: false };
      healTarget.element.style.opacity = '1';
      renderInitiativeBar();
      // BG3：被治疗苏醒，本回合只能用附赠动作（仅当被治疗者正在当前回合行动时）
      if (healTarget === S.selectedToken && S.combatPhase === 'player') {
        S.turnResources.justRevived = true;
        S.turnResources.action = 0;
        S.turnResources.moveLeft = 0;
        updateResourceBar();
      }
      appendCombatLog(`${healTarget.data.name} 受治疗苏醒！HP=${healTarget.data.hpCur}（本回合只能使用附赠动作）`, 'heal', currentTurnLabel());
    }
  }
  updateStatus(result.text || '');
  // 写入战斗日志
  if (result.text) {
    let logType = 'system';
    if (result.heal > 0) logType = 'heal';
    else if (result.damage > 0) logType = (result.crit || result.d20 === 20) ? 'crit' : 'attack';
    appendCombatLog(result.text, logType, currentTurnLabel());
  }
  // 通知右侧面板刷新
  if (window.__combatApi && typeof window.__combatApi.onResolve === 'function') {
    window.__combatApi.onResolve(result);
  }
  // 玩家击杀最后一只敌人 → 胜利
  if (S.combatPhase !== 'idle') {
    checkVictory();
  }
}

function executePendingAction(targetToken) {
  const char = S.selectedToken?.data?.character;
  if (!char) return;
  if (!trySpendCost(S.pendingAction)) {
    cancelTargeting();
    return;
  }

  if (S.pendingAction.type === 'attack') {
    const target = { name: targetToken.data.name, combat: { ac: targetToken.data.ac ?? 15 } };
    spendCost(S.pendingAction);
    const result = resolveAttack(char, target, S.pendingAction.kind);
    applyResult(result, targetToken, { attackKind: S.pendingAction.kind, attacker: S.selectedToken });
    // 额外攻击被动（Extra Attack，5 级战士）：攻击动作额外结算一次，不另耗动作
    if ((parseInt(char.level, 10) || 1) >= 5 && !targetToken.data.dead) {
      const extra = resolveAttack(char, target, S.pendingAction.kind);
      applyResult(extra, targetToken, { attackKind: S.pendingAction.kind, attacker: S.selectedToken });
    }
    return;
  }

  if (S.pendingAction.type === 'spell') {
    const spell = S.spellLookup[S.pendingAction.spellId];
    // 推离：力量对抗检定，成功推远 1 格
    if (spell.id === 'shove') {
      spendCost(S.pendingAction);
      resolveShove(S.selectedToken, targetToken);
      return;
    }
    // 扶起队友（help_downed，effect: revive）：触碰倒地己方，恢复 1HP 苏醒
    if (spell.id === 'help_downed' || String(spell.effect || '').toLowerCase().startsWith('revive')) {
      spendCost(S.pendingAction);
      resolveRevive(S.selectedToken, targetToken);
      return;
    }
    const target = targetToken ? { name: targetToken.data.name, combat: { ac: targetToken.data.ac ?? 15 } } : null;
    const result = resolveSpell(spell, char, target);
    spendCost(S.pendingAction);
    // 法术不消耗法术位（第一版简化，后续接后端）
    if (result) applyResult(result, targetToken);
  }
}

function useSelfAction(action) {
  const char = S.selectedToken?.data?.character;
  if (!char) return;
  // 动作如潮（fighting_spirit）：自由动作，但每战斗 1 次。先校验次数
  if (action.id === 'fighting_spirit' && S.combatPhase !== 'idle' && S.turnResources.actionSurgeUsed) {
    updateStatus('动作如潮每场战斗只能使用一次');
    return;
  }
  if (!trySpendCost(action)) return;
  if (action.id === 'second_wind' && S.combatPhase !== 'idle' && S.turnResources.secondWindUsed) {
    updateStatus('回气每场战斗只能使用一次');
    return;
  }
  if (action.id === 'jump') {
    startJump(char); // 跳跃在落点成功时才扣附赠动作 + 移动力
    return;
  }
  spendCost(action);
  if (action.id === 'second_wind') S.turnResources.secondWindUsed = true;
  const result = resolveSelfAction(action, char);
  // 动作如潮：本回合获得 1 个额外动作（不消耗动作/附赠，自由动作）
  if (result.actionSurge) {
    S.turnResources.actionSurgeUsed = true;
    S.turnResources.action += 1;
    updateResourceBar();
    // 重新计算按钮置灰（攻击等动作按钮恢复可点）
    if (typeof window.__combatApi?.onTurnChanged === 'function') {
      window.__combatApi.onTurnChanged({ ...S.turnResources });
    }
  }
  if (result.dash) {
    // 冲刺（动作）：额外获得一倍移动力（RAW Dash），已消耗的移动力不返还
    S.turnResources.moveLeft += S.turnResources.moveBase;
    updateResourceBar();
    showMovementRange(S.selectedToken);
    hideRangeCircle();
    showRangeCircle(S.selectedToken);
  }
  applyResult(result, null);
}

/* ══════════ 跳跃 ══════════ */

/**
 * 跳跃：进入落点选择状态。
 * D&D 5e 远跳 = 力量值英尺（每格 5 英尺），无视障碍直达落点。
 */
/* 跳跃路径走过哪些障碍类型允许跨过（白名单）。目前只允许 water，后续可扩（在 Plan 文档登记） */
const JUMP_CROSSABLE = new Set(['water']);
const OBSTACLE_KIND_LABEL = { water: '水', wall: '墙', tree: '树', rock: '岩石', background: '背景' };
function obstacleKindAt(mc, col, row) {
  for (const o of mc.obstacles || []) {
    if (o.col === col && o.row === row) return o.kind || 'wall';
  }
  return null;
}
/** Bresenham 直线沿途格子（含起点与终点），用于判定跳跃路径上是否夹着不可跨障碍 */
function bresenhamLine(x0, y0, x1, y1) {
  const cells = [];
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cells.push({ col: x0, row: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return cells;
}
/** 统一"落点能否站上去"判定：障碍 或 被其他 token 占据 → 返回原因；可站 → null。走路/跳跃/后续传送共用。 */
function getStandableBlockReason(col, row, selfToken = null) {
  if (S.mapConfig.obstacleSet.has(cellKey(col, row))) return '落点是障碍物，无法站立';
  const t = findTokenAt(col, row);
  if (t && t !== selfToken && !t.data.dead) return '落点已被其他生物占据';
  return null;
}
/** 跳跃路径检查：中途只允许跨可跨障碍（当前仅 water），返回 null 表示可通过 */
function jumpPathAllowed(col, row) {
  const { col: sc, row: sr } = S.selectedToken.data;
  const pathCells = bresenhamLine(sc, sr, col, row);
  for (let i = 1; i < pathCells.length - 1; i++) { // 去起点与落点
    const kind = obstacleKindAt(S.mapConfig, pathCells[i].col, pathCells[i].row);
    if (kind && !JUMP_CROSSABLE.has(kind)) {
      return `跳跃路径上有${OBSTACLE_KIND_LABEL[kind] || kind}阻挡，无法跳过`;
    }
  }
  return null;
}
/** 跳跃落点选择期间禁用 token 点击拦截（token 命中区过大可能吞掉落点点击） */
function setTokensClickable(clickable) {
  for (const t of S.tokens) {
    t.element.style.pointerEvents = clickable ? '' : 'none';
  }
}

function startJump(char) {
  // 跳跃 = 附赠动作 + 消耗移动力：先做预算校验（附赠在 useSelfAction 已校验）
  if (S.combatPhase !== 'idle' && S.turnResources.moveLeft < CELL_METERS) {
    updateStatus('移动力不足，无法跳跃');
    return;
  }
  const str = parseInt(((char.abilities || {}).str || {}).value ?? 10, 10);
  S.jumpRangeCells = Math.max(1, Math.round(str / 5)); // 力量17 → 3 格
  S.state = 'jumping';
  S.pendingAction = null;
  clearTargetables();
  hideRangeCircle();
  setTokensClickable(false);
  // 蓝色高亮跳跃落点范围：真正能跳过去的才亮（落点可站 + 路径只跨可跨障碍）
  const range = new Map();
  const { col, row } = S.selectedToken.data;
  for (let c = 0; c < S.mapConfig.grid_cols; c++) {
    for (let r = 0; r < S.mapConfig.grid_rows; r++) {
      const d = Math.hypot(c - col, r - row);
      if (d > S.jumpRangeCells + 1e-6) continue;
      if (getStandableBlockReason(c, r, S.selectedToken)) continue; // 落点是障碍/被占 → 不亮
      if (jumpPathAllowed(c, r)) continue; // 路径夹不可跨障碍 → 不亮
      range.set(cellKey(c, r), { col: c, row: r });
    }
  }
  highlightCells(S.layers.highlightLayer, range, S.mapConfig);
  updateStatus(`${S.selectedToken.data.name} 选择跳跃落点（${S.jumpRangeCells} 格内，蓝色为可落点）`);
}

async function doJump(col, row) {
  if (!S.selectedToken || S.state !== 'jumping') return;
  const dist = Math.hypot(col - S.selectedToken.data.col, row - S.selectedToken.data.row);
  if (dist > S.jumpRangeCells + 1e-6) return;
  // 跳跃路径检查：中途经过的格子只能为可跨障碍（当前仅 water）；墙/树/岩/背景之类高障碍不可跳过
  const pathCells = bresenhamLine(S.selectedToken.data.col, S.selectedToken.data.row, col, row);
  for (let i = 1; i < pathCells.length - 1; i++) { // 去掉起点与落点（落点另有障碍检查）
    const pc = pathCells[i];
    const kind = obstacleKindAt(S.mapConfig, pc.col, pc.row);
    if (kind && !JUMP_CROSSABLE.has(kind)) {
      updateStatus(`跳跃路径上有${OBSTACLE_KIND_LABEL[kind] || kind}阻挡，无法跳过`);
      return;
    }
  }
  // 落点不能是障碍格（跳越障碍，但不落在树上/岩石里）或已被其他生物占据
  if (S.mapConfig.obstacleSet.has(cellKey(col, row))) {
    updateStatus('落点是障碍物，无法站立');
    return;
  }
  const occupier = findTokenAt(col, row);
  if (occupier && occupier !== S.selectedToken) {
    updateStatus('落点已被其他生物占据');
    return;
  }
  // 跳跃消耗移动力 = 路径格数 × 每格米数（直步=1 格，斜步=1.5 格，与移动一致）
  let costCells = 0;
  for (let i = 1; i < pathCells.length; i++) {
    const pa = pathCells[i - 1], pb = pathCells[i];
    costCells += (pa.col !== pb.col && pa.row !== pb.row) ? 1.5 : 1;
  }
  const costM = costCells * CELL_METERS;
  if (S.combatPhase !== 'idle' && costM > S.turnResources.moveLeft + 1e-6) {
    updateStatus(`移动力不足，跳不过去（需 ${costM.toFixed(1)} 米）`);
    return;
  }

  S.state = 'moving';
  hideRangeCircle();
  setTokensClickable(true);
  updateStatus(`${S.selectedToken.data.name} 跳跃中...`);
  // 跳跃无视障碍，直接移动到落点
  await moveToken(S.selectedToken, col, row, S.mapConfig, 320);
  revealAround(); // 落点视野揭示
  // 落点成功：扣附赠动作 + 移动力
  if (S.combatPhase !== 'idle') {
    S.turnResources.bonus = Math.max(0, S.turnResources.bonus - 1);
    S.turnResources.moveLeft = Math.max(0, S.turnResources.moveLeft - costM);
    updateResourceBar();
  }
  select(S.selectedToken); // 保持选中，恢复移动范围
  updateStatus(`${S.selectedToken.data.name} 跳跃完成`);
}

function cancelJump() {
  if (S.state !== 'jumping') return;
  hideRangeCircle();
  setTokensClickable(true);
  select(S.selectedToken);
}

/* ══════════ 选中 / 取消 / 目标状态 ══════════ */

function select(token) {
  if (S.selectedToken) deselectToken(S.selectedToken);
  S.selectedToken = token;
  selectToken(token);
  showRangeCircle(token);
  showMovementRange(token);
  S.state = 'selected';
  S.pendingAction = null;
  clearTargetables();
  updateStatus(`已选中 ${token.data.name}，点击蓝色高亮格移动，或在右侧选择动作`);
}

function deselect() {
  if (S.selectedToken) {
    deselectToken(S.selectedToken);
    S.selectedToken = null;
  }
  S.currentRange = new Map();
  clearHighlights(S.layers.highlightLayer);
  hideRangeCircle();
  clearTargetables();
  S.pendingAction = null;
  S.state = 'idle';
  updateStatus('点击己方 token 查看移动范围');
}

/** 供 combat-loop.endCombat 调用：清空高亮（跨模块导出包装） */
function clearAllHighlights() {
  clearHighlights(S.layers.highlightLayer);
}

/* ── 进入选目标状态 ── */
function enterTargeting(action) {
  if (S.state === 'moving') return;
  if (!S.selectedToken) return;
  S.pendingAction = action;
  S.state = 'targeting';
  // 保留移动范围高亮（便于同时看移动），叠加射程圆 + 目标高亮
  const radiusCells = getActionRangeCells(action);
  if (radiusCells > 0) {
    hideRangeCircle();
    showRangeCircleBy(S.selectedToken, radiusCells);
  }
  showTargetables();
  const label = action.type === 'spell'
    ? (S.spellLookup[action.spellId]?.name || action.spellId)
    : (action.kind === 'melee' ? '近战攻击' : '远程攻击');
  const isShove = action.type === 'spell' && action.spellId === 'shove';
  updateStatus(isShove
    ? `${S.selectedToken.data.name} 选择【推离】，点击相邻敌人将其推远 1 格`
    : `${S.selectedToken.data.name} 选择【${label}】，点击红色高亮目标`);
}

function cancelTargeting(keepMessage) {
  if (S.state !== 'targeting') return;
  S.pendingAction = null;
  clearTargetables();
  hideRangeCircle();
  showRangeCircle(S.selectedToken);
  showMovementRange(S.selectedToken);
  S.state = 'selected';
  if (!keepMessage) {
    updateStatus(`已选中 ${S.selectedToken.data.name}，可移动或选择动作`);
  }
}

/* ══════════ 点击处理（移动/借机攻击） ══════════ */
async function doMove(targetCol, targetRow) {
  if (!S.selectedToken) return;
  const targetKey = cellKey(targetCol, targetRow);
  if (!S.currentRange.has(targetKey)) return;

  const path = reconstructPath(S.currentRange, { col: targetCol, row: targetRow });
  if (path.length < 2) return;
  // 路径成本（格，含斜步 1.5）→ 米，扣移动力预算
  const costCells = S.currentRange.get(targetKey)?.cost ?? 0;

  // 记录起点（用于借机攻击检测：移动前与 selectedToken 相邻的敌人）
  const startCol = S.selectedToken.data.col;
  const startRow = S.selectedToken.data.row;
  const adjEnemiesBefore = (S.combatPhase !== 'idle' && !S.selectedToken.data._shovedAway)
    ? S.tokens.filter(t => t.data.faction !== S.selectedToken.data.faction && !t.data.dead && cellsAdjacent(startCol, startRow, t.data.col, t.data.row))
    : [];

  S.state = 'moving';
  hideRangeCircle();
  clearTargetables();
  S.pendingAction = null;
  updateStatus(`${S.selectedToken.data.name} 移动中...`);

  const { triggerOpportunityAttack } = await import('./rules.js');
  for (let i = 1; i < path.length; i++) {
    await moveToken(S.selectedToken, path[i].col, path[i].row, S.mapConfig, 180);
    // 逐格揭示迷雾：每走一步视野跟随展开
    revealAround();
    // 逐格检测：本步是否离开了某个原本相邻的敌人 → 触发借机攻击
    if (adjEnemiesBefore.length > 0) {
      const stillAdj = adjEnemiesBefore.filter(t => !t.data.dead && cellsAdjacent(S.selectedToken.data.col, S.selectedToken.data.row, t.data.col, t.data.row));
      const left = adjEnemiesBefore.filter(t => !t.data.dead && !stillAdj.includes(t));
      for (const ao of left) {
        await triggerOpportunityAttack(ao, S.selectedToken);
      }
      // 清除已触发的敌人，避免重复触发
      adjEnemiesBefore.length = 0;
      adjEnemiesBefore.push(...stillAdj);
    }
  }
  // 清理推离标记（推离只在被推的那次移动豁免）
  delete S.selectedToken.data._shovedAway;

  if (S.combatPhase !== 'idle') {
    S.turnResources.moveLeft = Math.max(0, S.turnResources.moveLeft - costCells * CELL_METERS);
    updateResourceBar();
  }
  // 保持选中：支持「移动 → 攻击 → 再移动」拆分（剩余预算见资源条）
  select(S.selectedToken);
  updateStatus(`移动完成（剩余移动力 ${Math.round(S.turnResources.moveLeft * 10) / 10} 米）`);
  if (S.combatPhase !== 'idle') {
    appendCombatLog(`${S.selectedToken.data.name} 移动 ${costCells} 格（剩余 ${Math.round(S.turnResources.moveLeft * 10) / 10}m）`, 'move', currentTurnLabel());
  }
}

function handleMapClick(e) {
  if (S.state === 'moving') return;
  // 非玩家回合禁止操作
  if (S.combatPhase !== 'idle' && S.combatPhase !== 'player') return;

  const container = document.getElementById('combat-map-container');
  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cell = pixelToCell(S.mapConfig, x, y);

  if (cell.col < 0 || cell.col >= S.mapConfig.grid_cols || cell.row < 0 || cell.row >= S.mapConfig.grid_rows) {
    if (S.state === 'targeting') cancelTargeting();
    else if (S.state === 'jumping') cancelJump();
    else deselect();
    return;
  }

  // 点击的格子上有 token
  const tokenOnCell = findTokenAt(cell.col, cell.row);

  if (S.state === 'jumping') {
    // 跳跃：点击任意落点（可落在敌人/障碍格上，到达后处理），点空白或范围内则跳跃
    const dist = Math.hypot(cell.col - S.selectedToken.data.col, cell.row - S.selectedToken.data.row);
    if (dist <= S.jumpRangeCells + 1e-6) {
      doJump(cell.col, cell.row);
    } else {
      cancelJump();
    }
    return;
  }

  if (S.state === 'targeting') {
    if (tokenOnCell && S.targetableTokens.includes(tokenOnCell)) {
      // 允许点自己 token（治愈术等自身目标法术）或点敌人
      executePendingAction(tokenOnCell);
      cancelTargeting(true); // 保留结算文字
    } else {
      cancelTargeting();
    }
    return;
  }

  // 如果点击的格子上有一名己方 token，优先选中它
  if (tokenOnCell && tokenOnCell.data.faction === 'player') {
    if (S.selectedToken !== tokenOnCell) {
      if (S.selectedToken) deselect();
      select(tokenOnCell);
    } else {
      deselect();
    }
    return;
  }

  if (S.state === 'selected') {
    const key = cellKey(cell.col, cell.row);
    if (S.currentRange.has(key)) {
      doMove(cell.col, cell.row);
    } else {
      deselect();
    }
  }
}

function handleTokenClick(token) {
  if (S.state === 'moving') return;
  if (S.combatPhase !== 'idle' && S.combatPhase !== 'player') return;
  if (S.state === 'jumping') {
    // 跳跃落点选在 token 所在格：跳到该 token 旁或直接落点
    const dist = Math.hypot(token.data.col - S.selectedToken.data.col, token.data.row - S.selectedToken.data.row);
    if (dist <= S.jumpRangeCells + 1e-6) {
      doJump(token.data.col, token.data.row);
    } else {
      cancelJump();
    }
    return;
  }
  // targeting 状态：点击 targetableTokens 中的任意 token（含自己 — 触碰法术自疗）触发结算
  // 原实现只匹配 faction === 'enemy'，导致治愈术点击玩家自身 token 落到下面 deselect 分支，
  // 不触发 executePendingAction → 自疗完全无效
  if (S.state === 'targeting' && S.targetableTokens.includes(token)) {
    executePendingAction(token);
    cancelTargeting(true); // 保留结算文字
    return;
  }
  if (token.data.faction !== 'player') {
    if (S.selectedToken && S.state !== 'targeting') deselect();
    return;
  }
  if (S.selectedToken === token) {
    deselect();
    return;
  }
  select(token);
}

/* ══════════ 初始化 ══════════ */

function setupInteractions() {
  if (interactionsSetup) return;
  interactionsSetup = true;

  const container = document.getElementById('combat-map-container');
  if (container) {
    container.addEventListener('click', handleMapClick);
  }

  window.addEventListener('resize', () => {
    initMap();
  });
}

function attachTokenClick(token) {
  token.element.addEventListener('click', (e) => {
    e.stopPropagation();
    handleTokenClick(token);
  });
}

function renderTokens() {
  for (const token of S.tokens) {
    updateTokenPosition(token, S.mapConfig);
    updateTokenHp(token);
    S.layers.tokenLayer.appendChild(token.element);
  }
}

async function initMap() {
  const container = document.getElementById('combat-map-container');
  if (!container) return;

  try {
    // M6：从 URL 参数读取遭遇上下文（无参数时回退到调试模式）
    const params = new URLSearchParams(window.location.search);
    const encounterId = params.get('encounter');
    if (encounterId) {
      try {
        const raw = sessionStorage.getItem('encounterContext');
        if (raw) S.encounterContext = JSON.parse(raw);
      } catch (e) { console.warn('读取 encounterContext 失败:', e); }
    }

    const mapId = S.encounterContext?.mapId || 'cragmaw-hideout-overview';
    if (!S.mapConfig) {
      S.mapConfig = await loadMapConfig(mapId);
    }

    await loadCombatData();

    const img = await loadImage(S.mapConfig.image);
    const wrapper = container.parentElement;
    const dims = computeMapDimensions(
      img.naturalWidth,
      img.naturalHeight,
      wrapper.clientWidth - 48,
      wrapper.clientHeight - 48
    );

    S.layers = renderMap(container, S.mapConfig, dims.widthPx, dims.heightPx);
    // 探索迷雾：地图 JSON 有 fog_zones 才启用（挂最上层黑幕；resize 重建幂等）
    initFog(S.mapConfig, container);

    if (S.tokens.length === 0) {
      // M6：玩家角色 id 优先从 encounterContext.playerSnapshot.charId 取（默认 elias）
      const charId = S.encounterContext?.playerSnapshot?.charId || 'elias';
      const char = await loadCharacter(charId);
      applyEquipmentEffects(char, S.equipmentCatalog);
      // M6：用玩家快照中的 HP/AC 覆盖角色数据（保证战斗地图与冒险流程状态同步）
      if (S.encounterContext?.playerSnapshot) {
        const ps = S.encounterContext.playerSnapshot;
        char.combat = char.combat || { ac: 10, hp: '0 / 0' };
        char.combat.ac = ps.ac || char.combat.ac;
        char.combat.hp = `${ps.hpCur} / ${ps.hpMax}`;
      }
      const playerSpawn = S.mapConfig.spawns.players[0];
      const playerToken = createPlayerToken(char, playerSpawn);
      playerToken.data.character = char;
      S.tokens.push(playerToken);
      attachTokenClick(playerToken);

      // M6：敌人列表优先用 encounterContext.enemies；回退到调试模式 4 只地精
      const enemyIds = S.encounterContext?.enemies || ['goblin-ambusher-1', 'goblin-ambusher-2', 'goblin-ambusher-3', 'goblin-ambusher-4'];
      enemyIds.forEach((npcId, i) => {
        const spawn = S.mapConfig.spawns.enemies[i] || S.mapConfig.spawns.enemies[S.mapConfig.spawns.enemies.length - 1];
        if (!spawn) return; // spawn 不够则跳过
        const enemyToken = createEnemyToken(npcId, spawn, i);
        S.tokens.push(enemyToken);
        attachTokenClick(enemyToken);
      });
    }

    renderTokens();
    setupInteractions();
    // 迷雾启用时：以玩家出生位置为光源做首次揭示
    revealAround();
    // M6：战斗准备文案显示遭遇名（若有）
    const prepText = S.encounterContext?.encounterName
      ? `遭遇：${S.encounterContext.encounterName}，掷先攻中...`
      : '战斗准备中，掷先攻...';
    updateStatus(prepText);
    bindEndTurnButton();
    setTimeout(() => startCombat(), 500);
  } catch (e) {
    console.error('初始化战斗地图失败:', e);
    updateStatus('加载失败: ' + e.message);
  }
}

function bindEndTurnButton() {
  const btn = document.getElementById('btn-end-turn');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', endPlayerTurn);
}

/** 若当前未选中 token，自动选中己方玩家 token（战斗地图只操控一个玩家） */
function ensurePlayerSelected() {
  if (S.selectedToken) return;
  const playerToken = S.tokens.find(t => t.data.faction === 'player');
  if (playerToken) select(playerToken);
}

/* ══════════ 对外 API（供 combat-map.html 右侧动作面板调用） ══════════ */
window.__combatApi = {
  /** 选择需要目标的操作：attack(melee/ranged) / spell(spellId)。无需先点角色，自动选中己方 token */
  selectAction(action) {
    if (S.combatPhase !== 'idle' && S.combatPhase !== 'player') {
      updateStatus('敌人回合中，请等待');
      return;
    }
    if (!trySpendCost(action)) return; // 动作/附赠预算校验
    ensurePlayerSelected();
    if (!S.selectedToken) {
      updateStatus('请先点击自己的 token');
      return;
    }
    enterTargeting(action);
  },
  cancelAction() {
    if (S.state === 'jumping') cancelJump();
    else cancelTargeting();
  },
  /** 自身目标动作：jump / dash / second_wind / recovery / fighting_spirit 等 */
  useSelfAction(action) {
    if (S.combatPhase !== 'idle' && S.combatPhase !== 'player') {
      updateStatus('敌人回合中，请等待');
      return;
    }
    ensurePlayerSelected();
    if (!S.selectedToken) {
      updateStatus('请先点击自己的 token');
      return;
    }
    useSelfAction(action);
  },
  /** 结算后回调（右侧面板刷新 HP / 法术位） */
  onResolve: null,
  /** 动作预算变化回调（右侧面板刷新按钮置灰），参数为 turnResources 快照 */
  onTurnChanged: null,
  getSelectedToken() { return S.selectedToken; },
  getPlayerToken() { return getPlayerToken(); },
  getState() { return S.state; },
  getCombatPhase() { return S.combatPhase; },
  getTurnResources() { return { ...S.turnResources }; },
  getSpellLookup() { return S.spellLookup; },
  /** 非致命打击开关（session 内存，刷新即丢） */
  setNonlethal(enabled) { S.nonlethalEnabled = !!enabled; },
  getNonlethal() { return S.nonlethalEnabled; },
};

// 暴露给调试
window.__combatDebug = {
  get mapConfig() { return S.mapConfig; },
  get tokens() { return S.tokens; },
  get selectedToken() { return S.selectedToken; },
  get currentRange() { return S.currentRange; },
  get state() { return S.state; },
  get pendingAction() { return S.pendingAction; },
  pixelToCell: (x, y) => pixelToCell(S.mapConfig, x, y),
  cellToPixel: (c, r) => cellToPixel(S.mapConfig, c, r),
  /* 迷雾调试入口（fog.js） */
  fog: {
    state: () => ({ ...S.fog, zoneSet: S.fog.zoneSet.size, revealed: S.fog.revealed.size }),
    revealAround: () => revealAround(),
    revealAttacker: (t) => revealAttacker(t),
    updateVisibility: () => updateTokenVisibility(),
    isVisible: (t) => isTokenVisible(t),
  },
};

window.addEventListener('DOMContentLoaded', initMap);

/* ── 供其他模块（combat-loop/rules/enemy）反向调用的入口导出 ── */
export {
  select, deselect, applyResult,
  hideRangeCircle, clearTargetables, setTokensClickable, clearAllHighlights,
};
