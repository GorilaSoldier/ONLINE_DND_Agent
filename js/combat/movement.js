/**
 * 战斗地图移动系统
 * - 八方向移动，欧氏距离消耗
 * - 障碍物阻挡（Dijkstra 扩散）
 * - 圆范围过滤
 * - 垂直移动（跳跃/攀爬）判定，规格见 Plan《模块1-战斗地图系统设计方案》§7.3
 */

import { CELL_METERS } from './constants.js';

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
    { col: -1, row: -1, cost: 1.5 }, // 左上（斜走=1.5格，替代 √2）
    { col: 1, row: -1, cost: 1.5 },  // 右上
    { col: -1, row: 1, cost: 1.5 },  // 左下
    { col: 1, row: 1, cost: 1.5 },   // 右下
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

/* ── 垂直移动（§7.3）：跳跃距离/高度、登高判定 ── */

/**
 * BG3 跳远半径（格，水平）：基础 4.5m，每 2 点力量超过 10 加 1m。
 * 力量 8~11 → 4.5m(3.0 格)；12~13 → 5.5m；14~15 → 6.5m；…；20~21 → 9.5m(6.3 格)
 * @param {number} strScore 力量总值
 */
export function jumpDistanceCells(strScore) {
  const str = Number(strScore) || 10;
  const bonus = Math.floor((str - 10) / 2);      // 每 2 点力量 +1m
  const meters = 4.5 + Math.max(0, bonus);       // 力量 ≤ 10 不缩水，下限 4.5m
  return meters / CELL_METERS;
}

/**
 * 5e 跳高（格，向上）：(3 + 力量调整值) 尺 → 换算为格后四舍五入。
 * 力量 10 → 3 尺(0.91m) → 1 格；力量 20 → 8 尺(2.44m) → 2 格
 * @param {number} strScore 力量总值
 */
export function jumpHeightCells(strScore) {
  const str = Number(strScore) || 10;
  const mod = Math.floor((str - 10) / 2);        // 力量调整值
  const feet = Math.max(0, 3 + mod);             // 不足 3 尺按 0 计
  return Math.round((feet * 0.3048) / CELL_METERS);
}

/**
 * 登高判定：由「起落 z 层差」推出该次垂直移动属于走/跳/爬。
 *   起落 z 单位为「层」（1 层 = 1 格 = 1.5m，见 §7.3）。
 * @param {number} fromZ 起点 z 层
 * @param {number} toZ   落点 z 层
 * @param {number} jumpHeight 该生物的跳高（格，来自 jumpHeightCells）
 * @returns {{kind:'walk'|'jump'|'climb', extraCostCells:number}}
 *   - Δz ≤ 0            → walk（平走/下坠，重力，无额外消耗；下坠伤害另算）
 *   - 0 < Δz ≤ jumpHeight → jump（跳，无额外消耗）
 *   - Δz > jumpHeight   → climb（攀爬，额外消耗 = Δz × 2 格：5e 每爬 1 尺花 2 尺）
 */
export function resolveVerticalStep(fromZ, toZ, jumpHeight) {
  const dz = (Number(toZ) || 0) - (Number(fromZ) || 0);
  if (dz <= 0) return { kind: 'walk', extraCostCells: 0 };
  if (dz <= jumpHeight) return { kind: 'jump', extraCostCells: 0 };
  return { kind: 'climb', extraCostCells: dz * 2 };
}
