"""盗窃引擎确定性测试（四情况分档 + 挣脱/逃脱 + 卫兵流程 + 监狱 + 通缉 + 潜行）"""
import time
import services.core.steal_engine as se
from services.core.game_state import GameState, load_adventure_chapter
from services.ai.intent_dispatch import RuleEngine
from services.core.rules import witness_stealth_dc

CHAR = {
    "name": "测试者",
    "abilities": {"dex": {"value": 14}, "str": {"value": 14}, "cha": {"value": 12}},
    "inventory": {"gold": 100},
}

# 可控掷骰：按技能指定 total；escape 用 roll_d20
TOTALS = {"stealth": 99, "sleight_of_hand": 20, "athletics": 20, "acrobatics": 20}


def fake_skill(skill, character, dc):
    total = TOTALS.get(skill, dc + 5)
    return {"roll": total, "modifier": 0, "total": total, "skill": skill,
            "ability": "dex", "dc": dc, "success": total >= dc}


def fake_d20(mod=0):
    return {"roll": 10, "modifier": mod, "total": 10 + mod}


se.roll_skill_check = fake_skill
se.roll_d20 = fake_d20


def new_state():
    data = load_adventure_chapter("lost-mine-of-phandelver", "ch1")
    scene = data["chapter"]["scenes"][0]
    st = GameState("lost-mine-of-phandelver", "ch1", data, scene)
    st.location_id = "neverwinter-market"  # 市场：汉斯(str8/dex12) + 格罗斯(str14/dex8)
    st.character = CHAR
    return st


PASS = []
def ok(name, cond):
    PASS.append((name, cond))
    print(("  ✓ " if cond else "  ✗ ") + name)


# ── 情况一：巧手失败 → 不进入对峙，警觉+2、敌对 ──
s = new_state()
TOTALS["sleight_of_hand"] = 1  # dc=12 → 失败
r = se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
ok("情况一 case=1", r["case"] == 1 and r["success"] is False)
ok("情况一不设 suspicion", not s.has_active_suspicion())
ok("情况一警觉+2", s.npc_alert("market-merchant") == 2)
ok("情况一转敌对", s.is_hostile("market-merchant"))
ok("情况一未得手", "rations" not in s.player_inventory)

# ── 情况二：margin<3 → flagrante 立即对峙；挣脱成功 → 再逃脱 → 通缉 ──
s = new_state()
TOTALS["sleight_of_hand"] = 13  # dc=12 → margin=1 < 3
r = se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
ok("情况二 case=2 得手", r["case"] == 2 and r["success"] and "rations" in s.player_inventory)
sus = s.get_suspicion("market-merchant")
ok("情况二 flagrante 对峙", sus is not None and sus["mode"] == "flagrante")
ok("情况二 grappled 初始为真", sus["grappled"] is True)
# 挣脱（第 1 次，vs 商人力量 str8 → DC=8+(-1)=7）
rr = se.resolve_suspicion_action(s, "market-merchant", "flee", CHAR)
ok("挣脱成功 grappled=False", s.get_suspicion("market-merchant") is not None and s.get_suspicion("market-merchant")["grappled"] is False)
ok("挣脱未叫卫兵", not s.has_active_arrest())
# 再逃跑 → 敏捷逃脱（汉斯 dex12 → DC=9）
before_loc = s.location_id
rr = se.resolve_suspicion_action(s, "market-merchant", "flee", CHAR)
ok("逃脱成功清 suspicion", not s.has_active_suspicion())
ok("逃脱成功 + 通缉", s.wanted_location == "neverwinter-market")
ok("逃脱成功传送离开", s.location_id != before_loc)
ok("逃脱后无卫兵", not s.has_active_arrest())

# ── 情况二挣脱失败 → 被抓住 → 叫卫兵（赶来中）──
s = new_state()
TOTALS["sleight_of_hand"] = 13
se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
TOTALS["athletics"] = 1
TOTALS["acrobatics"] = 1  # 运动/体操都低 → 挣脱失败
rr = se.resolve_suspicion_action(s, "market-merchant", "flee", CHAR)
ok("挣脱失败进 caught", s.is_caught() and s.caught["breakout_used"] == 1)
ok("挣脱失败叫卫兵 summoned", s.has_active_arrest() and s.arrest["phase"] == "summoned")
ok("挣脱失败清 suspicion", not s.has_active_suspicion())
# 赶来中第 2 次挣脱（更难：DC=8+(-1)+2=9），成功 → clear_caught
TOTALS["athletics"] = 20
TOTALS["acrobatics"] = 20
rr = se.arrest_action(s, "breakout", CHAR)
ok("赶来中第2次挣脱成功", not s.is_caught())
# 再逃跑脱身
rr = se.arrest_action(s, "flee", CHAR)
ok("赶来中逃跑逃脱+通缉", s.wanted_location == "neverwinter-market" and not s.has_active_arrest())

