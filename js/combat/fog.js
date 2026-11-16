/**
 * 探索迷雾（Fog of War，2026-09-12 定稿，见文字冒险方案 11.4）
 * 职责：视野计算（半径圆 + 障碍遮挡 + 视线高度）、两态揭示渲染（黑幕/永久亮）、
 *       固定环境光源揭示、雾中敌人隐藏、攻击即现身、先攻条/播报的雾中名称掩码
 * 规则：
 *   - 地图 JSON 有 fog_zones 才启用；无迷雾地图所有函数均为无害空操作
 *   - 揭示 = 以玩家/队友所在格为原点、Chebyshev 距离 ≤ 视野半径的格子 + 视线判定（障碍 + 高度）
 *   - 视野半径：无黑暗视觉 0 格（5e RAW：纯黑暗中目盲，需光源）/ 种族黑暗视觉（按角色卡 darkvision 米数 ÷ 1.5 换算：6m → 4 格、9m → 6 格）/ 已装备火把·提灯 4 格（取最大）
 *   - 视线高度（2026-10-27）：观察者眼高 = 所在格 z + 1 层，目标点 = 目标格 z + 目标高度层；
 *     沿途格若地形 z 高于连线插值高度（+容差）则遮挡——「从高往低必看得见、从低往高看被崖壁挡住」
 *   - 抬头上限（2026-10-29）：目标格比观察者高超过 5 层（7.5m）→ 一律判不可见，
 *     避免谷底把高台崖沿格当作"可见顶面"而漏光；等高/向下视线不受限
 *   - 固定光源（地图 JSON light_sources，半径 4 格）+ 单位携带光源（已装备火把/提灯）：
 *     统一按同一套规则揭示「光源看得见 + 观察者也看得见」的格子；
 *     光源格自身不受半径限制，观察者只要有视线（朝火焰高度）就能看到远处火光（引导线索）；
 *     携带光源同样"发光即暴露"——敌人举灯也会被玩家看到
 *   - 两态：未揭示 = 黑幕；已揭示 = 永久亮（会话内存，刷新重置）
 *   - 雾中敌人不渲染/不进先攻条（?占位）/不播报；敌人攻击即现身（5e：unseen attacker reveals on attack）
 */

import { combatState } from './state.js';
import { cellKey } from './movement.js';
import {
  CELL_METERS, VISION_RADIUS_NORMAL, SIGHT_BLOCKING_KINDS,
  EYE_HEIGHT_LAYERS, LIGHT_FLAME_HEIGHT_LAYERS, SIGHT_HEIGHT_TOLERANCE, FIXED_LIGHT_RADIUS_CELLS,
  MAX_UPWARD_SIGHT_LAYERS,
} from './constants.js';
import { getCellZ } from './map.js';
import { computeEquipmentEffects } from '../character/equipment-effects.js';

const S = combatState;

/* ────────── 视野半径 ────────── */

/** 种族黑暗视觉距离（米）：角色创建时按种族写入 background.attributes.darkvision（"0" = 无） */
function darkvisionMeters(token) {
  const dv = String(token.data.character?.background?.attributes?.darkvision ?? '0').trim();
  const m = parseFloat(dv);
  return Number.isFinite(m) && m > 0 ? m : 0;
}

/** 角色 token 的视野半径（格）：种族黑暗视觉（米 ÷ 1.5）与已装备光源照明取最大
 *  （光源部分统一走 js/character/equipment-effects.js，需装备才生效） */
export function getVisionRadiusCells(token) {
  const dvMeters = darkvisionMeters(token);
  const dvCells = dvMeters > 0 ? Math.round(dvMeters / CELL_METERS) : VISION_RADIUS_NORMAL;
  const { lightRadiusCells } = computeEquipmentEffects(token.data.character, S.equipmentCatalog);
  return Math.max(dvCells, lightRadiusCells);
}

/* ────────── 视线判定 ────────── */

