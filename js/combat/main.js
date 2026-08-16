/**
 * 战斗地图主逻辑：加载、渲染、交互状态机
 * 状态：idle → selected（选中己方）→ moving（移动中）→ targeting（选目标施放）
 */

import { loadMapConfig, loadImage, renderMap, computeMapDimensions, pixelToCell, highlightCells, clearHighlights, cellToPixel } from './map.js';
import { createToken, moveToken, selectToken, deselectToken, updateTokenPosition, getMoveCells, updateTokenHp, spawnFloatingText } from './token.js';
import { calculateReachableCells, filterByRadius, reconstructPath, parseMeters, metersToCells, cellKey } from './movement.js';
import { resolveAttack, resolveSpell, resolveSelfAction, hpMax, hpCur } from './actions.js';

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

// 当前选中的动作（targeting 时有效）：{type:'attack', kind} | {type:'spell', spellId}
let pendingAction = null;
// 射程内的可点击目标
let targetableTokens = [];

// NPC / 法术目录（从后端 JSON 加载，供结算用）
let npcCatalog = {};
let spellLookup = {};
let equipmentCatalog = {};

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return await res.json();
}

async function loadCombatData() {
  try {
    const npcData = await loadJson(NPC_JSON);
    npcCatalog = npcData.npcs || {};
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
  }, mapConfig);
}

