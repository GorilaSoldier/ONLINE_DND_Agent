/**
 * 战斗地图主逻辑：加载、渲染、交互状态机
 * 状态：idle → selected（选中己方）→ moving（移动中）→ targeting（选目标施放）
 */

import { loadMapConfig, loadImage, renderMap, computeMapDimensions, pixelToCell, highlightCells, clearHighlights, cellToPixel } from './map.js';
import { createToken, moveToken, selectToken, deselectToken, updateTokenPosition, getMoveCells, updateTokenHp, spawnFloatingText } from './token.js';
import { calculateReachableCells, filterByRadius, reconstructPath, parseMeters, metersToCells, cellKey } from './movement.js';
import { resolveAttack, resolveSpell, resolveSelfAction, hpMax, hpCur, rollD20 } from './actions.js';

const API_BASE = window.location.origin;
const ADVENTURE_ID = 'lost-mine-of-phandelver';
const CHAPTER_ID = 'ch1';
const NPC_JSON = `${API_BASE}/data/adventures/${ADVENTURE_ID}/chapters/${CHAPTER_ID}/npcs.json?t=${Date.now()}`;
const SPELLS_JSON = `${API_BASE}/data/spells.json?t=${Date.now()}`;

let mapConfig = null;
let layers = null;
let tokens = [];
let selectedToken = null;
let currentRange = new Map();
let state = 'idle'; // idle | selected | moving | targeting
let interactionsSetup = false;
let rangeCircle = null;

/* ══════════ M6：遭遇上下文（从 adventure.html 传入）══════════
 * 通过 sessionStorage.encounterContext 传递，URL ?encounter=xxx 触发
 * encounterContext = {
 *   encounterId, encounterName, mapId, enemies: ['goblin-ambusher-1', ...],
 *   allies: [], playerSnapshot: { charId, hpCur, hpMax, ac },
 *   returnSceneId, nextSceneId, loot: [...], clues: [...], description
 * }
 */
let encounterContext = null;

// 当前选中的动作（targeting 时有效）：{type:'attack', kind} | {type:'spell', spellId}
let pendingAction = null;
// 射程内的可点击目标
let targetableTokens = [];

// NPC / 法术目录（从后端 JSON 加载，供结算用）
let npcCatalog = {};
let npcTemplates = {};
let spellLookup = {};
let equipmentCatalog = {};

/* ══════════ 法术位（D&D 5e）══════════
 * 1 环法术消耗 1 个 1 环法术位；戏法（0 环）不消耗；长休恢复
 * 与右侧角色卡 slotText1 共享，通过 __combatApi.getSpellSlots() 暴露
 * caster_level 1 → 2 个 1 环位；caster_level ≥ 2 → 3 个（与后端 spell_slot_max 一致）
 */
let spellSlots = { 1: { max: 2, used: 0 } };

/* ══════════ 动作经济（D&D 5e）══════════
 * 每回合：1 动作 + 1 附赠动作 + 移动力（米，不结转）
 * 展示用米（斜走消耗 √2 格 ≈ 2.12 米，非整数格）
 * 回气（second_wind）：1 次/战斗
 */
let turnResources = {
  action: 1,
  bonus: 1,
  moveLeft: 0,             // 剩余移动力（米）
  moveBase: 0,             // 基础移动力（米）
  secondWindUsed: false,   // 回气每场战斗 1 次
  actionSurgeUsed: false,  // 动作如潮每场战斗 1 次
};

/* ══════════ 先攻顺序（D&D 5e RAW：逐个掷骰，降序排列）══════════
 * initiativeOrder: [{ token, initiative, faction, name }, ...] 降序
 * currentInitIndex: 当前行动者索引；advanceInitiative 跳过死亡
 */
let initiativeOrder = [];
let currentInitIndex = -1;
let turnCounter = 1;       // 第几轮（走完一圈 +1，用于状态栏提示）
let lastLogTurn = null;    // 战斗日志：上一次记录的轮次，用于换轮时插入分隔条

/** action_type 文案 → 消耗类型：'action' | 'bonus' | 'free' */
function costFromType(type, fallback = 'action') {
  if (type === '附赠动作') return 'bonus';
  if (type === '1动作') return 'action';
  if (type === '自由动作') return 'free';
  return fallback;
}

/** 地图动作 → 消耗类型：攻击一律动作；法术/动作读 spells.json 的 action_type（默认 1 动作） */
function actionCostOf(action) {
  if (!action) return 'free';
  if (action.type === 'attack') return 'action';
  // 自身动作（useSelfAction 传 {id:'xxx'}）/ 法术（{type:'spell', spellId}）统一查 spellLookup
  const id = action.type === 'spell' ? action.spellId : action.id;
  if (id) {
    const def = spellLookup[id];
    if (def) return costFromType(def.action_type, 'action');
  }
  return costFromType(action.action_type, 'action');
}

/** 战斗外（idle）不限制；预算不足则提示并返回 false */
function trySpendCost(action) {
  if (combatPhase === 'idle') return true;
  const cost = actionCostOf(action);
  if (cost === 'free') return true;
  // BG3 规则：苏醒回合（被扶起/自然20/治疗）只能用附赠动作 → 禁止动作
  if (turnResources.justRevived && cost === 'action') {
    updateStatus('苏醒回合只能使用附赠动作（BG3 规则）');
    return false;
  }
  if (cost === 'action' && turnResources.action <= 0) {
    updateStatus('动作已用完，本回合不能再执行该操作（可结束回合）');
    return false;
  }
  if (cost === 'bonus' && turnResources.bonus <= 0) {
    updateStatus('附赠动作已用完');
    return false;
  }
  return true;
}

/** 实际扣减预算并刷新资源条 */
function spendCost(action) {
  if (combatPhase === 'idle') return;
  const cost = actionCostOf(action);
  if (cost === 'action') turnResources.action = Math.max(0, turnResources.action - 1);
  else if (cost === 'bonus') turnResources.bonus = Math.max(0, turnResources.bonus - 1);
  updateResourceBar();
}

/** 玩家本回合剩余移动力（格）：战斗外为满速 */
function playerMoveCellsLeft(token) {
  const full = getMoveCells(token, mapConfig);
  if (combatPhase === 'idle') return full;
  return Math.max(0, Math.min(full, turnResources.moveLeft / mapConfig.meters_per_cell));
}

/** 玩家回合开始时重置预算（移动力不结转，回气/动作如潮次数跨回合保留） */
function initTurnResources() {
  const p = getPlayerToken();
  const base = p ? parseMeters(p.data.character?.background?.attributes?.move_speed || '9m') : 9;
  turnResources = {
    action: 1,
    bonus: 1,
    moveLeft: base,
    moveBase: base,
    secondWindUsed: turnResources.secondWindUsed,
    actionSurgeUsed: turnResources.actionSurgeUsed,
    justRevived: false, // BG3：苏醒回合限制只在本回合有效，下回合开始清除
  };
  updateResourceBar();
}

/** 刷新地图底部资源条：动作● 附赠● 移动x.x米（仅玩家回合显示） */
function updateResourceBar() {
  const bar = document.getElementById('resource-bar');
  if (bar) {
    // 仅玩家回合显示资源条；敌人回合隐藏（按用户反馈：敌人回合不展示玩家资源状态）
    bar.style.display = combatPhase === 'player' ? 'flex' : 'none';
    bar.classList.remove('enemy-turn');
    if (combatPhase !== 'player') {
      bar.innerHTML = '';
    } else {
      const dot = ok => (ok ? '●' : '○');
      const moveM = Math.round(turnResources.moveLeft * 10) / 10;
      bar.innerHTML =
        `<span class="res-chip${turnResources.action > 0 ? '' : ' used'}">动作 ${dot(turnResources.action > 0)}</span>` +
        `<span class="res-chip${turnResources.bonus > 0 ? '' : ' used'}">附赠 ${dot(turnResources.bonus > 0)}</span>` +
        `<span class="res-chip${moveM > 0.01 ? '' : ' used'}">移动 ${moveM}米</span>`;
    }
  }
  // 通知右侧面板刷新按钮置灰状态
  if (typeof window.__combatApi?.onTurnChanged === 'function') {
    window.__combatApi.onTurnChanged({ ...turnResources });
  }
}

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return await res.json();
}

