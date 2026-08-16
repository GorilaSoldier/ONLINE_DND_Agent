"""偷窃四情况 + 卫兵流程 + 监狱 端到端测试（可控掷骰 + 真实 AI GM 叙事）

运行：cd backend && python test_steal_e2e.py
输出：终端打印 + Plan/模块1/偷窃与监狱测试记录-2026-08-14.md
"""
import os
import sys
import time
import functools
import copy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print = functools.partial(print, flush=True)  # 实时输出进度

from dotenv import load_dotenv
load_dotenv()

import services.core.steal_engine as se
from services.core.game_state import GameState, load_adventure_chapter, get_location, load_chapter_summary
from services.ai.ai_gm import AIGM

REPORT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Plan", "模块1", "偷窃与监狱测试记录-2026-08-14.md"))

CHAR = {
    "name": "爱米利亚",
    "abilities": {"dex": {"value": 14}, "str": {"value": 14}, "cha": {"value": 12}},
    "inventory": {"gold": 300},
}

# ── 可控掷骰：TOTALS 按技能指定；D20_TOTAL 覆盖敏捷检定（None → 10+mod 恒成功）──
TOTALS = {"stealth": 99, "sleight_of_hand": 20, "athletics": 20, "acrobatics": 20,
          "deception": 20, "intimidation": 20, "persuasion": 20}
D20_TOTAL = None


def fake_skill(skill, character, dc):
    total = TOTALS.get(skill, dc + 5)
    return {"roll": total, "modifier": 0, "total": total, "skill": skill,
            "ability": "dex", "dc": dc, "success": total >= dc}


def fake_d20(mod=0):
    global D20_TOTAL
    total = D20_TOTAL if D20_TOTAL is not None else 10 + mod
    return {"roll": total, "modifier": mod, "total": total}


se.roll_skill_check = fake_skill
se.roll_d20 = fake_d20

ai_gm = AIGM()
assert ai_gm.client, "DEEPSEEK_API_KEY 未配置，无法进行 GM 叙事"


def new_state():
    data = load_adventure_chapter("lost-mine-of-phandelver", "ch1")
    scene = data["chapter"]["scenes"][0]
    st = GameState("lost-mine-of-phandelver", "ch1", data, scene)
    st.location_id = "neverwinter-market"
    st.character = copy.deepcopy(CHAR)  # 深拷贝：避免场景间共享 inventory 污染
    return st


def gold(st):
    return st.character["inventory"]["gold"]


def build_context(st):
    location = get_location(st.data, st.location_id)
    return {
        "scene": st.scene or {},
        "location": location or {},
        "npcs": st.get_context_npcs(),
        "items": st.get_context_items(),
        "passive_discoveries": [],
        "character": st.character,
        "chapter_summary": load_chapter_summary(st.adventure_id, st.chapter_id),
        "suspicion": {nid: s for nid, s in st.suspicion.items() if s.get("active")},
        "arrest": st.arrest,
        "wanted_location": st.wanted_location,
        "wanted_names": [
            (get_location(st.data, lid) or {}).get("name", lid)
            for lid in (st.wanted_location or [])
        ],
    }


def gm_narrate(st, player_input, gm_hint, checks):
    """真实 AI GM 叙事（复用 game.py 的 polish_broadcast 单轮润色模式，无 thinking 回传约束）"""
    context = build_context(st)
    facts = f"玩家输入：{player_input}\n结算结果：{gm_hint}"
    tokens = []
    try:
        for tok in ai_gm.polish_broadcast(
            event_type="行动", facts=facts,
            context={"player_name": st.character.get("name") or "冒险者", "action": "行动",
                     "history": st.history},
        ):
            tokens.append(tok)
    except Exception:
        tokens = []
    text = "".join(tokens).strip() or gm_hint
    st.add_history("player", player_input)
    st.add_history("gm", text)
    return text


# ── 场景记录 ──
CHECK_FAILS = []
_report_lines = []
idx = 0


