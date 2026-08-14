"""确定性规则层（core）：检定、DC、潜行目击者、角色属性、金币等纯确定性逻辑。
AI 意图分发（services.ai.intent_dispatch）与各确定性引擎（steal_engine 等）共用，
后端不做任何猜测，只做"输入参数 → 确定性结果"。"""
import random

from services.core.game_state import get_location

# 技能 → 属性映射（检定用，确定性数据）
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


def roll_d20(modifier: int = 0) -> dict:
    roll = random.randint(1, 20)
    return {"roll": roll, "modifier": modifier, "total": roll + modifier}


def ability_modifier(score: int) -> int:
    return (score - 10) // 2


def char_ability_score(character: dict | None, ability: str) -> int:
    """读取角色属性值（兼容扁平 {dexterity: N} 与嵌套 {abilities: {dex: {value: N}}} 两种结构）"""
    if not character:
        return 10
    top = character.get(ability)
    if isinstance(top, dict):
        return int(top.get("value", 10))
    if top is not None:
        return int(top)
    short_key = {
        "strength": "str", "dexterity": "dex", "constitution": "con",
        "intelligence": "int", "wisdom": "wis", "charisma": "cha",
    }.get(ability, ability)
    ab = (character.get("abilities") or {}).get(short_key)
    if ab is None:
        ab = (character.get("abilities") or {}).get(ability)
    if isinstance(ab, dict):
        return int(ab.get("value", 10))
    return int(ab) if ab is not None else 10


def roll_skill_check(skill: str, character: dict | None, dc: int) -> dict:
    """技能检定：d20 + 属性调整 vs DC（确定性）"""
    ability = SKILL_ABILITY_MAP.get(skill, "wisdom")
    mod = ability_modifier(char_ability_score(character, ability))
    result = roll_d20(mod)
    result["skill"] = skill
    result["ability"] = ability
    result["dc"] = dc
    result["success"] = result["total"] >= dc
    return result


def is_equipment_item(item: dict) -> bool:
    """物品是否为装备类（拿取后进装备栏，而非道具背包）"""
    return bool(item) and item.get("type") in ("equipment", "weapon", "armor", "accessory")


def get_player_gold(state) -> int:
    return int(((getattr(state, "character", None) or {}).get("inventory") or {}).get("gold") or 0)


def set_player_gold(state, gold: int):
    char = getattr(state, "character", None)
    if not char:
        return
    char.setdefault("inventory", {})["gold"] = max(0, gold)


def deduct_gold(state, amount: int) -> int:
    gold = max(0, get_player_gold(state) - amount)
    set_player_gold(state, gold)
    return gold


def npc_present(state, npc_id: str) -> bool:
    """NPC 是否在当前场景/地点"""
    loc = get_location(state.data, state.location_id) if state.location_id else None
    npc_ids = location_npc_ids(loc) if loc is not None else (state.scene.get("npcs", []) if state.scene else [])
    return npc_id in npc_ids


def merchant_sells(state, npc_id: str, item_id: str) -> bool:
    return any(e.get("item_id") == item_id for e in state.get_merchant_inventory(npc_id))


def _npc_entry_id(entry) -> str | None:
    """npcs 数组元素（str 或 {id, sub}）取 id"""
    return entry if isinstance(entry, str) else (entry or {}).get("id")


def _npc_entry_sub(entry) -> str | None:
    """npcs 数组元素取子区域（无 sub 视为公共区域 None）"""
    return entry.get("sub") if isinstance(entry, dict) else None


def location_npc_ids(loc) -> list:
    """地点在场的 NPC id 列表（兼容 str / {id, sub} 两种形式）"""
    if not loc:
        return []
    return [nid for nid in (_npc_entry_id(e) for e in loc.get("npcs", [])) if nid]


def witness_stealth_dc(state, target_npc_id: str = None) -> int:
    """潜行 DC：在场目击者中最高被动感知 + 各自警觉。
    子区域相同才互为目击者——线下 DM 按"谁能看见偷窃现场"裁定的固化：
      - target_npc_id 给定时：只统计与目标同子区域（sub）的 NPC
        （带 sub 的 NPC 只与同 sub 者互见：铁匠铺里的格罗斯看不见路边摊的汉斯；
         无 sub 视为公共区域，公共区域者互见，但与带 sub 者互不可见）
      - target_npc_id 为 None（通用潜行，不针对特定目标）：统计全部在场 NPC
    躲过最警觉的那双眼睛，一次判定即可；无目击者时兜底 10。"""
    loc = get_location(state.data, state.location_id) if state.location_id else None
    entries = loc.get("npcs", []) if loc is not None else (state.scene.get("npcs", []) if state.scene else [])
    target_sub = None
    if target_npc_id:
        for e in entries:
            if _npc_entry_id(e) == target_npc_id:
                target_sub = _npc_entry_sub(e)
                break
    best = 0
    for e in entries:
        if target_npc_id and _npc_entry_sub(e) != target_sub:
            continue
        nid = _npc_entry_id(e)
        if not nid:
            continue
        pp = state.npc_passive_perception(nid) + state.npc_alert(nid)
        if pp > best:
            best = pp
    return best or 10
