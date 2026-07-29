"""JSON 文件读写工具"""
import json
from pathlib import Path
from fastapi import HTTPException

DATA_ROOT = Path(__file__).parent.parent.parent / "data"
EQUIPMENT_DIR = DATA_ROOT / "equipment"


def load_json(filename: str) -> dict:
    file_path = DATA_ROOT / filename
    if not file_path.exists():
        return {}
    with open(file_path, encoding="utf-8") as f:
        return json.load(f)


def load_equipment_catalog() -> dict[str, dict]:
    """加载所有装备库文件，按 id 平铺成字典"""
    catalog: dict[str, dict] = {}
    if not EQUIPMENT_DIR.exists():
        return catalog
    for file_path in sorted(EQUIPMENT_DIR.glob("*.json")):
        with open(file_path, encoding="utf-8") as f:
            data = json.load(f)
        for item_id, item in data.get("items", {}).items():
            catalog[item_id] = item
    return catalog


def load_equipment_by_type(equipment_type: str) -> dict[str, dict]:
    """加载指定类型的装备库文件"""
    file_path = EQUIPMENT_DIR / f"{equipment_type}.json"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Equipment type '{equipment_type}' not found")
    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("items", {})
