"""冒险数据加载、查询与运行时状态管理"""
import json
import time
import uuid
import random
import copy
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[3]  # services/core → DND
ADVENTURES_DIR = BASE_DIR / "data" / "adventures"

# 内存会话存储（开发阶段使用，后续可替换为持久化存储）
_sessions: dict = {}


def _load_global_equipment_items() -> dict:
    """加载全局物品定义库（角色装备库 data/equipment/*.json），供场景引用的物品统一解析"""
    try:
        from utils.file_io import load_equipment_catalog
        return load_equipment_catalog()
    except Exception:
        return {}


def load_adventure_chapter(adventure_id: str, chapter_id: str) -> dict:
    """加载冒险章节的所有数据"""
    base = ADVENTURES_DIR / adventure_id
    chapter_dir = base / "chapters" / chapter_id

    def _load(path):
        if not path.exists():
            return {}
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    global_npcs = _load(base / "global" / "npcs.json")
    chapter_npcs = _load(chapter_dir / "npcs.json")

    return {
        "chapter": _load(chapter_dir / "chapter.json"),
        "locations": _load(chapter_dir / "locations.json").get("locations", {}),
        "npcs": {**global_npcs.get("npcs", {}), **chapter_npcs.get("npcs", {})},
        # 物品定义统一合并：全局物品库 + 章节物品（章节优先覆盖）。
        # 物品是否可用由场景/地点引用决定，而不是由是否"全局"决定。
        "items": {**_load_global_equipment_items(), **_load(chapter_dir / "items.json").get("items", {})},
        "quests": _load(chapter_dir / "quests.json").get("quests", {}),
        "encounters": _load(chapter_dir / "encounters.json").get("encounters", {}),
        "secrets": _load(chapter_dir / "secrets.json").get("secrets", {}),
    }


def load_chapter_summary(adventure_id: str, chapter_id: str) -> str:
    """加载章节摘要文本"""
    path = ADVENTURES_DIR / adventure_id / "chapters" / chapter_id / "summary.md"
    if not path.exists():
        return ""
    with open(path, encoding="utf-8") as f:
        return f.read()


def find_scene(data: dict, scene_id: str) -> dict | None:
    """在章节数据中查找场景"""
    scenes = data["chapter"].get("scenes", [])
    for s in scenes:
        if s["id"] == scene_id:
            return s
    return None


def get_location(data: dict, location_id: str) -> dict | None:
    return data["locations"].get(location_id)


