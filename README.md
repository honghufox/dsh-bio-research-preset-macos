# 生物科研模式（含 LSF 集群执行）—— **macOS 适配版**（DSH Agent 预设）

DeepSeek Harness 的「生物科研模式（含 LSF 集群执行）」预设，从 Windows 版移植到 **macOS**，打包为自包含、可移植的 desktop bundle：放到本机任意路径，跑一次 `setup.sh` 即可在 DSH 桌面版 / Web 版的预设列表里选用。

- 预设 id：`bio-research`
- bundle 名：`bio-research-preset`
- 自带资源：`presets/bio-research/`（技能、工具与本地插件源码）

> **来源与许可**：移植自 <https://github.com/honghufox/dsh-bio-research-preset>（MIT）。
> 原预设面向 Windows（pwsh + 系统 Python + `G:\dsh\_tools\` 下的便携工具链）。
> 本仓库保留其**全部功能**，只把宿主相关的部分改写成 macOS 语义。第三方技能与工具的版权归各自作者所有（Tavotto 为 AGPL-3.0-only，详见 `presets/bio-research/tools/tavotto/LICENSE`）。

---

## 一、为什么不能直接把 Windows 版搬过来

原版的 `cordis.patch.yml`、技能文本和插件里散落着 Windows 专有的假设。这些在原机器上成立，在 macOS 上会**直接失效**（不是"退化"，是命令找不到、进程起不来）：

| 原版假设 | macOS 上的现实 | 本版怎么改 |
|---|---|---|
| 本机 shell 是 `pwsh`（`@deepseek-ai/dsh-pwsh-local` + `dsh-tool-pwsh`） | macOS 没有 pwsh | 隔离组内换成 `@deepseek-ai/dsh-bash-local` + `dsh-tool-bash`；**两行都带 `!!js` 平台条件**，所以同一个 bundle 在 Windows 上仍然可用 |
| MCP 子进程 `command: node` | 系统**没有** node（DSH 自带运行时但不进 PATH） | 改为候选链解析：`DSH_MCP_NODE` → DSH 主运行时 node → Homebrew 两处 |
| MCP 子进程 `command: python` | `/usr/bin/python3` 是 **Xcode 命令行工具的占位符**：命令存在、未装 CLT 时弹窗并返回**空输出** | 指向预设自管 venv；候选链**刻意不含** `/usr/bin/python3` |
| Tavotto venv：`%APPDATA%\Tavotto\mcp-runtime\venv\Scripts\python.exe` | 路径不存在 | `~/Library/Application Support/Tavotto/mcp-runtime/venv/bin/python3`，并把预设自管 venv 排在更前 |
| Tavotto 可信根：`C:\Users\wangh` | 路径不存在，导致每个 `open` 都回 `path_out_of_scope` | 默认 `os.homedir()`；多根分隔符在 macOS 上是 `:` 而不是 `;` |
| askpass：`askpass.bat`（cmd + `%1` 计数 + node 子进程） | 没有 cmd，且 `process.execPath` 在桌面版里是 Electron 主程序（误启动会拉起 GUI） | 改为**纯 POSIX sh** 的 `askpass.sh`（0700），凭据拆成 `password` / `otp` 两个 0600 文件，**整条路不再依赖任何解释器** |
| `ssh -o UserKnownHostsFile=NUL`（Windows 空设备） | macOS 没有 `NUL` | `/dev/null` |
| TinyTeX：`G:\dsh\_tools\TinyTeX\bin\windows\xelatex.exe` | 路径不存在 | 技能改写为 Homebrew BasicTeX/MacTeX + `universal-darwin` 二进制目录 |
| pandoc：`G:\dsh\_tools\pandoc\pandoc.exe` | 路径不存在 | `brew install pandoc` |
| 中文字体：`SimSun` / `Microsoft YaHei` / `SimHei` | macOS 没有这些字体（图表中文会变方框） | `Songti SC` / `PingFang SC` / `Heiti SC` / `STSong` |
| 技能声称 scipy / statsmodels / seaborn / lifelines / vcfpy / Biopython / R 4.5 "已装" | 这些在那台 Windows 机器上装了，**本机没有** | 新增 `bio-research-env` 技能作为环境唯一权威；`setup.sh` 建分析 venv 并按需安装；其余技能改为"先自检、缺什么装什么" |
| 三个社区工具包从 `G:\dsh\_plugins` 以 `file:` 链接挂载 | 该目录不存在，且这三个包**在 npm 上是 404**、也未随原仓库分发 | 随 bundle 分发**功能等价的本地实现**（见下） |
| 技能引用 `ncpgr-lsf` / `ncpgr-hpc` / `ncpgr-data-manage` / `ncpgr-software` / `ncpgr-bio-router`，但**原仓库里一个都没有** | 预设挂载后 persona 指向的技能不存在 | 直接从集群上取**官方版本**：`/public/home/software/opt/skills/` 下有官方的 `ncpgr-lsf` / `ncpgr-bio-router` / `ncpgr-data-manage` / `ncpgr-software`（含 `references/` 与 `.lsf` 作业模板）。整套原样收进预设，只把 front matter 的 `trigger` 折成 DSH 认的 `whenToUse`。**没有官方的 `ncpgr-hpc`**（那是原 persona 的过时引用），已改为指向 `ncpgr-software` 并删除自编版本 |
| 所有自带资源都用 `new URL('presets/bio-research/…', baseUrl)` 定位（原 README 称"baseUrl = 组合文件所在目录，因此自解析"） | **这句在实测中不成立**：预设子插件的 `baseUrl` 是 **profile 目录**，不是 bundle 目录。于是路径全部落到 `<profile>/presets/…`（不存在）——MCP server 起不来、技能目录扫不到，预设**表面挂载成功、实际是个空壳** | 换成 bundle 定位器：对 `node_modules/bio-research-preset/`、`local-bundles/bio-research-preset/`、裸相对路径三个候选前缀逐个探测，取第一个真实存在的 |

### ⚠ 关于 `baseUrl`（原版就存在的坑，实测复现）

原仓库 README 的核心卖点是"`Include` 会把 `baseUrl` 设为组合文件所在目录，所以同一个表达式自解析"。**实测（DSH 0.2.0-rc.2，本机）不成立**：

```
预设子插件里 baseUrl = file:///…/profiles/<profile>/     ← profile 目录，不是 bundle 目录
因此 new URL('presets/bio-research/tools/ncbi/run-ncbi-mcp.py', baseUrl)
     → /…/profiles/<profile>/presets/bio-research/tools/ncbi/run-ncbi-mcp.py   ← 不存在
