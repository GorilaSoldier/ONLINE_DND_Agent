"""冒险数据加载与查询"""
import json
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent.parent
ADVENTURES_DIR = BASE_DIR / "data" / "adventures"


def load_adventure_chapter(adventure_id: str, chapter_id: str) -> dict:
    """加载冒险章节的所有数据"""
    base = ADVENTURES_DIR / adventure_id
    chapter_dir = base / "chapters" / chapter_id

    def _load(path):
        if not path.exists():
            return {}
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    global_npcs = _load(base / "global" / "npcs.json")
    chapter_npcs = _load(chapter_dir / "npcs.json")

    return {
        "chapter": _load(chapter_dir / "chapter.json"),
        "locations": _load(chapter_dir / "locations.json").get("locations", {}),
        "npcs": {**global_npcs.get("npcs", {}), **chapter_npcs.get("npcs", {})},
        "items": _load(chapter_dir / "items.json").get("items", {}),
        "quests": _load(chapter_dir / "quests.json").get("quests", {}),
        "encounters": _load(chapter_dir / "encounters.json").get("encounters", {}),
        "secrets": _load(chapter_dir / "secrets.json").get("secrets", {}),
    }


def find_scene(data: dict, scene_id: str) -> dict | None:
    """在章节数据中查找场景"""
    scenes = data["chapter"].get("scenes", [])
    for s in scenes:
        if s["id"] == scene_id:
            return s
    return None


def get_location(data: dict, location_id: str) -> dict | None:
    return data["locations"].get(location_id)
