"""游戏动作路由"""
import json
import re
import random

from fastapi import APIRouter, HTTPException, Body
from fastapi.responses import StreamingResponse

from services.core.game_state import (
    get_or_create_session,
    find_scene,
    get_location,
    load_chapter_summary,
)
from services.ai.intent_dispatch import RuleEngine
from services.core.steal_engine import resolve_suspicion_action
from services.core.rules import get_player_gold, set_player_gold, is_equipment_item
from services.ai.ai_gm import AIGM
from services.core.intents import IntentResult
from services.core.state_manager import StateManager

router = APIRouter(prefix="/api/game", tags=["game"])

# 全局 AI GM 实例
ai_gm = AIGM()

# ── 开场白端点 ──
@router.get("/opening")
def get_opening(adventure_id: str = "lost-mine-of-phandelver",
                chapter_id: str = "ch1", scene_id: str = "ch1-scene1"):
    """获取预生成的开场白（含 session 初始化）"""
    from main import get_cached_opening, get_opening_exchange

    opening = get_cached_opening(adventure_id, chapter_id, scene_id)
    exchange = get_opening_exchange(adventure_id, chapter_id, scene_id)

    # 创建 session 并注入开场白背景
    session_id, state = get_or_create_session(None, adventure_id, chapter_id, scene_id)

    # 注入开场白背景 exchange 到 session（不显示给前端）
    if exchange:
        state._opening_exchange = exchange
        # 标记上下文已发送——开场白背景已经给了AI所有信息，后续对话用 lite context
        state.mark_context_sent()

    if opening:
        return {
            "opening": opening,
            "session_id": session_id,
            "cached": True,
        }
    else:
        # Fallback: 使用硬编码场景描述
        loc = get_location(state.data, state.location_id)
        fallback = loc.get("scene_text", loc.get("description", "")) if loc else ""
        return {
            "opening": fallback,
            "session_id": session_id,
            "cached": False,
        }


def _build_context(state) -> dict:
    """为 AI GM 构建当前上下文"""
    location = get_location(state.data, state.location_id)
    character = state.__dict__.get("character", {})

    # 新地点触发被动察觉和被动调查
    passive_discoveries = []
    if state.needs_full_context() and location and character:
        engine = RuleEngine(state.data, state.scene, state=state)
        passive_discoveries = engine.run_passive_checks(character, location)

    return {
        "scene": state.scene or {},
        "location": location or {},
        "npcs": state.get_context_npcs(),
        "items": state.get_context_items(),
        "passive_discoveries": passive_discoveries,
        "character": character,
        "chapter_summary": load_chapter_summary(state.adventure_id, state.chapter_id),
        "suspicion": {
            nid: s for nid, s in state.suspicion.items() if s.get("active")
        },
        "arrest": state.arrest,
        "wanted_location": state.wanted_location,
        # 通缉区域名称列表（供 AI prompt 渲染，wanted_location 为地点 id 列表）
        "wanted_names": [
            (get_location(state.data, lid) or {}).get("name", lid)
            for lid in (state.wanted_location or [])
        ],
    }