def scene(title, player_input, engine_text, checks, ok_asserts, extra_state=""):
    """记录一个场景：打印 + 写入报告（nr_state 为当前会话状态）"""
    for name, cond in ok_asserts:
        if not cond:
            CHECK_FAILS.append(f"{title}: {name}")
    t0 = time.time()
    ai_text = gm_narrate(nr_state, player_input, engine_text, checks)
    cost_sec = time.time() - t0
    lines = [
        f"## 场景 {idx}：{title}",
        "",
        f"- **玩家输入**：{player_input}",
    ]
    for name, cond in ok_asserts:
        lines.append(f"- **断言 {'✓' if cond else '✗'}** {name}")
    lines += [
        f"- **引擎检定**：{checks if checks else '无'}",
        f"- **引擎播报（事实）**：{engine_text}",
        f"- **GM 输出**：{ai_text}",
        f"- **GM 回复耗时**：{cost_sec:.1f} 秒",
    ]
    if extra_state:
        lines.append(f"- **状态**：{extra_state}")
    lines += ["", "---", ""]
    _report_lines.extend(lines)
    print("\n".join(lines))


def run_scene(title, player_input, setup, action):
    """setup(st) 构造状态；action(st) 执行引擎返回 (engine_text, checks, [(断言名, 是否), ...])"""
    global nr_state, idx, D20_TOTAL
    idx += 1
    # 重置可控掷骰（避免场景间残留）
    for k in TOTALS:
        TOTALS[k] = 99 if k == "stealth" else 30
    D20_TOTAL = None
    st = new_state()
    setup(st)
    engine_text, checks, ok_asserts = action(st)
    nr_state = st
    scene(title, player_input, engine_text, checks, ok_asserts)
    return st


def set_flagrante(st, total=13):
    TOTALS["sleight_of_hand"] = total
    return se.merchant_steal(st, "market-merchant", CHAR, item_id="rations", target="item")


def set_discovered(st, total=17):
    TOTALS["sleight_of_hand"] = total
    r = se.merchant_steal(st, "market-merchant", CHAR, item_id="rations", target="item")
    if r.get("delayed_suspicion"):
        st.set_suspicion(r["delayed_suspicion"]["npc_id"], r["delayed_suspicion"].get("item_ids", []),
                         gold_amount=r["delayed_suspicion"].get("gold_amount", 0), mode="discovered")
    return r


def enter_jail(st):
    st.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
    st.add_guard_to_scene()
    TOTALS["athletics"] = 1
    TOTALS["acrobatics"] = 1
    se.arrest_action(st, "breakout", CHAR)
    se.arrest_action(st, "", CHAR)


# ══════════════ 偷窃四情况 ══════════════

# 1. 潜行失败
def setup1(st):
    TOTALS["stealth"] = 1


def act1(st):
    r = se.merchant_steal(st, "market-merchant", CHAR, item_id="rations", target="item")
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("未得手", "rations" not in st.player_inventory),
        ("警觉+1", st.npc_alert("market-merchant") == 1),
        ("不进入对峙", not st.has_active_suspicion()),
        ("未通缉", st.wanted_location is None),
    ]


run_scene("1 潜行失败（未得手 警觉+1）", "我偷汉斯的干粮", setup1, act1)

# 2. 情况一：巧手失败
def setup2(st):
    TOTALS["sleight_of_hand"] = 1


def act2(st):
    r = se.merchant_steal(st, "market-merchant", CHAR, item_id="rations", target="item")
    return r["message"], [r["check"]], [
        ("case=1", r["case"] == 1 and not r["success"]),
        ("警觉+2", st.npc_alert("market-merchant") == 2),
        ("转敌对", st.is_hostile("market-merchant")),
        ("未得手", "rations" not in st.player_inventory),
        ("不进入对峙", not st.has_active_suspicion()),
    ]


run_scene("2 情况一：巧手失败（警觉+2 敌对 骂人）", "我偷汉斯的干粮", setup2, act2)

# 3. 情况二 flagrante → pay 赔偿×2
def setup3(st):
    set_flagrante(st)


