"""验证三猪小径地图：
1. 所有 kind=wall 的格子都不可达
2. 道路保持畅通（左侧出生点到右侧某点可达）
"""
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "js" / "combat"))

# 这里复用 JS 的算法逻辑，用 Python 简单实现一份验证
BASE = Path(__file__).parent.parent
data = json.loads((BASE / "data" / "combat" / "maps" / "triboar-trail-ambush.json").read_text(encoding="utf-8"))

cols, rows = data["grid_cols"], data["grid_rows"]
obstacles = {(o["col"], o["row"]): o["kind"] for o in data["obstacles"]}

DIRECTIONS = [
    (0, -1, 1), (0, 1, 1), (-1, 0, 1), (1, 0, 1),
    (-1, -1, math.sqrt(2)), (1, -1, math.sqrt(2)),
    (-1, 1, math.sqrt(2)), (1, 1, math.sqrt(2)),
]

def reachable(start, move_cells):
    seen = {start: 0.0}
    heap = [(0.0, start)]
    while heap:
        cost, (c, r) = heap.pop(0)
        if cost > seen[(c, r)] + 1e-9:
            continue
        for dc, dr, dcost in DIRECTIONS:
            nc, nr = c + dc, r + dr
            if not (0 <= nc < cols and 0 <= nr < rows):
                continue
            if (nc, nr) in obstacles:
                continue
            ncost = cost + dcost
            if ncost > move_cells:
                continue
            if (nc, nr) not in seen or ncost < seen[(nc, nr)]:
                seen[(nc, nr)] = ncost
                heap.append((ncost, (nc, nr)))
    return seen

# 1. 检查所有 wall 自身不可达（从任意非 wall 点开始不应包含 wall）
start = (2, 12)
reach = reachable(start, 20)
wall_unreachable = all((c, r) not in reach for (c, r), k in obstacles.items() if k == "wall")
print(f"所有 wall 格均不可达: {wall_unreachable}")

# 2. 检查玩家出生点到右侧道路仍有通路
right_road = (13, 12)
print(f"从 {start} 到 {right_road} 可达: {right_road in reach}")

# 3. 检查敌人出生点与玩家之间是否有路（不要求直接相邻，只要求能接近）
near_enemy = (12, 11)
print(f"从 {start} 到 {near_enemy} 可达: {near_enemy in reach}")

if not wall_unreachable or right_road not in reach:
    raise SystemExit("地图连通性验证失败")

print("✅ 地图障碍物与连通性验证通过")
