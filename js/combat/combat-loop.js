/**
 * 战斗回合循环
 * 职责：先攻推进（activateCurrent / advanceInitiative）、行动经济预算（成本/扣减/重置）、胜负判定
 * 玩家回合交还 main.js 事件交互；敌人回合调 enemy.js AI
 */

import { parseMeters } from './movement.js';
import { getMoveCells } from './token.js';
import { combatState } from './state.js';
import { appendCombatLog, currentTurnLabel, updateStatus, updateResourceBar, showEndTurnBtn, renderInitiativeBar, showCombatResult } from './combat-ui.js';
import { runPlayerDeathSave } from './rules.js';
import { runSingleEnemyAct } from './enemy.js';
import { fogDisplayName } from './fog.js';
import { CELL_METERS } from './constants.js';

const S = combatState;

/** 查找玩家 token（当前战斗地图只操控一个玩家） */
export function getPlayerToken() {
  return S.tokens.find(t => t.data.faction === 'player');
}

/** 存活敌人列表：昏迷 NPC 不算威胁（D&D 5e RAW：昏迷生物无威胁，可战后处置） */
export function getAliveEnemies() {
  return S.tokens.filter(t => t.data.faction === 'enemy' && !t.data.dead && !t.data.unconscious);
}

/** 是否为空地图测试模式（没有任何敌人 token）：用于在空地图上自由移动、检查墙壁 */
export function isTestingMap() {
  return !S.tokens.some(t => t.data.faction === 'enemy');
}

/* ── 行动经济 ── */

/** action_type 文案 → 消耗类型：'action' | 'bonus' | 'free' */
export function costFromType(type, fallback = 'action') {
  if (type === '附赠动作') return 'bonus';
  if (type === '1动作') return 'action';
  if (type === '自由动作') return 'free';
  return fallback;
}

/** 地图动作 → 消耗类型：攻击一律动作；法术/动作读 spells.json 的 action_type（默认 1 动作） */
export function actionCostOf(action) {
  if (!action) return 'free';
  if (action.type === 'attack') return 'action';
  // 自身动作（useSelfAction 传 {id:'xxx'}）/ 法术（{type:'spell', spellId}）统一查 spellLookup
  const id = action.type === 'spell' ? action.spellId : action.id;
  if (id) {
    const def = S.spellLookup[id];
    if (def) return costFromType(def.action_type, 'action');
  }
  return costFromType(action.action_type, 'action');
}

/** 战斗外（idle）不限制；预算不足则提示并返回 false */
export function trySpendCost(action) {
  if (S.combatPhase === 'idle') return true;
  const cost = actionCostOf(action);
  if (cost === 'free') return true;
  // BG3 规则：苏醒回合（被扶起/自然20/治疗）只能用附赠动作 → 禁止动作
  if (S.turnResources.justRevived && cost === 'action') {
    updateStatus('苏醒回合只能使用附赠动作（BG3 规则）');
    return false;
  }
  if (cost === 'action' && S.turnResources.action <= 0) {
    updateStatus('动作已用完，本回合不能再执行该操作（可结束回合）');
    return false;
  }
  if (cost === 'bonus' && S.turnResources.bonus <= 0) {
    updateStatus('附赠动作已用完');
    return false;
  }
  return true;
}

/** 实际扣减预算并刷新资源条 */
export function spendCost(action) {
  if (S.combatPhase === 'idle') return;
  const cost = actionCostOf(action);
  if (cost === 'action') S.turnResources.action = Math.max(0, S.turnResources.action - 1);
  else if (cost === 'bonus') S.turnResources.bonus = Math.max(0, S.turnResources.bonus - 1);
  updateResourceBar();
}

/** 玩家本回合剩余移动力（格）：战斗外为满速 */
export function playerMoveCellsLeft(token) {
  const full = getMoveCells(token);
  if (S.combatPhase === 'idle') return full;
  // 测试模式（无敌人）下不限制移动范围，便于走遍全图检查墙壁
  if (isTestingMap()) return 999;
  return Math.max(0, Math.min(full, S.turnResources.moveLeft / CELL_METERS));
}

/** 玩家回合开始时重置预算（移动力不结转，回气/动作如潮次数跨回合保留） */
export function initTurnResources() {
  const p = getPlayerToken();
  // 测试模式（无敌人）下移动力无限，便于全图走动检查墙壁
  const base = isTestingMap() ? 9999 : (p ? parseMeters(p.data.character?.background?.attributes?.move_speed || '9m') : 9);
  S.turnResources = {
    action: 1,
    bonus: 1,
    moveLeft: base,
    moveBase: base,
    secondWindUsed: S.turnResources.secondWindUsed,
    actionSurgeUsed: S.turnResources.actionSurgeUsed,
    justRevived: false, // BG3：苏醒回合限制只在本回合有效，下回合开始清除
  };
  updateResourceBar();
}

/* ── 回合推进 ── */

/** 战斗开始：掷先攻，按顺序逐个行动 */
export function startCombat() {
  // 掷先攻（rules.rollInitiative，动态引用避免 rules → loop → rules 循环）
  // 注意：rollInitiative 依赖本模块的 getPlayerToken/getAliveEnemies，静态 import 会循环，
  // 故 rules.js 从本模块静态导入（单向 rules → loop），此处反向用动态 import
  import('./rules.js').then(({ rollInitiative }) => {
    S.initiativeOrder = rollInitiative();
    S.currentInitIndex = 0;
    S.turnCounter = 1;
    S.lastLogTurn = null; // 重置分隔条状态
    renderInitiativeBar();
    // 雾中敌人不泄露名字：未现身敌人以"黑暗中的存在"代替（先攻条同步用 ? 占位）
    const orderText = S.initiativeOrder.map(o => `${fogDisplayName(o.token)} ${o.initiative}`).join(' / ');
    updateStatus(`战斗开始！先攻顺序：${orderText}`);
    // 先攻顺序作为战斗开场说明，独立于轮次分组之上（不触发分隔条）
    appendCombatLog(`战斗开始！先攻顺序：\n${orderText}`, 'system', '', true);
    // 延迟 1.2 秒让玩家看清顺序，再激活第一个行动者（不走 advanceInitiative，避免误触发轮数 +1）
    setTimeout(() => activateCurrent(), 1200);
  });
}

