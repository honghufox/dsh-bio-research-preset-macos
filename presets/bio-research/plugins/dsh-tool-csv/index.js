/**
 * dsh-tool-csv —— RFC 4180 CSV **文本**的解析、查询与统计工具。
 *
 * 设计取舍：
 *   - 输入是模型直接给出的 CSV 正文（字符串），不是路径：插件保持纯函数、零依赖、
 *     不做任何 I/O，因此不会因为工作目录、文件权限或路径解析而失败；代价是超过
 *     256 KB 的表格必须先由调用方裁剪，这也正好挡住撑爆上下文的输入；
 *   - 自带 RFC 4180 解析器：支持引号字段、`""` 转义、字段内的分隔符与换行、`\n` 与
 *     `\r\n` 两种行尾。绝不能按逗号/换行裸切，否则 `"a,b"` 这种字段会被切碎；
 *   - `where` 用手写词法 + 递归下降求值，只做「列 vs 字面量」的比较，没有任何求值
 *     入口（不用 eval / new Function / vm），模型给的表达式因此不可能执行任意代码；
 *   - 参差行（字段数与表头不一致）只统计并提示，不静默丢弃或补齐；所有数值结果要么
 *     有限、要么显式为 null，绝不出现 NaN / Infinity。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const name = 'dsh-tool-csv'
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

/* ------------------------------------------------------------------ *
 * 常量：所有硬上限集中在此，便于核对与调整
 * ------------------------------------------------------------------ */

/** 输入正文的字符数上限（256 KB）。 */
const MAX_INPUT_CHARS = 262_144
/** parse / query 默认返回行数。 */
const DEFAULT_LIMIT = 50
/** limit 的硬上限，避免一次把整张表塞进上下文。 */
const MAX_LIMIT = 1000
/** 渲染时最多显示的数据行数。 */
const MAX_RENDER_ROWS = 50
/** 渲染时最多显示的列数。 */
const MAX_RENDER_COLUMNS = 24
/** 单个单元格在渲染里的最大字符数。 */
const MAX_CELL_CHARS = 40
/** 渲染文本的总字符上限。 */
const MAX_RENDER_CHARS = 12_000
/** 支持的操作。 */
const OPS = ['parse', 'describe', 'query', 'stats']
/** 严格十进制数字（含可选指数），用于「两侧都是有限数字才做数值比较」。 */
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
/** ISO-8601 日期或日期时间前缀。 */
const DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/
const BOOLEAN_PATTERN = /^(?:true|false)$/i
const COMPARISON_OPS = new Set(['=', '!=', '>', '>=', '<', '<='])
const TEXT_OPS = new Set(['contains', 'startswith', 'endswith'])

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/**
 * 把浮点结果收敛成「至多 6 位小数」的有限数；非有限值一律变成 null。
 * 输出的 JSON 里因此永远不会出现 NaN / Infinity / -0。
 * @param value - 待收敛的数值。
 * @returns 有限数或 null。
 */
function round6(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Number(value.toFixed(6))
  if (!Number.isFinite(rounded)) return null
  return rounded === 0 ? 0 : rounded
}

/**
 * 把单元格文本解析成有限数字；空串、空白与非严格数字（如 0x10、Infinity、NaN）都返回 null。
 * @param value - 原始文本。
 * @returns 有限数字或 null。
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || !NUMBER_PATTERN.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** 判断单元格是否为空（仅含空白也算空）。 */
function isBlank(value) {
  return typeof value !== 'string' || value.trim().length === 0
}

/** 单个值的类型归类，供列类型推断使用。 */
function classifyValue(text) {
  if (NUMBER_PATTERN.test(text)) return 'number'
  if (BOOLEAN_PATTERN.test(text)) return 'boolean'
  if (DATE_PREFIX_PATTERN.test(text)) return 'date'
  return 'string'
}

/**
 * 校验并归一化分隔符。
 * @param raw - 调用方给的分隔符。
 * @returns 单字符分隔符。
 */
function normalizeDelimiter(raw) {
  if (raw === undefined || raw === null) return ','
  const text = String(raw)
  if (text === '\\t' || text === '\t') return '\t'
  if (text.length !== 1) {
    throw new Error(`delimiter 必须是单个字符，收到 ${JSON.stringify(raw)}（要制表符请传 "\\t"）`)
  }
  if (text === '"' || text === '\n' || text === '\r') {
    throw new Error(`delimiter 不能是引号或换行符，收到 ${JSON.stringify(raw)}`)
  }
  return text
}

