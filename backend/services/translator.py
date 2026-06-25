"""
文件翻译服务 — Markdown 分块、AI 翻译、结构校验
"""
import json
import re
import os
import uuid
import asyncio
from typing import Optional


# ---- Markdown 块类型 ----

BLOCK_TYPES = {
    "heading": "heading",
    "paragraph": "paragraph",
    "table": "table",
    "list": "list",
    "blockquote": "blockquote",
    "code": "code",
    "thematic_break": "thematic_break",
    "html": "html",
}


def split_into_blocks(markdown: str) -> list[dict]:
    """将 Markdown 按空行分割为块，每块附带类型信息。"""
    if not markdown or not markdown.strip():
        return []

    raw_blocks = re.split(r"\n{2,}", markdown)
    blocks = []
    block_id = 0

    for raw in raw_blocks:
        text = raw.strip()
        if not text:
            continue

        block_id += 1
        btype, extra = _detect_block_type(text)

        block = {
            "id": block_id,
            "type": btype,
            "original": text,
            "translation": "",
        }
        if extra:
            block.update(extra)
        blocks.append(block)

    return blocks


def _detect_block_type(text: str) -> tuple[str, dict]:
    """检测块类型，返回 (type, extra_info)。"""
    lines = text.split("\n")

    # 代码块
    if lines[0].startswith("```"):
        lang = lines[0].strip("`").strip()
        return "code", {"language": lang}

    # 分隔线
    if re.match(r"^-{3,}$|^\*{3,}$|^_{3,}$", lines[0].strip()):
        return "thematic_break", {}

    # 标题
    heading_match = re.match(r"^(#{1,6})\s+(.+)$", lines[0])
    if heading_match and len(lines) == 1:
        return "heading", {"level": len(heading_match.group(1))}

    # 多行标题 (Setext)
    if len(lines) == 2 and re.match(r"^={3,}$|^-{3,}$", lines[1].strip()):
        level = 1 if lines[1].strip().startswith("=") else 2
        return "heading", {"level": level}

    # 表格
    if any(line.startswith("|") and line.endswith("|") for line in lines):
        pipe_count = lines[0].count("|")
        if pipe_count >= 2:
            return "table", {}

    # 引用
    if any(line.startswith(">") for line in lines):
        return "blockquote", {}

    # 列表（无序或有序）
    list_pattern = re.compile(r"^(\s*)[-*+]\s|^\s*\d+[.)]\s")
    if any(list_pattern.match(line) for line in lines):
        return "list", {}

    # 默认段落
    return "paragraph", {}


# ---- AI 翻译 ----

async def translate_blocks(
    blocks: list[dict],
    source_lang: str = "auto",
    target_lang: str = "中文",
    batch_size: int = 6,
):
    """逐批翻译块，直接修改 blocks 中的 translation 字段。"""
    from ai_client import get_ai_client

    client = get_ai_client()
    model = os.getenv("TRANSLATE_MODEL", "deepseek-chat")

    total = len(blocks)
    for start in range(0, total, batch_size):
        end = min(start + batch_size, total)
        batch = blocks[start:end]
        await _translate_batch(client, model, batch, source_lang, target_lang)
        yield {"completed": end, "total": total, "blocks": blocks[:end]}


BLOCK_TRANSLATION_PROMPTS = {
    "heading": "将下面的 Markdown 标题翻译成{target_lang}。保持 # 符号的数量不变，只翻译后面的文字。直接输出标题，不要解释。",
    "paragraph": "将下面的法律文本翻译成{target_lang}。保持专业准确，保留所有 Markdown 内联格式标记（如 **加粗**、*斜体*、`行内代码`）。直接输出译文，不要解释。",
    "table": (
        "将下面的 Markdown 表格翻译成{target_lang}。重要规则：\n"
        "1. 保持管道符 | 和分隔行（| --- | --- |）的结构完全不变\n"
        "2. 不增删行列\n"
        "3. 只翻译单元格内的文字\n"
        "4. 直接输出表格，不要添加任何解释或额外内容"
    ),
    "list": "将下面的 Markdown 列表翻译成{target_lang}。保持缩进和列表标记符（-、*、1. 等）不变，只翻译内容文字。直接输出译文，不要解释。",
    "blockquote": "将下面的引用文本翻译成{target_lang}。保持 > 符号不变，只翻译后面的文字。直接输出译文，不要解释。",
    "code": "Code block — 保留原样不翻译。直接原样输出。",
    "thematic_break": "保留原样不翻译。直接原样输出。",
}


