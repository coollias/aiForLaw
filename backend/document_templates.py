"""
AI 法律助手 — 文档模板与导出
法律文书模板、python-docx 导出 Word
"""
import hashlib
import os
import re
import tempfile
from pathlib import Path
from typing import Optional

from docx import Document
from docx.shared import Inches, Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# 导出目录
EXPORT_DIR = Path(__file__).parent / "exports"

# ── 正则片段 ──────────────────────────────────────────────
_BOLD_ITALIC_RE = re.compile(r"\*\*\*(.+?)\*\*\*")   # ***bold+italic***
_BOLD_RE         = re.compile(r"\*\*(.+?)\*\*")        # **bold**
_ITALIC_RE       = re.compile(r"\*(.+?)\*")            # *italic*
_INLINE_CODE_RE  = re.compile(r"`([^`]+)`")            # `code`
_LINK_RE         = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")  # [text](url)


def _set_run_font(run, name: str = "宋体", size: Optional[Pt] = None,
                  bold: bool = False, italic: bool = False,
                  color: Optional[RGBColor] = None):
    """统一设置 run 字体（含中文字体回退）。"""
    run.font.name = name
    run.element.rPr.rFonts.set(qn("w:eastAsia"), name)
    if size:
        run.font.size = size
    run.font.bold = bold
    run.font.italic = italic
    if color:
        run.font.color.rgb = color


def _append_inline_runs(paragraph, text: str, base_size: Pt = Pt(12)):
    """把一行 Markdown 内联语法拆成多个 run 写入 paragraph。"""
    # 先把 inline code 保护起来，避免被后面的正则误伤
    code_placeholders = {}

    def _hide_code(m):
        placeholder = f"￰CODE{len(code_placeholders)}￰"
        code_placeholders[placeholder] = m.group(1)
        return placeholder
    text = _INLINE_CODE_RE.sub(_hide_code, text)

    # 同理保护链接
    link_placeholders = {}

    def _hide_link(m):
        placeholder = f"￱LINK{len(link_placeholders)}￱"
        link_placeholders[placeholder] = (m.group(1), m.group(2))
        return placeholder
    text = _LINK_RE.sub(_hide_link, text)

    # 累计剩余未匹配位置
    remaining = text
    last_end = 0
    patterns = [
        (_BOLD_ITALIC_RE, True, True),
        (_BOLD_RE, True, False),
        (_ITALIC_RE, False, True),
    ]

    def _emit_plain(s):
        if not s:
            return
        run = paragraph.add_run(s)
        _set_run_font(run, size=base_size)

    def _emit_styled(s, b, i):
        if not s:
            return
        run = paragraph.add_run(s)
        _set_run_font(run, size=base_size, bold=b, italic=i)

    # 简单贪婪匹配：先找最先出现的 pattern
    while remaining:
        earliest_match = None
        earliest_pat = None
        for pat, b, i in patterns:
            m = pat.search(remaining)
            if m:
                if earliest_match is None or m.start() < earliest_match.start():
                    earliest_match = m
                    earliest_pat = (pat, b, i)
        if earliest_match is None:
            _emit_plain(remaining)
            break
        m, (pat, b_tag, i_tag) = earliest_match, earliest_pat
        # 前面的纯文本
        _emit_plain(remaining[:m.start()])
        _emit_styled(m.group(1), b_tag, i_tag)
        remaining = remaining[m.end():]

    # 还原 code 占位符（遍历所有 run，找到含占位符的替换）
    for para_run in paragraph.runs:
        txt = para_run.text
        for ph, code_text in code_placeholders.items():
            if ph in txt:
                # 拆分：前文本 + 内联代码 run + 后文本
                before, _, after = txt.partition(ph)
                para_run.text = before
                if code_text:
                    code_run = paragraph.add_run(code_text)
                    _set_run_font(code_run, name="Consolas", size=Pt(base_size.pt * 0.9),
                                  color=RGBColor(0xE8, 0x49, 0x6A))
                if after:
                    after_run = paragraph.add_run(after)
                    _set_run_font(after_run, size=base_size)
                break
        for ph, (link_text, link_url) in link_placeholders.items():
            if ph in para_run.text:
                before, _, after = para_run.text.partition(ph)
                para_run.text = before
                if link_text:
                    link_run = paragraph.add_run(link_text)
                    _set_run_font(link_run, size=base_size, bold=True,
                                  color=RGBColor(0x25, 0x60, 0xC4))
                if after:
                    after_run = paragraph.add_run(after)
                    _set_run_font(after_run, size=base_size)
                break


