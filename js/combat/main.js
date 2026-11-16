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

import { loadMapConfig, loadImage, renderMap, computeMapDimensions, pixelToCell, highlightCells, clearHighlights, cellToPixel, getCellZ, setHeightOverlayVisible } from './map.js';
import { createToken, moveToken, selectToken, deselectToken, updateTokenPosition, getMoveCells, updateTokenHp, spawnFloatingText, tokenAc } from './token.js';
import { calculateReachableCells, filterByRadius, reconstructPath, cellKey, jumpDistanceCells, jumpHeightCells, resolveVerticalStep } from './movement.js';
import { resolveAttack, resolveSpell, resolveSelfAction, hpMax, hpCur, rollDice, rollD20 } from './actions.js';
import { combatState, API_BASE, ADVENTURE_ID, CHAPTER_ID } from './state.js';
import { appendCombatLog, currentTurnLabel, updateStatus, updateResourceBar, renderInitiativeBar, addUnconsciousMarker, removeUnconsciousMarker, escapeHtml } from './combat-ui.js';
import { resolveShove, resolveRevive, cellsAdjacent, sleep, fallDamageDice } from './rules.js';
import { getPlayerToken, trySpendCost, spendCost, playerMoveCellsLeft, actionCostOf, startCombat, endPlayerTurn, endCombat, checkVictory, isTestingMap } from './combat-loop.js';
import { findTokenAt, moveEnemyToward } from './enemy.js';
import { initFog, revealAround, revealAttacker, updateTokenVisibility, isTokenVisible, hasLineOfSight } from './fog.js';
import { CELL_METERS, MELEE_RANGE_CELLS, RANGED_RANGE_CELLS, EYE_HEIGHT_LAYERS } from './constants.js';
import { applyEquipmentEffects } from '../character/equipment-effects.js';

const S = combatState;

const GLOBAL_NPC_JSON = `${API_BASE}/data/adventures/${ADVENTURE_ID}/global/npcs.json?t=${Date.now()}`;
const NPC_JSON = `${API_BASE}/data/adventures/${ADVENTURE_ID}/chapters/${CHAPTER_ID}/npcs.json?t=${Date.now()}`;
const BATTLES_JSON = `${API_BASE}/data/adventures/${ADVENTURE_ID}/chapters/${CHAPTER_ID}/battles.json?t=${Date.now()}`;
const SPELLS_JSON = `${API_BASE}/data/spells.json?t=${Date.now()}`;

let interactionsSetup = false;
let preBattlePrompt = null;   // 战前交互弹窗正在等待选择时不为 null

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
    // 章节文件只有实例条目（如 goblin-sentry-1 通过 template 字段引用）。
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

/** 敌人 token：按战斗配置生成
 *  配置必须且只能有 npc（引用已有 NPC 实例）或 template（引用 _templates 模板）之一
 *  @param {Object} def battles.json 中的敌人条目 { template|npc, name?, col, row, state? }
 *  @param {number} index 同名模板敌人的序号（用于生成唯一 id）
 */