```

启动日志里的原始报错：

```
…/bio-research/venv/bin/python3: can't open file '…/profiles/bioweb/presets/bio-research/tools/ncbi/run-ncbi-mcp.py': [Errno 2] No such file or directory
Error: Cannot find module '…/profiles/bioweb/presets/bio-research/tools/biotools/node_modules/bach-biotools-server/build/index.js'
```

而 `dsh-agent-presets` 只会报"挂载成功"（`failOnStartupError: false` 让 MCP 失败不阻断挂载），所以这个坑**不会以错误形式暴露**，只会表现为"什么都没有"。

本版把所有 7 处自带资源引用改成对三个候选前缀探测：

```js
(() => { const fs = process.getBuiltinModule('node:fs'); const u = process.getBuiltinModule('node:url');
  const rel = 'presets/bio-research/skills/';
  for (const prefix of ['node_modules/bio-research-preset/', 'local-bundles/bio-research-preset/', '']) {
    const found = u.fileURLToPath(new URL(prefix + rel, baseUrl));
    if (fs.existsSync(found)) return found }
  return u.fileURLToPath(new URL(rel, baseUrl)) })()
```

三个候选分别覆盖：bundle 作为 profile 依赖经 pnpm 解析出的 `node_modules` 软链、安装器放的 `local-bundles/`、以及"baseUrl 恰好就是 bundle 目录"这种（未来可能出现的）情形。**结论不变**：bundle 仍可放在任意路径，无需安装期改写绝对路径。

### ⚠ macOS 库校验：DSH 自带 Python **装不了** pip 的包

这是本次移植里最隐蔽的一条，不处理的话 ncbi MCP 与整个科学计算栈都会在**运行时**才炸。

DSH 自带 Python 是**加固运行时 + 团队签名**的：

```
$ codesign -dv .../python/bin/python3.12
CodeDirectory … flags=0x10000(runtime)
TeamIdentifier=NAN929V4UM
```

macOS 的库校验因此只允许它加载**同一 Team ID 签名**的动态库。DSH 随包发的 numpy / pandas / lxml 正是这样签的，所以能用；而 `pip install` 装回来的 wheel 里的 `.so` 是 `adhoc, linker-signed`、`TeamIdentifier=not set`，`dlopen` 一律被拒：

```
ImportError: dlopen(.../site-packages/pydantic_core/_pydantic_core.cpython-312-darwin.so, 0x0002):
  … (non-platform) have different Team IDs
