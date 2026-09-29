/**
 * dsh-cluster-ssh —— 基于**系统 OpenSSH** 的 LSF 集群执行通道。
 *
 * 为什么不用 ssh2：这台集群（OpenSSH 7.4）上实测 ssh2 能完成认证，但随后客户端发
 * CHANNEL_OPEN(session) 时服务器直接断 TCP（无 CHANNEL_OPEN_FAILURE）。已排除加密
 * 套件（aes128-ctr 同样失败）、客户端 ident、限速等因素；系统 OpenSSH 用同一账号
 * 同一算法完全正常（macOS 自带 /usr/bin/ssh，实测 OpenSSH 10.3）。因此本插件以
 * `ssh` 子进程为执行后端。
 *
 * macOS 适配（相对原 Windows 版）：
 *   · askpass 从 `askpass.bat`（cmd + node 子进程）改为纯 POSIX sh 脚本 `askpass.sh`，
 *     凭据拆成 password / otp 两个 0600 文件，**整条路不再依赖 node**——这样即使
 *     `process.execPath` 指向 Electron 主程序，也不会误启动一个 GUI 进程；
 *   · `UserKnownHostsFile=NUL`（Windows 的空设备）改为 `/dev/null`；
 *   · 本地路径支持 `~` 展开（macOS 上模型常给 `~/x`）；
 *   · askpass.sh 以 0700 落盘（OpenSSH 拒绝执行不可执行的 askpass 程序）。
 *
 * 会话模型（为延迟与 token 双重优化）：
 *   - 起一个 `ssh -tt` 交互式会话，**只认证一次**（集群 TOTP 配了 DISALLOW_REUSE，
 *     同一时间步的码只能验证一次，逐条命令重登录必然失败）；
 *   - 之后所有命令复用同一会话，实测后续命令 ~200ms 量级；
 *   - 命令输出用哨兵切分，剥掉 ANSI 转义与登录横幅，不产生 PTY 回显/prompt 噪音，
 *     并按上限截断，避免把无关字节喂进模型上下文。
 *
 * 文件互传（`cluster_upload` / `cluster_download`）：
 *   - scp 走 SFTP 子协议，无法在已有 shell 里执行，因此**单开一个 scp 进程**；
 *   - 代价是每次传输单独认证一次（再消耗一个 TOTP 时间步）。所以多文件场景应先在
 *     集群侧（或本地）打成 tar 包再传一个归档，而不是逐个文件传；
 *   - 交互会话与传输互不干扰：传输不影响已经建立的 `cluster_exec` 会话。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const totpModule = require('./totp.cjs')

const { readConnections, readJson, dshHome, totpForEndpoint } = totpModule

export const name = 'dsh-cluster-ssh'
export const inject = ['tools']

/**
 * 把「作者方言」的 value schema 编译成宿主强制的原始 JSON Schema 子集。
 *
 * 作者方言（`defineTool` 接受的写法）允许在属性节点上写 `required: true` 简写，
 * 由编译器把它收拢进父对象的 `required` 数组。但 `ctx.tools.register` 对**原始**
 * ToolDefinition 直接跑 `assertSupportedJsonSchema`，而该子集里 `required` 只能
 * 出现在 object 节点上、且必须是字符串数组——照原样交上去会抛
 * `JsonSchemaError: schema.properties.x.required is not supported on type "string"`，
 * 整个插件在 `apply` 阶段就挂不上，预设随之损坏。
 *
 * 所以兜底路径必须自己把这层方言编译掉：剥掉属性节点上的布尔 `required`，
 * 并在其父 object 节点上汇总成 `required` 数组。`oneOf` 节点旁的布尔 `required`
 * 同样被收拢——原始子集里它挨着 `oneOf` 也是非法的。
 * @param node - 作者方言的 schema 片段。
 * @returns 原始 JSON Schema 子集里的等价片段。
 */
