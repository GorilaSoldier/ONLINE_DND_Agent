/**
 * 装备穿戴效果计算（角色域，canonical v2）
 * 职责：读角色卡 inventory 中 equipped === true 的装备，产出角色数值（唯一换算入口）。
 *       战斗地图与文字冒险共用本文件，避免同一套 D&D 5e 换算规则在各页面各写一份而漂移。
 * 边界：
 *   - 纯计算 + 写回角色卡对象，不碰 UI、不发请求、不落盘、不管战斗结算
 *   - AC = 无甲基础(10+敏调) + 已装备护甲取最高 + 盾牌 + 饰品加值
 *   - 攻击 = 已装备武器；无近战武器时回落到徒手；双持需两把均为 light，副手攻击消耗附赠
 *   - 照明半径 = 已装备光源的 stats.light_radius_cells（纯数据驱动，需装备才生效）
 */

/** 读取六维数值（canonical 格式为纯数字） */
export function abilityScore(char, key) {
  const v = char?.abilities?.[key];
  return typeof v === 'number' ? v : 10;
}

/** 六维调整值 */
export function abilityMod(char, key) {
  return Math.floor((abilityScore(char, key) - 10) / 2);
}

/** 规范化加值文本 */
export function formatBonus(v) {
  return typeof v === 'number' ? (v >= 0 ? '+' + v : String(v)) : (v ?? '+0');
}

/**
 * 从攻击者对象里取指定类型的主攻击
 * 兼容玩家（combat.attacks.current）与敌人适配器（attacks[]）
 */
export function getPrimaryAttack(attacker, kind) {
  const list = attacker?.combat?.attacks?.current || attacker?.attacks || [];
  return list.find(a => a.kind === kind) || (kind === 'melee' ? list[0] : null) || null;
}

function attackDamage(dice, mod, includeMod = true) {
  if (!includeMod || !mod) return dice;
  return dice + (mod > 0 ? '+' + mod : String(mod));
}

function rangedRangeCells(range) {
  const normal = parseInt(String(range || '').split('/')[0], 10);
  return normal > 0 ? Math.round(normal / 5) : 6;
}

/**
 * 计算角色卡上的装备效果
 * @param {object} char 角色卡对象（读 abilities / skills / inventory / combat.attacks.base）
 * @param {object} catalog 装备目录（equipment_id → 装备数据），来自 GET /api/equipment
 * @returns {{ ac: number, attacks: {base: Array, current: Array}, lightRadiusCells: number }}
 */
export function computeEquipmentEffects(char, catalog = {}) {
  const items = char?.inventory?.items || [];
  const dexMod = abilityMod(char, 'dex');
  const strMod = abilityMod(char, 'str');
  // 攻击加值 = 熟练加值 + 属性调整值 + 武器加值（D&D 5e 规则）
  const prof = parseInt(String(char?.skills?.proficiency_bonus || '+2').replace(/[^0-9-]/g, ''), 10) || 2;

  // AC：无甲基础 + 已装备护甲（取最高）+ 盾牌 + 饰品加值
  let ac = 10 + dexMod;
  let lightRadiusCells = 0;
  const meleeWeapons = [];
  const rangedWeapons = [];
  let meleeIndex = 0;

  for (const item of items) {
    if (!item.equipped) continue;
    const ci = catalog[item.equipment_id];
    const light = ci?.stats?.light_radius_cells || 0;
    if (light > lightRadiusCells) lightRadiusCells = light;
    if (!ci || !ci.stats) continue;

    if (ci.type === 'weapon') {
      const slot = item.slot
        || (ci.stats.category === 'ranged'
          ? 'ranged-main'
          : (meleeIndex++ === 0 ? 'melee-main' : 'melee-offhand'));
      if (ci.stats.category === 'ranged') rangedWeapons.push({ ci, slot });
      else meleeWeapons.push({ ci, slot });
    } else if (ci.type === 'armor') {
      const s = ci.stats;
      if (s.category === 'shield' || s.slot === 'shield') {
        ac += (s.bonus_ac || 0);
      } else if (s.category !== 'clothes' && s.ac_base) {
        let a = s.ac_base;
        if (s.ac_ability === 'dex') {
          a += (s.ac_max_dex != null ? Math.min(dexMod, s.ac_max_dex) : dexMod);
        }
        if (a > ac) ac = a;
      }
    } else if (ci.type === 'accessory' && ci.stats.bonus_ac) {
      ac += ci.stats.bonus_ac;
    }
  }

  const weaponAttack = (weapon, { kind, hand, includeMod = true }) => {
    const s = weapon.ci.stats;
    const mod = kind === 'ranged'
      ? dexMod
      : (s.finesse ? Math.max(strMod, dexMod) : strMod);
    const bonus = mod + prof + (s.bonus || 0);
    return {
      name: weapon.ci.name,
      bonus,
      damage: attackDamage(s.damage_dice, mod + (s.bonus || 0), includeMod),
      damage_type: s.damage_type,
      kind,
      hand,
      rangeCells: kind === 'ranged' ? rangedRangeCells(s.range) : 1,
    };
  };

  const mainMelee = meleeWeapons.find(w => w.slot === 'melee-main') || meleeWeapons[0];
  const offMelee = meleeWeapons.find(w => w !== mainMelee && w.slot === 'melee-offhand');
  const mainRanged = rangedWeapons.find(w => w.slot === 'ranged-main') || rangedWeapons[0];

  const base = char?.combat?.attacks?.base?.length
    ? char.combat.attacks.base
    : [{
      name: '徒手',
      bonus: strMod + prof,
      damage: attackDamage('1d4', strMod),
      damage_type: 'bludgeoning',
      kind: 'melee',
      hand: 'main',
      rangeCells: 1,
    }];

  const current = [];
  if (mainMelee) {
    current.push(weaponAttack(mainMelee, { kind: 'melee', hand: 'main' }));
    // 双持：两把均为 light 且主手非双手武器，副手攻击消耗附赠，伤害不加属性调整
    if (offMelee
      && mainMelee.ci.stats.light
      && offMelee.ci.stats.light
      && !mainMelee.ci.stats.two_handed) {
      current.push(weaponAttack(offMelee, { kind: 'melee', hand: 'offhand', includeMod: false }));
    }
  } else {
    current.push(...base);
  }
  if (mainRanged) {
    current.push(weaponAttack(mainRanged, { kind: 'ranged', hand: 'main' }));
  }

  return { ac, attacks: { base, current }, lightRadiusCells };
}

/** 计算并把结果写回角色卡（char.combat.ac / char.combat.attacks.current） */
export function applyEquipmentEffects(char, catalog) {
  const fx = computeEquipmentEffects(char, catalog);
  char.combat = char.combat || {};
  char.combat.ac = fx.ac;
  char.combat.hp = char.combat.hp && typeof char.combat.hp === 'object'
    ? char.combat.hp
    : { cur: 0, max: 0 };
  char.combat.attacks = char.combat.attacks || { base: [], current: [] };
  char.combat.attacks.base = fx.attacks.base;
  char.combat.attacks.current = fx.attacks.current;
  return fx;
}

/* 普通 <script> 页面（combat-map.html / adventure.html）无模块系统，挂 window 供其调用 */
window.computeEquipmentEffects = computeEquipmentEffects;
window.applyEquipmentEffects = applyEquipmentEffects;
window.abilityMod = abilityMod;
window.formatBonus = formatBonus;
window.getPrimaryAttack = getPrimaryAttack;
