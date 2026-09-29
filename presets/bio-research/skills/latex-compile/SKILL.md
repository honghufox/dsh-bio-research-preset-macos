---
name: latex-compile
description: 在 macOS 上编译 LaTeX 论文为 PDF：本机 TinyTeX（TeX Live 2026）的路径与用法、latexmk/xelatex 工作流、中文支持（ctex/xeCJK + 系统中文字体）、用 tlmgr 装缺失宏包、参考文献与常见报错处理。
whenToUse: 编译 .tex 文件为 PDF、处理 LaTeX 报错、安装缺失宏包、配置中文字体时
---

# LaTeX 编译（macOS / TinyTeX）

## 环境——已经装好了

本机装的是 **TinyTeX（TeX Live 2026）**，用户级安装，**不需要 sudo**：

```
~/Library/TinyTeX/bin/universal-darwin/{xelatex,pdflatex,latexmk,tlmgr}
```

它**不在 PATH 上**（macOS 默认 PATH 里没有可写目录，装不进去）。两个用法二选一：

```sh
# 推荐：source 一次，之后按裸名字调用
. "${DSH_HOME:-$HOME/.dsh}/bio-research/env.sh"
xelatex -interaction=nonstopmode main.tex

# 或者写绝对路径
"$HOME/Library/TinyTeX/bin/universal-darwin/xelatex" -interaction=nonstopmode main.tex
```

环境总览见 **bio-research-env** 技能 §5。

## 常用编译命令
```sh
latexmk -xelatex main.tex                  # 推荐：自动处理多轮编译与参考文献
xelatex -interaction=nonstopmode main.tex  # 单轮，快速看错误
pdflatex main.tex                          # 纯英文、无中文需求时
latexmk -c                                 # 清理中间产物（-C 连 PDF 一起删）
```

## 中文论文
- 用 `ctex` 文档类（`\documentclass[UTF8]{ctexart}` / `ctexrep` / `ctexbook`），内部已含 xeCJK，**无需额外配置字体**。`ctex` / `xeCJK` / `zhnumber` 都已装好。
- 或用 `\usepackage{xeCJK}` 手动指定。**macOS 上写系统自带的中文字体，不要写 `SimSun` / `Microsoft YaHei`（Windows 字体，本机没有）**：
  ```latex
  \usepackage{xeCJK}
  \setCJKmainfont{Songti SC}       % 宋体（正文）
  \setCJKsansfont{PingFang SC}     % 黑体（标题）
  \setCJKmonofont{Heiti SC}
  ```
  其他可用：`STSong` / `STHeiti` / `STKaiti` / `STFangsong`。用 `fc-list :lang=zh` 列全部中文字体。
- 编译**必须用 `xelatex`**：`pdflatex` 不支持中文。
- 已实测：`ctexart` 中文文档用 `xelatex` 编译通过，PDF 内嵌 `STSongti-SC` 子集字体（不是豆腐块）。

## 参考文献
- 简单引用：`thebibliography` 环境（无需外部工具）
- BibTeX：`.bib` 文件 + `\bibliography{refs}`；`latexmk` 会自动跑 bibtex
- biblatex + biber：`\usepackage[style=nature]{biblatex}`；用 `latexmk -xelatex -bibtex` 或 `-biber`（`biber` 与 `biblatex` 都已装）

## 缺失宏包
报错 `! LaTeX Error: File 'xxx.sty' not found` 时：

```sh
tlmgr install xxx                             # 按 .sty 文件名去掉扩展名装
tlmgr search --global --file '/xxx.sty'       # 不确定包名时先搜
```

- **不需要 sudo**（TinyTeX 在 `~/Library` 下，当前用户可写）。
- **仓库已指向清华 CTAN 镜像**（`https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet`），国内下载很快；镜像失效时用 `tlmgr option repository <url>` 换。
- scheme-small 只含常用包；`ctex` / `xeCJK` / `collection-fontsrecommended` / `biber` / `biblatex` 已装好。
- 装完重新编译。

## 常见问题
| 症状 | 处置 |
|---|---|
| `xelatex: command not found` | 没 source `env.sh`。见上文两条用法 |
| 中文全是方框/豆腐块 | 字体名写错（用了 Windows 字体名）。改用 `Songti SC`，或直接用 `ctex` 文档类 |
| `! LaTeX Error: File 'ctexart.cls' not found` | 少了 ctex，`tlmgr install ctex` |
| 目录/交叉引用是 `??` | 需要多轮编译；用 `latexmk` 自动处理 |
| 报错定位 | 看 `.log` 里第一个 `!` 之后的上下文 |
| 字体问题 | `\usepackage{fontspec}` 后 `\setmainfont` 指定系统字体 |

## 输出与清理
- 默认输出到源文件目录；交付时给 `.tex` 源 + 编译出的 `.pdf`
- 中间产物（`.aux .log .out .toc .bbl .blg .fls .fdb_latexmk`）交付前清理，或加 `.gitignore`
- 期刊模板：把期刊提供的 `.cls/.sty` 放到项目目录再编译
- 编译失败时**不要假装成功**：把 `.log` 里的首个 `!` 报错原文给用户，或先 `tlmgr install` 缺的包再重试
