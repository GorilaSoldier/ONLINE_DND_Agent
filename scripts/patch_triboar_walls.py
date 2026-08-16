"""给三猪小径地图补上马尸两侧土墙障碍物"""
import json
from pathlib import Path

BASE = Path(__file__).parent.parent
json_path = BASE / "data" / "combat" / "maps" / "triboar-trail-ambush.json"
data = json.loads(json_path.read_text(encoding="utf-8"))

# 已有障碍转成字典，避免重复
existing = {(o["col"], o["row"]): o["kind"] for o in data["obstacles"]}

# 马尸两侧土墙（按 18×24 网格估算）
# 北侧土墙：道路在此收窄，马尸上方
for c in range(6, 13):
    existing[(c, 10)] = "wall"
for c in (6, 7, 12, 13):
    existing[(c, 11)] = "wall"

# 南侧土墙：马尸下方
for c in (6, 7, 12, 13):
    existing[(c, 15)] = "wall"
for c in range(6, 13):
    existing[(c, 16)] = "wall"

# 把图片中道路两侧、靠近马尸的零星土坡/灌木也补上
for c, r in [
    (8, 9), (9, 9), (10, 9),       # 马尸左上方延伸
    (8, 17), (9, 17), (10, 17),     # 马尸左下方延伸
    (11, 9), (12, 9),
    (11, 17), (12, 17),
]:
    existing[(c, r)] = "wall"

# 重新生成列表并排序（按 row 优先，再 col）
data["obstacles"] = [
    {"col": c, "row": r, "kind": k}
    for (c, r), k in sorted(existing.items(), key=lambda x: (x[0][1], x[0][0]))
]

json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"已更新 {json_path}")
print(f"障碍物总数: {len(data['obstacles'])}")
