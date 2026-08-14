"""
盗窃引擎（core）：偷窃全流程的确定性结算。

职责：潜行前置 → 巧手 → 四情况分档 → 对峙选项 → 挣脱/逃脱 → 卫兵流程 → 通缉标记。
AI 通过工具调用（intent=steal / resolve_suspicion / arrest）触发，基于引擎返回的真实结果叙事；
纯确定性，不依赖 AI 判断。确定性规则/检定复用 core.rules。
"""
import random
import time
from typing import Optional

from services.core.game_state import get_location
from services.core.rules import (
    roll_skill_check,
    ability_modifier,
    roll_d20,
    get_player_gold,
    set_player_gold,
    is_equipment_item,
    npc_present,
    merchant_sells,
    witness_stealth_dc,
    deduct_gold,
    char_ability_score,
)

# 四情况档位（巧手成功 margin 分档）
FLAGRANTE_MAX_MARGIN = 3   # margin < 3 → 情况二（刚偷到被当场瞥见，人赃并获，立即对峙）
DISCOVERED_MAX_MARGIN = 6  # 3 ≤ margin ≤ 6 → 情况四（延迟发现，5 秒反应期）；> 6 → 情况三（无事发生）

SOCIAL_SKILLS = {"deception": "欺瞒", "intimidation": "威吓", "persuasion": "游说"}

# ── 监狱（jailed 阶段）──
JAIL_LOCATION = "neverwinter-jail"     # 监狱地点
JAIL_BAIL = 100                        # 保释金（金币）
PICK_LOCK_DC = 14                      # 牢锁巧手 DC
JAIL_GUARD_PRESENT_MIN, JAIL_GUARD_PRESENT_MAX = 10, 20  # 狱卒在场（真实秒数倒计时）
JAIL_GUARD_AWAY_MIN, JAIL_GUARD_AWAY_MAX = 1, 3          # 狱卒巡逻（玩家动作推进的轮数）


# ── 通用辅助 ──
def _npc_name(state, npc_id: str) -> str:
    return state.data["npcs"].get(npc_id, {}).get("name", npc_id)


def _pname(state) -> str:
    """玩家角色名（播报一律用角色名，禁止第一/第二人称）"""
    return (state.character or {}).get("name") or "冒险者"


def _ability_check(character, ability: str, dc: int) -> dict:
    """纯属性检定：d20 + 属性调整（挣脱后的敏捷逃脱是敏捷检定，非技能检定）"""
    mod = ability_modifier(char_ability_score(character, ability))
    result = roll_d20(mod)
    result["skill"] = ability
    result["ability"] = ability
    result["dc"] = dc
    result["success"] = result["total"] >= dc
    return result


def suspicion_cost(state, npc_id: str, s: dict, multiplier: int = 2) -> int:
    """被怀疑的赔偿金额：赃物价值 × 倍数（统一按 state.stolen_value 计价）。
    情况二/四对峙 = ×2；强制搜身 = ×3。"""
    value = state.stolen_value(s.get("item_ids", []), s.get("gold_amount", 0), npc_id=npc_id)
    return max(1, value * max(1, multiplier))


# ── 搜身（实查背包）──
def search_player(state, npc_id: str, s: dict, multiplier: int = 2) -> tuple:
    """搜查（实查背包）：道具赃物看是否还在背包；装备类赃物视为随身携带（刚偷的仍在身上）。
    返回 (消息, 是否搜出, 赔偿金额)。"""
    npc_name = _npc_name(state, npc_id)
    still_have = []
    for iid in s.get("item_ids", []):
        if iid == "__gold__":
            continue
        item = state.data.get("items", {}).get(iid, {})
        if is_equipment_item(item) or iid in state.player_inventory:
            still_have.append(iid)
    have_gold = "__gold__" in s.get("item_ids", [])
    searched_out = bool(still_have) or have_gold
    if searched_out:
        cost = suspicion_cost(state, npc_id, s, multiplier)
        gold_after = deduct_gold(state, cost)
        state.set_hostile(npc_id)
        return f"{npc_name}从你身上搜出了赃物！你不得不赔偿 {cost} 金币（余额 {gold_after}）。", True, cost
    return f"{npc_name}搜遍你的行囊，一无所获，悻悻地放你离开。", False, 0


