"""游戏动作路由"""
from fastapi import APIRouter, HTTPException, Body

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


def _build_context(state) -> dict:
    """为 AI GM 构建当前上下文"""
    location = get_location(state.data, state.location_id)
    character = state.__dict__.get("character", {})

    # 当前可自由移动到的地点（场景内自由地点 + 当前地点出口）
    free_locations = list(state.scene.get("free_locations", [])) if state.scene else []
    if location:
        for e in location.get("exits", []):
            target = e.get("target")
            if target and target not in free_locations:
                free_locations.append(target)

    return {
        "scene": state.scene or {},
        "location": location or {},
        "npcs": state.get_context_npcs(),
        "items": state.get_context_items(),
        "free_locations": free_locations,
        "history": state.history,
        "character": character,
        "chapter_summary": load_chapter_summary(state.adventure_id, state.chapter_id),
    }


@router.post("/action")
def game_action(payload: dict = Body(...)) -> dict:
    """接收玩家动作，返回 GM 响应"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    session_id = payload.get("session_id")
    scene_id = payload.get("scene_id")
    player_input = payload.get("player_input", "")
    character = payload.get("character")

    if not player_input:
        raise HTTPException(status_code=400, detail="player_input is required")

    # 1. 获取会话状态
    session_id, state = get_or_create_session(session_id, adventure_id, chapter_id)

    # 如果前端指定了 scene_id 且与当前不同，切换场景
    if scene_id and state.scene and state.scene.get("id") != scene_id:
        new_scene = find_scene(state.data, scene_id)
        if new_scene:
            state.scene = new_scene
            state.location_id = new_scene.get("location")

    if not state.scene:
        raise HTTPException(status_code=404, detail="Scene not found")

    # 记录角色卡（首次传入时保存）
    if character:
        state.character = character

    context = _build_context(state)

    # 2. AI 解析意图
    intent_result = ai_gm.interpret(player_input, context)

    # 3. 规则引擎执行
    engine = RuleEngine(state.data, state.scene, state=state)
    rule_result, state_changes = engine.execute(intent_result, character)

    # 4. 应用状态变更
    state_manager = StateManager(state)
    applied_changes = state_manager.apply(state_changes)

    # 5. AI 生成叙事
    gm_text = ai_gm.narrate(
        player_input=player_input,
        intent_result=intent_result,
        rule_result=rule_result,
        state_changes=applied_changes,
        context=context,
    )

    # 如果 AI 没有生成叙事，使用规则引擎模板
    if not gm_text.strip():
        gm_text = rule_result.get("gm_text", "GM 没有回应。")

    # 6. 更新历史
    state.add_history("player", player_input)
    state.add_history("gm", gm_text)

    # 7. 时间推进（简单处理，后续可细化）
    state.game_time += 1

    return {
        "session_id": session_id,
        "gm_text": gm_text,
        "intent": intent_result.to_dict(),
        "checks": rule_result.get("checks", []),
        "state_changes": applied_changes,
        "updates": state.to_client_updates(),
    }
