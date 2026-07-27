from fastapi import FastAPI, HTTPException, Body
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
import json
import uuid
from datetime import datetime
from pathlib import Path

app = FastAPI(title="DNDBOX Backend", version="0.1.0")

# 开发阶段允许前端跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 数据目录
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data" / "characters"
EQUIPMENT_DIR = BASE_DIR / "data" / "equipment"
DATA_ROOT = BASE_DIR / "data"


def _load_json(filename: str) -> dict:
    file_path = DATA_ROOT / filename
    if not file_path.exists():
        return {}
    with open(file_path, encoding="utf-8") as f:
        return json.load(f)


def _load_character(char_id: str) -> dict:
    file_path = DATA_DIR / f"{char_id}.json"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")
    with open(file_path, encoding="utf-8") as f:
        return json.load(f)


def _load_equipment_catalog() -> dict[str, dict]:
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


def _load_equipment_by_type(equipment_type: str) -> dict[str, dict]:
    """加载指定类型的装备库文件"""
    file_path = EQUIPMENT_DIR / f"{equipment_type}.json"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Equipment type '{equipment_type}' not found")
    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("items", {})


@app.get("/api/characters")
def list_characters() -> list[dict]:
    """返回所有人物卡列表"""
    characters = []
    if DATA_DIR.exists():
        for file_path in sorted(DATA_DIR.glob("*.json")):
            with open(file_path, encoding="utf-8") as f:
                characters.append(json.load(f))
    return characters


@app.post("/api/characters")
def create_character(data: dict = Body(...)) -> dict:
    """创建新角色，保存为 JSON 文件"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    char_id = f"char_{datetime.now().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:6]}"

    # 从数据文件中查找种族/职业名称，确保 lobby 兼容
    races = _load_json("races.json")
    classes = _load_json("classes.json")
    backgrounds = _load_json("backgrounds.json")
    race_data = races.get(data.get("race_id", ""), {})
    class_data = classes.get(data.get("class_id", ""), {})
    bg_data = backgrounds.get(data.get("background_id", ""), {})

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
        "background_id": data.get("background_id"),
        "background_name": bg_data.get("name", ""),
        "level": 1,
        "abilities": data.get("abilities", {}),
        "ability_bonus": data.get("abilityBonus", {}),
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


@app.get("/api/characters/{char_id}")
def get_character(char_id: str) -> dict:
    """返回单个人物卡详情"""
    return _load_character(char_id)


@app.get("/api/equipment")
def list_equipment() -> dict[str, dict]:
    """返回所有装备库数据，按装备 id 平铺"""
    return _load_equipment_catalog()


@app.get("/api/equipment/{equipment_type}")
def get_equipment_type(equipment_type: str) -> dict[str, dict]:
    """返回指定类型的所有装备"""
    return _load_equipment_by_type(equipment_type)


@app.get("/api/equipment/{equipment_type}/{item_id}")
def get_equipment_item(equipment_type: str, item_id: str) -> dict:
    """返回单个装备详情"""
    items = _load_equipment_by_type(equipment_type)
    if item_id not in items:
        raise HTTPException(status_code=404, detail=f"Equipment '{item_id}' not found in type '{equipment_type}'")
    return items[item_id]


@app.get("/api/spells")
def list_spells() -> dict:
    """返回法术/动作/被动目录"""
    return _load_json("spells.json")


@app.get("/api/features")
def list_features() -> dict:
    """返回所有特性目录（状态/抗性/职业特性/种族特性）"""
    return _load_json("features.json")


@app.get("/api/classes")
def list_classes() -> dict:
    """返回职业与子职业定义"""
    return _load_json("classes.json")


@app.get("/api/backgrounds")
def list_backgrounds() -> dict:
    """返回所有背景定义"""
    return _load_json("backgrounds.json")


@app.get("/api/races")
def list_races() -> dict:
    """返回所有种族与亚种族定义"""
    return _load_json("races.json")


@app.get("/api/quests")
def list_quests() -> dict:
    """返回所有任务（主线+地区）"""
    return _load_json("quests.json")


@app.get("/api/intel")
def list_intel() -> dict:
    """返回情报手记"""
    return _load_json("intel.json")


@app.get("/api/campaign")
def get_campaign() -> dict:
    """返回当前剧本数据（含章回内容）"""
    return _load_json("campaign.json")


# 根路径自动跳转到登录页
@app.get("/")
def root():
    return RedirectResponse(url="/login.html")


# 将项目根目录作为静态文件服务
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static")