# ── 情况三：margin>6 → 无事发生 ──
s = new_state()
TOTALS["sleight_of_hand"] = 25  # margin=13 > 6
r = se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
ok("情况三 case=3 无事", r["case"] == 3 and r["success"])
ok("情况三无 suspicion", not s.has_active_suspicion())

# ── 情况四：margin 3~6 → discovered；同意搜身 ×2 ──
s = new_state()
TOTALS["sleight_of_hand"] = 17  # margin=5 → 情况四
r = se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
ok("情况四 case=4 delayed", r["case"] == 4 and r.get("delayed_suspicion"))
s.set_suspicion("market-merchant", r["delayed_suspicion"]["item_ids"],
                gold_amount=r["delayed_suspicion"].get("gold_amount", 0), mode="discovered")
gold0 = s.character["inventory"]["gold"]
rr = se.resolve_suspicion_action(s, "market-merchant", "search", CHAR)
gold1 = s.character["inventory"]["gold"]
ok("搜身搜出赔2倍(10)", rr["searched_out"] and (gold0 - gold1) == 10)
ok("搜身后清 suspicion", not s.has_active_suspicion())

# ── 情况四：社交失败 → 强制搜身 ×3 ──
s = new_state()
TOTALS["sleight_of_hand"] = 17
r = se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
s.set_suspicion("market-merchant", r["delayed_suspicion"]["item_ids"],
                gold_amount=r["delayed_suspicion"].get("gold_amount", 0), mode="discovered")
TOTALS["persuasion"] = 1  # 游说失败
rr = se.resolve_suspicion_action(s, "market-merchant", "persuasion", CHAR)
ok("社交失败进强制搜身", s.get_suspicion("market-merchant") is not None and s.get_suspicion("market-merchant")["social_failed"] is True)
gold0 = s.character["inventory"]["gold"]
rr = se.resolve_suspicion_action(s, "market-merchant", "search", CHAR)
gold1 = s.character["inventory"]["gold"]
ok("强制搜身赔3倍(15)", rr["searched_out"] and (gold0 - gold1) == 15)

# ── 情况四：拒绝 → 叫卫兵；赶来中赔钱私了 ×3 ──
s = new_state()
TOTALS["sleight_of_hand"] = 17
r = se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
s.set_suspicion("market-merchant", r["delayed_suspicion"]["item_ids"],
                gold_amount=r["delayed_suspicion"].get("gold_amount", 0), mode="discovered")
rr = se.resolve_suspicion_action(s, "market-merchant", "refuse", CHAR)
ok("拒绝叫卫兵 summoned", s.has_active_arrest() and s.arrest["phase"] == "summoned" and s.arrest["rounds_left"] >= 1)
gold0 = s.character["inventory"]["gold"]
rr = se.arrest_action(s, "pay", CHAR)
gold1 = s.character["inventory"]["gold"]
ok("赶来中赔偿×3(15，统一按货架价5)", (gold0 - gold1) == 15 and not s.has_active_arrest())

# ── 卫兵到场：挣脱成功 → 敏捷逃脱；失败 → 被按死 → 监狱 ──
s = new_state()
s.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
s.add_guard_to_scene()
TOTALS["athletics"] = 20
rr = se.arrest_action(s, "breakout", CHAR)
ok("到场挣脱成功逃脱+通缉", s.wanted_location == "neverwinter-market" and not s.has_active_arrest())

s = new_state()
s.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
s.add_guard_to_scene()
TOTALS["athletics"] = 1
TOTALS["acrobatics"] = 1  # 都低 → 挣脱失败被按死
rr = se.arrest_action(s, "breakout", CHAR)
ok("到场挣脱失败被按死", s.arrest["phase"] == "arrested")
gold0 = s.character["inventory"]["gold"]
rr = se.arrest_action(s, "", CHAR)  # 被按死后任意输入 → 赔偿×3 + 进监狱
gold1 = s.character["inventory"]["gold"]
ok("被按死赔偿×3(15，统一按货架价5)", (gold0 - gold1) == 15)
ok("被按死没收赃物", "rations" not in s.player_inventory)
ok("被按死进监狱 jailed", s.arrest["phase"] == "jailed")
rr = se.arrest_action(s, "serve", CHAR)  # 蹲夜服刑
ok("监狱蹲夜释放", not s.has_active_arrest() and s.game_time == 8)

# ── 监狱流程：传送/狱卒巡逻/撬锁分档/保释金/越狱 ──
def enter_jail(st):
    """把测试角色弄进监狱（被按死 → jailed）"""
    st.set_arrest("market-merchant", ["rations"], 0, phase="arrived")
    st.add_guard_to_scene()
    TOTALS["athletics"] = 1
    TOTALS["acrobatics"] = 1
    se.arrest_action(st, "breakout", CHAR)
    se.arrest_action(st, "", CHAR)

