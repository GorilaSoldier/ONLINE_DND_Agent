/**
 * 共享 UI 工具（经典脚本，非 ES module）
 *
 * 由 adventure / combat-map / lobby / 创建人物 四个页面共同引用，
 * 必须在各页面的内联 <script> 之前加载（经典脚本按解析顺序执行）。
 *
 * 所有导出统一挂到 window，页面内联脚本在顶部取显式别名，例如：
 *   const bonusText = window.bonusText;
 * 这样既保留了 IDE 可跳转，也避免各页再维护一份副本。
 *
 * 注意：本文件里的函数**不读取任何页面私有状态**（state / catalogs / charCard 等），
 * 需要的数据一律走显式参数（char / catalog / slot），页面负责传入。
 */
(function () {
  'use strict';

  /* ── canonical v2 枚举 → 中文标签（数据只存英文枚举，展示层统一在此映射） ── */

  const DAMAGE_TYPE_LABEL = {
    acid: '强酸',
    bludgeoning: '钝击',
    cold: '冷冻',
    fire: '火焰',
    force: '力场',
    lightning: '闪电',
    necrotic: '黯蚀',
    piercing: '穿刺',
    poison: '毒素',
    psychic: '心灵',
    radiant: '光耀',
    slashing: '挥砍',
    thunder: '雷鸣',
  };

  const SCHOOL_LABEL = {
    abjuration: '防护',
    conjuration: '咒法',
    divination: '预言',
    enchantment: '附魔',
    evocation: '塑能',
    illusion: '幻术',
    necromancy: '死灵',
    transmutation: '变化',
  };

  const ACTION_COST_LABEL = {
    action: '1动作',
    bonus: '附赠动作',
    reaction: '反应',
    free: '自由动作',
    special: '特殊',
  };

  /** 射程对象 → 展示文本 */
  function rangeLabel(range) {
    if (!range) return '—';
    switch (range.kind) {
      case 'self': return '自身';
      case 'touch': return '触碰';
      case 'melee': return '近战 1.5 米';
      case 'ranged': return range.meters != null ? `${range.meters} 米` : '远程';
      default: return '可变';
    }
  }

  /** 伤害类型英文枚举 → 中文 */
  function damageTypeLabel(type) {
    return DAMAGE_TYPE_LABEL[type] || type || '—';
  }

  /* ── 通用文本 / 数值 ── */

  /** 转义 HTML（含属性引号）：用于模板字符串拼 innerHTML / data-* 属性 */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  /** 修正值展示：数字加正号，其余原样 */
  function bonusText(v) {
    return typeof v === 'number' ? (v >= 0 ? '+' + v : String(v)) : (v ?? '+0');
  }

  /** 生命值展示：`当前 / 上限` */
  function hpText(char) {
    const hp = char?.combat?.hp;
    return hp && typeof hp === 'object' ? `${hp.cur} / ${hp.max}` : '0 / 0';
  }

  /* ── 角色卡规范化 ── */

  function getAbility(char, key) {
    /* 兼容两种角色卡格式：后端嵌套 abilities.str.value / 前端扁平 str/dex */
    if (char.abilities && char.abilities[key] && char.abilities[key].value != null) {
      return char.abilities[key].value;
    }
    const flatMap = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
    const flatKey = flatMap[key] || key;
    if (char[flatKey] != null) return char[flatKey];
    if (char[key] != null) return char[key];
    return 10;
  }

  function getAbilitiesArray(char) {
    return [
      { name: '力量', key: 'str', abbr: 'STR', val: getAbility(char, 'str') },
      { name: '敏捷', key: 'dex', abbr: 'DEX', val: getAbility(char, 'dex') },
      { name: '体质', key: 'con', abbr: 'CON', val: getAbility(char, 'con') },
      { name: '智力', key: 'int', abbr: 'INT', val: getAbility(char, 'int') },
      { name: '感知', key: 'wis', abbr: 'WIS', val: getAbility(char, 'wis') },
      { name: '魅力', key: 'cha', abbr: 'CHA', val: getAbility(char, 'cha') },
    ];
  }

  function normalizeAbilities(char) {
    const abilities = char?.abilities || {};
    const bonus = char?.ability_bonus || {};
    const result = {};
    const keys = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    const labels = { str: '力', dex: '敏', con: '体', int: '智', wis: '感', cha: '魅' };
    for (const key of keys) {
      const score = typeof abilities[key] === 'number' ? abilities[key] : 10;
      const mod = Math.floor((score - 10) / 2);
      result[key] = {
        label: labels[key] || key,
        value: score,
        save_bonus: mod >= 0 ? '+' + mod : String(mod),
        highlighted: key === bonus.plus2 || key === bonus.plus1,
      };
    }
    return result;
  }

  function normalizeChar(char) {
    if (!char) return char;
    const hp = char.combat?.hp;
    return {
      ...char,
      combat: {
        ac: char.combat?.ac ?? 10,
        hp: hp && typeof hp === 'object' ? { cur: hp.cur ?? 0, max: hp.max ?? 0 } : { cur: 0, max: 0 },
        speed: char.combat?.speed || '9m',
        attacks: {
          base: char.combat?.attacks?.base || [],
          current: char.combat?.attacks?.current || [],
        },
      },
      xp: char.xp || { current: 0, max: 300 },
      inventory: char.inventory || { gold: 0, items: [] },
      features: char.features || { status_ids: [], resistance_ids: [], class_feature_ids: [], trait_ids: [] },
      skills: char.skills || { proficiency_bonus: '+2', sections: [] },
      spells: char.spells || { caster_level: 1, action_ids: { normal: ["jump", "throw", "dash"], class: [] }, passive_ids: [], spell_ids: {} },
      background: char.background || {
        class: '', race: '', attributes: {},
        traits: { personality: '', ideal: '', bond: '', flaw: '' },
        story: [],
      },
      abilities: normalizeAbilities(char),
    };
  }

  /** 取当前主手 / 远程攻击（无匹配时回落到首个攻击） */
  function primaryAttack(char, kind) {
    const list = char?.combat?.attacks?.current || [];
    return list.find(a => a.kind === kind) || (kind === 'melee' ? list[0] : null) || {};
  }

  /* ── 装备槽 / 物品文案 ── */

  /**
   * 根据已装备物品计算各装备槽位内容
   * @param {object} char     角色卡
   * @param {object} catalog  装备库（equipment_id → 装备定义），由调用方传入
   */
  function computeEquippedSlots(char, catalog) {
    catalog = catalog || {};
    const slots = { helmet: null, body: null, shield: null, legs: null, boots: null, neck: null, ring1: null, ring2: null, tool: null, melee: [null, null], ranged: [null, null] };
    // 槽位信息对象：名称 + 描述 + 属性行 + 图标名（图标从 JSON 的 icon 字段动态加载）
    const mk = ci => ({
      name: ci.name,
      desc: ci.description || '',
      props: (ci.properties && (ci.properties.damage || ci.properties.ac || ci.properties.effect)) || '',
      icon: ci.icon || 'pouch',
      twoHanded: !!ci.stats?.two_handed,
    });
    let ringCount = 0;
    for (const item of (char.inventory?.items || [])) {
      if (!item.equipped) continue;
      const ci = item.equipment_id ? catalog[item.equipment_id] : null;
      if (!ci) continue;
      if (ci.type === 'weapon') {
        const cat = ci.stats?.category;
        if (cat === 'melee') {
          if (!slots.melee[0]) slots.melee[0] = mk(ci);
          else if (!slots.melee[1] && !slots.melee[0].twoHanded) slots.melee[1] = mk(ci);
          // 双手武器占满两格：第二格置灰不可操作
          if (slots.melee[0] && slots.melee[0].twoHanded) slots.melee[1] = { disabled: true };
        }
        if (cat === 'ranged') {
          if (!slots.ranged[0]) slots.ranged[0] = mk(ci);
          else if (!slots.ranged[1] && !slots.ranged[0].twoHanded) slots.ranged[1] = mk(ci);
          if (slots.ranged[0] && slots.ranged[0].twoHanded) slots.ranged[1] = { disabled: true };
        }
      } else if (ci.type === 'armor') {
        const cat = ci.stats?.category;
        if (cat === 'shield') {
          if (!slots.shield) slots.shield = mk(ci);
        } else if (cat !== 'clothes') {
          if (!slots.body) slots.body = mk(ci);
        }
      } else if (ci.type === 'accessory') {
        if (ci.subtype === 'ring') {
          if (ringCount === 0) slots.ring1 = mk(ci);
          else if (ringCount === 1) slots.ring2 = mk(ci);
          ringCount++;
        } else if (ci.subtype === 'tool') {
          if (!slots.tool) slots.tool = mk(ci);
        }
      }
    }
    return slots;
  }

  /**
   * 物品效果文案：道具显示 effect（heal → 回复 X 生命值）；装备显示"造成 XdY 伤害"或护甲等级。
   * 章节物品（如火把/矿灯）仅引用 equipment_id，属性从全局装备库补充。
   * @param {object} item     物品（章节物品或装备库条目）
   * @param {object} catalog  装备库，用于按 equipment_id 补全属性
   */
  function itemEffectText(item, catalog) {
    if (!item) return '';
    const useEffect = item.use?.effect;
    if (useEffect) {
      if (useEffect.kind === 'heal') {
        const bonus = useEffect.bonus ? `+${useEffect.bonus}` : '';
        return `回复 ${useEffect.dice || ''}${bonus} 生命值`;
      }
      if (useEffect.kind === 'damage') {
        return `造成 ${useEffect.dice || ''} ${damageTypeLabel(useEffect.damage_type)}伤害`;
      }
    }
    if (item.properties?.effect) return item.properties.effect;
    const eq = item.equipment_id && catalog ? catalog[item.equipment_id] : null;
    const src = (eq && eq.stats) ? eq : item;
    if (src.stats?.damage_dice) {
      return `造成 ${src.stats.damage_dice} ${damageTypeLabel(src.stats.damage_type)}伤害`;
    }
    // 护甲/盾牌：护甲等级由 stats 计算展示
    if (src.stats?.slot === 'shield') return `护甲等级 +${src.stats.bonus_ac ?? 0}`;
    if (src.stats?.category && src.stats.category !== 'shield' && src.stats.ac_base) {
      const dex = src.stats.ac_ability === 'dex'
        ? (src.stats.ac_max_dex != null ? ` + 敏捷调整值（上限 ${src.stats.ac_max_dex}）` : ' + 敏捷调整值')
        : '';
      return `护甲等级 ${src.stats.ac_base}${dex}`;
    }
    return '';
  }

  /* ── 图标 / 槽位渲染 ── */

  const svgIconCache = {};

  /* 图标文件缺失时的兜底（极简背包图标） */
  const FALLBACK_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line></svg>';

  /** 异步加载装备 SVG 图标（带缓存，失败回落到背包图标） */
  async function loadSvgIcon(iconName) {
    if (svgIconCache[iconName] !== undefined) return svgIconCache[iconName];
    try {
      const res = await fetch(`/assets/icons/equipment/${iconName}.svg?v=${Date.now()}`);
      if (!res.ok) throw new Error(`Failed to load icon ${iconName}: ${res.status}`);
      const svgText = await res.text();
      svgIconCache[iconName] = svgText;
      return svgText;
    } catch (err) {
      console.warn('loadSvgIcon failed:', err);
      svgIconCache[iconName] = FALLBACK_ICON_SVG;
      return svgIconCache[iconName];
    }
  }

  /**
   * 渲染单个装备槽
   * @param {string} iconSvg  已经加载好的 SVG 文本（空槽用默认图标，由调用方决定）
   * @param {object} slot     槽位信息（null = 空槽 / { disabled } = 置灰）
   */
  function renderSlot(iconSvg, slot) {
    const disabled = !!slot && slot.disabled;
    const filled = !!slot && !disabled;
    const dataAttrs = filled
      ? ` data-name="${escapeHtml(slot.name)}" data-description="${escapeHtml(slot.desc)}" data-props="${escapeHtml(slot.props)}"`
      : '';
    return `<div class="slot${filled ? ' filled' : ''}${disabled ? ' disabled' : ''}"${dataAttrs}>
      <div class="slot-icon">${iconSvg}</div>
      ${filled ? `<div class="slot-name">${escapeHtml(slot.name)}</div>` : ''}
    </div>`;
  }

  Object.assign(window, {
    DAMAGE_TYPE_LABEL,
    SCHOOL_LABEL,
    SPELL_SCHOOL_LABEL: SCHOOL_LABEL,
    ACTION_COST_LABEL,
    rangeLabel,
    damageTypeLabel,
    escapeHtml,
    bonusText,
    hpText,
    getAbility,
    getAbilitiesArray,
    normalizeAbilities,
    normalizeChar,
    primaryAttack,
    computeEquippedSlots,
    itemEffectText,
    loadSvgIcon,
    renderSlot,
    FALLBACK_ICON_SVG,
  });
})();
