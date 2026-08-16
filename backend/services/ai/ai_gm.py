"""
AI GM 服务（ai 层）
负责：
1. 解析玩家输入为结构化意图（Function Calling，工具 schema 见 tool_schema）
2. 根据 core 确定性结算结果生成自然语言叙事

使用 DeepSeek-V4-Flash（兼容 OpenAI ChatCompletions API）。
"""

import os
import json
import re
import logging
from pathlib import Path
from typing import Dict, Any

from openai import OpenAI

from services.ai.tool_schema import TOOLS

logger = logging.getLogger(__name__)


def _find_xml_tool_start(text: str) -> int:
    """定位文本中工具调用 XML 的起始位置（流式分片时逐 chunk 判断）"""
    for tag in ("<tool_calls>", "<tool_calls", "<invoke"):
        i = text.find(tag)
        if i >= 0:
            return i
    return -1


class AIGM:
    """AI GM 封装"""

    TOOLS = TOOLS  # 工具 schema（定义在 tool_schema）

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
    def _parse_xml_tool_call(xml_text: str):
        """解析文本 XML 形式的工具调用：<tool_calls><invoke name="X"><parameter name="Y">V...
        容忍残缺标签（流式截断），返回 (工具名, 参数字典)；无法解析返回 None"""
        m = re.search(r'<invoke\s+name="([^"]+)"', xml_text)
        if not m:
            return None
        name = m.group(1)
        args = {}
        for pm in re.finditer(r'<parameter\s+name="([^"]+)"[^>]*>([^<]*)', xml_text):
            args[pm.group(1)] = pm.group(2).strip()
        return name, args

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
            xml_parts = []  # 模型以文本 XML 形式输出的工具调用（部分模型不支持原生 tool calling）
            in_xml = False
            tool_call_id = None
            tool_call_name = None
            tool_call_args_parts = []
            for chunk in response:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta is None:
                    continue

                # 思考过程（DeepSeek reasoner）
                rc = getattr(delta, 'reasoning_content', None)
                if rc:
                    reasoning_parts.append(rc)

                # 普通文本（流式中拦截以 XML 文本形式输出的工具调用，避免泄漏给玩家）
                if delta.content:
                    seg = delta.content
                    if not in_xml:
                        idx = _find_xml_tool_start(seg)
                        if idx >= 0:
                            in_xml = True
                            before = seg[:idx]
                            if before:
                                content_parts.append(before)
                                yield ("text", before)
                            xml_parts.append(seg[idx:])
                        else:
                            content_parts.append(seg)
                            yield ("text", seg)
                    else:
                        xml_parts.append(seg)

                # tool call（原生格式）
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
            elif xml_parts:
                # 兜底：解析文本 XML 形式的工具调用（容忍标签残缺）
                parsed = self._parse_xml_tool_call("".join(xml_parts))
                if parsed:
                    tool_call_name, tool_args = parsed

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
        tool_name: str = "process_action",
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
                "id": f"call_{tool_name}",
                "type": "function",
                "function": {
                    "name": tool_name,
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
                "tool_call_id": f"call_{tool_name}",
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
    # 播报润色（流式，确定性端点用）：复用主 GM 完整上下文，AI 用自己的话叙事
    # ------------------------------------------------------------------
    def polish_broadcast(self, event_type: str, facts: str, context: Dict[str, Any] = None):
        """把确定性结算播报交给主 GM 用自己的话流式叙事（复用完整 GM system + 已有 history）。

        event_type: 事件类型（stealth 潜行 / suspicion 被怀疑对峙）
        facts: 确定性结算的固定播报文本（叙事的事实来源，已写入 history）
        context: {"player_name", "action", "history"}——history 为已有对话历史（AI 有前因后果）
        铁律来自 gm_guide（完整 system）：只润色措辞与氛围，禁止改变/编造 facts 中的事实。
        AI 不可用或失败时 yield 空字符串，由调用方回退到 facts。"""
        if not self.client:
            yield ""
            return
        pname = (context or {}).get("player_name") or "冒险者"
        action_cn = (context or {}).get("action") or event_type
        history = (context or {}).get("history") or []
        # 复用主 GM 完整 system（gm_guide 铁律 + 规则说明），AI 以 GM 身份自然叙事
        messages = [{"role": "system", "content": self._tc_system_prompt()}]
        # 已有对话历史：AI 知道前因后果（如刚说了什么、当前处境）
        messages.extend(self._build_history_messages(history))
        user = (
            f"{pname} 触发了【{action_cn}】。\n"
            f"确定性结算结果：{facts}\n"
            f"请以 GM 身份用自己的话把它叙事出来，用角色名「{pname}」称呼玩家。"
        )
        messages.append({"role": "user", "content": user})
        try:
            response = self.client.chat.completions.create(
                model=self.model, messages=messages, temperature=0.8, max_tokens=300, stream=True,
            )
            for chunk in response:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except Exception as e:
            logger.error(f"播报润色失败: {e}")
            yield ""

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
1. 交代前因——你为什么会在这里（依据【模组概述】中的任务背景），但不要说"你是XXX"之类介绍角色身份的话
2. 描述当前地点环境（依据【地点描述】）
3. 介绍在场 NPC 和他们的状态（名单见【在场 NPC】）
4. 自然地引出当前任务（依据【模组概述】中的任务信息）
5. 开场时间点是玩家刚刚抵达该场景、尚未出发的时刻：所有【在场 NPC】此刻都仍在场。如果剧本设定 NPC 稍后要先行出发/探路，那只是口头说明的计划，不得描写他们已经离开。禁止出现"已经上马远去""马蹄声渐渐消失""只留下你一个人"之类的离开情节。"""

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

【核心铁律】（无条件生效）
1. 上下文约束：只能基于提供的上下文回复，禁止引入未提及的 NPC、地点、物品或事件。地点描述中明确提到的物品、NPC 均为真实存在。
2. 不替玩家决定：玩家角色的一切选择由玩家做出，你只描述选择后的世界反应。不得替玩家行动、替玩家说话、替玩家思考，也不得把玩家角色的心理活动描述为既定事实。
3. 引导式拒绝：玩家请求无法实现时，先说明原因，再给可行的替代方向（"你做不到……但你可以……"）。永远给玩家一条可走的路。
4. 说服≠心灵控制：游说/威吓/欺瞒成功只改变 NPC 的态度和意愿，不改变其核心信念、职业底线与自我保全本能。
5. 失败如实叙事：检定失败的后果以规则引擎返回和场景数据为准（警觉上升、态度恶化、被察觉、状态变化），如实描述。侦察/调查失败如实说"没有发现异常"。禁止凭空编造线索、NPC 行动或环境变化来"推进"剧情，也不得宣判剧情死路。
6. 只在有意义时掷骰：结果确定（无风险或不可能）的动作不掷骰，直接叙事。
7. 检定叙事铁律：检定成功但没有任何发现时，直接说"你没有发现任何异常/隐藏的东西"。绝对禁止凭空编造不存在的细节来"丰富"检定结果。
8. 不剧透秘密：NPC 的「秘密」字段是该 NPC 极力隐瞒的事，被问到时要含糊其辞或转移话题，绝不能直接承认。
9. 被动发现融入：【被动发现】是系统自动揭示的环境信息，首次描述场景时自然融入，不重复播报。
10. 格式与粒度：纯文字输出，不用 Markdown，不用 emoji。描写详略取决于信息重要性——关键剧情/线索细粒度，普通问答/日常交互一两句话直接给答案，保持简洁。
11. 数据边界：NPC 态度、物品、金币等持久状态变化一律由规则引擎执行（通过工具调用触发），你只描述神态、语气等即时反应，不得宣称数据之外的状态变化——不得让 NPC 凭空赠送物品、改变立场，不得让玩家无故得失物品金币。
12. 【剧情关键 NPC 保护】NPC 数据中标注 plot_critical 的（【在场 NPC】中可见该字段）是剧本指定的关键角色，其生死由剧本/规则引擎决定，不要擅自宣判其死亡或调用 update_npc_status 将其标记为 dead；未标注 plot_critical 的 NPC 无此限制。
13. 【工具调用格式】禁止以文本形式输出工具调用（如 <tool_calls>、<invoke> 等 XML 标签）。需要调用工具时必须使用系统提供的工具调用功能；若无法调用，则直接以 GM 口吻叙事，绝不把工具调用代码/标签显示给玩家。
14. 【人称】用角色名称呼玩家角色，GM 叙述不得用"你/我"指代玩家（NPC 台词里可以用"你"）。

工具使用（重要）：
- 调用 process_action 的条件：玩家执行了需要后端校验的具体动作，包括但不限于：
  * **检定类**：侦察(perception)、调查(investigation，仅用于搜索隐藏物品/检查机关暗格/仔细翻找可疑细节，打开普通容器不需要)、洞悉/察言观色(insight)、隐匿/潜行(stealth)、游说/说服(persuasion)、欺瞒/说谎(deception)、威吓/恐吓(intimidation)、巧手(sleight_of_hand)、运动(athletics)、体操(acrobatics)
  * **动作类**：偷窃(steal)、拿取(take)、移动(move)、使用物品(use_item)、交易(trade)、战斗(combat)
- **社交检定**：玩家试图说服/欺骗/威吓/游说NPC时，必须调用 process_action(intent="perception", skill="persuasion/deception/intimidation", target_id=NPC的id, target_type="npc", needs_check=true)。
- **洞悉检定**：玩家说"洞悉/察言观色/判断NPC是否说谎/揣摩意图"时，必须调用 process_action(intent="perception", skill="insight", target_id=NPC的id, target_type="npc", needs_check=true)。
- **潜行**（可选）：玩家说"潜行/偷偷摸摸/藏起来/躲起来"时，调用 process_action(intent="perception", skill="stealth", target_type="none", needs_check=true) 进入隐匿状态。**潜行不需要指定目标**——引擎会对在场全部目击者判定；玩家想瞒过特定某人时也可附 target_id（该 NPC 的 id）。潜行成功后偷窃会自动跳过潜行判定，直接调 steal 工具即可。
- **偷窃**：玩家说"偷X/偷Y的东西"时，调用 process_action(intent="steal", target_id=物品id或商人的id, target_type="item"或"npc", needs_check=true)。规则引擎会自动先做潜行判定（不被在场目击者察觉）再做巧手检定，无需玩家先单独潜行。目标必须使用【在场 NPC】【可见物品】中的 id= 值。商人货架上的物品（含售价与剩余数量）在【在场 NPC】的 merchant 信息中列出。
  偷窃结果分四种情况（引擎返回，你如实叙事）：
  * 情况一（巧手失败被抓）：NPC 警觉+2、转敌对、生气骂人，但不会质问对峙——玩家可自决去留。
  * 情况二（人赃并获，刚偷到被当场瞥见）：NPC 立即抓住玩家质问。玩家可：给钱了事（赔2倍）/ 欺瞒（极难）/ 威吓 / 逃跑（先挣脱：运动/体操 vs 商人力量，挣脱成功后可再敏捷逃脱）。
  * 情况三（得手无人知晓）：无事发生。
  * 情况四（延迟发现）：5 秒内离开即无事；超时仍原地 → NPC 拦住质问。玩家可：同意搜身（搜出赔2倍）/ 给钱承认（2倍）/ 社交（成功放行，失败将被强制搜身赔3倍）/ 逃跑（敏捷逃脱）/ 拒绝（叫卫兵）。
- **施法**：玩家说"施放X/用法术X"时，调用 process_action(intent="cast_spell", spell_id=法术id, target_npc_id=目标NPC的id, target_type="npc"（无目标用"none"）, needs_check=false)。法术 id 必须使用【已知法术】中的 id= 值。伤害类法术（火球术/燃烧之手/魔法飞弹等）需指定目标 NPC（target_npc_id）；叙事类法术（护盾/法师护甲/隐身/睡眠等）无需目标。规则引擎会校验法术位并确定性结算，你基于真实结果叙事；叙事类法术只能按【法术描述】内容描述效果，不得凭空添加效果。
- **职业动作**：玩家使用职业动作（"回气/回复"等）时，调用 process_action(intent="use_action", target_id=动作id, target_type="none", needs_check=false)。回气/回复会恢复生命值并消耗短休资源，你基于真实结果叙事。
- **被怀疑质问**：当 NPC 怀疑玩家偷窃并质问时（上下文会标注【正在被质问】），玩家必须暂时无法离开场景。根据玩家的回应调用 process_action(intent="resolve_suspicion", target_id=该NPC的id, target_type="npc", action=...)：
  * 玩家同意搜身/让你搜/随便搜 → action="search"
  * 玩家承认偷窃并给钱/愿意赔偿 → action="pay"
  * 玩家拒绝给钱/不给/强硬回绝 → action="refuse"（人赃并获时商人不会叫卫兵，只会更怒；延迟发现时才会叫卫兵）
  * 玩家撒谎/否认（欺瞒） → action="deception"；玩家威胁/恐吓 → action="intimidation"；玩家游说/解释/求情 → action="persuasion"（注意：人赃并获【flagrante】时游说无效，只有欺瞒/威吓可用）
  * 玩家逃跑/挣脱/溜走 → action="flee"（人赃并获时先挣脱再敏捷逃脱；延迟发现时直接敏捷逃脱）
  * 若玩家答非所问、试图解释或辩解，先由你扮演 NPC 继续质问（不调用工具），直到玩家明确选择。
  * 社交检定失败后：延迟发现场景 NPC 会强制搜身（玩家可再选"同意搜身"或"逃跑"）。
- **卫兵逮捕**：玩家拒绝赔偿、拒绝搜身或挣脱失败导致 NPC 呼叫卫兵后（上下文/结果中会出现卫兵，可看到【在场 NPC】里的城镇卫兵），进入卫兵流程。根据玩家回应调用 process_action(intent="arrest", target_id=卫兵的id="town-guard", target_type="npc", action=...)：
  * 卫兵赶来中（每轮逼近，可看到【正在被卫兵逮捕】的剩余轮数播报）：
    - 玩家愿意赔钱私了 → action="pay"（赔偿×3，结束）
    - 玩家求情/解释 → action="deception"/"intimidation"/"persuasion"（难度高，成功私了）
    - 玩家逃跑/溜走 → action="flee"（敏捷逃脱，vs 商人敏捷；成功逃脱/失败被抓）
    - 玩家挣脱/挣扎（若正被商人抓住） → action="breakout"（第 2 次挣脱机会，更难）
  * 卫兵到场（默认被抓住，要求搜身）：
    - 玩家同意搜身 → action="search"（×3 赔偿，结束）
    - 玩家求情/解释 → action="deception"/"intimidation"/"persuasion"（高难度，成功化解）
    - 玩家挣脱 → action="breakout"（对抗卫兵；成功 → 再敏捷逃脱，失败 → 被按死）
  * 被按死后 → 没收赃物 + 赔偿×3 + 关进绝冬城监狱（jailed，玩家被传送到监狱地点，【在场 NPC】会出现狱卒）。
- **监狱（jailed）互动**：玩家在牢里时，根据回应调用 process_action(intent="arrest", target_type="none", action=...)：
  * 交保释金（"保释/交钱出去/我要出狱"）→ action="pay"（保释金 100 金币，当场释放；钱不够则提示）
  * 撬锁（"撬锁/开锁/撬开牢门"）→ action="pick_lock"（巧手 vs DC14）。**狱卒在场时撬不了**——狱卒会不定时起身巡逻（玩家输入"等待"消磨时间等巡逻；狱卒离开期间才能撬锁）。撬锁成功牢门打开（cell_open），玩家可点击"监狱大门"越狱；失败且差 5 点以上会惊动狱卒（提前回来+警告），差 5 点内无声失败可再试
  * 蹲到天亮（"蹲牢/服刑/我认了/等到天亮"）→ action="serve"（game_time+8 后释放，免保释金）
  * 玩家与狱卒闲聊/提问 → 直接扮演狱卒对话，不调用工具
  * 狱卒巡逻状态在逮捕上下文中可见（jail_guard: present 在场 / away 巡逻、cell_open: 牢门是否已开），据此判断玩家能否撬锁、是否该提醒玩家点击监狱大门逃离
- **通缉（wanted_location）**：玩家被通缉时，结算结果与上下文的【通缉】中会明确列出通缉区域。AI 照实叙述该状态即可；后续玩家与卫兵、路人、商人互动时可自然体现通缉影响（如审视盘问、警惕戒备）。玩家主动询问时，可明确告知并暗示可行的出路（如离开区域避风头、赔钱和解等，具体机制后续实现）。
- target_id 必须使用上文【在场 NPC】【可见物品】【出口】中列出的 id= 值，不要使用中文名称。
- 调用 update_npc_status 的条件：当 NPC 死亡（如被击杀）、被击晕、或离开当前地点时，调用 update_npc_status(npc_id=..., status="dead"/"stunned"/"left") 同步角色栏显示。alive 用于恢复正常。纯叙事描述状态变化不需要调用，该工具只负责记录状态本身。
- 不调用 process_action 的情况：与 NPC 交谈/提问/闲聊、描述周围环境、表达想法、扮演角色、查看自己有权打开的容器或物品（如受托护送的箱子、自己背包里的东西、摊开的书等）。"""

    def _tc_detail_guide(self) -> str:
        """第二层详细准则：从 gm_guide.md 截取「## 第二层」至「## 变更日志」之间的内容，
        随完整上下文（首轮/切换场景）注入，控制 token 开销；准则更新只需改文档。"""
        try:
            path = Path(__file__).resolve().parents[2] / "prompts" / "gm_guide.md"  # services/ai → backend
            text = path.read_text(encoding="utf-8")
            start = text.find("## 第二层")
            end = text.find("## 变更日志")
            if start >= 0 and end > start:
                return text[start:end].strip()
        except Exception:
            logger.warning("读取 gm_guide.md 第二层准则失败", exc_info=True)
        return ""

    def _arrest_hint(self, context: Dict[str, Any]) -> str:
        """卫兵流程提示：注入当前 phase 与可行动作，帮助 AI 持续推进卫兵流程"""
        a = context.get("arrest")
        if not a or not a.get("active"):
            return ""
        phase_cn = {
            "summoned": "卫兵正在赶来（每轮逼近；可赔钱私了×3 / 社交求情 / 逃跑敏捷逃脱 / 若被抓住可挣脱）",
            "arrived": "卫兵已到场按住你，要求搜身（可同意搜身×3 / 社交化解一次 / 挣脱对抗卫兵，失败将被按死）",
            "arrested": "你已被卫兵制伏（将被没收赃物、赔偿×3并关进监狱）",
            "jailed": "你被关押在牢房里（玩家下一轮输入任意动作即自动释放，过一夜）",
            "escaped": "你已逃脱卫兵",
        }
        plaintiff = next(
            (n.get("name", "") for n in context.get("npcs", []) if n.get("id") == a.get("plaintiff")),
            "",
        )
        stolen = a.get("stolen_value", 0)
        lines = [f"【正在被卫兵逮捕】{phase_cn.get(phase, a.get('phase', ''))}"]
        if plaintiff:
            lines.append(f"原告：{plaintiff}；赃物价值 {stolen} 金币（搜出/赔偿按 3 倍计）")
        return "\n".join(lines)

    def _suspicion_hint(self, context: Dict[str, Any]) -> str:
        """被怀疑（强制对话）提示：注入正在被质问的 NPC 信息与可用回应"""
        suspicion = context.get("suspicion") or {}
        active = [(nid, s) for nid, s in suspicion.items() if s.get("active")]
        if not active:
            return ""
        lines = []
        for nid, s in active:
            name = next((n.get("name", "") for n in context.get("npcs", []) if n.get("id") == nid), "")
            mode = s.get("mode")
            if mode == "flagrante":
                state_txt = "（人赃并获，当场抓住你手腕）"
                opts = "给钱了事（赔2倍）/ 欺瞒（极难）/ 威吓 / 逃跑（先挣脱，挣脱后可敏捷逃脱）；游说当场无效"
            else:
                state_txt = "（怀疑你偷了东西）"
                opts = "同意搜身（搜出赔2倍）/ 给钱了事（2倍）/ 欺瞒/威吓/游说（成功放行，失败将被强制搜身赔3倍）/ 逃跑 / 拒绝（叫卫兵）"
            lines.append(f"{name or nid}正怀疑你偷走了东西，拦住你质问{state_txt}。回应方式：{opts}。在问题解决前，你不能离开当前地点。")
        return "\n".join(lines)

    def _known_spell_text(self, character: dict) -> str:
        """角色已知法术（中文名 + id= 值），供 AI 施法识别 spell_id；full/lite 上下文均注入"""
        try:
            from services.core.spell_engine import spell_lookup
            lookup = spell_lookup()
            spells_cfg = character.get("spells") or {}
            ids = list((spells_cfg.get("spell_ids") or {}).get("level_1") or []) + list(character.get("cantrip_ids") or [])
            if ids:
                names = "、".join(f"{lookup.get(i, {}).get('name', i)}(id={i})" for i in ids)
                return f"\n【已知法术】{names}"
        except Exception:
            pass
        return ""

    def _wanted_hint(self, context: Dict[str, Any]) -> str:
        """通缉提示：注入当前被通缉的区域，AI 据此自然揭示处境（不直接宣布，靠世界反应体现）"""
        names = context.get("wanted_names") or []
        if not names:
            return ""
        return f"\n【通缉】玩家在以下区域被通缉：{'、'.join(names)}。在这些区域活动时，卫兵可能盘问、商人可能拒卖，请通过世界反应自然体现。"

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
            merchant = n.get("merchant") or {}
            inv = merchant.get("inventory") or []
            if inv:
                goods = "、".join(
                    f"{e.get('item_id')}(售价{e.get('price')}G)" for e in inv
                )
                parts.append(f"  货架（可交易或偷窃）：{goods}")
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

        suspicion_text = self._suspicion_hint(context)
        arrest_text = self._arrest_hint(context)
        wanted_text = self._wanted_hint(context)

        # 角色已知法术（供施法识别 spell_id）
        spell_text = self._known_spell_text(character)

        # 第二层详细准则（GM 规则书，首轮/切场景随完整上下文加载）
        guide_text = self._tc_detail_guide()

        return f"""{guide_text}

【章节背景】
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

【角色】{character.get('name', '')} Lv{character.get('level', '')}{spell_text}
{passive_text}
{suspicion_text}
{arrest_text}
{wanted_text}
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

        # 在场商人货架信息（供交易/偷窃识别目标，AI 常因缺少货架清单而无法行动）
        merchant_text = ""
        for n in context.get("npcs", []):
            inv = (n.get("merchant") or {}).get("inventory") or []
            if inv:
                goods = "、".join(f"{e.get('item_id')}(售价{e.get('price')}G)" for e in inv)
                merchant_text += f"\n- {n.get('name')}（id={n.get('id')}）货架：{goods}"
        if merchant_text:
            merchant_text = "【在场商人的货架】" + merchant_text

        suspicion_text = self._suspicion_hint(context)
        arrest_text = self._arrest_hint(context)
        wanted_text = self._wanted_hint(context)
        # 已知法术（防止多轮后 AI 忘记角色会什么法术，误判"没有这个法术"）
        spell_text = self._known_spell_text(context.get("character") or {})

        return f"""{anchor}
{spell_text}
{merchant_text}
{suspicion_text}
{arrest_text}
{wanted_text}
【玩家输入】
{player_input}"""
