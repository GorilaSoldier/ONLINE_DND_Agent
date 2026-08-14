"""AI 工具 schema（ai）：process_action / update_npc_status 的定义与意图枚举。
与 prompt（ai_gm）分离，便于维护与复用。"""

# 支持的意图列表
INTENTS = [
    "talk",
    "move",
    "advance_scene",
    "perception",
    "investigation",
    "steal",
    "look",
    "use_item",
    "take",
    "trade",
    "cast_spell",
    "use_action",
    "resolve_suspicion",
    "arrest",
    "combat",
    "other",
]

# 支持的目标类型
TARGET_TYPES = ["npc", "item", "location", "exit", "none"]

TOOLS = [{
    "type": "function",
    "function": {
        "name": "process_action",
        "description": (
            "当玩家输入涉及状态变更（偷窃、拿取、移动、交易）、检定（侦察、调查）"
            "或需要后端校验目标是否存在时，调用此工具。"
            "纯对话、闲聊、查看周围环境描述等不需要后端处理的场景不要调用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "intent": {
                    "type": "string",
                    "enum": ["talk","move","advance_scene","perception","investigation","steal","look","use_item","take","trade","cast_spell","use_action","resolve_suspicion","arrest","combat","other"],
                    "description": "玩家意图"
                },
                "target_id": {
                    "type": "string",
                    "description": "目标 ID（如 NPC id、物品 id、地点 id；use_action 时为动作 id），无目标时为空字符串"
                },
                "target_type": {
                    "type": "string",
                    "enum": ["npc","item","location","exit","none"],
                    "description": "目标类型"
                },
                "spell_id": {
                    "type": "string",
                    "description": "施法专用：法术 id（intent=cast_spell 时必填，来自角色已知法术）"
                },
                "target_npc_id": {
                    "type": "string",
                    "description": "施法专用：目标 NPC id（intent=cast_spell 且是伤害类法术时必填）"
                },
                "action": {
                    "type": "string",
                    "enum": ["search", "pay", "refuse", "deception", "intimidation", "persuasion", "flee", "breakout"],
                    "description": "附加动作参数。intent=resolve_suspicion：search=同意搜身、pay=给钱/赔偿、refuse=拒绝、deception=欺瞒/撒谎、intimidation=威吓、persuasion=游说（仅延迟发现时有效）、flee=逃跑（被抓住时先挣脱，挣脱后再敏捷逃脱）。intent=arrest：flee=逃跑（敏捷逃脱）、breakout=挣脱、search=同意搜身、pay=赔偿、deception/intimidation/persuasion=社交求情。"
                },
                "needs_check": {
                    "type": "boolean",
                    "description": "是否需要掷骰检定"
                },
                "skill": {
                    "type": "string",
                    "description": "检定技能名（如 perception / investigation / sleight_of_hand），不需要检定时为 null"
                },
                "suggested_dc": {
                    "type": "integer",
                    "description": "建议检定 DC，不需要检定时为 null"
                }
            },
            "required": ["intent", "target_id", "target_type"]
        }
    }
}, {
    "type": "function",
    "function": {
        "name": "update_npc_status",
        "description": (
            "当在场 NPC 死亡、被击晕或离开当前地点时调用，用于同步前端角色栏显示。"
            "死亡/眩晕会在角色名字后显示（已死亡）/（眩晕）标记，离开则将该角色从当前地点角色列表移除。"
            "纯对话、叙事时不要调用，只有 NPC 状态确实发生变化时才调用。"
            "NPC 数据中标注 plot_critical 的关键角色（剧本指定不可死）不要标记为 dead，其状态由剧本/规则引擎决定。"
            "禁止将工具调用以 XML 文本形式输出，必须使用工具调用功能。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "npc_id": {
                    "type": "string",
                    "description": "状态发生变化的 NPC id"
                },
                "status": {
                    "type": "string",
                    "enum": ["dead", "stunned", "left", "alive"],
                    "description": "dead=已死亡；stunned=眩晕（丧失行动能力）；left=已离开当前地点；alive=恢复正常"
                }
            },
            "required": ["npc_id", "status"]
        }
    }
}]
