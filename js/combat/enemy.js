/**
 * 敌人回合 AI
 * 职责：单只敌人行动决策（选目标 → 移动 → 攻击）
 * 规则：与玩家对等动作经济（移动力 + 1 动作）；BG3 风格智能补刀
 * 攻击选择：数据驱动（attacks[].kind 分近战/远程），不按武器名硬编码
 */

import { resolveAttack } from './actions.js';
import { moveToken, getMoveCells } from './token.js';
import { calculateReachableCells, reconstructPath } from './movement.js';
import { combatState } from './state.js';
import { appendCombatLog, currentTurnLabel, updateStatus } from './combat-ui.js';
import { getPlayerToken, advanceInitiative, endCombat } from './combat-loop.js';
import { cellsAdjacent, targetForEnemy, attackerFromEnemy, pickMeleeAttack, pickRangedAttack, sleep } from './rules.js';
import { getCellZ } from './map.js';
import { MELEE_RANGE_CELLS, RANGED_RANGE_CELLS } from './constants.js';
import { isTokenVisible, revealAttacker, fogDisplayName } from './fog.js';

const S = combatState;

/** 单只敌人行动入口（combat-loop.activateCurrent 每敌人回合调用一次） */
export async function runSingleEnemyAct(enemy) {
  if (S.combatPhase !== 'enemy' || S.enemyTurnRunning) return;
  // 死亡或昏迷 NPC 跳过回合（昏迷无法行动）
  if (enemy.data.dead || enemy.data.unconscious) { advanceInitiative(); return; }
  S.enemyTurnRunning = true;
  const player = getPlayerToken();
  if (!player || player.data.dead) {
    S.enemyTurnRunning = false;
    if (player && player.data.dead) endCombat(false);
    return;
  }
  await enemyAct(enemy);
  await sleep(600);
  S.enemyTurnRunning = false;
  // 战斗结束判定（applyResult 内可能已触发 endCombat）
  if (S.combatPhase === 'victory' || S.combatPhase === 'defeat') return;
  advanceInitiative();
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
  // 数据驱动选攻击：按 kind 字段（近战/远程），不再按武器名硬编码
  const melee = pickMeleeAttack(attacks);
  const rangedAtk = pickRangedAttack(attacks);
  const ranged = rangedAtk || melee;

  // 攻击范围（格）：射程归一化为全局常量（近战 1 格 / 远程 6 格）
  // 无远程武器时（rangedAtk 为空）按近战射程处理，避免近战生物凭空获得远程攻击距离
  const meleeRange = MELEE_RANGE_CELLS;
  const rangedRange = rangedAtk ? RANGED_RANGE_CELLS : meleeRange;

  // 判断玩家方威胁：活且未倒地的 player/ally
  const liveThreats = S.tokens.filter(t =>
    (t.data.faction === 'player' || t.data.faction === 'ally')
    && !t.data.dead && !t.data.downed
  );
  const playerDowned = player.data.downed === true && !player.data.dead;
  // BG3 智能补刀条件：玩家已倒地且无其他活威胁 → 补刀倒地（不再原地待命）
  const willFinishDowned = playerDowned && liveThreats.length === 0;

  // 玩家倒地但仍有其他活威胁 → 敌人转去应对其他威胁，不打倒地（保留原待命行为）
  if (playerDowned && !willFinishDowned) {
    if (isTokenVisible(enemy)) {
      updateStatus(`${fogDisplayName(enemy)} 看到玩家倒下，转而应对其他威胁`);
      appendCombatLog(`${fogDisplayName(enemy)} 原地待命`, 'system', currentTurnLabel());
    } else {
      // 未现身的雾中敌人：不点名、不写日志，也不说"看到玩家倒下"
      // （那等于告诉玩家有个看不见的东西正盯着他）
      updateStatus('远处传来一阵骚动...');
    }
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
    // 未现身的雾中敌人：静默（"原地待命"会暴露有隐藏单位在活动，且本就无动静可播报）
    if (isTokenVisible(enemy)) updateStatus(`${fogDisplayName(enemy)} 原地待命`);
    await sleep(400);
  }
}

/** 敌人攻击结算：复用 applyResult 统一处理倒地、死亡豁免、稳定、暴击等所有逻辑
 *  target 参数为可选（默认 player），用于补刀倒地玩家时传入 */
