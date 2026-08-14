"""AI 意图数据结构（core 与 ai 层共用）。"""
from typing import Dict, Any, Optional
from dataclasses import dataclass


@dataclass
class IntentResult:
    """玩家意图解析结果（AI 工具调用产出，供意图分发确定性执行）"""
    intent: str = "other"
    target_id: str = ""
    target_type: str = "none"
    needs_check: bool = False
    skill: Optional[str] = None
    suggested_dc: Optional[int] = None
    narrative_description: str = ""
    action: str = ""  # 附加动作参数（如被怀疑时的 search/pay/refuse/flee、卫兵的 breakout 等）
    spell_id: str = ""  # 施法专用：法术 id
    target_npc_id: str = ""  # 施法专用：目标 NPC id（伤害类法术需要）

    def to_dict(self) -> Dict[str, Any]:
        return {
            "intent": self.intent,
            "target_id": self.target_id,
            "target_type": self.target_type,
            "needs_check": self.needs_check,
            "skill": self.skill,
            "suggested_dc": self.suggested_dc,
            "narrative_description": self.narrative_description,
            "action": self.action,
            "spell_id": self.spell_id,
            "target_npc_id": self.target_npc_id,
        }
