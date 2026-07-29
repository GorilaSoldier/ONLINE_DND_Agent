"""角色管理路由"""
import json
import uuid
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, HTTPException, Body
from utils.file_io import load_json
from services.character_builder import build_character_defaults

router = APIRouter(prefix="/api/characters", tags=["characters"])

BASE_DIR = Path(__file__).parent.parent.parent
DATA_DIR = BASE_DIR / "data" / "characters"


def _load_character(char_id: str) -> dict:
    file_path = DATA_DIR / f"{char_id}.json"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")
    with open(file_path, encoding="utf-8") as f:
        return json.load(f)


@router.get("")
def list_characters() -> list[dict]:
    """返回所有人物卡列表"""
    characters = []
    if DATA_DIR.exists():
        for file_path in sorted(DATA_DIR.glob("*.json")):
            with open(file_path, encoding="utf-8") as f:
                characters.append(json.load(f))
    return characters


@router.post("")
def create_character(data: dict = Body(...)) -> dict:
    """创建新角色，保存为 JSON 文件"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    char_id = f"char_{datetime.now().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:6]}"

    races = load_json("races.json")
    classes = load_json("classes.json")
    backgrounds = load_json("backgrounds.json")
    race_data = races.get(data.get("race_id", ""), {})
    class_data = classes.get(data.get("class_id", ""), {})
    bg_data = backgrounds.get(data.get("background_id", ""), {})

    defaults = build_character_defaults(data, class_data, race_data, bg_data)

    char_data = {
        "id": char_id,
        "created_at": datetime.now().isoformat(),
        "name": data.get("name", "未命名"),
        "campaign_id": data.get("campaign_id", ""),
        "theme": "light",
        "portrait": (data.get("name", "?"))[0] if data.get("name") else "?",
        "race_id": data.get("race_id"),
        "race": race_data.get("name", ""),
        "race_en": race_data.get("name_en", ""),
        "subrace_id": data.get("subrace_id"),
        "subrace": (race_data.get("subraces", {}).get(data.get("subrace_id", ""), {})).get("name", ""),
        "class_id": data.get("class_id"),
        "class": class_data.get("name", ""),
        "class_en": class_data.get("id", ""),
        "subclass_id": data.get("subclass_id"),
        "subclass": data.get("subclass", ""),
        "background_id": data.get("background_id"),
        "background_name": bg_data.get("name", ""),
        "level": 1,
        "combat": defaults["combat"],
        "xp": defaults["xp"],
        "attack": defaults["attack"],
        "abilities": defaults["abilities"],
        "ability_bonus": data.get("abilityBonus", {}),
        "inventory": defaults["inventory"],
        "features": defaults["features"],
        "skills": defaults["skills"],
        "spells": defaults["spells"],
        "background": defaults["background"],
        "cantrip_ids": data.get("cantrip_ids", []),
        "spell_ids": data.get("spell_ids", []),
        "class_skills": data.get("class_skills", []),
        "human_skill": data.get("human_skill"),
        "background_story": data.get("background", {}),
    }
    file_path = DATA_DIR / f"{char_id}.json"
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(char_data, f, ensure_ascii=False, indent=2)
    return char_data


@router.get("/{char_id}")
def get_character(char_id: str) -> dict:
    return _load_character(char_id)


@router.delete("/{char_id}")
def delete_character(char_id: str) -> dict:
    file_path = DATA_DIR / f"{char_id}.json"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")
    file_path.unlink()
    return {"ok": True, "deleted": char_id}