# ── 挣脱 / 逃脱 ──
def break_out(state, npc_id: str, character, opponent: str = "merchant") -> dict:
    """挣脱（仅被抓住状态可挣脱；全程最多 2 次机会，第 2 次更难 +2）。
    运动/体操自动取最高：两枚检定取 total 更高者。
    - opponent="merchant"：vs 商人力量，DC = 8 + 力量调整（第 2 次 +2）
    - opponent="guard"：vs 卫兵，DC 固定 15（卫兵训练有素，更难挣脱）
    返回 {"success", "check", "locked", "breakout_used"}"""
    used = state.caught_breakout_used()
    if used >= 2:
        return {"success": False, "locked": True, "breakout_used": used, "check": None,
                "message": "你已经没有力气再挣脱了，只能认栽。"}
    if opponent == "guard":
        dc = 15 + (2 if used >= 1 else 0)  # 卫兵 DC15；第 2 次挣脱同样 +2 更难
    else:
        dc = 8 + ability_modifier(state.npc_strength(npc_id)) + (2 if used >= 1 else 0)
    a = roll_skill_check("athletics", character, dc)
    b = roll_skill_check("acrobatics", character, dc)
    check = a if a["total"] >= b["total"] else b
    check["dc"] = dc
    check["skill"] = "athletics/acrobatics"  # 运动/体操自动取最高
    new_used = used + 1
    state.caught["breakout_used"] = new_used
    state.caught["breakout_locked"] = new_used >= 2
    return {"success": check["success"], "check": check, "locked": False, "breakout_used": new_used}


def escape_attempt(state, npc_id: str, character, opponent: str = "merchant") -> dict:
    """敏捷逃脱：敏捷检定 vs DC = 8 + 对方敏捷调整（商人敏捷 / 卫兵敏捷）。
    逃脱成功由调用方执行 _do_escape（传送 + 通缉）。"""
    if opponent == "guard":
        dc = 8 + ability_modifier(state.npc_dexterity("town-guard"))
    else:
        dc = 8 + ability_modifier(state.npc_dexterity(npc_id))
    check = _ability_check(character, "dexterity", dc)
    return {"success": check["success"], "check": check}


def random_teleport(state) -> str:
    """随机传送相邻出口（同场景 free_locations 内的出口目标）；无出口则原地不动。返回目标 location id"""
    loc = get_location(state.data, state.location_id)
    exits = (loc or {}).get("exits", [])
    targets = [e.get("target") for e in exits if e.get("target") and e.get("target") != state.location_id]
    if not targets:
        return state.location_id
    target = random.choice(targets)
    state.location_id = target
    return target


def _do_escape(state, npc_id: str) -> str:
    """逃脱成功：随机传送相邻出口 + 当前（案发）区域通缉 + 清空对峙/被抓住/卫兵状态。返回叙事消息（角色名，无你/我）"""
    crime_loc = state.location_id
    random_teleport(state)
    state.clear_suspicion(npc_id)
    state.clear_caught()
    state.clear_arrest()
    state.remove_guard_from_scene()
    state.set_wanted(crime_loc)
    loc = get_location(state.data, state.location_id)
    loc_name = loc.get("name", "一处地方") if loc else "一处地方"
    pname = _pname(state)
    # 不直接播报"被通缉"：通缉状态已标记（wanted_location），由 GM 在后续对话中自然揭示
    return f"{pname}甩开追兵，转身钻进人群，三拐两拐冲出了这片区域，一路逃到{loc_name}。"


# ── 呼叫卫兵 ──
def _call_guard(state, npc_id: str, s: dict):
    """商人呼叫卫兵：进入卫兵赶来中（1d4 轮），卫兵加入当前场景"""
    state.set_arrest(npc_id, s.get("item_ids", []), gold_amount=s.get("gold_amount", 0),
                     phase="summoned", rounds_left=random.randint(1, 4))
    state.add_guard_to_scene()


def _round_announce(rounds_left: int) -> str:
    """卫兵赶来轮数播报（每轮递减）"""
    if rounds_left >= 3:
        return "卫兵正在过来，你能听到远处传来急促的脚步声。"
    if rounds_left == 2:
        return "卫兵越来越近了，人群开始骚动，有人朝这边指指点点。"
    return "卫兵就到门口了！你几乎已经看见他按着剑柄的身影。"