/* ------------------------------------------------------------------ *
 * RFC 4180 解析器（手写状态机，不裸切逗号/换行）
 * ------------------------------------------------------------------ */

/**
 * 把 CSV 正文解析成二维字段数组。
 *
 * 规则：引号只在字段起始处开启引用；引用内的 `""` 表示一个字面引号；引用内的分隔符与
 * 换行都是普通字符；行尾接受 `\n`、`\r\n` 与单独的 `\r`；完全空白的行被跳过（否则
 * 表格中间的空白行会变成一行参差数据），跳过数量如实上报，不静默吞掉。未闭合的引号按
 * 「延伸到文本末尾」容错处理，并由调用方以 note 形式提示。
 * @param text - 已去掉 BOM 的 CSV 正文。
 * @param delimiter - 单字符分隔符。
 * @returns 行数组、空白行数量与「引号未闭合」标记。
 */
function parseCsvText(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let atFieldStart = true
  let rowHasToken = false
  let blankLines = 0
  let index = 0
  const end = text.length

  while (index < end) {
    const ch = text[index]

    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += ch
      index += 1
      continue
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true
      atFieldStart = false
      rowHasToken = true
      index += 1
      continue
    }

    if (ch === delimiter) {
      row.push(field)
      field = ''
      atFieldStart = true
      rowHasToken = true
      index += 1
      continue
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[index + 1] === '\n') index += 2
      else index += 1
      if (rowHasToken) {
        row.push(field)
        rows.push(row)
      } else {
        blankLines += 1
      }
      row = []
      field = ''
      atFieldStart = true
      rowHasToken = false
      continue
    }

    field += ch
    atFieldStart = false
    rowHasToken = true
    index += 1
  }

  if (rowHasToken) {
    row.push(field)
    rows.push(row)
  }
  return { rows, unterminatedQuote: inQuotes, blankLines }
}

/**
 * 生成列名：表头为空白的列回退成 `col{i}`，重名按 `name`、`name_2`、`name_3` 确定性去重。
 * @param rawHeader - 表头原始字段（无表头时为 undefined）。
 * @param width - 列数。
 * @returns 列名数组。
 */
