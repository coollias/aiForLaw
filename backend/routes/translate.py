"""
文件翻译 API 路由 — 上传、翻译、导出
"""
import base64
import os
import asyncio
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from db import get_user_by_auth_token

router = APIRouter(prefix="/api/translate", tags=["translate"])

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".txt", ".md"}


async def require_user(request: Request) -> dict:
    user = await get_user_by_auth_token(request.cookies.get("user_token"))
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    return user


@router.post("/upload")
async def translate_upload(request: Request):
    """上传文件，用 MinerU 解析后分块，返回原文块列表。"""
    await require_user(request)

    body = await request.json()
    file_data = body.get("file_data", "")
    file_name = body.get("file_name", "document.pdf")
    source_lang = body.get("source_lang", "auto")
    target_lang = body.get("target_lang", "中文")

    if not file_data:
        raise HTTPException(status_code=400, detail="请提供文件内容")

    # 校验文件大小
    raw_size = len(file_data) * 3 // 4
    if raw_size > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail=f"文件过大，最大支持 {MAX_UPLOAD_BYTES // 1024 // 1024} MB")

    # 解析文件为 Markdown
    markdown = await _parse_file_to_markdown(file_data, file_name)

    # 分块
    from services.translator import split_into_blocks
    blocks = split_into_blocks(markdown)

    return {
        "file_name": file_name,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "blocks": blocks,
        "total_blocks": len(blocks),
    }


@router.post("/start")
async def translate_start(request: Request):
    """开始翻译：接收原文块列表，返回翻译结果（同步模式，适合较短文档）。"""
    await require_user(request)

    body = await request.json()
    blocks = body.get("blocks", [])
    source_lang = body.get("source_lang", "auto")
    target_lang = body.get("target_lang", "中文")

    if not blocks:
        raise HTTPException(status_code=400, detail="请提供待翻译的文本块")

    from services.translator import translate_blocks

    result_blocks = None
    async for progress in translate_blocks(blocks, source_lang=source_lang, target_lang=target_lang):
        result_blocks = progress["blocks"]

    return {
        "blocks": result_blocks or blocks,
        "total": len(blocks),
    }


@router.post("/start-async")
async def translate_start_async(request: Request):
    """异步开始翻译，返回 job_id 用于轮询进度（适合长文档）。"""
    await require_user(request)

    body = await request.json()
    blocks = body.get("blocks", [])
    source_lang = body.get("source_lang", "auto")
    target_lang = body.get("target_lang", "中文")
    file_name = body.get("file_name", "document")

    if not blocks:
        raise HTTPException(status_code=400, detail="请提供待翻译的文本块")

    from services.translator import create_job, run_translation_job

    job_id = create_job(file_name, blocks, source_lang, target_lang)

    # 后台启动翻译
    asyncio.create_task(run_translation_job(job_id))

    return {
        "job_id": job_id,
        "total": len(blocks),
        "message": "翻译任务已启动",
    }


@router.get("/status/{job_id}")
async def translate_status(job_id: str, request: Request):
    """查询异步翻译任务状态。"""
    await require_user(request)

    from services.translator import get_job

    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="任务不存在")

    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "completed": job["completed"],
        "total": job["total"],
        "blocks": job["blocks"][:job["completed"]],
        "error": job["error"],
    }


@router.post("/export")
async def translate_export(request: Request):
    """导出译文为 DOCX 或 TXT。"""
    await require_user(request)

    body = await request.json()
    blocks = body.get("blocks", [])
    format_type = body.get("format", "docx")
    title = body.get("title", "译文")

    if not blocks:
        raise HTTPException(status_code=400, detail="请提供译文数据")

    from services.translator import reconstruct_markdown
    markdown = reconstruct_markdown(blocks)

    if format_type == "txt":
        # 纯文本：去掉 Markdown 标记
        import re
        plain = re.sub(r"[#*`>|-]", "", markdown)
        plain = re.sub(r"\n{3,}", "\n\n", plain).strip()
        data = plain.encode("utf-8")
        return Response(
            content=data,
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{title}.txt"'},
        )

    # 默认导出 DOCX — 使用 _md_to_docx 直接输出 bytes
    from document_templates import _md_to_docx
    doc = _md_to_docx(markdown, title)
    buf = BytesIO()
    doc.save(buf)
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{title}.docx"'},
    )


@router.post("/save")
async def translate_save(request: Request):
    """保存/更新翻译记录。"""
    user = await require_user(request)

    body = await request.json()
    record_id = body.get("id", "")
    filename = body.get("filename", "document")
    source_lang = body.get("source_lang", "auto")
    target_lang = body.get("target_lang", "中文")
    blocks = body.get("blocks", [])

    if not record_id:
        raise HTTPException(status_code=400, detail="缺少 id")
    if not blocks:
        raise HTTPException(status_code=400, detail="缺少翻译内容")

    from db import save_translation_record
    result = await save_translation_record(
        user_id=user["id"],
        record_id=record_id,
        filename=filename,
        source_lang=source_lang,
        target_lang=target_lang,
        blocks=blocks,
    )
    return {"ok": True, "record": result}


@router.get("/history")
async def translate_history(request: Request):
    """列出用户的翻译历史。"""
    user = await require_user(request)
    from db import list_translation_records
    records = await list_translation_records(user["id"])
    return {"records": records}


@router.get("/history/{record_id}")
async def translate_get_history(record_id: str, request: Request):
    """获取单条翻译历史完整内容。"""
    user = await require_user(request)
    from db import get_translation_record
    record = await get_translation_record(record_id, user["id"])
    if not record:
        raise HTTPException(status_code=404, detail="记录不存在")
    return record


@router.delete("/history/{record_id}")
async def translate_delete_history(record_id: str, request: Request):
    """删除翻译历史。"""
    user = await require_user(request)
    from db import delete_translation_record
    ok = await delete_translation_record(record_id, user["id"])
    if not ok:
        raise HTTPException(status_code=404, detail="记录不存在")
    return {"ok": True}


# ---- 内部辅助 ----

async def _parse_file_to_markdown(file_data: str, file_name: str) -> str:
    """解析文件为 Markdown，优先使用 MinerU。"""
    lower_name = file_name.lower()
    ext = Path(lower_name).suffix

    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的文件格式：{ext}，支持：{', '.join(ALLOWED_EXTENSIONS)}")

    # 纯文本直接返回
    if ext in (".txt", ".md"):
        try:
            return base64.b64decode(file_data).decode("utf-8", errors="replace")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"文本读取失败：{e}")

    # PDF / DOCX → 使用 MinerU
    mineru_error = ""
    if os.getenv("MINERU_API_TOKEN", "").strip():
        try:
            from main import extract_document_with_mineru_package
            result = extract_document_with_mineru_package(file_data, file_name)
            if result.get("markdown", "").strip():
                return result["markdown"]
        except Exception as e:
            mineru_error = str(e)

    # MinerU 失败，降级
    if ext == ".pdf":
        from main import extract_pdf_text
        text = extract_pdf_text(file_data)
        if text.strip():
            return text
    elif ext == ".docx":
        from main import extract_docx_text
        text = extract_docx_text(file_data)
        if text.strip():
            return text

    if mineru_error:
        raise HTTPException(status_code=500, detail=f"文件解析失败（MinerU：{mineru_error}，本地提取也无结果）")
    raise HTTPException(status_code=500, detail="文件解析失败，未提取到可读文本")