```

后果是**整条链断掉**：`pydantic_core` → `pydantic` → `mcp` SDK → ncbi MCP 起不来；`scipy` / `scikit-learn` / `lifelines` 这些带扩展的科学栈同样装不起来。（纯 Python 的 `tavotto` 不受影响，所以单看它"能用"会误判。）

`setup.sh` 的处置：把该解释器**复制一份**到 `$DSH_HOME/bio-research/python/`，用 `com.apple.security.cs.disable-library-validation` 重新做 adhoc 签名，再用这份副本建 venv。副本只写在用户自己的 `$DSH_HOME` 下，**不碰 DSH 安装目录、不改系统**；stdlib 与随包 site-packages 走符号链接，运行时升级能自动跟随。

不想重签名（或本机已有未被加固的 Python），改用外部解释器即可：

```sh
BIO_PRESET_BASE_PYTHON=/opt/homebrew/bin/python3 ./setup.sh --with-science
```

`./setup.sh --check` 会真的去 `dlopen` 一个 pip 装回来的扩展并报告结果，不会只看"文件在不在"。

### ⚠ 工具 schema 必须同时满足两套规则（否则预设整组挂不上）

工具定义要过**两道**不同的 schema 校验，规则并不一致：

| | 何时生效 | 规则 |
|---|---|---|
| **作者方言**（`defineTool` 的 "value schema DSL"） | `require('@deepseek-ai/dsh-tools')` 解析得到时。**实测这是运行时的真实路径**——loader 提供了内部模块解析，插件里那句 `require` 在 DSH 进程里是成功的 | `required` 只能以 `true` 写在**属性表条目**上（编译器收拢成父对象的 `required` 数组）；`type: 'object'` **必须显式声明 `additionalProperties`**（`true`/`false`） |
| **原始子集**（`assertSupportedJsonSchema`） | `dsh-tools` 解析不到时（如脱离 DSH 的纯 node 环境），走 `toToolDefinition` 回退 | `required` 必须是 object 节点上的**字符串数组**；不支持 `type` 数组 |

两套都要满足。本版踩到的两个真实报错（都会让 `dsh-agent-presets` 把整个预设标成 `broken`，GUI 里就是**「预设加载失败」**，而日志里只有一行）：

```
tool-csv (dsh-tool-csv): schema.properties.columnInfo.items.required is not supported by the value schema DSL
dsh-sci (dsh-sci):       parameters.equations.additionalProperties must be explicitly true or false
```

处置：

1. `columnInfo.items` 上的 `required: [...]` 数组 → 改成每个属性写 `required: true`（作者方言写法），回退路径由编译器收拢；
2. 7 个 object 节点补上显式 `additionalProperties`；
3. 7 处 `type: ['number','null']` → `oneOf: [{type:'number'},{type:'null'}]`（作者方言支持 `oneOf`，原始子集支持它且拒绝 type 数组，两边都过）；
4. `toToolDefinition` 里保留一层编译器，把作者方言规范化成原始子集——**这是兜底，不是主修复路径**，但少了它，任何脱离 DSH 的加载场景都会炸。

四插件的 9 个工具现在同时通过两套校验（见 §六）。

### ⚠ 顶层 shell 行与隔离组里的 shell 行会撞车（原版就有）

原版在顶层挂了一对 `tool-bash` / `tool-pwsh`（按平台条件二选一），又在下面的 `cluster-ssh` 隔离组里**再挂了一对同名工具**。`isolate` 隔离的是**服务**（`shell`），**不是注册作用域**——两行落在同一个 scope 里，第二个注册同一段 prompt section 时直接抛：

```
tool-bash-cluster (@deepseek-ai/dsh-tool-bash): prompt section "tool:bash" is already registered in this scope
```

这同样会让整个预设 `broken`。**实测确认原版这个结构在 macOS 上必然失败，Windows 上同理**（那边撞的是 pwsh）。

本版删掉了顶层那对，本机 shell 工具只由 `cluster-ssh` 组提供（组内既有 `dsh-cluster-ssh` 的集群工具，也有「本地 shell provider + 本地 shell 工具」）。`bash` 工具依旧执行本机命令，`cluster_exec` 走集群，职责不变。

## 二、与原版的对应关系

**功能上完全对齐**，逐项如下：

- **人格与平台语义**：同一份 persona，集群段落逐字保留；仅把"本机是 Windows / 用 pwsh"改成"本机是 macOS / 用 bash"，并加上环境自检指引。
- **技能**：原有 9 个技能全部保留（`bioinformatics`、`biostatistics`、`document-output`、`latex-compile`、`literature-review`、`paper-writing`、`scientific-plotting`、`survival-analysis`、`variant-analysis`），其中 3 个按 macOS 重写、5 个改写了环境段。**新增 5 个**：`bio-research-env`（macOS 环境权威）+ 集群官方的 4 个 `ncpgr-*` 技能。

### 集群侧的 `ncpgr-*` 技能：直接取自集群，不是自己编的

原 persona 引用了 `ncpgr-lsf` 等技能，但原仓库里一个都没有。**集群上其实带着官方版本**：

```
/public/home/software/opt/skills/
├── ncpgr-lsf/           SKILL.md (438 行) + references/{lsf-guide,faq,quick-ref}.md + scripts/*.lsf ×5
├── ncpgr-software/      SKILL.md + bioapp_core_ad.md + app/_overview.md + app_list
├── ncpgr-data-manage/   SKILL.md + scripts/*.sh ×4
└── ncpgr-bio-router/    SKILL.md + references/workflow-map.md
```

（同一份也软链在 `/public/home/software/.claude/skills/` 下，给集群上的 Claude Code 用。）

本预设把这四个**整套原样收录**（含 `references/` 与作业模板脚本）。唯一的改动是 front matter：官方用的是 Claude Code 约定（`trigger` 字段），DSH 认的是 `whenToUse`，所以把 `trigger` 折成一行 `whenToUse`——**正文一个字没动**。

重新同步（集群侧内容更新后）：

```sh
# 在能连集群的机器上，通过 cluster_exec 打包取回
cd /public/home/software/opt/skills && tar czf /tmp/ncpgr.tgz ncpgr-lsf ncpgr-bio-router ncpgr-data-manage ncpgr-software
base64 -w 100 /tmp/ncpgr.tgz          # 再在本地解码解压
```

> 注意：官方集合里**没有 `ncpgr-hpc`**——那是原 persona 的过时引用。本版已把 persona 改成指向 `ncpgr-software`，并删掉了先前自编的 `ncpgr-hpc`。

官方文档里几条**与直觉相反、但很关键**的规范（自己编的时候很容易写反）：

- **计算节点不联网**：下载数据/参考基因组、装软件包**必须在登录节点做**；比对/定量/组装这类纯计算才提交到计算节点。所以"登录节点什么都别跑"是错的简化。
- **不要写 `-M` / `rusage[mem=...]`**：所有队列已配好单核内存上限，**作业总内存 = 申请核数 × 队列单核上限**，要更多内存只需加大 `-n`。
- **不要写 `-W`**：不需要时间限制。
- 作业脚本后缀必须是 **`.lsf`**，且要写得极简（不要炫 sed/awk 技巧），用户得能自己读懂改懂。
- **工具行**：`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-goal`、`tool-ask-user`、`tool-todo`、`tool-web`、plan mode、compaction、delegation/workflow 全部原样保留（含 `disabled` 的 codex / claude-code 子代理行）。
- **四个 MCP server**：`biotools`（37 个生信工具）、`ncbi`（E-utilities）、`zotero`（默认禁用，需凭证）、`tavotto`（9 个配图工具），配置项与原版一一对应，只改了解释器解析与路径。
- **集群通道**：`dsh-cluster-ssh` 插件的四个工具（`cluster_exec` / `cluster_status` / `cluster_upload` / `cluster_download`）与 TOTP 逻辑**原样保留**（TOTP 已用 RFC 6238 官方测试向量验证），只把 askpass 与空设备路径改成 POSIX。
- **三个数据/统计工具**：原版从 `G:\dsh\_plugins` 挂的 `@deepseek-ai/dsh-tool-csv`、`@deepseek-ai/dsh-tool-stat`、`dsh-sci` 在 npm 上不存在，本版按原注释声明的能力**重新实现**并随包分发：
  | 包 | 工具 | 能力（对齐原注释） |
  |---|---|---|
  | `dsh-tool-csv` | `csv` | RFC 4180 CSV **文本**的 parse / describe / query / stats（自写解析器处理引号、`""` 转义、字段内换行、CRLF；256KB 上限） |
  | `dsh-tool-stat` | `stat` | 有限数值数组的 describe / percentile / frequency / correlation（Neumaier 补偿求和 + Welford 方差 + 线性插值百分位 + Spearman 中位秩） |
  | `dsh-sci` | `unit_convert` / `constant_lookup` / `ode_simulate` | 量纲感知的单位换算（含温度仿射刻度）、CODATA 物理常数、Runge-Kutta ODE 积分（受限公式语言，不用 `eval`） |

  > 这三者用**本地实现**而非原包，是本次移植中唯一"换实现"的地方——因为原包既不在 npm 也不在原仓库里，无法搬运。行为与原注释描述一致。

## 三、安装

### 快速安装

```sh
cd <这个目录>
./setup.sh --with-science --with-r --with-writing
```

- `--with-science` 把 `scipy / statsmodels / seaborn / scikit-learn / matplotlib / lifelines / biopython / vcfpy` 装进分析 venv（推荐；不加则只有 MCP 运行必需的最小集合）。
- `--with-r` 装 **R 4.5.3** 与 22 个常用包（生存分析 / 变异 / 组学 / 绘图），走 micromamba，**不需要 sudo、也不需要 Homebrew**。

装完**重启 DSH**（桌面版退出重开；Web 版重启 `dsh web`），新建会话时即可在预设列表里选到「生物科研模式」。

### 参数

| 参数 | 作用 |
|---|---|
| `--with-science` | 额外安装数据分析 / 生信 Python 栈（推荐） |
| `--with-r` | 额外安装 R 4.5 + 22 个常用包（micromamba，免 sudo；推荐） |
| `--with-writing` | 额外安装 pandoc + TinyTeX + 中文宏包（免 sudo；推荐） |
| `--minimal` | 只装 `ncbi-mcp` + `mcp 1.x`，跳过 Tavotto 引擎与科学栈 |
| `--copy` | 把 bundle 复制进 `local-bundles`（默认是符号链接，改完即生效） |
| `--profile <目录>` | 指定 profile 目录（默认 `$DSH_HOME/profiles/$DSH_PROFILE`，通常 `~/.dsh/profiles/desktop`） |
| `--no-profile` | 只装依赖，不改 profile 清单 |
| `--check` | 只做环境自检并打印报告，**不做任何改动** |

### 前置条件

- 已安装并**至少启动过一次** DSH 桌面版——`setup.sh` 依赖它自带的两套运行时：
  - Node 24 + pnpm：`$DSH_HOME/dsh-runtimes/*/dependencies/{node,pnpm}`
  - Python 3.12（含 numpy / pandas / python-docx 等）：`$DSH_HOME/dsh-runtimes/*/dependencies/python`
- macOS 自带 `/usr/bin/ssh`、`/usr/bin/scp`（集群通道用；`SSH_ASKPASS_REQUIRE=force` 需要 OpenSSH ≥ 8.4，macOS 自带的 10.x 满足）
- **不需要 sudo，不需要 Homebrew**，也不需要 GitHub 连通性（R 与 TeX 都走清华镜像）
- Xcode 命令行工具（`xcode-select --install`）：R 从 CRAN 编译 `timeROC` / `survivalROC` 时需要 C/Fortran 编译器

### 不在 PATH 上的工具：`env.sh`

R / pandoc / LaTeX 都装在用户目录、**都不在 PATH 上**（macOS 默认 PATH 里没有可写目录，装不进去）。`setup.sh` 会生成一个文件把它们一次性前置进去：

```sh
. "${DSH_HOME:-$HOME/.dsh}/bio-research/env.sh"
Rscript analysis.R
pandoc paper.md -o paper.docx
xelatex -interaction=nonstopmode main.tex
```

不 source 就用绝对路径：`$DSH_HOME/bio-research/r-env/bin/{Rscript,pandoc}`、`~/Library/TinyTeX/bin/universal-darwin/{xelatex,latexmk,tlmgr}`。

### R 环境

装在 `$DSH_HOME/bio-research/r-env`。已装 22 个包：`survival` `survminer` `timeROC` `survivalROC` `rms` `cmprsk` `forestplot` `vcfR` `biomaRt` `DESeq2` `edgeR` `ggplot2` `ggseqlogo` `VennDiagram` `eulerr` `data.table` `dplyr` `tidyr` `readr` `jsonlite` `optparse` `BiocManager`。

补装（**必须带国内镜像**，conda 环境里没有预置 repos）：

```sh
R="${DSH_HOME:-$HOME/.dsh}/bio-research/r-env/bin/Rscript"
"$R" -e 'options(repos=c(CRAN="https://mirrors.tuna.tsinghua.edu.cn/CRAN/")); install.packages("<包名>")'
"$R" -e 'BiocManager::install("<包名>")'
```

> ⚠ `~/.R/Makevars` 里有两处**必需**的覆盖，删掉后编译任何 R 包都会失败：`FLIBS`（conda 的 Makeconf 钉在旧的 gcc 版本目录，链接期报 `library 'gfortran' not found`）与清空的 `SHLIB_OPENMP_*`（Apple clang 不认 `-fopenmp`）。细节见预设内的 `bio-research-env` 技能 §4。

### 写作工具链

- **pandoc 3.11** — conda-forge 预编译包，装在 `r-env` 里（R Markdown 也需要它）
- **TinyTeX（TeX Live 2026）** — 用户级安装到 `~/Library/TinyTeX`，`scheme-small` + `ctex`/`xeCJK`/`zhnumber`/`collection-fontsrecommended`/`biber`/`biblatex`；`tlmgr` 仓库已指向清华 CTAN 镜像，**补装宏包不需要 sudo**
- 实测通路：`xelatex` 编 `ctexart` 中文文档 → PDF（内嵌 `STSongti-SC` 子集字体）；`pandoc` → docx；`pandoc --pdf-engine=xelatex -V CJKmainfont="Songti SC"` → PDF

> 为什么不用 Homebrew：装 Homebrew 要 sudo 建 `/opt/homebrew`，而 `raw.githubusercontent.com` 在国内通常不通。conda-forge 的 `texlive-core` **不含 `xelatex`**（中文必须用它），也没有 `tlpkg`，`tlmgr` 管不了，所以 LaTeX 走 TeX Live 官方 `install-tl` 的用户级安装。

### 手工安装（不用 setup.sh）

```sh
BUNDLE="$(pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/desktop"
NODE="$(ls -d "$DSH_HOME"/dsh-runtimes/*/dependencies/node/bin/node | head -1)"
PNPM="$(ls -d "$DSH_HOME"/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.mjs | head -1)"