async function loadCombatData() {
  try {
    const npcData = await loadJson(NPC_JSON);
    npcCatalog = npcData.npcs || {};
    npcTemplates = npcData._templates || {};
  } catch (e) { console.warn('加载 NPC 目录失败:', e); npcCatalog = {}; }
  try {
    const spellData = await loadJson(SPELLS_JSON);
    spellLookup = {};
    const add = (cat) => { if (cat) Object.entries(cat).forEach(([id, s]) => { spellLookup[id] = s; }); };
    add(spellData.actions?.normal);
    add(spellData.actions?.class);
    add(spellData.passive);
    add(spellData.cantrips);
    add(spellData.spells?.level_1);
  } catch (e) { console.warn('加载法术目录失败:', e); spellLookup = {}; }
  try {
    const eqData = await loadJson(`${API_BASE}/api/equipment`);
    equipmentCatalog = eqData || {};
  } catch (e) { console.warn('加载装备目录失败:', e); equipmentCatalog = {}; }
}

/**
 * 重算角色攻击数据（与右侧角色卡 recalcCharacterStats 一致的 D&D 5e 规则），
 * 保证地图结算与面板显示的攻击加值/伤害骰一致（如 "1d4+3"）。
 * 同时重算 AC（无甲基础 + 已装备护甲取最高 + 盾牌 + 饰品加值）。
 */
function recalcAttack(char) {
  const items = char.inventory?.items || [];
  const dexMod = Math.floor(((char.abilities?.dex?.value ?? 10) - 10) / 2);
  const strMod = Math.floor(((char.abilities?.str?.value ?? 10) - 10) / 2);
  const prof = parseInt(String(char.skills?.proficiency_bonus || '+2').replace(/[^0-9-]/g, ''), 10) || 2;
  let meleeDamage = null, rangedDamage = null, meleeBonus = 0, rangedBonus = 0;
  let ac = 10 + dexMod;
  for (const item of items) {
    if (!item.equipped) continue;
    const ci = equipmentCatalog[item.equipment_id];
    if (!ci || !ci.stats) continue;
    if (ci.type === 'weapon') {
      if (ci.stats.category === 'melee' && !meleeDamage) {
        meleeDamage = ci.stats.damage_dice;
        meleeBonus = ci.stats.bonus || 0;
      }
      if (ci.stats.category === 'ranged' && !rangedDamage) {
        rangedDamage = ci.stats.damage_dice;
        rangedBonus = ci.stats.bonus || 0;
      }
    } else if (ci.type === 'armor') {
      const s = ci.stats;
      if (s.category === 'shield') {
        ac += (s.bonus_ac || 0);
      } else if (s.category !== 'clothes' && s.ac_base) {
        let a = s.ac_base;
        if (s.ac_ability === 'dex') {
          a += (s.ac_max_dex != null ? Math.min(dexMod, s.ac_max_dex) : dexMod);
        }
        if (a > ac) ac = a;
      }
    } else if (ci.type === 'accessory' && ci.stats && ci.stats.bonus_ac) {
      ac += ci.stats.bonus_ac;
    }
  }
  char.combat = char.combat || { ac: 10, hp: '0 / 0' };
  char.combat.ac = ac;
  char.attack = char.attack || { melee: {}, ranged: {} };
  const fmt = v => (v >= 0 ? '+' : '') + v;
  char.attack.melee.bonus = fmt(strMod + prof + meleeBonus);
  char.attack.melee.damage = meleeDamage ? meleeDamage + (meleeBonus ? `+${meleeBonus}` : '') : '1d4';
  char.attack.ranged.bonus = fmt(dexMod + prof + rangedBonus);
  char.attack.ranged.damage = rangedDamage ? rangedDamage + (rangedBonus ? `+${rangedBonus}` : '') : '1d4';
}

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
  }, mapConfig);
}

/** 敌人 token：按 npcId 从 npcCatalog 取数据（支持模板复用）
 *  M6 之前写死 goblin-ambusher-{i+1}，M6 改为接受任意 npcId 参数 */
