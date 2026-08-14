"""
统一状态变更系统

规则引擎只负责生成状态变更建议（state_changes），本模块负责实际执行。
所有变更都是确定性的，不调用 AI。
"""

import logging
from typing import Dict, Any, List, Optional
from copy import deepcopy

logger = logging.getLogger(__name__)


class StateManager:
    """状态变更执行器"""

    VALID_CHANGE_TYPES = {
        "move_item",
        "update_npc_state",
        "reveal_secret",
        "reveal_item",
        "move_player",
        "add_memory",
        "trigger_event",
        "modify_player_stat",
        "update_quest",
    }

    def __init__(self, state: Any):
        """
        state 是 GameState 实例
        """
        self.state = state

    def apply(self, changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        批量应用状态变更，返回实际生效的变更列表
        """
        applied = []
        for change in changes:
            result = self.apply_one(change)
            if result:
                applied.append(result)
        return applied

    def apply_one(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        应用单个状态变更，返回实际执行的变更（可能和输入不同），失败返回 None
        """
        change_type = change.get("type")
        if change_type not in self.VALID_CHANGE_TYPES:
            logger.warning(f"未知的状态变更类型: {change_type}")
            return None

        try:
            handler = getattr(self, f"_handle_{change_type}")
            return handler(change)
        except Exception as e:
            logger.error(f"应用状态变更失败 {change}: {e}")
            return None

    # ------------------------------------------------------------------
    # 变更处理器
    # ------------------------------------------------------------------
    def _handle_move_item(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        移动物品
        {
            "type": "move_item",
            "item_id": "gundrens-map",
            "from": {"type": "location", "id": "cragmaw-hideout-boss"},
            "to": {"type": "player", "id": "player_1"},
            "hidden": true
        }
        """
        item_id = change.get("item_id")
        from_ref = change.get("from", {})
        to_ref = change.get("to", {})

        if not item_id or not from_ref or not to_ref:
            return None

        # 从来源移除
        removed = self._remove_item_from(item_id, from_ref)
        if not removed:
            logger.warning(f"物品 {item_id} 不在来源 {from_ref} 中")
            return None

        # 添加到目标
        self._add_item_to(item_id, to_ref, hidden=change.get("hidden", False))

        return change

    def _handle_update_npc_state(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        更新 NPC 状态
        {
            "type": "update_npc_state",
            "npc_id": "klarg",
            "updates": {"attitude": "hostile", "awareness": "alert"}
        }
        """
        # 运行时状态白名单：dead/stunned/left/alive，其余值视为非法
        VALID_STATUS = {"dead", "stunned", "left", "alive"}

        npc_id = change.get("npc_id")
        updates = change.get("updates", {})

        if not npc_id or not updates:
            return None

        if npc_id not in self.state.data.get("npcs", {}):
            logger.warning(f"未知 NPC: {npc_id}")
            return None

        if "status" in updates and updates["status"] not in VALID_STATUS:
            logger.warning(f"非法 NPC 状态值: npc_id={npc_id}, status={updates['status']}")
            return None

        if npc_id not in self.state.npc_states:
            self.state.npc_states[npc_id] = {}

        if updates.get("status") == "alive":
            # alive 表示恢复正常，直接移除状态标记
            self.state.npc_states[npc_id].pop("status", None)
            remaining = {k: v for k, v in updates.items() if k != "status"}
            self.state.npc_states[npc_id].update(remaining)
        else:
            self.state.npc_states[npc_id].update(updates)
        return change

    def _handle_reveal_secret(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        揭示隐藏信息，同时生成情报条目
        {
            "type": "reveal_secret",
            "location_id": "cragmaw-hideout-boss",
            "secret_id": "hidden-chest"
        }
        """
        location_id = change.get("location_id")
        secret_id = change.get("secret_id")

        if not location_id or not secret_id:
            return None

        loc_state = self._get_location_state(location_id)
        revealed = loc_state.setdefault("revealed_secrets", [])

        if secret_id not in revealed:
            revealed.append(secret_id)
            # 生成情报条目
            self._add_intel_from_secret(location_id, secret_id)
            return change
        return None

    def _handle_reveal_item(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        揭示隐藏物品，将其 visible 状态改为 true，同时生成情报条目
        {
            "type": "reveal_item",
            "location_id": "cragmaw-hideout-boss",
            "item_id": "potion-of-healing"
        }
        """
        location_id = change.get("location_id")
        item_id = change.get("item_id")

        if not location_id or not item_id:
            return None

        loc = self.state.data.get("locations", {}).get(location_id)
        if not loc:
            return None

        for entry in loc.get("items", []):
            if isinstance(entry, dict) and entry.get("id") == item_id:
                if not entry.get("visible", True):
                    entry["visible"] = True
                    # 生成情报条目
                    self._add_intel_from_item(location_id, item_id)
                    return change
                return None
        return None

    # ------------------------------------------------------------------
    # 情报生成
    # ------------------------------------------------------------------
    def _add_intel_from_secret(self, location_id: str, secret_id: str):
        """从揭示的秘密生成情报条目"""
        secrets = self.state.data.get("secrets", {})
        secret = secrets.get(secret_id)
        if not secret:
            return

        loc = self.state.data.get("locations", {}).get(location_id, {})
        region = loc.get("name", location_id)

        intel_entry = {
            "id": f"intel_secret_{secret_id}",
            "title": secret.get("intel_title") or secret.get("title") or f"发现：{secret_id}",
            "type": secret.get("intel_type", "clue"),
            "region": region,
            "description": secret.get("intel_description") or secret.get("description", ""),
            "source": f"在{region}{'侦察' if secret.get('skill') == 'perception' else '调查'}时发现",
            "discovered_at": self.state.game_time,
        }
        self.state.add_intel(intel_entry)

    def _add_intel_from_item(self, location_id: str, item_id: str):
        """从发现的隐藏物品生成情报条目"""
        items = self.state.data.get("items", {})
        item = items.get(item_id)
        if not item:
            return

        loc = self.state.data.get("locations", {}).get(location_id, {})
        region = loc.get("name", location_id)

        intel_entry = {
            "id": f"intel_item_{item_id}",
            "title": f"发现物品：{item.get('name', item_id)}",
            "type": "item",
            "region": region,
            "description": item.get("description", ""),
            "source": f"在{region}调查时发现",
            "discovered_at": self.state.game_time,
        }
        self.state.add_intel(intel_entry)

    def _handle_move_player(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        移动玩家
        {
            "type": "move_player",
            "location_id": "cragmaw-hideout-entrance",
            "scene_id": "cragmaw-hideout"  # 可选，切换场景时提供
        }
        """
        location_id = change.get("location_id")
        scene_id = change.get("scene_id")

        if not location_id:
            return None

        # 校验地点是否存在
        if location_id not in self.state.data.get("locations", {}):
            logger.warning(f"目标地点不存在: {location_id}")
            return None

        self.state.location_id = location_id

        if scene_id and scene_id in self.state.data.get("scenes", {}):
            self.state.scene = self.state.data["scenes"][scene_id]

        return change

    def _handle_add_memory(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        给 NPC 添加记忆
        {
            "type": "add_memory",
            "npc_id": "klarg",
            "memory": {"event": "item_stolen", "item_id": "gundrens-map", "timestamp": 0}
        }
        """
        npc_id = change.get("npc_id")
        memory = change.get("memory")

        if not npc_id or not memory:
            return None

        npc_state = self.state.npc_states.setdefault(npc_id, {})
        memories = npc_state.setdefault("memory", [])
        memories.append(deepcopy(memory))

        return change

    def _handle_trigger_event(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        触发延迟事件
        {
            "type": "trigger_event",
            "event_id": "klarg_notices_missing_map",
            "trigger_after": {"min": 10, "max": 30, "unit": "minutes"},
            "payload": {...}
        }
        """
        event_id = change.get("event_id")
        if not event_id:
            return None

        events = self.state.__dict__.setdefault("pending_events", [])
        events.append(deepcopy(change))
        return change

    def _handle_modify_player_stat(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        修改玩家属性
        {
            "type": "modify_player_stat",
            "player_id": "player_1",
            "stat": "hp",
            "delta": -5,
            "temporary": false
        }
        """
        # 当前阶段只记录变更，具体角色数据结构后续对接
        logger.info(f"玩家属性变更: {change}")
        return change

    def _handle_update_quest(self, change: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        更新任务状态
        {
            "type": "update_quest",
            "quest_id": "escort-gundren",
            "status": "completed",
            "progress": 1
        }
        """
        quest_id = change.get("quest_id")
        updates = {k: v for k, v in change.items() if k not in ("type", "quest_id")}

        if not quest_id or not updates:
            return None

        quest_state = self.state.quest_states.setdefault(quest_id, {})
        quest_state.update(updates)
        return change

    # ------------------------------------------------------------------
    # 辅助函数
    # ------------------------------------------------------------------
    def _get_location_state(self, location_id: str) -> Dict[str, Any]:
        return self.state.location_states.setdefault(location_id, {})

    def _remove_item_from(self, item_id: str, ref: Dict[str, Any]) -> bool:
        ref_type = ref.get("type")
        ref_id = ref.get("id")

        if ref_type == "location":
            loc = self.state.data.get("locations", {}).get(ref_id)
            if not loc:
                return False
            items = loc.get("items", [])
            for i, item in enumerate(items):
                if item.get("id") == item_id or item == item_id:
                    items.pop(i)
                    return True
            return False

        elif ref_type == "player":
            if item_id in self.state.player_inventory:
                self.state.player_inventory.remove(item_id)
                return True
            return False

        elif ref_type == "npc":
            # NPC 背包暂存在 npc_states 中
            npc_state = self.state.npc_states.setdefault(ref_id, {})
            inv = npc_state.setdefault("inventory", [])
            if item_id in inv:
                inv.remove(item_id)
                return True
            return False

        return False

    def _add_item_to(self, item_id: str, ref: Dict[str, Any], hidden: bool = False):
        ref_type = ref.get("type")
        ref_id = ref.get("id")

        if ref_type == "location":
            loc = self.state.data.get("locations", {}).get(ref_id)
            if loc:
                loc.setdefault("items", []).append({
                    "id": item_id,
                    "hidden": hidden,
                })

        elif ref_type == "player":
            self.state.player_inventory.append(item_id)

        elif ref_type == "npc":
            npc_state = self.state.npc_states.setdefault(ref_id, {})
            npc_state.setdefault("inventory", []).append(item_id)