# 1) 重建 Node 依赖（macOS 上没有 npm，用 DSH 自带的 pnpm）
(cd "$BUNDLE/presets/bio-research/tools/biotools" && "$NODE" "$PNPM" install --prod --ignore-workspace)
(cd "$BUNDLE/presets/bio-research/tools/zotero"   && "$NODE" "$PNPM" install --prod --ignore-workspace)

# 2) 建分析 venv
BASE_PY="$(ls -d "$DSH_HOME"/dsh-runtimes/*/dependencies/python/bin/python3 | head -1)"
"$BASE_PY" -m venv --system-site-packages "$DSH_HOME/bio-research/venv"
"$DSH_HOME/bio-research/venv/bin/python3" -m pip install 'ncbi-mcp' 'mcp>=1.0,<2' 'tavotto[worker]'

# 3) 挂进 profile
mkdir -p "$PROFILE/local-bundles"
ln -sfn "$BUNDLE" "$PROFILE/local-bundles/bio-research-preset"
# 编辑 $PROFILE/package.json：
#   dependencies 里加  "bio-research-preset": "link:./local-bundles/bio-research-preset"
#                     以及四个插件的 file: 依赖（见 setup.sh 的输出）
#   dsh.profile.bundles 里加  "bio-research-preset"
(cd "$PROFILE" && "$NODE" "$PNPM" install)
```

## 四、配置

### 集群通道（LSF / SSH）

**用助手脚本，不要手写 JSON。** TOTP 那个文件的键必须是 `"用户名@主机:端口"`，写错了 `cluster_exec` 只会回一句"缺少动态口令"，很难查：

```sh
CC="${DSH_HOME:-$HOME/.dsh}/bio-research/bin/cluster-credentials"
"$CC"          # = check：脱敏查看当前配置（主机/端口/用户名、密码是否已设、密钥长度与键名）
"$CC" set      # 交互式写入两个文件，权限 0600，并校验密钥是合法 base32
"$CC" show     # 明文显示（会打印密码与密钥，别把输出贴到别处）
"$CC" clear    # 删除
```

手写的话，两个文件放在 `$DSH_HOME`，**只存本机，绝不提交**：

```jsonc
// $DSH_HOME/dsh-ssh-connections.json
{ "connections": [ { "id": "hzau", "host": "<登录节点>", "port": 22,
                     "username": "<你的账号>", "password": "<密码>" } ] }