/** 激活当前 initiativeOrder[currentInitIndex]：玩家则等操作，敌人则 AI 行动 */
export function activateCurrent(isFirst = false) {
  // 跳过死亡和昏迷（昏迷 NPC 无威胁，不参与行动）
  while (S.initiativeOrder[S.currentInitIndex]
         && (S.initiativeOrder[S.currentInitIndex].token.data.dead
             || S.initiativeOrder[S.currentInitIndex].token.data.unconscious)) {
    S.currentInitIndex = (S.currentInitIndex + 1) % S.initiativeOrder.length;
  }
  const cur = S.initiativeOrder[S.currentInitIndex];
  if (!cur) return;
  renderInitiativeBar();
  if (cur.faction === 'player') {
    S.combatPhase = 'player';
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
    if (cur.token && !cur.token.data.dead) {
      // 玩家回合开始自动选中玩家 token（main.select 经动态 import 避免循环）
      import('./main.js').then(({ select }) => { if (!cur.token.data.dead) select(cur.token); });
    }
    updateStatus(`第 ${S.turnCounter} 轮 · ${cur.name}的回合，行动后点击「结束回合」`);
    appendCombatLog(`${cur.name}的回合开始`, 'system', currentTurnLabel());
  } else {
    S.combatPhase = 'enemy';
    showEndTurnBtn(false);
    import('./main.js').then(({ deselect }) => deselect());
    updateStatus(`第 ${S.turnCounter} 轮 · ${fogDisplayName(cur.token)}行动中...`);
    appendCombatLog(`${fogDisplayName(cur.token)}的回合开始`, 'system', currentTurnLabel());
    setTimeout(() => runSingleEnemyAct(cur.token), 500);
  }
}

/** 推进到下一个行动者（跳过死亡，到末尾回 0 并轮数 +1） */
export function advanceInitiative() {
  S.currentInitIndex = (S.currentInitIndex + 1) % S.initiativeOrder.length;
  if (S.currentInitIndex === 0) S.turnCounter++; // 走完一圈
  // 检查战斗是否结束（空地图测试模式无敌人则不判定胜利）
  if (getAliveEnemies().length === 0 && !isTestingMap()) { endCombat(true); return; }
  const p = getPlayerToken();
  if (!p || p.data.dead) { endCombat(false); return; }
  activateCurrent();
}

/** 玩家点击结束回合 */
export function endPlayerTurn() {
  if (S.combatPhase !== 'player') return;
  if (S.state === 'moving' || S.state === 'jumping' || S.state === 'targeting') return;
  advanceInitiative();
}

/** 玩家攻击/施法后检查：敌人全灭 → 胜利 */
export function checkVictory() {
  if (S.combatPhase === 'victory' || S.combatPhase === 'defeat') return;
  if (getAliveEnemies().length === 0) {
    endCombat(true);
    return true;
  }
  return false;
}

/** 战斗结束：写回结果（M6：sessionStorage + 跳回 adventure.html） */
export function endCombat(won) {
  S.combatPhase = won ? 'victory' : 'defeat';
  showEndTurnBtn(false);
  import('./main.js').then(({ hideRangeCircle, clearTargetables, setTokensClickable, deselect, clearAllHighlights }) => {
    hideRangeCircle();
    clearTargetables();
    setTokensClickable(true);
    if (S.selectedToken) deselect();
    clearAllHighlights();
  });
  updateResourceBar(); // 隐藏资源条 + 解锁按钮
  // 战斗结束：标记所有头像非当前，但保留顺序让玩家看到最终局面（死亡者变灰）
  S.currentInitIndex = -1;
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
  if (S.encounterContext) {
    const playerToken = S.tokens.find(t => t.data.faction === 'player');
    const playerEndHp = playerToken ? playerToken.data.hpCur : 0;
    // 非致命打击产生的昏迷敌人列表（带回写 adventure.html 标 status:unconscious 留在场景）
    const unconsciousEnemies = won
      ? S.tokens
          .filter(t => t.data.faction === 'enemy' && t.data.unconscious && !t.data.dead)
          .map(t => ({ npcId: t.data.npcId || t.data.id, name: t.data.name, hp: t.data.hpCur }))
      : [];
    const result = {
      encounterId: S.encounterContext.encounterId,
      encounterName: S.encounterContext.encounterName,
      outcome: won ? 'victory' : 'defeat',
      playerEndHp,
      loot: won ? (S.encounterContext.loot || []) : [],
      clues: won ? (S.encounterContext.clues || []) : [],
      nextSceneId: won ? (S.encounterContext.nextSceneId || null) : null,
      unconsciousEnemies,
    };
    try {
      sessionStorage.setItem('combatResult', JSON.stringify(result));
    } catch (e) { console.error('写入 combatResult 失败:', e); }

    // 2.5 秒延迟让玩家看清横幅，再跳转
    setTimeout(() => {
      window.location.href = `adventure.html?combat_result=${encodeURIComponent(S.encounterContext.encounterId)}`;
    }, 2500);
  }
}