/** Bresenham 直线沿途格子（含起终点），与 main.js 跳跃路径同算法 */
function bresenhamLine(x0, y0, x1, y1) {
  const cells = [];
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cells.push({ col: x0, row: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return cells;
}

/**
 * 视线是否通畅（障碍 + 高度）
 * @param {number} targetHeightLayers 目标点在目标格 z 层之上的高度（0 = 目标格地面；看 token 传 EYE_HEIGHT_LAYERS）
 * @param {number} sourceHeightLayers 观察点在起点格 z 层之上的高度（默认眼高）
 * 沿途格：挡视线障碍（墙/树/岩石，视为无限高）直接遮挡；地形 z 高于连线插值高度 + 容差也遮挡
 */
export function hasLineOfSight(col0, row0, col1, row1,
  targetHeightLayers = 0, sourceHeightLayers = EYE_HEIGHT_LAYERS) {
  const fromGroundZ = getCellZ(S.mapConfig, col0, row0);
  const toGroundZ = getCellZ(S.mapConfig, col1, row1);
  // 抬头上限：目标格比观察者高 >5 层 → 只看到崖壁，看不到顶面（等高/向下不受限）
  if (toGroundZ - fromGroundZ > MAX_UPWARD_SIGHT_LAYERS) return false;
  const path = bresenhamLine(col0, row0, col1, row1);
  const total = path.length - 1;
  const fromZ = fromGroundZ + sourceHeightLayers;
  const toZ = toGroundZ + targetHeightLayers;
  // 斜角（墙角）规则：对角一步跨过时，两侧正交格【都】是挡视线地形才判遮挡（宽松口径）。
  // 只一侧挡 → 视为从墙角缝隙探身可见，与"斜着看到敌人可打"一致。
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (a.col !== b.col && a.row !== b.row) {
      if (S.fog.sightBlockSet.has(cellKey(b.col, a.row)) &&
          S.fog.sightBlockSet.has(cellKey(a.col, b.row))) return false;
    }
  }
  for (let i = 1; i < path.length - 1; i++) {
    const { col, row } = path[i];
    if (S.fog.sightBlockSet.has(cellKey(col, row))) return false;
    const lineZ = fromZ + (toZ - fromZ) * (i / total);
    if (getCellZ(S.mapConfig, col, row) > lineZ + SIGHT_HEIGHT_TOLERANCE) return false;
  }
  return true;
}

/* ────────── 初始化与渲染 ────────── */

/** 战斗地图渲染后调用：按地图 JSON 建立 fog_zones，挂最上层黑幕 canvas（可重复调用，幂等） */
export function initFog(mapConfig, container) {
  const zones = mapConfig.fog_zones || [];
  S.fog.enabled = zones.length > 0;
  S.fog.zoneSet = new Set(zones.map(z => cellKey(z.col, z.row)));
  S.fog.sightBlockSet = new Set(
    (mapConfig.obstacles || [])
      .filter(o => SIGHT_BLOCKING_KINDS.has(o.kind))
      .map(o => cellKey(o.col, o.row))
  );
  if (S.fog.layer) { S.fog.layer.remove(); S.fog.layer = null; }
  if (!S.fog.enabled) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'fog-layer';
  canvas.width = mapConfig.widthPx;
  canvas.height = mapConfig.heightPx;
  canvas.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 30;';
  container.appendChild(canvas);
  S.fog.layer = canvas;
  redrawFog();
  updateTokenVisibility();
}

/** 重绘黑幕：迷雾区内未揭示的格涂黑（两态，无中间暗态） */
export function redrawFog() {
  if (!S.fog.enabled || !S.fog.layer || !S.mapConfig) return;
  const ctx = S.fog.layer.getContext('2d');
  const cellW = S.mapConfig.widthPx / S.mapConfig.grid_cols;
  const cellH = S.mapConfig.heightPx / S.mapConfig.grid_rows;
  ctx.clearRect(0, 0, S.fog.layer.width, S.fog.layer.height);
  ctx.fillStyle = 'rgba(8, 6, 4, 0.98)';
  for (const key of S.fog.zoneSet) {
    if (S.fog.revealed.has(key)) continue;
    const [col, row] = key.split(',').map(Number);
    ctx.fillRect(col * cellW, row * cellH, cellW + 0.5, cellH + 0.5); // +0.5 补抗锯齿缝隙
  }
}

/* ────────── 揭示 ────────── */

/**
 * 光源集合：地图固定光源（半径 4 格）+ 存活单位已装备的火把/提灯（半径取装备库）
 * 携带光源与固定光源语义一致：既照亮周围，也是一处"可被看见的火光"
 */
function collectLights() {
  const lights = (S.mapConfig?.light_sources || [])
    .map(l => ({ col: l.col, row: l.row, radius: FIXED_LIGHT_RADIUS_CELLS }));
  for (const t of S.tokens) {
    if (t.data.dead) continue;
    const { lightRadiusCells } = computeEquipmentEffects(t.data.character, S.equipmentCatalog);
    if (lightRadiusCells > 0) lights.push({ col: t.data.col, row: t.data.row, radius: lightRadiusCells });
  }
  return lights;
}

/**
 * 光源揭示：照亮半径内「光源看得见 + 观察者也看得见」的格；
 * 光源格自身不受半径限制（远处火光可作引导线索，只要观察者视线能看到火焰高度）
 */
function revealLights(lights, viewers) {
  if (!lights.length || !viewers.length) return;
  for (const light of lights) {
    const { col, row, radius } = light;
    const srcKey = cellKey(col, row);
    for (let c = col - radius; c <= col + radius; c++) {
      for (let r = row - radius; r <= row + radius; r++) {
        if (c < 0 || r < 0 || c >= S.mapConfig.grid_cols || r >= S.mapConfig.grid_rows) continue;
        if (c === col && r === row) continue; // 光源格单独判定
        const key = cellKey(c, r);
        if (!S.fog.zoneSet.has(key)) continue;
        if (!hasLineOfSight(col, row, c, r, 0, LIGHT_FLAME_HEIGHT_LAYERS)) continue; // 光照得到
        if (!viewers.some(v => hasLineOfSight(v.data.col, v.data.row, c, r, EYE_HEIGHT_LAYERS))) continue; // 玩家看得到
        S.fog.revealed.add(key);
      }
    }
    if (S.fog.zoneSet.has(srcKey) &&
        viewers.some(v => hasLineOfSight(v.data.col, v.data.row, col, row, LIGHT_FLAME_HEIGHT_LAYERS))) {
      S.fog.revealed.add(srcKey);
    }
  }
}

/** 以所有存活玩家/队友 token 为光源计算视野并集 + 环境/携带光源，揭示并刷新渲染（移动后调用） */
export function revealAround() {
  if (!S.fog.enabled) return;
  const viewers = S.tokens.filter(t =>
    (t.data.faction === 'player' || t.data.faction === 'ally') && !t.data.dead);
  for (const v of viewers) {
    const radius = Math.ceil(getVisionRadiusCells(v));
    const { col, row } = v.data;
    for (let c = col - radius; c <= col + radius; c++) {
      for (let r = row - radius; r <= row + radius; r++) {
        if (c < 0 || r < 0 || c >= S.mapConfig.grid_cols || r >= S.mapConfig.grid_rows) continue;
        if (hasLineOfSight(col, row, c, r, EYE_HEIGHT_LAYERS)) S.fog.revealed.add(cellKey(c, r));
      }
    }
  }
  revealLights(collectLights(), viewers);
  redrawFog();
  updateTokenVisibility();
}

/** 攻击即现身（5e：unseen attacker reveals on attack）：敌人攻击结算前调用 */
export function revealAttacker(enemy) {
  if (!S.fog.enabled || !enemy) return;
  S.fog.revealed.add(cellKey(enemy.data.col, enemy.data.row));
  redrawFog();
  updateTokenVisibility();
}

/* ────────── 可见性与名称掩码 ────────── */

/** token 是否对玩家可见：玩家/队友恒可见；敌人按所在格是否已揭示 */
export function isTokenVisible(token) {
  if (!S.fog.enabled) return true;
  if (token.data.faction === 'player' || token.data.faction === 'ally') return true;
  return S.fog.revealed.has(cellKey(token.data.col, token.data.row));
}

/** 隐藏雾中敌人 token（所在格已揭示则显示）；玩家/队友恒显示 */
export function updateTokenVisibility() {
  if (!S.fog.enabled) return;
  for (const t of S.tokens) {
    // 注意：不能用 '' 还原——那会清掉 createToken 写入的 inline display:flex，导致 token 圆圈失去居中
    t.element.style.display = isTokenVisible(t) ? 'flex' : 'none';
  }
}

/** 雾中播报掩码：未现身敌人的名字以"黑暗中的存在"代替（先攻条/状态栏/日志共用） */
export function fogDisplayName(token) {
  if (!token) return '???';
  return isTokenVisible(token) ? token.data.name : '黑暗中的存在';
}
