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


def _ability_mod(score: int) -> int:
    """计算属性调整值"""
    return (score - 10) // 2


def _build_character_defaults(data: dict, class_data: dict, race_data: dict, bg_data: dict, level: int = 1) -> dict:
    """为新角色构建所有默认字段，确保前端渲染不报错"""
    abilities_raw = data.get("abilities", {})
    ability_bonus = data.get("abilityBonus", {})
    ability_keys = ["str", "dex", "con", "int", "wis", "cha"]
    ability_labels = {"str": "力", "dex": "敏", "con": "体", "int": "智", "wis": "感", "cha": "魅"}

    # 应用创建页面分配属性奖励 +2/+1，得到最终属性分数
    corrected_scores = {}
    for key in ability_keys:
        score = abilities_raw.get(key, 10)
        if key == ability_bonus.get("plus2"):
            score += 2
        if key == ability_bonus.get("plus1"):
            score += 1
        corrected_scores[key] = score

    # 构建 abilities 对象格式
    abilities = {}
    for key in ability_keys:
        score = corrected_scores[key]
        mod = _ability_mod(score)
        abilities[key] = {
            "label": ability_labels.get(key, key),
            "value": score,
            "save_bonus": f"+{mod}" if mod >= 0 else str(mod),
            "highlighted": key == ability_bonus.get("plus2") or key == ability_bonus.get("plus1"),
        }

    # 种族名称
    race_name = race_data.get("name", "")
    race_en = race_data.get("name_en", "")

    # 计算战斗数据（基于修正后属性）
    dex_score = corrected_scores.get("dex", 10)
    dex_mod = _ability_mod(dex_score)
    con_score = corrected_scores.get("con", 10)
    con_mod = _ability_mod(con_score)
    str_score = corrected_scores.get("str", 10)
    str_mod = _ability_mod(str_score)

    # 基础 AC（无护甲）= 10 + 敏捷调整值；法师有法师护甲可设为 13+dex
    base_ac = 10 + dex_mod
    # 生命值 = 最大生命骰 + 体质调整值
    hit_die_value = {"fighter": 10, "barbarian": 12, "paladin": 10, "ranger": 10,
                     "rogue": 8, "cleric": 8, "bard": 8, "wizard": 6}.get(data.get("class_id", ""), 8)
    max_hp = hit_die_value + con_mod
    if max_hp < 1:
        max_hp = 1

    combat = {"ac": base_ac, "hp": f"{max_hp} / {max_hp}"}
    xp = {"current": 0, "max": 300, "display": "0 / 300"}
    attack = {
        "melee": {"label": "近战", "bonus": f"+{str_mod}" if str_mod >= 0 else str(str_mod), "damage": "1d4"},
        "ranged": {"label": "远程", "bonus": f"+{dex_mod}" if dex_mod >= 0 else str(dex_mod), "damage": "1d4"},
    }

    # 初始物品栏
    inventory = {"gold": data.get("starting_gold", 100), "items": []}

    # 从种族数据中提取特性与黑暗视觉
    base_traits = list(race_data.get("base_trait_ids", []))
    subrace_id = data.get("subrace_id")
    subrace_data = (race_data.get("subraces", {}) or {}).get(subrace_id, {}) if subrace_id else {}
    subrace_traits = list(subrace_data.get("extra_trait_ids", []))
    all_race_trait_ids = base_traits + subrace_traits

    # 计算黑暗视觉
    darkvision = "0"
    for tid in all_race_trait_ids:
        if "darkvision_12m" in tid or (tid == "darkvision_12m"):
            darkvision = "12m"
        if "superior_darkvision" in tid:
            darkvision = "24m"
            break  # superior overrides normal

    features = {
        "status_ids": [],
        "resistance_ids": [],
        "class_feature_ids": [],
        "trait_ids": all_race_trait_ids,
    }

    # 技能熟练
    class_skills = data.get("class_skills", [])
    human_skill = data.get("human_skill")

    # 种族特性 → 技能熟练映射（与创建人物页 TRAIT_SKILL_MAP 保持一致）
    trait_skill_map = {
        "keen_senses": ["察觉"],
        "stealth_proficient": ["隐匿"],
        "menacing": ["威吓"],
    }
    bg_skill_proficiencies = list(bg_data.get("skill_proficiencies", []))
    race_trait_skills = []
    for tid in all_race_trait_ids:
        if tid in trait_skill_map:
            race_trait_skills.extend(trait_skill_map[tid])

    # 合并所有来源的技能熟练项（背景 + 种族特性 + 职业选择 + 人类通才）
    all_proficient_skills = set(bg_skill_proficiencies + race_trait_skills + class_skills)
    if human_skill:
        all_proficient_skills.add(human_skill)

    def _build_skill_entry(name: str, ability_key: str) -> dict:
        mod_val = _ability_mod(corrected_scores.get(ability_key, 10))
        prof_bonus = 2  # level 1 proficiency
        is_proficient = name in all_proficient_skills
        total = mod_val + (prof_bonus if is_proficient else 0)
        val_str = f"+{total}" if total >= 0 else str(total)
        return {"name": name, "value": val_str, "type": "positive" if is_proficient else ("negative" if total < 0 else "neutral")}

    skill_map = {
        "str": ["运动"],
        "dex": ["体操", "巧手", "隐匿"],
        "int": ["奥秘", "历史", "调查", "自然", "宗教"],
        "wis": ["驯兽", "洞悉", "医药", "察觉", "求生"],
        "cha": ["欺瞒", "威吓", "表演", "说服"],
    }
    sections = []
    for ab_key in ["str", "dex", "int", "wis", "cha"]:
        mod_val = _ability_mod(corrected_scores.get(ab_key, 10))
        mod_str = f"+{mod_val}" if mod_val >= 0 else str(mod_val)
        skill_list = skill_map.get(ab_key, [])
        sections.append({
            "ability": ability_labels.get(ab_key, ab_key),
            "modifier": mod_str,
            "skills": [_build_skill_entry(s, ab_key) for s in skill_list],
        })
    skills = {"proficiency_bonus": "+2", "sections": sections}

    # 法术
    cantrip_ids = data.get("cantrip_ids", [])
    spell_ids = data.get("spell_ids", [])
    spells = {
        "caster_level": level,
        "action_ids": {"normal": ["jump", "throw", "dash"], "class": []},
        "passive_ids": [],
        "spell_ids": {"level_1": spell_ids} if spell_ids else {},
    }

    # 背景
    bg_story = data.get("background", {})
    background = {
        "class": f"{level}级{class_data.get('name', '')}",
        "race": f"{race_name}{' ' + race_en if race_en else ''}",
        "attributes": {
            "move_speed": "9m",
            "darkvision": darkvision,
            "ranged_range": "18m",
            "melee_range": "1.5m",
            "throw_range": "18m",
            "size": "中型",
            "weight": "75kg",
            "carry_weight": f"{str_score * 15}kg",
        },
        "traits": {
            "personality": bg_story.get("trait", ""),
            "ideal": bg_story.get("ideal", ""),
            "bond": bg_story.get("bond", ""),
            "flaw": bg_story.get("flaw", ""),
        },
        "story": [bg_story.get("story", "")] if bg_story.get("story") else [],
    }

    return {
        "combat": combat,
        "xp": xp,
        "attack": attack,
        "inventory": inventory,
        "features": features,
        "abilities": abilities,
        "skills": skills,
        "spells": spells,
        "background": background,
    }


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

    # 构建完整的角色数据（含默认值）
    defaults = _build_character_defaults(data, class_data, race_data, bg_data)

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
        "subclass_id": data.get("subclass_id"),  # 可能为 None
        "subclass": data.get("subclass", ""),  # 可能为空
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


@app.get("/api/characters/{char_id}")
def get_character(char_id: str) -> dict:
    """返回单个人物卡详情"""
    return _load_character(char_id)


@app.delete("/api/characters/{char_id}")
def delete_character(char_id: str) -> dict:
    """删除指定角色"""
    file_path = DATA_DIR / f"{char_id}.json"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Character '{char_id}' not found")
    file_path.unlink()
    return {"ok": True, "deleted": char_id}


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