def _set_cell_border(cell, **kwargs):
    """给单元格设置边框。"""
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcBorders = OxmlElement("w:tcBorders")
    for edge in ("start", "top", "end", "bottom", "insideH", "insideV"):
        if edge in kwargs:
            element = OxmlElement(f"w:{edge}")
            for attr, val in kwargs[edge].items():
                element.set(qn(f"w:{attr}"), str(val))
            tcBorders.append(element)
    tcPr.append(tcBorders)


def _add_table_borders(table):
    """给整个表格加上统一的细边框。"""
    tbl = table._tbl
    tblPr = tbl.tblPr if tbl.tblPr is not None else OxmlElement("w:tblPr")
    borders = OxmlElement("w:tblBorders")
    border_style = {"val": "single", "sz": "4", "space": "0", "color": "999999"}
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        for k, v in border_style.items():
            el.set(qn(f"w:{k}"), v)
        borders.append(el)
    tblPr.append(borders)


def _add_shading(cell, color_hex: str):
    """给单元格添加背景色。"""
    tcPr = cell._tc.get_or_add_tcPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), color_hex)
    shading.set(qn("w:val"), "clear")
    tcPr.append(shading)


def _md_to_docx(content: str, title: str) -> Document:
    """
    将 Markdown 内容转换为 Word 文档。
    支持：标题、加粗/斜体、内联代码、代码块、表格、引用、列表、分隔线。
    """
    doc = Document()

    # ── 默认字体 ──
    style = doc.styles["Normal"]
    font = style.font
    font.name = "宋体"
    font.size = Pt(12)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")

    # ── 文档标题 ──
    title_para = doc.add_paragraph()
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title_para.add_run(title)
    _set_run_font(title_run, name="黑体", size=Pt(22), bold=True)
    doc.add_paragraph()

    lines = content.split("\n")
    i = 0
    in_code_block = False
    code_buf = []

    def _flush_pending():
        nonlocal in_code_block, code_buf
        if in_code_block:
            code_text = "\n".join(code_buf)
            p = doc.add_paragraph()
            run = p.add_run(code_text)
            _set_run_font(run, name="Consolas", size=Pt(10),
                          color=RGBColor(0x33, 0x33, 0x33))
            # 灰色背景效果：段落底纹
            pPr = p._p.get_or_add_pPr()
            shd = OxmlElement("w:shd")
            shd.set(qn("w:fill"), "F5F5F5")
            shd.set(qn("w:val"), "clear")
            pPr.append(shd)
            code_buf = []
            in_code_block = False

    def _is_table_row(l: str) -> bool:
        return l.startswith("|") and l.rstrip().endswith("|")

    def _is_separator_row(l: str) -> bool:
        return bool(re.match(r"^\|[\s\-:|]+\|$", l))

    def _parse_table_row(l: str) -> list[str]:
        return [c.strip() for c in l.strip("|").split("|")]

    while i < len(lines):
        line = lines[i].rstrip()  # 保留前导空格用于列表判断
        stripped = line.strip()

        # ── 代码块 ──
        if stripped.startswith("```"):
            if in_code_block:
                # 结束代码块
                code_text = "\n".join(code_buf)
                p = doc.add_paragraph()
                run = p.add_run(code_text)
                _set_run_font(run, name="Consolas", size=Pt(10),
                              color=RGBColor(0x33, 0x33, 0x33))
                pPr = p._p.get_or_add_pPr()
                shd = OxmlElement("w:shd")
                shd.set(qn("w:fill"), "F5F5F5")
                shd.set(qn("w:val"), "clear")
                pPr.append(shd)
                code_buf = []
                in_code_block = False
            else:
                _flush_pending()
                in_code_block = True
            i += 1
            continue

        if in_code_block:
            code_buf.append(lines[i])
            i += 1
            continue

        # ── 空行 ──
        if not stripped:
            if code_buf:
                _flush_pending()
            doc.add_paragraph()
            i += 1
            continue

        # ── 表格（多行解析） ──
        if _is_table_row(stripped):
            _flush_pending()
            # 收集连续表格行
            table_lines = []
            while i < len(lines) and _is_table_row(lines[i].rstrip()):
                stripped_row = lines[i].rstrip().strip()
                table_lines.append(stripped_row)
                i += 1

            if not table_lines:
                continue

            # 解析：第一行是表头，第二行是分隔符（可能没有），其余是数据
            header_row = table_lines[0]
            data_start = 1
            if len(table_lines) > 1 and _is_separator_row(table_lines[1]):
                data_start = 2

            headers = _parse_table_row(header_row)
            if not headers:
                continue
            # 空表头占位列数
            if all(h == "" for h in headers):
                headers = [f"列{i+1}" for i in range(len(headers))]

            data_rows = [_parse_table_row(r) for r in table_lines[data_start:]]

            num_cols = len(headers)
            for row in data_rows:
                if len(row) < num_cols:
                    row.extend([""] * (num_cols - len(row)))
                elif len(row) > num_cols:
                    row = row[:num_cols]

            num_rows = 1 + len(data_rows)
            table = doc.add_table(rows=num_rows, cols=num_cols)
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            _add_table_borders(table)

            # 表头
            for ci, h in enumerate(headers):
                cell = table.cell(0, ci)
                cell.text = ""
                p = cell.paragraphs[0]
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                run = p.add_run(h)
                _set_run_font(run, name="黑体", size=Pt(11), bold=True,
                              color=RGBColor(0xFF, 0xFF, 0xFF))
                _add_shading(cell, "E8496A")

            # 数据行
            for ri, row in enumerate(data_rows):
                for ci, val in enumerate(row):
                    cell = table.cell(ri + 1, ci)
                    cell.text = ""
                    p = cell.paragraphs[0]
                    run = p.add_run(val)
                    _set_run_font(run, size=Pt(11))
                    if ri % 2 == 1:
                        _add_shading(cell, "FFF5F7")

            doc.add_paragraph()  # 表格后空行
            continue

        # ── H1 ──
        if stripped.startswith("# ") and not stripped.startswith("## "):
            _flush_pending()
            p = doc.add_paragraph()
            content_text = stripped[2:]
            _append_inline_runs(p, content_text, Pt(18))
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            i += 1
            continue

        # ── H2 ──
        if stripped.startswith("## "):
            _flush_pending()
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(16)
            p.paragraph_format.space_after = Pt(6)
            content_text = stripped[3:]
            _append_inline_runs(p, content_text, Pt(16))
            # 给整个 H2 加粗
            for r in p.runs:
                r.font.bold = True
                r.font.name = "黑体"
                r.element.rPr.rFonts.set(qn("w:eastAsia"), "黑体")
            i += 1
            continue

        # ── H3 ──
        if stripped.startswith("### "):
            _flush_pending()
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(12)
            p.paragraph_format.space_after = Pt(4)
            content_text = stripped[4:]
            _append_inline_runs(p, content_text, Pt(14))
            for r in p.runs:
                r.font.bold = True
                r.font.name = "黑体"
                r.element.rPr.rFonts.set(qn("w:eastAsia"), "黑体")
            i += 1
            continue

        # ── H4 ──
        if stripped.startswith("#### "):
            _flush_pending()
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(10)
            p.paragraph_format.space_after = Pt(2)
            content_text = stripped[5:]
            _append_inline_runs(p, content_text, Pt(13))
            for r in p.runs:
                r.font.bold = True
                r.font.name = "黑体"
                r.element.rPr.rFonts.set(qn("w:eastAsia"), "黑体")
            i += 1
            continue

        # ── 引用块 ──
        if stripped.startswith("> "):
            _flush_pending()
            quote_lines = []
            while i < len(lines) and lines[i].rstrip().strip().startswith("> "):
                quote_lines.append(lines[i].rstrip().strip()[2:])
                i += 1
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(1.5)
            # 加左边框效果用缩进模拟
            full_quote = " ".join(quote_lines)
            run = p.add_run(full_quote)
            _set_run_font(run, name="楷体", size=Pt(11), italic=True,
                          color=RGBColor(0x7A, 0x6E, 0x6E))
            doc.add_paragraph()
            continue

        # ── 分隔线 ──
        if re.match(r"^[-*_]{3,}$", stripped):
            _flush_pending()
            p = doc.add_paragraph()
            pPr = p._p.get_or_add_pPr()
            pBdr = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:space"), "1")
            bottom.set(qn("w:color"), "CCCCCC")
            pBdr.append(bottom)
            pPr.append(pBdr)
            i += 1
            continue

        # ── 有序列表 ──
        if re.match(r"^\d+\.\s", stripped):
            _flush_pending()
            list_items = []
            numbered = True
            while i < len(lines):
                sl = lines[i].rstrip().strip()
                if re.match(r"^\d+\.\s", sl):
                    list_items.append(("num", re.sub(r"^\d+\.\s+", "", sl)))
                    i += 1
                elif sl.startswith("- ") or sl.startswith("* "):
                    numbered = False
                    list_items.append(("bullet", sl[2:]))
                    i += 1
                else:
                    break

            for idx, (kind, item_text) in enumerate(list_items):
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Cm(1.5)
                if numbered and kind == "num":
                    p.style = doc.styles["List Number"]
                    _append_inline_runs(p, item_text, Pt(11))
                else:
                    prefix = f"{idx + 1}. " if kind == "num" else "• "
                    prefix_run = p.add_run(prefix)
                    _set_run_font(prefix_run, size=Pt(11))
                    _append_inline_runs(p, item_text, Pt(11))
            doc.add_paragraph()
            continue

        # ── 无序列表 ──
        if stripped.startswith("- ") or stripped.startswith("* "):
            _flush_pending()
            list_items = []
            while i < len(lines):
                sl = lines[i].rstrip().strip()
                if re.match(r"^\d+\.\s", sl):
                    break
                if sl.startswith("- ") or sl.startswith("* "):
                    list_items.append(sl[2:])
                    i += 1
                elif sl.startswith("  "):
                    # 续行
                    if list_items:
                        list_items[-1] += " " + sl.strip()
                    i += 1
                else:
                    break

            for item_text in list_items:
                p = doc.add_paragraph()
                p.style = doc.styles["List Bullet"]
                _append_inline_runs(p, item_text, Pt(11))
            doc.add_paragraph()
            continue

        # ── 普通段落（内联 Markdown） ──
        _flush_pending()
        p = doc.add_paragraph()
        _append_inline_runs(p, stripped, Pt(12))
        i += 1

    # 可能的尾随代码块
    _flush_pending()

    return doc


def export_to_word(content: str, title: str = "法律文书") -> str:
    """
    将内容导出为 Word 文档

    Args:
        content: Markdown 格式的文档内容
        title: 文档标题

    Returns:
        str: 生成的 .docx 文件路径
    """
    EXPORT_DIR.mkdir(exist_ok=True)

    safe_title = re.sub(r"[^\w一-鿿]", "_", title)
    filename = f"{safe_title}_{hashlib.md5(content.encode()).hexdigest()[:8]}.docx"
    filepath = EXPORT_DIR / filename

    doc = _md_to_docx(content, title)
    doc.save(str(filepath))

    return str(filepath)


def cleanup_exports(max_age_hours: int = 24):
    """清理旧的导出文件"""
    import time
    now = time.time()
    if not EXPORT_DIR.exists():
        return
    for f in EXPORT_DIR.glob("*.docx"):
        if now - f.stat().st_mtime > max_age_hours * 3600:
            f.unlink()