function createEnemyToken(def, index = 0) {
  if (!!def.npc === !!def.template) {
    throw new Error(`战斗敌人必须且只能指定 npc 或 template 之一: ${JSON.stringify(def)}`);
  }
  let npcId, base;
  if (def.npc) {
    base = S.npcCatalog[def.npc];
    if (!base) throw new Error(`战斗配置引用了不存在的 NPC: ${def.npc}`);
    npcId = def.npc;
  } else {
    if (!S.npcTemplates[def.template]) throw new Error(`战斗配置引用了不存在的模板: ${def.template}`);
    npcId = `${def.template}-${index + 1}`;
    base = { id: npcId, template: def.template };
  }
  // 合并模板基础数据 + 实例数据（实例 name 覆盖模板 name）
  const tmpl = base.template ? (S.npcTemplates[base.template] || {}) : {};
  const merged = { ...tmpl, ...base };
  const name = def.name ?? merged.name;
  if (!name) throw new Error(`战斗敌人缺少 name: ${JSON.stringify(def)}`);
  // combat 深合并：实例只改部分字段（如 hp.cur）时，不能把模板的 attacks/ac/move_speed 整体冲掉
  const tmplCombat = tmpl.combat || {};
  const baseCombat = base.combat || {};
  merged.combat = {
    ...tmplCombat,
    ...baseCombat,
    hp: { ...(tmplCombat.hp || {}), ...(baseCombat.hp || {}) },
  };
  const combat = merged.combat;
  const hp = combat.hp || {};
  const attacks = (combat.attacks || []).map(a => ({
    name: a.name || '攻击',
    bonus: a.bonus || 0,
    damage: a.damage || '1d4',
    damage_type: a.damage_type || 'slashing',
    kind: a.kind || 'melee',     // 'melee' | 'ranged'（数据驱动 AI 选攻击，不再按武器名硬编码）
  }));
  return createToken({
    id: npcId,
    name,
    // 不传 portrait：token.js 自动取 name 首字（斯/格/克/弗，个体名区分）
    faction: 'enemy',
    col: def.col,
    row: def.row,
    moveSpeed: combat.move_speed || '9m',
    level: combat.level ?? 1,
    hpCur: hp.cur ?? 7,
    hpMax: hp.max ?? 7,
    ac: combat.ac ?? 15,
    attacks,
    npcId,
    states: def.state,
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
  const selfTargetable = spell && (spell.range?.kind === 'touch' || spell.range?.kind === 'self');
  // 治疗法术（effect.kind === 'heal'）只针对自己/队友；扶起队友（'revive'）只针对倒地队友；
  // 伤害法术/攻击只针对敌人
  const effectKind = spell?.effect?.kind || 'utility';
  const isHealSpell = effectKind === 'heal';
  const isReviveSpell = effectKind === 'revive';
  // 扶起队友：不能对自己（自己倒地时无法动作），只能对倒地且未死的己方
  const selfCastable = selfTargetable && !isReviveSpell;
  let losBlocked = 0;
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
    // 隔墙/崖壁不能瞄（近战、远程、法术统一）：施法者到目标需有视线（含斜角墙角规则）
    if (inRange && !hasLineOfSight(S.selectedToken.data.col, S.selectedToken.data.row,
      t.data.col, t.data.row, EYE_HEIGHT_LAYERS)) {
      losBlocked++;
      continue;
    }
    if (inRange) {
      // 治疗目标用绿色高亮；伤害目标用红白高亮（区分视觉）
      t.circle.style.boxShadow = isHealSpell
        ? '0 0 0 3px rgba(126, 237, 159, 0.9), 0 0 12px rgba(126, 237, 159, 0.6)'
        : '0 0 0 3px rgba(255, 255, 255, 0.9), 0 0 12px rgba(255, 80, 80, 0.9)';
      S.targetableTokens.push(t);
    }
  }
  if (S.targetableTokens.length === 0) {
    updateStatus(losBlocked > 0 ? '目标被墙壁/崖壁遮挡，视线受阻' : '射程内没有可作用的目标');
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
    const range = spell?.range || {};
    if (range.kind === 'touch' || range.kind === 'melee') return 1;
    if (range.kind === 'self') return 0;
    return range.meters != null ? range.meters / CELL_METERS : 0;
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
    const target = { name: targetToken.data.name, combat: { ac: tokenAc(targetToken) } };
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
      // 推离若把人推下崖，按落差结算 5e 坠落伤害（§7.3）
      const shove = resolveShove(S.selectedToken, targetToken);
      if (shove?.success && shove.fallDz > 0) {
        applyFallDamage(targetToken, shove.fallDz);
      }
      return;
    }
    // 扶起队友（help_downed，effect: revive）：触碰倒地己方，恢复 1HP 苏醒
    if (spell.id === 'help_downed' || spell.effect?.kind === 'revive') {
      spendCost(S.pendingAction);
      resolveRevive(S.selectedToken, targetToken);
      return;
    }
    const target = targetToken ? { name: targetToken.data.name, combat: { ac: tokenAc(targetToken) } } : null;
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
const OBSTACLE_KIND_LABEL = { water: '水', wall: '墙', tree: '树', rock: '岩石', background: '背景', cliff: '崖壁' };
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

/** 读 token 力量总值（玩家读角色卡；无则默认 10） */
function tokenStrScore(token) {
  return parseInt((token?.data?.character?.abilities || {}).str ?? 10, 10);
}

/** 落地摔伤结算：dz 为**正的**落差层数（向下坠落才受伤；<2 格不伤；5e 每 10 尺 1d6，封顶 20d6） */
function applyFallDamage(token, dz) {
  if (dz <= 0) return; // 只有向下坠落才受伤（向上登高不伤）
  const dice = fallDamageDice(dz);
  if (dice <= 0) return;
  const dmg = rollDice(`${dice}d6`);
  applyResult({
    damage: dmg,
    text: `${token.data.name} 坠落 ${dz} 层（${(dz * CELL_METERS).toFixed(1)}m），受到 ${dmg} 点坠落伤害（${dice}d6）`,
  }, token);
}

function startJump(char) {
  // 跳跃 = 附赠动作 + 消耗移动力：先做预算校验（附赠在 useSelfAction 已校验）
  if (S.combatPhase !== 'idle' && S.turnResources.moveLeft < CELL_METERS) {
    updateStatus('移动力不足，无法跳跃');
    return;
  }
  const str = parseInt((char.abilities || {}).str ?? 10, 10);
  const jumpDist = jumpDistanceCells(str); // BG3 跳远：水平半径（格）
  const jumpHigh = jumpHeightCells(str);   // 5e 跳高：向上（格）
  S.jumpRangeCells = jumpDist;
  S.state = 'jumping';
  S.pendingAction = null;
  clearVerticalPrompt();
  clearTargetables();
  hideRangeCircle();
  setTokensClickable(false);
  // 蓝色高亮跳跃落点：水平 ≤ 跳远 且 向上 ≤ 跳高（且落点可站 + 路径只跨可跨障碍）
  const range = new Map();
  const { col, row } = S.selectedToken.data;
  const fromZ = getCellZ(S.mapConfig, col, row);
  for (let c = 0; c < S.mapConfig.grid_cols; c++) {
    for (let r = 0; r < S.mapConfig.grid_rows; r++) {
      const d = Math.hypot(c - col, r - row);
      if (d > jumpDist + 1e-6) continue;                            // 水平超跳远 → 不亮
      if (getStandableBlockReason(c, r, S.selectedToken)) continue; // 落点是障碍/被占 → 不亮
      if (jumpPathAllowed(c, r)) continue;                          // 路径夹不可跨障碍 → 不亮
      if (resolveVerticalStep(fromZ, getCellZ(S.mapConfig, c, r), jumpHigh).kind === 'climb') continue; // 向上超跳高 → 属攀爬
      range.set(cellKey(c, r), { col: c, row: r });
    }
  }
  highlightCells(S.layers.highlightLayer, range, S.mapConfig);
  updateStatus(`${S.selectedToken.data.name} 选择跳跃落点（水平 ${jumpDist.toFixed(1)} 格 / 向上 ${jumpHigh} 格内，蓝色为可落点）`);
}

async function doJump(col, row) {
  if (!S.selectedToken || S.state !== 'jumping') return;
  const dist = Math.hypot(col - S.selectedToken.data.col, row - S.selectedToken.data.row);
  if (dist > S.jumpRangeCells + 1e-6) return;
  // 垂直判定（§7.3）：向上超过跳高 → 跳不上去，提示改用攀爬
  const jumpHigh = jumpHeightCells(tokenStrScore(S.selectedToken));
  const fromZ = getCellZ(S.mapConfig, S.selectedToken.data.col, S.selectedToken.data.row);
  const toZ = getCellZ(S.mapConfig, col, row);
  if (resolveVerticalStep(fromZ, toZ, jumpHigh).kind === 'climb') {
    updateStatus(`落点高出跳高（${toZ - fromZ} 层 > ${jumpHigh} 格），跳不上去，请改用攀爬`);
    return;
  }
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
  // 位置变化 → 中断未完成的攀爬（§7.3 清空规则）
  S.selectedToken.data.climb = null;
  // 落地落差伤害（下坠 ≥2 层）
  applyFallDamage(S.selectedToken, fromZ - toZ);
  if (!S.selectedToken.data.dead) select(S.selectedToken); // 保持选中，恢复移动范围
  updateStatus(`${S.selectedToken.data.name} 跳跃完成`);
  checkZoneEngage();
}

/* ══════════ 攀爬（垂直移动，5e 双倍消耗，允许跨轮累积，§7.3） ══════════ */

/**
 * 发起攀爬/爬下：目标格 z 与当前不同，需与目标格相邻（贴壁）。
 * 5e：每爬 1 尺花 2 尺移动力 → 每层 z 消耗 2 格（= 3m），上/下同价。
 * 单轮移动力不足时投入全部剩余并记入 token.data.climb，下轮开始自动续扣（resumeClimb）。
 */
function startClimb(col, row) {
  const token = S.selectedToken;
  if (!token) return;
  const fromZ = getCellZ(S.mapConfig, token.data.col, token.data.row);
  const toZ = getCellZ(S.mapConfig, col, row);
  const dz = toZ - fromZ;
  if (dz === 0) return;
  if (!cellsAdjacent(token.data.col, token.data.row, col, row)) {
    updateStatus('需走到崖壁旁（与目标格相邻）才能攀爬');
    return;
  }
  if (S.mapConfig.obstacleSet.has(cellKey(col, row))) {
    updateStatus('目标格是障碍物，无法攀爬');
    return;
  }
  const occupier = findTokenAt(col, row);
  if (occupier && occupier !== token && !occupier.data.dead) {
    updateStatus('目标格已被其他生物占据');
    return;
  }
  const verb = dz > 0 ? '攀爬' : '爬下';
  const needM = Math.abs(dz) * 2 * CELL_METERS; // 双倍消耗
  // 战斗外 / 测试地图不限移动力 → 直接完成
  if (S.combatPhase === 'idle' || isTestingMap()) {
    completeClimb(token, col, row);
    return;
  }
  const availM = Math.max(0, S.turnResources.moveLeft);
  if (availM + 1e-6 >= needM) {
    S.turnResources.moveLeft = Math.max(0, S.turnResources.moveLeft - needM);
    updateResourceBar();
    completeClimb(token, col, row);
    return;
  }
  // 移动力不足：投入全部剩余，记录进度，本轮结束（下轮自动续爬）
  token.data.climb = { toCol: col, toRow: row, paid: availM };
  S.turnResources.moveLeft = 0;
  updateResourceBar();
  select(token);
  updateStatus(`${token.data.name} 开始${verb}（${availM.toFixed(1)}/${needM.toFixed(1)} 米），本轮移动力耗尽，下轮自动继续`);
}

/** 攀爬/爬下到达：移动到目标格 + 揭示视野（攀爬为受控下降，不结算坠落伤害） */
async function completeClimb(token, col, row) {
  token.data.climb = null;
  const dz = getCellZ(S.mapConfig, col, row) - getCellZ(S.mapConfig, token.data.col, token.data.row);
  const verb = dz > 0 ? '攀爬' : '爬下';
  S.state = 'moving';
  hideRangeCircle();
  setTokensClickable(true);
  updateStatus(`${token.data.name} ${verb}中...`);
  await moveToken(token, col, row, S.mapConfig, 320);
  revealAround();
  if (S.combatPhase !== 'idle') {
    appendCombatLog(`${token.data.name} ${dz > 0 ? '攀上高处' : '爬到低处'}（z=${getCellZ(S.mapConfig, col, row)} 层）`, 'move', currentTurnLabel());
  }
  select(token);
  updateStatus(`${token.data.name} ${verb}完成`);
  checkZoneEngage();
}

/**
 * 玩家回合开始自动续爬（combat-loop.activateCurrent 中 initTurnResources 之后调用）。
 * @returns {boolean} true 表示本轮存在未完成的攀爬（已处理）
 */
export function resumeClimb(token) {
  const c = token?.data?.climb;
  if (!c) return false;
  const fromZ = getCellZ(S.mapConfig, token.data.col, token.data.row);
  const dz = getCellZ(S.mapConfig, c.toCol, c.toRow) - fromZ;
  if (dz === 0) { token.data.climb = null; return false; } // 目标已与当前等高（异常兜底）
  const verb = dz > 0 ? '攀爬' : '爬下';
  const needM = Math.abs(dz) * 2 * CELL_METERS;
  const availM = Math.max(0, S.turnResources.moveLeft);
  if (c.paid + availM + 1e-6 >= needM) {
    S.turnResources.moveLeft = Math.max(0, S.turnResources.moveLeft - (needM - c.paid));
    updateResourceBar();
    completeClimb(token, c.toCol, c.toRow);
  } else {
    c.paid += availM;
    S.turnResources.moveLeft = 0;
    updateResourceBar();
    updateStatus(`${token.data.name} ${verb}中（${c.paid.toFixed(1)}/${needM.toFixed(1)} 米），本轮继续投入移动力`);
  }
  return true;
}

/* ══════════ 垂直移动弹窗（相邻格 |Δz|≥2：攀爬 / 跳跃 / 跳下，§7.3） ══════════ */

/** 移除垂直移动选择浮层（顺带清掉「崖壁旁」闪烁覆盖层） */
function clearVerticalPrompt() {
  if (S.verticalPrompt) { S.verticalPrompt.remove(); S.verticalPrompt = null; }
  clearCliffFlash();
}

let cliffFlashEls = []; // 「崖壁旁」闪烁覆盖层 DOM

/** 清除「崖壁旁」闪烁覆盖层 */
function clearCliffFlash() {
  for (const el of cliffFlashEls) el.remove();
  cliffFlashEls = [];
}

/**
 * 闪烁「崖壁旁」格子（§7.3）：玩家点击过高的非相邻格时，提示可走的落脚点。
 * 判定 = 与玩家**同层**、**在「当前行动角色移动范围」内**、且 **4 向（共边）相邻**存在比自己高 ≥2 层的格子。
 * 范围 = `playerMoveCellsLeft`（战斗中=剩余移动力、探索=移速）。测试地图（无敌人）该函数会返回 999
 * 以便走遍全图，闪烁若沿用会导致全图崖壁都闪，故测试时改用角色移速。
 * 用 4 向而非 8 向：站在对角格时崖壁并不正对边缘，不算贴壁（避免斜角误报）。
 * 用 Web Animations 做脉冲，约 2 秒后自动消失；覆盖层 pointer-events:none 不挡点击。
 */
function flashCliffBase(token) {
  clearCliffFlash();
  const container = document.getElementById('combat-map-container');
  if (!container) return;
  const { grid_cols: cols, grid_rows: rows } = S.mapConfig;
  const playerZ = getCellZ(S.mapConfig, token.data.col, token.data.row);
  const cellW = S.mapConfig.widthPx / cols;
  const cellH = S.mapConfig.heightPx / rows;
  // 直接用「当前行动角色移动范围」；测试地图退回角色移速，避免 999（全图）
  const moveCells = isTestingMap() ? getMoveCells(token) : playerMoveCellsLeft(token);
  const range = calculateReachableCells(
    { col: token.data.col, row: token.data.row },
    moveCells, S.mapConfig.obstacleSet, cols, rows
  );
  const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]]; // 仅共边相邻（4 向）
  for (const info of range.values()) {
    const c = info.col, r = info.row;
    if (getCellZ(S.mapConfig, c, r) !== playerZ) continue; // 需与玩家同层（可走过去）
    // 4 向相邻是否存在「高出玩家 ≥2 层」的崖壁
    const hasCliff = dirs.some(([dc, dr]) => {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return false;
      return getCellZ(S.mapConfig, nc, nr) - playerZ >= 2;
    });
    if (!hasCliff) continue;
    const pos = cellToPixel(S.mapConfig, c, r); // 返回格中心
    const el = document.createElement('div');
    el.className = 'cliff-flash';
    el.style.cssText = `
      position: absolute;
      left: ${pos.x - cellW / 2}px;
      top: ${pos.y - cellH / 2}px;
      width: ${cellW}px;
      height: ${cellH}px;
      border: 2px solid rgba(196, 154, 92, 0.9);
      border-radius: 3px;
      background: rgba(196, 154, 92, 0.25);
      pointer-events: none;
      z-index: 6;
    `;
    container.appendChild(el);
    el.animate(
      [{ opacity: 0.1 }, { opacity: 1 }, { opacity: 0.1 }],
      { duration: 600, iterations: 3, easing: 'ease-in-out' }
    );
    cliffFlashEls.push(el);
  }
  setTimeout(clearCliffFlash, 2200); // 脉冲播完自动清理
}