@router.post("/action/stream")
def game_action_stream(payload: dict = Body(...)):
    """Tool Calling 流式端点：AI 自主判断是否需要后端处理"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    scene_id = payload.get("scene_id")
    player_input = payload.get("player_input", "")
    character = payload.get("character")

    if not player_input:
        raise HTTPException(status_code=400, detail="player_input is required")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)

    if scene_id and state.scene and state.scene.get("id") != scene_id:
        new_scene = find_scene(state.data, scene_id)
        if new_scene:
            state.scene = new_scene
            state.location_id = new_scene.get("location")

    # 前端在 free_locations 内自由切换地点时同步后端位置
    location_id = payload.get("location_id")
    if location_id and state.location_id != location_id:
        state.location_id = location_id

    if not state.scene:
        raise HTTPException(status_code=404, detail="Scene not found")

    _sync_character(state, character)
    _sync_location(state, payload)

    context = _build_context(state)
    full_context = state.needs_full_context()
    extra_msgs = getattr(state, '_opening_exchange', None)
    history_msgs = ai_gm._build_history_messages(state.history)

    # 1. 第 1 次 API（流式）：AI 判断是否需要 tool
    gen = ai_gm.chat_with_tools(player_input, context, full_context=full_context,
                                extra_messages=extra_msgs, history_messages=history_msgs)

    # 将 gen 消费放入 StreamingResponse 内部，实现真正的流式输出
    def stream_response():
        nonlocal state, session_id, character, context, full_context
        direct_text = ""
        tool_call_name = None
        tool_call_args = {}
        reasoning_content = None
        meta_sent = False

        for event_type, data in gen:
            if event_type == "error":
                state.add_history("player", player_input)
                state.game_time += 1
                meta = json.dumps({"type": "meta", "session_id": session_id,
                    "checks": [], "state_changes": [], "updates": state.to_client_updates()}, ensure_ascii=False)
                yield f"data: {meta}\n\n"
                yield f"data: {json.dumps({'type': 'narrative_chunk', 'text': 'GM 暂时无法回应。'})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return

            elif event_type == "text":
                direct_text += data
                if not meta_sent:
                    meta_sent = True
                    updates = state.to_client_updates()
                    meta = json.dumps({"type": "meta", "session_id": session_id,
                        "intent": {"intent": "other", "target_id": "", "target_type": "none"},
                        "checks": [], "state_changes": [], "updates": updates,
                        "_debug": {"mode": "direct_reply", "prompt_chars": dict(ai_gm.last_prompt_chars), "has_tool": False},
                    }, ensure_ascii=False)
                    yield f"data: {meta}\n\n"
                yield f"data: {json.dumps({'type': 'narrative_chunk', 'text': data})}\n\n"

            elif event_type == "done":
                tool_call_name = data.get("tool_name")
                tool_call_args = data.get("tool_args", {})
                reasoning_content = data.get("reasoning_content")

        if tool_call_name:
            # ── AI 决定需要后端处理 ──
            state_manager = StateManager(state)
            npc_status_valid = {"dead", "stunned", "left", "alive"}
            pending_suspicion = None  # 偷窃败露的延迟 suspicion（等待 AI 叙事完成后再设置）

            if tool_call_name == "update_npc_status":
                # 同步 NPC 死亡/眩晕/离开状态到前端角色栏
                npc_id = tool_call_args.get("npc_id", "")
                status = tool_call_args.get("status", "")
                if npc_id and status in npc_status_valid and npc_id in state.data.get("npcs", {}):
                    applied_changes = state_manager.apply([{
                        "type": "update_npc_state",
                        "npc_id": npc_id,
                        "updates": {"status": status},
                    }])
                    npc_name = state.data["npcs"][npc_id].get("name", npc_id)
                    gm_hint = f"{npc_name} 的状态已更新为 {status}。"
                else:
                    applied_changes = []
                    gm_hint = ""
                intent_dict = {"intent": "update_npc_status", "target_id": npc_id,
                               "target_type": "npc", "needs_check": False, "skill": None,
                               "suggested_dc": None, "narrative_description": ""}
                checks = []
                rule_gm_text = gm_hint
                intent_value = "update_npc_status"
            else:
                intent_result = IntentResult(
                    intent=tool_call_args.get("intent", "other"),
                    target_id=tool_call_args.get("target_id", ""),
                    target_type=tool_call_args.get("target_type", "none"),
                    needs_check=bool(tool_call_args.get("needs_check", False)),
                    skill=tool_call_args.get("skill") or None,
                    suggested_dc=tool_call_args.get("suggested_dc") or None,
                    narrative_description="",
                    action=tool_call_args.get("action") or "",
                    spell_id=tool_call_args.get("spell_id") or "",
                    target_npc_id=tool_call_args.get("target_npc_id") or "",
                )

                engine = RuleEngine(state.data, state.scene, state=state)
                rule_result, state_changes = engine.execute(intent_result, character)
                applied_changes = state_manager.apply(state_changes)
                intent_dict = intent_result.to_dict()
                checks = rule_result.get("checks", [])
                rule_gm_text = rule_result.get("gm_text", "")
                intent_value = intent_result.intent
                pending_suspicion = rule_result.get("delayed_suspicion")

            state.add_history("player", player_input)
            state.game_time += 1
            state.mark_context_sent()
            updates = state.to_client_updates()

            meta = json.dumps({
                "type": "meta", "session_id": session_id,
                "intent": intent_dict,
                "checks": checks,
                "state_changes": applied_changes,
                "updates": updates,
                "_debug": {
                    "mode": "tool_call",
                    "prompt_chars": dict(ai_gm.last_prompt_chars),
                    "has_tool": True,
                },
            }, ensure_ascii=False)
            yield f"data: {meta}\n\n"

            full_text = ""
            for token in ai_gm.narrate_with_result(
                player_input=player_input,
                tool_result={"arguments": tool_call_args, "result": {
                    "gm_hint": rule_gm_text,
                    "intent": intent_value,
                    "checks": checks,
                    "state_changes": applied_changes,
                }},
                context=context,
                stream=True,
                full_context=full_context,
                reasoning_content=reasoning_content,
                extra_messages=extra_msgs,
                history_messages=history_msgs,
                tool_name=tool_call_name,
            ):
                full_text += token
                yield f"data: {json.dumps({'type': 'narrative_chunk', 'text': token})}\n\n"

            # 偷窃败露（discovered）：AI 叙事输出完成 ≈ 玩家看到"偷窃成功"消息，
            # 此刻才开始 5 秒反应期，避免 AI 生成叙事耗时的误差
            if pending_suspicion:
                state.set_suspicion(
                    pending_suspicion["npc_id"],
                    pending_suspicion.get("item_ids", []),
                    gold_amount=pending_suspicion.get("gold_amount", 0),
                    mode="discovered",
                )
                # 补发 meta：把刚设置的 suspicion 同步给前端，前端据此启动 5 秒倒计时
                extra_meta = json.dumps({
                    "type": "meta", "session_id": session_id,
                    "intent": intent_dict, "checks": [], "state_changes": [],
                    "updates": state.to_client_updates(),
                }, ensure_ascii=False)
                yield f"data: {extra_meta}\n\n"

            state.add_history("gm", full_text)
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        else:
            # ── AI 直接回复 ──
            state.add_history("player", player_input)
            state.add_history("gm", direct_text)
            state.game_time += 1
            state.mark_context_sent()
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _loc_item_ids(loc: dict) -> list:
    """当前地点 items 数组中的 id 列表（兼容 dict / 字符串两种形式）"""
    ids = []
    for e in loc.get("items", []):
        if isinstance(e, dict):
            ids.append(e.get("id"))
        else:
            ids.append(e)
    return ids


def _get_container_taken(state, loc_id: str, container_id: str) -> list:
    """获取某个容器在当前地点已被取走的物品 id 列表"""
    loc_state = state.location_states.setdefault(loc_id, {})
    return loc_state.setdefault("container_taken", {}).setdefault(container_id, [])


@router.post("/take_item")
def take_item(payload: dict = Body(...)):
    """从当前地点拿取物品。container_id 存在时拿容器内的物品，否则直接拿场景中的无主物品。"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    container_id = payload.get("container_id")
    item_id = payload.get("item_id", "")

    if not item_id:
        raise HTTPException(status_code=400, detail="item_id is required")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    items = state.data.get("items", {})
    item = items.get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    is_equipment = is_equipment_item(item)

    loc = get_location(state.data, state.location_id) if state.location_id else None
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")

    if container_id:
        # ── 拿取容器内的物品 ──
        container = items.get(container_id)
        if not container:
            raise HTTPException(status_code=404, detail="Container not found")
        if container_id not in _loc_item_ids(loc):
            raise HTTPException(status_code=400, detail="容器不在当前地点")
        contains = container.get("contains", [])
        if item_id not in contains:
            raise HTTPException(status_code=400, detail="容器里没有该物品")
        taken = _get_container_taken(state, state.location_id, container_id)
        if taken.count(item_id) >= contains.count(item_id):
            raise HTTPException(status_code=400, detail="该物品已全部取走")
        taken.append(item_id)
        note = f"我拿取了 {item.get('name', item_id)}（从{container.get('name', container_id)}）"
    else:
        # ── 直接拿取场景中的无主物品 ──
        if item_id not in _loc_item_ids(loc):
            raise HTTPException(status_code=400, detail="该物品不在当前地点")
        if item.get("owner"):
            raise HTTPException(status_code=400, detail="该物品有主人，需要偷窃")
        # 从当前地点移除（内存状态，随 session 存活）
        loc["items"] = [e for e in loc.get("items", []) if (e.get("id") if isinstance(e, dict) else e) != item_id]
        note = f"我拿取了 {item.get('name', item_id)}"

    # 装备类物品直接进前端装备栏（角色装备数据），不进入道具背包
    if not is_equipment:
        state.player_inventory.append(item_id)
    state.add_history("player", note)

    return {
        "item_id": item_id,
        "container_id": container_id or None,
        "is_equipment": is_equipment,
        "updates": state.to_client_updates(),
    }