// $DSH_HOME/dsh-ssh-totp.json     键为 "user@host:port"
{ "<user>@<host>:22": "<BASE32 密钥>" }
```

> 密钥是 **base32 种子**（认证器里那条 `otpauth://totp/...?secret=XXXX` 的 `secret=` 参数），**不是**当前那 6 位数字。只拿得到 6 位码的话，从二维码或用 `oathtool`/认证器导出里把 secret 取出来。

改完**需要重启 DSH** 才生效。然后在会话里用 `cluster_status` 自查（它同时报告 ssh 客户端、活动会话与密钥是否就绪），再用 `cluster_exec` 跑一条 `hostname` 验证。
集群上的作业规范见预设内的 **ncpgr-lsf** 技能。

> 集群 TOTP 配了 `DISALLOW_REUSE`，同一时间步的码只能验证一次——这正是插件复用**单一持久会话**的原因；`cluster_upload` / `cluster_download` 每次会单独认证、各消耗一个时间步，所以多文件请先打 tar 包。

### Tavotto（论文配图，9 个工具）

引擎是 PyPI 的 `tavotto`，`setup.sh` 默认装进分析 venv。未装时工具列表里只有 `tavotto_health`（降级 server，握手正常、不卡死）。要手动装：

```sh
"${DSH_HOME:-$HOME/.dsh}/bio-research/venv/bin/python3" \
  "$(pwd)/presets/bio-research/tools/tavotto/mcp/server.py" --provision
```

