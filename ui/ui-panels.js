/**
 * 共享面板渲染（经典脚本，非 ES module）
 *
 * 由 adventure / combat-map 共同引用，必须在 ui/ui-shared.js 之后、
 * 页面内联 <script> 之前加载（经典脚本按解析顺序执行）。
 *
 * 与 ui-shared.js 的分工：
 *   ui-shared.js  纯函数 / 格式化，不写 DOM
 *   ui-panels.js  渲染面板，只写 DOM；页面状态一律走显式参数
 *
 * 页面内建议保留一层极薄的绑定，把闭包状态喂进来，例如：
 *   const renderRightPanel = () => window.renderCharCard(state.character, catalogs, charCard);
 * 这样调用点不用改，且 catalogs 整体重新赋值时也能取到最新值。
 */
(function () {
  'use strict';

  const {
    computeEquippedSlots,
    escapeHtml,
    hpText,
    bonusText,
    primaryAttack,
    itemEffectText,
    loadSvgIcon,
    renderSlot,
  } = window;

  /**
   * 渲染右侧角色卡
   * @param {object} char       角色卡
   * @param {object} catalogs   目录集合（读取 catalogs.equipment）
   * @param {HTMLElement} container 角色卡容器（页面里的 charCard）
   */
  async function renderCharCard(char, catalogs, container) {
    try {
      if (!char || !char.name) {
        container.innerHTML = '<div class="char-card-placeholder">未选择角色<br>请在大厅创建或选择角色</div>';
        return;
      }
      const slots = computeEquippedSlots(char, (catalogs && catalogs.equipment) || {});

      // 槽位定义：空槽用默认槽图标，已装备槽用物品自身的 icon（动态加载）
      const slotDefs = [
        { defaultIcon: 'helmet', slot: slots.helmet },
        { defaultIcon: 'chestplate', slot: slots.body || slots.shield },
        { defaultIcon: 'greaves', slot: slots.legs },
        { defaultIcon: 'boots', slot: slots.boots },
        { defaultIcon: 'necklace', slot: slots.neck },
        { defaultIcon: 'ring', slot: slots.ring1 },
        { defaultIcon: 'ring', slot: slots.ring2 },
        { defaultIcon: 'lute', slot: slots.tool },
        { defaultIcon: 'sword', slot: slots.melee[0] },
        { defaultIcon: 'sword', slot: slots.melee[1] },
        { defaultIcon: 'bow', slot: slots.ranged[0] },
        { defaultIcon: 'bow', slot: slots.ranged[1] },
      ];
      const rendered = await Promise.all(slotDefs.map(async d => {
        const svg = await loadSvgIcon(d.slot && !d.slot.disabled ? d.slot.icon : d.defaultIcon);
        return renderSlot(svg, d.slot);
      }));
      const [helmetSlot, bodySlot, legsSlot, bootsSlot, neckSlot, ring1Slot, ring2Slot, toolSlot, melee0Slot, melee1Slot, ranged0Slot, ranged1Slot] = rendered;
      const meleeAtk = primaryAttack(char, 'melee');
      const rangedAtk = primaryAttack(char, 'ranged');

      container.innerHTML = `
        <div class="char-top">
          <div class="char-portrait-row">
            <div class="equipment-column left-slots">
              ${helmetSlot}
              ${bodySlot}
              ${legsSlot}
              ${bootsSlot}
            </div>

            <div class="portrait-mid">
              <div class="char-name">${escapeHtml(char.name)}</div>
              <div class="char-portrait">${escapeHtml(char.portrait || char.name[0])}</div>
            </div>

            <div class="equipment-column right-slots">
              ${neckSlot}
              ${ring1Slot}
              ${ring2Slot}
              ${toolSlot}
            </div>
          </div>

          <div class="combat-stats">
            <div class="combat-stat">
              <div class="combat-stat-icon">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                </svg>
              </div>
              <div class="combat-stat-value">${escapeHtml(String(char.combat.ac))}</div>
              <div class="combat-stat-label">护甲等级</div>
            </div>
            <div class="combat-stat">
              <div class="combat-stat-icon">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                </svg>
              </div>
              <div class="combat-stat-value">${escapeHtml(hpText(char))}</div>
              <div class="combat-stat-label">生命值</div>
            </div>
          </div>
        </div>

        <div class="char-bottom">
          <div class="weapon-slot-group">
            <div class="weapon-slot-label">${escapeHtml(meleeAtk.name || '近战')}</div>
            <div class="weapon-slots">
              ${melee0Slot}
              ${melee1Slot}
            </div>
          </div>

          <div class="char-level-badge">Lv.${escapeHtml(char.level ?? 1)}</div>

          <div class="weapon-slot-group">
            <div class="weapon-slot-label">${escapeHtml(rangedAtk.name || '远程')}</div>
            <div class="weapon-slots">
              ${ranged0Slot}
              ${ranged1Slot}
            </div>
          </div>
        </div>

        <div class="attack-stats">
          <div class="attack-weapon-group">
            <div class="attack-value">${escapeHtml(bonusText(meleeAtk.bonus))}</div>
            <div class="attack-value">${escapeHtml(meleeAtk.damage || '—')}</div>
          </div>
          <div class="attack-labels">
            <div class="attack-label">攻击加值</div>
            <div class="attack-label">伤害</div>
          </div>
          <div class="attack-weapon-group">
            <div class="attack-value">${escapeHtml(bonusText(rangedAtk.bonus))}</div>
            <div class="attack-value">${escapeHtml(rangedAtk.damage || '—')}</div>
          </div>
        </div>
      `;
    } catch (e) {
      container.innerHTML = '<div class="char-card-placeholder">角色数据读取失败</div>';
    }
  }

  /**
   * 背包物资面板
   * @param {object} char      角色卡
   * @param {object} catalogs  目录集合（读取 catalogs.equipment）
   * @param {object} state     页面状态（读取 state.playerInventory 与 state.data.items）
   */
  async function renderInventoryPanel(char, catalogs, state) {
    const catalog = catalogs.equipment || {};
    const items = char.inventory?.items || [];
    const gold = char.inventory?.gold || 0;
    const invItems = (state && state.playerInventory) || [];
    // 装备栏 = 角色卡 inventory.items（拾取/购买的装备直接写入角色卡；测试阶段不持久化，刷新即回退）
    const equipItems = items.map((it, i) => ({ ...it, idx: i }));
    let itemsHtml;
    let emptyDiv = '';
    if (equipItems.length === 0) {
      itemsHtml = '';
      if (invItems.length === 0) emptyDiv = '<div class="inv-empty">背包空空如也</div>';
    } else {
      const itemsWithSvg = await Promise.all(equipItems.map(async item => {
        const catalogItem = item.equipment_id ? catalog[item.equipment_id] : null;
        const displayName = catalogItem ? catalogItem.name : (item.name || '未知物品');
        const iconName = catalogItem ? catalogItem.icon : 'pouch';
        const iconSvg = await loadSvgIcon(iconName);
        const description = catalogItem ? catalogItem.description : '';
        const props = catalogItem ? itemEffectText(catalogItem, catalog) : '';
        return { ...item, displayName, iconSvg, description, props };
      }));
      itemsHtml = itemsWithSvg.map(item => `
        <div class="item-card" data-idx="${item.idx}" data-equipment-id="${escapeHtml(item.equipment_id || '')}" data-name="${escapeHtml(item.displayName)}" data-description="${escapeHtml(item.description)}" data-props="${escapeHtml(item.props)}">
          <div class="item-top">
            <div class="item-icon">${item.iconSvg}</div>
            <div class="item-info">
              <div class="item-name">${escapeHtml(item.displayName)}</div>
            </div>
          </div>
          ${item.equipped ? '<div class="item-equipped">已装备</div>' : ''}
          <div class="item-quantity">x${item.quantity || 1}</div>
        </div>
      `).join('');
    }
    // 道具区（后端运行时背包 playerInventory，数量按 id 聚合）
    let supplyHtml = '';
    if (invItems.length > 0) {
      const subItems = (state && state.data && state.data.items) || {};
      const counts = {};
      invItems.forEach(iid => counts[iid] = (counts[iid] || 0) + 1);
      const supplyRows = await Promise.all(Object.entries(counts).map(async ([iid, n]) => {
        const sub = subItems[iid];
        const name = sub ? sub.name : iid;
        const desc = sub ? sub.description : '';
        const iconSvg = await loadSvgIcon((sub && sub.icon) || 'pouch');
        return `
          <div class="item-card" data-kind="item" data-item-id="${escapeHtml(iid)}" data-name="${escapeHtml(name)}" data-description="${escapeHtml(desc)}" data-props="">
            <div class="item-top">
              <div class="item-icon">${iconSvg}</div>
              <div class="item-info">
                <div class="item-name">${escapeHtml(name)}</div>
              </div>
            </div>
            <div class="item-quantity">x${n}</div>
          </div>`;
      }));
      supplyHtml = `
        <div class="inv-supplies-title">道具</div>
        <div class="items-grid">${supplyRows.join('')}</div>`;
    }
    // 装备区：装备类物品单独成栏
    const equipHtml = items.length > 0 ? `
        <div class="inv-supplies-title">装备</div>
        <div class="items-grid">${itemsHtml}</div>` : '';
    return `
      <div class="inventory-panel">
        <div class="inventory-header">
          <div class="inventory-title">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <path d="M16 10a4 4 0 0 1-8 0"></path>
            </svg>
            背包物资
          </div>
          <div class="inventory-gold">${gold} G</div>
        </div>
        ${emptyDiv}
        ${equipHtml}
        ${supplyHtml}
      </div>
    `;
  }

  /** 职业 / 属性面板（需要职业与特性目录） */
  function renderClassAttrPanel(char, catalogs) {
    const features = catalogs.features || {};
    const classes = catalogs.classes || {};
    const classData = char.class_id ? classes[char.class_id] : null;
    const subclassData = classData && char.subclass_id ? (classData.subclasses || {})[char.subclass_id] : null;

    const statusItems = (char.features?.status_ids || []).map(id => features.status ? features.status[id] : null).filter(Boolean);
    const resistanceItems = (char.features?.resistance_ids || []).map(id => features.resistances ? features.resistances[id] : null).filter(Boolean);
    const classFeatureItems = (char.features?.class_feature_ids || []).map(id => features.class_features ? features.class_features[id] : null).filter(Boolean);
    const traitItems = (char.features?.trait_ids || []).map(id =>
      (features.traits && features.traits[id]) || (features.racial && features.racial[id]) || null
    ).filter(Boolean);

    const abilityOrder = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    const abilityHtml = abilityOrder.map(key => {
      const a = char.abilities[key];
      return `<div class="ability">
        <div class="ability-star">${a.highlighted ? '&#9733;' : ''}</div>
        <div class="ability-label">${escapeHtml(a.label)}</div>
        <div class="ability-value ${a.highlighted ? 'highlighted' : ''}">${a.value}</div>
      </div>`;
    }).join('');

    const featSection = (title, items) => items.length
      ? `<div class="divider"><span>${title}</span></div><ul class="feature-list">${items.map(f => `<li>${escapeHtml(f.name)} <span class="feature-arrow"><svg viewBox="0 0 12 8"><polyline points="2,2 6,6 10,2"></polyline></svg></span></li><div class="feature-detail">${escapeHtml(f.description || '')}</div>`).join('')}</ul>`
      : '';

    const raceName = char.background?.race || '';
    const className = classData ? classData.name : (char.class || '');
    return `
      <div class="class-panel">
        <div class="class-race">${escapeHtml(raceName)}</div>
        <div class="class-icon">${escapeHtml(classData ? (classData.icon || '') : '')}</div>
        <div class="class-subclass">${escapeHtml(subclassData ? subclassData.name : '')}</div>
        <div class="class-level">等级${char.level || 1} ${escapeHtml(className)}</div>

        <div class="ability-scores">${abilityHtml}</div>
        ${featSection('状态', statusItems)}
        ${featSection('抗性', resistanceItems)}
        ${featSection('职业特性', classFeatureItems)}
        ${featSection('重要特性', traitItems)}
      </div>
    `;
  }

  /** 熟练项面板 */
  function renderSkillsPanel(char) {
    const sections = char.skills?.sections || [];
    const pb = char.skills?.proficiency_bonus || '+2';
    return `
      <div class="prof-bonus"><span class="star">★</span>熟练项加值 (${escapeHtml(pb)})</div>
      ${sections.map(section => `
        <div class="divider"><span>${escapeHtml(section.ability)} (${escapeHtml(section.modifier)})</span></div>
        ${section.skills.map(skill => `
          <div class="skill-row">
            <span class="skill-name">${escapeHtml(skill.name)}</span>
            <span class="skill-value ${skill.type}">${escapeHtml(skill.value)}</span>
          </div>
        `).join('')}
      `).join('')}
    `;
  }

  /** 人物背景面板 */
  function renderBackgroundPanel(char) {
    const bg = char.background;
    const labelMap = { move_speed:'移动速度', darkvision:'黑暗视觉范围', ranged_range:'远程攻击范围', melee_range:'近战攻击范围', throw_range:'投掷范围', size:'体型', weight:'重量', carry_weight:'负重' };
    const attrsHtml = Object.entries(bg.attributes || {}).map(([k, v]) =>
      `<div class="bg-info-row"><span class="bg-info-label">${labelMap[k] || k}</span><span class="bg-info-value">${escapeHtml(String(v))}</span></div>`
    ).join('');

    const saveAbilities = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
    const saveHtml = saveAbilities.map(key => {
      const a = char.abilities[key];
      return `<div class="ability"><div class="ability-label">${escapeHtml(a.label)}</div><div class="ability-value highlighted">${escapeHtml(a.save_bonus)}</div></div>`;
    }).join('');

    const traitMap = { personality:'个人特点', ideal:'理想', bond:'牵绊', flaw:'缺点' };
    const traitsHtml = Object.entries(bg.traits || {}).map(([k, text]) =>
      `<div class="bg-trait"><div class="bg-trait-title">${traitMap[k] || k}</div><div class="bg-trait-text">${escapeHtml(text || '—')}</div></div>`
    ).join('');

    return `
      <div class="divider"><span>属性</span></div>
      ${attrsHtml}
      <div class="divider"><span>豁免</span></div>
      <div class="ability-scores">${saveHtml}</div>
      <div class="divider"><span>背景</span></div>
      ${traitsHtml}
    `;
  }

  /** 角色卡标签页切换（两个页面 DOM 结构相同，无需参数） */
  function initCharTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.char-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const target = document.getElementById('tab-' + tab.dataset.tab);
        if (target) target.classList.add('active');
      });
    });
  }

  /* ── 左侧上下文面板（场景 / 人物 / 物品 / 出口 / 任务） ── */

  function sceneOf(state) {
    if (!state || !state.data || !state.currentSceneId) return null;
    return state.data.scenes[state.currentSceneId] || null;
  }

  function locationOf(state) {
    const scene = sceneOf(state);
    if (!scene || !state.data.locations) return null;
    return state.data.locations[scene.location] || null;
  }

  function itemDefOf(state, catalogs, id) {
    const items = state && state.data && state.data.items;
    if (items && items[id]) return items[id];
    return (catalogs && catalogs.equipment && catalogs.equipment[id]) || null;
  }

  /** 当前地点的物理出口（不展示场景跳转） */
  function sceneExitsOf(state) {
    const scene = sceneOf(state);
    if (!scene) return [];
    const exits = [];
    const loc = locationOf(state);
    if (loc && loc.exits) {
      loc.exits.forEach(exit => {
        const targetLoc = state.data.locations[exit.target];
        exits.push({
          name: exit.name,
          targetLocationId: exit.target,
          targetSceneId: null,
          description: exit.description || (targetLoc ? targetLoc.description : ''),
        });
      });
    }
    return exits;
  }

  /** 地点标题 */
  function renderLocationHeader(state) {
    const scene = sceneOf(state);
    const loc = locationOf(state);
    if (!scene) return;
    const titleEl = document.getElementById('location-title');
    const metaEl = document.getElementById('location-meta');
    if (!titleEl || !metaEl) return;
    if (loc && loc.parent_location) {
      titleEl.textContent = `${loc.parent_location} · ${loc.name}`;
    } else {
      titleEl.textContent = loc ? loc.name : scene.name;
    }
    const chapter = state.data.chapter;
    metaEl.textContent = chapter ? `${chapter.title} · ${scene.name}` : scene.name;
  }

  /** 叙事日志 */
  function renderNarrativeLog(state) {
    const el = document.getElementById('narrative-log');
    if (!el) return;
    if (!state || !state.log || state.log.length === 0) {
      el.innerHTML = '';
      return;
    }

    const labels = { gm: 'GM', player: '玩家', system: '系统', check: '检定', npc: 'NPC' };

    el.innerHTML = state.log.map(entry => {
      let extra = '';
      const dataId = entry.meta && entry.meta.id ? `data-log-id="${entry.meta.id}"` : '';
      if (entry.type === 'check' && entry.meta) {
        const m = entry.meta;
        const rollText = m.roll ? `d20(${m.roll})+${m.mod||0}` : '';
        const dcText = m.dc ? ` DC ${m.dc}` : '';
        const result = m.success ? '成功' : '失败';
        const resultClass = m.success ? 'color:var(--accent);' : 'color:var(--danger);';
        extra = `<div style="margin-top:6px;font-size:13px;">掷骰: ${rollText}${dcText} — <span style="${resultClass}font-weight:700;">${result}</span></div>`;
      }
      return `
        <div class="log-entry ${entry.type}" ${dataId}>
          <div class="log-label">${labels[entry.type] || entry.type}</div>
          <div class="log-text">${entry.text}</div>
          ${extra}
        </div>
      `;
    }).join('');

    el.scrollTop = el.scrollHeight;
  }

  /**
   * 左侧上下文面板
   * @param {object} state     页面状态（场景、地点、NPC、物品、任务、日志）
   * @param {object} catalogs  目录（用于兜底查物品定义）
   * @param {object} handlers  { onOpenDetail(type,id), onNavigateScene(id), onNavigateLocation(id) }
   */
  function renderContextPanel(state, catalogs, handlers) {
    handlers = handlers || {};
    const scene = sceneOf(state);
    const loc = locationOf(state);
    if (!scene || !loc) return;

    // 当前地点
    const locEl = document.getElementById('context-location');
    if (locEl) {
      locEl.querySelector('.location-name').textContent = loc.name;
      locEl.onclick = () => handlers.onOpenDetail && handlers.onOpenDetail('location', loc.id);
    }

    // 人物：当前地点优先（地点显式定义了 npcs，含空数组），场景兜底
    const npcsEl = document.getElementById('context-npcs');
    const rawNpcIds = (loc.npcs !== undefined) ? (loc.npcs || []) : (scene.npcs || []);
    const npcIds = rawNpcIds.map(e => (typeof e === 'string') ? e : (e && e.id)).filter(Boolean);
    const NPC_STATUS_SUFFIX = { dead: '（已死亡）', stunned: '（眩晕）', unconscious: '（昏迷）' };
    const npcStates = state.npcStates || {};
    const visibleNpcIds = npcIds.filter(id => (npcStates[id]?.status || '') !== 'left');
    if (visibleNpcIds.length === 0) {
      npcsEl.innerHTML = '<div class="context-empty">此处没有其他人</div>';
    } else {
      npcsEl.innerHTML = visibleNpcIds.map(id => {
        const npc = state.data.npcs[id];
        if (!npc) return '';
        const suffix = NPC_STATUS_SUFFIX[npcStates[id]?.status] || '';
        return `
          <div class="context-item" data-type="npc" data-id="${id}">
            <div class="context-item-icon">${npc.name[0]}</div>
            <div class="context-item-name">${npc.name}${suffix}</div>
            <div class="context-item-meta">${npc.role || ''}</div>
          </div>
        `;
      }).join('');
      npcsEl.querySelectorAll('.context-item').forEach(el => {
        el.addEventListener('click', () => handlers.onOpenDetail && handlers.onOpenDetail('npc', el.dataset.id));
      });
    }

    // 物品：当前地点优先（地点显式定义了 items，含空数组），场景兜底
    const itemsEl = document.getElementById('context-items');
    const locHasItems = loc.items !== undefined;
    let visibleItems;
    if (locHasItems) {
      visibleItems = loc.items.filter(i => i.visible !== false);
    } else if (scene.items && scene.items.length > 0) {
      visibleItems = scene.items.map(id => ({ id, visible: true }));
    } else {
      visibleItems = [];
    }
    const takenItems = state.takenLocationItems || [];
    visibleItems = visibleItems.filter(entry => !takenItems.includes(entry.id));
    const dropped = (state.droppedItems || {})[loc.id] || [];
    if (dropped.length > 0) {
      const have = new Set(visibleItems.map(e => e.id));
      dropped.forEach(id => { if (!have.has(id)) visibleItems.push({ id, visible: true }); });
    }
    if (visibleItems.length === 0) {
      itemsEl.innerHTML = '<div class="context-empty">此处没有可见物品</div>';
    } else {
      itemsEl.innerHTML = visibleItems.map(entry => {
        const item = itemDefOf(state, catalogs, entry.id);
        if (!item) return '';
        return `
          <div class="context-item" data-type="item" data-id="${entry.id}">
            <div class="context-item-icon">I</div>
            <div class="context-item-name">${item.name}</div>
          </div>
        `;
      }).join('');
      itemsEl.querySelectorAll('.context-item').forEach(el => {
        el.addEventListener('click', () => handlers.onOpenDetail && handlers.onOpenDetail('item', el.dataset.id));
      });
    }

    // 可去地点：仅显示当前地点的物理出口
    const exitsSection = document.getElementById('context-exits-section');
    const exitsEl = document.getElementById('context-exits');
    const exits = sceneExitsOf(state);
    if (exits.length === 0) {
      exitsSection.style.display = 'none';
    } else {
      exitsSection.style.display = '';
      exitsEl.innerHTML = exits.map((exit, i) => `
        <div class="context-item" data-type="exit" data-index="${i}">
          <div class="context-item-icon" style="font-size:11px;">→</div>
          <div class="context-item-name">${exit.name}</div>
        </div>
      `).join('');
      exitsEl.querySelectorAll('.context-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.index);
          const exit = exits[idx];
          if (!exit || !exit.targetLocationId) return;

          const targetScene = Object.values(state.data.scenes).find(
            s => s.location === exit.targetLocationId
          );
          if (targetScene && targetScene.id !== state.currentSceneId) {
            handlers.onNavigateScene && handlers.onNavigateScene(targetScene.id);
          } else {
            handlers.onNavigateLocation && handlers.onNavigateLocation(exit.targetLocationId);
          }
        });
      });
    }

    // 任务
    const questsEl = document.getElementById('context-quests');
    const quests = state.quests || state.data.quests;
    const activeQuestIds = Object.keys(quests).filter(id => quests[id].status === 'active');
    if (activeQuestIds.length === 0) {
      questsEl.innerHTML = '<div class="context-empty">暂无任务</div>';
    } else {
      questsEl.innerHTML = activeQuestIds.map(id => {
        const q = quests[id];
        // 只显示：已完成子任务 + 第一个未完成子任务（防剧透）
        const objectives = q.objectives || [];
        let firstIncompleteIdx = objectives.findIndex(o => !o.completed);
        if (firstIncompleteIdx === -1) firstIncompleteIdx = objectives.length;
        const visibleObjectives = objectives.slice(0, firstIncompleteIdx + 1);

        const subtaskHtml = visibleObjectives.length > 0 ? `
          <div class="quest-subtasks" style="display:none;">
            ${visibleObjectives.map((o, idx) => `
              <div class="quest-subtask ${o.completed ? 'done' : ''}" data-quest-id="${id}" data-subtask-idx="${idx}">
                <div class="quest-subtask-check">${o.completed ? '✓' : ''}</div>
                <div class="quest-subtask-text">${o.description}</div>
              </div>
            `).join('')}
          </div>
        ` : '';

        return `
          <div class="context-item quest-item" data-quest-id="${id}">
            <div class="context-item-icon" style="font-size:10px;">Q</div>
            <div class="context-item-name">${q.name}</div>
            ${visibleObjectives.length > 0 ? `
              <button class="quest-expand-btn" type="button" aria-label="展开任务">
                <svg viewBox="0 0 12 8"><polyline points="2,2 6,6 10,2"></polyline></svg>
              </button>` : ''}
            ${subtaskHtml}
          </div>
        `;
      }).join('');

      // 点击任务：展开/收起子任务
      questsEl.querySelectorAll('.quest-item').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.quest-subtask')) return;
          const subtasksEl = el.querySelector('.quest-subtasks');
          if (subtasksEl) {
            const isOpen = subtasksEl.style.display !== 'none';
            subtasksEl.style.display = isOpen ? 'none' : 'block';
            const btn = el.querySelector('.quest-expand-btn');
            if (btn) btn.classList.toggle('open', !isOpen);
          }
        });
      });

      // 点击子任务：弹出任务详情模态框
      questsEl.querySelectorAll('.quest-subtask').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          handlers.onOpenQuestDetail && handlers.onOpenQuestDetail(el.dataset.questId, parseInt(el.dataset.subtaskIdx));
        });
      });
    }
  }

  /**
   * 任务详情弹窗（分类侧栏 + 任务展开 + 子任务详情）
   * @param {object} state      页面状态（读取 state.quests 或 state.data.quests）
   * @param {string} questId    初始选中的任务
   * @param {number|null} subtaskIdx 初始选中的子任务下标
   */
  function openQuestDetailModal(state, questId, subtaskIdx) {
    const modalOverlay = document.getElementById('detail-modal-overlay');
    const modalContent = document.getElementById('detail-modal-content');
    const questsRaw = state.quests || state.data.quests;

    // 构建任务列表（排除 hidden）
    const allQuests = Object.values(questsRaw)
      .filter(q => q.status !== 'hidden')
      .map(q => ({
        id: q.id,
        title: q.name,
        description: q.description,
        completed: q.status === 'completed' || (q.objectives && q.objectives.length > 0 && q.objectives.every(o => o.completed)),
        objectives: (q.objectives || []).map(o => ({ text: o.description, description: o.description, completed: o.completed })),
        reward: q.reward,
      }));

    const activeQuests = allQuests.filter(q => !q.completed);
    const completedQuests = allQuests.filter(q => q.completed);

    let selectedQuestId = questId;
    let expandedQuestIds = new Set([questId]);
    let selectedSubtask = subtaskIdx != null ? { questId: questId, subtaskIdx } : null;

    function renderSidebar() {
      let html = '';

      if (activeQuests.length > 0) {
        html += `
          <div class="task-category" data-category="active">
            <div class="task-category-title" data-category-toggle="active">
              <span>进行中</span>
              <span class="task-category-arrow">
                <svg viewBox="0 0 12 8"><polyline points="2,2 6,6 10,2"></polyline></svg>
              </span>
            </div>
            <div class="task-category-list">
              ${activeQuests.map(q => renderNavItem(q)).join('')}
            </div>
          </div>
        `;
      }

      if (completedQuests.length > 0) {
        html += `
          <div class="task-category" data-category="completed">
            <div class="task-category-title" data-category-toggle="completed">
              <span>已完成任务</span>
              <span class="task-category-arrow">
                <svg viewBox="0 0 12 8"><polyline points="2,2 6,6 10,2"></polyline></svg>
              </span>
            </div>
            <div class="task-category-list">
              ${completedQuests.map(q => renderNavItem(q)).join('')}
            </div>
          </div>
        `;
      }

      return html;
    }

    function buildSubtaskRows(quest) {
      if (!quest.objectives || quest.objectives.length === 0) return '';
      // 防剧透：只显示已完成子任务 + 第一个未完成子任务
      let fiIdx = quest.objectives.findIndex(o => !o.completed);
      if (fiIdx === -1) fiIdx = quest.objectives.length;
      const visibleObjs = quest.objectives.slice(0, fiIdx + 1);
      return visibleObjs.map((st, idx) => {
        const subCompleted = st.completed ? ' completed' : '';
        const subActive = selectedSubtask && selectedSubtask.questId === quest.id && selectedSubtask.subtaskIdx === idx ? ' active' : '';
        const subName = st.text + (st.completed ? '（已完成）' : '');
        return `
          <div class="task-sub-nav-item${subCompleted}${subActive}" data-quest-id="${quest.id}" data-subtask-idx="${idx}">
            <span class="sub-nav-dot"></span>
            <span class="task-sub-nav-name">${escapeHtml(subName)}</span>
          </div>
        `;
      }).join('');
    }

    function renderNavItem(quest) {
      const isActive = quest.id === selectedQuestId;
      const completedClass = quest.completed ? ' task-completed' : '';
      const statusText = quest.completed ? '已完成' : '进行中';
      const statusClass = quest.completed ? 'completed' : 'ongoing';
      const hasSubtasks = quest.objectives && quest.objectives.length > 0;
      const isExpanded = expandedQuestIds.has(quest.id);
      const expandClass = isExpanded ? ' expanded' : '';
      const noExpandClass = !hasSubtasks ? ' no-expand' : '';

      const subtaskRows = hasSubtasks && isExpanded ? buildSubtaskRows(quest) : '';

      return `
        <div class="task-nav-item${isActive ? ' active' : ''}${completedClass}${expandClass}${noExpandClass}" data-quest-id="${quest.id}">
          <span class="task-nav-name">${escapeHtml(quest.title)}</span>
          <span class="task-nav-status ${statusClass}">${statusText}</span>
          ${hasSubtasks ? `
            <span class="task-nav-arrow">
              <svg viewBox="0 0 12 8"><polyline points="2,2 6,6 10,2"></polyline></svg>
            </span>
          ` : ''}
        </div>
        ${subtaskRows}
      `;
    }

    function renderQuestDetail(quest) {
      const tagClass = quest.completed ? 'completed' : 'ongoing';
      const tagText = quest.completed ? '已完成' : '进行中';
      const objectives = quest.objectives || [];

      // 防剧透：只显示已完成子任务 + 第一个未完成子任务
      let firstIncompleteIdx = objectives.findIndex(o => !o.completed);
      if (firstIncompleteIdx === -1) firstIncompleteIdx = objectives.length;
      const visibleObjectives = objectives.slice(0, firstIncompleteIdx + 1);

      let subtasksHtml = '';
      if (visibleObjectives.length > 0) {
        subtasksHtml = `
          <div class="task-section-title">阶段目标</div>
          <div class="task-subtasks">
            ${visibleObjectives.map(st => `
              <div class="subtask${st.completed ? ' completed' : ''}">
                <div class="subtask-check">
                  ${st.completed
                    ? '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>'
                    : '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>'}
                </div>
                <div class="subtask-text">${escapeHtml(st.text)}${st.completed ? '（已完成）' : ''}</div>
              </div>
            `).join('')}
          </div>
        `;
      }

      return `
        <div class="task-detail-header">
          <div class="task-detail-tag ${tagClass}">${tagText}</div>
          <h2>${escapeHtml(quest.title)}</h2>
        </div>
        <div class="task-detail-body">
          ${subtasksHtml}
          <div class="task-description">${escapeHtml(quest.description || '')}</div>
        </div>
      `;
    }

    function renderSubtaskDetail(qid, idx) {
      const quest = allQuests.find(q => q.id === qid);
      if (!quest) return '';
      const st = quest.objectives && quest.objectives[idx];
      if (!st) return '';

      const tagClass = st.completed ? 'completed' : 'ongoing';
      const tagText = st.completed ? '已完成' : '进行中';

      return `
        <div class="task-detail-header">
          <div class="task-detail-tag ${tagClass}">${tagText}</div>
          <h2>${escapeHtml(st.text)}</h2>
        </div>
        <div class="task-detail-body">
          <div class="task-description">${escapeHtml(st.description || '详细描述待补充。')}</div>
        </div>
      `;
    }

    function renderDetail() {
      if (selectedSubtask) {
        return renderSubtaskDetail(selectedSubtask.questId, selectedSubtask.subtaskIdx);
      }
      const curQ = allQuests.find(q => q.id === selectedQuestId);
      return curQ ? renderQuestDetail(curQ) : '';
    }

    function bindSubtaskEl(sub) {
      sub.addEventListener('click', (e) => {
        e.stopPropagation();
        const qid = sub.dataset.questId;
        const idx = parseInt(sub.dataset.subtaskIdx);
        selectedQuestId = qid;
        selectedSubtask = { questId: qid, subtaskIdx: idx };
        refreshModal();
      });
    }

    function refreshModal() {
      modalContent.innerHTML = `
        <div class="task-columns">
          <div class="task-sidebar">${renderSidebar()}</div>
          <div class="task-detail" id="task-modal-detail">${renderDetail()}</div>
        </div>
      `;

      // 分类折叠/展开
      modalContent.querySelectorAll('.task-category-title').forEach(title => {
        title.addEventListener('click', () => {
          const category = title.closest('.task-category');
          if (category) category.classList.toggle('collapsed');
        });
      });

      // 任务项点击
      modalContent.querySelectorAll('.task-nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
          const qid = item.dataset.questId;
          const arrowEl = item.querySelector('.task-nav-arrow');

          if (arrowEl && arrowEl.contains(e.target)) {
            // 切换展开/折叠（局部操作，保证箭头旋转动画生效）
            const willExpand = !expandedQuestIds.has(qid);
            if (willExpand) expandedQuestIds.add(qid);
            else expandedQuestIds.delete(qid);
            item.classList.toggle('expanded', willExpand);

            // 局部插入/移除子任务行，避免整块重渲染导致动画失效
            if (willExpand) {
              const quest = allQuests.find(q => q.id === qid);
              item.insertAdjacentHTML('afterend', buildSubtaskRows(quest));
              let nxt = item.nextElementSibling;
              while (nxt && nxt.classList.contains('task-sub-nav-item')) {
                bindSubtaskEl(nxt);
                nxt = nxt.nextElementSibling;
              }
            } else {
              let nxt = item.nextElementSibling;
              while (nxt && nxt.classList.contains('task-sub-nav-item')) {
                const cur = nxt;
                nxt = nxt.nextElementSibling;
                cur.remove();
              }
            }

            if (selectedSubtask && selectedSubtask.questId === qid) {
              selectedSubtask = null;
            }
            selectedQuestId = qid;
            const detailEl = modalContent.querySelector('#task-modal-detail');
            if (detailEl) detailEl.innerHTML = renderDetail();
            return;
          }

          // 普通点击——选中任务
          selectedQuestId = qid;
          selectedSubtask = null;
          expandedQuestIds.add(qid);
          refreshModal();
        });
      });

      // 子任务项点击
      modalContent.querySelectorAll('.task-sub-nav-item').forEach(bindSubtaskEl);
    }

    refreshModal();
    const detailModal = document.getElementById('detail-modal');
    if (detailModal) detailModal.classList.add('task-panel');
    if (modalOverlay) modalOverlay.classList.add('active');
  }

  /* ── 通用详情弹窗（NPC / 物品 / 出口 / 地点） ── */

  const NPC_STATUS_SUFFIX = { dead: '（已死亡）', stunned: '（眩晕）', unconscious: '（昏迷）' };

  /**
   * 打开详情弹窗
   * @param {object} state
   * @param {object} catalogs
   * @param {string} type   npc / item / exit / location
   * @param {string} id
   * @param {object} extra  exit 的 { name, description }
   * @param {object} hooks  {
   *   npcExtraContent(npc,id,status) → html|Promise,   // 页面专属区块（如搜尸体）
   *   canTrade(npc,status) → boolean,                  // 是否显示交易按钮
   *   buildItemExtra(id,item) → html|Promise,          // 物品附加信息
   *   onTakeItem(containerId,itemId,npcId),            // 拾取
   *   onTrade(npcId)                                   // 交易
   * }
   */
  async function openDetailModal(state, catalogs, type, id, extra, hooks) {
    hooks = hooks || {};
    const modalContent = document.getElementById('detail-modal-content');
    const modalOverlay = document.getElementById('detail-modal-overlay');
    let title = '';
    let meta = '';
    let desc = '';
    let avatar = '?';
    let extraContent = '';

    switch (type) {
      case 'npc': {
        const npc = state.data.npcs[id];
        if (!npc) return;
        title = npc.name;
        meta = `${npc.race || ''} · ${npc.role || ''}`;
        desc = npc.description || '';
        avatar = npc.name[0];

        // 状态徽章（已死亡/昏迷/已离开）
        const npcStatus = state.npcStates?.[id]?.status;
        if (npcStatus && NPC_STATUS_SUFFIX[npcStatus]) {
          meta += ` <span class="npc-status-badge npc-status-${npcStatus}">${NPC_STATUS_SUFFIX[npcStatus]}</span>`;
        }

        // 页面专属区块（冒险页：死亡/昏迷时显示身上物品）
        if (hooks.npcExtraContent) {
          extraContent += (await hooks.npcExtraContent(npc, id, npcStatus)) || '';
        }

        const canTrade = hooks.canTrade ? hooks.canTrade(npc, npcStatus) : !!npc.merchant;
        if (canTrade) {
          extraContent += `
            <button type="button" class="trade-btn trade-open" data-npc="${id}" style="width:100%; padding:9px 0; font-size:14px;">交易</button>`;
        }
        break;
      }
      case 'item': {
        const item = itemDefOf(state, catalogs, id);
        if (!item) return;
        title = item.name;
        meta = item.type || '';
        desc = item.description || '';
        avatar = 'I';
        if (hooks.buildItemExtra) extraContent = (await hooks.buildItemExtra(id, item)) || '';
        break;
      }
      case 'exit': {
        const targetLoc = state.data.locations[id];
        title = (extra && extra.name) || '出口';
        meta = (extra && extra.description) || '';
        desc = targetLoc ? `通往: ${targetLoc.name}` : '';
        avatar = '→';
        break;
      }
      case 'location': {
        const loc = state.data.locations[id];
        if (!loc) return;
        title = loc.name;
        meta = loc.type || '';
        desc = loc.description || '';
        avatar = loc.name[0];
        break;
      }
    }

    modalContent.innerHTML = `
      <div class="modal-header">
        <div class="modal-avatar">${avatar}</div>
        <div>
          <div class="modal-name">${title}</div>
          <div class="modal-meta">${meta}</div>
        </div>
      </div>
      <div class="modal-desc">${desc.replace(/\n/g, '<br>')}</div>
      ${extraContent}
    `;

    modalContent.querySelectorAll('.take-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const containerId = btn.dataset.container || null;
        const itemId = btn.dataset.item;
        const npcId = btn.dataset.npc || null;
        if (hooks.onTakeItem) await hooks.onTakeItem(containerId, itemId, npcId);
      });
    });

    // 交易按钮：关闭详情弹窗后打开交易弹窗
    modalContent.querySelectorAll('.trade-open').forEach(btn => {
      btn.addEventListener('click', () => {
        if (hooks.onTrade) hooks.onTrade(btn.dataset.npc);
      });
    });

    modalOverlay.classList.add('active');
  }

  /* ═══════════════════════════════════════════════════════════
   * 法术 / 动作面板：只共享「算」，不共享「画」
   *   冒险页、大厅 → 说明书式胶囊（带 data-spell-id，悬浮看说明）
   *   战斗页       → 操作台式胶囊（带 data-action-kind / data-cost）
   * ═══════════════════════════════════════════════════════════ */

  /**
   * 整理角色法术/动作数据，并刷新 window.spellLookup（各页 tooltip 依赖）。
   * @param {object} char     角色卡
   * @param {object} catalogs 含 spells 的目录对象
   * @param {object} [opts]
   * @param {object} [opts.state]   页面 state（读 state.spellSlotsUsed）
   * @param {number} [opts.slotUsed] 直接指定 1 环已用法术位（大厅读角色卡存档时用）
   */
  function buildSpellViewModel(char, catalogs, opts) {
    opts = opts || {};
    const spells = (catalogs && catalogs.spells) || {};
    const charSpells = char.spells || {};

    // 快速查找表：id → 法术/动作定义
    const lookup = {};
    const addLookup = (catalog) => {
      if (catalog) Object.entries(catalog).forEach(([id, s]) => { lookup[id] = s; });
    };
    addLookup(spells.actions?.normal);
    addLookup(spells.actions?.class);
    addLookup(spells.passive);
    addLookup(spells.spells?.level_1);
    addLookup(spells.cantrips);
    window.spellLookup = lookup;

    // 统一产出 { id, name }，调用方无需再按名字反查 id
    const pairsOf = (ids, catalog) => (ids || []).map(id => ({
      id,
      name: (catalog && catalog[id]) ? catalog[id].name : id,
    }));

    const casterLevel = charSpells.caster_level || 1;
    const slotMax1 = casterLevel >= 2 ? 3 : 2;  // 与后端 spell_slot_max 一致（简化：1 级 2 个、2 级 3 个）
    const slotUsed1 = opts.slotUsed != null
      ? opts.slotUsed
      : ((opts.state?.spellSlotsUsed || {})[1] || 0);

    return {
      lookup,
      normalItems:  pairsOf((charSpells.action_ids || {}).normal || [], spells.actions?.normal),
      classItems:   pairsOf((charSpells.action_ids || {}).class || [], spells.actions?.class),
      passiveItems: pairsOf(charSpells.passive_ids || [], spells.passive),
      cantrips:     pairsOf(char.cantrip_ids || [], spells.cantrips),
      spellsL1:     pairsOf((charSpells.spell_ids || {}).level_1 || [], spells.spells?.level_1),
      casterLevel,
      slotMax1,
      slotUsed1,
      slotText1: `${Math.max(0, slotMax1 - slotUsed1)} / ${slotMax1}`,
    };
  }

  /** 共享「分节 + 网格」外壳；单个胶囊的样式由各页传入的 renderBlock 决定 */
  function spellSection(title, items, renderBlock) {
    return items.length
      ? `<div class="divider"><span>${title}</span></div><div class="skill-grid">${items.map(renderBlock).join('')}</div>`
      : '';
  }

  Object.assign(window, {
    renderCharCard,
    renderInventoryPanel,
    renderClassAttrPanel,
    renderSkillsPanel,
    renderBackgroundPanel,
    initCharTabs,
    renderLocationHeader,
    renderNarrativeLog,
    renderContextPanel,
    openQuestDetailModal,
    openDetailModal,
    buildSpellViewModel,
    spellSection,
  });
})();