function compileAuthorValueSchema(node) {
  if (Array.isArray(node)) return node.map(compileAuthorValueSchema)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  const collected = []
  for (const [key, value] of Object.entries(node)) {
    // 属性节点上的布尔 required 由父层收拢，本层丢弃。
    if (key === 'required' && typeof value === 'boolean') continue
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const properties = {}
      for (const [propertyKey, propertySchema] of Object.entries(value)) {
        if (propertySchema !== null && typeof propertySchema === 'object' && propertySchema.required === true) {
          collected.push(propertyKey)
        }
        properties[propertyKey] = compileAuthorValueSchema(propertySchema)
      }
      out.properties = properties
      continue
    }
    out[key] = compileAuthorValueSchema(value)
  }
  // 已有的（标准写法）required 数组与收拢到的合并，避免丢掉显式声明。
  const declared = Array.isArray(out.required) ? out.required : []
  const merged = [...new Set([...declared, ...collected])]
  if (merged.length > 0) out.required = merged
  return out
}

/**
 * 把工具定义交给宿主注册表。
 *
 * 优先用 `@deepseek-ai/dsh-tools` 的 `defineTool`（第一方工具的标准写法）；它会做
 * 参数校验与类型推导。若该包在当前 profile 里解析不到——**这是 profile 安装插件的
 * 常态**，因为 `@deepseek-ai/dsh-tools` 住在 app.asar 里、不在 profile 的
 * node_modules 中——则回退成宿主同样接受的原始 ToolDefinition（MCP 来源的工具走的
 * 就是这条路），并把作者方言的 schema 编译成原始子集。这样插件既不因宿主包解析差异
 * 而整体失效，也不会因为 schema 方言而在注册时抛异常。
 * @param definition - 以 defineTool 风格书写的定义。
 * @returns 可供 `ctx.tools.register` 使用的定义。
 */
