"""冒险数据加载、查询与运行时状态管理"""
import json
import uuid
import copy
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent.parent
ADVENTURES_DIR = BASE_DIR / "data" / "adventures"

# 内存会话存储（开发阶段使用，后续可替换为持久化存储）
_sessions: dict = {}


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


def load_chapter_summary(adventure_id: str, chapter_id: str) -> str:
    """加载章节摘要文本"""
    path = ADVENTURES_DIR / adventure_id / "chapters" / chapter_id / "summary.md"
    if not path.exists():
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read()


def find_scene(data: dict, scene_id: str) -> dict | None:
    """在章节数据中查找场景"""
    scenes = data["chapter"].get("scenes", [])
    for s in scenes:
        if s["id"] == scene_id:
            return s
    return None


def get_location(data: dict, location_id: str) -> dict | None:
    return data["locations"].get(location_id)


class GameState:
    """运行时游戏状态"""

    def __init__(self, adventure_id: str, chapter_id: str, data: dict, scene: dict):
        self.adventure_id = adventure_id
        self.chapter_id = chapter_id
        self.data = data
        self.scene = scene
        self.location_id = scene.get("location") if scene else None
        self.npc_states = {}
        self.location_states = {}
        self.player_inventory = []
        self.quest_states = {}
        self.game_time = 0
        self.history = []
        self.pending_events = []

    def to_client_updates(self) -> dict:
        """返回给前端的状态更新"""
        return {
            "scene_id": self.scene.get("id") if self.scene else None,
            "location_id": self.location_id,
            "npc_states": self.npc_states,
            "player_inventory": self.player_inventory,
            "quest_states": self.quest_states,
            "game_time": self.game_time,
        }

    def add_history(self, role: str, content: str):
        self.history.append({"role": role, "content": content, "time": self.game_time})
        # 只保留最近 20 轮
        if len(self.history) > 40:
            self.history = self.history[-40:]

    def get_context_npcs(self) -> list:
        """获取当前场景在场的 NPC 完整数据"""
        npc_ids = self.scene.get("npcs", []) if self.scene else []
        result = []
        for nid in npc_ids:
            npc = self.data["npcs"].get(nid)
            if npc:
                npc_copy = copy.deepcopy(npc)
                npc_copy["id"] = nid
                npc_copy["current_status"] = self.npc_states.get(nid, {})
                result.append(npc_copy)
        return result

    def get_context_items(self) -> list:
        """获取当前地点可见物品（visible=true）"""
        if not self.location_id:
            return []
        loc = get_location(self.data, self.location_id)
        if not loc:
            return []

        item_entries = loc.get("items", [])
        result = []
        for entry in item_entries:
            if isinstance(entry, str):
                iid = entry
                visible = True  # 字符串形式默认可见
            else:
                iid = entry.get("id")
                visible = entry.get("visible", True)
            item = self.data["items"].get(iid)
            if item and visible:
                item_copy = copy.deepcopy(item)
                item_copy["id"] = iid
                result.append(item_copy)
        return result


def get_or_create_session(
    session_id: str | None,
    adventure_id: str,
    chapter_id: str,
) -> tuple[str, GameState]:
    """获取或创建会话"""
    if session_id and session_id in _sessions:
        return session_id, _sessions[session_id]

    data = load_adventure_chapter(adventure_id, chapter_id)
    starting_scene_id = data["chapter"].get("starting_scene")
    scene = find_scene(data, starting_scene_id) if starting_scene_id else None

    new_id = session_id or str(uuid.uuid4())
    state = GameState(adventure_id, chapter_id, data, scene)
    _sessions[new_id] = state
    return new_id, state
