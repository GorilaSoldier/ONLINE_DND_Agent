/**
 * 移动逻辑单元测试（Node.js 可直接运行）
 * 用法：node js/combat/test-movement.js
 */

import { parseMeters, metersToCells, calculateReachableCells, filterByRadius, reconstructPath, cellKey } from './movement.js';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

function assertApprox(a, b, eps = 1e-9, msg) {
  if (Math.abs(a - b) > eps) throw new Error(`ASSERT FAIL: ${msg} (${a} != ${b})`);
}

console.log('--- 移动逻辑单元测试 ---');

// 1. 米数解析
assert(parseMeters('4.5m') === 4.5, "parseMeters('4.5m')");
assert(parseMeters('9m') === 9, "parseMeters('9m')");
assert(parseMeters(6) === 6, "parseMeters(6)");

// 2. 米 -> 格
assert(metersToCells(4.5, 1.5) === 3, 'metersToCells 4.5/1.5');
assert(metersToCells(9, 1.5) === 6, 'metersToCells 9/1.5');

// 3. 简单扩散：无障碍，3 格移动力
let reachable = calculateReachableCells({ col: 2, row: 2 }, 3, new Set(), 10, 10);
assert(reachable.size > 1, '无障碍时应有多格可达');
assert(reachable.has(cellKey(2, 2)), '起点应可达');
assert(reachable.has(cellKey(5, 2)), '正右 3 格应可达');
assert(!reachable.has(cellKey(6, 2)), '正右 4 格不可达');

// 4. 障碍物阻挡：障碍物格自身不可达，封闭围墙内无法出去
const wall = new Set([cellKey(3, 2)]);
reachable = calculateReachableCells({ col: 2, row: 2 }, 5, wall, 10, 10);
assert(!reachable.has(cellKey(3, 2)), '障碍物格自身不可达');

const box = new Set();
for (let c = 0; c < 5; c++) { box.add(cellKey(c, 0)); box.add(cellKey(c, 4)); }
for (let r = 0; r < 5; r++) { box.add(cellKey(0, r)); box.add(cellKey(4, r)); }
reachable = calculateReachableCells({ col: 2, row: 2 }, 10, box, 5, 5);
assert(reachable.size === 9, '被墙围住时只能到达内部 3x3');

// 5. 斜向移动消耗：对角应走 √2
reachable = calculateReachableCells({ col: 0, row: 0 }, 2, new Set(), 10, 10);
const diag = reachable.get(cellKey(1, 1));
assertApprox(diag.cost, Math.SQRT2, 1e-9, '对角距离应为 √2');
const straight = reachable.get(cellKey(2, 0));
assertApprox(straight.cost, 2, 1e-9, '直线距离应为 2');

// 6. 圆范围过滤
reachable = calculateReachableCells({ col: 2, row: 2 }, 5, new Set(), 10, 10);
let filtered = filterByRadius(reachable, { col: 2, row: 2 }, 3);
assert(filtered.size <= reachable.size, '过滤后不应更多');
for (const info of filtered.values()) {
  const dx = info.col - 2;
  const dy = info.row - 2;
  const dist = Math.sqrt(dx * dx + dy * dy);
  assert(dist <= 3 + 1e-6, '过滤后格应在圆内');
}

// 7. 路径重建
reachable = calculateReachableCells({ col: 2, row: 2 }, 5, new Set(), 10, 10);
const path = reconstructPath(reachable, { col: 5, row: 2 });
assert(path.length === 4, '路径应包含 4 个点');
assert(path[0].col === 2 && path[0].row === 2, '路径起点正确');
assert(path[3].col === 5 && path[3].row === 2, '路径终点正确');

// 8. 三猪小径场景：Elias 在 (2,12)，移动力 3
const obstacles = new Set();
// 模拟地图边缘与岩石
for (let c = 0; c < 18; c++) {
  for (let r = 0; r < 3; r++) obstacles.add(cellKey(c, r));
  for (let r = 21; r < 24; r++) obstacles.add(cellKey(c, r));
}
for (let r = 0; r < 24; r++) {
  obstacles.add(cellKey(0, r));
  obstacles.add(cellKey(1, r));
  obstacles.add(cellKey(16, r));
  obstacles.add(cellKey(17, r));
}
obstacles.add(cellKey(2, 7)); obstacles.add(cellKey(2, 8)); obstacles.add(cellKey(2, 9));
obstacles.add(cellKey(3, 7)); obstacles.add(cellKey(3, 8)); obstacles.add(cellKey(3, 9));
obstacles.add(cellKey(4, 8)); obstacles.add(cellKey(4, 9));

reachable = calculateReachableCells({ col: 2, row: 12 }, 3, obstacles, 18, 24);
filtered = filterByRadius(reachable, { col: 2, row: 12 }, 3);
console.log('三猪小径 Elias 可达格数:', filtered.size);
assert(filtered.size >= 10, 'Elias 应有不少于 10 格可达');
assert(!filtered.has(cellKey(1, 12)), '左侧树不可达');
assert(filtered.has(cellKey(3, 12)), '右侧道路应可达');

console.log('✅ 所有移动逻辑单元测试通过');