s = new_state()
enter_jail(s)
ok("进监狱传送", s.location_id == "neverwinter-jail" and s.arrest["phase"] == "jailed")
ok("狱卒在场+返回地点记录", s.arrest["jail_guard"] == "present" and s.arrest["return_location"] == "neverwinter-market")
# 狱卒在场不能撬锁
TOTALS["sleight_of_hand"] = 20
rr = se.arrest_action(s, "pick_lock", CHAR)
ok("狱卒在场不能撬锁", s.arrest["cell_open"] is False and "没法下手" in rr["message"])
# 倒计时到点 → 狱卒去巡逻（away）
s.arrest["guard_until"] = time.time() - 1
rr = se.arrest_action(s, "wait", CHAR)
ok("倒计时到点狱卒去巡逻", s.arrest["jail_guard"] == "away")
# 撬锁失败且差 5 点内（total=10 < DC14，10 > 9）→ 无声失败可再试
s.arrest["guard_away_left"] = 3
TOTALS["sleight_of_hand"] = 10
rr = se.arrest_action(s, "pick_lock", CHAR)
ok("撬锁失败无声可再试", s.arrest["cell_open"] is False and s.arrest["jail_guard"] == "away")
# 撬锁失败差 5 点以上（total=8 ≤ 9）→ 惊动狱卒提前回来
TOTALS["sleight_of_hand"] = 8
rr = se.arrest_action(s, "pick_lock", CHAR)
ok("撬锁失败惊动狱卒", s.arrest["cell_open"] is False and s.arrest["jail_guard"] == "present" and "惊动" in rr["message"])
# 再次等巡逻 + 撬锁成功 → 牢门开
s.arrest["guard_until"] = time.time() - 1
se.arrest_action(s, "wait", CHAR)
s.arrest["guard_away_left"] = 3
TOTALS["sleight_of_hand"] = 20
rr = se.arrest_action(s, "pick_lock", CHAR)
ok("撬锁成功牢门开", s.arrest["cell_open"] is True)
# 越狱成功：通缉 + 传送到市场 + 清状态
rr = se.jail_escape(s)
ok("越狱成功通缉+传送", rr["ok"] and s.wanted_location == "neverwinter-jail" and s.location_id == "neverwinter-market" and not s.has_active_arrest())

# ── 越狱被强制关回：撬完锁狱卒刚好回来 ──
s = new_state()
s.character["inventory"]["gold"] = 200
enter_jail(s)
s.arrest["guard_until"] = time.time() - 1
se.arrest_action(s, "wait", CHAR)
s.arrest["guard_away_left"] = 2  # 巡逻 2 轮：撬锁(1轮) 后仍 away，越狱(1轮) 时耗尽
TOTALS["sleight_of_hand"] = 20
se.arrest_action(s, "pick_lock", CHAR)  # tick: 2-1=1 仍 away → 撬锁成功
ok("撬锁成功牢门开(越狱窗口)", s.arrest["cell_open"] is True)
rr = se.jail_escape(s)  # 越狱行动 tick: 1-1=0 → 狱卒回来 → 强制关回
ok("越狱遇狱卒回来被关回", rr["ok"] is False and s.arrest["cell_open"] is False and s.arrest["jail_guard"] == "present")

# ── 保释金：够 → 释放（不 +8 时间）；不够 → 不释放 ──
s = new_state()
s.character["inventory"]["gold"] = 200
enter_jail(s)
gold0 = s.character["inventory"]["gold"]  # 200 - 15(罚金) = 185
rr = se.arrest_action(s, "pay", CHAR)
ok("保释金100释放", not s.has_active_arrest() and s.character["inventory"]["gold"] == gold0 - 100 and s.game_time == 0)
ok("保释释放传回原地点", s.location_id == "neverwinter-market")
s = new_state()
enter_jail(s)
rr = se.arrest_action(s, "pay", CHAR)  # 100 - 15 = 85 < 100
ok("保释金不够不释放", s.has_active_arrest() and s.arrest["phase"] == "jailed" and "不够" in rr["message"])

# ── 情况四 5 秒反应期：逃跑成功 → 无卫兵、通缉 ──
s = new_state()
TOTALS["sleight_of_hand"] = 17
r = se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item")
s.set_suspicion("market-merchant", r["delayed_suspicion"]["item_ids"],
                gold_amount=r["delayed_suspicion"].get("gold_amount", 0), mode="discovered")
