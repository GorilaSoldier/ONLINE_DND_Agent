/**
 * 战斗地图移动系统
 * - 八方向移动，欧氏距离消耗
 * - 障碍物阻挡（Dijkstra 扩散）
 * - 圆范围过滤
 */

export function parseMeters(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const match = value.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

export function metersToCells(meters, metersPerCell) {
  return meters / metersPerCell;
}

export function cellKey(col, row) {
  return `${col},${row}`;
}

export function euclideanDistance(a, b) {
  const dx = a.col - b.col;
  const dy = a.row - b.row;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 计算从起点出发、在移动力范围内的所有可达格子
 * @param {Object} start - {col, row}
 * @param {number} moveCells - 最大移动力（格数，可含小数如 6.0）
 * @param {Set<string>} obstacles - "col,row" 集合
 * @param {number} gridCols
 * @param {number} gridRows
 * @returns {Map<string, {col, row, cost, prev}>} 可达格子表
 */
export function calculateReachableCells(start, moveCells, obstacles, gridCols, gridRows) {
  const reachable = new Map();
  const startKey = cellKey(start.col, start.row);
  reachable.set(startKey, { col: start.col, row: start.row, cost: 0, prev: null });

  // 小顶堆优先队列（按 cost 排序）
  const heap = [{ col: start.col, row: start.row, cost: 0 }];

  const directions = [
    { col: 0, row: -1, cost: 1 },      // 上
    { col: 0, row: 1, cost: 1 },       // 下
    { col: -1, row: 0, cost: 1 },      // 左
    { col: 1, row: 0, cost: 1 },       // 右
    { col: -1, row: -1, cost: Math.SQRT2 }, // 左上
    { col: 1, row: -1, cost: Math.SQRT2 },  // 右上
    { col: -1, row: 1, cost: Math.SQRT2 },  // 左下
    { col: 1, row: 1, cost: Math.SQRT2 },   // 右下
  ];

  function heapPush(node) {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (heap[parent].cost <= heap[i].cost) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  function heapPop() {
    if (heap.length === 0) return null;
    const min = heap[0];
    const last = heap.pop();
    if (heap.length === 0) return min;
    heap[0] = last;
    let i = 0;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < heap.length && heap[left].cost < heap[smallest].cost) smallest = left;
      if (right < heap.length && heap[right].cost < heap[smallest].cost) smallest = right;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
    return min;
  }

  while (heap.length > 0) {
    const current = heapPop();
    const currentKey = cellKey(current.col, current.row);
    const currentInfo = reachable.get(currentKey);
    if (!currentInfo || current.cost > currentInfo.cost) continue;

    for (const dir of directions) {
      const nextCol = current.col + dir.col;
      const nextRow = current.row + dir.row;

      if (nextCol < 0 || nextCol >= gridCols || nextRow < 0 || nextRow >= gridRows) continue;

      const nextKey = cellKey(nextCol, nextRow);
      if (obstacles.has(nextKey)) continue;

      const nextCost = current.cost + dir.cost;
      if (nextCost > moveCells) continue;

      const existing = reachable.get(nextKey);
      if (!existing || nextCost < existing.cost) {
        reachable.set(nextKey, { col: nextCol, row: nextRow, cost: nextCost, prev: currentKey });
        heapPush({ col: nextCol, row: nextRow, cost: nextCost });
      }
    }
  }

  return reachable;
}

/**
 * 从可达表中过滤出在圆范围内的格子
 * @param {Map<string, Object>} reachable
 * @param {Object} center - {col, row}
 * @param {number} radiusCells - 半径（格数）
 */
export function filterByRadius(reachable, center, radiusCells) {
  const result = new Map();
  for (const [key, info] of reachable) {
    const dist = euclideanDistance(info, center);
    if (dist <= radiusCells + 1e-6) {
      result.set(key, info);
    }
  }
  return result;
}

/**
 * 重建从起点到目标格的最短路径
 * @param {Map<string, Object>} reachable
 * @param {Object} target - {col, row}
 * @returns {Array<{col, row}>} 路径点（包含起点和目标）
 */
export function reconstructPath(reachable, target) {
  const targetKey = cellKey(target.col, target.row);
  if (!reachable.has(targetKey)) return [];

  const path = [];
  let key = targetKey;
  while (key) {
    const info = reachable.get(key);
    path.push({ col: info.col, row: info.row });
    key = info.prev;
  }
  path.reverse();
  return path;
}

/**
 * 一次性计算并过滤移动范围
 * @param {Object} start - {col, row}
 * @param {number} moveCells - 最大移动力（格数）
 * @param {Set<string>} obstacles
 * @param {number} gridCols
 * @param {number} gridRows
 * @param {number} radiusCells - 圆半径（格数），通常等于 moveCells
 */
export function calculateMovementRange(start, moveCells, obstacles, gridCols, gridRows, radiusCells) {
  const reachable = calculateReachableCells(start, moveCells, obstacles, gridCols, gridRows);
  return filterByRadius(reachable, start, radiusCells);
}
