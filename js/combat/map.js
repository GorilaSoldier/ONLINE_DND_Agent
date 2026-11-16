/**
 * 地图渲染、坐标转换、高亮层
 */

export async function loadMapConfig(mapId) {
  const res = await fetch(`/data/combat/maps/${mapId}.json`);
  if (!res.ok) throw new Error(`加载地图配置失败: ${res.status}`);
  return await res.json();
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`加载图片失败: ${src}`));
    img.src = src;
  });
}

/**
 * 根据容器和图片尺寸，计算地图应占的像素大小（保持比例，尽量撑满）
 */
export function computeMapDimensions(naturalWidth, naturalHeight, containerWidth, containerHeight) {
  const imageRatio = naturalWidth / naturalHeight;
  const containerRatio = containerWidth / containerHeight;

  let widthPx, heightPx;
  if (containerRatio > imageRatio) {
    heightPx = containerHeight;
    widthPx = heightPx * imageRatio;
  } else {
    widthPx = containerWidth;
    heightPx = widthPx / imageRatio;
  }
  return { widthPx, heightPx };
}

export function pixelToCell(mapConfig, x, y) {
  const cellW = mapConfig.widthPx / mapConfig.grid_cols;
  const cellH = mapConfig.heightPx / mapConfig.grid_rows;
  return {
    col: Math.floor(x / cellW),
    row: Math.floor(y / cellH),
  };
}

export function cellToPixel(mapConfig, col, row) {
  const cellW = mapConfig.widthPx / mapConfig.grid_cols;
  const cellH = mapConfig.heightPx / mapConfig.grid_rows;
  return {
    x: col * cellW + cellW / 2,
    y: row * cellH + cellH / 2,
  };
}

export function cellRect(mapConfig, col, row) {
  const cellW = mapConfig.widthPx / mapConfig.grid_cols;
  const cellH = mapConfig.heightPx / mapConfig.grid_rows;
  return {
    x: col * cellW,
    y: row * cellH,
    w: cellW,
    h: cellH,
  };
}

function buildObstacleSet(obstacles) {
  const set = new Set();
  for (const obs of obstacles || []) {
    set.add(`${obs.col},${obs.row}`);
  }
  return set;
}

/** 高度表：地图 JSON heights（[{col,row,z}]）→ Map("col,row" → z 层)；无记录视为 0（地面） */
function buildHeightMap(heights) {
  const map = new Map();
  for (const h of heights || []) {
    if (h && Number(h.z)) map.set(`${h.col},${h.row}`, Number(h.z));
  }
  return map;
}

/** 读取某格的 z 层（层=格，1 层=1.5m；无记录 = 0 地面）。垂直移动判定见 §7.3 */
export function getCellZ(mapConfig, col, row) {
  return mapConfig?.heightMap?.get(`${col},${row}`) || 0;
}

/* ── 高度可视化：台地淡色底 + 崖壁边线 + 区域 z 角标（可开关） ── */

let heightOverlayVisible = true;

/** 切换高度可视化层显示（战斗界面「高度」开关） */
export function setHeightOverlayVisible(visible) {
  heightOverlayVisible = visible !== false;
  const layer = document.querySelector('.height-layer');
  if (layer) layer.style.display = heightOverlayVisible ? '' : 'none';
}