/** 轻量 DOM 浮层：定位到点击格上方，统一淡色按钮；不可行的项置灰禁用（仍显示，便于玩家理解原因） */
function showVerticalPrompt(col, row, options) {
  clearVerticalPrompt();
  const container = document.getElementById('combat-map-container');
  if (!container) return;
  const pos = cellToPixel(S.mapConfig, col, row);
  const el = document.createElement('div');
  el.className = 'vertical-prompt';
  el.style.cssText = `
    position: absolute;
    left: ${pos.x}px;
    top: ${pos.y}px;
    transform: translate(-50%, -100%);
    margin-top: -6px;
    background: rgba(30, 24, 18, 0.96);
    border: 1px solid rgba(196, 154, 92, 0.7);
    border-radius: 6px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 42;            /* 必须高于 .fog-layer(30)，否则迷雾黑幕会盖住攀爬/跳跃选项 */
    pointer-events: auto;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  `;
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.textContent = opt.label;
    // 整个浮层统一淡色（比之前更淡）：底 rgba(196,154,92,0.12) + 半透明浅字 + 细边；
    // 不可行项再降一档（灰化 + 禁用），保证弹出框内观感一致
    const disabled = opt.disabled === true;
    btn.disabled = disabled;
    if (disabled) {
      btn.style.cssText = `
        background: rgba(120, 110, 96, 0.08);
        color: rgba(217, 204, 182, 0.3);
        border: 1px solid rgba(120, 110, 96, 0.15);
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 12px;
        cursor: not-allowed;
        white-space: nowrap;
        text-align: left;
      `;
    } else {
      btn.style.cssText = `
        background: rgba(196, 154, 92, 0.12);
        color: rgba(217, 204, 182, 0.6);
        border: 1px solid rgba(196, 154, 92, 0.2);
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        text-align: left;
      `;
      btn.addEventListener('click', (e) => { e.stopPropagation(); clearVerticalPrompt(); opt.onClick(); });
    }
    el.appendChild(btn);
  }
  container.appendChild(el);
  S.verticalPrompt = el;
}

