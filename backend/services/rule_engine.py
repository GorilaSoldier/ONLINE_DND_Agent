"""
规则引擎：接收 AI 解析后的意图，执行确定性规则，生成检定与状态变更建议。
不直接修改 GameState，只返回 state_changes 建议。
"""
import random
import logging
from typing import Dict, Any, List, Tuple, Optional

from services.ai_gm import IntentResult
from services.game_state import get_location

logger = logging.getLogger(__name__)


def roll_d20(modifier: int = 0) -> dict:
    roll = random.randint(1, 20)
    return {"roll": roll, "modifier": modifier, "total": roll + modifier}


def ability_modifier(score: int) -> int:
    return (score - 10) // 2


class RuleEngine:
    """规则引擎：执行 AI 提供的意图"""

    SKILL_ABILITY_MAP = {
        "perception": "wisdom",
        "investigation": "intelligence",
        "sleight_of_hand": "dexterity",
        "stealth": "dexterity",
        "intimidation": "charisma",
        "persuasion": "charisma",
        "deception": "charisma",
        "insight": "wisdom",
        "athletics": "strength",
        "acrobatics": "dexterity",
        "arcana": "intelligence",
        "history": "intelligence",
        "nature": "intelligence",
        "religion": "intelligence",
        "medicine": "wisdom",
        "survival": "wisdom",
        "animal_handling": "wisdom",
        "performance": "charisma",
    }

    SKILL_NAME_CN = {
        "perception": "侦察（感知）",
        "investigation": "调查（智力）",
        "sleight_of_hand": "巧手（敏捷）",
        "stealth": "隐匿（敏捷）",
        "intimidation": "威吓（魅力）",
        "persuasion": "游说（魅力）",
        "deception": "欺瞒（魅力）",
        "insight": "洞悉（感知）",
    }

    def __init__(self, data: dict, scene: dict, state: Any = None):
        self.data = data
        self.scene = scene
        self.state = state
        self.location = get_location(data, scene["location"]) if scene else None

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------
    def execute(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """
        执行意图，返回 (rule_result, state_changes)
        """
        handlers = {
            "talk": self._handle_talk,
            "move": self._handle_move,
            "advance_scene": self._handle_advance,
            "perception": self._handle_check,
            "investigation": self._handle_check,
            "steal": self._handle_steal,
            "look": self._handle_look,
            "other": self._handle_other,
        }
        handler = handlers.get(intent_result.intent, self._handle_other)
        return handler(intent_result, character)

    # ------------------------------------------------------------------
    # 目标查找
    # ------------------------------------------------------------------
    def _resolve_target(self, intent_result: IntentResult) -> Tuple[Optional[Any], str]:
        """
        根据 target_id / target_type 查找实际对象
        返回 (对象, 查找状态：found / not_found / ambiguous)
        """
        target_id = intent_result.target_id
        target_type = intent_result.target_type

        if target_type == "none" or not target_id:
            return None, "none"

        # 先按 ID 查找
        if target_type == "npc":
            npc = self.data["npcs"].get(target_id)
            if npc:
                return npc, "found"
            # 再按名字查找
            for nid, npc in self.data["npcs"].items():
                if npc.get("name") == target_id:
                    return npc, "found"
            return None, "not_found"

        elif target_type == "item":
            item = self.data["items"].get(target_id)
            if item:
                return item, "found"
            for iid, item in self.data["items"].items():
                if item.get("name") == target_id:
                    return item, "found"
            return None, "not_found"

        elif target_type == "location" or target_type == "exit":
            loc = get_location(self.data, target_id)
            if loc:
                return loc, "found"
            for lid in self._get_free_locations():
                loc = get_location(self.data, lid)
                if loc and loc.get("name") == target_id:
                    return loc, "found"
            return None, "not_found"

        return None, "not_found"

    def _get_free_locations(self) -> List[str]:
        free = self.scene.get("free_locations", []) if self.scene else []
        if self.location:
            for e in self.location.get("exits", []):
                if e["target"] not in free:
                    free.append(e["target"])
        return free

    def _is_present_npc(self, npc_id: str) -> bool:
        present = self.scene.get("npcs", []) if self.scene else []
        return npc_id in present

    def _is_present_item(self, item_id: str) -> bool:
        item_entries = self.scene.get("items", []) if self.scene else []
        for entry in item_entries:
            if isinstance(entry, str) and entry == item_id:
                return True
            if isinstance(entry, dict) and entry.get("id") == item_id:
                return True
        return False

    def _is_reachable_location(self, loc_id: str) -> bool:
        return loc_id in self._get_free_locations()

    # ------------------------------------------------------------------
    # 检定
    # ------------------------------------------------------------------
    def _roll_skill_check(self, skill: str, character: dict | None, dc: Optional[int] = None) -> dict:
        ability = self.SKILL_ABILITY_MAP.get(skill, "wisdom")
        score = 10
        if character:
            score = character.get(ability, character.get(ability[:3], 10))
        mod = ability_modifier(score)
        result = roll_d20(mod)
        result["skill"] = skill
        result["ability"] = ability
        result["dc"] = dc
        result["success"] = dc is not None and result["total"] >= dc
        return result

    # ------------------------------------------------------------------
    # 处理器
    # ------------------------------------------------------------------
    def _handle_talk(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        npc, status = self._resolve_target(intent_result)

        if status != "found" or not npc:
            npc_ids = self.scene.get("npcs", []) if self.scene else []
            if npc_ids:
                names = [self.data["npcs"].get(nid, {}).get("name", nid) for nid in npc_ids]
                loc_name = self.location["name"] if self.location else "此处"
                text = f"在{loc_name}，你可以与以下人交谈：{'、'.join(names)}。你想找谁？"
            else:
                text = "这里没有可以交谈的人。"
            return {"gm_text": text, "checks": []}, []

        npc_id = npc["id"]
        if not self._is_present_npc(npc_id):
            return {"gm_text": f"{npc['name']} 不在这里。", "checks": []}, []

        greeting = (
            npc.get("dialogue", {}).get("greeting")
            or npc.get("reactions", {}).get("combat", {}).get("opening")
            or f"{npc['name']} 看着你，没有说话。"
        )

        return {"gm_text": greeting, "checks": []}, []

    def _handle_move(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        loc, status = self._resolve_target(intent_result)

        if status != "found" or not loc:
            exits = []
            if self.location:
                for e in self.location.get("exits", []):
                    exits.append(e["name"])
            free_locs = self._get_free_locations()
            for lid in free_locs:
                l = get_location(self.data, lid)
                if l and l["id"] != (self.location["id"] if self.location else None):
                    exits.append(f"前往{l['name']}")
            if exits:
                text = f"你可以去的地方：{'、'.join(exits)}。"
            else:
                text = "这里没有其他可去的地方。"
            return {"gm_text": text, "checks": []}, []

        target_id = loc["id"]
        free_locs = self._get_free_locations()

        if free_locs and target_id not in free_locs:
            return {
                "gm_text": f"要前往{loc['name']}，你需要继续前进。输入'出发'推进剧情。",
                "checks": [],
            }, []

        text = loc.get("scene_text") or loc.get("description", "")
        changes = [{"type": "move_player", "location_id": target_id}]

        # 检查被动察觉（简单实现，后续可扩展）
        if character:
            passive = 10 + ability_modifier(character.get("wisdom", 10))
            found = []
            for secret in loc.get("hidden", []):
                if secret.get("passive") and passive >= secret.get("dc", 20):
                    found.append(secret)
                    changes.append({
                        "type": "reveal_secret",
                        "location_id": target_id,
                        "secret_id": secret["id"],
                    })
            if found:
                descriptions = "\n".join([f"- {s['description']}" for s in found])
                text += f"\n\n你注意到了一些细节：\n{descriptions}"

        return {"gm_text": text, "checks": []}, changes

    def _handle_advance(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        next_id = self.scene.get("next_scene") if self.scene else None
        if not next_id:
            return {"gm_text": "前方已经没有路了。", "checks": []}, []

        scenes = self.data["chapter"].get("scenes", [])
        next_scene = next((s for s in scenes if s["id"] == next_id), None)
        if not next_scene:
            return {"gm_text": "无法推进剧情。", "checks": []}, []

        next_loc = get_location(self.data, next_scene["location"])
        text = ""
        if next_loc:
            text = next_loc.get("scene_text") or next_loc.get("description", "")
        if not text:
            text = next_scene.get("description", "")

        changes = [
            {"type": "move_player", "location_id": next_scene["location"], "scene_id": next_id},
        ]
        return {"gm_text": text, "checks": []}, changes

    def _handle_check(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        skill = intent_result.skill or ("perception" if intent_result.intent == "perception" else "investigation")
        skill_cn = self.SKILL_NAME_CN.get(skill, skill)
        ability = self.SKILL_ABILITY_MAP.get(skill, "wisdom")

        # DC 来源：AI 建议、地点/物品默认、隐藏信息默认
        dc = intent_result.suggested_dc
        if dc is None and self.location:
            # 取一个合适的 DC
            for h in self.location.get("hidden", []):
                if h.get("skill") == skill:
                    dc = h.get("dc", 10)
                    break
        if dc is None:
            dc = 10

        result = self._roll_skill_check(skill, character, dc)

        changes = []
        discovered = []
        if self.location:
            loc_id = self.location["id"]
            for h in self.location.get("hidden", []):
                if h.get("skill") == skill and result["total"] >= h.get("dc", 20):
                    discovered.append(h)
                    changes.append({
                        "type": "reveal_secret",
                        "location_id": loc_id,
                        "secret_id": h["id"],
                    })

            # 揭示隐藏物品（visible=false 且定义了 discovery 条件）
            for entry in self.location.get("items", []):
                if isinstance(entry, dict) and not entry.get("visible", True):
                    item_id = entry.get("id")
                    item = self.data["items"].get(item_id)
                    if not item:
                        continue
                    discovery = item.get("discovery")
                    if discovery and discovery.get("skill") == skill:
                        item_dc = discovery.get("dc", 15)
                        if result["total"] >= item_dc:
                            discovered.append({
                                "id": item_id,
                                "name": item.get("name"),
                                "description": discovery.get("description", ""),
                            })
                            changes.append({
                                "type": "reveal_item",
                                "location_id": loc_id,
                                "item_id": item_id,
                            })

        text = f"{skill_cn}检定：d20({result['roll']})+{result['modifier']} = {result['total']}，难度 DC {dc}。"
        if result["success"]:
            text += " 成功。"
        else:
            text += " 失败。"

        if discovered:
            descs = "\n".join([f"- {d['description']}" for d in discovered])
            text += f"\n\n你发现了：\n{descs}"

        return {"gm_text": text, "checks": [result]}, changes

    def _handle_steal(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        item, status = self._resolve_target(intent_result)

        if status != "found" or not item:
            # AI 没有识别出有效偷窃目标
            desc = intent_result.narrative_description or ""
            if desc and ("没有" in desc or "不存在" in desc):
                return {"gm_text": desc, "checks": []}, []
            return {"gm_text": "当前地点没有你可以偷的目标物品。", "checks": []}, []

        item_id = item["id"]
        if not self._is_present_item(item_id):
            return {"gm_text": f"这里没有 {item['name']}，无法偷窃。", "checks": []}, []

        if not item.get("stealable"):
            return {"gm_text": f"{item['name']} 无法被偷走。", "checks": []}, []

        dc = intent_result.suggested_dc or item.get("difficulty", 10)
        result = self._roll_skill_check("sleight_of_hand", character, dc)

        changes = []
        if result["success"]:
            owner_id = item.get("owner")
            changes.append({
                "type": "move_item",
                "item_id": item_id,
                "from": {"type": "location", "id": self.location["id"] if self.location else ""},
                "to": {"type": "player", "id": "player_1"},
                "hidden": True,
            })
            if owner_id:
                changes.append({
                    "type": "add_memory",
                    "npc_id": owner_id,
                    "memory": {
                        "event": "item_stolen",
                        "item_id": item_id,
                        "suspect": "player_1",
                        "timestamp": self.state.game_time if self.state else 0,
                    },
                })
            text = f"你成功偷走了 {item['name']}。"
        else:
            text = f"你试图偷走 {item['name']}，但手一滑没拿稳。"

        return {"gm_text": text, "checks": [result]}, changes

    def _handle_look(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        if not self.location:
            return {"gm_text": "你环顾四周，什么也没看到。", "checks": []}, []
        return {"gm_text": self.location.get("description", "你环顾四周。"), "checks": []}, []

    def _handle_other(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        desc = intent_result.narrative_description or ""
        # 如果 AI 已经在描述中说明目标不存在，直接作为规则引擎提示
        if desc and ("没有" in desc or "不存在" in desc):
            return {"gm_text": desc, "checks": []}, []
        return {"gm_text": "", "checks": []}, []