class GameState:
    """运行时游戏状态"""

    def __init__(self, adventure_id: str, chapter_id: str, data: dict, scene: dict):
        self.adventure_id = adventure_id
        self.chapter_id = chapter_id
        self.data = data
        self.scene = scene
        self.location_id = scene.get("location") if scene else None
        self.last_full_context_location = None  # 上次发完整上下文的 location_id
        self.last_full_context_scene = None      # 上次发完整上下文的 scene_id
        self.npc_states = {}
        self.location_states = {}
        self.merchant_states = {}   # 商人运行时状态: {npc_id: {"gold": 动态金币}}
        self.player_inventory = []
        self.player_intel = []      # 玩家已收集的情报条目
        self.quest_states = {}
        self.game_time = 0
        self.history = []
        self.pending_events = []
        self.check_attempts: set = set()       # 每人每目标每技能: {"insight:gundren-rockseeker", ...}
        self.revealed_secrets: set = set()     # 已揭示的隐藏信息: {"location_id:secret_id", ...}
        self.npc_alerts: dict = {}             # NPC 警觉度: {npc_id: 次数}，偷窃 DC 随次数上升
        self.hostile_npcs: set = set()         # 已转为敌对（交易涨价）的 NPC id 集合
        self.suspicion: dict = {}              # 被怀疑（强制对话）状态: {npc_id: {"active", "mode", "item_ids", "detected_at", ...}}
        self.arrest: dict | None = None        # 卫兵/逮捕状态（phase 见 set_arrest）
        self.caught: dict = {}                 # 被抓住状态（情况二挣脱失败等进入）: {"active", "plaintiff", "breakout_used", "breakout_locked"}
        self.wanted_location: list | None = None  # 通缉区域（地点 id 列表；本次只做标记 + GM 播报，效果 P1 落地）
        self.merchant_theft: dict = {}         # 商人被偷记录: {npc_id: {item_id: 被偷数量}}
        self.player_stealth: dict = {}         # 潜行状态: {"active": bool, "npc_id": str, "dc": int}
        self.player_hp: dict = {}              # HP 状态（后端权威）: {"cur": N, "max": N}
        self.short_rests_left: int = 2         # 短休次数（长休重置为 2，BG3 式）
        self.short_rest_action_uses: dict = {} # 短休充能动作使用记录: {action_id: used_count}
        self.spell_slots_used: dict = {}       # 已消耗法术位: {环位: n}，长休清零

    # ── HP 状态（后端权威，前端从 updates.player_hp 同步）──
    def init_player_hp(self, character: dict):
        """从角色 combat.hp（"cur / max" 字符串）初始化 HP 状态（仅一次）"""
        if self.player_hp:
            return
        hp = (character or {}).get("combat", {}).get("hp", "")
        cur = max_hp = 0
        try:
            parts = str(hp).split("/")
            cur = int(parts[0].strip())
            max_hp = int(parts[1].strip())
        except (ValueError, IndexError):
            pass
        cur = max(cur, 0)
        max_hp = max(max_hp, cur, 1)
        self.player_hp = {"cur": cur or max_hp, "max": max_hp}

    def player_hp_cur(self) -> int:
        return int(self.player_hp.get("cur", 0))

    def player_hp_max(self) -> int:
        return int(self.player_hp.get("max", 10))

    def heal_player(self, amount: int) -> int:
        """恢复 HP，返回实际恢复量（不超过上限）"""
        cur = min(self.player_hp_max(), self.player_hp_cur() + max(0, int(amount)))
        healed = cur - self.player_hp_cur()
        self.player_hp["cur"] = cur
        return healed

    def damage_player(self, amount: int) -> int:
        """扣除 HP（不低于 0），返回剩余 HP"""
        self.player_hp["cur"] = max(0, self.player_hp_cur() - max(0, int(amount)))
        return self.player_hp["cur"]

    def set_player_hp_full(self):
        self.player_hp["cur"] = self.player_hp_max()

    def needs_full_context(self) -> bool:
        """是否需要发送完整场景上下文（首次进入、或切换了地点/场景）"""
        if self.last_full_context_location is None:
            return True
        current_scene_id = self.scene.get("id") if self.scene else None
        if self.last_full_context_location != self.location_id:
            return True
        if self.last_full_context_scene != current_scene_id:
            return True
        return False

    def mark_context_sent(self):
        """标记已发送完整上下文"""
        self.last_full_context_location = self.location_id
        self.last_full_context_scene = self.scene.get("id") if self.scene else None

    def add_intel(self, entry: dict):
        """添加一条情报（去重：同 id 不重复添加）"""
        existing_ids = {i.get("id") for i in self.player_intel}
        if entry.get("id") and entry["id"] not in existing_ids:
            self.player_intel.append(entry)

    # ── 商人（交易）辅助 ──
    def get_merchant(self, npc_id: str) -> dict | None:
        """获取 NPC 的 merchant 配置；没有 merchant 字段的 NPC 不可交易"""
        npc = self.data["npcs"].get(npc_id) if npc_id else None
        return (npc or {}).get("merchant")

    def merchant_gold(self, npc_id: str) -> int:
        """商人的当前动态金币（初始来自配置，交易后随 session 变化）"""
        conf = self.get_merchant(npc_id)
        if not conf:
            return 0
        return self.merchant_states.get(npc_id, {}).get("gold", conf.get("gold", 0))

    def set_merchant_gold(self, npc_id: str, gold: int):
        """更新商人的动态金币（不低于 0）"""
        if not self.get_merchant(npc_id):
            return
        self.merchant_states.setdefault(npc_id, {})["gold"] = max(0, gold)

    def get_merchant_inventory(self, npc_id: str) -> list:
        """商人的货物列表（每条含 item_id 与买入价 price）"""
        conf = self.get_merchant(npc_id)
        return (conf or {}).get("inventory", [])

    def get_merchant_sold(self, npc_id: str) -> dict:
        """商人已售数量记录（session 内存，随交易累加）: {item_id: n}"""
        return self.merchant_states.setdefault(npc_id, {}).setdefault("sold", {})

    def merchant_stock(self, npc_id: str, item_id: str) -> int | None:
        """商人的剩余库存；配置未写 stock 视为无限（返回 None）"""
        for entry in self.get_merchant_inventory(npc_id):
            if entry.get("item_id") == item_id:
                stock = entry.get("stock")
                if stock is None:
                    return None
                sold = self.get_merchant_sold(npc_id).get(item_id, 0)
                stolen = self.merchant_theft.get(npc_id, {}).get(item_id, 0)
                return max(0, int(stock) - sold - stolen)
        return 0

    # ── 偷窃（警觉 / 敌对 / 被怀疑）辅助 ──
    def is_hostile(self, npc_id: str) -> bool:
        return npc_id in self.hostile_npcs

    def set_hostile(self, npc_id: str):
        if npc_id in self.data.get("npcs", {}):
            self.hostile_npcs.add(npc_id)

    def npc_alert(self, npc_id: str) -> int:
        return int(self.npc_alerts.get(npc_id, 0))

    def add_npc_alert(self, npc_id: str, amount: int = 1):
        self.npc_alerts[npc_id] = self.npc_alert(npc_id) + amount

    def add_merchant_theft(self, npc_id: str, item_id: str):
        """记录商人货架物品被偷（扣减剩余库存）"""
        self.merchant_theft.setdefault(npc_id, {})
        self.merchant_theft[npc_id][item_id] = self.merchant_theft[npc_id].get(item_id, 0) + 1

    def set_suspicion(self, npc_id: str, item_ids: list, gold_amount: int = 0, mode: str = "discovered"):
        """进入被怀疑（强制对话）状态。
        mode:
          - "flagrante"（情况二，人赃并获）：立即对峙，无反应期，移动立即锁定；grappled 表示是否仍被抓住（挣脱成功 → False）
          - "discovered"（情况四，延迟发现）：detected_at 起 5 秒反应期，期间可逃离，超时锁定质问
        item_ids 为赃物物品 id（__gold__ 表示钱袋），gold_amount 为被偷金币。"""
        self.suspicion[npc_id] = {
            "active": True,
            "mode": mode,
            "item_ids": list(item_ids or []),
            "gold_amount": int(gold_amount or 0),
            "detected_at": time.time(),
            "grappled": mode == "flagrante",   # 情况二：挣脱前一直被抓住
            "social_failed": False,            # 社交检定失败后进入强制搜身阶段（搜出 ×3）
        }

    def get_suspicion(self, npc_id: str) -> dict | None:
        s = self.suspicion.get(npc_id)
        if s and s.get("active"):
            return s
        return None

    def has_active_suspicion(self) -> bool:
        return any(s.get("active") for s in self.suspicion.values())

    def suspicion_locked(self) -> bool:
        """是否已被锁定质问。
        mode="flagrante"（情况二，人赃并获）立即锁定；mode="discovered"（情况四，延迟败露）超过 5 秒反应期后锁定"""
        now = time.time()
        for s in self.suspicion.values():
            if not s.get("active"):
                continue
            if s.get("mode") == "flagrante":
                return True
            if now - s.get("detected_at", 0) >= 5:
                return True
        return False

    def clear_suspicion(self, npc_id: str):
        s = self.suspicion.get(npc_id)
        if s:
            s["active"] = False

    def clear_all_suspicion(self):
        """移动/离开时清除所有被怀疑状态"""
        self.suspicion = {}

    # ── 被抓住状态（仅此状态可挣脱；全程最多 2 次挣脱机会）──
    def set_caught(self, plaintiff: str, breakout_used: int = 0):
        """进入被抓住状态。breakout_used 为已使用的挣脱次数（共 2 次）"""
        used = max(0, int(breakout_used or 0))
        self.caught = {
            "active": True,
            "plaintiff": plaintiff,
            "breakout_used": used,
            "breakout_locked": used >= 2,  # 2 次用完 → 再也不能挣脱
        }

    def is_caught(self) -> bool:
        return bool(self.caught and self.caught.get("active"))

    def clear_caught(self):
        self.caught = {}

    def caught_breakout_used(self) -> int:
        return int((self.caught or {}).get("breakout_used", 0))

    # ── 通缉（仅当前区域生效，本次只做标记；播报由调用方叙事）──
    def set_wanted(self, location_id: str | None = None, city: bool = False):
        """设置通缉区域：wanted_location 存**地点 id 列表**。
        - city=True：通缉整个城市（与 location_id 同 parent_location 的所有地点，如越狱重罪通缉全城）
        - 否则：仅通缉指定/当前地点（普通偷窃逃脱 = 案发区域）"""
        loc_id = location_id or self.location_id
        if city:
            parent = (get_location(self.data, loc_id) or {}).get("parent_location")
            ids = [lid for lid, loc in self.data["locations"].items()
                   if (loc or {}).get("parent_location") == parent]
            self.wanted_location = sorted(set(ids)) if ids else [loc_id]
        else:
            self.wanted_location = [loc_id]

    # ── NPC 力量/敏捷（挣脱/逃脱对抗用；abilities 兼容 {str: N} 与 {str: {value: N}}）──
    def _npc_stat(self, npc_id: str, short_key: str) -> int:
        npc = self.data.get("npcs", {}).get(npc_id, {})
        ab = (npc.get("abilities") or {}).get(short_key)
        if isinstance(ab, dict):
            return int(ab.get("value", 10))
        if ab is not None:
            return int(ab)
        return 10

    def npc_strength(self, npc_id: str) -> int:
        return self._npc_stat(npc_id, "str")

    def npc_dexterity(self, npc_id: str) -> int:
        return self._npc_stat(npc_id, "dex")

    # ── 卫兵 / 逮捕状态 ──
    def stolen_value(self, item_ids: list, gold_amount: int = 0, npc_id: str | None = None) -> int:
        """被盗物品总价值（金币）——全局统一计价来源（对峙赔偿 / 卫兵处置共用）：
        1. 商人货架售价（merchant.inventory[].price，npc_id 给定时优先）
        2. 物品 value 字段（dict 取 gp / 直接数值）
        3. 物品 price 字段
        4. 缺省 10G
        另加偷到的金币。"""
        total = int(gold_amount or 0)
        for iid in item_ids or []:
            if iid == "__gold__":
                continue
            price = None
            if npc_id:
                for entry in self.get_merchant_inventory(npc_id):
                    if entry.get("item_id") == iid:
                        price = int(entry.get("price") or 0)
                        break
            if price is None:
                it = self.data.get("items", {}).get(iid, {})
                v = it.get("value")
                if isinstance(v, dict):
                    price = int(v.get("gp") or 0)
                elif v is not None:
                    price = int(v)
                else:
                    price = int(it.get("price") or 0)
            total += price or 10
        return max(1, total)

    def set_arrest(self, plaintiff: str, item_ids: list, gold_amount: int = 0, phase: str = "summoned",
                   rounds_left: int = 0):
        """进入逮捕流程。
        phase:
          - summoned：原告呼叫卫兵，卫兵赶来中（1d4 轮，rounds_left 每轮递减；期间可赔偿/社交/逃跑/挣脱）
          - arrived：卫兵到场，默认被抓住状态，要求搜身（同意搜 ×3 / 社交化解 / 挣脱）
          - arrested：被按死（强制搜出 ×3 赔偿，随后进监狱）
          - jailed：被关押，下一轮输入自动释放
          - escaped：逃跑成功
        plaintiff 为原告 NPC id，item_ids 为赃物，gold_amount 为偷到的金币。"""
        self.arrest = {
            "active": True,
            "phase": phase,
            "plaintiff": plaintiff,
            "item_ids": list(item_ids or []),
            "gold_amount": int(gold_amount or 0),
            "stolen_value": self.stolen_value(item_ids, gold_amount, npc_id=plaintiff),
            "rounds_left": int(rounds_left or random.randint(1, 4)) if phase == "summoned" else 0,
            "breakout_used": self.caught_breakout_used(),  # 挣脱次数与 caught 同步
            "guard_present": False,
        }

    def get_arrest(self) -> dict | None:
        a = self.arrest
        if a and a.get("active"):
            return a
        return None

    def has_active_arrest(self) -> bool:
        return bool(self.arrest and self.arrest.get("active"))

    def clear_arrest(self):
        self.arrest = None

    def add_guard_to_scene(self):
        """卫兵到场：加入当前地点 NPC 列表（幂等，str 形式）"""
        if not self.location_id:
            return
        loc = get_location(self.data, self.location_id)
        if loc is None:
            return
        npcs = loc.setdefault("npcs", [])
        ids = [e if isinstance(e, str) else (e or {}).get("id") for e in npcs]
        if "town-guard" not in ids:
            npcs.append("town-guard")
        if self.arrest:
            self.arrest["guard_present"] = True

    def remove_guard_from_scene(self):
        """处置结束：卫兵离开当前地点"""
        if not self.location_id:
            return
        loc = get_location(self.data, self.location_id)
        if loc is None:
            return
        npcs = loc.get("npcs") or []
        loc["npcs"] = [e for e in npcs if (e if isinstance(e, str) else (e or {}).get("id")) != "town-guard"]

    # ── 潜行状态 ──
    def set_stealth(self, npc_id: str | None, dc: int):
        """潜行成功：进入隐匿状态。npc_id 为空 = 通用隐匿（不针对特定目标），偷窃任意 NPC 均视为已潜行"""
        self.player_stealth = {"active": True, "npc_id": npc_id or "", "dc": int(dc)}

    def clear_stealth(self):
        self.player_stealth = {}

    def has_stealth(self, npc_id: str = None) -> bool:
        """是否处于潜行状态；npc_id 给定时要求潜行目标是该 NPC（隐匿目标为空 = 通用隐匿，匹配任意目标）"""
        s = self.player_stealth
        if not s.get("active"):
            return False
        if npc_id and s.get("npc_id") and s.get("npc_id") != npc_id:
            return False
        return True

    def npc_passive_perception(self, npc_id: str) -> int:
        """NPC 的被动感知：优先取数据中的 passive_perception 字段，否则按 10 + 感知调整推导。
        偷窃/潜行 DC 的依据（观察者被动感知），不逐物品写难度。"""
        npc = self.data.get("npcs", {}).get(npc_id, {})
        pp = npc.get("passive_perception")
        if pp is not None:
            return int(pp)
        wis = npc.get("wisdom", 10)
        ab = npc.get("abilities") or {}
        w = ab.get("wis")
        if isinstance(w, dict):
            wis = w.get("value", 10)
        elif w is not None:
            wis = w
        return 10 + (int(wis) - 10) // 2

    def to_client_updates(self) -> dict:
        """返回给前端的状态更新"""
        return {
            "scene_id": self.scene.get("id") if self.scene else None,
            "location_id": self.location_id,
            "npc_states": self.npc_states,
            "merchant_states": self.merchant_states,
            "player_inventory": self.player_inventory,
            "player_intel": self.player_intel,
            "quest_states": self.quest_states,
            "game_time": self.game_time,
            "container_taken": {
                lid: ls.get("container_taken", {})
                for lid, ls in self.location_states.items()
                if ls.get("container_taken")
            },
            "npc_alerts": self.npc_alerts,
            "hostile_npcs": sorted(self.hostile_npcs),
            "suspicion": self.suspicion,
            "arrest": self.arrest,
            "caught": self.caught,
            "wanted_location": self.wanted_location,
            "merchant_theft": self.merchant_theft,
            "player_stealth": self.player_stealth,
            "player_hp": self.player_hp,
            "short_rests_left": self.short_rests_left,
            "spell_slots_used": self.spell_slots_used,
        }

    def add_history(self, role: str, content: str):
        self.history.append({"role": role, "content": content, "time": self.game_time})
        # 只保留最近 20 轮
        if len(self.history) > 40:
            self.history = self.history[-40:]

    def get_context_npcs(self) -> list:
        """获取当前地点/场景在场的 NPC 完整数据（地点优先，场景兜底）。
        npcs 数组元素兼容 str 与 {id, sub}（sub=子区域，仅用于目击者判定）两种形式"""
        npc_ids = None
        if self.location_id:
            loc = get_location(self.data, self.location_id)
            if loc is not None and "npcs" in loc:
                npc_ids = [e if isinstance(e, str) else (e or {}).get("id") for e in loc.get("npcs", [])]
                npc_ids = [nid for nid in npc_ids if nid]
        if npc_ids is None:
            npc_ids = self.scene.get("npcs", []) if self.scene else []
        result = []
        for nid in npc_ids:
            npc = self.data["npcs"].get(nid)
            if not npc:
                continue
            # 已离开当前地点的 NPC 不出现在上下文中
            if self.npc_states.get(nid, {}).get("status") == "left":
                continue
            npc_copy = copy.deepcopy(npc)
            npc_copy["id"] = nid
            npc_copy["current_status"] = self.npc_states.get(nid, {})
            result.append(npc_copy)
        return result

    def get_context_items(self) -> list:
        """获取当前地点可见物品（visible=true）"""
        if not self.location_id:
            return []
        loc = get_location(self.data, self.location_id)
        if not loc:
            return []

        item_entries = loc.get("items", [])
        result = []
        for entry in item_entries:
            if isinstance(entry, str):
                iid = entry
                visible = True  # 字符串形式默认可见
            else:
                iid = entry.get("id")
                visible = entry.get("visible", True)
            item = self.data["items"].get(iid)
            if item and visible:
                item_copy = copy.deepcopy(item)
                item_copy["id"] = iid
                result.append(item_copy)
        return result


def get_or_create_session(
    session_id: str | None,
    adventure_id: str,
    chapter_id: str,
    scene_id: str = None,
) -> tuple[str, GameState]:
    """获取或创建会话"""
    if session_id and session_id in _sessions:
        return session_id, _sessions[session_id]

    data = load_adventure_chapter(adventure_id, chapter_id)
    if scene_id:
        starting_scene = find_scene(data, scene_id)
    else:
        starting_scene_id = data["chapter"].get("starting_scene")
        starting_scene = find_scene(data, starting_scene_id) if starting_scene_id else None

    new_id = session_id or str(uuid.uuid4())
    state = GameState(adventure_id, chapter_id, data, starting_scene)
    _sessions[new_id] = state
    return new_id, state