def _resolve_item_effect(effect: str, cur_hp: int = 0, max_hp: int = 0) -> dict:
    """
    通用道具效果解析器。
    - "heal NdM+K"：掷骰并按当前/上限生命值截断，返回实际恢复值与文案
    - 其他非空字符串：视为叙事效果文案，原样返回（如"解除了中毒状态"）
    返回 {"value": 数值(无数值为 0), "message": 播报文案(可为空)}
    """
    effect = (effect or "").strip()
    if not effect:
        return {"value": 0, "message": ""}

    m = re.match(r'heal\s+(\d+)d(\d+)(?:\s*\+\s*(\d+))?', effect, re.IGNORECASE)
    if m:
        count = int(m.group(1))
        die = int(m.group(2))
        bonus = int(m.group(3) or 0)
        total = bonus
        for _ in range(count):
            total += random.randint(1, die)
        if max_hp > 0:
            healed = max(0, min(max_hp - cur_hp, total))
        else:
            healed = total
        return {"value": healed, "message": f"恢复了 {healed} 点生命值"}

    return {"value": 0, "message": effect}


@router.post("/use_item")
def use_item(payload: dict = Body(...)):
    """使用并消耗背包中的一个道具。heal 类效果由后端基于权威 HP 状态结算并按 HP 截断。"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    item_id = payload.get("item_id", "")
    character = payload.get("character")

    if not item_id:
        raise HTTPException(status_code=400, detail="item_id is required")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    item = state.data.get("items", {}).get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    if item_id not in state.player_inventory:
        raise HTTPException(status_code=400, detail="背包里没有该物品")

    state.player_inventory.remove(item_id)
    state.init_player_hp(state.character)
    effect_result = _resolve_item_effect(item.get("effect", ""), state.player_hp_cur(), state.player_hp_max())
    # heal 类：后端权威结算实际恢复量（按 HP 上限截断）
    if (item.get("effect") or "").strip().lower().startswith("heal") and effect_result.get("value"):
        healed = state.heal_player(effect_result["value"])
        effect_result["value"] = healed
        effect_result["message"] = f"恢复了 {healed} 点生命值"
    state.add_history("player", f"我使用了 {item.get('name', item_id)}")

    return {
        "item_id": item_id,
        "value": effect_result["value"],
        "message": effect_result["message"],
        "updates": state.to_client_updates(),
    }


@router.post("/equip_item")
def equip_item(payload: dict = Body(...)):
    """将背包中的道具转移为角色装备（从 player_inventory 移除，装备数据由前端写入角色卡）"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    item_id = payload.get("item_id", "")

    if not item_id:
        raise HTTPException(status_code=400, detail="item_id is required")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    item = state.data.get("items", {}).get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    if item_id not in state.player_inventory:
        raise HTTPException(status_code=400, detail="背包里没有该物品")

    state.player_inventory.remove(item_id)
    state.add_history("player", f"我装备了 {item.get('name', item_id)}")

    return {
        "item_id": item_id,
        "updates": state.to_client_updates(),
    }


