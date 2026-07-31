"""游戏动作路由"""
import json

from fastapi import APIRouter, HTTPException, Body
from fastapi.responses import StreamingResponse

from services.game_state import (
    get_or_create_session,
    find_scene,
    get_location,
    load_chapter_summary,
)
from services.rule_engine import RuleEngine
from services.ai_gm import AIGM, IntentResult
from services.state_manager import StateManager

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

    if not state.scene:
        raise HTTPException(status_code=404, detail="Scene not found")

    if character:
        state.character = character

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
            intent_result = IntentResult(
                intent=tool_call_args.get("intent", "other"),
                target_id=tool_call_args.get("target_id", ""),
                target_type=tool_call_args.get("target_type", "none"),
                needs_check=bool(tool_call_args.get("needs_check", False)),
                skill=tool_call_args.get("skill") or None,
                suggested_dc=tool_call_args.get("suggested_dc") or None,
                narrative_description="",
            )

            engine = RuleEngine(state.data, state.scene, state=state)
            rule_result, state_changes = engine.execute(intent_result, character)
            state_manager = StateManager(state)
            applied_changes = state_manager.apply(state_changes)

            state.add_history("player", player_input)
            state.game_time += 1
            state.mark_context_sent()
            updates = state.to_client_updates()

            meta = json.dumps({
                "type": "meta", "session_id": session_id,
                "intent": intent_result.to_dict(),
                "checks": rule_result.get("checks", []),
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
                    "gm_hint": rule_result.get("gm_text", ""),
                    "intent": intent_result.intent,
                    "checks": rule_result.get("checks", []),
                    "state_changes": applied_changes,
                }},
                context=context,
                stream=True,
                full_context=full_context,
                reasoning_content=reasoning_content,
                extra_messages=extra_msgs,
                history_messages=history_msgs,
            ):
                full_text += token
                yield f"data: {json.dumps({'type': 'narrative_chunk', 'text': token})}\n\n"

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