def act3(st):
    was_flagrante = (st.get_suspicion("market-merchant") or {}).get("mode") == "flagrante"
    r = se.resolve_suspicion_action(st, "market-merchant", "pay", CHAR)
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("之前是 flagrante 状态", was_flagrante),
        ("赔偿×2=10", gold(st) == 290),
        ("清 suspicion", not st.has_active_suspicion()),
    ]


run_scene("3 情况二 flagrante：赔偿×2 了结", "我认栽，赔钱！", setup3, act3)

# 4. 情况二 flagrante → 欺瞒成功
def setup4(st):
    set_flagrante(st)


def act4(st):
    TOTALS["deception"] = 30  # DC=15+1=16
    r = se.resolve_suspicion_action(st, "market-merchant", "deception", CHAR)
    return r["message"], [r["check"]], [("欺瞒成功放行", not st.has_active_suspicion())]


run_scene("4 情况二 flagrante：欺瞒成功放行", "这干粮是我刚才在你摊上买的，你记错了吧？", setup4, act4)

# 5. 情况二 flagrante → 欺瞒失败
def setup5(st):
    set_flagrante(st)


def act5(st):
    TOTALS["deception"] = 1
    r = se.resolve_suspicion_action(st, "market-merchant", "deception", CHAR)
    return r["message"], [r["check"]], [("欺瞒失败保持对峙", st.has_active_suspicion())]


run_scene("5 情况二 flagrante：欺瞒失败（保持对峙）", "这干粮是我刚才买的，你搞错了！", setup5, act5)

# 6. 情况二 flagrante → 威吓成功
def setup6(st):
    set_flagrante(st)


def act6(st):
    TOTALS["intimidation"] = 30  # DC=12+1=13
    r = se.resolve_suspicion_action(st, "market-merchant", "intimidation", CHAR)
    return r["message"], [r["check"]], [("威吓成功放行", not st.has_active_suspicion())]


run_scene("6 情况二 flagrante：威吓成功放行", "你敢动我一下试试？我大哥可是矿工会的！", setup6, act6)

# 7. 情况二 flagrante → 挣脱成功 → 敏捷逃脱成功 → 通缉
def setup7(st):
    set_flagrante(st)


def act7(st):
    r1 = se.resolve_suspicion_action(st, "market-merchant", "flee", CHAR)  # 挣脱
    r2 = se.resolve_suspicion_action(st, "market-merchant", "flee", CHAR)  # 敏捷逃脱
    checks = [c for c in ([r1["check"]] if r1.get("check") else []) + ([r2["check"]] if r2.get("check") else [])]
    return r2["message"], checks, [
        ("挣脱成功", "甩开" in r1["message"]),
        ("逃脱+通缉", "neverwinter-market" in st.wanted_location),
        ("传送离开", st.location_id != "neverwinter-market"),
        ("无卫兵", not st.has_active_arrest()),
    ]


run_scene("7 情况二 flagrante：挣脱→敏捷逃脱→通缉", "我挣脱他，逃跑！", setup7, act7)

# 8. 情况二 flagrante → 挣脱成功 → 敏捷逃脱失败 → 被抓叫卫兵
def setup8(st):
    set_flagrante(st)


def act8(st):
    global D20_TOTAL
    D20_TOTAL = 1  # 敏捷检定 1+2=3 < DC9 → 逃脱失败
    r1 = se.resolve_suspicion_action(st, "market-merchant", "flee", CHAR)  # 挣脱成功
    r2 = se.resolve_suspicion_action(st, "market-merchant", "flee", CHAR)  # 敏捷逃脱失败
    D20_TOTAL = None
    checks = [c for c in ([r1["check"]] if r1.get("check") else []) + ([r2["check"]] if r2.get("check") else [])]
    return r2["message"], checks, [
        ("挣脱成功", "甩开" in r1["message"]),
        ("逃脱失败被抓", "扑住" in r2["message"]),
        ("卫兵赶来中", st.has_active_arrest() and st.arrest["phase"] == "summoned"),
    ]