/** 同层连通区域：每个台地只放一个 z 角标，避免逐格铺满 */
function collectHeightRegions(mapConfig) {
  const hm = mapConfig.heightMap;
  if (!hm) return [];
  const seen = new Set();
  const regions = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [startKey, z] of hm) {
    if (z <= 0 || seen.has(startKey)) continue;
    const stack = [startKey];
    const cells = [];
    seen.add(startKey);
    while (stack.length) {
      const key = stack.pop();
      const [col, row] = key.split(',').map(Number);
      cells.push({ col, row });
      for (const [dc, dr] of dirs) {
        const nk = `${col + dc},${row + dr}`;
        if (seen.has(nk) || hm.get(nk) !== z) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
    regions.push({ z, cells });
  }
  return regions;
}

/** 绘制高度层。崖壁边 = 与 4 向相邻格落差 ≥2 的一侧 */
function renderHeightOverlay(layer, mapConfig, cellW, cellH) {
  const hm = mapConfig.heightMap;
  if (!hm || hm.size === 0) return;

  // 台地淡色底（很淡，不遮背景图）
  for (const [key, z] of hm) {
    if (z <= 0) continue;
    const [col, row] = key.split(',').map(Number);
    const tint = document.createElement('div');
    tint.style.cssText = `
      position: absolute;
      left: ${col * cellW}px;
      top: ${row * cellH}px;
      width: ${cellW}px;
      height: ${cellH}px;
      background: rgba(255, 214, 140, 0.07);
    `;
    layer.appendChild(tint);
  }

  // 崖壁边线
  const edges = [
    { dc: 1, dr: 0, x: cellW - 1.5, y: 0, w: 3, h: cellH },
    { dc: -1, dr: 0, x: -1.5, y: 0, w: 3, h: cellH },
    { dc: 0, dr: 1, x: 0, y: cellH - 1.5, w: cellW, h: 3 },
    { dc: 0, dr: -1, x: 0, y: -1.5, w: cellW, h: 3 },
  ];
  for (const [key, z] of hm) {
    if (z <= 0) continue;
    const [col, row] = key.split(',').map(Number);
    for (const e of edges) {
      const nc = col + e.dc, nr = row + e.dr;
      if (nc < 0 || nc >= mapConfig.grid_cols || nr < 0 || nr >= mapConfig.grid_rows) continue;
      if (z - getCellZ(mapConfig, nc, nr) < 2) continue;
      const line = document.createElement('div');
      line.style.cssText = `
        position: absolute;
        left: ${col * cellW + e.x}px;
        top: ${row * cellH + e.y}px;
        width: ${e.w}px;
        height: ${e.h}px;
        background: rgba(255, 214, 140, 0.85);
        box-shadow: 0 0 6px rgba(255, 214, 140, 0.55);
      `;
      layer.appendChild(line);
    }
  }

  // 区域 z 角标（区域几何中心）
  for (const region of collectHeightRegions(mapConfig)) {
    const cx = region.cells.reduce((s, c) => s + c.col, 0) / region.cells.length;
    const cy = region.cells.reduce((s, c) => s + c.row, 0) / region.cells.length;
    const chip = document.createElement('div');
    chip.textContent = `z=${region.z}`;
    chip.style.cssText = `
      position: absolute;
      left: ${(cx + 0.5) * cellW}px;
      top: ${(cy + 0.5) * cellH}px;
      transform: translate(-50%, -50%);
      padding: 1px 5px;
      font-size: ${Math.max(9, Math.min(12, cellW * 0.28))}px;
      font-weight: 700;
      color: #f6e6c8;
      background: rgba(61, 43, 31, 0.72);
      border: 1px solid rgba(255, 214, 140, 0.7);
      border-radius: 4px;
      white-space: nowrap;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    `;
    layer.appendChild(chip);
  }
}

export function renderMap(container, mapConfig, widthPx, heightPx) {
  mapConfig.widthPx = widthPx;
  mapConfig.heightPx = heightPx;
  mapConfig.obstacleSet = buildObstacleSet(mapConfig.obstacles);
  mapConfig.heightMap = buildHeightMap(mapConfig.heights);

  container.innerHTML = '';
  container.style.cssText = `
    position: relative;
    width: ${widthPx}px;
    height: ${heightPx}px;
    margin: 0 auto;
    background-image: url('${mapConfig.image}');
    background-size: 100% 100%;
    background-position: center;
    background-repeat: no-repeat;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(61, 43, 31, 0.25);
  `;

  // 网格线
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.cssText = 'position: absolute; top: 0; left: 0; pointer-events: none; z-index: 1;';

  const cellW = widthPx / mapConfig.grid_cols;
  const cellH = heightPx / mapConfig.grid_rows;

  for (let c = 0; c <= mapConfig.grid_cols; c++) {
    const x = c * cellW;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', 0);
    line.setAttribute('x2', x);
    line.setAttribute('y2', heightPx);
    line.setAttribute('stroke', 'rgba(61, 43, 31, 0.35)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }

  for (let r = 0; r <= mapConfig.grid_rows; r++) {
    const y = r * cellH;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', 0);
    line.setAttribute('y1', y);
    line.setAttribute('x2', widthPx);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', 'rgba(61, 43, 31, 0.35)');
    line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  }

  container.appendChild(svg);

  // 坐标标注层
  const coordLayer = document.createElement('div');
  coordLayer.className = 'coord-layer';
  coordLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;';

  const labelFontSize = Math.max(9, Math.min(12, cellW * 0.35));
  const labelW = Math.min(22, cellW * 0.6);
  const labelH = Math.min(18, cellH * 0.55);

  for (let c = 0; c < mapConfig.grid_cols; c++) {
    const label = document.createElement('div');
    label.textContent = c;
    label.style.cssText = `
      position: absolute;
      left: ${c * cellW + 2}px;
      top: 2px;
      width: ${cellW - 4}px;
      height: ${labelH}px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: ${labelFontSize}px;
      font-weight: 600;
      color: rgba(250, 246, 238, 0.9);
      background: rgba(61, 43, 31, 0.55);
      border-radius: 3px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.4);
    `;
    coordLayer.appendChild(label);
  }

  for (let r = 0; r < mapConfig.grid_rows; r++) {
    const label = document.createElement('div');
    label.textContent = r;
    label.style.cssText = `
      position: absolute;
      left: 2px;
      top: ${r * cellH + 2}px;
      width: ${labelW}px;
      height: ${cellH - 4}px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: ${labelFontSize}px;
      font-weight: 600;
      color: rgba(250, 246, 238, 0.9);
      background: rgba(61, 43, 31, 0.55);
      border-radius: 3px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.4);
    `;
    coordLayer.appendChild(label);
  }

  container.appendChild(coordLayer);

  // 障碍物标记层
  const obstacleLayer = document.createElement('div');
  obstacleLayer.className = 'obstacle-layer';
  obstacleLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2;';
  for (const obs of mapConfig.obstacles || []) {
    const rect = cellRect(mapConfig, obs.col, obs.row);
    const marker = document.createElement('div');
    marker.style.cssText = `
      position: absolute;
      left: ${rect.x}px;
      top: ${rect.y}px;
      width: ${rect.w}px;
      height: ${rect.h}px;
      background: rgba(61, 43, 31, 0.18);
      border: 1px dashed rgba(61, 43, 31, 0.35);
    `;
    obstacleLayer.appendChild(marker);
  }
  container.appendChild(obstacleLayer);

  // 高度可视化层（台地淡色底 + 崖壁边线 + z 角标；z-index 同障碍层，靠 DOM 顺序覆盖其上）
  const heightLayer = document.createElement('div');
  heightLayer.className = 'height-layer';
  heightLayer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2;
    ${heightOverlayVisible ? '' : 'display: none;'}
  `;
  renderHeightOverlay(heightLayer, mapConfig, cellW, cellH);
  container.appendChild(heightLayer);

  // 高亮层
  const highlightLayer = document.createElement('div');
  highlightLayer.className = 'highlight-layer';
  highlightLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 3;';
  container.appendChild(highlightLayer);

  // Token 层
  const tokenLayer = document.createElement('div');
  tokenLayer.className = 'token-layer';
  tokenLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 4;';
  container.appendChild(tokenLayer);

  return { highlightLayer, tokenLayer };
}

export function highlightCells(highlightLayer, cells, mapConfig) {
  clearHighlights(highlightLayer);
  for (const info of cells.values()) {
    const rect = cellRect(mapConfig, info.col, info.row);
    const div = document.createElement('div');
    div.className = 'cell-highlight';
    div.dataset.col = info.col;
    div.dataset.row = info.row;
    div.style.cssText = `
      position: absolute;
      left: ${rect.x}px;
      top: ${rect.y}px;
      width: ${rect.w}px;
      height: ${rect.h}px;
      background: rgba(74, 144, 217, 0.28);
      border: 1px solid rgba(74, 144, 217, 0.45);
      cursor: pointer;
      pointer-events: auto;
      transition: background 0.12s ease;
    `;
    div.addEventListener('mouseenter', () => {
      div.style.background = 'rgba(74, 144, 217, 0.42)';
    });
    div.addEventListener('mouseleave', () => {
      div.style.background = 'rgba(74, 144, 217, 0.28)';
    });
    highlightLayer.appendChild(div);
  }
}

export function clearHighlights(highlightLayer) {
  highlightLayer.innerHTML = '';
}

export function getHighlightAt(highlightLayer, col, row) {
  return highlightLayer.querySelector(`.cell-highlight[data-col="${col}"][data-row="${row}"]`);
}

// 伤害飘字动画（注入一次）
(function ensureFloatKeyframes() {
  if (document.getElementById('combat-float-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'combat-float-keyframes';
  style.textContent = `
    @keyframes floatUp {
      0%   { opacity: 1; transform: translate(-50%, -20%); }
      70%  { opacity: 1; }
      100% { opacity: 0; transform: translate(-50%, -160%); }
    }
  `;
  document.head.appendChild(style);
})();
