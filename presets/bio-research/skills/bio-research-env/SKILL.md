---
name: bio-research-env
description: 本预设的运行环境说明（macOS 专属）：DSH 自带 Node/Python 运行时的绝对路径、预设自管分析 venv、系统 python3 陷阱、R / pandoc / TinyTeX 的安装方法、文件沙箱与批准边界、集群通道的配置文件名。任何"命令找不到""包没装""写不进去"的问题都先读这里。
whenToUse: 需要跑 Python/R 脚本、装包、找解释器路径、编译 LaTeX、转 Word、或遇到权限与沙箱问题时
---

# 运行环境（macOS）

> **本技能是环境问题的唯一权威。** 其他技能里凡涉及"用什么解释器""装了什么"，以本文件为准。
> 原预设面向 Windows（pwsh + 系统 python + `G:\dsh\_tools\` 下的便携工具链），那些路径在本机**全部不存在**。

## 0. 第一件事：自检

不确定环境状态时，先跑这一条（`bash` 工具）：

```sh
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
VENV="$DSH_HOME/bio-research/venv"
RENV="$DSH_HOME/bio-research/r-env"
TEXBIN="$HOME/Library/TinyTeX/bin/universal-darwin"
printf 'venv python : %s\n' "$([ -x "$VENV/bin/python3" ] && echo "$VENV/bin/python3" || echo '(未创建 -> 跑 setup.sh --with-science)')"
printf 'Rscript     : %s\n' "$([ -x "$RENV/bin/Rscript" ] && echo "$RENV/bin/Rscript" || echo '(未创建 -> 跑 setup.sh --with-r)')"
printf 'pandoc      : %s\n' "$([ -x "$RENV/bin/pandoc" ] && echo "$RENV/bin/pandoc" || echo '(未装 -> 跑 setup.sh --with-writing)')"
printf 'xelatex     : %s\n' "$([ -x "$TEXBIN/xelatex" ] && echo "$TEXBIN/xelatex" || echo '(未装 -> 跑 setup.sh --with-writing)')"
printf 'dsh node    : %s\n' "$(ls -d "$DSH_HOME"/dsh-runtimes/*/dependencies/node/bin/node 2>/dev/null | head -1)"
printf 'dsh python  : %s\n' "$(ls -d "$DSH_HOME"/dsh-runtimes/*/dependencies/python/bin/python3 2>/dev/null | head -1)"
printf 'ssh / scp   : %s / %s\n' "$(command -v ssh || echo '(缺)')" "$(command -v scp || echo '(缺)')"
# 想要裸命令可用就先 source；下面这两行顺带验证它没坏
. "$DSH_HOME/bio-research/env.sh" 2>/dev/null && echo "env.sh      : 已 source"
Rscript -e 'cat("R           :", R.version.string, "\n")' 2>/dev/null
xelatex --version 2>/dev/null | head -1
```

## 1. 两个 Python，别用错

| | 路径 | 用途 |
|---|---|---|
| **分析 venv（首选）** | `$DSH_HOME/bio-research/venv/bin/python3` | 所有数据分析、绘图、生信脚本。scipy / statsmodels / seaborn / lifelines / biopython / vcfpy 等装在这里 |
| DSH 自带运行时 | `$DSH_HOME/dsh-runtimes/*/dependencies/python/bin/python3` | 兜底。固定带 numpy / pandas / python-docx / python-pptx / openpyxl / Pillow / lxml / XlsxWriter，可作为 venv 的基底 |
| ~~`/usr/bin/python3`~~ | — | **绝对不要用**。这是 Xcode 命令行工具的占位符：未装 CLT 时会弹出系统安装对话框并返回**空输出**，命令看起来"成功"但什么也没做 |

脚本开头统一写：

```sh
PY="${DSH_HOME:-$HOME/.dsh}/bio-research/venv/bin/python3"
"$PY" analyze.py
```

venv 不存在时，先跑预设根目录的 `./setup.sh --with-science` 创建；或临时退回 DSH 自带运行时：

```sh
PY="$(ls -d "${DSH_HOME:-$HOME/.dsh}"/dsh-runtimes/*/dependencies/python/bin/python3 2>/dev/null | head -1)"
```

## 2. Node 也不在 PATH 上

macOS 上系统**没有** node/npm。DSH 桌面版自带 Node 24，但不进 PATH：

```sh
NODE="$(ls -d "${DSH_HOME:-$HOME/.dsh}"/dsh-runtimes/*/dependencies/node/bin/node | head -1)"
"$NODE" -v
```

预设里的 MCP 子进程（biotools / zotero）在挂载时按候选链自动解析 node，**不需要你操心**；只有你自己要跑 `.mjs`/`.js` 时才需要上面这条。

## 3. 装 Python 包

一律装进分析 venv，不要动系统 Python：

```sh
PY="${DSH_HOME:-$HOME/.dsh}/bio-research/venv/bin/python3"
"$PY" -m pip install <包名>
"$PY" -m pip list
```

注意：`setup.sh` 装的是覆盖生信/统计常用的一组包。**缺什么补什么，不要盲目重装**——先 `"$PY" -m pip show <包名>` 确认。

## 4. R —— 已装好，用绝对路径调用

R **4.5.3 已经装好**，用的是 micromamba 建的独立环境（不需要 Homebrew、不需要 sudo）：

```sh
R="${DSH_HOME:-$HOME/.dsh}/bio-research/r-env/bin/Rscript"
"$R" -e 'cat(R.version.string, "\n")'
"$R" analysis.R                 # 跑脚本
"$R" -e 'library(survival); print(1)'   # 单行自检
```

**R / Rscript 不在 PATH 上**（macOS 的默认 PATH 里没有可写目录，装不进 `/usr/local/bin`），所以脚本与文档里一律写上面的绝对路径；`Rscript foo.R` 这种裸调用会 command not found。

已装的包（22 个，全部实测 `requireNamespace` 通过）：

| 用途 | 包 |
|---|---|
| 生存分析 | `survival` `survminer` `timeROC` `survivalROC` `rms` `cmprsk` `forestplot` |
| 变异 / 组学 | `vcfR` `biomaRt` `DESeq2` `edgeR` |
| 绘图 | `ggplot2` `ggseqlogo` `VennDiagram` `eulerr` |
| 数据基础 | `data.table` `dplyr` `tidyr` `readr` `jsonlite` `optparse` `BiocManager` |

补装 R 包：

```sh
R="${DSH_HOME:-$HOME/.dsh}/bio-research/r-env/bin/Rscript"
"$R" -e 'options(repos=c(CRAN="https://mirrors.tuna.tsinghua.edu.cn/CRAN/")); install.packages("<包名>")'
"$R" -e 'BiocManager::install("<包名>")'          # Bioconductor 的包
```

装包时**必须带 `options(repos=...)` 指向国内镜像**：默认 CRAN 在国内很慢，而 conda 环境里没有预置 repos。

### 环境里已经配好的编译链（改包时别删）

`~/.R/Makevars` 里有两处**必需**的覆盖，删掉后 `install.packages()` 会编译失败：

- `FLIBS` —— conda 的 `Makeconf` 把它钉在 `lib/gcc/<triple>/14.3.0`，而实际装的是 gfortran 16.2.0，链接期会报 `library 'gfortran' not found`。
- `SHLIB_OPENMP_*` 清空 —— Apple clang 不认 `-fopenmp`；`mets` / `riskRegression` 这类包虽带该 flag，但自身已设 `-DARMA_DONT_USE_OPENMP`，并不真的需要 OpenMP。

C/C++/Fortran 编译器来自 conda 自带的 `c-compiler` / `cxx-compiler` / `gfortran`，**不要**改指系统 clang：两套混用会出现 gfortran 找不到 clang 去链接。

### 没装的

- 集群侧的重型注释（VEP / ANNOVAR）—— 按 ncpgr-bio-router 技能放到集群上跑。

用户不想用 R 时，改走 Python 等价路径（lifelines / statsmodels / cyvcf2 等），并在交付时说明换了实现。

## 5. pandoc / LaTeX —— 都已装好

两个都装好了，**都不在 PATH 上**（原因同 R）。

| | 路径 |
|---|---|
| **pandoc 3.11** | `$DSH_HOME/bio-research/r-env/bin/pandoc` |
| **TinyTeX**（TeX Live 2026，含 `xelatex` / `pdflatex` / `latexmk` / `tlmgr`） | `~/Library/TinyTeX/bin/universal-darwin/` |

**最省事的用法：先 source 一个文件，之后所有命令都按裸名字调用。**

```sh
. "${DSH_HOME:-$HOME/.dsh}/bio-research/env.sh"
Rscript analysis.R
pandoc paper.md -o paper.docx
xelatex -interaction=nonstopmode main.tex
```

`env.sh` 由 `setup.sh` 生成，只做一件事：把 `r-env/bin` 与 TinyTeX 的 `bin` 前置进 PATH。不想 source 就用绝对路径。

- 中文字体：用系统自带的 **Songti SC / PingFang SC / STSong / Heiti SC**，不要写 `SimSun`（Windows 字体，macOS 没有）。详见 latex-compile 与 scientific-plotting 技能。
- 补装宏包：`tlmgr install <包名>`（仓库已指向清华 CTAN 镜像，**不需要 sudo**——TinyTeX 装在 `~/Library` 下）。
- 实测过的通路（别怀疑环境）：`xelatex` 编 `ctexart` 中文文档出 PDF（内嵌 `STSongti-SC` 子集字体）、`pandoc` 转 docx、`pandoc --pdf-engine=xelatex -V CJKmainfont="Songti SC"` 转 PDF，三者都通过。
- **没装就不要假装装了**：交付时如实说明，或先问用户是否安装。

## 6. 沙箱与批准边界

- 文件沙箱为 `workspace-write`：**只有会话工作区内可自由读写**。写工作区之外（如 `~/.dsh`、`/usr/local`、系统目录）会触发批准请求，被拒时不要换路子绕过。
- `bash` 工具的命令同样受沙箱约束；被拦时会明确报 `[sandbox: file access denied ...]`，那是策略拒绝，不是 bug。
- 数据文件、脚本、figures/、结果表一律放在**工作区**内。

## 7. 集群通道的配置文件（都在 `$DSH_HOME`）

| 文件 | 内容 |
|---|---|
| `dsh-ssh-connections.json` | 集群连接：`{"connections":[{"id","host","port","username","password"}]}` |
| `dsh-ssh-totp.json` | 动态口令密钥，键为 `"user@host:port"`，值为 base32 密钥 |

两者**只存本机、绝不提交**。缺动态口令密钥时 `cluster_exec` 会直接报错并给出该文件路径。配置是否就绪用 `cluster_status` 工具自查（它同时报告 ssh 客户端与活动会话）。集群侧的作业规范见 **ncpgr-lsf** 技能。

**用助手脚本，不要手写这两个 JSON**——TOTP 的键必须是 `"用户名@主机:端口"`，写错了 `cluster_exec` 只会回一句"缺少动态口令"，很难查：

```sh
"${DSH_HOME:-$HOME/.dsh}/bio-research/bin/cluster-credentials"          # check：脱敏查看
"${DSH_HOME:-$HOME/.dsh}/bio-research/bin/cluster-credentials" set      # 交互式写入（权限 0600）
```

- `check` 脱敏列出主机/端口/用户名、密码是否已设、密钥长度与键名——**排查时先跑它**。
- `set` 会问主机/端口/用户名/密码/连接 id/base32 密钥，校验密钥是合法 base32（只含 `A-Z2-7`），写成 `0600`。
- 用户问"密钥怎么查看"时：**默认给 `check`**（脱敏）；只有用户明确要明文才用 `show`，并提醒他别把输出贴到别处。
- 注意密钥是 **base32 种子**（认证器里那条 `otpauth://` 的 `secret=` 参数），**不是**当前那 6 位数字。用户只拿得到 6 位码时，让他从二维码/`otpauth://` 链接里把 secret 取出来。
- 改完这两个文件**需要重启 DSH** 才生效（`command`/env 只在挂载时读一次）。

## 8. 常见故障速查

| 症状 | 原因 / 处置 |
|---|---|
| `python3: command not found` 或弹窗后无输出 | 用了系统 `/usr/bin/python3`。改用分析 venv 或 DSH 运行时的绝对路径 |
| `ModuleNotFoundError: No module named 'scipy'` | 装进了别的解释器。用 `"$PY" -m pip install scipy`，`$PY` 必须是分析 venv 的那个 |
| `node: command not found` | 系统没有 node。用 §2 的绝对路径 |
| `xelatex: command not found` | LaTeX 未装，或 TeX 的 bin 目录不在 PATH。见 §5 |
| `Rscript: command not found` | R 未装。见 §4 |
| 写文件 `[sandbox: file access denied ...]` | 目标在工作区之外。改放工作区内，或先征得用户批准 |
| MCP 工具（`mcp__biotools__*` 等）缺失 | MCP 子进程起不来。回预设根目录跑 `./setup.sh`，然后**重启 dsh**（`command`/env 只在挂载时读一次） |