run_scene("8 情况二 flagrante：挣脱→敏捷逃脱失败→被抓叫卫兵", "我挣脱他，逃跑！", setup8, act8)

# 9. 情况二 flagrante → 挣脱失败 → 被抓住 → 叫卫兵
def setup9(st):
    set_flagrante(st)
    TOTALS["athletics"] = 1
    TOTALS["acrobatics"] = 1


def act9(st):
    r = se.resolve_suspicion_action(st, "market-merchant", "flee", CHAR)
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("进入 caught", st.is_caught() and st.caught["breakout_used"] == 1),
        ("叫卫兵 summoned", st.has_active_arrest() and st.arrest["phase"] == "summoned"),
        ("清 suspicion", not st.has_active_suspicion()),
    ]


run_scene("9 情况二 flagrante：挣脱失败→被抓住→叫卫兵", "我拼命挣脱！", setup9, act9)

# 10. 情况三：无事发生
def setup10(st):
    TOTALS["sleight_of_hand"] = 30


def act10(st):
    r = se.merchant_steal(st, "market-merchant", CHAR, item_id="rations", target="item")
    return r["message"], [r["check"]], [
        ("case=3", r["case"] == 3),
        ("得手", "rations" in st.player_inventory),
        ("无对峙", not st.has_active_suspicion()),
    ]


run_scene("10 情况三：偷了无事发生", "我悄悄摸走汉斯的干粮", setup10, act10)

# 11. 情况四 discovered → 同意搜身 搜出×2
def setup11(st):
    set_discovered(st)


def act11(st):
    r = se.resolve_suspicion_action(st, "market-merchant", "search", CHAR)
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("搜出×2=10", gold(st) == 290),
        ("清 suspicion", not st.has_active_suspicion()),
    ]


run_scene("11 情况四 discovered：同意搜身 搜出×2", "行行行，你搜吧", setup11, act11)

# 12. 情况四 discovered → 给钱承认 ×2
def setup12(st):
    set_discovered(st)


def act12(st):
    r = se.resolve_suspicion_action(st, "market-merchant", "pay", CHAR)
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("承认赔×2=10", gold(st) == 290),
        ("清 suspicion", not st.has_active_suspicion()),
    ]


run_scene("12 情况四 discovered：给钱承认×2", "是我拿的，我赔钱", setup12, act12)

# 13. 情况四 discovered → 游说成功
def setup13(st):
    set_discovered(st)


def act13(st):
    TOTALS["persuasion"] = 30  # DC=12+1=13
    r = se.resolve_suspicion_action(st, "market-merchant", "persuasion", CHAR)
    return r["message"], [r["check"]], [("游说成功放行", not st.has_active_suspicion())]


run_scene("13 情况四 discovered：游说成功放行", "这位大哥，我绝没偷你东西，一定是误会", setup13, act13)

# 14. 情况四 discovered → 游说失败 → 强制搜身×3
def setup14(st):
    set_discovered(st)


def act14(st):
    TOTALS["persuasion"] = 1
    r1 = se.resolve_suspicion_action(st, "market-merchant", "persuasion", CHAR)
    sus = st.get_suspicion("market-merchant")
    social_failed = bool(sus and sus.get("social_failed"))
    r2 = se.resolve_suspicion_action(st, "market-merchant", "search", CHAR)
    checks = [c for c in ([r1["check"]] if r1.get("check") else []) + ([r2["check"]] if r2.get("check") else [])]
    return r2["message"], checks, [
        ("社交失败标记", social_failed),
        ("强制搜身×3=15", gold(st) == 285),
    ]


run_scene("14 情况四 discovered：游说失败→强制搜身×3", "我真没偷！……好吧好吧，搜吧", setup14, act14)

# 15. 情况四 discovered → 逃跑 敏捷逃脱 → 通缉
def setup15(st):
    set_discovered(st)


def act15(st):
    r = se.resolve_suspicion_action(st, "market-merchant", "flee", CHAR)
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("逃脱+通缉", "neverwinter-market" in st.wanted_location),
        ("清 suspicion", not st.has_active_suspicion()),
    ]


