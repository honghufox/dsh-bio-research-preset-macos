/**
 * dsh-tool-stat —— 描述性统计工具（宿主平面：零依赖、纯函数、无 I/O）。
 *
 * 为什么要有这个工具：模型手算均值/方差/分位数既慢又容易错，而为了四则运算写一个
 * 一次性脚本会污染工作区、还要处理解释器差异。这里把四种最常用的统计运算直接做成
 * 宿主工具，数值算法一律采用成熟实现的定义：
 *
 *   - Neumaier 补偿求和（sum + compensation）：均值以及每一处「逐步累加」的方差/
 *     协方差累加器都走它，避免大数吃小数；
 *   - Welford 在线算法：方差、标准差、协动量的递推形式，数值上比 Σx² - (Σx)²/n 稳定；
 *     样本分母一律 n-1，n < 2 时相关统计量返回 null，而不是编造 0；
 *   - 线性插值分位数：与 NumPy 默认的 method='linear' 一致，index = p*(n-1)，
 *     在 sorted[floor(index)] 与 sorted[ceil(index)] 之间线性插值；
 *   - Spearman：先把两条序列转成 midrank（并列值取其所跨名次的算术平均），再套 Pearson；
 *     不使用 1 - 6Σd²/(n(n²-1)) 近似式——有并列时那个式子是错的。
 *
 * 数据卫生（对每个 op 都生效）：元素必须是有限数值。null / undefined / NaN / ±Infinity /
 * 非 number 一律报错并指出下标，工具**不会静默丢弃**缺失值；调用方应先自行过滤。
 * 输出里每个数字要么是有限值，要么是显式 null（null = 该统计量在当前输入下无定义）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const name = 'dsh-tool-stat'
export const inject = ['tools']

/** 'percentile' 未给 percentiles 时使用的概率（百分数，0-100）。 */
const DEFAULT_PERCENTILES = [25, 50, 75]
/** 'frequency' 未给 binEdges 时的默认分箱数。 */
const DEFAULT_BIN_COUNT = 10
/** 'correlation' 的默认系数类型。 */
const DEFAULT_CORRELATION_METHOD = 'pearson'
/** 相关系数上报的小数位。 */
const CORRELATION_DIGITS = 6
/** 文本直方图的最大列宽。 */
const BAR_MAX_WIDTH = 40

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

// ---------------------------------------------------------------------------
// 输出 schema 片段
//
// 宿主对**原始**工具输出 schema 有两条硬约束（dsh-tools 的 raw 子集校验）：
//   1. 不支持 type 数组（['number', 'null'] 会被拒），可空字段只能用 oneOf；
//   2. `required` 只能写在 object 节点上、且必须是字符串数组——写在标量或 oneOf 节点旁
//      会被判为非法（"required is not supported on type \"number\"" / "beside oneOf"）。
// 而 defineTool 的 author 方言恰好相反：它在属性对象里用 `required: true` 简写
// （参考实现 dsh-cluster-ssh 就是这个写法），由编译器把它收进父对象的 required 数组。
// 两条路径现在都由下游编译：defineTool 自己编译作者方言；原始回退路径由
// `compileAuthorValueSchema` 收拢。所以属性节点一律写作者方言的简写即可，
// 输出契约在两条路上完全一致：本工具永远返回全部键，声明侧的 required 只影响
// PTC 生成 SDK 类型时字段是否可选。
//
// 注意：同一个 schema 对象实例不能在一棵树里出现两次（raw 校验会判 circular），
// 所以这些节点一律用工厂函数现造。
// ---------------------------------------------------------------------------

/**
 * 属性节点的 `required` 标记（作者方言）。
 *
 * 两条路径都由下游收拢：`defineTool` 自己会编译作者方言；走原始 ToolDefinition
 * 回退时由 `compileAuthorValueSchema` 把它汇总到父对象的 `required` 数组。
 * 所以这里无条件写 `required: true`，而不是按宿主包能否解析二选一。
 */
function requiredMarker() {
  return { required: true }
}

/** 可选 description 注解。 */
function annotation(description) {
  return description === undefined ? {} : { description }
}

