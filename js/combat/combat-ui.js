/**
 * 战斗 UI 渲染层
 * 职责：状态栏文案、战斗日志、资源条、先攻头像条、战斗结果横幅、昏迷标记
 * 特点：只读共享状态做渲染，不参与任何规则判定与回合推进
 */

import { combatState } from './state.js';
import { isTokenVisible } from './fog.js';

const S = combatState;

/** 状态栏文案（地图顶部） */
export function updateStatus(text) {
  const statusEl = document.getElementById('combat-status');
  if (statusEl) statusEl.textContent = text;
}

/** 战斗日志：追加一条记录到左侧日志区
 * @param {string} text - 日志内容
 * @param {'attack'|'heal'|'move'|'system'|'crit'} type - 类型（决定颜色）
 * @param {string} turnLabel - 回合标签（保留参数兼容，实际按 turnCounter 分组）
 * @param {boolean} skipDivider - 跳过分隔条插入（用于战斗开场等非轮次内日志） */
export function appendCombatLog(text, type = 'system', turnLabel = '', skipDivider = false) {
  const logEl = document.getElementById('combat-log');
  if (!logEl) return;
  // 清空"战斗尚未开始"占位
  const empty = logEl.querySelector('.combat-log-empty');
  if (empty) empty.remove();
  // 按轮次分组：进入新一轮时插入分隔条，同一轮内所有角色动作合并在同一组
  // skipDivider=true 时跳过分隔条，且不更新 lastLogTurn，下次调用仍会按当前轮次插入
  if (!skipDivider) {
    const turnKey = `第${S.turnCounter}轮`;
    if (turnKey !== S.lastLogTurn) {
      const divider = document.createElement('div');
      divider.className = 'combat-log-divider';
      divider.textContent = `── ${turnKey} ──`;
      logEl.appendChild(divider);
      S.lastLogTurn = turnKey;
    }
  }
  const entry = document.createElement('div');
  entry.className = `combat-log-entry log-${type}`;
  entry.textContent = text; // textContent 自动转义，防注入
  logEl.appendChild(entry);
  // 自动滚动到底部
  logEl.scrollTop = logEl.scrollHeight;
}

/** 当前回合标签（用于日志前缀） */
export function currentTurnLabel() {
  const cur = S.initiativeOrder[S.currentInitIndex];
  const name = cur?.name || '未知';
  return `第${S.turnCounter}轮 ${name}`;
}

/** 刷新地图底部资源条：动作● 附赠● 移动x.x米（仅玩家回合显示） */
export function updateResourceBar() {
  const bar = document.getElementById('resource-bar');
  if (bar) {
    // 仅玩家回合显示资源条；敌人回合隐藏（按用户反馈：敌人回合不展示玩家资源状态）
    bar.style.display = S.combatPhase === 'player' ? 'flex' : 'none';
    bar.classList.remove('enemy-turn');
    if (S.combatPhase !== 'player') {
      bar.innerHTML = '';
    } else {
      const dot = ok => (ok ? '●' : '○');
      const moveM = Math.round(S.turnResources.moveLeft * 10) / 10;
      bar.innerHTML =
        `<span class="res-chip${S.turnResources.action > 0 ? '' : ' used'}">动作 ${dot(S.turnResources.action > 0)}</span>` +
        `<span class="res-chip${S.turnResources.bonus > 0 ? '' : ' used'}">附赠 ${dot(S.turnResources.bonus > 0)}</span>` +
        `<span class="res-chip${moveM > 0.01 ? '' : ' used'}">移动 ${moveM}米</span>`;
    }
  }
  // 通知右侧面板刷新按钮置灰状态
  if (typeof window.__combatApi?.onTurnChanged === 'function') {
    window.__combatApi.onTurnChanged({ ...S.turnResources });
  }
}

/** 结束回合按钮显隐 */
export function showEndTurnBtn(show) {
  const btn = document.getElementById('btn-end-turn');
  if (btn) btn.style.display = show ? 'inline-block' : 'none';
}

