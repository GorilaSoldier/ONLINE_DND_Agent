"""法术引擎：法术库加载、法术位状态、施法校验、效果结算。

与动作引擎（action_engine）分离：法术消耗法术位（长休恢复），动作消耗短休充能资源。
施法统一走本引擎的 cast_spell（确定性结算），前端按钮接口与 AI intent=cast_spell 共用，
结果写入 history 供 AI 叙事——与偷窃系统共用 steal_engine.merchant_steal 同一模式。
"""
import re
import random
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[3]  # services/core → DND
SPELLS_PATH = BASE_DIR / "data" / "spells.json"

# 法术位表（简化）：按施法等级（caster_level）的每环最大法术位；当前仅支持 1 环
_SLOT_MAX_BY_CASTER_LEVEL = {1: 2, 2: 3, 3: 4, 4: 4, 5: 4}


def load_spells() -> dict:
    try:
        with open(SPELLS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def spell_lookup() -> dict:
    """spell_id → 法术定义（actions / passive / spells 各环 / cantrips 全部平铺）"""
    data = load_spells()
    lookup = {}
    for group, cat in data.items():
        if group == "spells":
            for level_cat in (cat or {}).values():
                if isinstance(level_cat, dict):
                    lookup.update(level_cat)
        elif isinstance(cat, dict):
            lookup.update(cat)
    return lookup


def known_spell_ids(character: dict) -> set:
    """角色已知法术 id 集合（1 环法术 + 戏法）"""
    spells = (character or {}).get("spells") or {}
    lvl1 = (spells.get("spell_ids") or {}).get("level_1") or []
    cantrips = (character or {}).get("cantrip_ids") or []
    return set(lvl1) | set(cantrips)


def is_cantrip(spell_id: str, character: dict) -> bool:
    return spell_id in ((character or {}).get("cantrip_ids") or [])


def casting_ability_mod(character: dict) -> int:
    """施法属性调整：取智力/感知/魅力最高（按职业精细表后续可补）"""
    ab = (character or {}).get("abilities") or {}

    def _mod(key):
        v = ab.get(key)
        if isinstance(v, dict):
            v = v.get("value", 10)
        return (int(v or 10) - 10) // 2

    return max(_mod("int"), _mod("wis"), _mod("cha"))


def spell_slot_max(character: dict, level: int) -> int:
    """某环法术位的最大值（按施法等级推导）"""
    if level != 1:
        return 0
    caster_level = int(((character or {}).get("spells") or {}).get("caster_level", 1) or 1)
    return _SLOT_MAX_BY_CASTER_LEVEL.get(max(1, min(caster_level, 20)), 2)


def resolve_spell_id(character: dict, spell_id: str) -> str:
    """把 AI 传入的法术名/id 解析为真实 id：优先 id 匹配，其次按名字匹配已知法术。
    防 AI 把 spell_id 填成中文名（如"火焰箭"）导致校验失败。"""
    if spell_id in known_spell_ids(character):
        return spell_id
    lookup = spell_lookup()
    for iid in known_spell_ids(character):
        if lookup.get(iid, {}).get("name") == spell_id:
            return iid
    return spell_id


def _pname(character: dict | None) -> str:
    """玩家角色名（播报一律用角色名，禁止第一/第二人称）"""
    return (character or {}).get("name") or "冒险者"


def can_cast(state, character: dict, spell_id: str) -> tuple:
    """施法前置校验：法术已知（支持中文名/ id）+ 法术位充足（戏法不消耗）。返回 (是否可施放, 原因)"""
    spell_id = resolve_spell_id(character, spell_id)
    if spell_id not in known_spell_ids(character):
        return False, f"{_pname(character)}不会这个法术。"
    if is_cantrip(spell_id, character):
        return True, ""
    level = 1
    if int(state.spell_slots_used.get(level, 0)) >= spell_slot_max(character, level):
        return False, "没有剩余的法术位了（1 环法术位已用完，长休后恢复）。"
    return True, ""


def _parse_effect(effect: str):
    """解析 effect 字段：
    - "heal NdM+mod" / "heal NdM"
    - "damage NdM 类型 [save=dex half]" / "damage Nx(MdM+K) 类型"
    - "narrative"（无数值效果，AI 按 description 叙事）
    返回 (kind, params)"""
    effect = (effect or "").strip().lower() or "narrative"
    m = re.match(r"heal\s+(\d+)d(\d+)(?:\s*\+\s*mod)?", effect)
    if m:
        return "heal", {"count": int(m.group(1)), "die": int(m.group(2))}
    m = re.match(
        r"damage\s+(?:(\d+)x\s*\()?(\d+)d(\d+)(?:\s*\+\s*(\d+))?\s*\)?\s*([a-z\u4e00-\u9fa5]+)?(?:\s+save=(\w+)\s+half)?",
        effect,
    )
    if m:
        return "damage", {
            "repeats": int(m.group(1) or 1),
            "count": int(m.group(2)), "die": int(m.group(3)),
            "bonus": int(m.group(4) or 0),
            "dtype": m.group(5) or "力场", "save": m.group(6),
        }
    return "narrative", {}


def _npc_ability_mod(npc: dict, key: str) -> int:
    ab = npc.get("abilities") or {}
    v = ab.get(key)
    if isinstance(v, dict):
        v = v.get("value", 10)
    elif v is None:
        v = 10
    return (int(v) - 10) // 2


def cast_spell(state, character: dict, spell_id: str, target_npc_id: str = None) -> dict:
    """施放法术：校验 → 消耗法术位 → 结算效果（heal / damage / narrative）。
    返回 {success, message, spell_name, used_slot, heal, damage, damage_type, narrative, checks}，
    规则引擎/AI 基于真实结果叙事，不凭空加效果。"""
    lookup = spell_lookup()
    spell_id = resolve_spell_id(character, spell_id)
    spell = lookup.get(spell_id, {})
    spell_name = spell.get("name", spell_id)
    if not spell:
        return {"success": False, "message": "没有这个法术。"}

    ok, reason = can_cast(state, character, spell_id)
    if not ok:
        return {"success": False, "message": reason}

    used_slot = False
    if not is_cantrip(spell_id, character):
        state.spell_slots_used[1] = int(state.spell_slots_used.get(1, 0)) + 1
        used_slot = True

    kind, params = _parse_effect(spell.get("effect", ""))
    result = {"success": True, "spell_name": spell_name, "used_slot": used_slot,
              "checks": [], "heal": 0, "damage": 0}

    if kind == "heal":
        total = sum(random.randint(1, params["die"]) for _ in range(params["count"]))
        total += casting_ability_mod(character)
        healed = state.heal_player(total)
        result.update(heal=healed, message=f"{_pname(character)}施放{spell_name}，恢复了 {healed} 点生命值。")

    elif kind == "damage":
        total = 0
        for _ in range(params["repeats"]):
            total += sum(random.randint(1, params["die"]) for _ in range(params["count"])) + params["bonus"]
        result["damage"] = total
        result["damage_type"] = params["dtype"]
        save = params.get("save")
        npc = state.data.get("npcs", {}).get(target_npc_id or "", {})
        if save and npc:
            # 目标豁免：DC = 8 + 施法调整 + 熟练(2)，豁免属性取目标对应属性（缺省 0）
            dc = 8 + casting_ability_mod(character) + 2
            mod = _npc_ability_mod(npc, save[:3])
            roll = random.randint(1, 20) + mod
            half = roll >= dc
            if half:
                result["damage"] = total // 2
            name = npc.get("name") or target_npc_id
            result["message"] = (
                f"{_pname(character)}施放{spell_name}，目标{name}{'豁免成功' if half else '豁免失败'}，"
                f"受到 {result['damage']} 点{params['dtype']}伤害。"
            )
            npc_state = state.npc_states.setdefault(target_npc_id, {})
            npc_state["wounded"] = True
            npc_state["last_damage"] = result["damage"]
        else:
            result["message"] = f"{_pname(character)}施放{spell_name}，造成 {total} 点{params['dtype']}伤害。"
            if npc:
                npc_state = state.npc_states.setdefault(target_npc_id, {})
                npc_state["wounded"] = True
                npc_state["last_damage"] = total

    else:  # narrative：隐身/护盾/法师护甲/睡眠等，效果由 AI 按 description 叙事
        result["narrative"] = spell.get("description", "")
        result["message"] = f"{_pname(character)}施放了{spell_name}。"

    return result