# ── 偷窃主流程：四情况分档（商人 / 钱袋）──
def merchant_steal(state, npc_id: str, character, item_id: Optional[str] = None, target: str = "item") -> dict:
    """对在场商人执行偷窃。偷窃 = 前置潜行判定（未被目击）+ 巧手判定（得手），一次调用完成。

    时序：
      - ① 潜行判定（仅当未处于隐匿状态）：DC = 在场目击者最高被动感知+警觉
          失败 → 仅警觉 +1、未得手、不质问（玩家按兵不动）
      - ② 巧手判定：DC = 目标被动感知+警觉
          失败 → 【情况一】警觉 +2、转敌对、NPC 生气骂人，不进入对峙（玩家自决去留）
          成功 → 得手，按 margin 分档：
            margin < 3           → 【情况二】刚偷到被当场瞥见（人赃并获），立即对峙（flagrante）
            3 ≤ margin ≤ 6       → 【情况四】延迟发现（5 秒反应期后质问，discovered）
            margin > 6           → 【情况三】无事发生
    target="item" 偷货架物品 item_id；target="gold" 偷钱袋金币。"""
    npc_name = _npc_name(state, npc_id)

    if not state.get_merchant(npc_id):
        return {"success": False, "message": f"{npc_name}不是商人，没什么可偷的。", "gold": get_player_gold(state)}
    if not npc_present(state, npc_id):
        return {"success": False, "message": f"{npc_name} 不在这里。", "gold": get_player_gold(state)}
    if state.has_active_suspicion() or state.has_active_arrest():
        return {"success": False, "message": "你正被怀疑或被追捕，先应付眼前的事吧。", "gold": get_player_gold(state)}

    # ── ① 前置潜行判定：未被在场目击者察觉（已处于隐匿状态则跳过）──
    stealth_check = None
    if not state.has_stealth(npc_id):
        stealth_dc = witness_stealth_dc(state)
        stealth_check = roll_skill_check("stealth", character, stealth_dc)
        if not stealth_check["success"]:
            state.add_npc_alert(npc_id, 1)
            noise = "你弄出了声响" if stealth_check["roll"] <= 10 else "对方似乎有所察觉"
            msg = f"你悄悄靠近{npc_name}的摊位，但{noise}，只好先按兵不动。{npc_name}变得警觉了一些。"
            state.add_history("player", f"我想偷{npc_name}的东西")
            state.add_history("gm", msg)
            return {
                "success": False, "message": msg,
                "check": stealth_check, "stealth_blocked": True, "gold": get_player_gold(state),
            }

    # 目标确定（货架物品 / 钱袋金币）
    if target == "gold":
        merchant_gold = state.merchant_gold(npc_id)
        if merchant_gold <= 0:
            return {"success": False, "message": f"{npc_name}的钱袋空空如也。", "gold": get_player_gold(state)}
        stolen_amount = max(1, merchant_gold // 10)  # 偷钱袋的 10%
        stolen_desc = f"{stolen_amount} 金币"
        is_equipment = False
        stolen_ids = ["__gold__"]
    else:
        if not merchant_sells(state, npc_id, item_id or ""):
            return {"success": False, "message": f"{npc_name}的货架上没有这个。", "gold": get_player_gold(state)}
        stock = state.merchant_stock(npc_id, item_id)
        if stock is not None and stock <= 0:
            return {"success": False, "message": "货架上的这件已经被拿光了。", "gold": get_player_gold(state)}
        item = state.data.get("items", {}).get(item_id, {})
        stolen_desc = item.get("name", item_id)
        stolen_amount = 0
        is_equipment = is_equipment_item(item)
        stolen_ids = [item_id]

    # ── ② 巧手判定：DC = 目标被动感知 + 警觉 ──
    dc = state.npc_passive_perception(npc_id) + state.npc_alert(npc_id)
    check = roll_skill_check("sleight_of_hand", character, dc)

    if not check["success"]:
        # 【情况一】没偷到被抓：警觉 +2、转敌对、NPC 生气骂人。不进入对峙，走不走玩家自决。
        state.add_npc_alert(npc_id, 2)
        state.set_hostile(npc_id)
        state.clear_stealth()
        state.add_history("player", f"我试图偷{npc_name}的 {stolen_desc}")
        state.add_history("gm", f"你伸手想顺走{npc_name}的 {stolen_desc}，被他逮个正着！{npc_name}勃然大怒。")
        return {
            "success": False, "case": 1,
            "message": f"你伸手想顺走{npc_name}的 {stolen_desc}，却被他逮个正着！{npc_name}勃然大怒，指着你鼻子骂了一通。他现在对你充满敌意。",
            "check": check, "gold": get_player_gold(state),
        }

    # 成功：物品/金币入袋，潜行解除
    state.clear_stealth()
    margin = check["total"] - dc
    if target == "gold":
        state.set_merchant_gold(npc_id, state.merchant_gold(npc_id) - stolen_amount)
        set_player_gold(state, get_player_gold(state) + stolen_amount)
    else:
        state.add_merchant_theft(npc_id, item_id)
        if not is_equipment:
            state.player_inventory.append(item_id)
    state.add_npc_alert(npc_id, 1)
    state.add_history("player", f"我偷偷拿走了{npc_name}的 {stolen_desc}")
    state.add_history("gm", f"你悄悄偷走了{npc_name}的 {stolen_desc}。")

    if margin < FLAGRANTE_MAX_MARGIN:
        # 【情况二】刚偷到被当场瞥见 → 人赃并获，立即对峙（flagrante）
        state.set_hostile(npc_id)
        state.set_suspicion(npc_id, stolen_ids, gold_amount=stolen_amount, mode="flagrante")
        return {
            "success": True, "case": 2, "check": check, "is_equipment": is_equipment,
            "message": f"你刚把{npc_name}的 {stolen_desc}摸到手，就被他一个转身撞见！他一把扣住你的手腕：“人赃并获！你还有什么话说？！”",
            "stolen_amount": stolen_amount, "gold": get_player_gold(state),
        }
    if margin <= DISCOVERED_MAX_MARGIN:
        # 【情况四】延迟发现（5 秒反应期后质问）
        state.set_hostile(npc_id)
        return {
            "success": True, "case": 4, "check": check, "is_equipment": is_equipment,
            "message": f"你成功偷走了{npc_name}的 {stolen_desc}，暂时没人注意到。",
            "suspicion_triggered": True,
            "delayed_suspicion": {
                "npc_id": npc_id,
                "item_ids": stolen_ids,
                "gold_amount": stolen_amount if target == "gold" else 0,
            },
            "stolen_amount": stolen_amount, "gold": get_player_gold(state),
        }
    # 【情况三】无事发生
    return {
        "success": True, "case": 3, "check": check, "is_equipment": is_equipment,
        "message": f"你悄悄偷走了{npc_name}的 {stolen_desc}，没有引起任何注意。",
        "stolen_amount": stolen_amount, "gold": get_player_gold(state),
    }


# ── 场景物品（有主物）偷窃：保留 notice_chance / plot_critical 败露判定 ──
def scene_item_steal(state, owner_id: str, character, item: dict, item_id: str,
                     suggested_dc: Optional[int] = None) -> tuple:
    """场景物品偷窃。巧手失败 → 情况一（警觉+2、敌对、骂人、不进入对峙）；
    成功 → 得手 + 败露判定（物品 notice_chance 优先，缺省按 margin 挂钩的 discovery_p；
    plot_critical 必败露）→ 情况四（discovered）或无事（情况三）。
    返回 (rule_dict, changes)。"""
    npc_name = _npc_name(state, owner_id)
    changes = []

    # ① 前置潜行判定（未处于隐匿状态时）
    stealth_check = None
    if not state.has_stealth(owner_id):
        stealth_dc = witness_stealth_dc(state)
        stealth_check = roll_skill_check("stealth", character, stealth_dc)
        if not stealth_check["success"]:
            state.add_npc_alert(owner_id, 1)
            noise = "你弄出了声响" if stealth_check["roll"] <= 10 else "对方似乎有所察觉"
            return ({"gm_text": f"你悄悄靠近，但{noise}，只好先按兵不动。", "checks": [stealth_check]}, changes)

    # ② 巧手判定：DC = 主人被动感知+警觉（或物品 difficulty / AI 建议）
    dc = suggested_dc or item.get("difficulty") or (
        state.npc_passive_perception(owner_id) + state.npc_alert(owner_id)
    )
    result = roll_skill_check("sleight_of_hand", character, dc)

    if not result["success"]:
        # 【情况一】没偷到被抓：不进入对峙
        state.clear_stealth()
        state.add_npc_alert(owner_id, 2)
        state.set_hostile(owner_id)
        return ({"gm_text": f"你伸手想顺走 {item['name']}，却被{npc_name}逮个正着！{npc_name}勃然大怒，把你骂了一通。",
                 "checks": [result]}, changes)

    # 成功：得手
    state.clear_stealth()
    changes.append({
        "type": "move_item",
        "item_id": item_id,
        "from": {"type": "location", "id": state.location_id},
        "to": {"type": "player", "id": "player_1"},
        "hidden": True,
    })
    changes.append({
        "type": "add_memory",
        "npc_id": owner_id,
        "memory": {"event": "item_stolen", "item_id": item_id, "suspect": "player_1",
                   "timestamp": state.game_time},
    })
    rule = {"gm_text": f"你成功偷走了 {item['name']}，没有引起任何注意。", "checks": [result]}

    # 败露判定：主人不在场则无人发现；在场时按 notice_chance（plot_critical 必败露）
    if npc_present(state, owner_id):
        if item.get("plot_critical"):
            discovered = True
        else:
            notice_chance = item.get("notice_chance")
            if notice_chance is None:
                margin = result["total"] - dc
                notice_chance = max(0.05, min(0.9, 0.7 - margin * 0.08))
            discovered = random.random() < notice_chance
        if discovered:
            state.set_hostile(owner_id)
            rule = {
                "gm_text": f"你成功偷走了 {item['name']}，暂时没人注意到。",
                "checks": [result],
                "delayed_suspicion": {"npc_id": owner_id, "item_ids": [item_id]},
            }
    return rule, changes


# ── 被怀疑（强制对话）回应：按 mode 分流 ──
def resolve_suspicion_action(state, npc_id: str, action: str, character) -> dict:
    """被怀疑（强制对话）时玩家的回应，按 suspicion.mode 分流：

    flagrante（情况二，人赃并获）：
      - pay：赔偿 ×2 → 结束
      - deception：DC = 15 + 警觉（人赃并获时撒谎极难）→ 成功放行 / 失败保持对峙
      - intimidation：DC = 12 + 警觉 → 成功放行 / 失败保持对峙（说服当场无效，已删去）
      - flee：挣脱（运动/体操 vs 商人力量，第 1 次）→ 成功则挣脱开，可再"逃跑"敏捷逃脱 /
              失败 → 被抓住（第 1 次挣脱用完）→ 商人叫卫兵

    discovered（情况四，延迟发现）：
      - search：同意搜身 → 搜出 ×2（社交失败后 ×3）/ 没搜出放行
      - pay：给钱承认 → 赔偿 ×2
      - deception/intimidation/persuasion：DC = 12 + 警觉 → 成功放行 /
        失败 → 进入强制搜身阶段（social_failed，接受搜身 ×3 或逃跑）
      - flee：敏捷逃脱（vs 商人敏捷）→ 成功 = 逃脱[+通缉] / 失败 = 被抓 → 叫卫兵
      - refuse：拒绝 → 叫卫兵"""
    s = state.get_suspicion(npc_id)
    if not s:
        return {"searched_out": False, "cost": 0, "gold": get_player_gold(state), "message": "对方没有怀疑你。"}
    npc_name = _npc_name(state, npc_id)
    mode = s.get("mode", "discovered")
    check = None
    searched_out = False
    cost = 0
    msg = ""

    if mode == "flagrante":
        if action == "pay":
            cost = suspicion_cost(state, npc_id, s, 2)
            gold_after = deduct_gold(state, cost)
            state.set_hostile(npc_id)
            state.clear_suspicion(npc_id)
            msg = f"你认栽赔给{npc_name} {cost} 金币（余额 {gold_after}）。{npc_name}哼了一声，放开手放你离开。"
        elif action in ("deception", "intimidation"):
            dc = 15 + state.npc_alert(npc_id) if action == "deception" else 12 + state.npc_alert(npc_id)
            check = roll_skill_check(action, character, dc)
            if check["success"]:
                state.clear_suspicion(npc_id)
                msg = f"你巧舌如簧，{npc_name}将信将疑地松开了手，放你离开。"
            else:
                msg = f"{npc_name}不为所动：“人赃并获还想狡辩？！”他把你的手腕攥得更紧了。"
        elif action == "flee":
            if s.get("grappled", True):
                # 挣脱（第 1 次机会，vs 商人力量）
                result = break_out(state, npc_id, character, opponent="merchant")
                check = result["check"]
                if result.get("locked"):
                    msg = result["message"]
                elif result["success"]:
                    s["grappled"] = False
                    msg = (f"你猛地一挣，甩开了{npc_name}的手！{npc_name}又惊又怒。"
                           f"你现在可以继续“逃跑”尝试敏捷逃脱，或赔偿/社交了结。")
                else:
                    # 挣脱失败 → 被抓住 → 商人叫卫兵
                    state.set_caught(npc_id, result["breakout_used"])
                    _call_guard(state, npc_id, s)
                    state.clear_suspicion(npc_id)
                    msg = (f"你没能挣脱{npc_name}的钳制，被他死死按住。{npc_name}高声呼叫卫兵：“来人啊，抓小偷！”")
            else:
                # 已挣脱 → 敏捷逃脱（vs 商人敏捷）
                result = escape_attempt(state, npc_id, character, opponent="merchant")
                check = result["check"]
                if result["success"]:
                    msg = _do_escape(state, npc_id)
                else:
                    _call_guard(state, npc_id, s)
                    state.clear_suspicion(npc_id)
                    msg = f"你刚要跑，却被{npc_name}扑住。{npc_name}高声呼叫卫兵：“抓小偷啊！”"
        elif action == "refuse":
            msg = f"{npc_name}怒视着你：“人赃并获还想抵赖？给钱，还是让我叫卫兵来？”"
        else:
            msg = f"{npc_name}死死拽着你：“给个说法！”"
    else:
        if action == "search":
            mult = 3 if s.get("social_failed") else 2
            msg, searched_out, cost = search_player(state, npc_id, s, mult)
            state.clear_suspicion(npc_id)
        elif action == "pay":
            cost = suspicion_cost(state, npc_id, s, 2)
            gold_after = deduct_gold(state, cost)
            state.set_hostile(npc_id)
            state.clear_suspicion(npc_id)
            msg = f"你承认偷了东西，赔给{npc_name} {cost} 金币（余额 {gold_after}）。"
        elif action in SOCIAL_SKILLS:
            dc = 12 + state.npc_alert(npc_id)
            check = roll_skill_check(action, character, dc)
            if check["success"]:
                state.clear_suspicion(npc_id)
                msg = f"你用{SOCIAL_SKILLS[action]}打发了{npc_name}，对方虽仍有些怀疑，但没再纠缠，放你离开。"
            else:
                s["social_failed"] = True
                msg = (f"{npc_name}不为所动：“别跟我耍花招！”他上前一步，“再不让我搜身，我就要动手了！”"
                       f"（你可以选择“接受搜身”，或“逃跑”）")
        elif action == "flee":
            # 未抓住 → 敏捷逃脱
            result = escape_attempt(state, npc_id, character, opponent="merchant")
            check = result["check"]
            if result["success"]:
                msg = _do_escape(state, npc_id)
            else:
                state.set_hostile(npc_id)
                _call_guard(state, npc_id, s)
                state.clear_suspicion(npc_id)
                msg = f"你转身就跑，却被{npc_name}一把抓住！{npc_name}高声呼叫卫兵：“抓小偷！”"
        elif action == "refuse":
            state.set_hostile(npc_id)
            _call_guard(state, npc_id, s)
            state.clear_suspicion(npc_id)
            msg = f"你拒绝承认偷窃。{npc_name}高声呼叫卫兵：“来人啊，抓小偷！”"
        else:
            msg = f"{npc_name}盯着你：“给个说法！”"

    # 对峙结算统一写入 history（/suspicion 确定性端点不走 AI 叙事，AI 上下文需要此记忆）
    state.add_history("gm", msg)
    result = {"searched_out": searched_out, "cost": cost, "gold": get_player_gold(state), "message": msg}
    if check:
        result["check"] = check
    if state.has_active_arrest():
        result["arrest"] = state.arrest
    return result


# ── 卫兵流程（统一，情况二/四汇入）──
def arrest_action(state, action: str, character) -> dict:
    """卫兵 / 逮捕流程（新设计）：
    summoned（赶来中 1d4 轮，每轮播报）→ arrived（到场，默认被抓住，要求搜身）→
    arrested（被按死）→ jailed（关押一夜自动释放）。

    赶来中：pay 谈判赔偿 ×3 / 社交（难度↑）→ 成功私了 / flee 敏捷逃脱 / breakout 挣脱（第 2 次，仅被抓住）
    到场：search 同意搜 ×3 / 社交 1 次（高难度）/ breakout 挣脱（vs 卫兵 DC15）→ 成功再敏捷逃脱 /
        失败被按死 → 被按死 = ×3 赔偿 + 进监狱。"""
    a = state.arrest
    if not a or not a.get("active"):
        return {"message": "这里没有卫兵找你的麻烦。", "checks": []}
    phase = a.get("phase")
    guard_name = _npc_name(state, "town-guard")
    pname = _npc_name(state, a.get("plaintiff", ""))
    check = None
    msg = ""

    if phase == "summoned":
        # 每轮动作推进 1 轮（纯对话/询问不算一轮）
        rounds_left = max(0, int(a.get("rounds_left", 1)) - 1)
        a["rounds_left"] = rounds_left
        if action == "flee":
            result = escape_attempt(state, a.get("plaintiff", ""), character, opponent="merchant")
            check = result["check"]
            if result["success"]:
                return {"message": _do_escape(state, a.get("plaintiff", "")), "checks": [check], "escaped": True}
            a["phase"] = "arrived"
            a["guard_present"] = True
            msg = f"你刚迈开腿就被{pname}拽住。此刻{guard_name}已经赶到！"
        elif action == "breakout":
            if state.is_caught():
                result = break_out(state, a.get("plaintiff", ""), character, opponent="merchant")
                check = result["check"]
                if result.get("locked"):
                    msg = result["message"]
                elif result["success"]:
                    state.clear_caught()
                    msg = f"你拼尽全力挣脱了{pname}的钳制！趁卫兵还没到，你可以尝试“逃跑”脱身。"
                else:
                    msg = f"你奋力挣扎，却被{pname}抓得更紧。你已经用光了挣脱的机会，再也挣不脱了。"
            else:
                msg = "你现在并没有被抓住，不需要挣脱。想脱身就直接说“逃跑”。"
        elif action == "pay":
            cost = state.stolen_value(a.get("item_ids", []), a.get("gold_amount", 0), npc_id=a.get("plaintiff")) * 3
            gold_after = deduct_gold(state, cost)
            state.set_hostile(a.get("plaintiff", ""))
            _end_arrest(state)
            msg = (f"你同意赔偿私了，赔给{pname} {cost} 金币（余额 {gold_after}）。"
                   f"卫兵赶来后，{pname}说已经解决了，卫兵点了点头转身离开。")
        elif action in SOCIAL_SKILLS:
            dc = 15 + state.npc_alert(a.get("plaintiff", ""))
            check = roll_skill_check(action, character, dc)
            if check["success"]:
                _end_arrest(state)
                msg = (f"你用{SOCIAL_SKILLS[action]}说服了{pname}，对方同意私了。"
                       f"卫兵赶来后见已和解，便离开了。")
            else:
                msg = f"{pname}不为所动：“少来这套，等卫兵来处理你！”"
        else:
            msg = _round_announce(rounds_left)
        if a.get("phase") == "summoned" and rounds_left <= 0:
            a["phase"] = "arrived"
            a["guard_present"] = True
            msg += f" {guard_name}赶到{pname}身边：“怎么回事？”{pname}指着你：“就是他偷了我的东西！”卫兵转向你：“搜身，还是赔钱，自己说。”"
    elif phase == "arrived":
        # 卫兵到场 → 默认被抓住状态 → 要求搜身
        if not state.is_caught():
            state.set_caught("town-guard", int(a.get("breakout_used", 0)))
        if action == "search":
            cost = state.stolen_value(a.get("item_ids", []), a.get("gold_amount", 0), npc_id=a.get("plaintiff")) * 3
            gold_after = deduct_gold(state, cost)
            _seize_stolen(state)
            state.set_hostile(a.get("plaintiff", ""))
            _end_arrest(state)
            msg = (f"你主动同意搜身。{guard_name}从你身上搜出了赃物，按镇规没收并罚赔 {cost} 金币"
                   f"（余额 {gold_after}），训斥几句后放你离开。")
        elif action in SOCIAL_SKILLS:
            dc = 18
            check = roll_skill_check(action, character, dc)
            if check["success"]:
                _end_arrest(state)
                msg = f"你一番解释，{guard_name}与{pname}核对后确认是个误会，把你放了。"
            else:
                msg = f"{guard_name}不为所动：“先搜了再说。”你现在可以“挣脱”，或“同意搜身”。"
        elif action == "breakout":
            result = break_out(state, "town-guard", character, opponent="guard")
            check = result["check"]
            if result.get("locked"):
                msg = result["message"] + f" {guard_name}上前搜身。"
                a["phase"] = "arrested"
            elif result["success"]:
                state.clear_caught()
                esc = escape_attempt(state, "town-guard", character, opponent="guard")
                check = esc["check"]
                if esc["success"]:
                    return {"message": _do_escape(state, "town-guard"), "checks": [check], "escaped": True}
                a["phase"] = "arrested"
                msg = f"你刚挣开{guard_name}的手，一个趔趄又被按倒在地！"
            else:
                a["phase"] = "arrested"
                msg = f"你拼命挣扎，却仍被{guard_name}反剪双手按倒在地！"
        elif action == "flee":
            esc = escape_attempt(state, "town-guard", character, opponent="guard")
            check = esc["check"]
            if esc["success"]:
                return {"message": _do_escape(state, "town-guard"), "checks": [check], "escaped": True}
            a["phase"] = "arrested"
            msg = f"你转身就跑，却没跑过{guard_name}，被一把按倒。"
        else:
            msg = f"{guard_name}盯着你：“搜身，还是赔钱，自己说。”"
    elif phase == "arrested":
        # 被按死 → 没收赃物 + ×3 罚金 + 关进监狱（进监狱后可选：交保释金 / 蹲夜服刑 / 等巡逻撬锁越狱）
        cost = state.stolen_value(a.get("item_ids", []), a.get("gold_amount", 0), npc_id=a.get("plaintiff")) * 3
        gold_after = deduct_gold(state, cost)
        _seize_stolen(state)
        a["phase"] = "jailed"
        state.remove_guard_from_scene()
        return_loc = state.location_id
        state.location_id = JAIL_LOCATION
        _jail_init_guard(state, return_loc)
        pname = _pname(state)
        msg = (f"{pname}被{guard_name}按死，赃物被当场搜出没收，罚赔 {cost} 金币（余额 {gold_after}），"
               f"随后被关进绝冬城监狱。狱卒守在走廊里。可以选择：交保释金（{JAIL_BAIL} 金币）提前出狱、"
               f"蹲到天亮服刑，或等狱卒巡逻时撬锁越狱。")
    elif phase == "jailed":
        # 监狱互动：pay 保释 / pick_lock 撬锁 / wait 等巡逻 / serve 蹲夜 / 其他=对话（仅推进狱卒状态）
        tick_msg = _jail_tick(state)
        if action == "pay":
            if get_player_gold(state) >= JAIL_BAIL:
                gold_after = get_player_gold(state) - JAIL_BAIL
                set_player_gold(state, gold_after)
                msg = (f"{_pname(state)}掏出 {JAIL_BAIL} 金币交给狱卒作保释金。狱卒掂了掂钱袋，打开牢门："
                       f"“出去吧，别再犯事。”")
                _release_from_jail(state)
            else:
                msg = (f"翻遍口袋也只有 {get_player_gold(state)} 金币，不够 {JAIL_BAIL} 的保释金。"
                       f"要么想办法凑钱，要么蹲到天亮，要么等狱卒巡逻时撬锁越狱。")
        elif action == "pick_lock":
            if a.get("jail_guard") == "present":
                msg = "狱卒就坐在走廊里盯着这边，没法下手撬锁。可以输入“等待”消磨时间，等狱卒去巡逻。"
            else:
                check = roll_skill_check("sleight_of_hand", character, PICK_LOCK_DC)
                if check["success"]:
                    a["cell_open"] = True
                    msg = "锁芯“咔哒”一声弹开，牢门开了一条缝！趁狱卒还没回来，点击“监狱大门”赶紧离开。"
                elif check["total"] <= PICK_LOCK_DC - 5:
                    a["jail_guard"] = "present"
                    a["guard_until"] = time.time() + random.randint(JAIL_GUARD_PRESENT_MIN, JAIL_GUARD_PRESENT_MAX)
                    msg = "撬锁的手一抖，锁链哗啦作响，惊动了狱卒！他快步赶回来，恶狠狠地警告：“再敢撬锁，就加刑期！”"
                else:
                    msg = "锁芯纹丝不动，好在没发出太大声响，狱卒并未察觉。可以再试一次。"
        elif action == "wait":
            msg = "在牢里来回踱步，消磨着时间。"
            if a.get("jail_guard") == "away":
                msg += f"狱卒正在巡逻，估计还有 {a.get('guard_away_left', 0)} 轮才回来，现在可以试着撬锁。"
            else:
                msg += "狱卒还在走廊里守着，再等等吧。"
        elif action == "serve":
            state.game_time += 8
            msg = "决定服刑到天亮。一夜无事，第二天清晨，狱卒打开牢门：“滚吧，别再犯事。”"
            _release_from_jail(state)
        else:
            msg = "狱卒在走廊里踱步，没有理人。"
        if tick_msg:
            msg = tick_msg + " " + msg
    else:
        msg = ""

    result = {"message": msg}
    if check:
        result["check"] = check
    if state.has_active_arrest():
        result["arrest"] = state.arrest
    return result


def _seize_stolen(state):
    """逮捕时没收赃物：物品移出背包，偷到的金币扣回"""
    a = state.arrest
    for iid in a.get("item_ids", []):
        if iid != "__gold__" and iid in state.player_inventory:
            state.player_inventory.remove(iid)
    ga = a.get("gold_amount", 0)
    if ga > 0:
        set_player_gold(state, max(0, get_player_gold(state) - ga))


def _end_arrest(state):
    """处置结束：清空逮捕/被抓住状态，卫兵离开场景"""
    state.clear_arrest()
    state.clear_caught()
    state.remove_guard_from_scene()


# ── 监狱（jailed）狱卒巡逻 ──
def _jail_init_guard(state, return_location: str):
    """进监狱时初始化狱卒：在场倒计时（真实秒数），记录出狱返回地点"""
    a = state.arrest
    a["jail_guard"] = "present"  # present 在场（倒计时） / away 巡逻（按轮）
    a["guard_until"] = time.time() + random.randint(JAIL_GUARD_PRESENT_MIN, JAIL_GUARD_PRESENT_MAX)
    a["guard_away_left"] = 0
    a["cell_open"] = False
    a["return_location"] = return_location


def _jail_tick(state) -> str:
    """狱卒巡逻状态推进（玩家每次动作/越狱行动调用一次）：
    在场 = 真实时间倒计时（到点切 away）；离开 = 按玩家动作推进轮数（耗尽切 present；若牢门开着 → 强制关回）。
    返回播报片段（无变化时为空串）。"""
    a = state.arrest
    if not a or not a.get("active") or a.get("phase") != "jailed":
        return ""
    now = time.time()
    if a.get("jail_guard") == "present":
        if now >= float(a.get("guard_until", 0)):
            a["jail_guard"] = "away"
            a["guard_away_left"] = random.randint(JAIL_GUARD_AWAY_MIN, JAIL_GUARD_AWAY_MAX)
            return "狱卒起身去巡逻了，走廊里暂时没人。"
        return ""
    # 巡逻中：玩家动作推进 1 轮
    a["guard_away_left"] = max(0, int(a.get("guard_away_left", 0)) - 1)
    if a["guard_away_left"] <= 0:
        a["jail_guard"] = "present"
        a["guard_until"] = now + random.randint(JAIL_GUARD_PRESENT_MIN, JAIL_GUARD_PRESENT_MAX)
        if a.get("cell_open"):
            a["cell_open"] = False
            return f"狱卒巡逻回来了！他看到牢门大开的{_pname(state)}，一把将对方推回牢里，重新锁上门。"
        return "狱卒巡逻回来了，重新坐回桌边。"
    return ""


def _release_from_jail(state):
    """出狱：传回被抓前地点 + 清空逮捕状态"""
    a = state.arrest or {}
    ret = a.get("return_location")
    if ret and get_location(state.data, ret):
        state.location_id = ret
    _end_arrest(state)


def jail_escape(state) -> dict:
    """点击监狱大门越狱（牢门已开）：
    越狱行动同样推进狱卒巡逻轮数——若狱卒刚好回来 → 强制关回；否则越狱成功（复用 _do_escape：传送+通缉+清状态）。"""
    a = state.arrest
    if not a or not a.get("active") or a.get("phase") != "jailed":
        return {"ok": False, "message": "玩家现在不在监狱里。", "updates": state.to_client_updates()}
    if not a.get("cell_open"):
        return {"ok": False, "message": "牢门还锁着，出不去。", "updates": state.to_client_updates()}
    tick_msg = _jail_tick(state)
    if not a.get("active") or a.get("jail_guard") == "present":
        # 狱卒刚好回来 → 强制关回（cell_open 已被 _jail_tick 复位）
        return {"ok": False, "message": tick_msg or "狱卒回来了，把玩家按回牢里。", "updates": state.to_client_updates()}
    pname = _pname(state)
    msg = (f"{pname}趁狱卒巡逻的空档，猫着腰溜出牢房，穿过走廊推开监狱大门！" + _do_escape(state, "town-guard"))
    return {"ok": True, "message": msg, "updates": state.to_client_updates()}