/** 组装并弹出相邻格的垂直移动选项：向上给攀爬/跳跃，向下给爬下/跳下（不可行项置灰仍显示） */
function showVerticalPromptFor(col, row, dz) {
  const token = S.selectedToken;
  if (!token) return;
  const occupier = findTokenAt(col, row);
  if (S.mapConfig.obstacleSet.has(cellKey(col, row)) || (occupier && occupier !== token && !occupier.data.dead)) {
    updateStatus('目标格无法站立（障碍或已被占据）');
    return;
  }
  const bounded = S.combatPhase !== 'idle' && !isTestingMap(); // 是否受行动经济约束
  const hasBonus = !bounded || S.turnResources.bonus > 0;
  const options = [];
  if (dz >= 2) {
    // 攀爬：5e 双倍消耗（每层 2 格），无附赠/力量门槛，向上无高度上限
    const needM = dz * 2 * CELL_METERS;
    const crossTurn = bounded && needM > S.turnResources.moveLeft + 1e-6;
    options.push({ label: `攀爬（${needM.toFixed(1)}m 移动力${crossTurn ? '，将跨轮' : ''}）`, onClick: () => startClimb(col, row) });
    // 跳跃：与跳下同族（附赠动作 + 移动力），不可行时置灰但仍显示
    const jumpHigh = jumpHeightCells(tokenStrScore(token));
    const costM = ((token.data.col !== col && token.data.row !== row) ? 1.5 : 1) * CELL_METERS;
    const canJump = dz <= jumpHigh && hasBonus;
    let jumpLabel = `跳跃（1 附赠 + ${costM.toFixed(1)}m）`;
    if (!hasBonus) jumpLabel = '跳跃（需附赠动作）';
    else if (dz > jumpHigh) jumpLabel = `跳跃（超出跳高 ${jumpHigh} 格）`;
    options.push({ label: jumpLabel, onClick: () => jumpFromPrompt(col, row), disabled: !canJump });
  } else {
    // 向下：爬下（受控下降，双倍移动力，无坠落伤害）/ 跳下（= 跳跃动作，落地结算 5e 坠落伤害）
    const needM = Math.abs(dz) * 2 * CELL_METERS;
    const crossTurn = bounded && needM > S.turnResources.moveLeft + 1e-6;
    options.push({ label: `爬下（${needM.toFixed(1)}m 移动力${crossTurn ? '，将跨轮' : ''}）`, onClick: () => startClimb(col, row) });
    // 跳下 = 玩家点击「跳跃」动作（进入跳跃落点选择流程，自己挑落点），落地按落差结算摔伤；
    // 无附赠时置灰仍显示
    const dropLabel = hasBonus ? '跳下（1 附赠动作，选择落点）' : '跳下（需附赠动作）';
    options.push({ label: dropLabel, onClick: () => useSelfAction({ id: 'jump' }), disabled: !hasBonus });
  }
  options.push({ label: '取消', onClick: () => {} });
  showVerticalPrompt(col, row, options);
}