/** 数值属性节点。 */
function numberProperty(description) {
  return { type: 'number', ...requiredMarker(), ...annotation(description) }
}

/** 字符串属性节点。 */
function stringProperty(description) {
  return { type: 'string', ...requiredMarker(), ...annotation(description) }
}

/** 可空数值属性节点：null 表示该统计量在当前输入下无定义，绝不是编造的 0。 */
function nullableNumberProperty(description) {
  return { oneOf: [{ type: 'number' }, { type: 'null' }], ...requiredMarker(), ...annotation(description) }
}

/** 可空字符串属性节点。 */
function nullableStringProperty(description) {
  return { oneOf: [{ type: 'string' }, { type: 'null' }], ...requiredMarker(), ...annotation(description) }
}

// ---------------------------------------------------------------------------
// 输入校验与规范化
// ---------------------------------------------------------------------------

/** 把任意值描述成可读片段，供错误信息使用。 */
function describeValue(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value)
  if (typeof value === 'string') return `字符串 ${JSON.stringify(value)}`
  if (typeof value === 'boolean') return `布尔 ${String(value)}`
  if (Array.isArray(value)) return '数组'
  if (typeof value === 'object') return '对象'
  return typeof value
}

/**
 * 校验并复制一列样本。
 *
 * 这是本工具的数据卫生闸门：任何非有限数值都在这里被拒绝，并指出具体下标。
 * 同时把 -0 归一成 0——宿主把 -0 视为「非 JSON 数值」，会在输出校验阶段直接报错。
 * @param raw - 模型传入的候选数组。
 * @param label - 参数名，用于错误信息。
 * @param options - `allowEmpty` 是否允许空数组；`hint` 缺失/为空时的补充说明。
 * @returns 干净的有限数值数组。
 */
