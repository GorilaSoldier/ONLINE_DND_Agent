"""AI 意图分发层（ai）：把 AI 工具调用产出的结构化意图，分发给 core 的确定性结算。

后端不做任何猜测：目标不明时按"系统锁定的唯一对象"推断（对峙质问者/卫兵，非猜测），
其余一律返回提示由 AI/玩家明确；确定性检定/结算全部来自 services.core。
"""
import time
from typing import Dict, Any, List, Tuple, Optional

from services.core.intents import IntentResult
from services.core.game_state import get_location
from services.core.rules import (
    SKILL_ABILITY_MAP,
    char_ability_score,
    ability_modifier,
    roll_d20,
    location_npc_ids,
    witness_stealth_dc,
    merchant_sells,
)


class RuleEngine:
    """意图分发：执行 AI 提供的意图 → core 确定性结算。不直接猜测目标。"""

    SKILL_ABILITY_MAP = SKILL_ABILITY_MAP  # 技能→属性（确定性映射，定义在 core.rules）

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
        """执行意图，返回 (rule_result, state_changes)"""
        handlers = {
            "talk": self._handle_talk,
            "move": self._handle_move,
            "advance_scene": self._handle_advance,
            "perception": self._handle_check,
            "investigation": self._handle_check,
            "steal": self._handle_steal,
            "look": self._handle_look,
            "take": self._handle_take,
            "trade": self._handle_trade,
            "cast_spell": self._handle_cast,
            "use_action": self._handle_action,
            "resolve_suspicion": self._handle_resolve_suspicion,
            "arrest": self._handle_arrest,
            "other": self._handle_other,
        }
        handler = handlers.get(intent_result.intent, self._handle_other)
        return handler(intent_result, character)

    # ------------------------------------------------------------------
    # 目标查找
    # ------------------------------------------------------------------
    def _resolve_target(self, intent_result: IntentResult) -> Tuple[Optional[Any], str]:
        """根据 target_id / target_type 查找实际对象，返回 (对象, 查找状态)"""
        target_id = intent_result.target_id
        target_type = intent_result.target_type

        if target_type == "none" or not target_id:
            return None, "none"

        if target_type == "npc":
            npc = self.data["npcs"].get(target_id)
            if npc:
                return npc, "found"
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
        return npc_id in self._present_npc_ids()

    def _present_npc_ids(self) -> list:
        """当前地点/场景在场的 NPC id 列表（地点优先，场景兜底）"""
        if self.state and self.state.location_id:
            loc = get_location(self.data, self.state.location_id)
            if loc is not None and "npcs" in loc:
                return location_npc_ids(loc)
        return self.scene.get("npcs", []) if self.scene else []

    def _is_present_item(self, item_id: str) -> bool:
        """物品是否在当前地点/场景"""
        if self.state and self.state.location_id:
            loc = get_location(self.data, self.state.location_id)
            if loc is not None and "items" in loc:
                for entry in loc.get("items", []):
                    if isinstance(entry, str) and entry == item_id:
                        return True
                    if isinstance(entry, dict) and entry.get("id") == item_id:
                        return True
                return False
        item_entries = self.scene.get("items", []) if self.scene else []
        for entry in item_entries:
            if isinstance(entry, str) and entry == item_id:
                return True
            if isinstance(entry, dict) and entry.get("id") == item_id:
                return True
        return False

    # ------------------------------------------------------------------
    # 检定
    # ------------------------------------------------------------------
    def _char_ability(self, character: dict | None, ability: str) -> int:
        return char_ability_score(character, ability)

    def _roll_skill_check(self, skill: str, character: dict | None, dc: Optional[int] = None) -> dict:
        ability = self.SKILL_ABILITY_MAP.get(skill, "wisdom")
        score = self._char_ability(character, ability)
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
        # 逮捕流程中：移动被拦截（逃跑须明说"逃跑"走敏捷逃脱检定 / 被抓住可"挣脱"）
        if self.state and self.state.has_active_arrest():
            phase = self.state.arrest.get("phase")
            if phase == "summoned":
                return {"gm_text": "卫兵正在赶来。你若想脱身，就明说“逃跑”（敏捷检定甩开追兵）或“挣脱”。", "checks": []}, []
            if phase == "jailed":
                if self.state.arrest.get("cell_open"):
                    return {"gm_text": "牢门已经撬开了！点击“监狱大门”就可以逃出去。", "checks": []}, []
                return {"gm_text": "你被关在牢里，铁栏杆挡着出不去。可以等狱卒巡逻时撬锁，或交保释金、蹲到天亮服刑。", "checks": []}, []
            return {"gm_text": "卫兵拦住了你的去路：“先把事情说清楚！”你现在没法离开。", "checks": []}, []
        # 被怀疑偷窃（强制对话）时锁定移动（情况二立即锁定；情况四超过 5 秒反应期后锁定，期间允许逃跑）
        if self.state and self.state.suspicion_locked():
            for sid, s in self.state.suspicion.items():
                if s.get("active") and time.time() - s.get("detected_at", 0) >= 5:
                    npc = self.data["npcs"].get(sid, {})
                    return {
                        "gm_text": f"{npc.get('name', sid)}正盯着你，你现在没法离开这里。",
                        "checks": [],
                    }, []
            return {"gm_text": "你现在没法离开这里。", "checks": []}, []

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

        # 检查被动察觉
        if character:
            passive = 10 + ability_modifier(self._char_ability(character, "wisdom"))
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
        if skill == "stealth" and self.state:
            return self._handle_stealth(intent_result, character)
        skill_cn = self.SKILL_NAME_CN.get(skill, skill)
        ability = self.SKILL_ABILITY_MAP.get(skill, "wisdom")

        target_id = intent_result.target_id or (self.location["id"] if self.location else "")
        target_type = intent_result.target_type or "location"
        if target_type == "none":
            target_type = "location"  # 无明确目标的检定统一归到地点
        attempt_key = f"{skill}:{target_type}:{target_id}"

        if self.state and attempt_key in self.state.check_attempts:
            return {"gm_text": f"你已经对{target_type=='npc' and '这个人' or '这里'}进行过{skill_cn}了，没有更多发现。", "checks": [], "blocked": True}, []

        dc = intent_result.suggested_dc
        if dc is None and self.location:
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
        elif result["success"]:
            text += " 你在当前区域没有发现任何隐藏信息。只回复这一句：你没有发现异常。不要添加任何环境描写、NPC动作或新地点细节。"

        if self.state:
            self.state.check_attempts.add(attempt_key)

        return {"gm_text": text, "checks": [result]}, changes

    def run_passive_checks(self, character: dict | None, location: dict) -> list:
        """进入新地点时运行被动察觉和被动调查"""
        if not character or not location:
            return []

        passive_perception = 10 + ability_modifier(self._char_ability(character, "wisdom"))
        passive_investigation = 10 + ability_modifier(self._char_ability(character, "intelligence"))
        discoveries = []
        loc_id = location["id"]

        for h in location.get("hidden", []):
            if not h.get("passive"):
                continue
            skill = h.get("skill", "perception")
            dc = h.get("dc", 20)
            passive_score = passive_perception if skill == "perception" else (
                passive_investigation if skill == "investigation" else 0
            )
            if passive_score < dc:
                continue

            secret_key = f"{loc_id}:{h['id']}"
            if secret_key in (self.state.revealed_secrets if self.state else set()):
                continue

            discoveries.append({"id": h["id"], "description": h.get("description", ""), "skill": skill, "dc": dc})
            if self.state:
                self.state.revealed_secrets.add(secret_key)

        return discoveries

    def _handle_stealth(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """潜行：隐匿检定 vs 在场目击者最高被动感知+警觉。成功后进入隐匿状态。
        潜行不需要指定目标——未指定时为通用隐匿（偷窃任意在场 NPC 均视为已潜行）；
        指定目标时也可（如只想瞒过某人的眼睛）。"""
        present = self._present_npc_ids()
        target_id = intent_result.target_id
        npc_id = target_id if target_id and target_id in present else ""
        dc = witness_stealth_dc(self.state, npc_id or None) if self.state else 10
        result = self._roll_skill_check("stealth", character, dc)
        if result["success"]:
            self.state.set_stealth(npc_id, dc)
            text = "你悄然隐入人群与阴影，藏起了身形。"
        else:
            if npc_id:
                self.state.add_npc_alert(npc_id, 1)
                noise = "脚步声惊动" if result["roll"] <= 10 else "对方有所察觉"
                text = f"你试图潜行，但{noise}了在场的人，只好先按兵不动。"
            else:
                noise = "脚下踩到碎物" if result["roll"] <= 10 else "有人向你投来目光"
                text = f"你试图潜行，但{noise}，惊动了周围的人，只好先按兵不动。"
        return {"gm_text": text, "checks": [result]}, []

    def _handle_steal(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        from services.core.steal_engine import merchant_steal, scene_item_steal

        item, status = self._resolve_target(intent_result)

        if status == "found" and item and item.get("id"):
            item_id = item["id"]
            if self._is_present_item(item_id):
                if item.get("stealable") is False:
                    return {"gm_text": f"{item['name']} 无法被偷走。", "checks": []}, []
                if not item.get("owner"):
                    return {"gm_text": f"{item['name']} 是无主之物，直接拿走就行，不需要偷。", "checks": []}, []
                owner_id = item["owner"]
                dc = intent_result.suggested_dc
                rule, changes = scene_item_steal(self.state, owner_id, character, item, item_id, suggested_dc=dc)
                return rule, changes

        if self.state:
            target_type = intent_result.target_type
            target_id = intent_result.target_id
            if target_type == "item" and target_id:
                for nid in self._present_npc_ids():
                    if self.state.get_merchant(nid) and merchant_sells(self.state, nid, target_id):
                        r = merchant_steal(self.state, nid, character, item_id=target_id, target="item")
                        rule = {"gm_text": r["message"], "checks": [r["check"]] if r.get("check") else []}
                        if r.get("delayed_suspicion"):
                            rule["delayed_suspicion"] = r["delayed_suspicion"]
                        return rule, []
            elif target_type == "npc" and target_id:
                if self._is_present_npc(target_id) and self.state.get_merchant(target_id):
                    r = merchant_steal(self.state, target_id, character, target="gold")
                    rule = {"gm_text": r["message"], "checks": [r["check"]] if r.get("check") else []}
                    if r.get("delayed_suspicion"):
                        rule["delayed_suspicion"] = r["delayed_suspicion"]
                    return rule, []

        desc = intent_result.narrative_description or ""
        if desc and ("没有" in desc or "不存在" in desc):
            return {"gm_text": desc, "checks": []}, []
        return {"gm_text": "当前地点没有你可以偷的目标物品。", "checks": []}, []

    def _handle_resolve_suspicion(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """被怀疑（强制对话）时玩家的选择：search / pay / refuse / deception / intimidation / persuasion / flee。
        目标默认为系统锁定的唯一质问者（非猜测）：AI 未传 target_id 时取唯一 active 的 suspicion 对象。"""
        if not self.state:
            return {"gm_text": "", "checks": []}, []
        npc_id = intent_result.target_id
        if not npc_id:
            # 默认目标：状态机锁定的唯一质问者（玩家不可能对别人表态）
            active = [nid for nid, s in self.state.suspicion.items() if s.get("active")]
            npc_id = active[0] if len(active) == 1 else ""
        action = intent_result.action
        if not npc_id or action not in ("search", "pay", "refuse", "deception", "intimidation", "persuasion", "flee"):
            return {"gm_text": "对方在等你表态。", "checks": []}, []
        from services.core.steal_engine import resolve_suspicion_action
        result = resolve_suspicion_action(self.state, npc_id, action, character)
        return {"gm_text": result["message"], "checks": [result["check"]] if result.get("check") else []}, []

    def _handle_arrest(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """卫兵流程：summoned → arrived → arrested → jailed。对象固定（卫兵/原告），不依赖 target。"""
        if not self.state or not self.state.has_active_arrest():
            return {"gm_text": "这里没有卫兵找你的麻烦。", "checks": []}, []
        from services.core.steal_engine import arrest_action
        result = arrest_action(self.state, intent_result.action or "", character)
        return {"gm_text": result["message"], "checks": [result["check"]] if result.get("check") else []}, []

    def _handle_look(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        target_type = intent_result.target_type
        target_id = intent_result.target_id

        if target_type == "npc" and target_id:
            npc = self.data["npcs"].get(target_id)
            if not npc:
                return {"gm_text": "你没有看到那个人。", "checks": []}, []
            if not self._is_present_npc(target_id):
                return {"gm_text": f"{npc.get('name', target_id)} 不在这里。", "checks": []}, []
            desc = npc.get("description", "")
            race = npc.get("race", "")
            role = npc.get("role", "")
            name = npc.get("name", target_id)
            appearance = f"你打量着{name}。"
            if race or role:
                appearance += f" 这是一位{race}{role}。"
            if desc:
                appearance += f" {desc}"
            return {"gm_text": appearance, "checks": []}, []

        if target_type == "item" and target_id:
            item = self.data["items"].get(target_id)
            if not item:
                return {"gm_text": "你没有看到那个东西。", "checks": []}, []
            if not self._is_present_item(target_id):
                return {"gm_text": f"这里没有 {item.get('name', target_id)}。", "checks": []}, []
            name = item.get("name", target_id)
            desc = item.get("description", "")
            appearance = f"你仔细看了看{name}。"
            if desc:
                appearance += f" {desc}"
            return {"gm_text": appearance, "checks": []}, []

        if not self.location:
            return {"gm_text": "你环顾四周，什么也没看到。", "checks": []}, []
        return {"gm_text": self.location.get("description", "你环顾四周。"), "checks": []}, []

    def _handle_take(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """拿取物品（非偷窃，物品未被他人持有）"""
        item, status = self._resolve_target(intent_result)

        if status != "found" or not item:
            return {"gm_text": "当前地点没有你可以拿取的目标物品。", "checks": []}, []

        item_id = item["id"]
        if not self._is_present_item(item_id):
            return {"gm_text": f"这里没有 {item.get('name', item_id)}。", "checks": []}, []

        if item.get("owner"):
            return {"gm_text": f"{item['name']} 看起来属于别人。如果你想拿走它，需要偷窃。", "checks": []}, []

        changes = [{
            "type": "move_item",
            "item_id": item_id,
            "from": {"type": "location", "id": self.location["id"] if self.location else ""},
            "to": {"type": "player", "id": "player_1"},
            "hidden": False,
        }]
        return {"gm_text": f"你拿起了 {item['name']}。", "checks": []}, changes

    def _handle_trade(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """交易意图（当前为占位实现）"""
        target_type = intent_result.target_type
        target_id = intent_result.target_id

        if target_type == "npc" and target_id:
            npc = self.data["npcs"].get(target_id)
            if npc and self._is_present_npc(target_id):
                return {"gm_text": f"{npc['name']} 看着你，似乎在等你开口。你想买什么，或者卖什么？", "checks": []}, []
        elif target_type == "item" and target_id:
            item = self.data["items"].get(target_id)
            if item:
                return {"gm_text": f"你在考虑交易 {item.get('name', target_id)}，但这里似乎没有合适的交易对象。", "checks": []}, []

        return {"gm_text": "你想和谁交易？买什么还是卖什么？", "checks": []}, []

    def _handle_cast(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """施法：调用 core.spell_engine 校验法术位并确定性结算，AI 基于真实结果叙事"""
        if not self.state:
            return {"gm_text": "", "checks": []}, []
        from services.core.spell_engine import cast_spell
        spell_id = intent_result.spell_id or intent_result.target_id
        target_npc = intent_result.target_npc_id or None
        result = cast_spell(self.state, character, spell_id, target_npc)
        if not result.get("success"):
            return {"gm_text": result["message"], "checks": []}, []
        pname = (character or {}).get("name") or "你"
        text = result["message"].replace("你", pname, 1)
        if result.get("narrative"):
            text += f"\n【法术描述】{result['narrative']}"
        return {"gm_text": text, "checks": result.get("checks", [])}, []

    def _handle_action(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        """职业动作（回气/回复等）：core.action_engine 确定性结算"""
        if not self.state:
            return {"gm_text": "", "checks": []}, []
        from services.core.action_engine import use_action
        result = use_action(self.state, character, intent_result.target_id)
        return {"gm_text": result["message"], "checks": []}, []

    def _handle_other(self, intent_result: IntentResult, character: dict | None) -> Tuple[dict, List[dict]]:
        desc = intent_result.narrative_description or ""
        if desc and ("没有" in desc or "不存在" in desc):
            return {"gm_text": desc, "checks": []}, []
        return {"gm_text": "", "checks": []}, []
