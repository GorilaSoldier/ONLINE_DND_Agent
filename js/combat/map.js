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

export function renderMap(container, mapConfig, widthPx, heightPx) {
  mapConfig.widthPx = widthPx;
  mapConfig.heightPx = heightPx;
  mapConfig.obstacleSet = buildObstacleSet(mapConfig.obstacles);

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
