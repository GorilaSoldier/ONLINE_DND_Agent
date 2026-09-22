/**
 * 装备穿戴效果计算（角色域，2026-09-17 定稿）
 * 职责：读角色卡 inventory 中 equipped === true 的装备，产出角色数值（唯一换算入口）。
 *       战斗地图（combat-map.html / main.js）与文字冒险（adventure.html）共用本文件，
 *       避免同一套 D&D 5e 换算规则在各页面各写一份而漂移。
 * 边界：
 *   - 纯计算 + 写回角色卡对象，不碰 UI、不发请求、不落盘、不管战斗结算
 *   - 规则：AC = 无甲基础(10+敏调) + 已装备护甲取最高 + 盾牌 + 饰品加值
 *           攻击加值 = 属性调整值 + 熟练加值 + 武器加值
 *           照明半径 = 已装备光源的 stats.light_radius_cells（纯数据驱动，需装备才生效）
 *   - 装备目录缺 stats 的条目（旧 schema）静默跳过，与原三处拷贝口径一致
 */

/**
 * 计算角色卡上的装备效果
 * @param {object} char 角色卡对象（读 abilities / skills / inventory）
 * @param {object} catalog 装备目录（equipment_id → 装备数据），来自 GET /api/equipment
 * @returns {{ ac: number, attack: { melee: {bonus: string, damage: string}, ranged: {bonus: string, damage: string} }, lightRadiusCells: number }}
 */
export function computeEquipmentEffects(char, catalog = {}) {
  const items = char?.inventory?.items || [];
  const dexMod = Math.floor(((char?.abilities?.dex?.value ?? 10) - 10) / 2);
  const strMod = Math.floor(((char?.abilities?.str?.value ?? 10) - 10) / 2);
  // 攻击加值 = 熟练加值 + 属性调整值 + 武器加值（D&D 5e 规则）
  const prof = parseInt(String(char?.skills?.proficiency_bonus || '+2').replace(/[^0-9-]/g, ''), 10) || 2;

  // AC：无甲基础 + 已装备护甲（取最高）+ 盾牌 + 饰品加值
  let ac = 10 + dexMod;
  let meleeDamage = null;
  let rangedDamage = null;
  let meleeBonus = 0;
  let rangedBonus = 0;
  let lightRadiusCells = 0;
  for (const item of items) {
    if (!item.equipped) continue;
    const ci = catalog[item.equipment_id];
    // 照明：纯数据驱动，半径来自装备库 stats.light_radius_cells（目录缺失该字段即视为无照明）
    const light = ci?.stats?.light_radius_cells || 0;
    if (light > lightRadiusCells) lightRadiusCells = light;
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

  const fmt = v => (v >= 0 ? '+' : '') + v;
  return {
    ac,
    attack: {
      melee: {
        bonus: fmt(strMod + prof + meleeBonus),
        damage: meleeDamage ? meleeDamage + (meleeBonus ? `+${meleeBonus}` : '') : '1d4',
      },
      ranged: {
        bonus: fmt(dexMod + prof + rangedBonus),
        damage: rangedDamage ? rangedDamage + (rangedBonus ? `+${rangedBonus}` : '') : '1d4',
      },
    },
    lightRadiusCells,
  };
}

/** 计算并把结果写回角色卡（char.combat.ac / char.attack.*），返回计算结果 */
export function applyEquipmentEffects(char, catalog) {
  const fx = computeEquipmentEffects(char, catalog);
  char.combat = char.combat || { ac: 10, hp: '0 / 0' };
  char.combat.ac = fx.ac;
  char.attack = char.attack || { melee: {}, ranged: {} };
  Object.assign(char.attack.melee, fx.attack.melee);
  Object.assign(char.attack.ranged, fx.attack.ranged);
  return fx;
}

/* 普通 <script> 页面（combat-map.html / adventure.html）无模块系统，挂 window 供其调用 */
window.computeEquipmentEffects = computeEquipmentEffects;
window.applyEquipmentEffects = applyEquipmentEffects;