rr = se.resolve_suspicion_action(s, "market-merchant", "flee", CHAR)
ok("情况四逃跑逃脱+通缉", s.wanted_location == "neverwinter-market" and not s.has_active_suspicion() and not s.has_active_arrest())

# ── 场景物品（有主物）：克拉格钱袋（notice_chance=0.4）——保留 notice_chance 判定 ──
import random as _random
s = new_state()
s.location_id = "cragmaw-hideout-boss"
item = s.data["items"]["klargs-coinpurse"]
_orig = se.random.random
se.random.random = lambda: 0.1  # 必触发 notice_chance
rule, changes = se.scene_item_steal(s, "klarg", CHAR, item, "klargs-coinpurse")
ok("场景物品败露 → delayed", rule.get("delayed_suspicion") is not None and rule["delayed_suspicion"]["npc_id"] == "klarg")
ok("场景物品得手 move_item", any(c["type"] == "move_item" for c in changes))
se.random.random = lambda: 0.9  # 不触发
rule, changes = se.scene_item_steal(s, "klarg", CHAR, item, "klargs-coinpurse")
ok("场景物品未败露 → 无事", rule.get("delayed_suspicion") is None)
se.random.random = _orig

# ── 场景物品 plot_critical（甘德伦的地图）必败露 ──
s = new_state()
s.location_id = "cragmaw-hideout-boss"
item = s.data["items"]["gundrens-map"]
rule, changes = se.scene_item_steal(s, "klarg", CHAR, item, "gundrens-map")
ok("plot_critical 必败露", rule.get("delayed_suspicion") is not None)

# ── 场景物品巧手失败 → 情况一（不进入对峙）──
s = new_state()
s.location_id = "cragmaw-hideout-boss"
TOTALS["sleight_of_hand"] = 1
rule, changes = se.scene_item_steal(s, "klarg", CHAR, item, "gundrens-map")
ok("场景物品失败无 suspicion", not s.has_active_suspicion() and s.is_hostile("klarg"))

# ── 统一计价：货架物品按货架售价（干粮5），场景物品按 value 字段（克拉格钱袋 15）──
s = new_state()
ok("统一计价·货架价优先", s.stolen_value(["rations"], 0, npc_id="market-merchant") == 5)
ok("统一计价·无货架按 value", s.stolen_value(["klargs-coinpurse"], 0) == 15)
ok("统一计价·无 value 缺省10", s.stolen_value(["gundrens-map"], 0) == 10)
ok("统一计价·加偷到金币", s.stolen_value(["rations"], 8, npc_id="market-merchant") == 13)
ok("统一计价·set_arrest 同步", (lambda st: (st.set_arrest("market-merchant", ["rations"], 0), st.arrest["stolen_value"] == 5))(s))

# ── 潜行：无需目标（通用隐匿）／指定目标均可 ──
class _FakeIntent:
    def __init__(self, target_id=""):
        self.target_id = target_id

# 引擎内 _roll_skill_check 统一走可控掷骰
_orig_roll = RuleEngine._roll_skill_check
def _fake_engine_roll(self, skill, character, dc):
    total = TOTALS.get(skill, dc + 5)
    return {"roll": total, "modifier": 0, "total": total, "skill": skill,
            "ability": "dex", "dc": dc, "success": total >= dc}
RuleEngine._roll_skill_check = _fake_engine_roll

s = new_state()
TOTALS["stealth"] = 99
rule, changes = RuleEngine(s.data, s.scene, state=s)._handle_stealth(_FakeIntent(""), CHAR)
ok("潜行无需目标·成功进通用隐匿", s.has_stealth("market-merchant") and s.has_stealth("blacksmith"))
ok("潜行无需目标·checks 播报", len(rule["checks"]) == 1 and rule["checks"][0]["skill"] == "stealth")
ok("通用潜行后偷窃跳过潜行判定", not se.merchant_steal(s, "market-merchant", CHAR, item_id="rations", target="item").get("stealth_blocked"))

s = new_state()
rule, changes = RuleEngine(s.data, s.scene, state=s)._handle_stealth(_FakeIntent("blacksmith"), CHAR)
ok("潜行指定目标·仅匹配该目标", s.has_stealth("blacksmith") and not s.has_stealth("market-merchant"))

s = new_state()
ok("通用潜行 DC 统计全部在场", witness_stealth_dc(s, None) == 12)  # 汉斯/格罗斯被动感知 12，非兜底 10
ok("指定目标潜行 DC 限同 sub", witness_stealth_dc(s, "blacksmith") == 12)

RuleEngine._roll_skill_check = _orig_roll

print()
failed = [n for n, c in PASS if not c]
print(f"共 {len(PASS)} 项，通过 {len(PASS) - len(failed)} 项" + ("" if not failed else f"，失败：{failed}"))
raise SystemExit(1 if failed else 0)