function makeColumns(rawHeader, width) {
  const used = new Set()
  const columns = []
  for (let i = 0; i < width; i += 1) {
    const raw = rawHeader === undefined ? '' : String(rawHeader[i] ?? '')
    const base = raw.trim().length > 0 ? raw.trim() : `col${i}`
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`
      suffix += 1
    }
    used.add(candidate)
    columns.push(candidate)
  }
  return columns
}

/**
 * 解析正文并整理成表格：列名、参差行计数与提示。
 * @param args - 工具入参。
 * @returns 表格对象。
 */
function prepareTable(args) {
  const delimiter = normalizeDelimiter(args.delimiter)
  const hasHeader = args.hasHeader !== false
  const text = String(args.csv).replace(/^\uFEFF/, '')
  const { rows: rawRows, unterminatedQuote, blankLines } = parseCsvText(text, delimiter)
  if (rawRows.length === 0) throw new Error('CSV 文本里没有可解析的行（只有空白或换行）')

  const headerRow = hasHeader ? rawRows[0] : undefined
  const dataRows = hasHeader ? rawRows.slice(1) : rawRows

  let width = 0
  if (hasHeader) {
    width = headerRow.length
  } else {
    for (const row of dataRows) if (row.length > width) width = row.length
  }

  const columns = makeColumns(headerRow, width)
  let raggedRows = 0
  for (const row of dataRows) if (row.length !== width) raggedRows += 1

  const notes = []
  if (unterminatedQuote) notes.push('输入末尾存在未闭合的引号，已按「引用延伸到文本末尾」处理')
  if (blankLines > 0) notes.push(`已跳过 ${blankLines} 个空白行（空白行不计入数据行）`)
  if (raggedRows > 0) {
    notes.push(`有 ${raggedRows} 行的字段数与${hasHeader ? '表头' : '最宽行'}(${width}) 不一致；缺失字段按空串处理，多余字段被忽略`)
  }
  if (hasHeader && dataRows.length === 0) notes.push('输入只有表头行，没有任何数据行')

  return { columns, dataRows, width, raggedRows, notes, hasHeader, delimiter }
}

/* ------------------------------------------------------------------ *
 * 列选择与行投影
 * ------------------------------------------------------------------ */

/**
 * 解析 `select`：列名优先（先精确、再忽略大小写），纯数字 token 在列名匹配不到时按 0 基下标解释。
 * @param available - 全部列名。
 * @param select - 调用方给的 select 字符串。
 * @returns 选中的列名数组（保序去重）。
 */
function selectColumns(available, select) {
  if (select === undefined || select === null || String(select).trim().length === 0) return [...available]
  const tokens = String(select).split(',').map((token) => token.trim()).filter((token) => token.length > 0)
  if (tokens.length === 0) throw new Error('select 为空：请给出列名或 0 基下标，并用逗号分隔')

  const lowerIndex = new Map()
  available.forEach((columnName, i) => {
    const key = columnName.toLowerCase()
    if (!lowerIndex.has(key)) lowerIndex.set(key, i)
  })

  const picked = []
  for (const token of tokens) {
    let index = available.indexOf(token)
    if (index === -1 && lowerIndex.has(token.toLowerCase())) index = lowerIndex.get(token.toLowerCase())
    if (index === -1 && /^\d+$/.test(token)) {
      const numeric = Number(token)
      if (numeric >= 0 && numeric < available.length) index = numeric
    }
    if (index === -1) throw new Error(`select 里的列 "${token}" 不存在；可用列：${available.join(', ')}`)
    if (!picked.includes(index)) picked.push(index)
  }
  return picked.map((i) => available[i])
}

/**
 * 把一行字段投影成对象。用 Object.fromEntries 而不是逐键赋值，避免表头里出现
 * `__proto__` 之类的名字时污染原型而不产生自有属性。
 * @param row - 字段数组。
 * @param columns - 目标列名。
 * @param sourceIndexes - 每个目标列在原始行里的下标。
 * @returns 行对象。
 */
function projectRow(row, columns, sourceIndexes) {
  const pairs = []
  for (let i = 0; i < columns.length; i += 1) {
    const at = sourceIndexes[i]
    pairs.push([columns[i], at < row.length ? row[at] : ''])
  }
  return Object.fromEntries(pairs)
}

/* ------------------------------------------------------------------ *
 * where 表达式：手写词法 + 递归下降（无 eval / new Function / vm）
 * ------------------------------------------------------------------ */

/**
 * 词法分析：空白分隔；单/双引号字符串支持 `\x` 与双写转义；比较运算符两字符优先；
 * 其余连续字符构成裸词（列名、数字字面量、and/or 关键字、contains 等）。
 * @param input - 表达式文本。
 * @returns token 数组。
 */
function tokenizeWhere(input) {
  const tokens = []
  let i = 0
  const end = input.length

  while (i < end) {
    const ch = input[i]

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ kind: ch })
      i += 1
      continue
    }

    if (ch === "'" || ch === '"') {
      const quote = ch
      let value = ''
      let closed = false
      i += 1
      while (i < end) {
        const current = input[i]
        if (current === '\\' && i + 1 < end) {
          value += input[i + 1]
          i += 2
          continue
        }
        if (current === quote) {
          if (input[i + 1] === quote) {
            value += quote
            i += 2
            continue
          }
          closed = true
          i += 1
          break
        }
        value += current
        i += 1
      }
      if (!closed) throw new Error(`where 里的字符串缺少收尾引号：${quote}${value}`)
      tokens.push({ kind: 'string', value })
      continue
    }

    const pair = input.slice(i, i + 2)
    if (pair === '>=' || pair === '<=' || pair === '!=' || pair === '<>' || pair === '==') {
      tokens.push({ kind: 'op', value: pair === '<>' ? '!=' : pair === '==' ? '=' : pair })
      i += 2
      continue
    }
    if (ch === '=' || ch === '>' || ch === '<') {
      tokens.push({ kind: 'op', value: ch })
      i += 1
      continue
    }

    let word = ''
    while (i < end) {
      const current = input[i]
      if (current === ' ' || current === '\t' || current === '\n' || current === '\r') break
      if (current === '=' || current === '!' || current === '<' || current === '>') break
      if (current === '(' || current === ')' || current === "'" || current === '"') break
      word += current
      i += 1
    }
    if (word.length === 0) throw new Error(`where 表达式里有无法识别的字符：${JSON.stringify(input[i] ?? '')}`)
    tokens.push({ kind: 'word', value: word })
  }

  return tokens
}

/**
 * 递归下降解析：or 优先级最低，其次 and，最内层是括号或单个比较子句。
 * @param input - 表达式文本。
 * @returns 语法树。
 */
function parseWhere(input) {
  const tokens = tokenizeWhere(input)
  let pos = 0

  const peek = () => tokens[pos]
  const isKeyword = (token, keyword) => token !== undefined && token.kind === 'word' && token.value.toLowerCase() === keyword

  function parsePrimary() {
    const token = peek()
    if (token === undefined) throw new Error('where 表达式不完整：缺少子句')

    if (token.kind === '(') {
      pos += 1
      const node = parseOr()
      const close = peek()
      if (close === undefined || close.kind !== ')') throw new Error('where 表达式里的括号不匹配')
      pos += 1
      return node
    }
    if (token.kind === 'op' || token.kind === ')') {
      throw new Error(`where 表达式不完整：此处应为列名，收到 ${JSON.stringify(token.value ?? token.kind)}`)
    }

    const columnToken = tokens[pos]
    pos += 1
    const opToken = tokens[pos]
    pos += 1
    if (opToken === undefined) throw new Error(`where 子句 "${columnToken.value}" 缺少运算符`)
    let op
    if (opToken.kind === 'op' && COMPARISON_OPS.has(opToken.value)) op = opToken.value
    else if (opToken.kind === 'word' && TEXT_OPS.has(opToken.value.toLowerCase())) op = opToken.value.toLowerCase()
    else throw new Error(`where 子句 "${columnToken.value}" 的运算符无法识别：${JSON.stringify(opToken.value ?? opToken.kind)}`)

    const literalToken = tokens[pos]
    pos += 1
    if (literalToken === undefined) throw new Error(`where 子句 "${columnToken.value} ${op}" 缺少字面量`)
    if (literalToken.kind === 'op' || literalToken.kind === '(' || literalToken.kind === ')') {
      throw new Error(`where 子句 "${columnToken.value} ${op}" 缺少字面量（字面量要用数字或引号字符串）`)
    }
    return { type: 'clause', column: String(columnToken.value), op, literal: String(literalToken.value) }
  }

  function parseAnd() {
    let node = parsePrimary()
    while (isKeyword(peek(), 'and')) {
      pos += 1
      node = { type: 'and', left: node, right: parsePrimary() }
    }
    return node
  }

  function parseOr() {
    let node = parseAnd()
    while (isKeyword(peek(), 'or')) {
      pos += 1
      node = { type: 'or', left: node, right: parseAnd() }
    }
    return node
  }

  const ast = parseOr()
  if (pos !== tokens.length) throw new Error(`where 表达式在 ${JSON.stringify(tokens[pos].value ?? tokens[pos].kind)} 之后无法继续解析`)
  return ast
}

/**
 * 把语法树里的列名解析成列下标（列名优先，纯数字在匹配不到列名时按 0 基下标解释）。
 * @param node - 语法树节点。
 * @param columns - 全部列名。
 */
function resolveWhereColumns(node, columns) {
  if (node.type === 'and' || node.type === 'or') {
    resolveWhereColumns(node.left, columns)
    resolveWhereColumns(node.right, columns)
    return
  }
  let index = columns.indexOf(node.column)
  if (index === -1) index = columns.findIndex((columnName) => columnName.toLowerCase() === node.column.toLowerCase())
  if (index === -1 && /^\d+$/.test(node.column)) {
    const numeric = Number(node.column)
    if (numeric >= 0 && numeric < columns.length) index = numeric
  }
  if (index === -1) throw new Error(`where 里的列 "${node.column}" 不存在；可用列：${columns.join(', ')}`)
  node.index = index
}

/**
 * 单个子句的比较：只要两侧都能解析成有限数字就按数值比较，否则按字符串比较（区分大小写）。
 * @param cell - 单元格原文。
 * @param op - 运算符。
 * @param literal - 字面量。
 * @returns 是否命中。
 */
function compareCell(cell, op, literal) {
  const text = cell ?? ''
  if (op === 'contains') return text.includes(literal)
  if (op === 'startswith') return text.startsWith(literal)
  if (op === 'endswith') return text.endsWith(literal)

  const left = toNumber(text)
  const right = toNumber(literal)
  if (left !== null && right !== null) {
    if (op === '=') return left === right
    if (op === '!=') return left !== right
    if (op === '>') return left > right
    if (op === '>=') return left >= right
    if (op === '<') return left < right
    return left <= right
  }

  if (op === '=') return text === literal
  if (op === '!=') return text !== literal
  if (op === '>') return text > literal
  if (op === '>=') return text >= literal
  if (op === '<') return text < literal
  return text <= literal
}

/** 在给定行上求值语法树。 */
function evaluateWhere(node, row) {
  if (node.type === 'and') return evaluateWhere(node.left, row) && evaluateWhere(node.right, row)
  if (node.type === 'or') return evaluateWhere(node.left, row) || evaluateWhere(node.right, row)
  return compareCell(row[node.index], node.op, node.literal)
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/** 列类型推断：非空值的类型一致则取该类型，混合则为 string，全空为 empty。 */
function inferType(values) {
  const seen = new Set()
  let nonEmpty = 0
  for (const value of values) {
    if (isBlank(value)) continue
    seen.add(classifyValue(value.trim()))
    nonEmpty += 1
  }
  if (nonEmpty === 0) return 'empty'
  if (seen.size === 1) return [...seen][0]
  return 'string'
}

/** 非空值去重计数。 */
function distinctCount(values) {
  const seen = new Set()
  for (const value of values) if (!isBlank(value)) seen.add(value)
  return seen.size
}

/**
 * 数值列摘要：count/min/max/mean/median/样本标准差（n-1）；n < 2 时标准差为 null。
 * @param values - 该列的原始值。
 * @returns 全部字段均为有限数或 null 的摘要。
 */
function numericSummary(values) {
  const numbers = []
  for (const value of values) {
    const parsed = toNumber(value)
    if (parsed !== null) numbers.push(parsed)
  }
  if (numbers.length === 0) {
    return { count: 0, min: null, max: null, mean: null, median: null, stddev: null }
  }

  let min = numbers[0]
  let max = numbers[0]
  let sum = 0
  for (const value of numbers) {
    if (value < min) min = value
    if (value > max) max = value
    sum += value
  }
  const mean = sum / numbers.length
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2

  let variance = null
  if (numbers.length >= 2) {
    let acc = 0
    for (const value of numbers) {
      const delta = value - mean
      acc += delta * delta
    }
    variance = acc / (numbers.length - 1)
  }
  const stddev = variance === null ? null : Math.sqrt(variance)

  return {
    count: numbers.length,
    min: round6(min),
    max: round6(max),
    mean: round6(mean),
    median: round6(median),
    stddev: round6(stddev),
  }
}

/**
 * 组装一列的元信息。describe 与 stats 共用同一形状（additionalProperties:false 的输出
 * schema 因此只有一个 item 形状）：describe 不算 median/stddev，stats 对非数值列给出 reason。
 * @param column - 列名。
 * @param values - 该列原始值。
 * @param mode - `describe` 或 `stats`。
 * @returns 列元信息。
 */
function describeColumn(column, values, mode) {
  const type = inferType(values)
  const missing = values.filter((value) => isBlank(value)).length
  const count = values.length - missing
  const distinct = distinctCount(values)
  const base = { column, type, count, missing, distinct, numeric: type === 'number' }

  if (type === 'number') {
    const summary = numericSummary(values)
    return {
      ...base,
      min: summary.min,
      max: summary.max,
      mean: summary.mean,
      median: mode === 'stats' ? summary.median : null,
      stddev: mode === 'stats' ? summary.stddev : null,
      reason: '',
    }
  }

  const reason = mode !== 'stats'
    ? ''
    : type === 'empty'
      ? `column "${column}" has no non-empty values`
      : `column "${column}" is typed "${type}", not "number"; only numeric columns get min/max/mean/median/stddev`
  return { ...base, min: null, max: null, mean: null, median: null, stddev: null, reason }
}

/* ------------------------------------------------------------------ *
 * 渲染（纯文本表格；任何输入都不允许抛异常）
 * ------------------------------------------------------------------ */

/** 把任意单元格值压成单行、定长的可读文本。 */
function formatCell(value) {
  let text
  if (value === null || value === undefined) text = ''
  else if (typeof value === 'string') text = value
  else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : 'null'
  else text = String(value)
  text = text
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
  if (text.length > MAX_CELL_CHARS) text = `${text.slice(0, MAX_CELL_CHARS - 1)}…`
  return text
}

/** 拼接一行单元格并按列宽补齐。 */
function joinCells(cells, widths) {
  const parts = []
  for (let i = 0; i < cells.length; i += 1) parts.push(cells[i].padEnd(widths[i], ' '))
  return parts.join(' | ').replace(/\s+$/, '')
}

/** 渲染等宽网格，并返回实际显示的列数/行数。 */
function renderGrid(header, rows, options = {}) {
  const maxRows = options.maxRows ?? MAX_RENDER_ROWS
  const maxColumns = options.maxColumns ?? MAX_RENDER_COLUMNS
  const columnCount = Math.max(0, Math.min(header.length, maxColumns))
  const shownRows = rows.slice(0, maxRows)
  const headerCells = header.slice(0, columnCount).map(formatCell)
  const bodyCells = shownRows.map((row) => {
    const cells = []
    for (let i = 0; i < columnCount; i += 1) cells.push(formatCell(Array.isArray(row) ? row[i] : undefined))
    return cells
  })

  const widths = headerCells.map((cell, i) => {
    let width = Math.max(1, cell.length)
    for (const row of bodyCells) if (row[i].length > width) width = row[i].length
    return width
  })

  const lines = [joinCells(headerCells, widths), widths.map((width) => '-'.repeat(width)).join('-+-')]
  for (const row of bodyCells) lines.push(joinCells(row, widths))
  return { lines, shownColumns: columnCount, shownRows: shownRows.length }
}

/** 数字的渲染形式；非有限值显示 `?`。 */
function displayCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '?'
}

/** 数字的渲染形式；null / 非有限值显示 `-`。 */
function displayNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-'
}

/** 渲染前的行数上限收敛，超出部分直接丢行并提示。 */
function capLines(lines) {
  const out = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > MAX_RENDER_CHARS) {
      out.push(`…[渲染文本已截断：完整文本约 ${lines.join('\n').length} 字符，上限 ${MAX_RENDER_CHARS}]`)
      break
    }
    out.push(line)
    size += line.length + 1
  }
  return out.join('\n')
}

/** 参差行的提示后缀。 */
function raggedSuffix(value) {
  const ragged = typeof value?.raggedRows === 'number' && Number.isFinite(value.raggedRows) ? value.raggedRows : 0
  return ragged > 0 ? `，参差行 ${ragged}` : ''
}

/** describe / stats 的文本渲染。 */
function renderInfoResult(op, value) {
  const info = Array.isArray(value?.columnInfo) ? value.columnInfo : []
  const lines = [`${op}：${info.length} 列 / ${displayCount(value?.totalRows)} 行数据${raggedSuffix(value)}`]
  if (info.length === 0) {
    lines.push('(无数据)')
    return lines
  }

  const header = op === 'stats'
    ? ['列', '类型', '非空', '缺失', '最小', '最大', '均值', '中位', '标准差']
    : ['列', '类型', '非空', '缺失', '去重', '最小', '最大', '均值']
  const rows = info.map((item) => (op === 'stats'
    ? [
      item?.column, item?.type, displayCount(item?.count), displayCount(item?.missing),
      displayNumber(item?.min), displayNumber(item?.max), displayNumber(item?.mean),
      displayNumber(item?.median), displayNumber(item?.stddev),
    ]
    : [
      item?.column, item?.type, displayCount(item?.count), displayCount(item?.missing),
      displayCount(item?.distinct), displayNumber(item?.min), displayNumber(item?.max), displayNumber(item?.mean),
    ]))

  const grid = renderGrid(header, rows)
  lines.push(...grid.lines)
  if (grid.shownRows < rows.length) lines.push(`…仅显示前 ${grid.shownRows} 列（共 ${rows.length} 列）`)

  const reasons = info
    .filter((item) => typeof item?.reason === 'string' && item.reason.length > 0)
    .slice(0, 8)
    .map((item) => `注：${item.reason}`)
  lines.push(...reasons)
  if (info.filter((item) => typeof item?.reason === 'string' && item.reason.length > 0).length > reasons.length) {
    lines.push('注：其余非数值列的说明已省略')
  }
  return lines
}

/** parse / query 的文本渲染。 */
function renderDataResult(op, value) {
  const rows = Array.isArray(value?.rows) ? value.rows : []
  const declared = Array.isArray(value?.columns) ? value.columns.map((column) => String(column)) : []
  const columns = declared.length > 0
    ? declared
    : (rows.length > 0 && rows[0] !== null && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [])

  const head = op === 'query'
    ? `query：命中 ${displayCount(value?.matchedRows)} / ${displayCount(value?.totalRows)} 行，返回 ${rows.length} 行`
    : `parse：返回 ${rows.length} / ${displayCount(value?.totalRows)} 行`
  const lines = [head + raggedSuffix(value)]

  if (rows.length === 0) {
    lines.push('(无数据)')
  } else {
    const matrix = rows.map((row) => columns.map((column) => (
      row !== null && typeof row === 'object' ? row[column] : undefined
    )))
    const grid = renderGrid(columns, matrix)
    lines.push(...grid.lines)
    if (grid.shownColumns < columns.length) lines.push(`…仅显示前 ${grid.shownColumns} 列（共 ${columns.length} 列）`)
    if (grid.shownRows < matrix.length) lines.push(`…仅显示前 ${grid.shownRows} 行（共 ${matrix.length} 行）`)
  }

  if (value?.truncated === true) lines.push(`[已按 limit 截断：结果里只有前 ${rows.length} 行]`)
  return lines
}

/**
 * 渲染入口：任何 value 都不允许让 render 抛异常。
 * @param value - execute 的返回值。
 * @returns 纯文本。
 */
function renderCsvResult(value) {
  try {
    const op = typeof value?.op === 'string' ? value.op : '?'
    const lines = op === 'describe' || op === 'stats' ? renderInfoResult(op, value) : renderDataResult(op, value)
    const notes = Array.isArray(value?.notes) ? value.notes.filter((note) => typeof note === 'string' && note.length > 0) : []
    for (const note of notes) lines.push(`注：${note}`)
    return capLines(lines)
  } catch (error) {
    return `csv 结果渲染失败（结果本身仍有效）：${error instanceof Error ? error.message : String(error)}`
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 收敛 limit：默认 50，至少 1，最多 MAX_LIMIT。 */
function normalizeLimit(raw, notes) {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`limit 必须是数字，收到 ${JSON.stringify(raw)}`)
  const floored = Math.floor(parsed)
  if (floored < 1) throw new Error(`limit 至少为 1，收到 ${JSON.stringify(raw)}`)
  if (floored > MAX_LIMIT) {
    notes.push(`limit 上限为 ${MAX_LIMIT}，已按 ${MAX_LIMIT} 处理（请求 ${floored}）`)
    return MAX_LIMIT
  }
  return floored
}

/** parse / query 的结果组装。 */
function runRowOperation(op, table, args, notes) {
  const limit = normalizeLimit(args.limit, notes)
  const selected = selectColumns(table.columns, args.select)
  const sourceIndexes = selected.map((column) => table.columns.indexOf(column))
  const hasHeader = table.hasHeader

  let candidates = table.dataRows
  let matchedRows = null

  if (op === 'query') {
    const expression = typeof args.where === 'string' ? args.where.trim() : ''
    if (expression.length === 0) {
      notes.push('op=query 但没有给出 where，返回全部行')
    } else {
      const ast = parseWhere(expression)
      resolveWhereColumns(ast, table.columns)
      candidates = table.dataRows.filter((row) => evaluateWhere(ast, row))
    }
    matchedRows = candidates.length
  }

  const returned = candidates.slice(0, limit)
  const rows = returned.map((row) => projectRow(row, selected, sourceIndexes))
  const truncated = returned.length < candidates.length

  return {
    op,
    columns: selected,
    rows,
    columnInfo: [],
    totalRows: table.dataRows.length,
    returnedRows: rows.length,
    matchedRows,
    truncated,
    raggedRows: table.raggedRows,
    notes,
  }
}

/** describe / stats 的结果组装。 */
function runColumnOperation(op, table, args, notes) {
  const selected = selectColumns(table.columns, args.select)
  const columnInfo = selected.map((column) => {
    const at = table.columns.indexOf(column)
    const values = table.dataRows.map((row) => (at < row.length ? row[at] : ''))
    return describeColumn(column, values, op === 'stats' ? 'stats' : 'describe')
  })

  return {
    op,
    columns: selected,
    rows: [],
    columnInfo,
    totalRows: table.dataRows.length,
    returnedRows: 0,
    matchedRows: null,
    truncated: false,
    raggedRows: table.raggedRows,
    notes,
  }
}

/**
 * 注册 CSV 工具。
 * @param ctx - 挂载上下文；插件只使用 `tools` 注册表。
 */
export function apply(ctx) {
  ctx.tools.register(toToolDefinition({
    name: 'csv',
    description: 'Parse, query and summarise RFC 4180 CSV text passed directly as a string (never a file path). Handles quoted fields, escaped double quotes (""), embedded delimiters/newlines and both LF and CRLF endings. Ops: "parse" returns rows as objects; "describe" infers a type per column (number|boolean|date|string|empty) with counts; "query" filters with a small `column OP literal` grammar joined by and/or; "stats" gives count/min/max/mean/median/sample-stddev for numeric columns. Input is capped at 262144 characters.',
    parameters: {
      csv: { type: 'string', required: true, description: 'The CSV text itself, not a path; at most 262144 characters.' },
      op: { type: 'string', required: true, enum: OPS, description: 'Operation: "parse" rows, "describe" column types, "query" filter with where, "stats" numeric summary.' },
      delimiter: { type: 'string', description: 'Single-character field delimiter (default ","); pass "\\t" for a tab.' },
      hasHeader: { type: 'boolean', description: 'Treat the first row as a header (default true); when false the columns are named col0, col1, ...' },
      select: { type: 'string', description: 'Comma-separated column names (or 0-based indices) to keep, for every op; default all columns. A token is read as an index only when no column has that name.' },
      where: { type: 'string', description: 'Filter expression, only for op "query": clauses `column OP literal` joined by and/or (and binds tighter, parentheses allowed). OP is one of = != > >= < <= contains startswith endswith; literal is a number or a quoted string. Numeric comparison when both sides are finite numbers, otherwise case-sensitive string comparison.' },
      limit: { type: 'number', description: `Maximum rows returned by "parse" and "query" (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', required: true },
          columns: { type: 'array', required: true, items: { type: 'string' } },
          rows: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          columnInfo: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              // 作者方言：required 只能以 `true` 写在**属性节点**上，由编译器收拢成父对象的
              // required 数组。直接写 `required: [...]`（原始子集的写法）会被 DSL 判为
              // "not supported by the value schema DSL"，整个插件随之挂不上。
              properties: {
                column: { type: 'string', required: true },
                type: { type: 'string', required: true, enum: ['number', 'boolean', 'date', 'string', 'empty'] },
                count: { type: 'number', required: true },
                missing: { type: 'number', required: true },
                distinct: { type: 'number', required: true },
                min: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                max: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                mean: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                median: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                stddev: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                numeric: { type: 'boolean', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          totalRows: { type: 'number', required: true },
          returnedRows: { type: 'number', required: true },
          matchedRows: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          truncated: { type: 'boolean', required: true },
          raggedRows: { type: 'number', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCsvResult(value) }],
    },
    async execute(args) {
      const input = args ?? {}
      const text = typeof input.csv === 'string' ? input.csv : ''
      if (text.length > MAX_INPUT_CHARS) {
        throw new Error(`CSV 文本过长：${text.length} 个字符，超过上限 ${MAX_INPUT_CHARS} 个字符（256 KB）；请先裁剪或改用 op=query/limit 缩小范围`)
      }
      if (text.trim().length === 0) {
        throw new Error('CSV 文本为空：csv 参数要的是 CSV 正文（字符串），不是文件路径')
      }

      const op = typeof input.op === 'string' ? input.op.trim().toLowerCase() : ''
      if (!OPS.includes(op)) {
        throw new Error(`不支持的 op ${JSON.stringify(input.op)}；可用：${OPS.join(' | ')}`)
      }

      const table = prepareTable(input)
      const notes = [...table.notes]
      if (op !== 'query' && typeof input.where === 'string' && input.where.trim().length > 0) {
        notes.push('where 仅在 op=query 时生效，本次已忽略')
      }

      return op === 'describe' || op === 'stats'
        ? runColumnOperation(op, table, input, notes)
        : runRowOperation(op, table, input, notes)
    },
  }))
}