/** 相邻格 |Δz|≥2 的点击拦截：弹出选择窗则返回 true（调用方不再走普通移动） */
function handleVerticalClick(col, row) {
  const token = S.selectedToken;
  if (!token) return false;
  const fromZ = getCellZ(S.mapConfig, token.data.col, token.data.row);
  const toZ = getCellZ(S.mapConfig, col, row);
  const dz = toZ - fromZ;
  if (Math.abs(dz) < 2) return false; // ≤1 层：普通台阶，直接走，不打扰
  if (!cellsAdjacent(token.data.col, token.data.row, col, row)) {
    if (dz >= 2) {
      updateStatus('该处过高且不相邻：请用【跳跃】或走到崖壁旁攀爬');
      flashCliffBase(token); // 闪烁「崖壁旁」可攀爬落脚点
      return true;
    }
    return false; // 向下非相邻：走正常移动路径，落地结算摔伤
  }
  showVerticalPromptFor(col, row, dz);
  return true;
}

/** 弹窗选「跳跃」：进入跳跃落点流程直接跳到该格（相邻，必然在跳远内） */
function jumpFromPrompt(col, row) {
  if (!S.selectedToken) return;
  S.jumpRangeCells = jumpDistanceCells(tokenStrScore(S.selectedToken));
  S.state = 'jumping';
  doJump(col, row);
}

function cancelJump() {
  if (S.state !== 'jumping') return;
  hideRangeCircle();
  setTokensClickable(true);
  select(S.selectedToken);
}

/* ══════════ 选中 / 取消 / 目标状态 ══════════ */

