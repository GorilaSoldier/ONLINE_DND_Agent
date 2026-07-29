"""数据目录路由（装备/法术/特性/种族等只读接口）"""
from fastapi import APIRouter, HTTPException
from utils.file_io import load_json, load_equipment_catalog, load_equipment_by_type

router = APIRouter(prefix="/api", tags=["data"])


@router.get("/equipment")
def list_equipment() -> dict[str, dict]:
    return load_equipment_catalog()


@router.get("/equipment/{equipment_type}")
def get_equipment_type(equipment_type: str) -> dict[str, dict]:
    return load_equipment_by_type(equipment_type)


@router.get("/equipment/{equipment_type}/{item_id}")
def get_equipment_item(equipment_type: str, item_id: str) -> dict:
    items = load_equipment_by_type(equipment_type)
    if item_id not in items:
        raise HTTPException(status_code=404, detail=f"Equipment '{item_id}' not found in type '{equipment_type}'")
    return items[item_id]


@router.get("/spells")
def list_spells() -> dict:
    return load_json("spells.json")


@router.get("/features")
def list_features() -> dict:
    return load_json("features.json")


@router.get("/classes")
def list_classes() -> dict:
    return load_json("classes.json")


@router.get("/backgrounds")
def list_backgrounds() -> dict:
    return load_json("backgrounds.json")


@router.get("/races")
def list_races() -> dict:
    return load_json("races.json")


@router.get("/quests")
def list_quests() -> dict:
    return load_json("quests.json")


@router.get("/intel")
def list_intel() -> dict:
    return load_json("intel.json")


@router.get("/campaign")
def get_campaign() -> dict:
    return load_json("campaign.json")
