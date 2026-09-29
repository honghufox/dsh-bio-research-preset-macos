#!/usr/bin/env bash
#
# 生物科研模式（含 LSF 集群执行）预设 —— **macOS 安装脚本**（setup.ps1 的对应物）。
#
# 做四件事：
#   1) 重建随 bundle 分发但未提交的 Node 依赖（biotools / zotero 两个 MCP server）；
#   2) 在 $DSH_HOME/bio-research/venv 建分析用 Python 环境（ncbi-mcp / tavotto 引擎，
#      可选完整科学计算栈）；
#   3) 把 bundle 挂进 desktop profile 的 local-bundles，并写进 profile 清单
#      （dependencies + dsh.profile.bundles，四个本地插件用 file: 依赖）；
#   4) 在 profile 里跑 pnpm install，让预设与插件真正可解析。
#
# 用法：
#   ./setup.sh                     # 完整安装（推荐）
#   ./setup.sh --with-science      # 额外装 scipy/statsmodels/seaborn/matplotlib/lifelines/biopython/vcfpy
#   ./setup.sh --with-r            # 额外装 R 4.5 + 生存分析/变异/组学/绘图常用包（micromamba，免 sudo）
#   ./setup.sh --with-writing      # 额外装 pandoc + TinyTeX（xelatex/latexmk/tlmgr + ctex，中文可编译）
#   ./setup.sh --with-science --with-r --with-writing   # 全都要（推荐）
#   ./setup.sh --minimal           # 只装 ncbi-mcp + mcp SDK，跳过 tavotto 引擎与科学栈
#   ./setup.sh --copy              # 把 bundle 复制进 local-bundles（默认用符号链接）
#   ./setup.sh --profile <目录>    # 指定 profile 目录（默认 $DSH_HOME/profiles/$DSH_PROFILE）
#   ./setup.sh --no-profile        # 只装依赖，不改 profile 清单
#   ./setup.sh --check             # 只做环境自检并打印报告，不做任何改动
#
# macOS 上没有系统 node / npm；/usr/bin/python3 虽有（Xcode CLT 带的 3.9）但不是本项目
# 要用的解释器。本脚本一律使用 **DSH 桌面版自带的运行时**：node + pnpm 装 Node 依赖，
# 自带 Python 建分析 venv。R 走 micromamba（不需要 sudo / Homebrew）。

set -euo pipefail

BUNDLE_NAME='bio-research-preset'
BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="${DSH_HOME}/profiles/${DSH_PROFILE:-desktop}"
VENV_DIR="${DSH_HOME}/bio-research/venv"
# 重签名后的解释器前缀（见第 2 步的长注释：macOS 库校验要求这样做才能加载 pip 的扩展）。
PREFIX_DIR="${DSH_HOME}/bio-research/python"
# R 环境（micromamba 建，见 --with-r）。
R_ENV_DIR="${DSH_HOME}/bio-research/r-env"
MAMBA_BIN="${DSH_HOME}/bio-research/bin/micromamba"
# TinyTeX：用户级安装，落在 ~/Library 下，不需要 sudo。
TEX_DIR="${HOME}/Library/TinyTeX"
TEX_BIN="${TEX_DIR}/bin/universal-darwin"
PLUGIN_REL='presets/bio-research/plugins'
PLUGINS=(dsh-cluster-ssh dsh-tool-csv dsh-tool-stat dsh-sci)

WITH_SCIENCE=0
WITH_R=0
WITH_WRITING=0
COPY_BUNDLE=0
MINIMAL=0
PATCH_PROFILE=1
CHECK_ONLY=0

# ── 输出 ────────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_OFF=''; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '%s✘%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }
step() { printf '\n%s── %s ──%s\n' "$C_DIM" "$*" "$C_OFF"; }

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# ── 参数 ────────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --with-science) WITH_SCIENCE=1 ;;
    --with-r)       WITH_R=1 ;;
    --with-writing) WITH_WRITING=1 ;;
    --minimal)      MINIMAL=1 ;;
    --copy)         COPY_BUNDLE=1 ;;
    --no-profile)   PATCH_PROFILE=0 ;;
    --check)        CHECK_ONLY=1 ;;
    --profile)      shift; [ $# -gt 0 ] || die '--profile 需要一个目录参数'; PROFILE_DIR="$1" ;;
    --profile=*)    PROFILE_DIR="${1#*=}" ;;
    -h|--help)      usage ;;
    *)              die "未知参数：$1（用 --help 看用法）" ;;
  esac
  shift
done