run_scene("15 情况四 discovered：逃跑 敏捷逃脱+通缉", "我不跟你说了，跑！", setup15, act15)

# 16. 情况四 discovered → 拒绝 → 叫卫兵
def setup16(st):
    set_discovered(st)


def act16(st):
    r = se.resolve_suspicion_action(st, "market-merchant", "refuse", CHAR)
    return r["message"], [], [
        ("拒绝叫卫兵 summoned", st.has_active_arrest() and st.arrest["phase"] == "summoned"),
        ("清 suspicion", not st.has_active_suspicion()),
    ]


run_scene("16 情况四 discovered：拒绝→叫卫兵（赶来中）", "我没偷，我凭什么让你搜！叫卫兵就叫卫兵！", setup16, act16)

# 17. 钱袋偷窃（10%）
def setup17(st):
    TOTALS["sleight_of_hand"] = 30


def act17(st):
    r = se.merchant_steal(st, "market-merchant", CHAR, target="gold")
    return r["message"], [r["check"]], [
        ("偷到10%金币", r["success"] and r["stolen_amount"] >= 1),
        ("金币入袋", gold(st) > 300),
    ]


run_scene("17 钱袋偷窃：商人金币10%（成功无事）", "我偷汉斯钱袋里的金币", setup17, act17)

# 18. 场景物品：克拉格钱袋 notice_chance 败露 → discovered
def setup18(st):
    st.location_id = "cragmaw-hideout-boss"


def act18(st):
    _orig = se.random.random
    se.random.random = lambda: 0.1  # 必触发 notice_chance 0.4
    try:
        item = st.data["items"]["klargs-coinpurse"]
        rule, changes = se.scene_item_steal(st, "klarg", CHAR, item, "klargs-coinpurse")
    finally:
        se.random.random = _orig
    return rule.get("gm_text"), [], [
        ("败露→delayed", rule.get("delayed_suspicion") is not None),
        ("得手 move_item", any(c["type"] == "move_item" for c in changes)),
    ]


run_scene("18 场景物品：克拉格钱袋 notice_chance 败露→延迟发现", "我偷克拉格的钱袋", setup18, act18)

# 19. 场景物品：plot_critical 必败露
def setup19(st):
    st.location_id = "cragmaw-hideout-boss"


def act19(st):
    item = st.data["items"]["gundrens-map"]
    rule, changes = se.scene_item_steal(st, "klarg", CHAR, item, "gundrens-map")
    return rule.get("gm_text"), [], [
        ("plot_critical 必败露", rule.get("delayed_suspicion") is not None),
        ("NPC 失窃记忆", any(c["type"] == "add_memory" for c in changes)),
    ]


run_scene("19 场景物品：甘德伦地图 plot_critical 必败露", "我偷走克拉格桌上甘德伦的地图", setup19, act19)

# ══════════════ 卫兵流程 ══════════════

def caught_summoned(st):
    """构造：情况二挣脱失败 → caught + 卫兵赶来中（固定轮数避免随机影响断言）"""
    set_flagrante(st)
    TOTALS["athletics"] = 1
    TOTALS["acrobatics"] = 1
    se.resolve_suspicion_action(st, "market-merchant", "flee", CHAR)
    st.arrest["rounds_left"] = 3


# 20. 赶来中：pay ×3 私了
def setup20(st):
    caught_summoned(st)


def act20(st):
    r = se.arrest_action(st, "pay", CHAR)
    return r["message"], [], [
        ("赶来中赔偿×3=15", gold(st) == 285),
        ("结束", not st.has_active_arrest()),
    ]


run_scene("20 卫兵赶来中：谈判赔偿×3 私了", "我同意赔偿，别叫卫兵了", setup20, act20)

# 21. 赶来中：社交成功
def setup21(st):
    caught_summoned(st)


def act21(st):
    TOTALS["persuasion"] = 30  # DC=15+1=16
    r = se.arrest_action(st, "persuasion", CHAR)
    return r["message"], [r["check"]], [("社交成功私了", not st.has_active_arrest())]