/** 敌人 token：id 关联 npc 目录（goblin-1 → goblin-ambusher-1），读取 HP/AC/攻击 */
function createEnemyToken(index, spawn) {
  const npcId = `goblin-ambusher-${index + 1}`;
  const npc = npcCatalog[npcId] || {};
  const combat = npc.combat || {};
  const hp = combat.hp || {};
  const attacks = (combat.attacks || []).map(a => ({
    name: a.name || '攻击',
    bonus: a.bonus || 0,
    damage: a.damage || '1d4',
    type: a.type || '挥砍',
  }));
  return createToken({
    id: npcId,
    name: npc.name || `地精${index + 1}`,
    portrait: '地',
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

/* ── 移动范围（复用原有逻辑） ── */
function showMovementRange(token) {
  const moveCells = getMoveCells(token, mapConfig);
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
  const moveCells = getMoveCells(token, mapConfig);
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
  for (const t of tokens) {
    if (t.data.faction !== 'enemy') continue;
    const dist = Math.hypot(t.data.col - selectedToken.data.col, t.data.row - selectedToken.data.row);
    if (dist <= radiusCells + 1e-6) {
      t.circle.style.boxShadow = '0 0 0 3px rgba(255, 255, 255, 0.9), 0 0 12px rgba(255, 80, 80, 0.9)';
      targetableTokens.push(t);
    }
  }
  if (targetableTokens.length === 0) {
    updateStatus('射程内没有可攻击的目标');
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
    targetToken.data.hpCur = Math.max(0, (targetToken.data.hpCur ?? 0) - result.damage);
    updateTokenHp(targetToken);
    spawnFloatingText(targetToken, `-${result.damage}`, '#ff6b6b');
    if (targetToken.data.hpCur <= 0) {
      targetToken.element.style.opacity = '0.35';
      targetToken.data.dead = true;
    }
  }
  // 治疗 → 加 HP + 飘字
  if (result.heal > 0 && selectedToken) {
    selectedToken.data.hpCur = Math.min(
      selectedToken.data.hpMax ?? 100,
      (selectedToken.data.hpCur ?? 0) + result.heal
    );
    updateTokenHp(selectedToken);
    spawnFloatingText(selectedToken, `+${result.heal}`, '#7bed9f');
  }
  updateStatus(result.text || '');
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

  let result = null;
  if (pendingAction.type === 'attack') {
    const target = { name: targetToken.data.name, combat: { ac: targetToken.data.ac ?? 15 } };
    result = resolveAttack(char, target, pendingAction.kind);
  } else if (pendingAction.type === 'spell') {
    const spell = spellLookup[pendingAction.spellId];
    const target = targetToken ? { name: targetToken.data.name, combat: { ac: targetToken.data.ac ?? 15 } } : null;
    result = resolveSpell(spell, char, target);
    // 法术不消耗法术位（第一版简化，后续接后端）
  }
  if (result) applyResult(result, targetToken);
}

function useSelfAction(action) {
  const char = selectedToken?.data?.character;
  if (!char) return;
  if (action.id === 'jump') {
    startJump(char);
    return;
  }
  const result = resolveSelfAction(action, char);
  if (result.dash) {
    // 冲刺：移动范围翻倍（重新计算并高亮）
    showMovementRangeDouble();
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

  state = 'moving';
  hideRangeCircle();
  setTokensClickable(true);
  updateStatus(`${selectedToken.data.name} 跳跃中...`);
  // 跳跃无视障碍，直接移动到落点
  await moveToken(selectedToken, col, row, mapConfig, 320);
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

/** 掷先攻：d20 + 敏捷调整值。返回 { player, enemies, playerFirst } */
function rollInitiative() {
  const player = getPlayerToken();
  const char = player?.data?.character || {};
  const pDex = abilityMod(char?.abilities?.dex?.value ?? 10);
  const playerRoll = Math.floor(Math.random() * 20) + 1 + pDex;
  // 地精群体取最高先攻（简化：取第一只存活地精），地精 dex 由 combat 提供
  const enemies = getAliveEnemies();
  let enemyRoll = -Infinity;
  for (const e of enemies) {
    const dex = abilityMod(e.data.enemyDex ?? 14);
    enemyRoll = Math.max(enemyRoll, Math.floor(Math.random() * 20) + 1 + dex);
  }
  return { player: playerRoll, enemies: enemyRoll, playerFirst: playerRoll >= enemyRoll };
}

function showEndTurnBtn(show) {
  const btn = document.getElementById('btn-end-turn');
  if (btn) btn.style.display = show ? 'inline-block' : 'none';
}

/** 战斗开始：掷先攻，决定谁先动 */
function startCombat() {
  const init = rollInitiative();
  const playerName = getPlayerToken()?.data?.name || '玩家';
  const first = init.playerFirst ? playerName : '地精';
  updateStatus(`战斗开始！先攻：${playerName} ${init.player} vs 地精 ${init.enemies}，${first}先行动`);
  combatPhase = init.playerFirst ? 'player' : 'enemy';
  if (combatPhase === 'player') {
    showEndTurnBtn(true);
    select(getPlayerToken());
  } else {
    showEndTurnBtn(false);
    deselect();
    setTimeout(() => runEnemyTurn(), 1200);
  }
}

/** 玩家点击结束回合 */
function endPlayerTurn() {
  if (combatPhase !== 'player') return;
  if (state === 'moving' || state === 'jumping' || state === 'targeting') return;
  combatPhase = 'enemy';
  showEndTurnBtn(false);
  deselect();
  updateStatus('地精回合...');
  setTimeout(() => runEnemyTurn(), 600);
}

/** 敌人回合：存活地精逐只行动 */
async function runEnemyTurn() {
  if (combatPhase !== 'enemy' || enemyTurnRunning) return;
  enemyTurnRunning = true;
  const player = getPlayerToken();
  if (!player || player.data.dead) {
    endCombat(false);
    enemyTurnRunning = false;
    return;
  }
  const enemies = getAliveEnemies();
  for (const enemy of enemies) {
    if (combatPhase !== 'enemy') break;
    if (player.data.dead) break;
    await enemyAct(enemy);
    if (combatPhase === 'enemy' && player.data.dead) break;
    await sleep(700);
  }
  enemyTurnRunning = false;
  // 敌人回合结束 → 回到玩家回合
  if (combatPhase === 'enemy') {
    combatPhase = 'player';
    const p = getPlayerToken();
    if (p && !p.data.dead) select(p);
    showEndTurnBtn(true);
    updateStatus('你的回合！行动后点击「结束回合」');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 敌人单只行动 AI：近战 → 弯刀；短弓射程 → 短弓；够不着 → 靠近玩家 */
async function enemyAct(enemy) {
  const player = getPlayerToken();
  if (!player) return;
  const dist = Math.hypot(enemy.data.col - player.data.col, enemy.data.row - player.data.row);
  const attacks = enemy.data.attacks || [];
  const melee = attacks.find(a => a.name === '弯刀') || attacks[0];
  const ranged = attacks.find(a => a.name === '短弓') || attacks[1] || melee;

  // 攻击范围（格）：近战 1.5m / 远程 6m
  const meleeRange = 1.5 / mapConfig.meters_per_cell; // 1 格
  const rangedRange = 6 / mapConfig.meters_per_cell;  // 4 格

  if (dist <= meleeRange) {
    const result = resolveAttack(attackerFromEnemy(enemy, melee), playerTarget(), 'melee');
    await applyEnemyAttack(enemy, result);
    return;
  }
  if (dist <= rangedRange) {
    const result = resolveAttack(attackerFromEnemy(enemy, ranged), playerTarget(), 'ranged');
    await applyEnemyAttack(enemy, result);
    return;
  }
  // 够不着：向玩家靠近一格
  await moveEnemyToward(enemy);
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

function playerTarget() {
  const p = getPlayerToken();
  return { name: p?.data?.name || '玩家', combat: { ac: p?.data?.ac ?? 12 } };
}

/** 敌人攻击结算：伤害扣到玩家，同步右侧面板 */
async function applyEnemyAttack(enemy, result) {
  const player = getPlayerToken();
  if (!player) return;
  if (result.damage > 0 && !player.data.dead) {
    player.data.hpCur = Math.max(0, (player.data.hpCur ?? 0) - result.damage);
    updateTokenHp(player);
    spawnFloatingText(player, `-${result.damage}`, '#ff6b6b');
  }
  updateStatus(result.text || '');
  // 同步右侧角色卡 HP
  if (window.__combatApi && typeof window.__combatApi.onResolve === 'function') {
    window.__combatApi.onResolve(result);
  }
  if (player.data.hpCur <= 0) {
    player.data.dead = true;
    player.element.style.opacity = '0.35';
    endCombat(false);
  }
  await sleep(600);
}

/** 敌人向玩家方向走一步（沿最短路径首格） */
async function moveEnemyToward(enemy) {
  const player = getPlayerToken();
  if (!player) return;
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
  } else {
    updateStatus(`${enemy.data.name} 原地待命`);
  }
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
  if (won) {
    updateStatus('战斗胜利！所有敌人已被击败');
    showCombatResult(true);
  } else {
    updateStatus('战斗失败！你倒下了');
    showCombatResult(false);
  }
}

/** 战斗结果提示（居中横幅，3.5 秒后自动消失） */
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
  el.textContent = won ? '⚔ 战斗胜利' : '☠ 战斗失败';
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function showMovementRangeDouble() {
  const moveCells = getMoveCells(selectedToken, mapConfig) * 2;
  const reachable = calculateReachableCells(
    { col: selectedToken.data.col, row: selectedToken.data.row },
    moveCells,
    mapConfig.obstacleSet,
    mapConfig.grid_cols,
    mapConfig.grid_rows
  );
  currentRange = filterByRadius(reachable, { col: selectedToken.data.col, row: selectedToken.data.row }, moveCells);
  highlightCells(layers.highlightLayer, currentRange, mapConfig);
  hideRangeCircle();
  showRangeCircleBy(selectedToken, moveCells);
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
  updateStatus(`${selectedToken.data.name} 选择【${label}】，点击红色高亮目标`);
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

  state = 'moving';
  hideRangeCircle();
  clearTargetables();
  pendingAction = null;
  updateStatus(`${selectedToken.data.name} 移动中...`);

  for (let i = 1; i < path.length; i++) {
    await moveToken(selectedToken, path[i].col, path[i].row, mapConfig, 180);
  }

  deselect();
  updateStatus('移动完成');
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
    if (tokenOnCell && tokenOnCell.data.faction === 'enemy' && targetableTokens.includes(tokenOnCell)) {
      executePendingAction(tokenOnCell);
      cancelTargeting(true); // 保留结算文字
    } else if (tokenOnCell && tokenOnCell.data.faction === 'player') {
      cancelTargeting();
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
  // 非玩家回合禁止操作
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
  if (token.data.faction === 'enemy' && state === 'targeting' && targetableTokens.includes(token)) {
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
    if (!mapConfig) {
      mapConfig = await loadMapConfig('triboar-trail-ambush');
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
      const char = await loadCharacter('elias');
      recalcAttack(char);
      const playerSpawn = mapConfig.spawns.players[0];
      const playerToken = createPlayerToken(char, playerSpawn);
      playerToken.data.character = char;
      tokens.push(playerToken);
      attachTokenClick(playerToken);

      mapConfig.spawns.enemies.forEach((spawn, i) => {
        const enemyToken = createEnemyToken(i, spawn);
        tokens.push(enemyToken);
        attachTokenClick(enemyToken);
      });
    }

    renderTokens();
    setupInteractions();
    updateStatus('战斗准备中，掷先攻...');
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
  getSelectedToken() { return selectedToken; },
  getPlayerToken() { return getPlayerToken(); },
  getState() { return state; },
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
