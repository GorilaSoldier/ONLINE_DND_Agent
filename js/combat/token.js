/**
 * Token 渲染与状态管理
 */

import { parseMeters, metersToCells } from './movement.js';

const FACTION_STYLES = {
  player: { border: '#4a90d9', bg: 'linear-gradient(135deg, rgba(74, 144, 217, 0.55), rgba(42, 92, 160, 0.9))', shadow: 'rgba(74, 144, 217, 0.45)' },
  enemy: { border: '#c44b4b', bg: 'linear-gradient(135deg, rgba(196, 75, 75, 0.55), rgba(150, 45, 45, 0.9))', shadow: 'rgba(196, 75, 75, 0.45)' },
  ally: { border: '#5aa85a', bg: 'linear-gradient(135deg, rgba(90, 168, 90, 0.55), rgba(55, 120, 55, 0.9))', shadow: 'rgba(90, 168, 90, 0.45)' },
  neutral: { border: '#888888', bg: 'linear-gradient(135deg, rgba(136, 136, 136, 0.55), rgba(90, 90, 90, 0.9))', shadow: 'rgba(136, 136, 136, 0.45)' },
};

function getCellPixel(mapConfig, col, row) {
  const cellW = mapConfig.widthPx / mapConfig.grid_cols;
  const cellH = mapConfig.heightPx / mapConfig.grid_rows;
  return {
    x: col * cellW + cellW / 2,
    y: row * cellH + cellH / 2,
  };
}

export function getMoveCells(token, mapConfig) {
  const meters = parseMeters(token.moveSpeed);
  return metersToCells(meters, mapConfig.meters_per_cell);
}

export function createToken(tokenData, mapConfig) {
  const style = FACTION_STYLES[tokenData.faction] || FACTION_STYLES.neutral;
  const cellW = mapConfig.widthPx / mapConfig.grid_cols;
  const visualSize = cellW * 0.78;
  const hitSize = Math.max(cellW * 1.4, 48); // 命中区域至少 48px，覆盖大部分格子

  const el = document.createElement('div');
  el.className = 'combat-token';
  el.dataset.tokenId = tokenData.id;
  el.style.cssText = `
    position: absolute;
    width: ${hitSize}px;
    height: ${hitSize}px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    user-select: none;
    transform: translate(-50%, -50%);
    z-index: 10;
  `;

  const circle = document.createElement('div');
  circle.className = 'token-circle';
  circle.style.cssText = `
    width: ${visualSize}px;
    height: ${visualSize}px;
    border-radius: 50%;
    background: ${style.bg};
    border: 2px solid ${style.border};
    box-shadow: 0 2px 6px ${style.shadow};
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: ${Math.max(11, visualSize * 0.42)}px;
    font-weight: 700;
    color: #fff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    transition: box-shadow 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  `;

  // 类似角色卡头像：只显示一个字（优先取 portrait，否则取名字首字）
  const label = document.createElement('span');
  label.textContent = tokenData.portrait || tokenData.name.slice(0, 1);
  label.style.cssText = 'pointer-events: none; text-align: center; line-height: 1;';
  circle.appendChild(label);
  el.appendChild(circle);

  // HP 条（位于圆形下方）
  const hpBar = document.createElement('div');
  hpBar.className = 'token-hp-bar';
  hpBar.style.cssText = `
    position: absolute;
    bottom: ${Math.max(2, hitSize * 0.06)}px;
    left: 50%;
    transform: translateX(-50%);
    width: ${visualSize * 1.1}px;
    height: ${Math.max(5, hitSize * 0.13)}px;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 3px;
    overflow: hidden;
    pointer-events: none;
  `;
  const hpFill = document.createElement('div');
  hpFill.className = 'token-hp-fill';
  hpFill.style.cssText = 'height: 100%; width: 100%; background: #5cb85c; transition: width 0.25s ease;';
  hpBar.appendChild(hpFill);
  el.appendChild(hpBar);

  // HP 数字（小字，右上角）
  const hpText = document.createElement('div');
  hpText.className = 'token-hp-text';
  hpText.style.cssText = `
    position: absolute;
    top: ${Math.max(2, hitSize * 0.04)}px;
    right: ${Math.max(2, hitSize * 0.1)}px;
    font-size: ${Math.max(8, visualSize * 0.22)}px;
    font-weight: 700;
    color: #fff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  `;
  el.appendChild(hpText);

  // Lv 等级（小字，左上角）
  const lvText = document.createElement('div');
  lvText.className = 'token-lv-text';
  lvText.style.cssText = `
    position: absolute;
    top: ${Math.max(2, hitSize * 0.04)}px;
    left: ${Math.max(2, hitSize * 0.1)}px;
    font-size: ${Math.max(8, visualSize * 0.22)}px;
    font-weight: 700;
    color: #fff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  `;
  lvText.textContent = `Lv.${tokenData.level ?? 1}`;
  el.appendChild(lvText);

  const pos = getCellPixel(mapConfig, tokenData.col, tokenData.row);
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;

  return {
    id: tokenData.id,
    data: tokenData,
    element: el,
    circle,
    selected: false,
    moveSpeed: tokenData.moveSpeed,
    hpBar,
    hpFill,
    hpText,
    lvText,
  };
}