function select(token) {
  clearVerticalPrompt();
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
  clearVerticalPrompt();
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
  clearVerticalPrompt();
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

  // 高度判定（§7.3）：相邻 |Δz|≥2 已由 handleVerticalClick 弹窗拦截；到这里只剩 ≤1 层台阶
  const path = reconstructPath(S.currentRange, { col: targetCol, row: targetRow });
  if (path.length < 2) return;
  // 路径高度兜底（§7.3）：Dijkstra 不感知高度，可能把路径规划成「翻过高台」。
  // 逐对检查相邻两格，|Δz| ≥ 2 说明路径跨越了崖壁 → 中断，避免无消耗翻崖。
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (Math.abs(getCellZ(S.mapConfig, b.col, b.row) - getCellZ(S.mapConfig, a.col, a.row)) >= 2) {
      updateStatus('路径被崖壁阻断：请走到崖壁旁用【攀爬/跳跃】逐段上/下');
      return;
    }
  }
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
  // 位置变化 → 中断未完成的攀爬（§7.3 清空规则）
  S.selectedToken.data.climb = null;
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
  // 走路不结算坠落伤害：上方路径兜底已禁止单段 |Δz|≥2，走通的路径只剩 ≤1 层台阶（<10 尺不伤）。
  // 摔伤只由「跳跃落地」「被推落崖」这类一次性垂直落差触发。
  // 保持选中：支持「移动 → 攻击 → 再移动」拆分（剩余预算见资源条）
  select(S.selectedToken);
  updateStatus(`移动完成（剩余移动力 ${Math.round(S.turnResources.moveLeft * 10) / 10} 米）`);
  if (S.combatPhase !== 'idle') {
    appendCombatLog(`${S.selectedToken.data.name} 移动 ${costCells} 格（剩余 ${Math.round(S.turnResources.moveLeft * 10) / 10}m）`, 'move', currentTurnLabel());
  }
  // 探索状态：走进战斗区域 → 开战
  checkZoneEngage();
}