run_scene("21 卫兵赶来中：游说成功私了", "这是一场误会，让我解释给你听……", setup21, act21)

# 22. 赶来中：社交失败
def setup22(st):
    caught_summoned(st)


def act22(st):
    TOTALS["deception"] = 1
    r = se.arrest_action(st, "deception", CHAR)
    return r["message"], [r["check"]], [("社交失败保持赶来中", st.has_active_arrest() and st.arrest["phase"] == "summoned")]


run_scene("22 卫兵赶来中：社交失败（保持）", "我没偷，这是误会！", setup22, act22)

# 23. 赶来中：flee 敏捷逃脱成功 → 通缉
def setup23(st):
    caught_summoned(st)


def act23(st):
    r = se.arrest_action(st, "flee", CHAR)
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("逃脱+通缉", "neverwinter-market" in st.wanted_location),
        ("结束", not st.has_active_arrest()),
    ]


run_scene("23 卫兵赶来中：逃跑 敏捷逃脱+通缉", "趁卫兵没到，快跑！", setup23, act23)

# 24. 赶来中：第2次挣脱成功 → 再逃跑逃脱
def setup24(st):
    caught_summoned(st)


def act24(st):
    TOTALS["athletics"] = 30
    TOTALS["acrobatics"] = 30
    r1 = se.arrest_action(st, "breakout", CHAR)  # 第2次挣脱（DC 更高）
    r2 = se.arrest_action(st, "flee", CHAR)
    checks = [c for c in ([r1["check"]] if r1.get("check") else []) + ([r2["check"]] if r2.get("check") else [])]
    return r2["message"], checks, [
        ("第2次挣脱成功", not st.is_caught()),
        ("逃脱+通缉", "neverwinter-market" in st.wanted_location),
    ]


run_scene("24 卫兵赶来中：第2次挣脱→敏捷逃脱+通缉", "我使劲挣脱，然后逃跑！", setup24, act24)

# 25. 到场：主动同意搜身 ×3
def setup25(st):
    st.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
    st.add_guard_to_scene()


def act25(st):
    r = se.arrest_action(st, "search", CHAR)
    return r["message"], [], [
        ("搜身×3=15", gold(st) == 285),
        ("没收赃物", "rations" not in st.player_inventory),
        ("结束", not st.has_active_arrest()),
    ]


run_scene("25 卫兵到场：主动同意搜身×3", "行，卫兵大哥，你搜吧", setup25, act25)

# 26. 到场：社交 DC18 成功
def setup26(st):
    st.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
    st.add_guard_to_scene()


def act26(st):
    TOTALS["persuasion"] = 30
    r = se.arrest_action(st, "persuasion", CHAR)
    return r["message"], [r["check"]], [("DC18 社交成功", not st.has_active_arrest())]


run_scene("26 卫兵到场：社交 DC18 成功化解", "卫兵大人，这真是误会，干粮是我自己买的", setup26, act26)

# 27. 到场：社交失败
def setup27(st):
    st.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
    st.add_guard_to_scene()


def act27(st):
    TOTALS["persuasion"] = 1
    r = se.arrest_action(st, "persuasion", CHAR)
    return r["message"], [r["check"]], [("社交失败保持到场", st.has_active_arrest() and st.arrest["phase"] == "arrived")]


run_scene("27 卫兵到场：社交失败（保持）", "我真是冤枉的！", setup27, act27)

# 28. 到场：挣脱成功 → 敏捷逃脱 → 通缉
def setup28(st):
    st.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
    st.add_guard_to_scene()
    TOTALS["athletics"] = 30
    TOTALS["acrobatics"] = 30


def act28(st):
    r = se.arrest_action(st, "breakout", CHAR)
    return r["message"], [r["check"]] if r.get("check") else [], [
        ("逃脱+通缉", "neverwinter-market" in st.wanted_location),
        ("结束", not st.has_active_arrest()),
    ]


run_scene("28 卫兵到场：挣脱→敏捷逃脱+通缉", "我挣开卫兵逃跑！", setup28, act28)