/** 更新 token HP 显示（data.hpCur / data.hpMax） */
export function updateTokenHp(token) {
  const cur = token.data.hpCur ?? 1;
  const max = token.data.hpMax ?? cur;
  const pct = Math.max(0, Math.min(100, (cur / max) * 100));
  if (token.hpFill) token.hpFill.style.width = pct + '%';
  if (token.hpText) token.hpText.textContent = `HP:${cur}`;
  token.hpFill.style.background = pct > 50 ? '#5cb85c' : pct > 20 ? '#e6a23c' : '#d9534f';
}

/**
 * 伤害/治疗飘字：在 token 位置短暂显示一条信息后消失
 * @param {Object} token 目标 token
 * @param {string} text 飘字内容（如 "-5" / "+4" / "未命中"）
 * @param {string} color 颜色
 */
export function spawnFloatingText(token, text, color = '#fff') {
  if (!token || !token.element) return;
  const el = document.createElement('div');
  el.className = 'combat-float-text';
  el.textContent = text;
  el.style.cssText = `
    position: absolute;
    left: 50%;
    top: 0;
    transform: translate(-50%, -50%);
    font-size: 15px;
    font-weight: 800;
    color: ${color};
    text-shadow: 0 1px 3px rgba(0,0,0,0.8);
    pointer-events: none;
    z-index: 20;
    animation: floatUp 1.1s ease-out forwards;
    white-space: nowrap;
  `;
  token.element.appendChild(el);
  setTimeout(() => el.remove(), 1150);
}

export function moveToken(token, col, row, mapConfig, duration = 280) {
  const pos = getCellPixel(mapConfig, col, row);
  token.element.style.transition = `left ${duration}ms ease, top ${duration}ms ease`;
  token.element.style.left = `${pos.x}px`;
  token.element.style.top = `${pos.y}px`;
  token.data.col = col;
  token.data.row = row;

  return new Promise(resolve => {
    setTimeout(() => {
      token.element.style.transition = '';
      resolve();
    }, duration);
  });
}

export function selectToken(token) {
  token.selected = true;
  token.element.classList.add('selected');
  // 选中态：仅放大 + 白色描边（按用户反馈：保持稍微放大+高亮即可，去掉光晕避免视觉干扰）
  token.circle.style.transform = 'scale(1.12)';
  token.circle.style.boxShadow = '0 0 0 3px rgba(255, 255, 255, 0.9)';
}

export function deselectToken(token) {
  token.selected = false;
  token.element.classList.remove('selected');
  token.circle.style.transform = 'scale(1)';
  token.circle.style.boxShadow = `0 2px 6px ${FACTION_STYLES[token.data.faction]?.shadow || FACTION_STYLES.neutral.shadow}`;
}

export function updateTokenPosition(token, mapConfig) {
  const pos = getCellPixel(mapConfig, token.data.col, token.data.row);
  token.element.style.left = `${pos.x}px`;
  token.element.style.top = `${pos.y}px`;
}
