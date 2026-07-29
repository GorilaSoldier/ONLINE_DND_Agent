"""游戏动作路由"""
from fastapi import APIRouter, HTTPException, Body
from services.game_state import load_adventure_chapter, find_scene
from services.rule_engine import RuleEngine

router = APIRouter(prefix="/api/game", tags=["game"])


@router.post("/action")
def game_action(payload: dict = Body(...)) -> dict:
    """接收玩家动作，返回 GM 响应"""
    adventure_id = payload.get("adventure_id", "lost-mine-of-phandelver")
    chapter_id = payload.get("chapter_id", "ch1")
    scene_id = payload.get("scene_id")
    player_input = payload.get("player_input", "")
    character = payload.get("character")

    if not scene_id or not player_input:
        raise HTTPException(status_code=400, detail="scene_id and player_input are required")

    data = load_adventure_chapter(adventure_id, chapter_id)
    scene = find_scene(data, scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail=f"Scene '{scene_id}' not found")

    engine = RuleEngine(data, scene)
    result = engine.process(player_input, character)

    return {
        "gm_text": result["gm_text"],
        "checks": result["checks"],
        "state_changes": result["state_changes"],
    }
