---
name: document-output
description: 科研文档输出（macOS）：用 pandoc 把 Markdown 转 Word/PDF、用 python-docx 生成与编辑 docx、中文字体配置、投稿用 Word 文档的格式规范。
whenToUse: 把 Markdown/LaTeX 转成 Word 或 PDF、生成/编辑 .docx、准备投稿文档时
---

# 文档输出（Word / PDF，macOS）

## 环境——pandoc 与 LaTeX 都已装好

- **pandoc 3.11**：`$DSH_HOME/bio-research/r-env/bin/pandoc`
- **TinyTeX**（`xelatex` / `latexmk` / `tlmgr`）：`~/Library/TinyTeX/bin/universal-darwin/`
- 两者都**不在 PATH 上**。最省事是先 source：

  ```sh
  . "${DSH_HOME:-$HOME/.dsh}/bio-research/env.sh"
  pandoc paper.md -o paper.docx
  ```

  不 source 就用绝对路径 `"$DSH_HOME/bio-research/r-env/bin/pandoc"`。
- `python-docx` / `python-pptx` / `openpyxl` **已随 DSH 自带 Python 提供**，用分析 venv 的解释器即可：
  ```sh
  PY="${DSH_HOME:-$HOME/.dsh}/bio-research/venv/bin/python3"
  "$PY" -c "import docx, pptx, openpyxl; print('OK')"
  ```
- 环境总览见 **bio-research-env** 技能 §5。

## Markdown → Word（最常见）
```sh
pandoc paper.md -o paper.docx
```
- 期刊格式：先准备一个 `reference.docx`（用 Word 设置好样式），然后
  ```sh
  pandoc paper.md -o paper.docx --reference-doc=reference.docx
  ```
- 数学公式：`pandoc paper.md -o paper.docx --mathml`（Word 原生公式）
- 表格/图片：标准 Markdown 表格与图片语法即可；图注自动跟随
- **中文字体**：pandoc 转 docx 时中文默认走 docx 样式，不会乱码；若要显式指定，写 `-V mainfont="Songti SC"`，**不要写 `SimSun`**（Windows 字体，macOS 没有）

## Markdown → PDF（走 TinyTeX）
```sh
pandoc paper.md -o paper.pdf --pdf-engine=xelatex -V CJKmainfont="Songti SC"
```
已实测通过（中文正常嵌入 `STSongti-SC`）。
- 中文 PDF 必须用 `xelatex` 引擎并指定 CJK 字体：`-V CJKmainfont="Songti SC"`（或 `"PingFang SC"` / `"STSong"`）
- 学术模板：`--template` 指定期刊模板；`-V geometry:margin=2.5cm` 调页边距
- `--pdf-engine=xelatex` 找不到时，先按 **latex-compile** 技能把 TeX 的 bin 加进 PATH

## python-docx（程序化生成/编辑 Word）
```python
import docx
doc = docx.Document()
doc.add_heading('标题', level=1)
doc.add_paragraph('正文文本')
table = doc.add_table(rows=3, cols=2)   # 表格
table.style = 'Table Grid'
doc.save('output.docx')
```
- 常用：加标题/段落/表格/图片（`doc.add_picture('fig1.png', width=Inches(6))`）
- 修改既有 docx：打开 → 遍历 `doc.paragraphs` 替换文本 → 保存
- macOS 上中文字体名用 `Songti SC` / `PingFang SC`；python-docx 里设置字体需同时设 `run.font.name` 与 `w:eastAsia`（否则中文会回落）

> 需要生成 pptx / xlsx 时同理：`python-pptx` 与 `openpyxl` 也已随 DSH 自带 Python 提供。

## 投稿规范
- 多数期刊接受 Word（.docx）：正文 + 图表分开或合并提交，看期刊指南
- 图表按 `Figure 1. 标题` 编号，引用处写 `(Fig. 1)`；表格用三线表风格
- 交付时确认：字体（Times New Roman / 宋体 → macOS 写 `Songti SC`）、行距（通常双倍）、页边距（2.5cm）
- 图表分辨率 ≥300 dpi；矢量图（SVG/PDF）直接嵌入 Word 效果最好

## 流程建议
- 写作用 Markdown（版本管理友好），投稿前用 pandoc 转 docx
- 需要 PDF 时：Markdown →（pandoc + xelatex）→ PDF；或直接用 LaTeX 模板（见 latex-compile 技能）
- **工具没装就如实说**，先问用户是否安装，不要生成一个假的 `.docx` 交差