function toFiniteSeries(raw, label, options = {}) {
  const { allowEmpty = false, hint = '该 op 需要一个数值数组（每个元素都必须是有限数值）' } = options
  if (raw === undefined || raw === null) throw new Error(`${label} 缺失：${hint}`)
  if (!Array.isArray(raw)) throw new Error(`${label} 必须是数值数组，实际收到 ${describeValue(raw)}`)
  if (raw.length === 0 && allowEmpty !== true) throw new Error(`${label} 是空数组：该 op 至少需要 1 个观测`)
  const series = new Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label}[${index}] 不是有限数值（收到 ${describeValue(value)}）：本工具不静默丢弃缺失值，请先过滤后再调用`)
    }
    series[index] = value === 0 ? 0 : value
  }
  return series
}

/** 校验 'percentile' 的概率列表：每个都在 [0, 100]（百分数，不是 0-1）。 */
function toProbabilities(raw) {
  const list = raw === undefined || raw === null ? DEFAULT_PERCENTILES : raw
  if (!Array.isArray(list)) throw new Error(`percentiles 必须是数值数组，实际收到 ${describeValue(list)}`)
  if (list.length === 0) throw new Error('percentiles 是空数组：至少需要 1 个概率')
  return list.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`percentiles[${index}] 不是有限数值（收到 ${describeValue(value)}）：概率用 0-100 的百分数表示，不是 0-1`)
    }
    if (value < 0 || value > 100) {
      throw new Error(`percentiles[${index}] = ${value} 越界：概率必须落在 [0, 100] 内（0-100 的百分数，不是 0-1）`)
    }
    return value === 0 ? 0 : value
  })
}

/** 校验 'frequency' 的显式分箱边界：至少 2 个且严格递增。 */
function toBinEdges(raw) {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error(`binEdges 必须是数值数组，实际收到 ${describeValue(raw)}`)
  if (raw.length < 2) throw new Error(`binEdges 至少需要 2 个边界，实际只有 ${raw.length} 个`)
  const edges = toFiniteSeries(raw, 'binEdges', { hint: 'binEdges 是一列严格递增的数值边界' })
  for (let index = 1; index < edges.length; index += 1) {
    if (!(edges[index] > edges[index - 1])) {
      throw new Error(`binEdges 必须严格递增：binEdges[${index}] = ${edges[index]} 不大于 binEdges[${index - 1}] = ${edges[index - 1]}`)
    }
  }
  return edges
}

/** 校验 'frequency' 的分箱数：正整数。 */
function toBinCount(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BIN_COUNT
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`bins 必须是正整数，实际收到 ${describeValue(raw)}`)
  if (!Number.isInteger(raw) || raw < 1) throw new Error(`bins 必须是正整数，实际收到 ${raw}`)
  return raw
}

/** 校验 'correlation' 的系数类型。 */
function toCorrelationMethod(raw) {
  if (raw === undefined || raw === null) return DEFAULT_CORRELATION_METHOD
  if (raw !== 'pearson' && raw !== 'spearman') {
    throw new Error(`method 只能是 pearson 或 spearman，实际收到 ${describeValue(raw)}`)
  }
  return raw
}

// ---------------------------------------------------------------------------
// 数值算法
// ---------------------------------------------------------------------------

/** 补偿累加器的初值：主项 + 舍入补偿项。 */
function newAccumulator() {
  return { sum: 0, compensation: 0 }
}

/**
 * 一步 Neumaier 补偿累加：把 `increment` 加进累加器，舍入损失记进补偿项。
 * Welford 的 m2 与协动量同样是「一步步加出来的和」，因此适用同一套补偿逻辑。
 */
function compensatedAdd(accumulator, increment) {
  const next = accumulator.sum + increment
  if (Math.abs(accumulator.sum) >= Math.abs(increment)) accumulator.compensation += (accumulator.sum - next) + increment
  else accumulator.compensation += (increment - next) + accumulator.sum
  accumulator.sum = next
}

/** 取补偿和的最终值。 */
function compensatedTotal(accumulator) {
  return accumulator.sum + accumulator.compensation
}

/** Neumaier 补偿求和。 */
function neumaierSum(values) {
  const accumulator = newAccumulator()
  for (const value of values) compensatedAdd(accumulator, value)
  return compensatedTotal(accumulator)
}

/** 数值升序排序（不是字典序）。 */
function sortedNumeric(values) {
  return [...values].sort((a, b) => a - b)
}

/**
 * Welford 在线方差：返回累加出的 m2（Σ(x-mean)²），样本方差 = m2/(n-1)。
 * 这里既用 Welford 的递推，也用 Neumaier 补偿保存累加过程。
 */
function welfordM2(values) {
  let count = 0
  let mean = 0
  const accumulator = newAccumulator()
  for (const value of values) {
    count += 1
    const delta = value - mean
    mean += delta / count
    compensatedAdd(accumulator, delta * (value - mean))
  }
  return { n: count, mean, m2: compensatedTotal(accumulator) }
}

/**
 * 在线协动量（Welford 的二元推广）：同时得到两列的 m2 与协动量 Σ(x-meanX)(y-meanY)。
 * 协方差 = coMoment/(n-1)，标准差 = sqrt(m2/(n-1))，均由这些累加器导出。
 */
function onlineCoMoment(xs, ys) {
  let count = 0
  let meanX = 0
  let meanY = 0
  const m2X = newAccumulator()
  const m2Y = newAccumulator()
  const coMoment = newAccumulator()
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index]
    const y = ys[index]
    count += 1
    const dx = x - meanX
    meanX += dx / count
    const dy = y - meanY
    meanY += dy / count
    compensatedAdd(m2X, dx * (x - meanX))
    compensatedAdd(m2Y, dy * (y - meanY))
    compensatedAdd(coMoment, dx * (y - meanY))
  }
  return { n: count, meanX, meanY, m2X: compensatedTotal(m2X), m2Y: compensatedTotal(m2Y), coMoment: compensatedTotal(coMoment) }
}

/**
 * 线性插值分位数（NumPy 默认 method='linear'）。
 * index = (p/100) * (n-1)，在 sorted[floor(index)] 与 sorted[ceil(index)] 之间插值；
 * p=0 返回最小值，p=100 返回最大值。
 * @param sorted - 已按数值升序排好的数组（非空）。
 * @param probability - 概率，0-100 的百分数。
 * @returns 插值结果。
 */
function percentileOfSorted(sorted, probability) {
  const n = sorted.length
  const index = (probability / 100) * (n - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  const weight = index - lower
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight
}

/**
 * 把一列数值转成 midrank（名次 1-based）。
 * 并列值共享其所跨名次区间的算术平均：这是 Spearman 在有并列时仍然正确的前提。
 */
function midranks(values) {
  const n = values.length
  const order = new Array(n)
  for (let index = 0; index < n; index += 1) order[index] = index
  // 并列时再用原下标定序，保证结果确定
  order.sort((a, b) => (values[a] - values[b]) || (a - b))
  const ranks = new Array(n)
  let start = 0
  while (start < n) {
    let end = start
    while (end + 1 < n && values[order[end + 1]] === values[order[start]]) end += 1
    const midrank = (start + 1 + (end + 1)) / 2
    for (let index = start; index <= end; index += 1) ranks[order[index]] = midrank
    start = end + 1
  }
  return ranks
}

/** 有限值 → 原值；非有限值/-0 → null 或 0，确保输出永远不是 NaN/Infinity/-0。 */
function finiteOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value === 0 ? 0 : value
}

/** 四舍五入到指定小数位；非有限值返回 null。 */
function roundTo(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  const scaled = value * factor
  if (!Number.isFinite(scaled)) return null
  const rounded = Math.round(scaled) / factor
  if (!Number.isFinite(rounded)) return null
  return rounded === 0 ? 0 : rounded
}

// ---------------------------------------------------------------------------
// 各 op 的实现（纯函数）
// ---------------------------------------------------------------------------

/**
 * 所有 op 共用的结果骨架：不适用的字段一律显式 null。
 * 输出 schema 是 additionalProperties:false 的固定形状，因此每个 op 都必须返回完整键集。
 */
function emptyResult(op, n) {
  return {
    op,
    n,
    missing: 0,
    min: null,
    max: null,
    range: null,
    mean: null,
    median: null,
    variance: null,
    stdDev: null,
    standardError: null,
    sum: null,
    coefficientOfVariation: null,
    percentiles: null,
    binRule: null,
    intervalRule: null,
    bins: null,
    totalCount: null,
    totalRelativeFrequency: null,
    method: null,
    coefficient: null,
    rSquared: null,
  }
}

/** describe：位置、离散度与形状的常用摘要。 */
function describeOp(rawValues) {
  const values = toFiniteSeries(rawValues, 'values')
  const n = values.length
  const sorted = sortedNumeric(values)
  const sum = neumaierSum(values)
  const mean = sum / n
  const { m2 } = welfordM2(values)
  const variance = n >= 2 ? m2 / (n - 1) : null
  const stdDev = variance === null ? null : Math.sqrt(variance)
  const standardError = stdDev === null ? null : stdDev / Math.sqrt(n)
  const coefficientOfVariation = stdDev === null || mean === 0 ? null : stdDev / mean
  return {
    ...emptyResult('describe', n),
    min: finiteOrNull(sorted[0]),
    max: finiteOrNull(sorted[n - 1]),
    range: finiteOrNull(sorted[n - 1] - sorted[0]),
    mean: finiteOrNull(mean),
    median: finiteOrNull(percentileOfSorted(sorted, 50)),
    variance: finiteOrNull(variance),
    stdDev: finiteOrNull(stdDev),
    standardError: finiteOrNull(standardError),
    sum: finiteOrNull(sum),
    coefficientOfVariation: finiteOrNull(coefficientOfVariation),
  }
}

/** percentile：按线性插值给出指定概率的分位数。 */
function percentileOp(rawValues, rawPercentiles) {
  const values = toFiniteSeries(rawValues, 'values')
  const probabilities = toProbabilities(rawPercentiles)
  const sorted = sortedNumeric(values)
  const n = values.length
  return {
    ...emptyResult('percentile', n),
    min: finiteOrNull(sorted[0]),
    max: finiteOrNull(sorted[n - 1]),
    median: finiteOrNull(percentileOfSorted(sorted, 50)),
    percentiles: probabilities.map((probability) => ({
      probability,
      value: finiteOrNull(percentileOfSorted(sorted, probability)),
    })),
  }
}

/** frequency：频数表；未给边界时按 [min, max] 等宽分箱，min === max 时退化为单箱。 */
function frequencyOp(rawValues, rawBins, rawBinEdges) {
  const values = toFiniteSeries(rawValues, 'values')
  const n = values.length
  const edges = toBinEdges(rawBinEdges)

  let boundaries
  let binRule
  if (edges !== undefined) {
    boundaries = edges
    binRule = 'explicit binEdges'
    const lowest = boundaries[0]
    const highest = boundaries[boundaries.length - 1]
    // 显式边界不覆盖全部观测时直接报错：静默丢弃区间外的点会让频数表撒谎
    for (let index = 0; index < n; index += 1) {
      const value = values[index]
      if (value < lowest || value > highest) {
        throw new Error(`values[${index}] = ${value} 落在 binEdges 覆盖范围 [${lowest}, ${highest}] 之外：请先过滤或放宽边界（本工具不静默丢弃观测）`)
      }
    }
  } else {
    const binCount = toBinCount(rawBins)
    const sorted = sortedNumeric(values)
    const min = sorted[0]
    const max = sorted[n - 1]
    if (min === max) {
      // 全部观测同值：不能除以零宽，直接给一个容纳所有值的单箱
      boundaries = [min, max]
      binRule = 'degenerate (min === max): single bin'
    } else {
      const width = (max - min) / binCount
      boundaries = new Array(binCount + 1)
      for (let index = 0; index <= binCount; index += 1) boundaries[index] = min + width * index
      // 末边界钉在真实最大值上，避免浮点误差在尾部留缝
      boundaries[binCount] = max
      binRule = `${binCount} equal-width bins over [min, max]`
    }
  }

  const binCount = boundaries.length - 1
  const counts = new Array(binCount).fill(0)
  for (const value of values) {
    for (let index = 0; index < binCount; index += 1) {
      const from = boundaries[index]
      const to = boundaries[index + 1]
      const isLast = index === binCount - 1
      // 半开区间 [from, to)，最后一个箱取闭区间 [from, to]
      if (value >= from && (isLast ? value <= to : value < to)) {
        counts[index] += 1
        break
      }
    }
  }

  const bins = []
  let totalCount = 0
  let totalRelativeFrequency = 0
  for (let index = 0; index < binCount; index += 1) {
    const count = counts[index]
    const relativeFrequency = count / n
    totalCount += count
    totalRelativeFrequency += relativeFrequency
    bins.push({
      from: finiteOrNull(boundaries[index]),
      to: finiteOrNull(boundaries[index + 1]),
      count,
      relativeFrequency: finiteOrNull(relativeFrequency),
    })
  }

  return {
    ...emptyResult('frequency', n),
    binRule,
    intervalRule: 'half-open [from, to) except the last bin, which is closed [from, to]',
    bins,
    totalCount,
    totalRelativeFrequency: finiteOrNull(totalRelativeFrequency),
  }
}

/** correlation：Pearson，或「先转 midrank 再 Pearson」的 Spearman。 */
function correlationOp(rawValues, rawValues2, rawMethod) {
  const method = toCorrelationMethod(rawMethod)
  const first = toFiniteSeries(rawValues, 'values', { hint: 'correlation 需要两条等长数值序列，values 是第一条' })
  const second = toFiniteSeries(rawValues2, 'values2', { hint: 'correlation 需要两条等长数值序列，values2 是第二条' })
  if (first.length !== second.length) {
    throw new Error(`correlation 要求两条序列等长：values 有 ${first.length} 个观测，values2 有 ${second.length} 个`)
  }
  const n = first.length
  if (n < 3) throw new Error(`correlation 至少需要 3 对观测，实际只有 ${n} 对`)

  const xs = method === 'spearman' ? midranks(first) : first
  const ys = method === 'spearman' ? midranks(second) : second
  const { m2X, m2Y, coMoment } = onlineCoMoment(xs, ys)
  const suffix = method === 'spearman' ? '（Spearman 名次序列）' : ''
  // 常数序列方差为 0，相关系数没有定义：直接报错，而不是返回 NaN
  if (!(m2X > 0)) throw new Error(`correlation 拒绝常数序列：values${suffix} 的方差为 0，相关系数无定义`)
  if (!(m2Y > 0)) throw new Error(`correlation 拒绝常数序列：values2${suffix} 的方差为 0，相关系数无定义`)

  const rawCoefficient = coMoment / Math.sqrt(m2X * m2Y)
  if (!Number.isFinite(rawCoefficient)) throw new Error('correlation 无法得到有限系数：数值溢出')
  // 浮点误差可能给出 1.0000000000000002，夹到 [-1, 1] 后按 6 位小数上报
  const coefficient = roundTo(Math.max(-1, Math.min(1, rawCoefficient)), CORRELATION_DIGITS)
  return {
    ...emptyResult('correlation', n),
    method,
    coefficient,
    rSquared: method === 'pearson' && coefficient !== null ? roundTo(coefficient * coefficient, CORRELATION_DIGITS) : null,
  }
}

// ---------------------------------------------------------------------------
// 文本渲染（宿主会校验 output.schema 并冻结 value，render 只读且绝不允许抛错）
// ---------------------------------------------------------------------------

/** 渲染用数值格式化：null/非有限值显示为 null，永不抛错。 */
function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'null'
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e15)) return value.toExponential(6)
  return String(Number(value.toFixed(6)))
}

/** 把 [标签, 文本] 对渲染成对齐的键值行。 */
function formatPairs(pairs) {
  let width = 0
  for (const [label] of pairs) width = Math.max(width, label.length)
  return pairs.map(([label, text]) => `${label.padEnd(width)}  ${text}`).join('\n')
}

/** 描述性统计的公共抬头行。 */
function commonPairs(op, result) {
  return [
    ['op', op],
    ['n', formatNumber(result.n)],
    ['missing', formatNumber(result.missing)],
  ]
}

/** 分位数表格：p25 之类的标签 + 数值。 */
function formatPercentiles(items) {
  if (!Array.isArray(items) || items.length === 0) return '(无)'
  return formatPairs(items.map((item) => {
    const entry = item !== null && typeof item === 'object' ? item : {}
    return [`p${formatNumber(entry.probability)}`, formatNumber(entry.value)]
  }))
}

/** 频数表的 ASCII 直方图：块字符列宽上限 BAR_MAX_WIDTH。 */
function renderHistogram(bins) {
  if (!Array.isArray(bins) || bins.length === 0) return '(无分箱)'
  const rows = []
  const labels = []
  let labelWidth = 0
  let maxCount = 0
  const last = bins.length - 1
  for (let index = 0; index < bins.length; index += 1) {
    const bin = bins[index] !== null && typeof bins[index] === 'object' ? bins[index] : {}
    const count = typeof bin.count === 'number' && Number.isFinite(bin.count) ? bin.count : 0
    if (count > maxCount) maxCount = count
    // 最后一个分箱是闭区间，用 ] 收尾
    const label = `[${formatNumber(bin.from)}, ${formatNumber(bin.to)}${index === last ? ']' : ')'}`
    labels.push(label)
    labelWidth = Math.max(labelWidth, label.length)
  }
  for (let index = 0; index < bins.length; index += 1) {
    const bin = bins[index] !== null && typeof bins[index] === 'object' ? bins[index] : {}
    const count = typeof bin.count === 'number' && Number.isFinite(bin.count) ? bin.count : 0
    const relative = formatNumber(bin.relativeFrequency)
    const bar = maxCount > 0 && count > 0
      ? '█'.repeat(Math.max(1, Math.min(BAR_MAX_WIDTH, Math.round((count / maxCount) * BAR_MAX_WIDTH))))
      : ''
    rows.push(`${labels[index].padEnd(labelWidth)}  ${String(count).padStart(4)}  ${relative.padStart(8)}  ${bar}`)
  }
  return rows.join('\n')
}

/** 按 op 渲染紧凑文本摘要；任何形状的 value 都必须能安全走完。 */
function renderStat(value) {
  const result = value !== null && typeof value === 'object' ? value : {}
  const op = typeof result.op === 'string' ? result.op : '(未知)'
  if (op === 'describe') {
    return formatPairs([
      ...commonPairs(op, result),
      ['min', formatNumber(result.min)],
      ['max', formatNumber(result.max)],
      ['range', formatNumber(result.range)],
      ['mean', formatNumber(result.mean)],
      ['median', formatNumber(result.median)],
      ['variance', formatNumber(result.variance)],
      ['stdDev', formatNumber(result.stdDev)],
      ['stdError', formatNumber(result.standardError)],
      ['sum', formatNumber(result.sum)],
      ['cv', formatNumber(result.coefficientOfVariation)],
    ])
  }
  if (op === 'percentile') {
    return [
      formatPairs([
        ...commonPairs(op, result),
        ['min', formatNumber(result.min)],
        ['max', formatNumber(result.max)],
        ['median', formatNumber(result.median)],
      ]),
      '',
      'percentiles (linear interpolation)',
      formatPercentiles(result.percentiles),
    ].join('\n')
  }
  if (op === 'frequency') {
    return [
      formatPairs([
        ...commonPairs(op, result),
        ['binRule', typeof result.binRule === 'string' ? result.binRule : 'null'],
        ['interval', typeof result.intervalRule === 'string' ? result.intervalRule : 'null'],
        ['totalCount', formatNumber(result.totalCount)],
        ['totalRelFreq', formatNumber(result.totalRelativeFrequency)],
      ]),
      '',
      renderHistogram(result.bins),
    ].join('\n')
  }
  if (op === 'correlation') {
    return formatPairs([
      ...commonPairs(op, result),
      ['method', typeof result.method === 'string' ? result.method : 'null'],
      ['coefficient', formatNumber(result.coefficient)],
      ['rSquared', formatNumber(result.rSquared)],
    ])
  }
  return `未知的 stat 输出：op=${op}`
}

/** 安全地把异常转成文本（String() 本身也可能抛）。 */
function errorText(error) {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch (cause) {
    return '未知错误'
  }
}

/**
 * 注册统计工具。
 * @param ctx - 挂载上下文；插件只使用 `tools` 注册表。
 */
export function apply(ctx) {
  ctx.tools.register(toToolDefinition({
    name: 'stat',
    description: 'Exact descriptive statistics over finite numeric arrays, computed in-process so no script is needed. Ops: "describe" (n/min/max/range/mean/median/sample variance/stdDev/standardError/sum/CV), "percentile" (NumPy-style linear interpolation, probabilities given as 0-100 percentages), "frequency" (bin counts, equal-width or explicit binEdges), "correlation" (Pearson, or Spearman with midranks for ties). Strict input contract: every element must be a finite number — null, undefined, NaN, ±Infinity and non-numbers are rejected and the offending index is reported; this tool never silently drops values, so filter missing data before calling. Empty arrays are rejected by describe/percentile/frequency; correlation needs two equal-length series of at least 3 observations and rejects constant (zero-variance) series instead of returning NaN.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['describe', 'percentile', 'frequency', 'correlation'],
        description: 'Operation to run: "describe", "percentile", "frequency" or "correlation".',
      },
      values: {
        type: 'array',
        items: { type: 'number' },
        description: 'Sample of finite numbers (no null/NaN/Infinity): required by describe, percentile and frequency; for correlation it is the first series.',
      },
      values2: {
        type: 'array',
        items: { type: 'number' },
        description: 'Second series for correlation; must have the same length as values (at least 3 pairs).',
      },
      percentiles: {
        type: 'array',
        items: { type: 'number' },
        description: 'Percentile probabilities for "percentile", each within [0, 100]: these are percentages, NOT 0-1 fractions. p=0 is the minimum and p=100 the maximum. Default [25, 50, 75].',
      },
      bins: {
        type: 'number',
        description: 'Positive integer bin count for "frequency" when binEdges is absent (default 10). Ignored when binEdges is given.',
      },
      binEdges: {
        type: 'array',
        items: { type: 'number' },
        description: 'Strictly increasing explicit bin edges for "frequency". Every value must lie within [first edge, last edge], otherwise the call fails rather than dropping observations.',
      },
      method: {
        type: 'string',
        enum: ['pearson', 'spearman'],
        description: 'Correlation coefficient for "correlation": "pearson" (default) or "spearman" (ranks with midranks for ties, then Pearson).',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Accepted for compatibility and ignored: this tool only handles numeric input, so no category tally is produced.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: stringProperty('Operation that produced this result.'),
          n: numberProperty('Number of observations actually used.'),
          missing: numberProperty('Always 0: non-finite values are rejected instead of being counted as missing.'),
          min: nullableNumberProperty(),
          max: nullableNumberProperty(),
          range: nullableNumberProperty(),
          mean: nullableNumberProperty(),
          median: nullableNumberProperty(),
          variance: nullableNumberProperty('Sample variance (n-1); null when n < 2.'),
          stdDev: nullableNumberProperty('Sample standard deviation (n-1); null when n < 2.'),
          standardError: nullableNumberProperty('stdDev / sqrt(n); null when n < 2.'),
          sum: nullableNumberProperty(),
          coefficientOfVariation: nullableNumberProperty('stdDev / mean; null when n < 2 or the mean is 0.'),
          percentiles: {
            ...requiredMarker(),
            ...annotation('Requested percentiles for op "percentile", otherwise null.'),
            oneOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    probability: numberProperty('Requested probability as a 0-100 percentage.'),
                    value: nullableNumberProperty(),
                  },
                },
              },
              { type: 'null' },
            ],
          },
          binRule: nullableStringProperty('How bins were chosen for op "frequency", otherwise null.'),
          intervalRule: nullableStringProperty('Interval convention: half-open [from, to) except the last bin, which is closed.'),
          bins: {
            ...requiredMarker(),
            ...annotation('Bins for op "frequency", otherwise null.'),
            oneOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    from: nullableNumberProperty('Lower edge (inclusive).'),
                    to: nullableNumberProperty('Upper edge (exclusive except in the last bin).'),
                    count: numberProperty('Observations falling in this bin.'),
                    relativeFrequency: numberProperty('count / n.'),
                  },
                },
              },
              { type: 'null' },
            ],
          },
          totalCount: nullableNumberProperty('Sum of bin counts for op "frequency", otherwise null.'),
          totalRelativeFrequency: nullableNumberProperty('Sum of bin relative frequencies for op "frequency", otherwise null.'),
          method: nullableStringProperty('Correlation method for op "correlation", otherwise null.'),
          coefficient: nullableNumberProperty('Correlation coefficient rounded to 6 decimals.'),
          rSquared: nullableNumberProperty('coefficient² for Pearson correlation, otherwise null.'),
        },
      },
      render: (_args, value) => {
        try {
          return [{ type: 'text', text: renderStat(value) }]
        } catch (error) {
          // render 抛错会被宿主判成整个工具失败，这里再兜一层：任何异常都降级成纯文本
          return [{ type: 'text', text: `stat 结果渲染失败：${errorText(error)}` }]
        }
      },
    },
    async execute(args) {
      const op = args !== null && typeof args === 'object' && typeof args.op === 'string' ? args.op : ''
      switch (op) {
        case 'describe':
          return describeOp(args.values)
        case 'percentile':
          return percentileOp(args.values, args.percentiles)
        case 'frequency':
          // labels 只声明不使用：本工具拒绝一切非数值输入，因此不存在分类计数分支
          return frequencyOp(args.values, args.bins, args.binEdges)
        case 'correlation':
          return correlationOp(args.values, args.values2, args.method)
        default:
          throw new Error(`未知 op ${JSON.stringify(op)}：可用值为 describe / percentile / frequency / correlation`)
      }
    },
  }))
}