# 29. 到场：挣脱失败 → 被按死 → 进监狱
def setup29(st):
    st.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
    st.add_guard_to_scene()
    TOTALS["athletics"] = 1
    TOTALS["acrobatics"] = 1


def act29(st):
    r1 = se.arrest_action(st, "breakout", CHAR)
    r2 = se.arrest_action(st, "", CHAR)  # 被按死后任意输入 → 罚金+进监狱
    checks = [c for c in ([r1["check"]] if r1.get("check") else []) + ([r2["check"]] if r2.get("check") else [])]
    return r2["message"], checks, [
        ("挣脱失败被按死", st.arrest["phase"] == "jailed"),
        ("罚金×3=15", gold(st) == 285),
        ("没收赃物", "rations" not in st.player_inventory),
        ("进监狱", st.location_id == "neverwinter-jail"),
    ]


run_scene("29 卫兵到场：挣脱失败→被按死→进监狱", "我挣扎！……", setup29, act29)

# ══════════════ 监狱 ══════════════

# 30. 保释金够 → 释放
def setup30(st):
    st.character["inventory"]["gold"] = 300
    enter_jail(st)  # 罚金15 → 285


def act30(st):
    r = se.arrest_action(st, "pay", CHAR)
    return r["message"], [], [
        ("保释100释放", not st.has_active_arrest() and gold(st) == 185),
        ("传回原地点", st.location_id == "neverwinter-market"),
        ("不+8时间", st.game_time == 0),
    ]


run_scene("30 监狱：交保释金100G 释放（不+8时间）", "我交保释金！", setup30, act30)

# 31. 保释金不够
def setup31(st):
    st.character["inventory"]["gold"] = 100
    enter_jail(st)  # 罚金15 → 85


def act31(st):
    r = se.arrest_action(st, "pay", CHAR)
    return r["message"], [], [
        ("保释金不够不释放", st.has_active_arrest() and st.arrest["phase"] == "jailed"),
        ("提示金额", "不够" in r["message"]),
    ]


run_scene("31 监狱：保释金不够（85<100）", "我交保释金出去", setup31, act31)

# 32. 蹲夜服刑 → 释放
def setup32(st):
    enter_jail(st)


def act32(st):
    r = se.arrest_action(st, "serve", CHAR)
    return r["message"], [], [
        ("蹲夜释放", not st.has_active_arrest()),
        ("game_time+8", st.game_time == 8),
        ("传回原地点", st.location_id == "neverwinter-market"),
    ]


run_scene("32 监狱：蹲夜服刑（game_time+8）释放", "我认了，蹲夜服刑", setup32, act32)

# 33. 狱卒在场不能撬锁
def setup33(st):
    enter_jail(st)
    st.arrest["jail_guard"] = "present"


def act33(st):
    r = se.arrest_action(st, "pick_lock", CHAR)
    return r["message"], [], [("狱卒在场拒绝撬锁", st.arrest["cell_open"] is False)]


run_scene("33 监狱：狱卒在场时撬锁被拒", "我趁狱卒不注意撬锁", setup33, act33)

# 34. 撬锁成功 → 越狱 → 通缉
def setup34(st):
    enter_jail(st)
    st.arrest["guard_until"] = time.time() - 1
    se.arrest_action(st, "wait", CHAR)  # 狱卒去巡逻
    st.arrest["guard_away_left"] = 3


def act34(st):
    TOTALS["sleight_of_hand"] = 30  # ≥14 成功
    r1 = se.arrest_action(st, "pick_lock", CHAR)
    r2 = se.jail_escape(st)
    return r2["message"], [], [
        ("撬锁成功牢门开", (st.arrest or {}).get("cell_open") is True or r2.get("ok")),
        ("越狱成功+通缉", r2["ok"] and "neverwinter-jail" in st.wanted_location and st.location_id == "neverwinter-market"),
    ]


run_scene("34 监狱：撬锁成功→越狱→通缉（监狱区）", "咔哒……锁开了！点击监狱大门！", setup34, act34)