async function applyEnemyAttack(enemy, result, target) {
  const tgt = target || getPlayerToken();
  if (!tgt) return;
  // 攻击即现身（5e：unseen attacker reveals on attack）：雾中开火暴露位置，现身后再播报
  revealAttacker(enemy);
  // 复用 applyResult：处理倒地、死亡豁免（含稳定状态打断）、近战自动暴击等
  const { applyResult } = await import('./main.js');
  applyResult(result, tgt);
  await sleep(600);
}

/** 敌人向玩家方向走一步（沿最短路径首格） */
export async function moveEnemyToward(enemy) {
  const player = getPlayerToken();
  if (!player) return;
  const mapConfig = S.mapConfig;
  // 记录起点（用于借机攻击检测：移动前与 enemy 相邻的玩家方 token）
  const startCol = enemy.data.col;
  const startRow = enemy.data.row;
  const adjAlliesBefore = (!enemy.data._shovedAway)
    ? S.tokens.filter(t => t.data.faction !== enemy.data.faction && !t.data.dead && cellsAdjacent(startCol, startRow, t.data.col, t.data.row))
    : [];
  const moveCells = getMoveCells(enemy);
  const reachable = calculateReachableCells(
    { col: enemy.data.col, row: enemy.data.row },
    moveCells,
    mapConfig.obstacleSet,
    mapConfig.grid_cols,
    mapConfig.grid_rows
  );
  // 在可达范围内选离玩家最近、且非障碍/非占用的格子。
  // 高度兜底（§7.3）：Dijkstra 不感知高度，路径可能穿崖壁。按距离从近到远逐候选重建路径，
  // 任一步 |Δz| ≥ 2 即跳过该候选，避免敌人无消耗翻崖（上不去就停在崖壁旁待命）。
  const candidates = [];
  for (const [, info] of reachable) {
    const occ = findTokenAt(info.col, info.row);
    if (occ && occ !== enemy) continue;
    candidates.push(info);
  }
  candidates.sort((a, b) =>
    Math.hypot(a.col - player.data.col, a.row - player.data.row)
    - Math.hypot(b.col - player.data.col, b.row - player.data.row));
  let best = null;
  for (const info of candidates) {
    const path = reconstructPath(reachable, info);
    let crossesCliff = false;
    for (let i = 1; i < path.length; i++) {
      const dz = getCellZ(mapConfig, path[i].col, path[i].row)
        - getCellZ(mapConfig, path[i - 1].col, path[i - 1].row);
      if (Math.abs(dz) >= 2) { crossesCliff = true; break; }
    }
    if (!crossesCliff) { best = info; break; }
  }
  const bestDist = best
    ? Math.hypot(best.col - player.data.col, best.row - player.data.row)
    : Infinity;
  if (best && bestDist < Math.hypot(enemy.data.col - player.data.col, enemy.data.row - player.data.row)) {
    // 未现身的雾中敌人：只给不点名、不含方向的声响提示
    // （原为"黑暗中的存在 向 XXX 靠近"，既报了存在又泄露了移动目标）
    updateStatus(isTokenVisible(enemy)
      ? `${fogDisplayName(enemy)} 向 ${player.data.name} 靠近`
      : '某处传来移动的声响');
    await moveToken(enemy, best.col, best.row, mapConfig, 260);
    // 借机攻击：enemy 离开了原本相邻的玩家方 token → 玩家方自动结算一次近战
    const { triggerOpportunityAttack } = await import('./rules.js');
    for (const ao of adjAlliesBefore) {
      if (ao.data.dead) continue;
      if (!cellsAdjacent(enemy.data.col, enemy.data.row, ao.data.col, ao.data.row)) {
        await triggerOpportunityAttack(ao, enemy);
      }
    }
  } else {
    // 未现身的雾中敌人：静默（同射程外待命）
    if (isTokenVisible(enemy)) updateStatus(`${fogDisplayName(enemy)} 原地待命`);
  }
  delete enemy.data._shovedAway;
}

/** 查找占据指定格子的 token */
export function findTokenAt(col, row) {
  return S.tokens.find(t => t.data.col === col && t.data.row === row);
}