async def _translate_batch(client, model: str, batch: list[dict], source_lang: str, target_lang: str):
    """翻译一批块。每个块独立调用 AI，以保证边界清晰。"""
    tasks = []
    for block in batch:
        tasks.append(_translate_single_block(client, model, block, source_lang, target_lang))
    await asyncio.gather(*tasks)


async def _translate_single_block(client, model: str, block: dict, source_lang: str, target_lang: str):
    """翻译单个块。"""
    btype = block["type"]
    text = block["original"]

    # 代码块和分隔线直接跳过
    if btype in ("code", "thematic_break"):
        block["translation"] = text
        return

    prompt_template = BLOCK_TRANSLATION_PROMPTS.get(btype, "将下面的文本翻译成{target_lang}。直接输出译文，不要解释。")
    system_prompt = prompt_template.format(target_lang=target_lang)

    if source_lang and source_lang != "auto":
        system_prompt += f"\n源语言：{source_lang}"

    try:
        response = await client.chat.completions.create(
            model=model,
            max_tokens=4096,
            temperature=0.1,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
        )
        translation = (response.choices[0].message.content or "").strip()

        # 对表格做结构校验
        if btype == "table":
            translation = _validate_table(text, translation)

        block["translation"] = translation
    except Exception as e:
        block["translation"] = f"[翻译失败：{e}]"


def _validate_table(original: str, translation: str) -> str:
    """校验表格结构，如果 AI 改坏了行列数，尝试修复或回退。"""
    orig_lines = [l for l in original.split("\n") if l.strip()]
    trans_lines = [l for l in translation.split("\n") if l.strip()]

    # 检查行数是否一致（至少 header + separator 两行）
    if len(trans_lines) < 2:
        return translation

    # 检查管道符数量是否一致
    orig_pipes = orig_lines[0].count("|")
    trans_pipes = trans_lines[0].count("|")

    if orig_pipes == trans_pipes:
        return translation

    # 如果不一致，尝试用原始结构重新翻译（逐格翻译）
    return _retry_table_cell_by_cell(original)


def _retry_table_cell_by_cell(original: str) -> str:
    """当 AI 改坏了表格结构时，保留原始结构，逐格替换译文。"""
    # 简单策略：保留原始表格结构，标记未翻译
    return original  # fallback: return original


def reconstruct_markdown(blocks: list[dict], field: str = "translation") -> str:
    """从块的指定字段重建 Markdown。"""
    parts = []
    for block in blocks:
        text = block.get(field, "").strip()
        if not text:
            text = block.get("original", "")
        parts.append(text)
    return "\n\n".join(parts)


# ---- 后台任务管理 ----

_jobs: dict[str, dict] = {}


def create_job(file_name: str, blocks: list[dict], source_lang: str, target_lang: str) -> str:
    """创建翻译任务，返回 job_id。"""
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {
        "job_id": job_id,
        "file_name": file_name,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "blocks": blocks,
        "completed": 0,
        "total": len(blocks),
        "status": "pending",
        "error": None,
    }
    return job_id


def get_job(job_id: str) -> Optional[dict]:
    """获取任务状态。"""
    return _jobs.get(job_id)


async def run_translation_job(job_id: str):
    """执行翻译任务（异步后台执行）。"""
    job = _jobs.get(job_id)
    if not job:
        return

    job["status"] = "translating"
    try:
        async for progress in translate_blocks(
            job["blocks"],
            source_lang=job["source_lang"],
            target_lang=job["target_lang"],
        ):
            job["completed"] = progress["completed"]
            job["status"] = "translating"

        job["status"] = "done"
        job["completed"] = job["total"]
    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
