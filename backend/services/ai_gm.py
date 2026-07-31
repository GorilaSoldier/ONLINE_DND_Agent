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
        "take",
        "trade",
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
                        "enum": ["talk","move","advance_scene","perception","investigation","steal","look","use_item","take","trade","combat","other"],
                        "description": "玩家意图"
                    },
                    "target_id": {
                        "type": "string",
                        "description": "目标 ID（如 NPC id、物品 id、地点 id），无目标时为空字符串"
                    },
                    "target_type": {
                        "type": "string",
                        "enum": ["npc","item","location","exit","none"],
                        "description": "目标类型"
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
    }]

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

        # Token 用量追踪
        self.last_usage = {}
        self.last_prompt_chars = {}
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.total_calls = 0

    # ------------------------------------------------------------------
    # Tool Calling：AI 自主判断是否需要后端处理
    # ------------------------------------------------------------------
    @staticmethod
    def _build_history_messages(history: list) -> list:
        """将 state.history 转为标准 API messages 格式。
        history 格式: [{role: "player"/"gm", content: "...", time: 0}, ...]
        输出:       [{"role": "user", ...}, {"role": "assistant", ...}, ...]
        """
        messages = []
        for h in history:
            if h.get("role") == "player":
                messages.append({"role": "user", "content": h["content"]})
            elif h.get("role") == "gm":
                messages.append({"role": "assistant", "content": h["content"]})
        return messages

    def chat_with_tools(self, player_input: str, context: Dict[str, Any], full_context: bool = True, extra_messages: list = None, history_messages: list = None):
        """
        第 1 次 API 调用（流式）：AI 判断是否需要 tool_call。
        stream=True 时逐个 token yield，同时收集 tool_call 信息。
        extra_messages: 开场的背景 exchange（固定插入 system 之后）
        history_messages: 累积的历史对话（标准 API 格式，逐轮增长）
        Messages 结构: [system, extra_messages..., history_messages..., user_prompt]
        """
        prompt = self._tc_full_user_prompt(player_input, context) if full_context else self._tc_lite_user_prompt(player_input, context)
        messages = [
            {"role": "system", "content": self._tc_system_prompt()},
        ]
        # 开场背景 exchange
        if extra_messages:
            messages.extend(extra_messages)
        # 累积的历史对话
        if history_messages:
            messages.extend(history_messages)
        messages.append({"role": "user", "content": prompt})

        # 记录 prompt 尺寸
        prompt_chars = sum(len(m["content"]) for m in messages)
        self.last_prompt_chars['tc_round1'] = prompt_chars

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                tools=self.TOOLS,
                tool_choice="auto",
                temperature=0.7,
                max_tokens=1200,
                stream=True,
            )

            content_parts = []
            reasoning_parts = []  # 思考模式产生的 reasoning_content
            tool_call_id = None
            tool_call_name = None
            tool_call_args_parts = []

            for chunk in response:
                delta = chunk.choices[0].delta if chunk.choices else None
                if not delta:
                    continue

                # 思考模式 reasoning_content
                rc = getattr(delta, 'reasoning_content', None)
                if rc:
                    reasoning_parts.append(rc)

                # 普通文本
                if delta.content:
                    content_parts.append(delta.content)
                    yield ("text", delta.content)

                # tool call
                if delta.tool_calls:
                    tc = delta.tool_calls[0]
                    if tc.id:
                        tool_call_id = tc.id
                    if tc.function:
                        if tc.function.name:
                            tool_call_name = tc.function.name
                        if tc.function.arguments:
                            tool_call_args_parts.append(tc.function.arguments)

            content = "".join(content_parts)
            reasoning_content = "".join(reasoning_parts) or None
            tool_args = {}
            if tool_call_name and tool_call_args_parts:
                try:
                    tool_args = json.loads("".join(tool_call_args_parts))
                except json.JSONDecodeError:
                    pass

            yield ("done", {"content": content, "tool_name": tool_call_name, "tool_args": tool_args, "reasoning_content": reasoning_content})

        except Exception as e:
            logger.error(f"Tool Calling 首轮 API 错误: {e}")
            yield ("error", str(e))

    def narrate_with_result(
        self,
        player_input: str,
        tool_result: dict,
        context: Dict[str, Any],
        stream: bool = True,
        full_context: bool = False,
        reasoning_content: str = None,
        extra_messages: list = None,
        history_messages: list = None,
    ):
        """
        第 2 次 API 调用：AI 拿到规则引擎结果后生成回复。
        stream=True 时逐 token yield。
        Messages 结构: [system, extra_messages..., history_messages..., user, assistant(tool_call), tool_result]
        """
        prompt = self._tc_full_user_prompt(player_input, context) if full_context else self._tc_lite_user_prompt(player_input, context)

        # 构建 assistant 消息（必须回传 reasoning_content）
        assistant_msg = {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_process_action",
                "type": "function",
                "function": {
                    "name": "process_action",
                    "arguments": json.dumps(tool_result.get("arguments", {}), ensure_ascii=False),
                }
            }]
        }
        if reasoning_content:
            assistant_msg["reasoning_content"] = reasoning_content

        messages = [
            {"role": "system", "content": self._tc_system_prompt()},
        ]
        if extra_messages:
            messages.extend(extra_messages)
        if history_messages:
            messages.extend(history_messages)
        messages.extend([
            {"role": "user", "content": prompt},
            assistant_msg,
            {
                "role": "tool",
                "tool_call_id": "call_process_action",
                "content": json.dumps(tool_result.get("result", {}), ensure_ascii=False),
            }
        ])

        # 记录 prompt 尺寸（含所有消息）
        prompt_chars = sum(len(str(m.get("content", "") or "")) for m in messages)
        # 加上 tool_calls 文本
        prompt_chars += len(json.dumps(tool_result.get("arguments", {}), ensure_ascii=False))
        prompt_chars += len(json.dumps(tool_result.get("result", {}), ensure_ascii=False))
        self.last_prompt_chars['tc_round2'] = prompt_chars

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.7,
                max_tokens=1200,
                stream=stream,
            )

            if stream:
                for chunk in response:
                    if chunk.choices and chunk.choices[0].delta.content:
                        yield chunk.choices[0].delta.content
            else:
                return response.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"Tool Calling 结果叙事 API 错误: {e}")
            if stream:
                yield tool_result.get("result", {}).get("gm_hint", "GM 没有回应。")
            else:
                return tool_result.get("result", {}).get("gm_hint", "GM 没有回应。")

    # ------------------------------------------------------------------
    # 开场白生成（非 Tool Calling，纯文本生成）
    # ------------------------------------------------------------------
    def generate_opening(self, adventure_name: str, chapter_summary: str,
                         scene_name: str, location: dict, npcs: list,
                         items: list, character_name: str) -> str:
        """生成开场叙事。不经过 Tool Calling，纯文本生成。"""
        npc_text = "\n".join([
            f"- {n.get('name')}（{n.get('race', '')} {n.get('role', '')}）"
            for n in npcs
        ]) or "无"

        desc = location.get('scene_text', location.get('description', ''))

        system_prompt = f"""你是 DNDBOX 的地下城主（GM），正在主持《{adventure_name}》的开场叙事。

规则：
1. 基于提供的上下文写开场白，禁止引入未提及的 NPC、地点、物品。
2. 只能描述玩家角色此刻应该知道的信息，严禁剧透任何秘密、阴谋或未来剧情。
3. 人称：使用"你"称呼玩家角色。不用介绍玩家角色的姓名、身份、职业或背景——玩家已经知道自己的角色是谁。
4. 叙事风格：古风奇幻，但保持简洁自然，不要堆砌形容词。
5. 交代清楚：前因后果、当前地点、在场人物、接下来要做什么。
6. 纯文字输出，不用 Markdown，不用 emoji。"""

        user_prompt = f"""【模组概述】
{chapter_summary}

【当前场景】{scene_name}
【地点】{location.get('name', '')}
【地点描述】{desc}

【在场 NPC】
{npc_text}

请为以上场景生成一段开场白。要求：
1. 交代前因——你为什么会在这里（护送甘德伦的采矿物资去凡达林），但不要说"你是XXX"之类介绍角色身份的话
2. 描述当前地点环境（矿业公会大厅）
3. 介绍在场 NPC（甘德伦·碎石者、修达·豪温特）和他们的状态
4. 自然地引出当前任务：护送物资前往凡达林，十个金币报酬"""

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        prompt_chars = sum(len(m["content"]) for m in messages)
        self.last_prompt_chars['opening'] = prompt_chars

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0.8,
                max_tokens=2000,
                stream=False,
            )
            content = response.choices[0].message.content.strip()
            self.total_calls += 1
            if hasattr(response, 'usage') and response.usage:
                self.total_prompt_tokens += response.usage.prompt_tokens
                self.total_completion_tokens += response.usage.completion_tokens
                self.last_usage['opening'] = {
                    'prompt_tokens': response.usage.prompt_tokens,
                    'completion_tokens': response.usage.completion_tokens,
                }
            return content
        except Exception as e:
            logger.error(f"开场白生成失败: {e}")
            raise

    # ------------------------------------------------------------------
    # Tool Calling Prompts
    # ------------------------------------------------------------------
    def _tc_system_prompt(self) -> str:
        return """你是 DNDBOX 的地下城主（GM），正在主持《凡戴尔的失落矿坑》第一章。

规则：
1. 只能基于提供的上下文回复，禁止引入未提及的 NPC、地点、物品或事件。
2. 地点描述中明确提到的物品、NPC 均为真实存在。
3. 保持简洁，通常 1-3 句话。
4. 不要过度描写，不要用修辞——直接说明发生了什么。
5. 纯文字输出，不用 Markdown，不用 emoji。
6. NPC 的「秘密」字段是该 NPC 极力隐瞒的事——被问到时要含糊其辞或转移话题，绝不能直接承认。
7. 【被动发现】是你作为 GM 自动为玩家揭示的环境信息（基于被动察觉/被动调查）。如果存在，请在首次描述场景时自然融入。若玩家已通过其他方式发现过，不需要重复。
8. 【检定叙事铁律】当检定成功但没有发现任何隐藏信息时，直接说"你没有发现任何异常/隐藏的东西"。绝对禁止凭空编造不存在的人物、物品、事件或细节来"丰富"检定结果。

工具使用（重要）：
- 调用 process_action 的条件：玩家执行了需要后端校验的具体动作，包括但不限于：
  * **检定类**：侦察(perception)、调查(investigation，仅用于搜索隐藏物品/检查机关暗格/仔细翻找可疑细节，打开普通容器不需要)、洞悉/察言观色(insight)、隐匿/潜行(stealth)、游说/说服(persuasion)、欺瞒/说谎(deception)、威吓/恐吓(intimidation)、巧手(sleight_of_hand)、运动(athletics)、体操(acrobatics)
  * **动作类**：偷窃(steal)、拿取(take)、移动(move)、使用物品(use_item)、交易(trade)、战斗(combat)
- **社交检定**：玩家试图说服/欺骗/威吓/游说NPC时，必须调用 process_action(intent="perception", skill="persuasion/deception/intimidation", target_id=NPC的id, target_type="npc", needs_check=true)。
- **洞悉检定**：玩家说"洞悉/察言观色/判断NPC是否说谎/揣摩意图"时，必须调用 process_action(intent="perception", skill="insight", target_id=NPC的id, target_type="npc", needs_check=true)。
- target_id 必须使用上文【在场 NPC】【可见物品】【出口】中列出的 id= 值，不要使用中文名称。
- 不调用 process_action 的情况：与 NPC 交谈/提问/闲聊、描述周围环境、表达想法、扮演角色、查看自己有权打开的容器或物品（如受托护送的箱子、自己背包里的东西、摊开的书等）。"""

    def _tc_full_user_prompt(self, player_input: str, context: Dict[str, Any]) -> str:
        """完整上下文 prompt：切换场景时使用（历史对话通过 history_messages 累积，不贴在此处）"""
        scene = context.get("scene", {})
        location = context.get("location", {})
        npcs = context.get("npcs", [])
        items = context.get("items", [])
        character = context.get("character", {})

        def _npc_line_tc(n):
            parts = [f"- id={n.get('id')}，{n.get('name')}（{n.get('race', '')} {n.get('role', '')}）"]
            personality = n.get("personality", [])
            if personality:
                parts.append(f"  性格：{'，'.join(personality)}")
            secrets = n.get("secrets", [])
            if secrets:
                parts.append(f"  秘密（NPC 会隐瞒）：{'；'.join(secrets)}")
            goals = n.get("goals", [])
            if goals:
                parts.append(f"  目标：{'；'.join(goals)}")
            return "\n".join(parts)
        npc_text = "\n".join([_npc_line_tc(n) for n in npcs]) or "无"

        def _item_line(i):
            flags = []
            if i.get("stealable"): flags.append("可偷窃")
            if i.get("owner"): flags.append(f"属于{i.get('owner')}")
            return f"- id={i.get('id')}，{i.get('name')}{'（' + '，'.join(flags) + '）' if flags else ''}"
        item_text = "\n".join([_item_line(i) for i in items]) or "无"

        exits = location.get("exits", []) if location else []
        exit_text = "\n".join([f"- {e.get('name')}（id={e.get('target')}）" for e in exits]) or "无"

        # 被动发现（成功时才有内容，失败为空）
        passive_text = ""
        passive_list = context.get("passive_discoveries", [])
        if passive_list:
            lines = [f"- {d['description']}" for d in passive_list]
            passive_text = "\n【被动发现】\n" + "\n".join(lines) + "\n（以上为你被动察觉/调查自动发现的信息，请在描述场景时自然融入。）"

        return f"""【章节背景】
{context.get('chapter_summary', '无')}

【当前场景】{scene.get('name', '')}
【地点】{location.get('name', '')}
【描述】{location.get('scene_text', location.get('description', ''))}

【在场 NPC】
{npc_text}

【可见物品】
{item_text}

【出口】
{exit_text}

【角色】{character.get('name', '')} Lv{character.get('level', '')}
{passive_text}
【玩家输入】
{player_input}"""

    def _tc_lite_user_prompt(self, player_input: str, context: Dict[str, Any]) -> str:
        """轻量 prompt：场景锚点 + 玩家输入（历史对话通过 messages 累积传递）"""
        scene = context.get("scene", {})
        location = context.get("location", {})

        # 场景锚点：防止 AI 忘记自己在哪里、剧情进行到哪一步
        anchor = f"【当前场景】{scene.get('name', '')} — {location.get('name', '')}"
        # 取地点描述第一句作为剧情位置提示
        desc = location.get('scene_text', location.get('description', ''))
        first_sentence = desc.split('。')[0] if desc else ''
        if first_sentence and len(first_sentence) < 60:
            anchor += f"\n【当前状态】{first_sentence}。"

        return f"""{anchor}

【玩家输入】
{player_input}"""
