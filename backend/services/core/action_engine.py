"""动作引擎：职业动作（回气/回复等），消耗短休充能资源。

与法术引擎（spell_engine）分离：动作消耗动作充能/短休资源，法术消耗法术位。
使用统一走本引擎 use_action（确定性结算），前端按钮接口与 AI intent=use_action 共用。
"""
import random


def _class_action_ids(character: dict) -> list:
    spells = (character or {}).get("spells") or {}
    return (spells.get("action_ids") or {}).get("class") or []


def use_action(state, character: dict, action_id: str) -> dict:
    """使用职业动作。返回 {success, message, heal, ...}，规则引擎/AI 基于真实结果叙事。"""
    if action_id not in _class_action_ids(character):
        return {"success": False, "message": "你不会这个动作。"}

    if action_id == "second_wind":
        # 回气：恢复 1d10 + 等级，每次短休/长休后一次
        uses = int(state.short_rest_action_uses.get(action_id, 0))
        if uses >= 1:
            return {"success": False, "message": "回气已经用过了，短休或长休后才能再次使用。"}
        level = int((character or {}).get("level", 1) or 1)
        total = random.randint(1, 10) + level
        healed = state.heal_player(total)
        state.short_rest_action_uses[action_id] = uses + 1
        return {"success": True, "message": f"你使用回气，恢复了 {healed} 点生命值。", "heal": healed}

    if action_id == "recovery":
        # 回复：花费一次短休充能，恢复少量生命值并刷新部分职业技能次数
        if state.short_rests_left <= 0:
            return {"success": False, "message": "没有短休次数了，需要长休恢复。"}
        state.short_rests_left -= 1
        healed = state.heal_player(max(2, state.player_hp_max() // 4))
        return {"success": True, "message": f"你使用回复，恢复了 {healed} 点生命值（消耗一次短休充能，剩余 {state.short_rests_left} 次）。", "heal": healed}

    if action_id == "fighting_spirit":
        # 斗气如潮：依赖战斗回合，非战斗不可用（战斗系统待实现）
        return {"success": False, "message": "斗气如潮需要在战斗中使用。"}

    return {"success": False, "message": "暂不支持该动作。"}