# 35. 撬锁失败惊动狱卒
def setup35(st):
    enter_jail(st)
    st.arrest["guard_until"] = time.time() - 1
    se.arrest_action(st, "wait", CHAR)
    st.arrest["guard_away_left"] = 3


def act35(st):
    TOTALS["sleight_of_hand"] = 8  # ≤9 → 惊动
    r = se.arrest_action(st, "pick_lock", CHAR)
    return r["message"], [], [
        ("惊动狱卒", st.arrest["jail_guard"] == "present" and "惊动" in r["message"]),
    ]


run_scene("35 监狱：撬锁失败惊动狱卒（提前回来+警告）", "我撬锁……（手一抖）", setup35, act35)

# 36. 撬锁失败无声可再试
def setup36(st):
    enter_jail(st)
    st.arrest["guard_until"] = time.time() - 1
    se.arrest_action(st, "wait", CHAR)
    st.arrest["guard_away_left"] = 3


def act36(st):
    TOTALS["sleight_of_hand"] = 10  # 10-13 → 无声失败
    r = se.arrest_action(st, "pick_lock", CHAR)
    return r["message"], [], [
        ("无声失败可再试", st.arrest["jail_guard"] == "away" and st.arrest["cell_open"] is False),
    ]


run_scene("36 监狱：撬锁失败（无声，狱卒不察觉）", "我再撬一次试试……", setup36, act36)

# 37. 越狱被强制关回
def setup37(st):
    enter_jail(st)
    st.arrest["guard_until"] = time.time() - 1
    se.arrest_action(st, "wait", CHAR)
    st.arrest["guard_away_left"] = 2  # 撬锁(1轮)后仍away，越狱(1轮)耗尽


def act37(st):
    TOTALS["sleight_of_hand"] = 30
    r1 = se.arrest_action(st, "pick_lock", CHAR)
    r2 = se.jail_escape(st)
    return r2["message"], [], [
        ("越狱遇狱卒回来强制关回", r2["ok"] is False and st.arrest["cell_open"] is False and st.arrest["jail_guard"] == "present"),
    ]


run_scene("37 监狱：越狱时狱卒刚好回来→强制关回", "点击监狱大门！（但狱卒巡逻回来了）", setup37, act37)

# ══════════════ 汇总 ══════════════
print("\n" + "=" * 70)
print(f"共 {idx} 个场景")
if CHECK_FAILS:
    print(f"自动断言失败 {len(CHECK_FAILS)} 项：")
    for f in CHECK_FAILS:
        print("  ✗", f)
else:
    print("自动断言全部通过（逻辑层面无异常）")
print("注意：GM 叙事为真实 AI 输出，是否与引擎事实一致需人工对照")

with open(REPORT, "w", encoding="utf-8") as fp:
    fp.write("# 偷窃与监狱 端到端测试记录\n\n")
    fp.write(f"**测试日期**：2026-08-14  \n")
    fp.write(f"**测试方式**：可控掷骰（确定性覆盖全部分支）+ 真实 AI GM 叙事（{os.getenv('DEEPSEEK_MODEL', '?')}）  \n")
    fp.write("**覆盖**：偷窃四情况（潜行/情况一二三四）、钱袋、场景物品（notice_chance/plot_critical）、"
             "卫兵流程（赶来中/到场/被按死）、监狱（保释/蹲夜/撬锁三档/越狱/强制关回）\n")
    fp.write("**耗时**：各场景 GM 回复耗时见对应条目（AI 单轮叙事耗时，不含引擎结算）\n\n")
    fp.write("\n".join(_report_lines))
    fp.write("\n\n---\n\n## 汇总\n\n")
    fp.write(f"- 场景数：{idx}\n")
    fp.write(f"- 自动断言失败：{len(CHECK_FAILS)}\n")
    for f in CHECK_FAILS:
        fp.write(f"  - ✗ {f}\n")
    fp.write("\n> 注：GM 叙事为真实 AI 输出，是否与引擎事实（金币/物品/状态）一致需人工对照检查。\n")

print(f"\n报告已写入：{REPORT}")