function createEnemyToken(npcId, spawn, index = 0) {
  const npc = npcCatalog[npcId] || { id: npcId, name: npcId };
  // 合并模板基础数据 + 实例数据（实例 name 覆盖模板 name）
  const tmpl = npc.template ? (npcTemplates[npc.template] || {}) : {};
  const merged = { ...tmpl, ...npc };
  const combat = merged.combat || {};
  const hp = combat.hp || {};
  const attacks = (combat.attacks || []).map(a => ({
    name: a.name || '攻击',
    bonus: a.bonus || 0,
    damage: a.damage || '1d4',
    type: a.type || '挥砍',
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
  }, mapConfig);
}

/* ── 移动范围（复用原有逻辑；玩家战斗中按剩余移动力） ── */
function showMovementRange(token) {
  const moveCells = token.data.faction === 'player'
    ? playerMoveCellsLeft(token)
    : getMoveCells(token, mapConfig);
  if (moveCells <= 0.01) {
    currentRange = new Map();
    clearHighlights(layers.highlightLayer);
    return;
  }
  const radiusCells = moveCells;
  const reachable = calculateReachableCells(
    { col: token.data.col, row: token.data.row },
    moveCells,
    mapConfig.obstacleSet,
    mapConfig.grid_cols,
    mapConfig.grid_rows
  );
  currentRange = filterByRadius(reachable, { col: token.data.col, row: token.data.row }, radiusCells);
  highlightCells(layers.highlightLayer, currentRange, mapConfig);
}

/**
 * 显示指定半径的范围圆（半径以"格"为单位）
 * @param {string} color css 颜色（默认红色 = 攻击/法术射程）
 */
function showRangeCircleBy(token, radiusCells, color = 'rgba(196, 75, 75, 0.75)') {
  hideRangeCircle();
  const cellW = mapConfig.widthPx / mapConfig.grid_cols;
  const cellH = mapConfig.heightPx / mapConfig.grid_rows;
  const rx = radiusCells * cellW;
  const ry = radiusCells * cellH;
  const pos = cellToPixel(mapConfig, token.data.col, token.data.row);

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
  rangeCircle = el;
}

function showRangeCircle(token) {
  const moveCells = token.data.faction === 'player'
    ? playerMoveCellsLeft(token)
    : getMoveCells(token, mapConfig);
  showRangeCircleBy(token, moveCells);
}

function hideRangeCircle() {
  if (rangeCircle) {
    rangeCircle.remove();
    rangeCircle = null;
  }
}

/* ── 目标高亮（可点击敌人加红圈） ── */
function clearTargetables() {
  for (const t of targetableTokens) {
    if (t.circle) t.circle.style.boxShadow = '';
  }
  targetableTokens = [];
}

function showTargetables() {
  clearTargetables();
  if (!pendingAction || !selectedToken) return;
  const radiusCells = getActionRangeCells(pendingAction);
  // 判定是否为自身/友善目标法术（触碰治疗、增益等可对自己施放）
  const spell = pendingAction.type === 'spell' ? spellLookup[pendingAction.spellId] : null;
  const selfTargetable = spell && (spell.range === '触碰' || spell.range === '自身');
  // 治疗法术（effect 以 "heal" 开头）只针对自己/队友；扶起队友（"revive"）只针对倒地队友；
  // 伤害法术/攻击只针对敌人
  // 原实现不区分治疗/伤害，导致治愈术高亮敌人 → 玩家可对敌人"加血"（错误）
  const effectStr = String(spell?.effect || '').trim().toLowerCase();
  const isHealSpell = effectStr.startsWith('heal');
  const isReviveSpell = effectStr.startsWith('revive');
  // 扶起队友：不能对自己（自己倒地时无法动作），只能对倒地且未死的己方
  const selfCastable = selfTargetable && !isReviveSpell;
  for (const t of tokens) {
    if (t === selectedToken) {
      // 自身目标法术（治愈术触碰等）可对自己施放（但扶起队友不可）
      if (selfCastable) {
        t.circle.style.boxShadow = '0 0 0 3px rgba(126, 237, 159, 0.9), 0 0 12px rgba(126, 237, 159, 0.6)';
        targetableTokens.push(t);
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
    const dc = Math.abs(t.data.col - selectedToken.data.col);
    const dr = Math.abs(t.data.row - selectedToken.data.row);
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
      targetableTokens.push(t);
    }
  }
  if (targetableTokens.length === 0) {
    updateStatus('射程内没有可作用的目标');
  }
}

/* ── 动作射程（米 → 格） ── */
function getActionRangeCells(action) {
  const char = selectedToken?.data?.character;
  const attrs = char?.background?.attributes || {};
  if (action.type === 'attack') {
    const meters = action.kind === 'melee'
      ? parseFloat(String(attrs.melee_range || '1.5m'))
      : parseFloat(String(attrs.ranged_range || '6m'));
    return meters / mapConfig.meters_per_cell;
  }
  if (action.type === 'spell') {
    const spell = spellLookup[action.spellId];
    if (spell?.id === 'shove') return 1; // 推离：近战距离 1 格
    const range = String(spell?.range || '').trim();
    if (range === '触碰') return 1;
    if (range === '自身') return 0;
    const m = range.match(/(\d+(?:\.\d+)?)\s*米?/);
    return m ? parseFloat(m[1]) / mapConfig.meters_per_cell : 0;
  }
  return 0;
}

/* ── 结算 ── */
function applyResult(result, targetToken) {
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
      // 敌人：HP=0 直接死亡（保持原状）
      if (targetToken.data.hpCur <= 0) {
        targetToken.element.style.opacity = '0.35';
        targetToken.data.dead = true;
        renderInitiativeBar(); // 头像条标记死亡变灰
      }
    }
  }
  // 治疗 → 加目标 HP + 飘字（targetToken 为治疗目标，可能是自己或队友）
  const healTarget = targetToken || selectedToken;
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
      if (healTarget === selectedToken && combatPhase === 'player') {
        turnResources.justRevived = true;
        turnResources.action = 0;
        turnResources.moveLeft = 0;
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
  if (combatPhase !== 'idle') {
    checkVictory();
  }
}

function executePendingAction(targetToken) {
  const char = selectedToken?.data?.character;
  if (!char) return;
  if (!trySpendCost(pendingAction)) {
    cancelTargeting();
    return;
  }

  if (pendingAction.type === 'attack') {
    const target = { name: targetToken.data.name, combat: { ac: targetToken.data.ac ?? 15 } };
    spendCost(pendingAction);
    const result = resolveAttack(char, target, pendingAction.kind);
    applyResult(result, targetToken);
    // 额外攻击被动（Extra Attack，5 级战士）：攻击动作额外结算一次，不另耗动作
    if ((parseInt(char.level, 10) || 1) >= 5 && !targetToken.data.dead) {
      const extra = resolveAttack(char, target, pendingAction.kind);
      applyResult(extra, targetToken);
    }
    return;
  }

  if (pendingAction.type === 'spell') {
    const spell = spellLookup[pendingAction.spellId];
    // 推离：力量对抗检定，成功推远 1 格
    if (spell.id === 'shove') {
      spendCost(pendingAction);
      resolveShove(selectedToken, targetToken);
      return;
    }
    // 扶起队友（help_downed，effect: revive）：触碰倒地己方，恢复 1HP 苏醒
    if (spell.id === 'help_downed' || String(spell.effect || '').toLowerCase().startsWith('revive')) {
      spendCost(pendingAction);
      resolveRevive(selectedToken, targetToken);
      return;
    }
    const target = targetToken ? { name: targetToken.data.name, combat: { ac: targetToken.data.ac ?? 15 } } : null;
    const result = resolveSpell(spell, char, target);
    spendCost(pendingAction);
    // 法术不消耗法术位（第一版简化，后续接后端）
    if (result) applyResult(result, targetToken);
  }
}

/** 扶起队友（BG3 Help 动作）：触碰倒地己方，恢复 1 HP 并苏醒
 *  目标需为 faction∈{player,ally} 且 downed=true 且 dead=false
 *  被扶起者本回合只能用附赠动作（justRevived 标记，下回合开始清除）
 */
function resolveRevive(caster, target) {
  if (!target) return;
  if (target.data.faction !== 'player' && target.data.faction !== 'ally') {
    updateStatus('扶起队友只能对己方使用');
    appendCombatLog(`扶起队友失败：${target.data.name} 不是己方`, 'system', currentTurnLabel());
    return;
  }
  if (target.data.dead) {
    updateStatus(`${target.data.name} 已死亡，无法扶起（需复活类法术）`);
    appendCombatLog(`扶起失败：${target.data.name} 已死亡`, 'system', currentTurnLabel());
    return;
  }
  if (!target.data.downed) {
    updateStatus(`${target.data.name} 未倒地，无需扶起`);
    appendCombatLog(`扶起无效：${target.data.name} 未倒地`, 'system', currentTurnLabel());
    return;
  }
  target.data.hpCur = 1;
  target.data.downed = false;
  target.data.deathSaves = { successes: 0, failures: 0, stable: false };
  target.element.style.opacity = '1';
  updateTokenHp(target);
  renderInitiativeBar();
  // BG3：被扶起的角色本回合只能用附赠动作（若该角色正在当前回合，置动作=0、移动力=0，仅留附赠）
  if (target === selectedToken) {
    turnResources.justRevived = true;
    turnResources.action = 0;
    turnResources.moveLeft = 0;
    updateResourceBar();
  }
  const text = `${caster.data.name} 扶起 ${target.data.name}！恢复 1 HP 苏醒（本回合只能使用附赠动作）`;
  appendCombatLog(text, 'heal', currentTurnLabel());
  updateStatus(text);
}

/** 推离结算：双方掷 d20+力量调整值对抗，成功推远 1 格（被推方该次移动不触发借机攻击） */
function resolveShove(attacker, target) {
  // 力量值取数：玩家用 char.abilities.str.value（角色卡格式）；
  //              敌人无 abilities 字段时 fallback 到 10（mod=0）
  // 原实现读 background.attributes.力量 —— 该字段在角色卡里不存在，导致双方都 fallback Str=10
  const atkStr = attacker.data.character?.abilities?.str;
  const tgtStr = target.data.character?.abilities?.str
    || target.data.attrs?.str
    || target.data.combat?.strength;
  const atkStrVal = (typeof atkStr === 'object' ? atkStr?.value : atkStr) ?? 10;
  const tgtStrVal = (typeof tgtStr === 'object' ? tgtStr?.value : tgtStr) ?? 10;
  const atkMod = Math.floor((atkStrVal - 10) / 2);
  const tgtMod = Math.floor((tgtStrVal - 10) / 2);
  const atkRoll = rollD20(atkMod);
  const tgtRoll = rollD20(tgtMod);
  const success = atkRoll.total >= tgtRoll.total;
  if (!success) {
    updateStatus(`${attacker.data.name}推离${target.data.name}失败（${atkRoll.total} vs ${tgtRoll.total}）`);
    appendCombatLog(`推离失败：${atkRoll.total} vs ${tgtRoll.total}`, 'system', currentTurnLabel());
    return;
  }
  // 推远方向：从攻击者指向目标的方向，取格化
  const dc = target.data.col - attacker.data.col;
  const dr = target.data.row - attacker.data.row;
  const stepC = dc === 0 ? 0 : (dc > 0 ? 1 : -1);
  const stepR = dr === 0 ? 0 : (dr > 0 ? 1 : -1);
  const newCol = target.data.col + stepC;
  const newRow = target.data.row + stepR;
  // 落点校验：不出界、不是障碍格、不是其他 token 占据格
  const blocked = mapConfig.obstacles?.some(o => o.col === newCol && o.row === newRow)
    || tokens.some(t => t !== target && t.data.col === newCol && t.data.row === newRow && !t.data.dead)
    || newCol < 0 || newCol >= mapConfig.grid_cols
    || newRow < 0 || newRow >= mapConfig.grid_rows;
  if (blocked) {
    updateStatus(`${attacker.data.name}将${target.data.name}推离成功，但后方有障碍，未能推开（${atkRoll.total} vs ${tgtRoll.total}）`);
    appendCombatLog(`推离成功但后方有障碍：${atkRoll.total} vs ${tgtRoll.total}`, 'system', currentTurnLabel());
    return;
  }
  // 标记该次移动不触发借机攻击（推离替代脱离）
  target.data._shovedAway = true;
  target.data.col = newCol;
  target.data.row = newRow;
  updateTokenPosition(target, mapConfig);
  updateStatus(`${attacker.data.name}将${target.data.name}推远 1 格（${atkRoll.total} vs ${tgtRoll.total}）`);
  appendCombatLog(`推离成功，${target.data.name} 被推远 1 格（${atkRoll.total} vs ${tgtRoll.total}）`, 'attack', currentTurnLabel());
}

function useSelfAction(action) {
  const char = selectedToken?.data?.character;
  if (!char) return;
  // 动作如潮（fighting_spirit）：自由动作，但每战斗 1 次。先校验次数
  if (action.id === 'fighting_spirit' && combatPhase !== 'idle' && turnResources.actionSurgeUsed) {
    updateStatus('动作如潮每场战斗只能使用一次');
    return;
  }
  if (!trySpendCost(action)) return;
  if (action.id === 'second_wind' && combatPhase !== 'idle' && turnResources.secondWindUsed) {
    updateStatus('回气每场战斗只能使用一次');
    return;
  }
  if (action.id === 'jump') {
    startJump(char); // 跳跃在落点成功时才扣附赠动作 + 移动力
    return;
  }
  spendCost(action);
  if (action.id === 'second_wind') turnResources.secondWindUsed = true;
  const result = resolveSelfAction(action, char);
  // 动作如潮：本回合获得 1 个额外动作（不消耗动作/附赠，自由动作）
  if (result.actionSurge) {
    turnResources.actionSurgeUsed = true;
    turnResources.action += 1;
    updateResourceBar();
    // 重新计算按钮置灰（攻击等动作按钮恢复可点）
    if (typeof window.__combatApi?.onTurnChanged === 'function') {
      window.__combatApi.onTurnChanged({ ...turnResources });
    }
  }
  if (result.dash) {
    // 冲刺（动作）：额外获得一倍移动力（RAW Dash），已消耗的移动力不返还
    turnResources.moveLeft += turnResources.moveBase;
    updateResourceBar();
    showMovementRange(selectedToken);
    hideRangeCircle();
    showRangeCircle(selectedToken);
  }
  applyResult(result, null);
}

/**
 * 跳跃：进入落点选择状态。
 * D&D 5e 远跳 = 力量值英尺（每格 5 英尺），无视障碍直达落点。
 */
let jumpRangeCells = 0;
/** 跳跃落点选择期间禁用 token 点击拦截（token 命中区过大可能吞掉落点点击） */
function setTokensClickable(clickable) {
  for (const t of tokens) {
    t.element.style.pointerEvents = clickable ? '' : 'none';
  }
}

function startJump(char) {
  // 跳跃 = 附赠动作 + 消耗移动力：先做预算校验（附赠在 useSelfAction 已校验）
  if (combatPhase !== 'idle' && turnResources.moveLeft < mapConfig.meters_per_cell) {
    updateStatus('移动力不足，无法跳跃');
    return;
  }
  const str = parseInt(((char.abilities || {}).str || {}).value ?? 10, 10);
  jumpRangeCells = Math.max(1, Math.round(str / 5)); // 力量17 → 3 格
  state = 'jumping';
  pendingAction = null;
  clearTargetables();
  hideRangeCircle();
  setTokensClickable(false);
  // 蓝色高亮跳跃落点范围（与移动范围视觉一致），排除障碍格
  const range = new Map();
  const { col, row } = selectedToken.data;
  for (let c = 0; c < mapConfig.grid_cols; c++) {
    for (let r = 0; r < mapConfig.grid_rows; r++) {
      const d = Math.hypot(c - col, r - row);
      if (d <= jumpRangeCells + 1e-6 && !mapConfig.obstacleSet.has(cellKey(c, r))) {
        range.set(cellKey(c, r), { col: c, row: r });
      }
    }
  }
  highlightCells(layers.highlightLayer, range, mapConfig);
  updateStatus(`${selectedToken.data.name} 选择跳跃落点（${jumpRangeCells} 格内，可越过障碍）`);
}

async function doJump(col, row) {
  if (!selectedToken || state !== 'jumping') return;
  const dist = Math.hypot(col - selectedToken.data.col, row - selectedToken.data.row);
  if (dist > jumpRangeCells + 1e-6) return;
  // 落点不能是障碍格（跳越障碍，但不落在树上/岩石里）或已被其他生物占据
  if (mapConfig.obstacleSet.has(cellKey(col, row))) {
    updateStatus('落点是障碍物，无法站立');
    return;
  }
  const occupier = findTokenAt(col, row);
  if (occupier && occupier !== selectedToken) {
    updateStatus('落点已被其他生物占据');
    return;
  }
  // 跳跃消耗移动力 = 距离（格）× 每格米数（斜跳为 √2 × 1.5 ≈ 2.12 米）
  const costM = dist * mapConfig.meters_per_cell;
  if (combatPhase !== 'idle' && costM > turnResources.moveLeft + 1e-6) {
    updateStatus(`移动力不足，跳不过去（需 ${costM.toFixed(1)} 米）`);
    return;
  }

  state = 'moving';
  hideRangeCircle();
  setTokensClickable(true);
  updateStatus(`${selectedToken.data.name} 跳跃中...`);
  // 跳跃无视障碍，直接移动到落点
  await moveToken(selectedToken, col, row, mapConfig, 320);
  // 落点成功：扣附赠动作 + 移动力
  if (combatPhase !== 'idle') {
    turnResources.bonus = Math.max(0, turnResources.bonus - 1);
    turnResources.moveLeft = Math.max(0, turnResources.moveLeft - costM);
    updateResourceBar();
  }
  select(selectedToken); // 保持选中，恢复移动范围
  updateStatus(`${selectedToken.data.name} 跳跃完成`);
}

function cancelJump() {
  if (state !== 'jumping') return;
  hideRangeCircle();
  setTokensClickable(true);
  select(selectedToken);
}

/* ══════════ 回合制与敌人 AI ══════════ */
let combatPhase = 'idle'; // idle | player | enemy | victory | defeat
let enemyTurnRunning = false;

function getPlayerToken() {
  return tokens.find(t => t.data.faction === 'player');
}

function getAliveEnemies() {
  return tokens.filter(t => t.data.faction === 'enemy' && !t.data.dead);
}

function abilityMod(abilityValue) {
  return Math.floor(((Number(abilityValue) || 10) - 10) / 2);
}

/** 掷先攻（RAW 逐个）：每个生物 d20 + 敏捷调整值，降序排列，同值玩家优先 */
function rollInitiative() {
  const order = [];
  const player = getPlayerToken();
  if (player) {
    const char = player.data.character || {};
    const pDex = abilityMod(char?.abilities?.dex?.value ?? 10);
    order.push({
      token: player,
      initiative: Math.floor(Math.random() * 20) + 1 + pDex,
      faction: 'player',
      name: player.data.name || '玩家',
    });
  }
  for (const e of getAliveEnemies()) {
    const dex = abilityMod(e.data.enemyDex ?? 14);
    order.push({
      token: e,
      initiative: Math.floor(Math.random() * 20) + 1 + dex,
      faction: 'enemy',
      name: e.data.name || '地精',
    });
  }
  // 降序；同值时玩家优先（D&D 5e 同值惯例：先攻加值高者先，此处简化玩家优先）
  order.sort((a, b) => b.initiative - a.initiative || (a.faction === 'player' ? -1 : 1));
  return order;
}

function showEndTurnBtn(show) {
  const btn = document.getElementById('btn-end-turn');
  if (btn) btn.style.display = show ? 'inline-block' : 'none';
}

/** 战斗开始：掷先攻，按顺序逐个行动 */
function startCombat() {
  initiativeOrder = rollInitiative();
  currentInitIndex = 0;
  turnCounter = 1;
  lastLogTurn = null; // 重置分隔条状态
  renderInitiativeBar();
  const orderText = initiativeOrder.map(o => `${o.name} ${o.initiative}`).join(' / ');
  updateStatus(`战斗开始！先攻顺序：${orderText}`);
  // 先攻顺序作为战斗开场说明，独立于轮次分组之上（不触发分隔条）
  appendCombatLog(`战斗开始！先攻顺序：\n${orderText}`, 'system', '', true);
  // 延迟 1.2 秒让玩家看清顺序，再激活第一个行动者（不走 advanceInitiative，避免误触发轮数 +1）
  setTimeout(() => activateCurrent(), 1200);
}

/** 渲染先攻顺序头像条（地图上方横向） */
function renderInitiativeBar() {
  const bar = document.getElementById('initiative-bar');
  if (!bar) return;
  if (!initiativeOrder.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = initiativeOrder.map((o, i) => {
    const dead = o.token.data.dead;
    const isCur = i === currentInitIndex && !dead;
    const nextIdx = (currentInitIndex + 1) % initiativeOrder.length;
    const isNext = i === nextIdx && !dead && i !== currentInitIndex;
    const cls = dead ? 'dead' : (isCur ? 'current' : (isNext ? 'next' : ''));
    const color = o.faction === 'player' ? 'var(--player,#4a90d9)' : 'var(--enemy,#d94a4a)';
    const initial = (o.name || '?').charAt(0);
    return `<div class="init-portrait ${cls}" title="${o.name}（先攻 ${o.initiative}）">
      <div class="init-circle" style="border-color:${color};background:${color}33;color:${color}">${initial}</div>
      <div class="init-name">${o.name}</div>
      <div class="init-roll">${o.initiative}</div>
    </div>`;
  }).join('');
}

/** 激活当前 initiativeOrder[currentInitIndex]：玩家则等操作，敌人则 AI 行动 */
function activateCurrent(isFirst = false) {
  // 跳过死亡
  while (initiativeOrder[currentInitIndex] && initiativeOrder[currentInitIndex].token.data.dead) {
    currentInitIndex = (currentInitIndex + 1) % initiativeOrder.length;
  }
  const cur = initiativeOrder[currentInitIndex];
  if (!cur) return;
  renderInitiativeBar();
  if (cur.faction === 'player') {
    combatPhase = 'player';
    initTurnResources(); // 重置动作/附赠/移动力（不结转）
    showEndTurnBtn(true);
    // ── 死亡豁免（5e RAW）：昏迷玩家回合开始掷 d20 ──
    if (cur.token.data.downed && !cur.token.data.dead) {
      const handled = runPlayerDeathSave(cur.token);
      if (handled) {
        // 昏迷中无法行动：自动结束回合（除非自然 20/稳定后苏醒 → 可正常行动）
        if (cur.token.data.downed || cur.token.data.dead) {
          setTimeout(() => advanceInitiative(), 1500);
          return;
        }
      }
    }
    if (cur.token && !cur.token.data.dead) select(cur.token);
    updateStatus(`第 ${turnCounter} 轮 · ${cur.name}的回合，行动后点击「结束回合」`);
    appendCombatLog(`${cur.name}的回合开始`, 'system', currentTurnLabel());
  } else {
    combatPhase = 'enemy';
    showEndTurnBtn(false);
    deselect();
    updateStatus(`第 ${turnCounter} 轮 · ${cur.name}行动中...`);
    appendCombatLog(`${cur.name}的回合开始`, 'system', currentTurnLabel());
    setTimeout(() => runSingleEnemyAct(cur.token), 500);
  }
}

/**
 * 玩家死亡豁免掷骰（BG3 风格）：昏迷玩家回合开始时调用。
 * 自然 20 → 立即回 1 HP 苏醒（可正常行动）
 * 自然 1  → 失败 +2
 * ≥ 10    → 成功 +1，累计 3 → 稳定（不再掷骰，但仍昏迷，需队友扶起/治疗）
 * ≤ 9     → 失败 +1，累计 3 → 死亡
 * 稳定后回到此函数 → 跳过掷骰，仍昏迷等待救援（不自动苏醒）
 * @returns {boolean} true 表示已处理（昏迷/苏醒/死亡）
 */
function runPlayerDeathSave(playerToken) {
  const ds = playerToken.data.deathSaves || (playerToken.data.deathSaves = { successes: 0, failures: 0, stable: false });
  const name = playerToken.data.name || '玩家';

  // 稳定后：不再掷骰，但仍昏迷，需队友扶起/治疗才能苏醒（BG3 规则）
  // 原实现：稳定后下回合自动回 1HP 苏醒 → 人物永远死不了（与用户反馈一致）
  if (ds.stable) {
    appendCombatLog(`${name} 已稳定（昏迷中，等待队友扶起或治疗）`, 'system', currentTurnLabel());
    return true; // 跳过本回合掷骰，但仍占回合
  }

  const roll = Math.floor(Math.random() * 20) + 1;
  let text;
  if (roll === 20) {
    // 自然 20：立即回 1 HP 苏醒；BG3 规则：本回合只能用附赠动作
    playerToken.data.hpCur = 1;
    playerToken.data.downed = false;
    playerToken.data.deathSaves = { successes: 0, failures: 0, stable: false };
    playerToken.element.style.opacity = '1';
    updateTokenHp(playerToken);
    renderInitiativeBar();
    // BG3：苏醒回合只能用附赠动作（本函数仅在玩家回合开始调用，turnResources 属于该角色）
    turnResources.justRevived = true;
    turnResources.action = 0;
    turnResources.moveLeft = 0;
    updateResourceBar();
    text = `${name} 死亡豁免掷出自然 20！立即恢复 1 HP 苏醒！（本回合只能使用附赠动作）`;
    appendCombatLog(text, 'crit', currentTurnLabel());
    updateStatus(text);
    return true;
  }
  if (roll === 1) {
    // 自然 1：失败 +2
    ds.failures += 2;
    text = `${name} 死亡豁免掷出自然 1，失败 +2（累计 ${ds.failures}/3）`;
    appendCombatLog(text, 'system', currentTurnLabel());
    updateStatus(text);
    if (ds.failures >= 3) {
      playerToken.data.dead = true;
      playerToken.data.downed = false;
      playerToken.element.style.opacity = '0.35';
      renderInitiativeBar();
      appendCombatLog(`${name} 死亡豁免失败累计 3 次，已经死亡...`, 'system', currentTurnLabel());
      // 玩家死亡 → 战斗结束（败北）
      setTimeout(() => endCombat(false), 1200);
    }
    return true;
  }
  if (roll >= 10) {
    ds.successes += 1;
    text = `${name} 死亡豁免掷出 ${roll}，成功（累计 ${ds.successes}/3）`;
    appendCombatLog(text, 'heal', currentTurnLabel());
    updateStatus(text);
    if (ds.successes >= 3) {
      ds.stable = true;
      // BG3：稳定后仍昏迷，不自动苏醒；需队友扶起/治疗
      appendCombatLog(`${name} 死亡豁免成功累计 3 次，状态稳定！但仍昏迷，需队友扶起或治疗才能苏醒`, 'system', currentTurnLabel());
    }
    return true;
  }
  // 2~9：失败 +1
  ds.failures += 1;
  text = `${name} 死亡豁免掷出 ${roll}，失败（累计 ${ds.failures}/3）`;
  appendCombatLog(text, 'system', currentTurnLabel());
  updateStatus(text);
  if (ds.failures >= 3) {
    playerToken.data.dead = true;
    playerToken.data.downed = false;
    playerToken.element.style.opacity = '0.35';
    renderInitiativeBar();
    appendCombatLog(`${name} 死亡豁免失败累计 3 次，已经死亡...`, 'system', currentTurnLabel());
    setTimeout(() => endCombat(false), 1200);
  }
  return true;
}

/** 推进到下一个行动者（跳过死亡，到末尾回 0 并轮数 +1） */
function advanceInitiative() {
  currentInitIndex = (currentInitIndex + 1) % initiativeOrder.length;
  if (currentInitIndex === 0) turnCounter++; // 走完一圈
  // 检查战斗是否结束
  if (getAliveEnemies().length === 0) { endCombat(true); return; }
  const p = getPlayerToken();
  if (!p || p.data.dead) { endCombat(false); return; }
  activateCurrent();
}

/** 单只敌人行动（替代旧 runEnemyTurn 的 for 循环） */
async function runSingleEnemyAct(enemy) {
  if (combatPhase !== 'enemy' || enemyTurnRunning) return;
  if (enemy.data.dead) { advanceInitiative(); return; }
  enemyTurnRunning = true;
  const player = getPlayerToken();
  if (!player || player.data.dead) {
    enemyTurnRunning = false;
    if (player && player.data.dead) endCombat(false);
    return;
  }
  await enemyAct(enemy);
  await sleep(600);
  enemyTurnRunning = false;
  // 战斗结束判定（applyResult 内可能已触发 endCombat）
  if (combatPhase === 'victory' || combatPhase === 'defeat') return;
  advanceInitiative();
}

/** 玩家点击结束回合 */
function endPlayerTurn() {
  if (combatPhase !== 'player') return;
  if (state === 'moving' || state === 'jumping' || state === 'targeting') return;
  advanceInitiative();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 敌人单只行动 AI（对等动作经济：移动力 + 1 动作）
 *  BG3 风格智能补刀：
 *  - 有其他活着的、未倒地的玩家方威胁 → 优先打活的（不打倒地）
 *  - 仅剩倒地玩家且未死 → 补刀倒地（近战自动暴击2失败，3次即死）
 *  - 远程射程内直接攻击；够不着先移动，移动后射程内再攻击 */
async function enemyAct(enemy) {
  const player = getPlayerToken();
  if (!player) return;
  const attacks = enemy.data.attacks || [];
  const melee = attacks.find(a => a.name === '弯刀') || attacks[0];
  const ranged = attacks.find(a => a.name === '短弓') || attacks[1] || melee;

  // 攻击范围（格）：近战 1.5m / 远程 6m
  const meleeRange = 1.5 / mapConfig.meters_per_cell; // 1 格
  const rangedRange = 6 / mapConfig.meters_per_cell;  // 4 格

  // 判断玩家方威胁：活且未倒地的 player/ally
  const liveThreats = tokens.filter(t =>
    (t.data.faction === 'player' || t.data.faction === 'ally')
    && !t.data.dead && !t.data.downed
  );
  const playerDowned = player.data.downed === true && !player.data.dead;
  // BG3 智能补刀条件：玩家已倒地且无其他活威胁 → 补刀倒地（不再原地待命）
  const willFinishDowned = playerDowned && liveThreats.length === 0;

  // 玩家倒地但仍有其他活威胁 → 敌人转去应对其他威胁，不打倒地（保留原待命行为）
  if (playerDowned && !willFinishDowned) {
    updateStatus(`${enemy.data.name} 看到玩家倒下，转而应对其他威胁`);
    appendCombatLog(`${enemy.data.name} 原地待命`, 'system', currentTurnLabel());
    await sleep(400);
    return;
  }

  // 目标：补刀时打倒地玩家；否则打活玩家（当前getPlayerToken返回唯一玩家token，两者同一引用）
  const target = player;

  let dist = Math.hypot(enemy.data.col - target.data.col, enemy.data.row - target.data.row);

  // 移动阶段：射程外 → 靠近目标
  if (dist > rangedRange) {
    await moveEnemyToward(enemy);
    dist = Math.hypot(enemy.data.col - target.data.col, enemy.data.row - target.data.row);
  }

  // 动作阶段：射程内攻击（近战优先）
  if (target.data.dead) return;
  if (dist <= meleeRange) {
    const result = resolveAttack(attackerFromEnemy(enemy, melee), targetForEnemy(target), 'melee');
    await applyEnemyAttack(enemy, result, target);
  } else if (dist <= rangedRange) {
    const result = resolveAttack(attackerFromEnemy(enemy, ranged), targetForEnemy(target), 'ranged');
    await applyEnemyAttack(enemy, result, target);
  } else {
    updateStatus(`${enemy.data.name} 原地待命`);
    await sleep(400);
  }
}

/** 把任意目标 token 转成 resolveAttack 需要的目标结构（暴露 downed 标记，5 尺近战昏迷自动暴击） */
function targetForEnemy(target) {
  return {
    name: target?.data?.name || '玩家',
    combat: { ac: target?.data?.ac ?? 12 },
    downed: target?.data?.downed === true,
  };
}

/** 把敌人 attacks 转成 resolveAttack 需要的攻击者结构 */
function attackerFromEnemy(enemy, atk) {
  return {
    name: enemy.data.name,
    attack: {
      melee: { bonus: atk.bonus, damage: atk.damage },
      ranged: { bonus: atk.bonus, damage: atk.damage },
    },
  };
}

/** 敌人攻击结算：复用 applyResult 统一处理倒地、死亡豁免、稳定、暴击等所有逻辑
 *  target 参数为可选（默认 player），用于补刀倒地玩家时传入 */
async function applyEnemyAttack(enemy, result, target) {
  const tgt = target || getPlayerToken();
  if (!tgt) return;
  // 复用 applyResult：处理倒地、死亡豁免（含稳定状态打断）、近战自动暴击等
  applyResult(result, tgt);
  await sleep(600);
}

/** 敌人向玩家方向走一步（沿最短路径首格） */
async function moveEnemyToward(enemy) {
  const player = getPlayerToken();
  if (!player) return;
  // 记录起点（用于借机攻击检测：移动前与 enemy 相邻的玩家方 token）
  const startCol = enemy.data.col;
  const startRow = enemy.data.row;
  const adjAlliesBefore = (!enemy.data._shovedAway)
    ? tokens.filter(t => t.data.faction !== enemy.data.faction && !t.data.dead && cellsAdjacent(startCol, startRow, t.data.col, t.data.row))
    : [];
  const moveCells = getMoveCells(enemy, mapConfig);
  const reachable = calculateReachableCells(
    { col: enemy.data.col, row: enemy.data.row },
    moveCells,
    mapConfig.obstacleSet,
    mapConfig.grid_cols,
    mapConfig.grid_rows
  );
  // 在可达范围内选离玩家最近、且非障碍/非占用的格子
  let best = null, bestDist = Infinity;
  for (const [, info] of reachable) {
    const dist = Math.hypot(info.col - player.data.col, info.row - player.data.row);
    const occ = findTokenAt(info.col, info.row);
    if (occ && occ !== enemy) continue;
    if (dist < bestDist) { bestDist = dist; best = info; }
  }
  if (best && bestDist < Math.hypot(enemy.data.col - player.data.col, enemy.data.row - player.data.row)) {
    updateStatus(`${enemy.data.name} 向 ${player.data.name} 靠近`);
    await moveToken(enemy, best.col, best.row, mapConfig, 260);
    // 借机攻击：enemy 离开了原本相邻的玩家方 token → 玩家方自动结算一次近战
    for (const ao of adjAlliesBefore) {
      if (ao.data.dead) continue;
      if (!cellsAdjacent(enemy.data.col, enemy.data.row, ao.data.col, ao.data.row)) {
        await triggerOpportunityAttack(ao, enemy);
      }
    }
  } else {
    updateStatus(`${enemy.data.name} 原地待命`);
  }
  delete enemy.data._shovedAway;
}

/** 玩家攻击/施法后检查：敌人全灭 → 胜利 */
function checkVictory() {
  if (combatPhase === 'victory' || combatPhase === 'defeat') return;
  if (getAliveEnemies().length === 0) {
    endCombat(true);
    return true;
  }
  return false;
}

function endCombat(won) {
  combatPhase = won ? 'victory' : 'defeat';
  showEndTurnBtn(false);
  hideRangeCircle();
  clearTargetables();
  setTokensClickable(true);
  if (selectedToken) deselect();
  clearHighlights(layers.highlightLayer);
  updateResourceBar(); // 隐藏资源条 + 解锁按钮
  // 战斗结束：标记所有头像非当前，但保留顺序让玩家看到最终局面（死亡者变灰）
  currentInitIndex = -1;
  renderInitiativeBar();
  if (won) {
    updateStatus('战斗胜利！所有敌人已被击败');
    showCombatResult(true);
  } else {
    updateStatus('战斗失败！你倒下了');
    showCombatResult(false);
  }

  // M6：写入战斗结果到 sessionStorage，2.5 秒后跳回 adventure.html
  // 仅当 encounterContext 存在时才回传（独立调试模式不跳转）
  if (encounterContext) {
    const playerToken = tokens.find(t => t.data.faction === 'player');
    const playerEndHp = playerToken ? playerToken.data.hpCur : 0;
    const result = {
      encounterId: encounterContext.encounterId,
      encounterName: encounterContext.encounterName,
      outcome: won ? 'victory' : 'defeat',
      playerEndHp,
      loot: won ? (encounterContext.loot || []) : [],
      clues: won ? (encounterContext.clues || []) : [],
      nextSceneId: won ? (encounterContext.nextSceneId || null) : null,
    };
    try {
      sessionStorage.setItem('combatResult', JSON.stringify(result));
    } catch (e) { console.error('写入 combatResult 失败:', e); }

    // 2.5 秒延迟让玩家看清横幅，再跳转
    setTimeout(() => {
      window.location.href = `adventure.html?combat_result=${encodeURIComponent(encounterContext.encounterId)}`;
    }, 2500);
  }
}

/** 战斗结果提示（居中横幅，胜利/失败显示不同颜色）
 *  M6：嵌入冒险时不再自动消失，等跳转；独立调试模式下 3.5 秒后消失 */
function showCombatResult(won) {
  const container = document.getElementById('combat-map-container');
  if (!container) return;
  const el = document.createElement('div');
  el.style.cssText = `
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    padding: 18px 36px;
    border-radius: 10px;
    font-size: 22px;
    font-weight: 800;
    color: #fff;
    background: ${won ? 'rgba(80, 170, 90, 0.92)' : 'rgba(200, 60, 60, 0.92)'};
    box-shadow: 0 4px 18px rgba(0,0,0,0.4);
    z-index: 50;
    pointer-events: none;
    text-align: center;
  `;
  // M6：嵌入冒险时显示跳转提示
  if (encounterContext) {
    el.innerHTML = won
      ? '⚔ 战斗胜利<br><span style="font-size:14px;font-weight:normal">正在返回冒险流程...</span>'
      : '☠ 战斗失败<br><span style="font-size:14px;font-weight:normal">冒险结束...</span>';
  } else {
    el.textContent = won ? '⚔ 战斗胜利' : '☠ 战斗失败';
  }
  container.appendChild(el);
  // 仅独立调试模式（无 encounterContext）下自动移除横幅
  if (!encounterContext) {
    setTimeout(() => el.remove(), 3500);
  }
}

function showMovementRangeDouble() {
  // 已被动作经济替代：冲刺（Dash）现在直接增加移动力预算 moveLeft
  showMovementRange(selectedToken);
}

/* ── 选中 / 取消 ── */
function select(token) {
  if (selectedToken) deselectToken(selectedToken);
  selectedToken = token;
  selectToken(token);
  showRangeCircle(token);
  showMovementRange(token);
  state = 'selected';
  pendingAction = null;
  clearTargetables();
  updateStatus(`已选中 ${token.data.name}，点击蓝色高亮格移动，或在右侧选择动作`);
}

function deselect() {
  if (selectedToken) {
    deselectToken(selectedToken);
    selectedToken = null;
  }
  currentRange = new Map();
  clearHighlights(layers.highlightLayer);
  hideRangeCircle();
  clearTargetables();
  pendingAction = null;
  state = 'idle';
  updateStatus('点击己方 token 查看移动范围');
}

/* ── 进入选目标状态 ── */
function enterTargeting(action) {
  if (state === 'moving') return;
  if (!selectedToken) return;
  pendingAction = action;
  state = 'targeting';
  // 保留移动范围高亮（便于同时看移动），叠加射程圆 + 目标高亮
  const radiusCells = getActionRangeCells(action);
  if (radiusCells > 0) {
    hideRangeCircle();
    showRangeCircleBy(selectedToken, radiusCells);
  }
  showTargetables();
  const label = action.type === 'spell'
    ? (spellLookup[action.spellId]?.name || action.spellId)
    : (action.kind === 'melee' ? '近战攻击' : '远程攻击');
  const isShove = action.type === 'spell' && action.spellId === 'shove';
  updateStatus(isShove
    ? `${selectedToken.data.name} 选择【推离】，点击相邻敌人将其推远 1 格`
    : `${selectedToken.data.name} 选择【${label}】，点击红色高亮目标`);
}

function cancelTargeting(keepMessage) {
  if (state !== 'targeting') return;
  pendingAction = null;
  clearTargetables();
  hideRangeCircle();
  showRangeCircle(selectedToken);
  showMovementRange(selectedToken);
  state = 'selected';
  if (!keepMessage) {
    updateStatus(`已选中 ${selectedToken.data.name}，可移动或选择动作`);
  }
}

/* ── 点击处理 ── */
async function doMove(targetCol, targetRow) {
  if (!selectedToken) return;
  const targetKey = cellKey(targetCol, targetRow);
  if (!currentRange.has(targetKey)) return;

  const path = reconstructPath(currentRange, { col: targetCol, row: targetRow });
  if (path.length < 2) return;
  // 路径成本（格，含 √2 斜步）→ 米，扣移动力预算
  const costCells = currentRange.get(targetKey)?.cost ?? 0;

  // 记录起点（用于借机攻击检测：移动前与 selectedToken 相邻的敌人）
  const startCol = selectedToken.data.col;
  const startRow = selectedToken.data.row;
  const adjEnemiesBefore = (combatPhase !== 'idle' && !selectedToken.data._shovedAway)
    ? tokens.filter(t => t.data.faction !== selectedToken.data.faction && !t.data.dead && cellsAdjacent(startCol, startRow, t.data.col, t.data.row))
    : [];

  state = 'moving';
  hideRangeCircle();
  clearTargetables();
  pendingAction = null;
  updateStatus(`${selectedToken.data.name} 移动中...`);

  for (let i = 1; i < path.length; i++) {
    await moveToken(selectedToken, path[i].col, path[i].row, mapConfig, 180);
    // 逐格检测：本步是否离开了某个原本相邻的敌人 → 触发借机攻击
    if (adjEnemiesBefore.length > 0) {
      const stillAdj = adjEnemiesBefore.filter(t => !t.data.dead && cellsAdjacent(selectedToken.data.col, selectedToken.data.row, t.data.col, t.data.row));
      const left = adjEnemiesBefore.filter(t => !t.data.dead && !stillAdj.includes(t));
      for (const ao of left) {
        await triggerOpportunityAttack(ao, selectedToken);
      }
      // 清除已触发的敌人，避免重复触发
      adjEnemiesBefore.length = 0;
      adjEnemiesBefore.push(...stillAdj);
    }
  }
  // 清理推离标记（推离只在被推的那次移动豁免）
  delete selectedToken.data._shovedAway;

  if (combatPhase !== 'idle') {
    turnResources.moveLeft = Math.max(0, turnResources.moveLeft - costCells * mapConfig.meters_per_cell);
    updateResourceBar();
  }
  // 保持选中：支持「移动 → 攻击 → 再移动」拆分（剩余预算见资源条）
  select(selectedToken);
  updateStatus(`移动完成（剩余移动力 ${Math.round(turnResources.moveLeft * 10) / 10} 米）`);
  if (combatPhase !== 'idle') {
    appendCombatLog(`${selectedToken.data.name} 移动 ${costCells} 格（剩余 ${Math.round(turnResources.moveLeft * 10) / 10}m）`, 'move', currentTurnLabel());
  }
}

/** 8 方向相邻判定（含斜角） */
function cellsAdjacent(c1, r1, c2, r2) {
  return Math.abs(c1 - c2) <= 1 && Math.abs(r1 - r2) <= 1 && !(c1 === c2 && r1 === r2);
}

/** 借机攻击触发：attacker 对 mover 自动结算一次近战攻击（不消耗反应预算，第一版简化） */
async function triggerOpportunityAttack(attacker, mover) {
  if (!attacker || !mover || mover.data.dead) return;
  // 按阵营构造 resolveAttack 需要的攻击者结构：
  //   - 玩家：data.character 已含 attack.melee.bonus/damage（与普通攻击 resolveAttack(char,...) 同源）
  //   - 敌人：用 attackerFromEnemy 把扁平 attacks 项转成 { name, attack:{melee,ranged} } 结构
  // 否则会出现：玩家移动离开敌人 → 敌人 data.character 为 undefined → 早返回不触发；
  //              敌人移动离开玩家 → 玩家 data.attacks 为空 → melee 为 undefined → 早返回不触发。
  let atkChar;
  if (attacker.data.faction === 'player') {
    atkChar = attacker.data.character;
    if (!atkChar) return;
  } else {
    const attacks = attacker.data.attacks || [];
    const melee = attacks.find(a => a.name === '弯刀') || attacks[0];
    if (!melee) return;
    atkChar = attackerFromEnemy(attacker, melee);
  }
  const target = { name: mover.data.name, combat: { ac: mover.data.ac ?? 15 } };
  const result = resolveAttack(atkChar, target, 'melee');
  applyResult(result, mover);
  // 借机攻击单独标记（applyResult 已写伤害日志，这里补"借机"前缀）
  if (result.text) {
    appendCombatLog(`【借机】${result.text}`, result.damage > 0 ? 'attack' : 'system', currentTurnLabel());
  }
  await sleep(400);
}

function findTokenAt(col, row) {
  return tokens.find(t => t.data.col === col && t.data.row === row);
}

function handleMapClick(e) {
  if (state === 'moving') return;
  // 非玩家回合禁止操作
  if (combatPhase !== 'idle' && combatPhase !== 'player') return;

  const container = document.getElementById('combat-map-container');
  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cell = pixelToCell(mapConfig, x, y);

  if (cell.col < 0 || cell.col >= mapConfig.grid_cols || cell.row < 0 || cell.row >= mapConfig.grid_rows) {
    if (state === 'targeting') cancelTargeting();
    else if (state === 'jumping') cancelJump();
    else deselect();
    return;
  }

  // 点击的格子上有 token
  const tokenOnCell = findTokenAt(cell.col, cell.row);

  if (state === 'jumping') {
    // 跳跃：点击任意落点（可落在敌人/障碍格上，到达后处理），点空白或范围内则跳跃
    const dist = Math.hypot(cell.col - selectedToken.data.col, cell.row - selectedToken.data.row);
    if (dist <= jumpRangeCells + 1e-6) {
      doJump(cell.col, cell.row);
    } else {
      cancelJump();
    }
    return;
  }

  if (state === 'targeting') {
    if (tokenOnCell && targetableTokens.includes(tokenOnCell)) {
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
    if (selectedToken !== tokenOnCell) {
      if (selectedToken) deselect();
      select(tokenOnCell);
    } else {
      deselect();
    }
    return;
  }

  if (state === 'selected') {
    const key = cellKey(cell.col, cell.row);
    if (currentRange.has(key)) {
      doMove(cell.col, cell.row);
    } else {
      deselect();
    }
  }
}

function handleTokenClick(token) {
  if (state === 'moving') return;
  if (combatPhase !== 'idle' && combatPhase !== 'player') return;
  if (state === 'jumping') {
    // 跳跃落点选在 token 所在格：跳到该 token 旁或直接落点
    const dist = Math.hypot(token.data.col - selectedToken.data.col, token.data.row - selectedToken.data.row);
    if (dist <= jumpRangeCells + 1e-6) {
      doJump(token.data.col, token.data.row);
    } else {
      cancelJump();
    }
    return;
  }
  // targeting 状态：点击 targetableTokens 中的任意 token（含自己 — 触碰法术自疗）触发结算
  // 原实现只匹配 faction === 'enemy'，导致治愈术点击玩家自身 token 落到下面 deselect 分支，
  // 不触发 executePendingAction → 自疗完全无效
  if (state === 'targeting' && targetableTokens.includes(token)) {
    executePendingAction(token);
    cancelTargeting(true); // 保留结算文字
    return;
  }
  if (token.data.faction !== 'player') {
    if (selectedToken && state !== 'targeting') deselect();
    return;
  }
  if (selectedToken === token) {
    deselect();
    return;
  }
  select(token);
}

function updateStatus(text) {
  const statusEl = document.getElementById('combat-status');
  if (statusEl) statusEl.textContent = text;
}

/** 战斗日志：追加一条记录到左侧日志区
 * @param {string} text - 日志内容
 * @param {'attack'|'heal'|'move'|'system'|'crit'} type - 类型（决定颜色）
 * @param {string} turnLabel - 回合标签（保留参数兼容，实际按 turnCounter 分组）
 * @param {boolean} skipDivider - 跳过分隔条插入（用于战斗开场等非轮次内日志） */
function appendCombatLog(text, type = 'system', turnLabel = '', skipDivider = false) {
  const logEl = document.getElementById('combat-log');
  if (!logEl) return;
  // 清空"战斗尚未开始"占位
  const empty = logEl.querySelector('.combat-log-empty');
  if (empty) empty.remove();
  // 按轮次分组：进入新一轮时插入分隔条，同一轮内所有角色动作合并在同一组
  // skipDivider=true 时跳过分隔条，且不更新 lastLogTurn，下次调用仍会按当前轮次插入
  if (!skipDivider) {
    const turnKey = `第${turnCounter}轮`;
    if (turnKey !== lastLogTurn) {
      const divider = document.createElement('div');
      divider.className = 'combat-log-divider';
      divider.textContent = `── ${turnKey} ──`;
      logEl.appendChild(divider);
      lastLogTurn = turnKey;
    }
  }
  const entry = document.createElement('div');
  entry.className = `combat-log-entry log-${type}`;
  entry.textContent = text; // textContent 自动转义，防注入
  logEl.appendChild(entry);
  // 自动滚动到底部
  logEl.scrollTop = logEl.scrollHeight;
}

/** HTML 转义，防注入 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/** 当前回合标签（用于日志前缀） */
function currentTurnLabel() {
  const cur = initiativeOrder[currentInitIndex];
  const name = cur?.name || '未知';
  return `第${turnCounter}轮 ${name}`;
}

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
  for (const token of tokens) {
    updateTokenPosition(token, mapConfig);
    updateTokenHp(token);
    layers.tokenLayer.appendChild(token.element);
  }
}

async function initMap() {
  const container = document.getElementById('combat-map-container');
  if (!container) return;

  try {
    // M6：从 URL 参数读取遭遇上下文（无参数时回退到调试模式，写死 triboar-trail-ambush）
    const params = new URLSearchParams(window.location.search);
    const encounterId = params.get('encounter');
    if (encounterId) {
      try {
        const raw = sessionStorage.getItem('encounterContext');
        if (raw) encounterContext = JSON.parse(raw);
      } catch (e) { console.warn('读取 encounterContext 失败:', e); }
    }

    const mapId = encounterContext?.mapId || 'triboar-trail-ambush';
    if (!mapConfig) {
      mapConfig = await loadMapConfig(mapId);
    }

    await loadCombatData();

    const img = await loadImage(mapConfig.image);
    const wrapper = container.parentElement;
    const dims = computeMapDimensions(
      img.naturalWidth,
      img.naturalHeight,
      wrapper.clientWidth - 48,
      wrapper.clientHeight - 48
    );

    layers = renderMap(container, mapConfig, dims.widthPx, dims.heightPx);

    if (tokens.length === 0) {
      // M6：玩家角色 id 优先从 encounterContext.playerSnapshot.charId 取（默认 elias）
      const charId = encounterContext?.playerSnapshot?.charId || 'elias';
      const char = await loadCharacter(charId);
      recalcAttack(char);
      // M6：用玩家快照中的 HP/AC 覆盖角色数据（保证战斗地图与冒险流程状态同步）
      if (encounterContext?.playerSnapshot) {
        const ps = encounterContext.playerSnapshot;
        char.combat = char.combat || { ac: 10, hp: '0 / 0' };
        char.combat.ac = ps.ac || char.combat.ac;
        char.combat.hp = `${ps.hpCur} / ${ps.hpMax}`;
      }
      const playerSpawn = mapConfig.spawns.players[0];
      const playerToken = createPlayerToken(char, playerSpawn);
      playerToken.data.character = char;
      tokens.push(playerToken);
      attachTokenClick(playerToken);

      // M6：敌人列表优先用 encounterContext.enemies；回退到调试模式 4 只地精
      const enemyIds = encounterContext?.enemies || ['goblin-ambusher-1', 'goblin-ambusher-2', 'goblin-ambusher-3', 'goblin-ambusher-4'];
      enemyIds.forEach((npcId, i) => {
        const spawn = mapConfig.spawns.enemies[i] || mapConfig.spawns.enemies[mapConfig.spawns.enemies.length - 1];
        if (!spawn) return; // spawn 不够则跳过
        const enemyToken = createEnemyToken(npcId, spawn, i);
        tokens.push(enemyToken);
        attachTokenClick(enemyToken);
      });
    }

    renderTokens();
    setupInteractions();
    // M6：战斗准备文案显示遭遇名（若有）
    const prepText = encounterContext?.encounterName
      ? `遭遇：${encounterContext.encounterName}，掷先攻中...`
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

/* ── 对外 API（供 combat-map.html 右侧动作面板调用） ── */
window.__combatApi = {
  /** 选择需要目标的操作：attack(melee/ranged) / spell(spellId)。无需先点角色，自动选中己方 token */
  selectAction(action) {
    if (combatPhase !== 'idle' && combatPhase !== 'player') {
      updateStatus('敌人回合中，请等待');
      return;
    }
    if (!trySpendCost(action)) return; // 动作/附赠预算校验
    ensurePlayerSelected();
    if (!selectedToken) {
      updateStatus('请先点击自己的 token');
      return;
    }
    enterTargeting(action);
  },
  cancelAction() {
    if (state === 'jumping') cancelJump();
    else cancelTargeting();
  },
  /** 自身目标动作：jump / dash / second_wind / recovery / fighting_spirit 等 */
  useSelfAction(action) {
    if (combatPhase !== 'idle' && combatPhase !== 'player') {
      updateStatus('敌人回合中，请等待');
      return;
    }
    ensurePlayerSelected();
    if (!selectedToken) {
      updateStatus('请先点击自己的 token');
      return;
    }
    useSelfAction(action);
  },
  /** 结算后回调（右侧面板刷新 HP / 法术位） */
  onResolve: null,
  /** 动作预算变化回调（右侧面板刷新按钮置灰），参数为 turnResources 快照 */
  onTurnChanged: null,
  getSelectedToken() { return selectedToken; },
  getPlayerToken() { return getPlayerToken(); },
  getState() { return state; },
  getCombatPhase() { return combatPhase; },
  getTurnResources() { return { ...turnResources }; },
  getSpellLookup() { return spellLookup; },
};

/** 若当前未选中 token，自动选中己方玩家 token（战斗地图只操控一个玩家） */
function ensurePlayerSelected() {
  if (selectedToken) return;
  const playerToken = tokens.find(t => t.data.faction === 'player');
  if (playerToken) select(playerToken);
}

// 暴露给调试
window.__combatDebug = {
  get mapConfig() { return mapConfig; },
  get tokens() { return tokens; },
  get selectedToken() { return selectedToken; },
  get currentRange() { return currentRange; },
  get state() { return state; },
  get pendingAction() { return pendingAction; },
  pixelToCell: (x, y) => pixelToCell(mapConfig, x, y),
  cellToPixel: (c, r) => cellToPixel(mapConfig, c, r),
};

window.addEventListener('DOMContentLoaded', initMap);