function toToolDefinition(definition) {
  let defineTool
  try {
    defineTool = require('@deepseek-ai/dsh-tools').defineTool
  } catch (error) {
    defineTool = undefined
  }
  if (typeof defineTool === 'function') return defineTool(definition)

  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(definition.parameters ?? {})) {
    const { required: isRequired, ...rest } = spec
    properties[key] = compileAuthorValueSchema(rest)
    if (isRequired === true) required.push(key)
  }
  return {
    name: definition.name,
    description: definition.description,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: {
      ...definition.output,
      schema: compileAuthorValueSchema(definition.output.schema),
    },
    execute: definition.execute,
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * askpass 的落盘位置：**$DSH_HOME 下，不是插件目录里**。
 *
 * 原实现放在 `HERE/askpass`（插件自己旁边），而插件往往就住在源码仓库里——于是
 * 明文密码与一次性口令会直接落在 git 工作区，只靠一条 `.gitignore` 兜着。任何一个
 * `git add -f`、改错 .gitignore、或者打包分发时顺手 `tar` 一下，凭据就出去了。
 * 放到 `$DSH_HOME` 之后，运行时产物与源码树彻底分开，这条风险不存在了。
 *
 * （bundle 里仍保留 `askpass/` 的 .gitignore 条目，兼容老版本留下的目录。）
 */
const ASKPASS_DIR = join(dshHome(), 'bio-research', 'askpass')
const ASKPASS_SH = join(ASKPASS_DIR, 'askpass.sh')
const PASSWORD_FILE = join(ASKPASS_DIR, 'password')
const OTP_FILE = join(ASKPASS_DIR, 'otp')
const COUNT_FILE = join(ASKPASS_DIR, 'count')

/**
 * 把字符串包成 POSIX sh 的单引号字面量。
 * 路径里可能出现空格或引号（预设可放在任意目录），拼进脚本前必须转义。
 * @param value - 原始字符串。
 * @returns 可直接嵌入 sh 脚本的字面量。
 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const READY_PATTERN = /[$#]\s*$/
const START_TIMEOUT_MS = 45_000

/**
 * 生成 askpass 脚本：无 tty 时 ssh 通过 SSH_ASKPASS 取「密码」与「动态口令」。
 *
 * macOS 版是**纯 sh**，不经过 node：ssh 对 askpass 程序的要求只是「可执行 + 把口令
 * 打到 stdout」，而每次认证都要 fork 一个 node 解释器纯属浪费。更重要的是，
 * DSH 桌面版里 `process.execPath` 指向 Electron 主程序，用它当解释器有拉起一个
 * GUI 进程的风险；脚本里不出现可执行解释器，这条路就不存在。
 *
 * 「第几次询问」用计数文件区分：集群的 keyboard-interactive 先问密码、再问动态口令，
 * 所以第 1 次回密码，之后回动态口令。
 */
function ensureAskpass() {
  mkdirSync(ASKPASS_DIR, { recursive: true })
  writeFileSync(ASKPASS_SH, [
    '#!/bin/sh',
    '# 由 ssh/scp 经 SSH_ASKPASS 调用：第 1 次询问回密码，之后回动态口令。',
    '# 本文件由 dsh-cluster-ssh 自动生成，凭据在同目录的 password / otp（均为 0600）。',
    'set -u',
    `CNT=${shQuote(COUNT_FILE)}`,
    `PW=${shQuote(PASSWORD_FILE)}`,
    `OTP=${shQuote(OTP_FILE)}`,
    'N=0',
    'if [ -f "$CNT" ]; then N=$(cat "$CNT" 2>/dev/null || echo 0); fi',
    'case "$N" in *[!0-9]*|"") N=0 ;; esac',
    'N=$((N + 1))',
    'printf %s "$N" > "$CNT" 2>/dev/null || true',
    'if [ "$N" -eq 1 ]; then cat "$PW" 2>/dev/null; else cat "$OTP" 2>/dev/null; fi',
    'printf "\\n"',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o700 })
  // OpenSSH 拒绝执行不可执行的 askpass 程序；若文件已存在，writeFileSync 的 mode 不生效。
  chmodSync(ASKPASS_SH, 0o700)
}

/**
 * 每次发起认证前重写凭据与计数：密码固定，动态口令现算。
 *
 * 写成两个纯文本文件（而不是一个 JSON）是为了让 askpass 脚本保持纯 sh：
 * 解析 JSON 需要解释器，cat 一个文件不需要。两者都是 0600，只存本机。
 */
function writeCredentials(spec) {
  const otp = totpForEndpoint(spec.username, spec.host, spec.port)
  if (otp === null) {
    throw new Error(`缺少动态口令：请在 ${join(dshHome(), 'dsh-ssh-totp.json')} 里为 "${spec.username}@${spec.host}:${spec.port}" 配置 base32 密钥（该文件只存本机，不要提交到仓库）`)
  }
  writeFileSync(PASSWORD_FILE, spec.password ?? '', { encoding: 'utf8', mode: 0o600 })
  writeFileSync(OTP_FILE, otp, { encoding: 'utf8', mode: 0o600 })
  chmodSync(PASSWORD_FILE, 0o600)
  chmodSync(OTP_FILE, 0o600)
  rmSync(COUNT_FILE, { force: true })
}

/**
 * 子进程用的环境：让 ssh/scp 从 askpass 取密码与动态口令。
 *
 * `SSH_ASKPASS_REQUIRE=force` 让 ssh 即使在没有 tty 的情况下也走 askpass
 * （OpenSSH 8.4+；macOS 自带 10.x 满足）；`DISPLAY` 是给更老的 OpenSSH 兜底的，
 * 那些版本只在 DISPLAY 存在时才认 askpass。
 */
function askpassEnv() {
  return { ...process.env, SSH_ASKPASS: ASKPASS_SH, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'localhost:0' }
}

/** ssh/scp/sftp 共用的连接参数（含端口）。 */
function connectionArgs(spec) {
  return [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'PreferredAuthentications=keyboard-interactive',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'ConnectTimeout=25',
    '-o', 'LogLevel=ERROR',
  ]
}

/**
 * 把本地路径补成绝对路径。
 * 模型常给相对路径，而子进程的工作目录是 DSH 进程的目录，直接传给 scp 会指错地方。
 * `~` / `~/x` 按本机主目录展开（macOS 上模型经常这么写）。
 * @param localPath - 用户给的本地路径。
 * @returns 绝对路径。
 */
function toAbsoluteLocal(localPath) {
  if (localPath === '~') return homedir()
  if (localPath.startsWith('~/')) return join(homedir(), localPath.slice(2))
  // Windows 绝对路径原样保留（同一个 bundle 在 win32 上也能跑）
  if (/^[A-Za-z]:[\\/]/.test(localPath) || localPath.startsWith('\\\\')) return localPath
  return resolve(process.cwd(), localPath)
}

/**
 * 展开远端路径（`~`、`~/x` 归一为主目录下的 POSIX 路径）。
 * @param remotePath - 用户给的远端路径。
 * @param home - 连接上配置的远端主目录，可为空。
 * @returns 绝对 POSIX 路径。
 */
function toAbsoluteRemote(remotePath, home) {
  if (remotePath === '~') return home.length > 0 ? home : '.'
  if (remotePath.startsWith('~/')) return `${home}/${remotePath.slice(2)}`.replace(/\/{2,}/g, '/')
  return remotePath
}

/**
 * 用 scp 做一次单向传输。
 *
 * 为什么单开进程而不复用交互会话：scp 走 SFTP 子协议，不能在已有 shell 里跑。
 * 代价是这次传输要**单独认证一次**（集群 TOTP 有 DISALLOW_REUSE，所以连续多次
 * 传输会各自消耗一个时间步；批量传输请优先用 `cluster_exec` 在集群侧用 tar 打包）。
 * @param spec - 连接配置。
 * @param direction - `up` 上传，`down` 下载。
 * @param localPath - 本地路径。
 * @param remotePath - 远端路径。
 * @returns 传输结果。
 */
function runTransfer(spec, direction, localPath, remotePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    ensureAskpass()
    writeCredentials(spec)
    const home = typeof spec.cwd === 'string' ? spec.cwd : ''
    const local = direction === 'up' ? toAbsoluteLocal(localPath) : toAbsoluteLocal(localPath)
    const remote = toAbsoluteRemote(remotePath, home)
    const target = `${spec.username}@${spec.host}`
    const args = [
      ...connectionArgs(spec),
      '-P', String(spec.port),
      direction === 'up' ? local : `${target}:${remote}`,
      direction === 'up' ? `${target}:${remote}` : local,
    ]
    const started = Date.now()
    const child = spawn(process.env.DSH_SCP_CLIENT ?? 'scp', args, {
      env: askpassEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch (error) { /* 已退出 */ } }, 30 * 60 * 1000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { clearTimeout(timer); rejectPromise(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({
        direction,
        localPath: local,
        remotePath: remote,
        ok: code === 0,
        exitCode: code === null ? -1 : code,
        elapsedMs: Date.now() - started,
        detail: (stderr.trim() || stdout.trim()).slice(0, 2000),
      })
    })
  })
}

