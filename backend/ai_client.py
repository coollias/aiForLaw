"""
AI 法律助手 — DeepSeek API 客户端
通过 OpenAI 兼容接口调用 DeepSeek V4，支持流式对话、工具调用、文档生成
"""
import json
import os
from typing import AsyncIterator

from openai import AsyncOpenAI

# DeepSeek 配置
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")  # 默认/轻量模型
DEEPSEEK_FLASH_MODEL = os.getenv("DEEPSEEK_FLASH_MODEL", DEEPSEEK_MODEL)
RESEARCH_PRO_MODEL = os.getenv(
    "RESEARCH_PRO_MODEL",
    os.getenv("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"),
)
CONTRACT_REFERENCE_QUERY_MODEL = os.getenv("CONTRACT_REFERENCE_QUERY_MODEL", DEEPSEEK_FLASH_MODEL)
CONTRACT_REVIEW_MODEL = os.getenv("CONTRACT_REVIEW_MODEL", RESEARCH_PRO_MODEL)

# 全局客户端实例
_client: AsyncOpenAI | None = None


def get_ai_client() -> AsyncOpenAI:
    """获取或创建 DeepSeek 客户端"""
    global _client
    if _client is None:
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
        if not api_key:
            raise ValueError("DEEPSEEK_API_KEY 未配置，请在 .env 文件中设置")
        base_url = os.getenv("DEEPSEEK_BASE_URL", DEEPSEEK_BASE_URL)
        _client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    return _client


def init_ai_client(api_key: str, model: str | None = None, base_url: str | None = None):
    """初始化 AI 客户端"""
    global _client
    _client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url or DEEPSEEK_BASE_URL,
    )


# ===== 工具定义（OpenAI 格式 — 法律检索等） =====
LEGAL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_law",
            "description": "搜索中国法律法规条文。输入关键词或法规名称，返回相关法条内容。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词或法规名称，如'民法典 合同编 违约责任'",
                    },
                    "law_type": {
                        "type": "string",
                        "enum": ["法律", "行政法规", "司法解释", "部门规章", "任意"],
                        "description": "法规类型筛选，默认'任意'",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_case",
            "description": "搜索中国法院裁判案例。输入案由或关键词，返回相关案例摘要。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "案由或关键词，如'买卖合同纠纷 质量异议'",
                    },
                    "court_level": {
                        "type": "string",
                        "enum": ["基层", "中级", "高级", "最高", "任意"],
                        "description": "法院层级筛选",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_law_detail",
            "description": "获取特定法律法规的详细内容。需要提供法规名称和具体条款。",
            "parameters": {
                "type": "object",
                "properties": {
                    "law_name": {
                        "type": "string",
                        "description": "法规完整名称，如'中华人民共和国民法典'",
                    },
                    "article": {
                        "type": "string",
                        "description": "具体条款，如'第584条' 或 '合同编第12章'",
                    },
                },
                "required": ["law_name", "article"],
            },
        },
    },
]

# 文档类型定义
DOCUMENT_TYPES = {
    "complaint": {
        "name": "起诉状",
        "fields": ["原告信息", "被告信息", "诉讼请求", "事实与理由", "证据清单"],
    },
    "defense": {
        "name": "答辩状",
        "fields": ["答辩人信息", "被答辩人信息", "案由", "答辩意见", "事实与理由"],
    },
    "legal_opinion": {
        "name": "法律意见书",
        "fields": ["委托人", "委托事项", "背景情况", "法律分析", "结论意见"],
    },
    "contract": {
        "name": "合同/协议",
        "fields": ["合同类型", "甲方信息", "乙方信息", "主要条款", "特别约定"],
    },
    "lawyer_letter": {
        "name": "律师函",
        "fields": ["委托人", "收函方", "委托事项", "事实陈述", "法律依据", "具体要求"],
    },
}


def _build_messages(
    message: str,
    history: list[dict] | None = None,
    system_prompt: str | None = None,
) -> list[dict]:
    """构建 OpenAI 格式的消息列表"""
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history:
        for msg in history[-20:]:  # 最近 20 条，避免超长
            messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": message})
    return messages


async def chat_stream(
    message: str,
    history: list[dict] | None = None,
    system_prompt: str | None = None,
    tools_enabled: bool = True,
) -> AsyncIterator[str]:
    """
    流式对话，逐 token 返回

    Args:
        message: 当前用户消息
        history: 对话历史 [{"role": "user/assistant", "content": "..."}]
        system_prompt: 系统提示词
        tools_enabled: 是否启用工具调用（DeepSeek V4 支持 function calling）
    """
    client = get_ai_client()
    messages = _build_messages(message, history, system_prompt)

    kwargs = {
        "model": DEEPSEEK_MODEL,
        "max_tokens": 4096,
        "messages": messages,
        "stream": True,
        "temperature": 0.7,
    }
    if tools_enabled:
        kwargs["tools"] = LEGAL_TOOLS

    stream = await client.chat.completions.create(**kwargs)
    async for chunk in stream:
        delta = chunk.choices[0].delta if chunk.choices else None
        if delta and delta.content:
            yield delta.content


async def generate_document(doc_type: str, info: dict, include_usage: bool = False):
    """
    生成法律文书（非流式）

    Args:
        doc_type: 文书类型 key（complaint/defense/legal_opinion/contract/lawyer_letter）
        info: 用户填写的关键信息 dict
    """
    doc_meta = DOCUMENT_TYPES.get(doc_type, {})
    doc_name = doc_meta.get("name", doc_type)
    fields = doc_meta.get("fields", [])

    # 构建生成提示
    info_text = "\n".join([f"- {k}: {info.get(k, '【待补充】')}" for k in fields])

    prompt = f"""请根据以下信息，生成一份专业的{doc_name}。

用户提供的信息：
{info_text}

请按标准法律文书格式生成，缺失信息处用【待补充】标注。
输出要求：
1. 格式规范，符合中国法律文书标准
2. 内容完整，逻辑清晰
3. 引用相关法律法规
4. 使用 Markdown 格式输出"""

    client = get_ai_client()
    response = await client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        max_tokens=8192,
        temperature=0.7,
        messages=[
            {
                "role": "system",
                "content": "你是一位资深法律文书撰写专家。请生成专业规范的法律文书，使用Markdown格式。",
            },
            {"role": "user", "content": prompt},
        ],
    )

    content = response.choices[0].message.content or ""
    if include_usage:
        return content, response.usage
    return content


def get_document_types() -> dict:
    """获取支持的文书类型列表"""
    return DOCUMENT_TYPES
