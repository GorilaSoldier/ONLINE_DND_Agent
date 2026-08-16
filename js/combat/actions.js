/**
 * 战斗结算引擎（前端本地掷骰）
 * - 普攻：d20 + 攻击加值 vs 目标 AC，命中掷伤害骰
 * - 法术：解析 spells.json effect（damage / heal / narrative）
 * - 自身动作：跳跃 / 冲刺 / 回气 / 回复（目标为施放者自己）
 */

/** 解析 "1d8+3" / "2d6" / "1d10" 形式的骰子表达式，返回 (count, die, bonus) */
export function parseDice(expr) {
  const m = String(expr || '').trim().match(/^(\d+)d(\d+)(?:\s*\+\s*(\d+))?$/i);
  if (!m) return null;
  return { count: parseInt(m[1], 10), die: parseInt(m[2], 10), bonus: parseInt(m[3] || 0, 10) };
}

/**
 * 掷骰 "1d8+3" 并返回总点数。
 * 兼容范围格式（"6~16" / "3~12"）：在该范围内随机取值（旧角色卡伤害格式）。
 */
export function rollDice(expr) {
  const d = parseDice(expr);
  if (d) {
    let total = d.bonus;
    for (let i = 0; i < d.count; i++) total += Math.floor(Math.random() * d.die) + 1;
    return total;
  }
  const range = String(expr || '').trim().match(/^(\d+)\s*[~-]\s*(\d+)$/);
  if (range) {
    const lo = parseInt(range[1], 10), hi = parseInt(range[2], 10);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  return 0;
}

/** d20 检定：返回 { roll, total, crit, fumble }，mod 为调整值（如攻击加值） */
export function rollD20(mod = 0) {
  const roll = Math.floor(Math.random() * 20) + 1;
  return { roll, total: roll + mod, crit: roll === 20, fumble: roll === 1 };
}

/**
 * 普攻结算（D&D 5e 简化）：攻击检定 d20 + bonus vs 目标 AC。
 * 命中则掷伤害骰；重击(20)伤害骰翻倍；1 自动未命中。
 * @param {Object} attacker 攻击者角色卡（含 attack.melee/ranged）
 * @param {Object} target 目标 { name, combat:{ ac } }
 * @param {'melee'|'ranged'} kind
 * @returns {{hit:boolean, crit:boolean, damage:number, text:string, d20:number}}
 */
export function resolveAttack(attacker, target, kind = 'melee') {
  const atk = (attacker.attack || {})[kind] || {};
  const bonus = parseInt(String(atk.bonus || '+0').replace('+', ''), 10) || 0;
  const ac = target.combat?.ac ?? 10;
  const atkName = (kind === 'melee' ? '近战' : '远程') + '攻击';
  const res = rollD20(bonus);

  if (res.fumble) {
    return { hit: false, crit: false, damage: 0, d20: res.roll, text: `${attacker.name}的${atkName}掷出 1，失手了！` };
  }
  if (res.crit) {
    // 重击：伤害骰翻倍（掷两次）
    const damage = rollDice(atk.damage) + rollDice(atk.damage);
    return { hit: true, crit: true, damage, d20: res.roll, text: `${attacker.name}对${target.name}造成重击，${damage} 点伤害！` };
  }
  if (res.total < ac) {
    return { hit: false, crit: false, damage: 0, d20: res.roll, text: `${attacker.name}的${atkName}未命中${target.name}（骰值 ${res.total} < AC ${ac}）。` };
  }
  const damage = rollDice(atk.damage);
  return { hit: true, crit: false, damage, d20: res.roll, text: `${attacker.name}的${atkName}命中${target.name}，造成 ${damage} 点伤害。` };
}

/** 解析法术 effect 字符串："damage 1d10 火焰" / "heal 1d8+mod" / "narrative" */
export function parseSpellEffect(effect) {
  const e = String(effect || '').trim().toLowerCase() || 'narrative';
  let m = e.match(/^heal\s+(\d+)d(\d+)(?:\s*\+\s*mod)?/);
  if (m) return { kind: 'heal', dice: `${m[1]}d${m[2]}`, addMod: e.includes('+mod') };
  m = e.match(/^damage\s+(?:(\d+)x\s*\()?(\d+)d(\d+)(?:\s*\+\s*(\d+))?\s*\)?\s*([a-z\u4e00-\u9fa5]+)?/);
  if (m) {
    const repeats = parseInt(m[1] || 1, 10);
    const base = { count: parseInt(m[2], 10), die: parseInt(m[3], 10), bonus: parseInt(m[4] || 0, 10) };
    return { kind: 'damage', repeats, dice: `${m[2]}d${m[3]}`, bonus: base.bonus, dtype: m[5] || '力场' };
  }
  return { kind: 'narrative' };
}

/** 施法属性调整：取智力/感知/魅力最高 */
export function castingMod(char) {
  const ab = (char.abilities || {});
  const val = (k) => { const v = ab[k]; return (typeof v === 'object' ? v?.value : v) ?? 10; };
  return Math.max(val('int'), val('wis'), val('cha')) - 10 >> 1;
}

/**
 * 法术结算（前端本地）。目标可为 null（无目标法术，如 buff / 治疗自己）。
 * @param {Object} spell 法术定义（含 effect / range / name）
 * @param {Object} caster 施法者角色卡
 * @param {Object|null} target 目标（含 name / combat）
 * @returns {{ok:boolean, kind:string, damage:number, heal:number, text:string, narrative:boolean}}
 */
export function resolveSpell(spell, caster, target) {
  const spellName = spell.name || spell.id || '法术';
  const { kind, repeats = 1, dice, bonus = 0, dtype, addMod } = parseSpellEffect(spell.effect);

  if (kind === 'heal') {
    let heal = 0;
    for (let i = 0; i < repeats; i++) heal += rollDice(dice);
    if (addMod) heal += castingMod(caster);
    return { ok: true, kind, heal, damage: 0, text: `${caster.name}施放${spellName}，恢复了 ${heal} 点生命值。` };
  }

  if (kind === 'damage') {
    if (!target) {
      return { ok: false, kind, damage: 0, heal: 0, text: `${spellName}需要选择目标。` };
    }
    let damage = 0;
    for (let i = 0; i < repeats; i++) {
      damage += rollDice(dice) + bonus;
    }
    return { ok: true, kind, damage, heal: 0, text: `${caster.name}施放${spellName}，对${target.name}造成 ${damage} 点${dtype}伤害。` };
  }

  // narrative：无数值效果，仅提示
  return { ok: true, kind, damage: 0, heal: 0, narrative: true, text: `${caster.name}施放了${spellName}。` };
}

/**
 * 自身动作结算（目标 = 施放者自己）。
 * @returns {{ok:boolean, text:string, heal?:number, dash?:boolean}}
 */
export function resolveSelfAction(action, char) {
  const name = action.name || action.id || '动作';
  const aId = action.id;

  if (aId === 'jump') {
    // 跳跃：消耗移动力跨障碍登高。第一版简化为提示 + 后续由地图端处理跳跃落点
    return { ok: true, text: `${char.name}准备跳跃。`, jump: true };
  }
  if (aId === 'dash') {
    return { ok: true, text: `${char.name}进入冲刺状态，移动范围翻倍。`, dash: true };
  }
  if (aId === 'second_wind') {
    const level = parseInt(char.level || 1, 10) || 1;
    const heal = Math.floor(Math.random() * 10) + 1 + level;
    return { ok: true, text: `${char.name}使用回气，恢复了 ${heal} 点生命值。`, heal };
  }
  if (aId === 'recovery') {
    const maxHp = hpMax(char);
    const heal = Math.max(2, Math.floor(maxHp / 4));
    return { ok: true, text: `${char.name}使用回复，恢复了 ${heal} 点生命值（消耗一次短休充能）。`, heal };
  }
  if (aId === 'fighting_spirit') {
    return { ok: true, text: `${char.name}激发斗气如潮，本回合攻击获得额外伤害。`, fightingSpirit: true };
  }
  if (aId === 'extra_attack') {
    return { ok: true, text: `${char.name}发动附加攻击，可再进行一次攻击。`, extraAttack: true };
  }
  return { ok: true, text: `${char.name}使用了${name}。` };
}

/** 角色最大生命值（兼容 combat.hp "cur / max" 字符串 与 combat.hp {cur,max}） */
export function hpMax(char) {
  const hp = (char.combat || {}).hp;
  if (typeof hp === 'string') {
    const m = hp.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? parseInt(m[2], 10) : 10;
  }
  return hp?.max ?? 10;
}

/** 角色当前生命值 */
export function hpCur(char) {
  const hp = (char.combat || {}).hp;
  if (typeof hp === 'string') {
    const m = hp.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 10;
  }
  return hp?.cur ?? hpMax(char);
}
