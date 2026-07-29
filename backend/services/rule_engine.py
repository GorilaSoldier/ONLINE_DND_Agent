"""规则引擎：校验玩家动作合法性，不替 GM 做叙事"""
import random
from services.game_state import get_location


def roll_d20(modifier: int = 0) -> dict:
    roll = random.randint(1, 20)
    return {"roll": roll, "modifier": modifier, "total": roll + modifier}


class RuleEngine:
    """规则引擎：校验玩家动作合法性，不替 GM 做叙事"""

    def __init__(self, data: dict, scene: dict):
        self.data = data
        self.scene = scene
        self.location = get_location(data, scene["location"]) if scene else None

    def process(self, player_input: str, character: dict | None = None) -> dict:
        """处理玩家输入，返回结构化结果"""
        text = player_input.strip()
        lower = text.lower()

        intent, target = self._classify(lower)

        handlers = {
            "talk": self._handle_talk,
            "move": self._handle_move,
            "advance": self._handle_advance,
            "perception": self._handle_check,
            "investigation": self._handle_check,
            "steal": self._handle_steal,
            "look": self._handle_look,
            "other": self._handle_other,
        }
        return handlers.get(intent, self._handle_other)(target, character)

    def _classify(self, lower: str) -> tuple[str, str | None]:
        """意图分类"""
        if any(kw in lower for kw in ["出发", "启程", "前进", "上路", "追踪", "跟着", "沿着"]):
            return ("advance", None)
        if any(kw in lower for kw in ["侦察", "观察", "看看周围", "环顾"]):
            return ("perception", "perception")
        if any(kw in lower for kw in ["调查", "检查", "搜查", "仔细看"]):
            return ("investigation", "investigation")
        if any(kw in lower for kw in ["偷", "顺走", "拿走", "扒"]):
            return ("steal", self._find_item(lower))
        if any(kw in lower for kw in ["去", "移动", "走", "前往", "进入"]):
            return ("move", self._find_exit(lower))
        if any(kw in lower for kw in ["交谈", "对话", "问", "说", "聊"]):
            return ("talk", self._find_npc(lower))
        if any(kw in lower for kw in ["查看", "看看", "观察"]):
            return ("look", None)
        return ("other", None)

    def _find_npc(self, lower: str) -> str | None:
        npc_ids = self.scene.get("npcs", []) if self.scene else []
        for nid in npc_ids:
            npc = self.data["npcs"].get(nid, {})
            if npc.get("name", "") and npc["name"] in lower:
                return nid
        return None

    def _find_item(self, lower: str) -> str | None:
        item_ids = self.scene.get("items", []) if self.scene else []
        for entry in item_ids:
            iid = entry if isinstance(entry, str) else entry.get("id", "")
            if not iid:
                continue
            item = self.data["items"].get(iid, {})
            if item.get("name", "") and item["name"] in lower:
                return iid
        return None

    def _find_exit(self, lower: str) -> str | None:
        free = self.scene.get("free_locations", []) if self.scene else []
        if not free and self.location:
            free = [e["target"] for e in self.location.get("exits", [])]

        if self.location:
            for exit_entry in self.location.get("exits", []):
                name = exit_entry.get("name", "")
                clean = name.replace("前往", "").replace("返回", "").replace("进入", "").strip()
                if clean and clean in lower:
                    return exit_entry["target"]

        for lid in free:
            loc = get_location(self.data, lid)
            if loc and loc.get("name", "") and loc["name"] in lower:
                return lid

        return None

    # ── 处理器 ──

    def _handle_talk(self, npc_id: str | None, character: dict | None) -> dict:
        loc_name = self.location["name"] if self.location else "此处"
        if not npc_id:
            npc_ids = self.scene.get("npcs", []) if self.scene else []
            if npc_ids:
                names = []
                for nid in npc_ids:
                    npc = self.data["npcs"].get(nid, {})
                    if npc.get("name"):
                        names.append(npc["name"])
                return {"gm_text": f"在{loc_name}，你可以与以下人交谈：{'、'.join(names)}。你想找谁？", "checks": None, "state_changes": []}
            return {"gm_text": f"{loc_name}没有可以交谈的人。", "checks": None, "state_changes": []}

        npc = self.data["npcs"].get(npc_id, {})
        if not npc:
            return {"gm_text": "这里没有那个人。", "checks": None, "state_changes": []}

        greeting = (
            npc.get("dialogue", {}).get("greeting")
            or npc.get("reactions", {}).get("combat", {}).get("opening")
            or f'"{...}" {npc["name"]} 看着你，没有说话。'
        )
        attitude = npc.get("attitude", "neutral")
        note = ""
        if attitude == "hostile":
            note = f"\n（{npc['name']} 看起来不太友善。）"
        elif attitude == "friendly":
            note = f"\n（{npc['name']} 对你露出友善的微笑。）"

        return {"gm_text": f"{greeting}{note}", "checks": None, "state_changes": []}

    def _handle_move(self, target_id: str | None, character: dict | None) -> dict:
        if not target_id:
            free = self.scene.get("free_locations", []) if self.scene else []
            exits = []
            if self.location:
                for e in self.location.get("exits", []):
                    exits.append(e["name"])
            if free and self.location["id"] in free:
                others = [lid for lid in free if lid != self.location["id"]]
                for lid in others:
                    loc = get_location(self.data, lid)
                    if loc:
                        exits.append(f"前往{loc['name']}")
            if exits:
                return {"gm_text": f"你可以去的地方：{'、'.join(exits)}。", "checks": None, "state_changes": []}
            return {"gm_text": "这里没有其他可去的地方。", "checks": None, "state_changes": []}

        target_loc = get_location(self.data, target_id)
        if not target_loc:
            return {"gm_text": "你无法到达那个地方。", "checks": None, "state_changes": []}

        free = self.scene.get("free_locations", []) if self.scene else []
        if free and target_id not in free:
            scenes = self.data["chapter"].get("scenes", [])
            target_scene = next((s for s in scenes if s["location"] == target_id), None)
            if target_scene:
                return {"gm_text": f"要前往{target_loc['name']}，你需要继续前进。输入'出发'推进剧情。", "checks": None, "state_changes": []}
            return {"gm_text": "你无法到达那个地方。", "checks": None, "state_changes": []}

        return {
            "gm_text": target_loc.get("scene_text") or target_loc.get("description", ""),
            "checks": None,
            "state_changes": [{"type": "move", "location_id": target_id}],
        }

    def _handle_advance(self, _target, character: dict | None) -> dict:
        next_id = self.scene.get("next_scene") if self.scene else None
        if not next_id:
            return {"gm_text": "前方已经没有路了。", "checks": None, "state_changes": []}

        scenes = self.data["chapter"].get("scenes", [])
        next_scene = next((s for s in scenes if s["id"] == next_id), None)
        if not next_scene:
            return {"gm_text": "无法推进剧情。", "checks": None, "state_changes": []}

        next_loc = get_location(self.data, next_scene["location"])
        return {
            "gm_text": next_loc.get("scene_text") or next_loc.get("description", "") if next_loc else next_scene.get("description", ""),
            "checks": None,
            "state_changes": [{"type": "advance_scene", "scene_id": next_id}],
        }

    def _handle_check(self, skill: str | None, character: dict | None) -> dict:
        skill_name = "侦察（感知）" if skill == "perception" else "调查（智力）"
        ability_key = "wisdom" if skill == "perception" else "intelligence"

        if not character:
            return {
                "gm_text": f"请进行{skill_name}检定。",
                "checks": [{"skill": skill, "dc": None, "reason": "请 GM 设定 DC"}],
                "state_changes": [],
            }

        score = character.get(ability_key, character.get(ability_key[:3], 10))
        mod = (score - 10) // 2
        result = roll_d20(mod)

        discovered = []
        if self.location:
            for h in self.location.get("hidden", []):
                if h.get("skill") == skill and h.get("passive", False):
                    if result["total"] >= h.get("dc", 10):
                        discovered.append(h["description"])

        dc_info = ""
        if discovered:
            dc_info = "\n\n你发现了：" + "；".join(discovered)

        return {
            "gm_text": f"{skill_name}检定：d20({result['roll']})+{mod} = {result['total']}{dc_info}",
            "checks": None,
            "state_changes": [],
        }

    def _handle_steal(self, item_id: str | None, character: dict | None) -> dict:
        if not item_id:
            return {"gm_text": "你想偷什么？请指定目标物品。", "checks": None, "state_changes": []}

        item = self.data["items"].get(item_id, {})
        if not item:
            return {"gm_text": "这里没有那个东西。", "checks": None, "state_changes": []}
        if not item.get("stealable"):
            return {"gm_text": f"{item['name']}无法被偷走。", "checks": None, "state_changes": []}

        dc = item.get("difficulty", 10)
        return {
            "gm_text": f"你试图偷走{item['name']}。请进行巧手（Sleight of Hand）检定，难度 DC {dc}。",
            "checks": [{"skill": "sleight_of_hand", "dc": dc, "reason": f"偷窃{item['name']}"}],
            "state_changes": [],
        }

    def _handle_look(self, _target, character: dict | None) -> dict:
        if not self.location:
            return {"gm_text": "你环顾四周，什么也没看到。", "checks": None, "state_changes": []}
        return {"gm_text": self.location.get("description", "你环顾四周。"), "checks": None, "state_changes": []}

    def _handle_other(self, _target, character: dict | None) -> dict:
        return {"gm_text": "你沉思片刻，等待进一步的行动。", "checks": None, "state_changes": []}