/** 渲染先攻顺序头像条（地图上方横向） */
export function renderInitiativeBar() {
  const bar = document.getElementById('initiative-bar');
  if (!bar) return;
  if (!S.initiativeOrder.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = S.initiativeOrder.map((o, i) => {
    const dead = o.token.data.dead;
    const isCur = i === S.currentInitIndex && !dead;
    const nextIdx = (S.currentInitIndex + 1) % S.initiativeOrder.length;
    const isNext = i === nextIdx && !dead && i !== S.currentInitIndex;
    const cls = dead ? 'dead' : (isCur ? 'current' : (isNext ? 'next' : ''));
    const color = o.faction === 'player' ? 'var(--player,#4a90d9)' : 'var(--enemy,#d94a4a)';
    // 雾中敌人不泄露身份：名字/首字以 ? 占位（现身后再显示），先攻数值照常展示
    const hidden = o.faction !== 'player' && o.faction !== 'ally' && !isTokenVisible(o.token);
    const name = hidden ? '???' : (o.name || '?');
    const initial = hidden ? '?' : name.charAt(0);
    const title = hidden ? `未发现的敌人（先攻 ${o.initiative}）` : `${o.name}（先攻 ${o.initiative}）`;
    return `<div class="init-portrait ${cls}" title="${title}">
      <div class="init-circle" style="border-color:${color};background:${color}33;color:${color}">${initial}</div>
      <div class="init-name">${name}</div>
      <div class="init-roll">${o.initiative}</div>
    </div>`;
  }).join('');
}

/** 战斗结果提示（居中横幅，胜利/失败显示不同颜色）
 *  M6：嵌入冒险时不再自动消失，等跳转；独立调试模式下 3.5 秒后消失 */
export function showCombatResult(won) {
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
  // 地图探险模式：胜利后留在地图继续探索
  if (S.mapMode) {
    el.innerHTML = won
      ? '⚔ 战斗胜利<br><span style="font-size:14px;font-weight:normal">继续探索洞窟...</span>'
      : '☠ 战斗失败<br><span style="font-size:14px;font-weight:normal">冒险结束...</span>';
    container.appendChild(el);
    setTimeout(() => el.remove(), 2400);
    return;
  }
  // M6：嵌入冒险时显示跳转提示
  if (S.encounterContext) {
    el.innerHTML = won
      ? '⚔ 战斗胜利<br><span style="font-size:14px;font-weight:normal">正在返回冒险流程...</span>'
      : '☠ 战斗失败<br><span style="font-size:14px;font-weight:normal">冒险结束...</span>';
  } else {
    el.textContent = won ? '⚔ 战斗胜利' : '☠ 战斗失败';
  }
  container.appendChild(el);
  // 仅独立调试模式（无 encounterContext）下自动移除横幅
  if (!S.encounterContext) {
    setTimeout(() => el.remove(), 3500);
  }
}

/* ── 昏迷标记（Zzz 文字 + 视觉灰显）──
 * 非致命打击触发：敌人 HP 归零时强制留 1 HP + 昏迷标记
 * 区别于"倒地玩家"（downed=true 无 unconscious 标记）：昏迷敌人不会苏醒（无死亡豁免） */
export function addUnconsciousMarker(token) {
  if (!token || !token.element) return;
  if (token.unconsciousMarker) return; // 防止重复添加
  const marker = document.createElement('div');
  marker.className = 'token-unconscious-marker';
  marker.textContent = 'Zzz';
  marker.style.cssText = `
    position: absolute;
    top: -18px;
    left: 50%;
    transform: translateX(-50%);
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(0,0,0,0.75);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.5px;
    pointer-events: none;
    box-shadow: 0 0 4px rgba(0,0,0,0.6);
    z-index: 11;
    animation: zz-float 1.6s ease-in-out infinite;
  `;
  token.element.appendChild(marker);
  token.unconsciousMarker = marker;
}

export function removeUnconsciousMarker(token) {
  if (token?.unconsciousMarker) {
    token.unconsciousMarker.remove();
    token.unconsciousMarker = null;
  }
}

/** HTML 转义，防注入 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