function handleMapClick(e) {
  if (S.state === 'moving') return;
  // 非玩家回合禁止操作
  if (S.combatPhase !== 'idle' && S.combatPhase !== 'player') return;
  clearVerticalPrompt(); // 地图上任意点击先关掉旧的垂直移动浮层

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
    if (handleVerticalClick(cell.col, cell.row)) return; // 相邻 |Δz|≥2 → 弹垂直移动窗
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
  clearVerticalPrompt();
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

  // 高度可视化开关
  const heightToggle = document.getElementById('toggle-height');
  if (heightToggle) {
    heightToggle.checked = true;
    heightToggle.addEventListener('change', () => setHeightOverlayVisible(heightToggle.checked));
  }

  window.addEventListener('resize', scheduleMapRefit);
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

/** 数据驱动的接战判定：
 *  engage.type = on_load（进入地图即开战，如三猪小径伏击）
 *  engage.type = on_enter（玩家走进 battle.zone 指定区域才开战，如养狼洞）
 */
function checkZoneEngage() {
  if (S.combatPhase !== 'idle' || preBattlePrompt) return;
  const player = getPlayerToken();
  if (!player) return;
  const candidates = S.mapMode
    ? S.mapBattles.filter(b => b.engage.type === 'on_enter' && !b._resolved)
    : (S.activeBattle.engage.type === 'on_enter' && !S.activeBattle._resolved ? [S.activeBattle] : []);
  const battle = candidates.find(b => {
    const zone = (S.mapConfig.zones || []).find(z => z.id === b.zone);
    if (!zone) throw new Error(`地图 ${S.mapId} 缺少 zone: ${b.zone}`);
    return zone.cells.some(c => c.col === player.data.col && c.row === player.data.row);
  });
  if (!battle) return;
  // 带 pre_battle 的战斗（如驯兽）先弹交互，玩家选择后才开战
  if (battle.pre_battle && !battle._preBattleResolved) {
    showPreBattlePrompt(battle);
    return;
  }
  triggerBattle(battle);
}

/* ── 战前交互（数据驱动：battles.json 的 pre_battle） ── */

/** 读取角色技能加值（skills.sections[].skills[] 的 "+1" 字符串转数字） */
function skillBonus(char, skillName) {
  for (const section of (char?.skills?.sections || [])) {
    const found = (section.skills || []).find(s => s.name === skillName);
    if (found) return parseInt(String(found.value).replace(/[^0-9-]/g, ''), 10);
  }
  return null;
}

function closePreBattlePrompt() {
  const el = document.getElementById('pre-battle-overlay');
  if (el) el.remove();
  preBattlePrompt = null;
}

/** 弹出战前交互框：尝试技能检定 / 直接战斗 */
function showPreBattlePrompt(battle) {
  preBattlePrompt = battle;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'pre-battle-overlay';
  const btnStyle = 'flex:1;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--paper-card);cursor:pointer;font-family:inherit;font-size:13px;color:var(--ink);';
  overlay.innerHTML = `
    <div class="modal" style="max-width:440px;">
      <div class="modal-header"><div class="modal-name">${escapeHtml(battle.name)}</div></div>
      <div class="modal-desc">${escapeHtml(battle.pre_battle.prompt)}</div>
      <div style="display:flex;gap:10px;margin-top:18px;">
        <button id="pre-battle-skill" type="button" style="${btnStyle}">尝试${escapeHtml(battle.pre_battle.skill)}（DC ${battle.pre_battle.dc}）</button>
        <button id="pre-battle-fight" type="button" style="${btnStyle}">直接战斗</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#pre-battle-skill').addEventListener('click', () => {
    if (!preBattlePrompt) return;
    resolvePreBattleSkill(battle);
  });
  overlay.querySelector('#pre-battle-fight').addEventListener('click', () => {
    if (!preBattlePrompt) return;
    battle._preBattleResolved = true;
    closePreBattlePrompt();
    triggerBattle(battle);
  });
}

/** 战前技能检定：成功则不进入战斗，失败立即开战 */
function resolvePreBattleSkill(battle) {
  const player = getPlayerToken();
  const bonus = skillBonus(player.data.character, battle.pre_battle.skill);
  if (bonus === null) throw new Error(`角色缺少技能: ${battle.pre_battle.skill}`);
  const { roll, total } = rollD20(bonus);
  const success = total >= battle.pre_battle.dc;
  closePreBattlePrompt();
  appendCombatLog(
    `${battle.pre_battle.skill}检定：d20(${roll}) + ${bonus} = ${total} vs DC ${battle.pre_battle.dc} → ${success ? '成功' : '失败'}`,
    'system'
  );
  if (success) {
    battle._preBattleResolved = true;
    battle._resolved = true;   // 已安抚：不再触发战斗
    removeBattleTokens(battle.id);
    if (S.mapMode) {
      S.mapBattles = S.mapBattles.filter(b => b !== battle);
      recordBattleDefeated(S.mapId, battle.id);
    }
    appendCombatLog(battle.pre_battle.success, 'system');
    updateStatus('狼群安静下来，战斗被避免了');
  } else {
    appendCombatLog(battle.pre_battle.failure, 'system');
    battle._preBattleResolved = true;
    triggerBattle(battle);
  }
}

/** 移除某场战斗的敌人 token（安抚成功后敌人退场） */
function removeBattleTokens(battleId) {
  for (const t of S.tokens.filter(t => t.data.battleId === battleId)) {
    t.element.remove();
    if (t.circle) t.circle.remove();
  }
  S.tokens = S.tokens.filter(t => t.data.battleId !== battleId);
}

/** 按战斗定义生成敌人 token（template + name，或引用 npc 实例） */
function spawnBattleEnemies(battle) {
  battle.enemies.forEach((def, i) => {
    const enemyToken = createEnemyToken(def, i);
    // 标记所属战斗：地图上可能同时存在多场战斗的敌人，先攻/胜负只统计当前战斗
    enemyToken.data.battleId = battle.id;
    S.tokens.push(enemyToken);
    attachTokenClick(enemyToken);
  });
}

/** 触发一场战斗：敌人已随地图预生成，这里只掷先攻开战 */
function triggerBattle(battle) {
  if (battle._started) return; // startCombat 异步掷先攻期间防止重复触发
  battle._started = true;
  S.activeBattle = battle;
  if (S.mapMode) S.mapBattles = S.mapBattles.filter(b => b !== battle);
  renderTokens();
  startCombat();
}

/* ── 地图探险进度（session 内有效：已击败战斗不再重复触发） ── */
function readMapProgress() {
  const raw = sessionStorage.getItem('mapProgress');
  return raw ? JSON.parse(raw) : {};
}

function isBattleDefeatedInMap(mapId, battleId) {
  const progress = readMapProgress()[mapId];
  return !!progress && progress.defeatedBattles.includes(battleId);
}

function recordBattleDefeated(mapId, battleId) {
  const all = readMapProgress();
  const progress = all[mapId] || { defeatedBattles: [] };
  if (!progress.defeatedBattles.includes(battleId)) progress.defeatedBattles.push(battleId);
  all[mapId] = progress;
  sessionStorage.setItem('mapProgress', JSON.stringify(all));
}

/** 供 combat-loop 在胜利后调用：记录该地图上的战斗已击败 */
function recordBattleVictory(battleId) {
  recordBattleDefeated(S.mapId, battleId);
}

let refitTimer = null;

function scheduleMapRefit() {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refitMap, 80);
}

/** 面板拖拽/窗口缩放后按可用空间重排地图（只重绘，不重建 token、不重掷先攻） */
function refitMap() {
  const container = document.getElementById('combat-map-container');
  if (!container || !S.mapConfig || !S.mapImageSize || !S.layers) return;
  const wrapper = container.parentElement;
  const dims = computeMapDimensions(
    S.mapImageSize.w,
    S.mapImageSize.h,
    wrapper.clientWidth - 48,
    wrapper.clientHeight - 48
  );
  if (Math.abs(dims.widthPx - (S.mapConfig.widthPx || 0)) < 1
      && Math.abs(dims.heightPx - (S.mapConfig.heightPx || 0)) < 1) return;
  S.layers = renderMap(container, S.mapConfig, dims.widthPx, dims.heightPx);
  initFog(S.mapConfig, container);
  renderTokens();
  revealAround();
  // 重绘会清空高亮层：选中状态下补回移动范围
  if (S.state === 'selected' && S.selectedToken) {
    highlightCells(S.layers.highlightLayer, S.currentRange, S.mapConfig);
  }
}

async function initMap() {
  const container = document.getElementById('combat-map-container');
  if (!container) return;

  try {
    // 进入上下文：activeBattleId（直接战斗）/ activeMapId（地图探险）/ ?map= 调试入口
    const params = new URLSearchParams(window.location.search);
    const debugMapId = params.get('map');
    const battleId = localStorage.getItem('activeBattleId');
    const mapId = debugMapId || localStorage.getItem('activeMapId');
    if (battleId && !debugMapId && localStorage.getItem('activeMapId')) {
      throw new Error('战斗上下文与地图上下文同时存在，请清理 localStorage 后重试');
    }
    if (debugMapId) localStorage.removeItem('activeBattleId'); // 调试入口显式覆盖战斗上下文
    if (!battleId && !mapId) throw new Error('缺少战斗/地图上下文：请从冒险场景进入战斗地图，或使用 ?map=地图id 调试');

    // 运行时附加项（玩家快照 / 返回场景 / 战利品 / 线索）；调试入口可没有
    const rawContext = sessionStorage.getItem('encounterContext');
    if (rawContext) {
      S.encounterContext = JSON.parse(rawContext);
    } else if (!debugMapId) {
      throw new Error('缺少 encounterContext：请从冒险场景进入战斗地图');
    }

    const battlesData = await loadJson(BATTLES_JSON);
    const battles = battlesData.battles;

    if (battleId && !debugMapId) {
      const battle = battles[battleId];
      if (!battle) throw new Error(`battles.json 中不存在战斗: ${battleId}`);
      S.activeBattle = battle;
      S.mapMode = false;
      S.mapId = battle.map;
    } else {
      S.mapMode = true;
      S.debugMap = !!debugMapId;
      S.mapId = mapId;
      // 地图探险：挂载该地图上所有尚未击败的战斗，走进 zone 才触发
      S.mapBattles = Object.values(battles)
        .filter(b => b.map === S.mapId && !isBattleDefeatedInMap(S.mapId, b.id));
    }

    if (!S.mapConfig) {
      S.mapConfig = await loadMapConfig(S.mapId);
    }

    // 校验接战方式与 zone 数据，缺数据直接报错（不兜底）
    const battlesToValidate = S.mapMode ? S.mapBattles : [S.activeBattle];
    for (const b of battlesToValidate) {
      if (b.engage.type === 'on_enter') {
        if (!(S.mapConfig.zones || []).some(z => z.id === b.zone)) {
          throw new Error(`地图 ${S.mapId} 缺少 zone: ${b.zone}（战斗 ${b.id}）`);
        }
      } else if (b.engage.type !== 'on_load') {
        throw new Error(`未知接战方式: ${b.engage.type}（战斗 ${b.id}）`);
      }
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

    S.mapImageSize = { w: img.naturalWidth, h: img.naturalHeight };
    S.layers = renderMap(container, S.mapConfig, dims.widthPx, dims.heightPx);
    // 探索迷雾：地图 JSON 有 fog_zones 才启用（挂最上层黑幕；resize 重建幂等）
    initFog(S.mapConfig, container);
    // 侧栏拖拽不会触发 window.resize：监听地图容器父级尺寸变化，实时重排
    if (!S.mapResizeObserver && window.ResizeObserver) {
      S.mapResizeObserver = new ResizeObserver(scheduleMapRefit);
      S.mapResizeObserver.observe(container.parentElement);
    }

    if (S.tokens.length === 0) {
      // 玩家角色卡由页面交付（combat-map.html 加载后挂 window.__playerCharacterReady）：
      // 战斗端不再自行加载角色，token.data.character 就是页面 state.character 那份对象，
      // 页面重算的 AC/攻击加值引擎立即可见（无拷贝、无同步、无监听）
      const char = await window.__playerCharacterReady;
      applyEquipmentEffects(char, S.equipmentCatalog);
      // M6：用玩家快照中的 HP/AC 覆盖角色数据（保证战斗地图与冒险流程状态同步）
      if (S.encounterContext?.playerSnapshot) {
        const ps = S.encounterContext.playerSnapshot;
        char.combat = char.combat || { ac: 10, hp: { cur: 0, max: 0 } };
        char.combat.ac = ps.ac || char.combat.ac;
        char.combat.hp = { cur: ps.hpCur ?? 0, max: ps.hpMax ?? 0 };
      }
      const playerSpawn = S.mapConfig.spawns.players[0];
      const playerToken = createPlayerToken(char, playerSpawn);
      playerToken.data.character = char;
      S.tokens.push(playerToken);
      attachTokenClick(playerToken);

      // 敌人属于地图：进图即生成并显示；战斗只决定何时掷先攻（不再"开战才刷怪"）
      if (S.mapMode) S.mapBattles.forEach(spawnBattleEnemies);
      else spawnBattleEnemies(S.activeBattle);
    }

    renderTokens();
    setupInteractions();
    // 迷雾启用时：以玩家出生位置为光源做首次揭示
    revealAround();
    // 探索状态默认选中玩家，进图即可点击蓝格移动（开战后会由先攻流程重新选中）
    ensurePlayerSelected();
    updateStatus(S.mapMode
      ? '探险中：走进战斗区域才会开战'
      : `战斗：${S.activeBattle.name}`);
    bindEndTurnButton();
    setTimeout(() => {
      revealAround();
      if (S.mapMode) {
        const onLoadBattle = S.mapBattles.find(b => b.engage.type === 'on_load');
        if (onLoadBattle) triggerBattle(onLoadBattle);
        else checkZoneEngage();
      } else if (S.activeBattle.engage.type === 'on_load') {
        startCombat();
      } else {
        checkZoneEngage();
      }
    }, 300);
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
  /** 离开地图回冒险页：探险模式写回 HP 与已击败战斗；直接战斗模式直接返回 */
  leaveMap() {
    if (!S.mapMode || S.debugMap) {
      window.location.href = 'adventure.html';
      return;
    }
    const playerToken = S.tokens.find(t => t.data.faction === 'player');
    const ps = S.encounterContext.playerSnapshot;
    const progress = readMapProgress()[S.mapId];
    sessionStorage.setItem('mapResult', JSON.stringify({
      mapId: S.mapId,
      returnSceneId: S.encounterContext.returnSceneId,
      playerEndHp: playerToken ? playerToken.data.hpCur : ps.hpCur,
      hpMax: ps.hpMax,
      defeatedBattles: progress ? progress.defeatedBattles : [],
    }));
    localStorage.removeItem('activeMapId');
    window.location.href = 'adventure.html?map_result=1';
  },

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
  /** 装备/卸下后立即刷新迷雾照明
   *  （角色卡是同一份对象，装备变化已直接生效，只需按新照明半径重新揭示） */
  refreshFog() {
    revealAround();
  },
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
  recordBattleVictory,
};