工作区可信根默认是 `os.homedir()`。要改就在**启动 dsh 之前**设：

```sh
export TAVOTTO_MCP_ROOTS="$HOME:$HOME/Documents/figures"   # macOS 上多根用冒号分隔
```

### Zotero（默认禁用）

1. 在 <https://www.zotero.org/settings/keys> 创建 API Key
2. 用该 Key 请求 `https://api.zotero.org/keys/current` 取 User ID
3. 填进 `cordis.patch.yml` 的 `mcp-zotero` 行并删掉 `disabled: true`

### NCBI API Key（可选，提高限速）

在 <https://www.ncbi.nlm.nih.gov/account/settings/> 免费申请，填进 `mcp-ncbi` 行的 `NCBI_API_KEY`，或设置同名环境变量。

> ⚠️ `command` 与 `TAVOTTO_*` 都是**挂载时**读的，已经建好的 standing mount 不会重来。**任何预设改动都要重启 dsh 才生效。**

## 五、目录结构

```
bio-research-preset-macos/
├── cordis.patch.yml      # 预设声明（一行 @deepseek-ai/dsh-agent-preset，内联 composition）
├── package.json          # dsh.bundle.patch 指向上面的 patch；dsh.install 记录待重建依赖
├── lib/index.js          # bundle 入口（空模块，仅满足包约定）
├── setup.sh              # macOS 安装脚本（依赖重建 + venv + profile 清单写入）
├── README.md
└── presets/bio-research/
    ├── preset.yml                    # 预设元数据（id / 名称 / 描述）
    ├── plugins/                      # 随包的本地 DSH 插件（file: 依赖进 profile）
    │   ├── dsh-cluster-ssh/          # 集群执行通道（POSIX askpass + TOTP）
    │   ├── dsh-tool-csv/             # → csv 工具
    │   ├── dsh-tool-stat/            # → stat 工具
    │   └── dsh-sci/                  # → unit_convert / constant_lookup / ode_simulate
    ├── skills/                       # 15 个技能
    │   ├── bio-research-env/         # ★ macOS 环境权威（新增）
    │   ├── bioinformatics/  biostatistics/  variant-analysis/  survival-analysis/
    │   ├── scientific-plotting/  paper-writing/  literature-review/
    │   ├── latex-compile/  document-output/
    │   └── ncpgr-lsf/  ncpgr-software/  ncpgr-data-manage/  ncpgr-bio-router/   # ★ 取自集群官方 /public/home/software/opt/skills/
    └── tools/
        ├── biotools/                 # bach-biotools-server（37 个生信工具，npm）
        ├── ncbi/                     # ncbi-mcp 启动器（PyPI）
        ├── zotero/                   # mcp-zotero（npm，默认禁用）
        └── tavotto/                  # vendor 自 Codex 插件的 Tavotto 0.15.0
```

