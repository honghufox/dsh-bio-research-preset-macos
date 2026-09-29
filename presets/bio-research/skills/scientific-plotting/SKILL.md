---
name: scientific-plotting
description: 发表级科研绘图：matplotlib/seaborn 规范（尺寸、字体、DPI、色盲友好配色）与 macOS 中文字体配置，柱状/箱线/小提琴/散点/火山图/热图/生存曲线等生物学常见图型。
whenToUse: 绘制论文图表、制作 figures、调整图表样式、图里出现中文方框时
---

# 科研绘图（Publication-Quality Figures）

## 环境
- 本机是 macOS。**先读 `bio-research-env` 技能**拿到解释器路径：
  ```sh
  PY="${DSH_HOME:-$HOME/.dsh}/bio-research/venv/bin/python3"
  "$PY" -c "import matplotlib, seaborn; print('plotting ready')"
  ```
- 缺包：`"$PY" -m pip install matplotlib seaborn`（原预设假设已装，本机需确认）
- **不要用系统 `/usr/bin/python3`**：那是 Xcode 占位符，会弹窗且零输出

## 基线规范（matplotlib）
- 单栏图宽 3.5 in，双栏 7 in；高度按内容 2.5–5 in；输出 dpi=300（PNG/TIFF），矢量优先存 SVG/PDF
- 字体：Arial / Helvetica 或 Times（macOS 三者均自带）；字号 7–9 pt（多数期刊要求 6–10 pt）；数学符号用 mathtext
- 去图表垃圾：默认关闭 top/right 边框（ax.spines），网格浅色虚线可选
- 颜色：色盲友好（Okabe-Ito 或 seaborn colorblind 调色板）；不用红绿对比表达关键差异

## rcParams 推荐模板（写在脚本开头）
```python
import matplotlib as mpl
mpl.rcParams.update({
    'figure.dpi': 300, 'savefig.dpi': 300,
    'font.family': 'sans-serif', 'font.sans-serif': ['Arial', 'Helvetica'],
    'font.size': 8, 'axes.labelsize': 8, 'axes.titlesize': 9,
    'xtick.labelsize': 7, 'ytick.labelsize': 7,
    'axes.linewidth': 0.8, 'lines.linewidth': 1.2,
    'legend.fontsize': 7, 'svg.fonttype': 'none',
    'axes.unicode_minus': False,
})
```
`svg.fonttype: 'none'` 让 SVG 里的文字保持可编辑文本（而不是转成路径），Tavotto 与期刊排版都需要这一点。

## 生物学常见图型
- 柱状图 + 误差棒：seaborn.barplot + errorbar（注明 SEM 或 SD）；叠加散点（swarm/strip）优于纯柱状
- 箱线 / 小提琴：seaborn.boxplot / violinplot，配合显著性标注
- 散点 + 回归：seaborn.regplot；报告 Pearson/Spearman r 与 p
- 火山图：log2FC vs -log10(padj)，阈值线 + 按阈值着色高亮显著基因（matplotlib scatter）
- 热图：seaborn.clustermap（带层次聚类）或 heatmap + 行列注释（基因/样本）；Z-score 标准化需注明
- 生存曲线：R survival + survminer（ggsurvplot）或 Python lifelines；标注 log-rank p 与中位生存时间（R 已装好，用 `"${DSH_HOME:-$HOME/.dsh}/bio-research/r-env/bin/Rscript"`，见 survival-analysis 技能）
- 多面板：plt.subplots / GridSpec；统一图例、轴范围与配色
- 序列相关：序列 logo 用 R ggseqlogo 或 Python logomaker；比对图见 bioinformatics 技能

## 中文字体（macOS）
matplotlib 默认字体不含中文，图里写中文会变成方框。macOS 上**用系统自带的中文字体**，不要写 `Microsoft YaHei` / `SimHei`（Windows 字体，本机没有）：

```python
mpl.rcParams['font.sans-serif'] = ['PingFang SC', 'Songti SC', 'Heiti SC', 'Arial Unicode MS']
mpl.rcParams['axes.unicode_minus'] = False   # 否则负号显示为方框
```

用 `fc-list :lang=zh` 列出本机全部中文字体；字体名必须是 **PostScript/家族名**（`PingFang SC`），不是文件名。
若某个字体找不到，matplotlib 会静默回落到默认字体并刷一堆 `findfont` 警告——**看图确认中文没变方框**，别只看脚本跑通了。

- 投稿期刊大多要求英文标签：图中文字一律英文，中文只用于说明文字

## 输出与交付
- 存到工作区 `figures/` 目录；同时交付可复现脚本
- 交付时说明：图类型、统计方法、样本量、误差棒含义、软件与版本
- 交付前的版式微调走内置 Tavotto（见 tavotto-figure 技能）：`mcp__tavotto__tavotto_health` → `tavotto_open_figure` → `tavotto_apply_overrides` → `tavotto_preflight` → `tavotto_export` 导出真矢量 PDF
