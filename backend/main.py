from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
import json
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