/**
 * 去掉 PTY 的 ANSI 控制序列与 `\r`，保留其余字节原样。
 * 输出的切分由调用方的标记界定完成，这里只做终端装饰的清理。
 * @param raw - 会话原始字节解码后的文本。
 * @returns 可读文本。
 */
function stripAnsi(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[=>()][A-Za-z0-9]?/g, '')
    .replace(/\r/g, '')
}

/**
 * 取出两个整行标记之间的内容，作为命令的真实输出。
 *
 * 回显里每行只含一个标记（其后还跟着命令余部），而真实标记独占一行，因此用
 * 「标记后紧跟换行或文本结束」定位真正的边界：从最后一个这样的 `pre` 之后开始，
 * 到其后第一个 `post` 为止。
 * @param text - 已剥离 ANSI 的会话文本。
 * @param pre - 输出起始标记。
 * @param post - 输出结束标记。
 * @param command - 原始命令（回填到结果里）。
 * @param maxOutputBytes - 输出字节上限。
 * @returns 规范化的执行结果。
 */
function extractBetween(text, pre, post, command, maxOutputBytes) {
  const standalone = (marker, from) => {
    let index = text.indexOf(marker, from)
    while (index !== -1) {
      const after = text[index + marker.length]
      // 注意：after 可能是空串（行尾），空串是 falsy，不能直接用于条件
      if (after === '\n' || after === '' || after === undefined) return index
      index = text.indexOf(marker, index + 1)
    }
    return -1
  }

  const startAt = (() => {
    let found = -1
    let index = standalone(pre, 0)
    while (index !== -1) { found = index; index = standalone(pre, index + 1) }
    return found
  })()

  if (startAt === -1) {
    return { command, output: text.trim(), truncated: false, bytes: Buffer.byteLength(text, 'utf8'), timedOut: true }
  }

  const bodyFrom = startAt + pre.length
  const endAt = standalone(post, bodyFrom)
  const body = stripPromptPrefix(
    (endAt === -1 ? text.slice(bodyFrom) : text.slice(bodyFrom, endAt)).replace(/^\n+/, '').replace(/\n+$/, ''),
  )
  const bytes = Buffer.byteLength(body, 'utf8')
  const truncated = bytes > maxOutputBytes
  return {
    command,
    output: truncated ? `${body.slice(0, maxOutputBytes)}\n\n[输出已截断：共 ${bytes} 字节，仅保留前 ${maxOutputBytes} 字节]` : body,
    truncated,
    bytes,
    timedOut: endAt === -1,
  }
}