`node_modules` 与 `askpass/` 是运行/安装产物，**刻意不提交**（`.gitignore` 已覆盖；`askpass/` 内含明文密码与一次性口令）。

## 六、安装后自检

```sh
./setup.sh --check
```

它会报告：node / pnpm / base python / 签名前缀 / 分析 venv 是否就位，venv 与 R 环境里装了哪些包，库校验是否通过，以及 pandoc / LaTeX / brew / ssh 的可用性。

在 DSH 会话里：
- `cluster_status` — 集群连接、活动会话、TOTP 密钥、ssh 客户端
- `mcp__tavotto__tavotto_health` — Tavotto 引擎是否满血（`mode: engine`）还是降级
- `mcp__biotools__search_pubmed` — biotools MCP 是否连通

**预设到底有没有挂上**，最可靠的判据是看它的 composition 有没有 `broken`。GUI 里显示「预设加载失败」时，用下面的办法拿到**逐行诊断**（GUI 只给一句结论，日志里往往什么都没有）：

1. 复制一份 desktop profile 出来（CLI 拒绝直接启动 `desktop`，它由 Electron 独占）：

   ```sh
   DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   cp -R "$DSH_HOME/profiles/desktop" "$DSH_HOME/profiles/dbgcopy"
   # 改掉 package.json 里的 name（dsh-profile-desktop -> dsh-profile-dbgcopy）
   ```

2. 写一个探针插件，调用 `ctx.agentPresets.list()` 与 `compositionInventory()`，把每个预设的
   `broken` 字段和每一行的 `fiberState` 写到文件里；把它作为 `file:` 依赖装进 dbgcopy，
   再往 dbgcopy 的 `cordis.patch.yml` 末尾加一段行（**注意要包在 `insert:` 里，裸行只能覆盖已有条目**）：

   ```yaml
   - insert:
       - id: roster-probe
         name: "roster-probe"
   ```