# ── 运行时定位 ──────────────────────────────────────────────────────────────────
# 一律优先 DSH 自带运行时：macOS 上系统没有 node，/usr/bin/python3 是 Xcode 占位符。
find_node() {
  local c
  for c in "${DSH_NODE:-}" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  for c in "$DSH_HOME"/dsh-runtimes/*/dependencies/node/bin/node; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  c="$(command -v node 2>/dev/null || true)"
  [ -n "$c" ] && { printf '%s' "$c"; return 0; }
  return 1
}

find_pnpm() {
  local c
  for c in "$DSH_HOME"/dsh-runtimes/*/dependencies/pnpm/bin/pnpm.mjs \
           "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.mjs"; do
    [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# 只用 DSH 自带 Python：它一定有 numpy/pandas/docx 等，且绝不是 Xcode 占位符。
find_base_python() {
  local c
  for c in "${BIO_PRESET_BASE_PYTHON:-}" "$DSH_HOME"/dsh-runtimes/*/dependencies/python/bin/python3; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

NODE="$(find_node || true)"
PNPM="$(find_pnpm || true)"
BASE_PYTHON="$(find_base_python || true)"

# ── --check：只报告，不改动 ─────────────────────────────────────────────────────
if [ "$CHECK_ONLY" = 1 ]; then
  step '环境自检'
  say "bundle 目录 : $BUNDLE_DIR"
  say "DSH_HOME    : $DSH_HOME"
  say "profile     : $PROFILE_DIR"
  say "分析 venv   : $VENV_DIR"
  say ''
  [ -n "$NODE" ]       && ok "node        : $NODE ($("$NODE" -v 2>/dev/null))" || warn 'node        : 未找到 —— 需要 DSH 桌面版至少启动过一次'
  [ -n "$PNPM" ]       && ok "pnpm        : $PNPM"                          || warn 'pnpm        : 未找到'
  [ -n "$BASE_PYTHON" ]&& ok "base python : $BASE_PYTHON ($("$BASE_PYTHON" -V 2>&1))" || warn 'base python : 未找到'
  if [ -x "$PREFIX_DIR/bin/python3" ]; then
    ok "签名前缀    : $PREFIX_DIR/bin/python3"
    # 关键：确认它真的拿到了 disable-library-validation，否则 pip 的扩展一律加载不了。
    if codesign -d --entitlements - "$PREFIX_DIR/bin/python3" 2>&1 | grep -q 'disable-library-validation'; then
      ok '  └ 授权     : disable-library-validation 已就位'
    else
      warn '  └ 授权     : 缺少 disable-library-validation —— pip 装的原生扩展会加载失败'
    fi
  else
    say "  ${C_DIM}签名前缀    : 未创建（跑 ./setup.sh；或设 BIO_PRESET_BASE_PYTHON 用外部 Python）${C_OFF}"
  fi
  [ -x "$VENV_DIR/bin/python3" ] && ok "venv python : $VENV_DIR/bin/python3" || warn "venv python : 未创建（跑 ./setup.sh）"
  [ -f "$PROFILE_DIR/package.json" ] && ok "profile 清单: $PROFILE_DIR/package.json" || warn "profile 清单: 不存在"
  say ''
  if [ -x "$VENV_DIR/bin/python3" ]; then
    # 决定性探针：真的 dlopen 一个 pip 装回来的扩展（pydantic_core 是 mcp SDK 的硬依赖）。
    if "$VENV_DIR/bin/python3" -c 'import pydantic_core' >/dev/null 2>&1; then
      ok '库校验      : 可以加载 pip 装回来的原生扩展'
    else
      warn '库校验      : 无法加载 pip 装回来的原生扩展 —— MCP（ncbi）与科学栈都会在运行时失败'
      warn '              处置见 README 的「macOS 库校验」一节'
    fi
    for m in numpy pandas scipy statsmodels seaborn matplotlib lifelines Bio vcfpy ncbi_mcp tavotto mcp; do
      if "$VENV_DIR/bin/python3" -c "import $m" >/dev/null 2>&1; then ok "  py:$m"; else say "  ${C_DIM}py:$m (缺)${C_OFF}"; fi
    done
  fi
  say ''
  if [ -x "$R_ENV_DIR/bin/Rscript" ]; then
    ok "R           : $("$R_ENV_DIR/bin/Rscript" -e 'cat(R.version.string)' 2>/dev/null)"
    miss="$("$R_ENV_DIR/bin/Rscript" -e '
      p <- c("survival","survminer","timeROC","survivalROC","rms","cmprsk","forestplot","ggplot2",
             "ggseqlogo","VennDiagram","vcfR","biomaRt","DESeq2","edgeR","BiocManager")
      cat(paste(p[!vapply(p, requireNamespace, logical(1), quietly=TRUE)], collapse=" "))' 2>/dev/null)"
    if [ -z "$miss" ]; then ok '  └ R 包      : 全部就绪'
    else warn "  └ R 包      : 缺 ${miss}"; fi
    [ -f "$HOME/.R/Makevars" ] && ok '  └ Makevars  : 已配置（编译 R 包用）' || say "  ${C_DIM}  └ Makevars  : 未配置${C_OFF}"
  else
    say "  ${C_DIM}R           : 未安装（跑 ./setup.sh --with-r）${C_OFF}"
  fi
  say ''
  if [ -x "$R_ENV_DIR/bin/pandoc" ]; then
    ok "pandoc      : $("$R_ENV_DIR/bin/pandoc" --version 2>/dev/null | head -1)"
  else
    say "  ${C_DIM}pandoc      : 未装（跑 ./setup.sh --with-writing）${C_OFF}"
  fi
  if [ -x "$TEX_BIN/xelatex" ]; then
    ok "LaTeX       : $("$TEX_BIN/xelatex" --version 2>/dev/null | head -1)"
    ok "  └ 目录     : $TEX_BIN"
    if [ -f "$TEX_DIR/texmf-dist/tex/latex/ctex/ctexart.cls" ] || \
       ls "$TEX_DIR"/texmf-dist/tex/latex/ctex/*.cls >/dev/null 2>&1; then
      ok '  └ 中文支持 : ctex 已装'
    else
      warn '  └ 中文支持 : 缺 ctex（tlmgr install ctex xecjk）'
    fi
  else
    say "  ${C_DIM}LaTeX       : 未装（跑 ./setup.sh --with-writing）${C_OFF}"
  fi
  if [ -f "$DSH_HOME/bio-research/env.sh" ]; then
    ok "env.sh      : $DSH_HOME/bio-research/env.sh（source 后可用裸命令）"
  fi
  say ''
  for t in brew ssh scp; do
    c="$(command -v "$t" 2>/dev/null || true)"
    [ -n "$c" ] && ok "  $t -> $c" || say "  ${C_DIM}$t (缺)${C_OFF}"
  done
  exit 0
fi

step '安装信息'
say "bundle  : $BUNDLE_DIR"
say "DSH_HOME: $DSH_HOME"
say "profile : $PROFILE_DIR"
[ -n "$NODE" ] || die '找不到 node。macOS 上系统没有 node，本脚本依赖 DSH 桌面版自带的运行时——请先启动一次 DSH 桌面版再重跑。'
say "node    : $NODE ($("$NODE" -v 2>/dev/null))"

# ── 1) Node 依赖 ────────────────────────────────────────────────────────────────
step '1/4 重建 Node 依赖（biotools / zotero MCP server）'
[ -n "$PNPM" ] || die '找不到 pnpm（DSH 自带运行时里应有 pnpm/bin/pnpm.mjs）。请先启动一次 DSH 桌面版。'

install_node_deps() {
  local rel="$1" dir="$BUNDLE_DIR/$1"
  if [ ! -f "$dir/package.json" ]; then warn "跳过（无 package.json）：$rel"; return 0; fi
  if [ -d "$dir/node_modules" ]; then ok "已就绪  : $rel"; return 0; fi
  say "安装中  : $rel"
  # --ignore-workspace：这些目录物理上位于 profile 工作区内，不加这个会被 pnpm 当成
  # 工作区成员而报错。--prod：跳过 devDependencies。
  # strict-dep-builds=false：pnpm 11 默认把「被忽略的依赖构建脚本」当失败
  # （ERR_PNPM_IGNORED_BUILDS）；被跳过的都是 core-js-pure 之类的资助提示脚本，
  # 跳过无害，所以降级成警告而不是让整步失败。
  if ( cd "$dir" && "$NODE" "$PNPM" install --prod --ignore-workspace --config.strict-dep-builds=false ); then
    ok "完成    : $rel"
  else
    warn "失败    : ${rel}（网络或 registry 问题；可稍后在该目录手动重跑）"
  fi
}

install_node_deps 'presets/bio-research/tools/biotools'
install_node_deps 'presets/bio-research/tools/zotero'

# ── 2) Python 分析环境 ──────────────────────────────────────────────────────────
step '2/4 分析用 Python 环境'

# ⚠ macOS 的库校验是这一步的核心难点。
#
# DSH 自带 Python 是**加固运行时 + 团队签名**的（codesign 显示 flags=0x10000(runtime)、
# TeamIdentifier=NAN929V4UM），且没有 disable-library-validation 授权。macOS 的库校验
# 因此只允许它加载**同一个 Team ID 签名**的扩展——DSH 随包发的 numpy / pandas / lxml
# 正是这样签的，所以它们能用；而 `pip install` 装回来的 wheel 里的 .so 是
# `adhoc, linker-signed`、TeamIdentifier 未设置，`dlopen` 一律被拒：
#
#   ImportError: dlopen(.../_pydantic_core.cpython-312-darwin.so ...)
#     ... (non-platform) have different Team IDs
#
# 后果不是"某个包不好用"，而是**整条 MCP 链断掉**：pydantic_core → pydantic → mcp SDK
# → ncbi MCP 起不来；同理 scipy / scikit-learn 这些带扩展的科学栈也全都装不起来。
#
# 解法：把该解释器**复制一份**，用 `com.apple.security.cs.disable-library-validation`
# 重新做 adhoc 签名，再用这份副本建 venv。副本只写在自己家目录（$DSH_HOME/bio-research/），
# 不碰 DSH 安装目录，也不改系统任何东西。
#
# 不想重签名（或本机已有未被加固的 Python）就设 BIO_PRESET_BASE_PYTHON 指过去，
# 例如：BIO_PRESET_BASE_PYTHON=/opt/homebrew/bin/python3 ./setup.sh --with-science
build_signed_prefix() {
  local rt_bin rt_root pyver stamp
  rt_bin="$BASE_PYTHON"
  rt_root="$(cd "$(dirname "$rt_bin")/.." && pwd -P)"
  pyver="$("$rt_bin" -c 'import sys; print("python%d.%d" % sys.version_info[:2])')"
  stamp="${rt_root}|$("$rt_bin" -c 'import sys; print(sys.version)')"

  if [ -x "$PREFIX_DIR/bin/python3" ] && [ -f "$PREFIX_DIR/.source" ] && [ "$(cat "$PREFIX_DIR/.source")" = "$stamp" ]; then
    ok "已就绪  : ${PREFIX_DIR}（重签名副本）"
  else
    say "重建中  : ${PREFIX_DIR}（重新签名，以便加载 pip 装回来的扩展）"
    rm -rf "$PREFIX_DIR"
    mkdir -p "$PREFIX_DIR/bin"
    # 真实二进制（bin/python3 只是指向它的符号链接）；stdlib 与随包 site-packages 走符号链接，
    # 这样 DSH 升级运行时后这里自动跟随，也不会被我们写脏。
    cp "$rt_root/bin/$pyver" "$PREFIX_DIR/bin/$pyver" || return 1
    ln -sfn "$pyver" "$PREFIX_DIR/bin/python3"
    ln -sfn "$rt_root/lib" "$PREFIX_DIR/lib"
    cat > "$PREFIX_DIR/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
PLIST
    if codesign --force --sign - --entitlements "$PREFIX_DIR/entitlements.plist" --options runtime "$PREFIX_DIR/bin/$pyver" >/dev/null 2>&1; then
      ok "已签名  : $PREFIX_DIR/bin/$pyver"
    else
      warn '重新签名失败；pip 装的带扩展的包可能无法加载'
    fi
    printf '%s' "$stamp" > "$PREFIX_DIR/.source"
  fi
  # 通过全局变量返回路径，**不要** printf——本函数的进度信息走 stdout，
  # 若用 $(...) 捕获返回值，那些 ✔/! 行会一起被捕获进去。
  ANALYSIS_PYTHON="$PREFIX_DIR/bin/python3"
}

resolve_analysis_python() {
  ANALYSIS_PYTHON=''
  if [ -n "${BIO_PRESET_BASE_PYTHON:-}" ]; then
    if [ -x "${BIO_PRESET_BASE_PYTHON}" ]; then
      ANALYSIS_PYTHON="${BIO_PRESET_BASE_PYTHON}"
      return 0
    fi
    warn "BIO_PRESET_BASE_PYTHON 不可执行，忽略：${BIO_PRESET_BASE_PYTHON}"
  fi
  [ -n "$BASE_PYTHON" ] || return 1
  build_signed_prefix
}

ANALYSIS_PYTHON=''
resolve_analysis_python || true

if [ -z "$ANALYSIS_PYTHON" ] || [ ! -x "$ANALYSIS_PYTHON" ]; then
  warn '找不到可用的 Python，跳过 venv 创建。'
  warn '（ncbi / tavotto 两个 MCP 会回落到 DSH 自带 Python，但那里装不了带扩展的包。）'
else
  say "base    : $ANALYSIS_PYTHON"
  "$ANALYSIS_PYTHON" -V 2>&1 | sed 's/^/          /'
  if [ -x "$VENV_DIR/bin/python3" ]; then
    ok "已存在  : $VENV_DIR"
  else
    say "创建中  : $VENV_DIR"
    # --system-site-packages：继承 DSH 自带 Python 的 numpy/pandas/python-docx 等，
    # 省下一次几百 MB 的重复下载；venv 里 pip 装的包会覆盖同名的系统包。
    mkdir -p "$(dirname "$VENV_DIR")"
    "$ANALYSIS_PYTHON" -m venv --system-site-packages "$VENV_DIR" || die "创建 venv 失败：$VENV_DIR"
    ok "已创建  : $VENV_DIR"
  fi

  VPY="$VENV_DIR/bin/python3"
  "$VPY" -m pip install --quiet --upgrade pip setuptools wheel >/dev/null 2>&1 || warn 'pip 自升级失败（继续）'

  pip_install() {
    local label="$1"; shift
    say "pip     : $label"
    if "$VPY" -m pip install --quiet --upgrade "$@" >/dev/null 2>&1; then
      ok "装好    : $label"
    else
      warn "装失败  : ${label}（可手动重跑：\"$VPY\" -m pip install $*）"
      return 1
    fi
  }

  # ncbi-mcp 依赖 mcp SDK 1.x（2.0 移除了它用的 FastMCP API），必须钉住上界。
  pip_install 'ncbi-mcp + mcp 1.x' 'ncbi-mcp' 'mcp>=1.0,<2' || true

  if [ "$MINIMAL" = 1 ]; then
    say '（--minimal：跳过 tavotto 引擎与科学计算栈）'
  else
    pip_install 'tavotto 引擎（配图 MCP 的后端）' 'tavotto[worker]' || true
  fi

  if [ "$WITH_SCIENCE" = 1 ]; then
    pip_install '科学计算栈' scipy statsmodels seaborn scikit-learn matplotlib lifelines biopython vcfpy || true
  else
    say "（未装科学计算栈；需要时重跑：./setup.sh --with-science）"
  fi

  # 决定性自检：真的去 dlopen 一个 pip 装回来的扩展。
  # 这一步失败就说明库校验没过，MCP 与科学栈都会在运行时才炸——宁可现在就说清楚。
  if "$VPY" -c 'import pydantic_core' >/dev/null 2>&1; then
    ok '库校验自检: 可以加载 pip 装回来的原生扩展'
  else
    warn '库校验自检失败：该解释器无法加载 pip 装回来的原生扩展。'
    warn "  这通常意味着重签名没生效。可改用未被加固的 Python 重装："
    warn "  rm -rf \"$VENV_DIR\" && BIO_PRESET_BASE_PYTHON=/opt/homebrew/bin/python3 ./setup.sh --with-science"
  fi
fi

# ── 2b) R 环境（--with-r）────────────────────────────────────────────────────────
# 为什么不用 Homebrew：`brew install r` 需要先有 Homebrew，而装 Homebrew 要 sudo 建
# /opt/homebrew——本脚本要能在无交互、无 sudo 的情况下跑完。micromamba 是静态二进制，
# 落到用户自己目录即可，conda-forge / bioconda 上有 R 4.5 与全部 Bioconductor 包的
# **预编译**版本（比从源码编译快几个数量级）。
#
# 镜像：conda.anaconda.org 实测约 0.8 MB/s，清华 TUNA 约 6.6 MB/s，所以统一走 TUNA。
install_r_env() {
  step '2b 分析用 R 环境（--with-r）'

  local arch mamba_url tmp
  arch="$(uname -m)"
  case "$arch" in
    arm64) arch='osx-arm64' ;;
    x86_64) arch='osx-64' ;;
    *) warn "不支持的架构：${arch}，跳过 R 安装"; return 0 ;;
  esac

  # 1) micromamba（优先 TUNA 的 conda-forge 镜像，失败再回官方 API）
  if [ ! -x "$MAMBA_BIN" ]; then
    mkdir -p "$(dirname "$MAMBA_BIN")"
    tmp="$(mktemp -d)"
    say "下载    : micromamba (${arch})"
    for mamba_url in \
      "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/${arch}/micromamba-2.9.0-0.tar.bz2" \
      "https://micro.mamba.pm/api/micromamba/${arch}/latest"; do
      if curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp/mm.tar.bz2" "$mamba_url" \
         && tar xjf "$tmp/mm.tar.bz2" -C "$tmp" bin/micromamba 2>/dev/null; then
        mv "$tmp/bin/micromamba" "$MAMBA_BIN"; chmod +x "$MAMBA_BIN"; break
      fi
      warn "  取源失败，换下一个：${mamba_url}"
    done
    rm -rf "$tmp"
    [ -x "$MAMBA_BIN" ] && ok "已安装  : ${MAMBA_BIN}" || { warn 'micromamba 安装失败，跳过 R'; return 0; }
  else
    ok "已就绪  : ${MAMBA_BIN}"
  fi

  # 2) 镜像配置（只在不存在时写，不覆盖用户已有配置）
  if [ ! -f "$HOME/.mambarc" ]; then
    cat > "$HOME/.mambarc" <<'MAMBARC'
channel_alias: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud
channels:
  - conda-forge
  - bioconda
show_channel_urls: true
MAMBARC
    ok "已写入  : ~/.mambarc（TUNA 镜像）"
  fi

  # 3) 建 R 环境
  export MAMBA_ROOT_PREFIX="${DSH_HOME}/bio-research/mamba"
  mkdir -p "$MAMBA_ROOT_PREFIX"
  if [ -x "$R_ENV_DIR/bin/Rscript" ]; then
    ok "已就绪  : ${R_ENV_DIR}"
  else
    say "创建中  : ${R_ENV_DIR}（R + 生存分析/变异/组学/绘图包，约 550MB）"
    if "$MAMBA_BIN" create -y -p "$R_ENV_DIR" -c conda-forge -c bioconda --strict-channel-priority \
        'r-base>=4.3' \
        r-survival r-survminer r-rms r-cmprsk r-forestplot \
        r-ggplot2 r-ggseqlogo r-venn* r-vcfr \
        r-data.table r-dplyr r-tidyr r-readr r-jsonlite r-optparse r-biocmanager \
        bioconductor-biomart bioconductor-deseq2 bioconductor-edger \
        c-compiler cxx-compiler gfortran >/dev/null 2>&1; then
      ok "已创建  : ${R_ENV_DIR}"
    else
      warn 'R 环境创建失败（网络或求解问题）；可手动重跑：'
      warn "  MAMBA_ROOT_PREFIX=\"$MAMBA_ROOT_PREFIX\" \"$MAMBA_BIN\" create -y -p \"$R_ENV_DIR\" -c conda-forge -c bioconda 'r-base>=4.3' r-survival r-survminer"
      return 0
    fi
  fi

  # 4) 编译配置：conda 的 R 有两处默认值在裸环境下必然失败，见注释。
  local gfort_dir sdk
  gfort_dir="$(ls -d "$R_ENV_DIR"/lib/gcc/*/* 2>/dev/null | tail -1)"
  sdk="$(xcrun --show-sdk-path 2>/dev/null || true)"
  mkdir -p "$HOME/.R"
  if [ ! -f "$HOME/.R/Makevars" ] || ! grep -q 'bio-research-preset-macos' "$HOME/.R/Makevars" 2>/dev/null; then
    cat > "$HOME/.R/Makevars" <<MAKEVARS
# 由 bio-research-preset-macos 的 setup.sh 生成。
#
# 1) FLIBS：conda 的 Makeconf 把它钉在 lib/gcc/<triple>/14.3.0，而实际装的 gfortran
#    版本目录不同，链接期会报 "library 'gfortran' not found"。
# 2) SHLIB_OPENMP_*：Apple clang 不认 -fopenmp；mets / riskRegression 这类包虽带该
#    flag，但自身已设 -DARMA_DONT_USE_OPENMP，并不真的需要 OpenMP。
FLIBS = ${gfort_dir:+-L$gfort_dir} -L$R_ENV_DIR/lib -lgfortran -lquadmath -lm
SHLIB_OPENMP_CFLAGS   =
SHLIB_OPENMP_CXXFLAGS =
SHLIB_OPENMP_FFLAGS   =
MAKEVARS
    ok "已写入  : ~/.R/Makevars（编译配置）"
  else
    ok "已存在  : ~/.R/Makevars（保留用户配置）"
  fi
  [ -n "$sdk" ] || warn 'xcrun 取不到 macOS SDK，编译 R 包时可能失败'

  # 5) 补几个 conda 上没有、只能从 CRAN 编的包
  local rbin="$R_ENV_DIR/bin/Rscript"
  say "补装    : timeROC / survivalROC（conda 无可用构建，从 CRAN 编译）"
  if "$MAMBA_BIN" run -p "$R_ENV_DIR" Rscript -e \
      'options(repos=c(CRAN="https://mirrors.tuna.tsinghua.edu.cn/CRAN/"), Ncpus=4); install.packages(c("survivalROC","timeROC"))' >/dev/null 2>&1; then
    ok '补装完成'
  else
    warn 'timeROC / survivalROC 编译失败；survivalROC 通常仍可用，timeROC 缺失时用 survivalROC 代替'
  fi

  # 6) 自检
  if "$rbin" -e 'quit(status=0)' >/dev/null 2>&1; then
    say "R       : $("$rbin" -e 'cat(R.version.string)' 2>/dev/null)"
    local miss
    miss="$("$rbin" -e '
      p <- c("survival","survminer","timeROC","survivalROC","rms","cmprsk","forestplot","ggplot2",
             "ggseqlogo","VennDiagram","vcfR","biomaRt","DESeq2","edgeR","BiocManager")
      cat(paste(p[!vapply(p, requireNamespace, logical(1), quietly=TRUE)], collapse=" "))' 2>/dev/null)"
    if [ -z "$miss" ]; then ok 'R 包自检: 全部就绪'; else warn "R 包自检: 缺 ${miss}"; fi
  else
    warn 'R 环境自检失败'
  fi
}

if [ "$WITH_R" = 1 ]; then
  install_r_env
else
  say ''
  say "（未装 R；需要时重跑：./setup.sh --with-r）"
fi

# ── 2c) 写作工具链（--with-writing）─────────────────────────────────────────────
# pandoc 走 micromamba（conda-forge 有预编译包）。LaTeX 走 **TinyTeX**：
#   · conda-forge 的 texlive-core **不含 xelatex**（中文必须用它），且没有 tlpkg，
#     tlmgr 管不了那套安装，装不了 ctex/xeCJK；
#   · TeX Live 官方 install-tl 支持完全的用户级安装（TEXDIR 设在 ~/Library 下，
#     不需要 sudo），配合清华 CTAN 镜像在国内速度很好。
# 两条路都不碰 GitHub（raw.githubusercontent.com 在国内通常不通）。
install_writing_env() {
  step '2c 写作工具链（--with-writing）'

  # 1) pandoc —— 从 conda-forge 拿预编译包，扔进 r-env（R Markdown 也需要它）
  if [ -x "$R_ENV_DIR/bin/pandoc" ]; then
    ok "pandoc 已就绪: $R_ENV_DIR/bin/pandoc"
  elif [ -x "$MAMBA_BIN" ]; then
    say "安装中  : pandoc"
    if "$MAMBA_BIN" install -y -p "$R_ENV_DIR" -c conda-forge --strict-channel-priority pandoc >/dev/null 2>&1; then
      ok "pandoc 已装: $("$R_ENV_DIR/bin/pandoc" --version 2>/dev/null | head -1)"
    else
      warn 'pandoc 安装失败；可手动重跑：'
      warn "  \"$MAMBA_BIN\" install -y -p \"$R_ENV_DIR\" -c conda-forge pandoc"
    fi
  else
    warn '没有 micromamba（先跑 ./setup.sh --with-r），跳过 pandoc'
  fi

  # 2) TinyTeX（含 xelatex / latexmk / tlmgr）
  if [ -x "$TEX_BIN/xelatex" ]; then
    ok "TinyTeX 已就绪: $TEX_BIN"
  else
    local tmp profile
    tmp="$(mktemp -d)"
    say "下载    : TeX Live 安装器（清华 CTAN 镜像）"
    if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp/install-tl-unx.tar.gz" \
        "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet/install-tl-unx.tar.gz"; then
      warn '安装器下载失败；跳过 LaTeX'
      rm -rf "$tmp"; return 0
    fi
    tar xzf "$tmp/install-tl-unx.tar.gz" -C "$tmp" || { warn '解压失败'; rm -rf "$tmp"; return 0; }
    profile="$tmp/tl.profile"
    cat > "$profile" <<PROFILE
selected_scheme scheme-small
TEXDIR $TEX_DIR
TEXMFLOCAL $TEX_DIR/texmf-local
TEXMFSYSCONFIG $TEX_DIR/texmf-config
TEXMFSYSVAR $TEX_DIR/texmf-var
TEXMFHOME ~/Library/texmf
TEXMFCONFIG ~/Library/texmf-config
TEXMFVAR ~/Library/texmf-var
instopt_adjustpath 0
instopt_adjustrepo 0
instopt_letter 0
instopt_portable 0
instopt_write18_restricted 1
tlpdbopt_autobackup 0
tlpdbopt_install_docfiles 0
tlpdbopt_install_srcfiles 0
PROFILE
    say "安装中  : TinyTeX -> $TEX_DIR（scheme-small，约 200MB）"
    if ( cd "$tmp" && ./install-tl-*/install-tl -profile "$profile" \
           -repository https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet >/dev/null 2>&1 ); then
      ok "TinyTeX 已装"
    else
      warn 'TinyTeX 安装失败；可手动重跑 install-tl'
      rm -rf "$tmp"; return 0
    fi
    rm -rf "$tmp"
  fi

  # 3) 中文支持：仓库指向 TUNA，注意**不需要 sudo**
  if [ -x "$TEX_BIN/tlmgr" ]; then
    say '配置    : tlmgr 仓库 + 中文字体/宏包'
    TEXMFCONFIG="$TEX_DIR/texmf-config" TEXMFVAR="$TEX_DIR/texmf-var" \
      "$TEX_BIN/tlmgr" option repository \
      https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet >/dev/null 2>&1 || true
    if TEXMFCONFIG="$TEX_DIR/texmf-config" TEXMFVAR="$TEX_DIR/texmf-var" \
         "$TEX_BIN/tlmgr" install ctex xecjk zhnumber collection-fontsrecommended biber biblatex >/dev/null 2>&1; then
      ok '中文宏包已装（ctex / xeCJK / fontsrecommended / biber）'
    else
      warn '部分宏包安装失败；可手动重跑：'
      warn "  \"$TEX_BIN/tlmgr\" install ctex xecjk collection-fontsrecommended"
    fi
    # 4) 实测一次中文编译，别只看"装完了"
    local t
    t="$(mktemp -d)"
    printf '\\documentclass[UTF8]{ctexart}\n\\begin{document}\n中文编译自检。\n\\end{document}\n' > "$t/t.tex"
    if ( cd "$t" && PATH="$TEX_BIN:$PATH" TEXMFCONFIG="$TEX_DIR/texmf-config" TEXMFVAR="$TEX_DIR/texmf-var" \
           xelatex -interaction=nonstopmode t.tex >/dev/null 2>&1 ) && [ -f "$t/t.pdf" ]; then
      ok '中文编译自检: 通过（xelatex + ctexart 出 PDF）'
    else
      warn '中文编译自检失败；多半是 ctex/xeCJK 没装上，看上面那条'
    fi
    rm -rf "$t"
  fi
}

if [ "$WITH_WRITING" = 1 ]; then
  install_writing_env
else
  say ''
  say "（未装 pandoc / LaTeX；需要时重跑：./setup.sh --with-writing）"
fi

# 安装集群凭据助手：查看 / 写入 $DSH_HOME 下那两个配置文件。
# 手写这两个 JSON 很容易把 TOTP 的键格式（必须 "用户名@主机:端口"）弄错，
# 而错了以后 cluster_exec 只会回一句"缺少动态口令"，不好排查。
install_cluster_helper() {
  local src="$BUNDLE_DIR/presets/bio-research/tools/cluster/cluster-credentials"
  local dst="$DSH_HOME/bio-research/bin/cluster-credentials"
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"; chmod 755 "$dst"
  ok "已安装  : $dst（check / set / show / clear）"
}
install_cluster_helper

# 生成 env.sh：把不在 PATH 上的工具（R / pandoc / TeX）一次性前置进去，
# 这样技能与用户都可以用裸命令名。只写实际存在的路径。
write_env_sh() {
  local bin="$DSH_HOME/bio-research/env.sh" parts=''
  [ -x "$R_ENV_DIR/bin/Rscript" ] && parts="$R_ENV_DIR/bin"
  [ -x "$TEX_BIN/xelatex" ] && parts="${parts:+$parts:}$TEX_BIN"
  [ -n "$parts" ] || return 0
  cat > "$bin" <<ENVSH
# 生物科研模式用的工具链 PATH —— 由 bio-research-preset-macos 的 setup.sh 生成。
#
# 这些工具都不在 macOS 默认 PATH 上（默认 PATH 里没有可写目录，装不进去），
# 所以在脚本里用绝对路径，或者先 source 这个文件：
#
#   . "\${DSH_HOME:-\$HOME/.dsh}/bio-research/env.sh"
#   Rscript analysis.R
#   pandoc paper.md -o paper.docx
#   xelatex main.tex
#
export PATH="$parts:\$PATH"
ENVSH
  ok "已生成  : $bin"
}
write_env_sh

# ── 3) 写 profile 清单 ──────────────────────────────────────────────────────────
step '3/4 写入 profile 清单'
if [ "$PATCH_PROFILE" = 0 ]; then
  say '（--no-profile：跳过）'
else
  MANIFEST="$PROFILE_DIR/package.json"
  [ -f "$MANIFEST" ] || die "找不到 profile 清单：${MANIFEST}（DSH 桌面版至少启动过一次才会有；或用 --profile 指定）"

  # 把 bundle 挂进 local-bundles：默认符号链接（就地使用，改完即生效），--copy 则复制。
  LINK_DIR="$PROFILE_DIR/local-bundles"
  LINK_PATH="$LINK_DIR/$BUNDLE_NAME"
  mkdir -p "$LINK_DIR"
  if [ "$BUNDLE_DIR" = "$LINK_PATH" ]; then
    ok "bundle 已就位（就地使用）"
  elif [ "$COPY_BUNDLE" = 1 ]; then
    say "复制    : $BUNDLE_DIR -> $LINK_PATH"
    rm -rf "$LINK_PATH"
    mkdir -p "$LINK_PATH"
    ( cd "$BUNDLE_DIR" && tar cf - --exclude='.git' --exclude='askpass' --exclude='node_modules' . ) | ( cd "$LINK_PATH" && tar xf - )
    # 复制模式下 node_modules 不跟着走，需要在副本里再装一次
    for rel in 'presets/bio-research/tools/biotools' 'presets/bio-research/tools/zotero'; do
      if [ ! -d "$LINK_PATH/$rel/node_modules" ]; then
        say "补装    : $rel"
        ( cd "$LINK_PATH/$rel" && "$NODE" "$PNPM" install --prod --ignore-workspace --config.strict-dep-builds=false ) || warn "补装失败：$rel"
      fi
    done
    ok "已复制"
  else
    say "符号链接: $LINK_PATH -> $BUNDLE_DIR"
    rm -rf "$LINK_PATH"
    ln -s "$BUNDLE_DIR" "$LINK_PATH"
    ok "已链接"
  fi

  # 插件用 file: 依赖进 profile；路径尽量写成相对 profile 的形式，便于整体搬迁。
  PLUGIN_DEPS=()
  for p in "${PLUGINS[@]}"; do
    d="$BUNDLE_DIR/$PLUGIN_REL/$p"
    [ -f "$d/package.json" ] && PLUGIN_DEPS+=("$p=$d")
  done

  BACKUP="$MANIFEST.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$MANIFEST" "$BACKUP"
  ok "已备份  : $BACKUP"

  NODE="$NODE" MANIFEST="$MANIFEST" PROFILE_DIR="$PROFILE_DIR" \
  BUNDLE_NAME="$BUNDLE_NAME" LINK_PATH="$LINK_PATH" \
  PLUGIN_DEPS_JOINED="$(printf '%s\n' "${PLUGIN_DEPS[@]:-}")" \
  "$NODE" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const manifestPath = process.env.MANIFEST;
    const profileDir = process.env.PROFILE_DIR;
    const linkPath = process.env.LINK_PATH;
    const bundleName = process.env.BUNDLE_NAME;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    // 相对 profile 的 POSIX 路径；不在 profile 内则退回绝对路径。
    const asSpec = (abs) => {
      const rel = path.relative(profileDir, abs);
      if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return "file:./" + rel.split(path.sep).join("/");
      return "file:" + abs.split(path.sep).join("/");
    };

    manifest.dependencies = manifest.dependencies || {};
    manifest.dependencies[bundleName] = "link:./local-bundles/" + bundleName;

    for (const line of (process.env.PLUGIN_DEPS_JOINED || "").split("\n")) {
      if (line.trim() === "") continue;
      const at = line.indexOf("=");
      manifest.dependencies[line.slice(0, at)] = asSpec(line.slice(at + 1));
    }

    manifest.dsh = manifest.dsh || {};
    manifest.dsh.profile = manifest.dsh.profile || {};
    const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.slice() : [];
    if (!bundles.includes(bundleName)) bundles.push(bundleName);
    manifest.dsh.profile.bundles = bundles;

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log("  dependencies: " + Object.keys(manifest.dependencies).length + " 项");
    console.log("  bundles     : " + bundles.join(", "));
  '
  ok "清单已写入: $MANIFEST"
fi

# ── 4) profile pnpm install ─────────────────────────────────────────────────────
step '4/4 让 profile 的 node_modules 生效'
if [ "$PATCH_PROFILE" = 0 ]; then
  say '（--no-profile：跳过）'
else
  say "在 $PROFILE_DIR 执行 pnpm install（可能需要几分钟）…"
  if ( cd "$PROFILE_DIR" && "$NODE" "$PNPM" install --config.strict-dep-builds=false ); then
    ok 'profile 依赖已就绪'
  else
    warn "pnpm install 失败；请手动执行：cd \"$PROFILE_DIR\" && \"$NODE\" \"$PNPM\" install"
  fi
fi

# ── 收尾 ────────────────────────────────────────────────────────────────────────
step '完成'
cat <<EOF
预设      : 生物科研模式（含 LSF 集群执行）—— macOS 版
bundle    : $BUNDLE_DIR
分析 venv : $VENV_DIR
node      : $NODE
pnpm      : $PNPM

下一步：
  1. 重启 DSH（桌面版退出重开；Web 版重启 \`dsh web\`）——预设的 command/env 只在挂载时读一次。
  2. 新建会话时在预设列表里选「生物科研模式」。
  3. 集群通道需要两个配置文件（都只存本机，不要提交）：
       \$DSH_HOME/dsh-ssh-connections.json   {"connections":[{"id","host","port","username","password"}]}
       \$DSH_HOME/dsh-ssh-totp.json          {"user@host:port":"BASE32SECRET"}
     配好后用 cluster_status 工具自查。
  4. 全面自检：./setup.sh --check
  5. 环境与工具链的说明见预设内的 bio-research-env 技能。
EOF
