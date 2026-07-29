"""
AI GM 服务
负责：
1. 解析玩家输入为结构化意图（Function Calling）
2. 根据规则引擎执行结果生成自然语言叙事

使用 DeepSeek-V4-Flash（兼容 OpenAI ChatCompletions API）。
"""

import os
import json
import logging
from typing import Dict, Any, Optional, List
from dataclasses import dataclass

from openai import OpenAI, APIError

logger = logging.getLogger(__name__)


@dataclass
class IntentResult:
    """玩家意图解析结果"""
    intent: str = "other"
    target_id: str = ""
    target_type: str = "none"
    needs_check: bool = False
    skill: Optional[str] = None
    suggested_dc: Optional[int] = None
    narrative_description: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "intent": self.intent,
            "target_id": self.target_id,
            "target_type": self.target_type,
            "needs_check": self.needs_check,
            "skill": self.skill,
            "suggested_dc": self.suggested_dc,
            "narrative_description": self.narrative_description,
        }


class AIGM:
    """AI GM 封装"""

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
        "combat",
        "other",
    ]

    # 支持的目标类型
    TARGET_TYPES = ["npc", "item", "location", "exit", "none"]

    def __init__(self):
        self.api_key = os.getenv("DEEPSEEK_API_KEY", "")
        self.base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
        self.model = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
        self.enabled = os.getenv("ENABLE_AI_GM", "true").lower() == "true"

        if not self.api_key or self.api_key == "YOUR_DEEPSEEK_API_KEY_HERE":
            logger.warning("DEEPSEEK_API_KEY 未配置，AI GM 将不可用")
            self.client = None
        else:
            self.client = OpenAI(api_key=self.api_key, base_url=self.base_url)

    # ------------------------------------------------------------------
    # 1. 意图解析
    # ------------------------------------------------------------------
    def interpret(self, player_input: str, context: Dict[str, Any]) -> IntentResult:
        """
        使用 Function Calling 解析玩家输入为结构化意图。
        如果 AI 调用失败，返回 intent=other 的降级结果。
        """
        if not self.client or not self.enabled:
            logger.info("AI GM 未启用，返回 other 意图")
            return IntentResult(
                intent="other",
                narrative_description=f"玩家输入：{player_input}",
            )

        messages = [
            {"role": "system", "content": self._interpret_system_prompt()},
            {"role": "user", "content": self._interpret_user_prompt(player_input, context)},
        ]

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.1,
                max_tokens=500,
            )

            content = (response.choices[0].message.content or "").strip()
            logger.info(f"AI 意图解析原始输出: {content[:300]}")

            parsed = self._extract_json_from_content(content)
            if parsed:
                result = self._parse_intent_args(parsed)
                # 硬约束：校验目标是否真实存在于当前上下文
                result = self._validate_intent_against_context(result, context, player_input)
                return result

            logger.warning(f"AI 输出无法解析为 JSON: {content[:200]}")

        except APIError as e:
            logger.error(f"AI 意图解析 API 错误: {e}")
        except Exception as e:
            logger.error(f"AI 意图解析异常: {e}")

        # 降级
        return IntentResult(
            intent="other",
            narrative_description=f"玩家输入：{player_input}",
        )

    # ------------------------------------------------------------------
    # 2. 叙事生成
    # ------------------------------------------------------------------
    def narrate(
        self,
        player_input: str,
        intent_result: IntentResult,
        rule_result: Dict[str, Any],
        state_changes: List[Dict[str, Any]],
        context: Dict[str, Any],
    ) -> str:
        """
        根据规则引擎执行结果生成自然语言叙事。
        如果 AI 调用失败，返回 rule_result 中的 gm_text 作为降级。
        """
        if not self.client or not self.enabled:
            return rule_result.get("gm_text", "GM 没有回应。")

        messages = [
            {"role": "system", "content": self._narrate_system_prompt()},
            {"role": "user", "content": self._narrate_user_prompt(
                player_input, intent_result, rule_result, state_changes, context
            )},
        ]

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.8,
                max_tokens=800,
            )
            text = response.choices[0].message.content.strip()
            return text if text else rule_result.get("gm_text", "GM 没有回应。")

        except APIError as e:
            logger.error(f"AI 叙事生成 API 错误: {e}")
        except Exception as e:
            logger.error(f"AI 叙事生成异常: {e}")

        return rule_result.get("gm_text", "GM 没有回应。")

    # ------------------------------------------------------------------
    # Prompt 构建
    # ------------------------------------------------------------------
    def _interpret_system_prompt(self) -> str:
        return """你是 DNDBOX 的意图解析器，负责把玩家的自然语言输入解析为结构化动作。

规则：
1. 只能基于提供的当前场景、地点、NPC、物品进行解析。
2. 禁止推断未在上下文中出现的 NPC、地点或物品。
3. 如果玩家输入含糊不清，选择最可能的意图；如果完全无法理解，intent 使用 "other"。
4. 不要代替玩家做决定，只解析其输入表达的意思。
5. 输出必须是且仅是一个 JSON 对象，不要 Markdown 代码块，不要额外解释。

JSON 字段说明：
- intent：意图，必须是以下之一：talk、move、advance_scene、perception、investigation、steal、look、use_item、combat、other
- target_id：目标 ID。与 NPC 交谈时填 NPC 的 id；移动时填目标地点/出口的 id；偷窃时填物品 id；查看周围或无明确目标时留空字符串
- target_type：目标类型，必须是：npc、item、location、exit、none
- needs_check：该动作是否需要掷骰检定（true/false）
- skill：如需检定，填写对应技能或属性名，例如 "persuasion"、"stealth"、"perception"、"investigation"、"sleight_of_hand"
- suggested_dc：建议的检定 DC 难度（数字），若不需要检定则为 null
- narrative_description：一句话概括玩家想做什么；如果玩家动作目标不存在，请说明"玩家试图做某事，但当前地点没有某目标"

重要约束：
	- 场景描述（地点描述）中明确提到的具体物品、NPC、地点都是真实存在的，玩家可以与它们交互。
	- 【可见物品】列表是场景描述中可交互物品的汇总， steal 意图只能针对其中真实存在的物品。
	- 如果玩家想偷的物品不在【可见物品】列表中，且场景描述里也没有明确提到，intent 必须使用 "other"，target_id 留空，并在 narrative_description 中说明目标不存在。
	- 不要根据氛围描写或泛泛推断虚构物品；只有场景描述明确点名的物品，或【可见物品】列表中的物品，才是真实可交互的。
	- 某些物品可能标为 `stealable: false`，它们依然存在且可交互，只是不能被偷窃。玩家试图偷窃这类物品时，仍然返回 `steal` 意图，由规则引擎处理"无法被偷走"的情况。

	示例：
	假设【可见物品】包含 id=sword-coast-map（剑湾地图，stealable: false）和 id=supplies-neverwinter（绝冬城补给箱，stealable: true），地点描述里提到"桌上摊着一张剑湾地图"。
	玩家输入"偷走桌上的地图"，应输出：
	{"intent":"steal","target_id":"sword-coast-map","target_type":"item","needs_check":true,"skill":"sleight_of_hand","suggested_dc":12,"narrative_description":"玩家试图偷走桌上的剑湾地图。"}

	玩家输入"偷走补给箱"，应输出：
	{"intent":"steal","target_id":"supplies-neverwinter","target_type":"item","needs_check":true,"skill":"sleight_of_hand","suggested_dc":15,"narrative_description":"玩家试图偷走绝冬城补给箱。"}

	玩家输入"偷走桌上的酒杯"，应输出：
	{"intent":"other","target_id":"","target_type":"none","needs_check":false,"skill":null,"suggested_dc":null,"narrative_description":"玩家试图偷窃桌上的酒杯，但当前地点没有名为'酒杯'的可交互物品。"}"""

    def _interpret_user_prompt(self, player_input: str, context: Dict[str, Any]) -> str:
        scene = context.get("scene", {})
        location = context.get("location", {})
        npcs = context.get("npcs", [])
        items = context.get("items", [])

        npc_text = "\n".join([
            f"- id={n.get('id')}，{n.get('name')}（{n.get('race', '')} {n.get('role', '')}）"
            for n in npcs
        ]) or "无"

        def _item_line(i):
            flags = []
            if i.get("stealable"):
                flags.append("可偷窃")
            return f"- id={i.get('id')}，{i.get('name')}{'（' + '，'.join(flags) + '）' if flags else ''}：{i.get('description', '')}"

        item_text = "\n".join([_item_line(i) for i in items]) or "无"

        exits = location.get("exits", []) if location else []
        exit_text = "\n".join([
            f"- {e.get('name')}（目标 id={e.get('target')}）"
            for e in exits
        ]) or "无"

        next_scene_id = scene.get("next_scene", "")
        next_scene_hint = f"当前场景可以推进到下一幕：{next_scene_id}" if next_scene_id else "当前场景没有明确的下一幕"

        return f"""【当前场景】
场景名：{scene.get('name', '未知')}
地点：{location.get('name', '未知')}
地点描述：{location.get('scene_text', location.get('description', ''))}

注意：地点描述中明确提到的具体物品、NPC、出口都是真实存在的。【可见物品】列表是这些可交互物品的汇总；只有未在场景描述中点名、也未在列表中出现的物品，才视为不存在。

【在场 NPC】
{npc_text}

【可见物品】
{item_text}

【可前往地点 / 出口】
{exit_text}

【场景推进信息】
{next_scene_hint}

【玩家输入】
{player_input}

请解析玩家意图，只输出 JSON。

移动意图示例：
- 玩家输入"去市场广场" → {{"intent":"move","target_id":"neverwinter-market","target_type":"exit"}}
- 玩家输入"前往三猪小径/出发/继续前进" → {{"intent":"advance_scene","target_id":"","target_type":"none"}}"""

    def _narrate_system_prompt(self) -> str:
        return """你是 DNDBOX 的地下城主（GM），正在为玩家主持《凡戴尔的失落矿坑》第一章"地精之箭"。

你的职责：
1. 根据提供的当前场景、地点、NPC 状态、玩家动作、检定结果、状态变化和规则引擎提示，生成自然、有氛围的叙事回复。
2. 严格基于提供的上下文，禁止引入未提及的 NPC、地点、物品或剧情。
3. 地点描述（scene_text）中明确提到的具体物品、NPC、地点都是真实存在的，玩家可以与它们交互。【可见物品】列表是这些可交互物品的汇总。不要根据氛围描写虚构未明确点名的可偷窃、可拾取或可使用的物品。
	4. 如果玩家试图与一个不在【可见物品】列表、且场景描述也没有明确提到的目标互动，直接说明当前地点没有该目标，不要编造目标存在但无法互动的情节。
	5. 如果【规则引擎提示】指出目标不存在或动作无法执行，你必须直接说明该情况，不要自行改写为"目标存在但失败"。
	6. 保持叙事简洁，通常 2-4 句话为宜，不要过度描写。
	7. 不要直接暴露 NPC 的内部状态（如"他怀疑你了"），而是通过行为和表情暗示。
	8. 不要代替玩家做决定，不要替玩家行动。
	9. 输出纯文本，不要 Markdown、不要 JSON、不要使用 emoji。

	示例：
	玩家输入"悄悄偷走桌上的剑湾地图"，【规则引擎提示】为"剑湾地图 无法被偷走。"，且该物品在【可见物品】中但 `stealable: false`。
	错误回复："你的手刚碰到地图，甘德伦就收走了它。"（这暗示偷窃检定失败）
	正确回复："你伸手想拿走地图，甘德伦粗短的手指按住了羊皮纸的一角：'这地图可不能给你，没了它我们可找不到路。'"

	玩家输入"悄悄偷走桌上的酒杯"，【可见物品】中没有酒杯，场景描述里也没有明确提到酒杯。
	错误回复："你的手刚碰到酒杯，甘德伦就按住了它。"
	正确回复："你扫视桌面，除了地图和杯盏留下的蜡渍外，并没有什么值得留意的酒杯。"（目标不存在）"""

    def _narrate_user_prompt(
        self,
        player_input: str,
        intent_result: IntentResult,
        rule_result: Dict[str, Any],
        state_changes: List[Dict[str, Any]],
        context: Dict[str, Any],
    ) -> str:
        scene = context.get("scene", {})
        location = context.get("location", {})
        npcs = context.get("npcs", [])
        items = context.get("items", [])
        history = context.get("history", [])
        character = context.get("character", {})

        npc_text = "\n".join([
            f"- {n.get('name')}（{n.get('race', '')} {n.get('role', '')}）：{n.get('current_status', '在场')}"
            for n in npcs
        ]) or "无"

        def _item_line_narrative(i):
            flags = []
            if i.get("stealable"):
                flags.append("可偷窃")
            return f"- {i.get('name')}{'（' + '，'.join(flags) + '）' if flags else ''}：{i.get('description', '')}"

        item_text = "\n".join([_item_line_narrative(i) for i in items]) or "无"

        history_text = "\n".join([
            f"{h.get('role', '未知')}：{h.get('content', '')}"
            for h in history[-10:]
        ]) or "无"

        checks_text = json.dumps(rule_result.get("checks", []), ensure_ascii=False, indent=2)
        changes_text = json.dumps(state_changes, ensure_ascii=False, indent=2)
        rule_hint = rule_result.get("gm_text", "")
        rule_hint_text = f"规则引擎提示：{rule_hint}" if rule_hint else ""

        target_name = ""
        if intent_result.target_type == "npc":
            target_name = next((n.get("name") for n in npcs if n.get("id") == intent_result.target_id), intent_result.target_id)
        elif intent_result.target_type == "item":
            target_name = next((i.get("name") for i in items if i.get("id") == intent_result.target_id), intent_result.target_id)
        else:
            target_name = intent_result.target_id

        return f"""【章节背景】
{context.get('chapter_summary', '无')}

【当前场景】
场景名：{scene.get('name', '未知')}
地点：{location.get('name', '未知')}
地点描述：{location.get('scene_text', location.get('description', ''))}

注意：地点描述中明确提到的具体物品、NPC、出口都是真实存在的。【可见物品】列表是这些可交互物品的汇总；只有未在场景描述中点名、也未在列表中出现的物品，才视为不存在。

【在场 NPC】
{npc_text}

【可见物品】
{item_text}

【玩家角色】
{character.get('name', '未知')}，{character.get('race', '')} {character.get('class', '')} {character.get('level', '')}级

【最近对话】
{history_text}

【玩家动作】
{player_input}

【解析结果】
意图：{intent_result.intent}
目标：{target_name}（{intent_result.target_type}）
动作描述：{intent_result.narrative_description}

{rule_hint_text}

【检定结果】
{checks_text}

【状态变化】
{changes_text}

请根据以上信息，生成一段 GM 叙事回复。"""

    # ------------------------------------------------------------------
    # 工具函数
    # ------------------------------------------------------------------
    def _parse_intent_args(self, args: Dict[str, Any]) -> IntentResult:
        intent = args.get("intent", "other")
        if intent not in self.INTENTS:
            intent = "other"

        target_type = args.get("target_type", "none")
        if target_type not in self.TARGET_TYPES:
            target_type = "none"

        return IntentResult(
            intent=intent,
            target_id=args.get("target_id", ""),
            target_type=target_type,
            needs_check=bool(args.get("needs_check", False)),
            skill=args.get("skill") or None,
            suggested_dc=args.get("suggested_dc") or None,
            narrative_description=args.get("narrative_description", ""),
        )

    def _validate_intent_against_context(
        self,
        result: IntentResult,
        context: Dict[str, Any],
        player_input: str,
    ) -> IntentResult:
        """
        硬约束校验：确保目标 ID 真实存在于当前上下文。
        如果 AI 编造了不存在的目标，强制回退为 other，避免幻觉物品/NPC/地点。
        """
        valid_npcs = {n.get("id") for n in context.get("npcs", []) if n.get("id")}
        valid_items = {i.get("id") for i in context.get("items", []) if i.get("id")}

        invalid = False
        reason = ""

        if result.intent == "talk":
            if result.target_type == "npc" and result.target_id and result.target_id not in valid_npcs:
                invalid = True
                reason = f"玩家试图与 {result.target_id} 交谈，但当前场景没有该 NPC。"
        elif result.intent == "steal":
            if result.target_type != "item" or not result.target_id or result.target_id not in valid_items:
                invalid = True
                reason = "玩家试图偷窃，但当前地点没有对应的目标物品。"
        elif result.intent == "use_item":
            if result.target_type == "item" and result.target_id and result.target_id not in valid_items:
                invalid = True
                reason = f"玩家试图使用 {result.target_id}，但当前地点没有该物品。"
        # move 目标可能是中文名或出口描述，不做硬校验，交给规则引擎处理。

        if invalid:
            result.intent = "other"
            result.target_id = ""
            result.target_type = "none"
            result.needs_check = False
            result.skill = None
            result.suggested_dc = None
            if not result.narrative_description or "玩家输入" in result.narrative_description:
                result.narrative_description = reason

        # 二次兜底：如果 AI 直接把偷窃请求判为 other，但描述只是复读玩家输入，
        # 则补充说明。若当前地点存在可见物品，说明玩家试图偷窃某件物品（可能不可偷）；
        # 否则说明目标不存在，避免叙事 AI 幻觉该物品。
        if result.intent == "other" and (not result.narrative_description or result.narrative_description.startswith("玩家输入")):
            if "偷" in player_input:
                if valid_items:
                    result.narrative_description = "玩家试图偷窃当前地点的某件物品。"
                else:
                    result.narrative_description = "玩家试图偷窃，但当前地点没有对应的目标物品。"

        # 三次兜底：明显的出发/前进语句应推进到下一幕
        if result.intent == "other":
            advance_keywords = ["前往", "出发", "继续前进", "动身", "上路", "启程"]
            if any(k in player_input for k in advance_keywords):
                next_scene = context.get("scene", {}).get("next_scene")
                if next_scene:
                    result.intent = "advance_scene"
                    result.target_id = ""
                    result.target_type = "none"
                    result.narrative_description = "玩家准备推进到下一幕场景。"

        return result

    def _extract_json_from_content(self, content: str) -> Optional[Dict[str, Any]]:
        """从文本中提取 JSON 对象"""
        # 尝试直接解析
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        # 尝试从 markdown 代码块中提取
        import re
        matches = re.findall(r"```(?:json)?\s*([\s\S]*?)```", content)
        for m in matches:
            try:
                return json.loads(m.strip())
            except json.JSONDecodeError:
                continue

        # 尝试提取第一个 { ... }
        match = re.search(r"\{[\s\S]*?\}", content)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass

        return None