3. 启动并读结果：

   ```sh
   DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
   "$DSH" dbgcopy --port 19507 --host 127.0.0.1 --no-open
   ```

   探针的输出形如：

   ```
   id=bio-research name="生物科研模式"  BROKEN="tool-csv (dsh-tool-csv): …value schema DSL"
   ===== bio-research broken=undefined =====
     tool-bash-cluster   @deepseek-ai/dsh-tool-bash   ACTIVE
     mcp-biotools        @deepseek-ai/dsh-mcp-client  ACTIVE
   ```

   `broken=undefined` 且各行 `ACTIVE` 就是挂上了。**本版就是靠它定位到 §一 那三处问题的。**

## 七、故障排查

| 症状 | 处置 |
|---|---|
| **GUI 显示「预设加载失败」** | 预设 composition 有 `broken`。按 §六 的探针拿到逐行诊断；最常见的三个原因（`baseUrl` 指错、schema 两套规则、shell 行撞车）见 §一 |
| 预设列表里看不到「生物科研模式」 | 没重启 DSH。`command`/env 只在挂载时读一次 |
| 挂载卡住、停止按钮也没反应 | 典型的 Tavotto `os.execv` 交棒问题。本版已用「指向装有引擎的解释器 + `TAVOTTO_MCP_EXECED=1`」双保险堵住；若仍出现，跑 `./setup.sh --check` 确认 venv 里有 `tavotto` |
| `mcp__biotools__*` 工具全部缺失 | biotools 的 `node_modules` 没装。跑 `./setup.sh`（它会跳过已就绪的） |
| `mcp__ncbi__*` 缺失 | 分析 venv 里没有 `ncbi-mcp` 或 `mcp` 版本 >1。跑 `./setup.sh` |
| `cluster_exec` 报"缺少动态口令" | `$DSH_HOME/dsh-ssh-totp.json` 没有对应 `user@host:port` 的 base32 密钥 |
| `cluster_exec` 报"SSH 会话已关闭" | 主机/端口/密码不对，或集群侧拒绝。先用 `cluster_status` 确认连接配置 |
| 图表里中文是方框 | 用了 Windows 字体名。见 `scientific-plotting` 技能 |
| `Rscript: command not found` | R 不在 PATH 上。先 `. $DSH_HOME/bio-research/env.sh`，或用绝对路径 `$DSH_HOME/bio-research/r-env/bin/Rscript`，见 §三 |
| `pandoc: command not found` | 同上，`$DSH_HOME/bio-research/r-env/bin/pandoc` |
| `xelatex: command not found` | 同上，`~/Library/TinyTeX/bin/universal-darwin/xelatex` |
| 中文编译报 `File 'ctexart.cls' not found` | 少了 ctex。`"$HOME/Library/TinyTeX/bin/universal-darwin/tlmgr" install ctex xecjk`（**不需要 sudo**） |
| 装 R 包时 `library 'gfortran' not found` | `~/.R/Makevars` 被删或 `FLIBS` 失效。重跑 `./setup.sh --with-r` 会重建 |
| 装 R 包时 `unsupported option '-fopenmp'` | 同上，`SHLIB_OPENMP_*` 必须清空 |
| `python3` 找不到 / 是 3.9 | 系统 `/usr/bin/python3` 是 Xcode CLT 带的 3.9，**不是**本项目用的解释器。用分析 venv，见 `bio-research-env` 技能 |
| 预设挂上了，但 MCP 工具与技能**一个都没有**，日志里也没有报错 | 典型的 `baseUrl` 指错（见 §一）。本版已修；若自行改过行内路径，跑 `./setup.sh --check` 并检查 `--dump-config` 里的路径 |
| `import scipy` / `import pydantic_core` 报 `different Team IDs` | macOS 库校验拦下了 pip 的扩展。跑 `./setup.sh --check` 看「库校验」一行，按 §一 用 `BIO_PRESET_BASE_PYTHON` 或让 setup.sh 重建签名前缀 |
| 某个插件整组不激活 / 日志出现 `not supported by the value schema DSL` 或 `additionalProperties must be explicitly true or false` | 工具 schema 没同时满足两套规则（见 §一）。四个插件的 `toToolDefinition` 已统一编译，不要绕过它直接 `ctx.tools.register({...})` |

## 八、许可

MIT（与原仓库一致）。第三方技能与工具的版权归各自作者所有：

- **Tavotto** — AGPL-3.0-only，见 `presets/bio-research/tools/tavotto/LICENSE`
- `bach-biotools-server`、`mcp-zotero`、`ncbi-mcp` — 各自 npm / PyPI 包许可
