"""角色构建器：根据创建页数据生成完整角色卡"""
from utils.file_io import load_json


def ability_mod(score: int) -> int:
    """计算属性调整值"""
    return (score - 10) // 2


def build_character_defaults(data: dict, class_data: dict, race_data: dict, bg_data: dict, level: int = 1) -> dict:
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
        mod = ability_mod(score)
        abilities[key] = {
            "label": ability_labels.get(key, key),
            "value": score,
            "save_bonus": f"+{mod}" if mod >= 0 else str(mod),
            "highlighted": key == ability_bonus.get("plus2") or key == ability_bonus.get("plus1"),
        }

    race_name = race_data.get("name", "")
    race_en = race_data.get("name_en", "")

    dex_score = corrected_scores.get("dex", 10)
    dex_mod = ability_mod(dex_score)
    con_score = corrected_scores.get("con", 10)
    con_mod = ability_mod(con_score)
    str_score = corrected_scores.get("str", 10)
    str_mod = ability_mod(str_score)

    base_ac = 10 + dex_mod
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

    inventory = {"gold": data.get("starting_gold", 100), "items": []}

    # 种族特性与黑暗视觉
    base_traits = list(race_data.get("base_trait_ids", []))
    subrace_id = data.get("subrace_id")
    subrace_data = (race_data.get("subraces", {}) or {}).get(subrace_id, {}) if subrace_id else {}
    subrace_traits = list(subrace_data.get("extra_trait_ids", []))
    all_race_trait_ids = base_traits + subrace_traits

    darkvision = "0"
    for tid in all_race_trait_ids:
        if "darkvision_12m" in tid or (tid == "darkvision_12m"):
            darkvision = "12m"
        if "superior_darkvision" in tid:
            darkvision = "24m"
            break

    features = {
        "status_ids": [],
        "resistance_ids": [],
        "class_feature_ids": [],
        "trait_ids": all_race_trait_ids,
    }

    class_skills = data.get("class_skills", [])
    human_skill = data.get("human_skill")

    trait_skill_map = {"keen_senses": ["察觉"], "stealth_proficient": ["隐匿"], "menacing": ["威吓"]}
    bg_skill_proficiencies = list(bg_data.get("skill_proficiencies", []))
    race_trait_skills = []
    for tid in all_race_trait_ids:
        if tid in trait_skill_map:
            race_trait_skills.extend(trait_skill_map[tid])

    all_proficient_skills = set(bg_skill_proficiencies + race_trait_skills + class_skills)
    if human_skill:
        all_proficient_skills.add(human_skill)

    def _build_skill_entry(name: str, ability_key: str) -> dict:
        mod_val = ability_mod(corrected_scores.get(ability_key, 10))
        prof_bonus = 2
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
        mod_val = ability_mod(corrected_scores.get(ab_key, 10))
        mod_str = f"+{mod_val}" if mod_val >= 0 else str(mod_val)
        skill_list = skill_map.get(ab_key, [])
        sections.append({
            "ability": ability_labels.get(ab_key, ab_key),
            "modifier": mod_str,
            "skills": [_build_skill_entry(s, ab_key) for s in skill_list],
        })
    skills = {"proficiency_bonus": "+2", "sections": sections}

    cantrip_ids = data.get("cantrip_ids", [])
    spell_ids = data.get("spell_ids", [])
    spells = {
        "caster_level": level,
        "action_ids": {"normal": ["jump", "throw", "dash"], "class": []},
        "passive_ids": [],
        "spell_ids": {"level_1": spell_ids} if spell_ids else {},
    }

    bg_story = data.get("background", {})
    background = {
        "class": f"{level}级{class_data.get('name', '')}",
        "race": f"{race_name}{' ' + race_en if race_en else ''}",
        "attributes": {
            "move_speed": "9m", "darkvision": darkvision, "ranged_range": "18m",
            "melee_range": "1.5m", "throw_range": "18m", "size": "中型",
            "weight": "75kg", "carry_weight": f"{str_score * 15}kg",
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
        "combat": combat, "xp": xp, "attack": attack,
        "inventory": inventory, "features": features,
        "abilities": abilities, "skills": skills,
        "spells": spells, "background": background,
    }
