"""临时测试文件"""
import sys
sys.dont_write_bytecode = True

import importlib
import document_templates
importlib.reload(document_templates)

content = "这是第一行文字\n这是第二行文字\n这是第三行文字\n\n这个是新段落的内容\n继续这个段落的第二行"
doc = document_templates._md_to_docx(content, '测试')
paras = [p for p in doc.paragraphs if p.text.strip()]
print(f'段落数: {len(paras)}')
for idx, p in enumerate(paras):
    print(f'  P{idx}: {repr(p.text[:90])}')