@router.post("/drop_item")
def drop_item(payload: dict = Body(...)):
    """丢弃一个物品到当前地点（从 player_inventory 移除，加入当前地点 items，其他角色可拾取）"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    item_id = payload.get("item_id", "")

    if not item_id:
        raise HTTPException(status_code=400, detail="item_id is required")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)

    # 若在道具背包中则移除（装备类可能只在角色卡，同样允许丢弃落地点）
    if item_id in state.player_inventory:
        state.player_inventory.remove(item_id)

    item_def = state.data.get("items", {}).get(item_id)
    item_name = item_def.get("name", item_id) if item_def else item_id

    # 加入当前地点（世界状态，其他角色可拾取）
    loc = get_location(state.data, state.location_id) if state.location_id else None
    if loc:
        loc.setdefault("items", []).append({"id": item_id, "visible": True})

    state.add_history("player", f"我把 {item_name} 丢弃在当前地点")

    return {
        "item_id": item_id,
        "updates": state.to_client_updates(),
    }


# ── 交易系统 ──
def _merchant_buy_price(state, npc_id: str, item_id: str) -> int | None:
    """商人的出售价（仅限商人库存内的物品，不在库存中不可购买）；敌对后统一涨价 +50%"""
    for entry in state.get_merchant_inventory(npc_id):
        if entry.get("item_id") == item_id:
            price = int(entry.get("price") or 0)
            if state.is_hostile(npc_id):
                price = -(-price * 3 // 2)  # ceil(price * 1.5)
            return price
    return None


def _merchant_sell_price(state, npc_id: str, item_id: str) -> int | None:
    """商人的收购价：商人库存内的物品按售价半价回收；否则按物品自身 price 半价。
    敌对后压低收购价（×0.5），让玩家卖出更亏"""
    price = _merchant_buy_price(state, npc_id, item_id)
    if price is None:
        item = state.data.get("items", {}).get(item_id)
        if item and item.get("price"):
            price = int(item["price"])
            if state.is_hostile(npc_id):
                price = (price + 1) // 2
    if price is None:
        return None
    # (price + 1) // 2 等价于 JS 的 Math.round(price/2)（half-up），避免两端价格不一致
    return max(1, (price + 1) // 2)


def _sync_location(state, payload: dict):
    """同步前端当前位置（前端自由切换地点后需让后端一致）。
    移动/离开会解除潜行状态，并清除被怀疑（5 秒反应期内离开 = 逃脱）"""
    location_id = payload.get("location_id")
    if location_id and state.location_id != location_id:
        state.location_id = location_id
        state.clear_stealth()
        if state.has_active_suspicion():
            state.clear_all_suspicion()


def _sync_character(state, character: dict | None):
    """同步前端角色数据，并初始化后端权威 HP 状态（仅首次）"""
    if character:
        state.character = character
        state.init_player_hp(character)


@router.post("/buy_item")
def buy_item(payload: dict = Body(...)):
    """从商人处购买物品：校验金币 → 扣玩家金币、商人金币增加 → 物品进背包（装备类进装备栏）"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    npc_id = payload.get("npc_id", "")
    item_id = payload.get("item_id", "")
    quantity = int(payload.get("quantity") or 1)
    character = payload.get("character")

    if not npc_id or not item_id or quantity < 1:
        raise HTTPException(status_code=400, detail="参数不完整")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    _sync_location(state, payload)

    if not state.get_merchant(npc_id):
        raise HTTPException(status_code=400, detail="该NPC不是商人，无法交易")
    npc = state.data["npcs"].get(npc_id, {})

    price_per = _merchant_buy_price(state, npc_id, item_id)
    if price_per is None:
        raise HTTPException(status_code=400, detail="该商人不出售此物品")
    item = state.data.get("items", {}).get(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # 库存校验（配置了 stock 的商品有限量）
    stock = state.merchant_stock(npc_id, item_id)
    if stock is not None and stock < quantity:
        raise HTTPException(status_code=400, detail="该商品库存不足")

    total = price_per * quantity
    gold = get_player_gold(state)
    if gold < total:
        raise HTTPException(status_code=400, detail="金币不足，无法购买")

    # 成交：玩家金币减少、商人金币增加、物品进背包（测试阶段金币不写回角色 JSON，刷新即回退）
    set_player_gold(state, gold - total)
    state.set_merchant_gold(npc_id, state.merchant_gold(npc_id) + total)
    # 扣减商人库存（session 内存）
    if state.merchant_stock(npc_id, item_id) is not None:
        sold = state.get_merchant_sold(npc_id)
        sold[item_id] = sold.get(item_id, 0) + quantity
    is_equipment = is_equipment_item(item)
    if not is_equipment:
        for _ in range(quantity):
            state.player_inventory.append(item_id)

    npc_name = npc.get("name", npc_id)
    item_name = item.get("name", item_id)
    msg = f"你花了 {total} 金币，从{npc_name}那里买下了 {quantity} 件{item_name}。"
    state.add_history("player", f"我花了 {total} 金币从{npc_name}购买了 {quantity} 件{item_name}")
    state.add_history("gm", msg)

    return {
        "item_id": item_id,
        "quantity": quantity,
        "is_equipment": is_equipment,
        "gold": get_player_gold(state),
        "cost": total,
        "message": msg,
        "updates": state.to_client_updates(),
    }


@router.post("/sell_item")
def sell_item(payload: dict = Body(...)):
    """向商人出售背包道具：物品移除 → 玩家金币增加（半价回收）、商人金币减少"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    npc_id = payload.get("npc_id", "")
    item_id = payload.get("item_id", "")
    quantity = int(payload.get("quantity") or 1)
    character = payload.get("character")

    if not npc_id or not item_id or quantity < 1:
        raise HTTPException(status_code=400, detail="参数不完整")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    _sync_location(state, payload)

    if not state.get_merchant(npc_id):
        raise HTTPException(status_code=400, detail="该NPC不是商人，无法交易")
    npc = state.data["npcs"].get(npc_id, {})

    # 出售仅支持道具背包中的物品（装备类暂不可出售）
    if state.player_inventory.count(item_id) < quantity:
        raise HTTPException(status_code=400, detail="背包里没有足够数量的该物品")

    offer = _merchant_sell_price(state, npc_id, item_id)
    if offer is None:
        raise HTTPException(status_code=400, detail="该商人无法收购此物品")
    total = offer * quantity
    merchant_gold = state.merchant_gold(npc_id)
    if merchant_gold < total:
        raise HTTPException(status_code=400, detail="商人没有足够的金币收购")

    item = state.data.get("items", {}).get(item_id, {})
    for _ in range(quantity):
        state.player_inventory.remove(item_id)
    # 测试阶段：金币不写回角色 JSON，刷新页面即回退（持久化后期再做）
    set_player_gold(state, get_player_gold(state) + total)
    state.set_merchant_gold(npc_id, merchant_gold - total)

    npc_name = npc.get("name", npc_id)
    item_name = item.get("name", item_id)
    msg = f"你把 {quantity} 件{item_name}卖给了{npc_name}，获得 {total} 金币。"
    state.add_history("player", f"我把 {quantity} 件{item_name}以 {total} 金币卖给了{npc_name}")
    state.add_history("gm", msg)

    return {
        "item_id": item_id,
        "quantity": quantity,
        "gold": get_player_gold(state),
        "gain": total,
        "message": msg,
        "updates": state.to_client_updates(),
    }


# ── 偷窃系统（核心逻辑在 services/steal_engine.py，偷窃经 AI 意图走 /action/stream，此处为确定性端点）──


_SUSPICION_ACTION_CN = {
    "search": "接受搜身",
    "pay": "赔钱认账",
    "refuse": "拒绝质问",
    "deception": "欺瞒对方",
    "intimidation": "威吓对方",
    "persuasion": "游说对方",
    "flee": "逃跑",
}


def _polish_meta_stream(state, session_id, updates, check, extra: dict = None, event_type: str = "suspicion"):
    """确定性端点流式生成器：先发确定性 meta（前端立即应用状态/骰子），再流式输出 AI 润色播报，
    润色失败或 AI 不可用时回退固定播报（facts）。extra 可附加 searched_out/cost/gold/arrest 等。"""
    facts = extra.get("facts", "") if extra else ""
    context = extra.get("context") if extra else None
    if context is not None:
        context["history"] = state.history  # 复用主 GM 上下文：AI 有前因后果
    meta = {"type": "meta", "session_id": session_id, "updates": updates,
            "checks": [check] if check else []}
    for k in ("searched_out", "cost", "gold", "arrest"):
        if extra and extra.get(k) is not None:
            meta[k] = extra[k]
    yield f"data: {json.dumps(meta, ensure_ascii=False)}\n\n"

    polished = ""
    for token in ai_gm.polish_broadcast(event_type, facts, context):
        if token:
            polished += token
            yield f"data: {json.dumps({'type': 'narrative_chunk', 'text': token}, ensure_ascii=False)}\n\n"
    if not polished:
        yield f"data: {json.dumps({'type': 'narrative_chunk', 'text': facts}, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps({'type': 'done', 'full_text': polished or facts}, ensure_ascii=False)}\n\n"


@router.post("/stealth")
def stealth(payload: dict = Body(...)):
    """潜行（确定性接口，前端关键词触发，绕过 AI 意图识别——保证有骰子播报、无需指定目标、毫秒级结算）。
    潜行不需要目标：未传 target_id = 通用隐匿（DC 取当前场景在场 NPC 最高被动感知+警觉），
    偷窃任意在场 NPC 均视为已潜行；传 target_id = 只瞒过该 NPC（限同子区域目击者）。
    结算同步毫秒级完成，随后 AI 流式润色播报（失败回退固定播报）。"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    target_id = payload.get("target_id", "")
    character = payload.get("character")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    _sync_location(state, payload)

    if state.has_active_suspicion():
        raise HTTPException(status_code=400, detail="你正被怀疑偷窃，先应付当前的质问。")
    if state.has_active_arrest():
        raise HTTPException(status_code=400, detail="卫兵正盯着你，现在没法躲藏。")

    engine = RuleEngine(state.data, state.scene, state=state)
    intent = IntentResult(
        intent="perception",
        target_id=target_id or "",
        target_type="npc" if target_id else "none",
        skill="stealth",
        needs_check=True,
    )
    rule, _ = engine._handle_stealth(intent, character)
    check = rule["checks"][0] if rule.get("checks") else None
    state.add_history("player", "我潜行躲藏起来")
    state.add_history("gm", rule["gm_text"])

    updates = state.to_client_updates()
    facts = rule["gm_text"]
    loc = get_location(state.data, state.location_id) or {}
    npc_name = state.data["npcs"].get(target_id, {}).get("name", "在场的人") if target_id else "在场的人"
    context = {
        "player_name": (character or {}).get("name", ""),
        "npc_name": npc_name,
        "location_name": loc.get("name", ""),
        "action": "潜行",
    }

    def stream_response():
        for ev in _polish_meta_stream(state, session_id, updates, check,
                                      {"facts": facts, "context": context}, event_type="stealth"):
            yield ev

    return StreamingResponse(stream_response(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/suspicion")
def resolve_suspicion(payload: dict = Body(...)):
    """被怀疑（强制对话）时玩家的回应（确定性接口，前端关键词触发，AI 仅叙事）：
    search 同意搜身 / pay 给钱承认 / refuse 拒绝 / deception 欺瞒 / intimidation 威吓 / persuasion 游说 /
    flee 逃跑（人赃并获先挣脱再敏捷逃脱，延迟发现直接敏捷逃脱）。按 suspicion.mode 分流。
    结算同步毫秒级完成，随后 AI 流式润色播报（失败回退固定播报）。"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    npc_id = payload.get("npc_id", "")
    action = payload.get("action", "")
    character = payload.get("character")

    if not npc_id or action not in ("search", "pay", "refuse", "deception", "intimidation", "persuasion", "flee"):
        raise HTTPException(status_code=400, detail="参数不完整")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    _sync_location(state, payload)

    result = resolve_suspicion_action(state, npc_id, action, character)
    updates = state.to_client_updates()

    loc = get_location(state.data, state.location_id) or {}
    npc_name = state.data["npcs"].get(npc_id, {}).get("name", npc_id)
    context = {
        "player_name": (character or {}).get("name", ""),
        "npc_name": npc_name,
        "location_name": loc.get("name", ""),
        "action": _SUSPICION_ACTION_CN.get(action, action),
    }
    extra = {"facts": result["message"], "context": context}
    if result.get("searched_out") is not None:
        extra["searched_out"] = result["searched_out"]
    if result.get("cost") is not None:
        extra["cost"] = result["cost"]
    if result.get("gold") is not None:
        extra["gold"] = result["gold"]
    if result.get("arrest"):
        extra["arrest"] = result["arrest"]

    def stream_response():
        for ev in _polish_meta_stream(state, session_id, updates,
                                      result.get("check"), extra):
            yield ev

    return StreamingResponse(stream_response(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── 越狱（jailed 阶段点击监狱大门）──
@router.post("/jail/escape")
def jail_escape(payload: dict = Body(...)):
    """点击监狱大门越狱（牢门已开，前端导航触发）：
    越狱行动同样推进狱卒巡逻轮数——狱卒刚好回来 → 强制关回（GM 流式润色叙事）；
    越狱成功 → 直接播报固定文本（不润色）。"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    character = payload.get("character")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    _sync_location(state, payload)

    from services.core.steal_engine import jail_escape as _jail_escape
    result = _jail_escape(state)
    pname = (character or {}).get("name") or "冒险者"
    if result.get("ok"):
        state.add_history("player", f"{pname}推开监狱大门逃了出去")
    else:
        state.add_history("player", f"{pname}试图越狱，却被狱卒堵了回来")
    state.add_history("gm", result["message"])

    updates = result.get("updates") or state.to_client_updates()
    facts = result["message"]

    def stream_response():
        if result.get("ok"):
            # 越狱成功：固定播报直出（meta 先应用状态，随后直接播报）
            meta = {"type": "meta", "session_id": session_id, "updates": updates}
            yield f"data: {json.dumps(meta, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'narrative_chunk', 'text': facts}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'full_text': facts}, ensure_ascii=False)}\n\n"
            return
        # 强制关回等：GM 流式润色叙事（狱卒回来这种戏剧性场景需要 GM 说话）
        loc = get_location(state.data, state.location_id) or {}
        context = {"player_name": pname, "location_name": loc.get("name", ""), "action": "越狱被阻"}
        extra = {"facts": facts, "context": context}
        for ev in _polish_meta_stream(state, session_id, updates, None, extra, event_type="jail_escape"):
            yield ev

    return StreamingResponse(stream_response(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── 休息系统（确定性结算，按钮/关键词触发，不走 AI）──
@router.post("/rest")
def rest(payload: dict = Body(...)):
    """短休（回一半最大 HP + 恢复短休充能动作，每天 2 次）/ 长休（回满 + 法术位 + 短休重置，消耗 1 份干粮）"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    rest_type = payload.get("type", "")
    character = payload.get("character")

    if rest_type not in ("short", "long"):
        raise HTTPException(status_code=400, detail="type 必须是 short 或 long")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    state.init_player_hp(state.character)

    if rest_type == "short":
        if state.short_rests_left <= 0:
            raise HTTPException(status_code=400, detail="今天已经短休过两次了，需要长休恢复。")
        state.short_rests_left -= 1
        half = (state.player_hp_max() + 1) // 2  # ceil(最大/2)，BG3 式
        state.player_hp["cur"] = min(state.player_hp_max(), max(state.player_hp_cur(), half))
        state.short_rest_action_uses = {}
        state.game_time += 1
        msg = (f"你短休了一会儿（1 小时）：生命值恢复到 {state.player_hp['cur']} / {state.player_hp_max()}，"
               f"短休充能动作（回气等）已恢复。今天还可短休 {state.short_rests_left} 次。")
    else:
        if "rations" not in state.player_inventory:
            raise HTTPException(status_code=400, detail="背包里没有干粮，无法进行长休。")
        state.player_inventory.remove("rations")
        state.set_player_hp_full()
        state.spell_slots_used = {}
        state.short_rests_left = 2
        state.short_rest_action_uses = {}
        state.game_time += 8
        msg = (f"你们休整了一夜（长休 8 小时）：生命值回满（{state.player_hp['cur']} / {state.player_hp_max()}），"
               "法术位全部恢复，短休次数重置为 2，消耗了 1 份干粮。")

    state.add_history("gm", msg)
    return {"message": msg, "updates": state.to_client_updates()}


# ── 施法 / 动作（确定性结算，前端按钮与 AI 意图共用 spell_engine / action_engine）──
@router.post("/cast_spell")
def cast_spell(payload: dict = Body(...)):
    """施放已知法术：校验法术位 → 消耗 → 结算（治疗/伤害/narrative）。narrative 效果由 AI 按法术描述叙事。"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    spell_id = payload.get("spell_id", "")
    target_npc_id = payload.get("target_npc_id") or None
    character = payload.get("character")

    if not spell_id:
        raise HTTPException(status_code=400, detail="spell_id is required")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    state.init_player_hp(state.character)

    from services.core.spell_engine import cast_spell as do_cast
    result = do_cast(state, state.character, spell_id, target_npc_id)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result["message"])
    pname = (state.character or {}).get("name") or "我"
    # 以 GM 口吻叙事：把引擎模板里的"你"换成角色名（点击施法不产生玩家发言条）
    result["message"] = result["message"].replace("你", pname, 1)
    state.add_history("gm", result["message"])
    result["updates"] = state.to_client_updates()
    return result


@router.post("/use_action")
def use_action(payload: dict = Body(...)):
    """使用职业动作（回气/回复等）：校验短休充能 → 消耗 → 结算。"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    action_id = payload.get("action_id", "")
    character = payload.get("character")

    if not action_id:
        raise HTTPException(status_code=400, detail="action_id is required")

    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)
    _sync_character(state, character)
    state.init_player_hp(state.character)

    from services.core.action_engine import use_action as do_action
    result = do_action(state, state.character, action_id)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result["message"])
    pname = (state.character or {}).get("name") or "我"
    state.add_history("player", f"{pname}使用了动作 {action_id}")
    state.add_history("gm", result["message"])
    result["updates"] = state.to_client_updates()
    return result