/** 去掉输出首尾残留的 shell 提示符（`[user@host ~]$`）与 `cd` 前缀。 */
function stripPromptPrefix(body) {
  return body
    .replace(/^\[[^\]\n]*@[^\]\n]*\][$#]\s?/, '')
    .replace(/^cd\s+\S+\s+2>\/dev\/null;\s*/, '')
    .replace(/\n\[[^\]\n]*@[^\]\n]*\][$#]\s?$/, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

/** 一个持久 SSH 交互式会话；内部把命令串行化，避免哨兵互相污染。 */
export class ClusterSession {
  constructor(spec, options = {}) {
    this.spec = spec
    this.cwd = options.cwd ?? spec.cwd ?? ''
    this.child = undefined
    this.buffer = ''
    this.ready = false
    this.dead = false
    this.counter = 0
    this.tail = Promise.resolve()
    this.waiters = []
    this.rejectStart = undefined
  }

  /** 启动会话并等待提示符；失败时抛出带诊断的异常。 */
  start() {
    if (this.child !== undefined) return Promise.resolve()
    ensureAskpass()
    writeCredentials(this.spec)
    const args = [
      '-tt',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'PreferredAuthentications=keyboard-interactive',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'ConnectTimeout=25',
      '-o', 'ServerAliveInterval=30',
      '-o', 'LogLevel=ERROR',
      '-p', String(this.spec.port),
      `${this.spec.username}@${this.spec.host}`,
    ]
    this.child = spawn(process.env.DSH_SSH_CLIENT ?? 'ssh', args, {
      env: askpassEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    this.child.stderr.on('data', (chunk) => this.onData(chunk))
    this.child.on('error', (error) => this.fail(error))
    this.child.on('close', () => this.fail(new Error('SSH 会话已关闭')))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SSH 会话在 ${START_TIMEOUT_MS / 1000}s 内未就绪；最近输出：${JSON.stringify(this.buffer.slice(-300))}`))
      }, START_TIMEOUT_MS)
      this.rejectStart = (error) => { clearTimeout(timer); reject(error) }
      this.waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8')
    if (!this.ready && READY_PATTERN.test(this.buffer.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))) {
      // 会话可用后立刻关掉 PTY 回显：否则命令本身会被回显进输出，
      // 而回显与结果挤在同一行，无法可靠切分。
      this.ready = true
      try { this.child.stdin.write('stty -echo\n') } catch (error) { /* 会话可能刚断开 */ }
      setTimeout(() => {
        this.buffer = ''
        const waiters = this.waiters
        this.waiters = []
        for (const waiter of waiters) waiter()
      }, 400)
    }
    if (this.onChunk !== undefined) this.onChunk()
  }

  fail(error) {
    if (this.dead) return
    this.dead = true
    this.ready = false
    if (this.rejectStart !== undefined) this.rejectStart(error)
    if (this.onChunk !== undefined) this.onChunk()
  }

  /**
   * 在会话里执行一条命令：用一对标记把输出夹住，再按标记切出来。
   *
   * 为什么用「标记界定」而不是「按提示符剥离回显」：PTY 会把命令回显与输出挤在同一
   * 个提示符行内（多行输出才会换行），按行判断无法可靠区分两者。把输出包在
   * `MARK_BEGIN … MARK_END` 之间后，回显里虽然也出现这两个串，但只有真正执行的那一份
   * 位于最后一个 MARK_END 之前，倒数定位即可精确取到输出。
   * @param command - bash 命令。
   * @param options - 超时与输出上限。
   * @returns 规范化的执行结果。
   */
  exec(command, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, rawOnly = false } = {}) {
    const run = async () => {
      await this.start()
      if (this.dead) throw new Error('SSH 会话不可用')
      const token = `${++this.counter}_${Date.now().toString(36)}`
      const pre = `__DSHP_${token}__`
      const post = `__DSHQ_${token}__`
      const prefixed = this.cwd.length > 0 ? `cd ${this.cwd} 2>/dev/null; ${command}` : command
      // 真实标记各占一整行；PTY 回显里同一行还会带命令余部，故用「标记后紧跟换行/结束」定位
      const payload = `echo ${pre}\n${prefixed}\necho ${post}\n`

      let settled = false
      let release
      const done = new Promise((resolve) => { release = resolve })
      this.onChunk = () => { if (!settled && this.buffer.includes(post)) { settled = true; release() } }
      this.buffer = ''
      this.child.stdin.write(payload)
      const timer = setTimeout(() => { if (!settled) { settled = true; release() } }, timeoutMs)
      await done
      clearTimeout(timer)
      const raw = this.buffer
      this.buffer = ''
      this.onChunk = undefined
      if (rawOnly) return { raw: stripAnsi(raw) }
      return extractBetween(stripAnsi(raw), pre, post, command, maxOutputBytes)
    }
    const chained = this.tail.then(run, run)
    this.tail = chained.then(() => undefined, () => undefined)
    return chained
  }

  dispose() {
    this.dead = true
    this.ready = false
    try { this.child?.stdin.write('exit\n') } catch (error) { /* 会话可能已断开 */ }
    try { this.child?.kill() } catch (error) { /* 已退出 */ }
    this.child = undefined
  }

  /**
   * 调试用：返回未切分的会话原文（已剥离 ANSI），用于校准标记定位。
   * @param command - 要执行的命令。
   * @returns 原文文本。
   */
  async execRaw(command) {
    const result = await this.exec(command, { rawOnly: true })
    return result.raw
  }

  get alive() { return this.dead !== true && this.ready === true }
}

/**
 * 注册集群工具。
 * @param ctx - 挂载上下文；插件只使用 `tools` 注册表。
 */
export function apply(ctx) {
  const sessions = new Map()

  /** 按连接 id 取（或建立）会话。 */
  function sessionFor(connectionId) {
    const connections = readConnections()
    const spec = connectionId === undefined
      ? connections[0]
      : connections.find((item) => item.id === connectionId)
    if (spec === undefined) {
      throw new Error(connections.length === 0
        ? `没有已保存的集群连接：请在 ${join(dshHome(), 'dsh-ssh-connections.json')} 中配置主机、端口、用户名与密码`
        : `找不到连接 "${connectionId}"；可用：${connections.map((c) => c.id).join(', ')}`)
    }
    const key = spec.id ?? `${spec.username}@${spec.host}:${spec.port}`
    let session = sessions.get(key)
    if (session === undefined || session.dead) {
      session = new ClusterSession(spec)
      sessions.set(key, session)
    }
    return { session, spec }
  }

  ctx.tools.register(toToolDefinition({
    name: 'cluster_exec',
    description: 'Run a bash command on the LSF cluster login node over SSH. Reuses one authenticated session, so consecutive calls are fast (~200ms). Use it for bjobs/bqueues/bhosts/module/ls/cat and other short work; submit heavy computation with bsub instead of running it on the login node.',
    parameters: {
      command: { type: 'string', required: true, description: 'Bash command line to run on the cluster login node.' },
      timeoutMs: { type: 'number', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).` },
      maxOutputBytes: { type: 'number', description: `Cap on returned output bytes (default ${DEFAULT_MAX_OUTPUT_BYTES}); longer output is truncated.` },
      connectionId: { type: 'string', description: 'Saved connection id to use; defaults to the first saved connection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', required: true },
          output: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          bytes: { type: 'number', required: true },
          timedOut: { type: 'boolean', required: true },
          host: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.output.length > 0 ? value.output : '(命令无输出)' }],
    },
    async execute(args) {
      const { session, spec } = sessionFor(args.connectionId)
      const result = await session.exec(args.command, {
        timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      })
      return { ...result, host: `${spec.username}@${spec.host}` }
    },
  }))

  ctx.tools.register(toToolDefinition({
    name: 'cluster_status',
    description: 'Report the cached cluster SSH session state: saved connections, live sessions, and whether the TOTP secret is present. Use it to diagnose before running cluster commands.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connections: { type: 'array', required: true, items: { type: 'string' } },
          liveSessions: { type: 'array', required: true, items: { type: 'string' } },
          totpConfigured: { type: 'boolean', required: true },
          totpFile: { type: 'string', required: true },
          sshClient: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `已保存连接: ${value.connections.length === 0 ? '(无)' : value.connections.join('; ')}`,
          `活动会话: ${value.liveSessions.length === 0 ? '(无，首次调用 cluster_exec 时建立)' : value.liveSessions.join(', ')}`,
          `动态口令密钥: ${value.totpConfigured ? '已配置' : `未配置 -> ${value.totpFile}`}`,
          `ssh 客户端: ${value.sshClient}`,
        ].join('\n'),
      }],
    },
    async execute() {
      const connections = readConnections()
      const totpFile = join(dshHome(), 'dsh-ssh-totp.json')
      const ring = readJson(totpFile)
      const first = connections[0]
      const totpConfigured = first !== undefined && ring !== undefined && ring !== null
        && (ring[`${first.username}@${first.host}:${first.port}`] !== undefined || ring[`${first.username}@${first.host}`] !== undefined)
      return {
        connections: connections.map((c) => `${c.id ?? '?'} = ${c.username}@${c.host}:${c.port}`),
        liveSessions: [...sessions.entries()].filter(([, s]) => s.alive).map(([k]) => k),
        totpConfigured: totpConfigured === true,
        totpFile,
        sshClient: process.env.DSH_SSH_CLIENT ?? 'ssh',
      }
    },
  }))

  ctx.tools.register(toToolDefinition({
    name: 'cluster_upload',
    description: 'Copy a local file to the LSF cluster over SCP. This opens its own authenticated connection, so it spends one TOTP code — for many files, tar them first (locally or with cluster_exec) and transfer the archive instead.',
    parameters: {
      localPath: { type: 'string', required: true, description: 'Local file path (relative paths resolve against the harness working directory).' },
      remotePath: { type: 'string', required: true, description: 'Destination path on the cluster; `~` and `~/x` are expanded against the login home.' },
      connectionId: { type: 'string', description: 'Saved connection id; defaults to the first saved connection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          direction: { type: 'string', required: true },
          localPath: { type: 'string', required: true },
          remotePath: { type: 'string', required: true },
          exitCode: { type: 'number', required: true },
          elapsedMs: { type: 'number', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已上传（${value.elapsedMs} ms）：${value.localPath} -> ${value.remotePath}`
          : `上传失败（exit ${value.exitCode}）：${value.localPath} -> ${value.remotePath}\n${value.detail}`,
      }],
    },
    async execute(args) {
      const { spec } = sessionFor(args.connectionId)
      return runTransfer(spec, 'up', args.localPath, args.remotePath)
    },
  }))

  ctx.tools.register(toToolDefinition({
    name: 'cluster_download',
    description: 'Copy a file from the LSF cluster to the local machine over SCP. This opens its own authenticated connection, so it spends one TOTP code — prefer tarring many files on the cluster first and downloading one archive.',
    parameters: {
      remotePath: { type: 'string', required: true, description: 'File path on the cluster; `~` and `~/x` are expanded against the login home.' },
      localPath: { type: 'string', required: true, description: 'Local destination path (relative paths resolve against the harness working directory).' },
      connectionId: { type: 'string', description: 'Saved connection id; defaults to the first saved connection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          direction: { type: 'string', required: true },
          localPath: { type: 'string', required: true },
          remotePath: { type: 'string', required: true },
          exitCode: { type: 'number', required: true },
          elapsedMs: { type: 'number', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已下载（${value.elapsedMs} ms）：${value.remotePath} -> ${value.localPath}`
          : `下载失败（exit ${value.exitCode}）：${value.remotePath} -> ${value.localPath}\n${value.detail}`,
      }],
    },
    async execute(args) {
      const { spec } = sessionFor(args.connectionId)
      return runTransfer(spec, 'down', args.localPath, args.remotePath)
    },
  }))

  // 会话随插件 fiber 回收，避免留下悬空的 ssh 子进程
  ctx.effect(() => () => {
    for (const session of sessions.values()) session.dispose()
    sessions.clear()
  }, 'dsh-cluster-ssh session teardown')
}

export const askpassDirectory = ASKPASS_DIR
export const resolveSshClient = () => process.env.DSH_SSH_CLIENT ?? 'ssh'
