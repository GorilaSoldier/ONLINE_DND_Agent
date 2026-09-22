/**
 * 战斗规则结算（D&D 5e 规则层）
 * 职责：推离对抗、扶起队友、死亡豁免、先攻掷骰、借机攻击等"规则判定"
 * 不负责：回合推进（combat-loop）、敌人 AI（enemy）、DOM 渲染（combat-ui）
 */

import { rollD20, resolveAttack } from './actions.js';
import { updateTokenPosition, updateTokenHp } from './token.js';
import { combatState } from './state.js';
import { appendCombatLog, currentTurnLabel, updateStatus, renderInitiativeBar, updateResourceBar } from './combat-ui.js';
import { getPlayerToken, endCombat, getAliveEnemies } from './combat-loop.js';

/** 属性调整值：属性值 → (值-10)/2 向下取整 */
export function abilityMod(abilityValue) {
  return Math.floor(((Number(abilityValue) || 10) - 10) / 2);
}

/** 8 方向相邻判定（含斜角） */
export function cellsAdjacent(c1, r1, c2, r2) {
  return Math.abs(c1 - c2) <= 1 && Math.abs(r1 - r2) <= 1 && !(c1 === c2 && r1 === r2);
}

/** 扶起队友（BG3 Help 动作）：触碰倒地己方，恢复 1 HP 并苏醒
 *  目标需为 faction∈{player,ally} 且 downed=true 且 dead=false
 *  被扶起者本回合只能用附赠动作（justRevived 标记，下回合开始清除）
 */
export function resolveRevive(caster, target) {
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
  if (target === combatState.selectedToken) {
    combatState.turnResources.justRevived = true;
    combatState.turnResources.action = 0;
    combatState.turnResources.moveLeft = 0;
    updateResourceBar();
  }
  const text = `${caster.data.name} 扶起 ${target.data.name}！恢复 1 HP 苏醒（本回合只能使用附赠动作）`;
  appendCombatLog(text, 'heal', currentTurnLabel());
  updateStatus(text);
}

/** 推离结算：双方掷 d20+力量调整值对抗，成功推远 1 格（被推方该次移动不触发借机攻击） */
export function resolveShove(attacker, target) {
  const mapConfig = combatState.mapConfig;
  // 力量值取数：玩家用 char.abilities.str.value（角色卡格式）；
  //              敌人无 abilities 字段时 fallback 到 10（mod=0）
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
    || combatState.tokens.some(t => t !== target && t.data.col === newCol && t.data.row === newRow && !t.data.dead)
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

/** 玩家死亡豁免掷骰（BG3 风格）：昏迷玩家回合开始时调用。
 *  自然 20 → 立即回 1 HP 苏醒（本回合只能用附赠动作）
 *  自然 1  → 失败 +2
 *  ≥ 10    → 成功 +1，累计 3 → 稳定（不再掷骰，但仍昏迷，需队友扶起/治疗）
 *  ≤ 9     → 失败 +1，累计 3 → 死亡
 *  稳定后回到此函数 → 跳过掷骰，仍昏迷等待救援（不自动苏醒）
 *  @returns {boolean} true 表示已处理（昏迷/苏醒/死亡）
 */
export function runPlayerDeathSave(playerToken) {
  const ds = playerToken.data.deathSaves || (playerToken.data.deathSaves = { successes: 0, failures: 0, stable: false });
  const name = playerToken.data.name || '玩家';

  // 稳定后：不再掷骰，但仍昏迷，需队友扶起/治疗才能苏醒（BG3 规则）
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
    combatState.turnResources.justRevived = true;
    combatState.turnResources.action = 0;
    combatState.turnResources.moveLeft = 0;
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
      markPlayerDead(playerToken, name);
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
    markPlayerDead(playerToken, name);
  }
  return true;
}

/** 玩家死亡（死亡豁免累计 3 失败）：标记死亡 + 延时触发战斗败北 */
function markPlayerDead(playerToken, name) {
  playerToken.data.dead = true;
  playerToken.data.downed = false;
  playerToken.element.style.opacity = '0.35';
  renderInitiativeBar();
  appendCombatLog(`${name} 死亡豁免失败累计 3 次，已经死亡...`, 'system', currentTurnLabel());
  setTimeout(() => endCombat(false), 1200);
}

/** 掷先攻（RAW 逐个）：每个生物 d20 + 敏捷调整值，降序排列，同值玩家优先 */
export function rollInitiative() {
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

/** 把任意目标 token 转成 resolveAttack 需要的目标结构（暴露 downed 标记，5 尺近战昏迷自动暴击） */
export function targetForEnemy(target) {
  return {
    name: target?.data?.name || '玩家',
    combat: { ac: target?.data?.ac ?? 12 },
    downed: target?.data?.downed === true,
  };
}

/** 把敌人 attacks 转成 resolveAttack 需要的攻击者结构 */
export function attackerFromEnemy(enemy, atk) {
  return {
    name: enemy.data.name,
    attack: {
      melee: { bonus: atk.bonus, damage: atk.damage },
      ranged: { bonus: atk.bonus, damage: atk.damage },
    },
  };
}

/** 借机攻击触发：attacker 对 mover 自动结算一次近战攻击（不消耗反应预算，第一版简化） */
export async function triggerOpportunityAttack(attacker, mover) {
  if (!attacker || !mover || mover.data.dead) return;
  // 按阵营构造 resolveAttack 需要的攻击者结构：
  //   - 玩家：data.character 已含 attack.melee.bonus/damage（与普通攻击 resolveAttack(char,...) 同源）
  //   - 敌人：用 attackerFromEnemy 把扁平 attacks 项转成 { name, attack:{melee,ranged} } 结构
  let atkChar;
  if (attacker.data.faction === 'player') {
    atkChar = attacker.data.character;
    if (!atkChar) return;
  } else {
    const attacks = attacker.data.attacks || [];
    const melee = pickMeleeAttack(attacks);
    if (!melee) return;
    atkChar = attackerFromEnemy(attacker, melee);
  }
  const target = { name: mover.data.name, combat: { ac: mover.data.ac ?? 15 } };
  const result = resolveAttack(atkChar, target, 'melee');
  applyOpportunityResult(result, mover, attacker);
  // 借机攻击单独标记（applyResult 已写伤害日志，这里补"借机"前缀）
  if (result.text) {
    appendCombatLog(`【借机】${result.text}`, result.damage > 0 ? 'attack' : 'system', currentTurnLabel());
  }
  await sleep(400);
}

/** 从 attacks 里选近战攻击项（kind 为 melee 或未标 kind 的第一项） */
export function pickMeleeAttack(attacks) {
  return attacks.find(a => a.kind === 'melee') || attacks.find(a => !a.kind) || attacks[0];
}

/** 从 attacks 里选远程攻击项（kind 为 ranged） */
export function pickRangedAttack(attacks) {
  return attacks.find(a => a.kind === 'ranged') || null;
}

/** 借机攻击结果落地（伤害/治疗/死亡判定复用 main.applyResult）
 *  通过动态 import 避免与 main.js 循环依赖（main → rules，rules 需要 main.applyResult）
 */
async function applyOpportunityResult(result, mover, attacker) {
  const { applyResult } = await import('./main.js');
  applyResult(result, mover, { attackKind: 'melee', attacker });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
