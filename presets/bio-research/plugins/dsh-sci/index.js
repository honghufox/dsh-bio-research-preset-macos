/**
 * dsh-sci —— 面向定量科研的三件套宿主工具：单位换算、CODATA 常数查询、ODE 数值积分。
 *
 * 设计取舍：
 *   - **零依赖、纯函数**：只用 `node:module`（仅为复刻第一方工具的 `defineTool`
 *     解析路径），其余全是纯 JavaScript。不做任何 I/O、不读环境、不联网，因此
 *     不需要配置、凭据或工作目录，任何输入的结果都是确定的、可复现的；
 *   - `unit_convert` 是**量纲感知**的：每个单位都登记为「相对某 SI 基准单位的
 *     系数（+ 温度特有的仿射偏移）」，只有量纲相同才允许换算。把 kg 换成 m 会
 *     直接报错并点明两个量纲，而不是给出一个看似合理的错数；
 *   - 温度是仿射刻度而非比例刻度，因此不套用通用的比例路径，而是在
 *     `TEMPERATURE_CONVERSIONS` 里为 K/C/F 的 9 种组合各写一条直接公式
 *     （K = C + 273.15、F = (C × 9/5) + 32，同单位为恒等）。经基准单位中转会多
 *     一次舍入，让 1 F -> F 变成 1.00000000000045；直接公式则保证 0 C -> 32 F、
 *     100 C -> 373.15 K、1 F -> 1 F 都精确，其余仿射往返也只差几个 ULP；
 *   - `constant_lookup` 内置 CODATA 2022 常数表，`uncertainty` 为**绝对**不确定度，
 *     由定义固定的常量（c、h、e、kB、NA…）取 null 并置 `exact: true`；`unit` 参数
 *     复用同一套换算器，量纲不同即报错；
 *   - `ode_simulate` 的右端项是模型给的**公式文本**，这里自写词法分析 + 递归下降
 *     解析成 AST 后逐步求值：没有 `eval`、没有 `new Function`、没有 `vm`，因而
 *     公式语言里不存在赋值、比较、成员访问或任何未声明标识符的入口；
 *   - 所有报出的数字要么有限、要么显式为 null，绝不出现 NaN / Infinity：积分中
 *     一旦出现非有限值就抛错并点名「第几步、哪个变量」，把发散暴露出来而不是
 *     悄悄返回 Inf。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const name = 'dsh-sci'
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
 * 基础工具：数值校验与格式化
 * ------------------------------------------------------------------ */

/** unit_convert 的默认有效数字位数。 */
const DEFAULT_PRECISION = 6
/** 有效数字位数上限（双精度可表示 17 位）。 */
const MAX_PRECISION = 17

/**
 * 把参数收敛成有限数值；字符串数字也接受（工具层可能以文本传递）。
 * @param raw - 原始参数。
 * @param label - 出错时用于定位的参数名。
 * @returns 有限数值。
 */
function toFiniteNumber(raw, label) {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值（收到 ${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)}）`)
  }
  return value
}

/**
 * 按**有效数字**渲染数值：去掉尾随零，永不出 NaN / Infinity 文本。
 * @param value - 待渲染的值。
 * @param precision - 有效数字位数。
 * @returns 文本；非有限值返回 'n/a'。
 */
function formatSignificant(value, precision) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const digits = Math.min(MAX_PRECISION, Math.max(1, Math.round(Number.isFinite(precision) ? precision : DEFAULT_PRECISION)))
  let text = value.toPrecision(digits)
  if (/[eE]/.test(text)) {
    const [mantissa, exponent] = text.split(/[eE]/)
    let head = mantissa
    if (head.includes('.')) head = head.replace(/0+$/, '').replace(/\.$/, '')
    const exp = Number(exponent)
    text = `${head}e${exp >= 0 ? '+' : '-'}${Math.abs(exp)}`
  } else if (text.includes('.')) {
    text = text.replace(/0+$/, '').replace(/\.$/, '')
  }
  return text === '-0' ? '0' : text
}

/* ------------------------------------------------------------------ *
 * 单位表：每个单位 -> { dimension, factor, toBase, fromBase }
 * factor 是相对该量纲 SI 基准单位的系数；温度另给仿射函数。
 * ------------------------------------------------------------------ */

/**
 * 抹掉二进制浮点噪声：把数值收敛到 15 位有效数字。
 *
 * 十进制比例在二进制里并不精确：直接做 1e-3 / 1e-6 会得到 1000.0000000000001，
 * 于是「1 L = 1000.0000000000001 cm3」这种结果看起来像 bug。双精度本身只有约
 * 15.95 位十进制有效数字，收敛到 15 位不损失真实精度，却能让 1 L -> cm3 精确等于
 * 1000、37 C -> F 精确等于 98.6，也显著改善温度换算的往返一致性。
 * @param value - 待收敛的数值。
 * @returns 收敛后的数值（非有限值原样返回，由调用方负责拒绝）。
 */
function cleanFloat(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return value
  const cleaned = Number(value.toPrecision(15))
  if (!Number.isFinite(cleaned)) return value
  return cleaned === 0 ? 0 : cleaned
}

/** 单位表，键就是用户书写的单位串（去空白后**区分大小写**）。 */
const UNIT_TABLE = new Map()

/**
 * 登记一批线性单位（基准 = value × factor）。
 * @param dimension - 量纲标识。
 * @param factor - 相对基准单位的系数。
 * @param spellings - 所有可接受的写法。
 */
function registerLinearUnit(dimension, factor, spellings) {
  for (const spelling of spellings) {
    UNIT_TABLE.set(spelling, {
      dimension,
      factor,
      toBase: (value) => value * factor,
      fromBase: (base) => base / factor,
    })
  }
}

/**
 * 温度单位之间的**直接**换算式表。
 *
 * 为什么不走通用的 toBase/fromBase：仿射换算多一次加减就多一次舍入，经基准单位
 * 中转会让 1 F -> F 变成 1.00000000000045 这种结果。因此这里为 9 种组合各写一条
 * 直接公式，同单位即恒等；公式严格按 K = C + 273.15、F = (C × 9/5) + 32 书写。
 */
const TEMPERATURE_CONVERSIONS = new Map()
{
  const cToK = (c) => c + 273.15
  const kToC = (k) => k - 273.15
  const cToF = (c) => (c * 9) / 5 + 32
  const fToC = (f) => ((f - 32) * 5) / 9
  TEMPERATURE_CONVERSIONS.set('K>K', (v) => v)
  TEMPERATURE_CONVERSIONS.set('C>C', (v) => v)
  TEMPERATURE_CONVERSIONS.set('F>F', (v) => v)
  TEMPERATURE_CONVERSIONS.set('C>K', cToK)
  TEMPERATURE_CONVERSIONS.set('K>C', kToC)
  TEMPERATURE_CONVERSIONS.set('C>F', cToF)
  TEMPERATURE_CONVERSIONS.set('F>C', fToC)
  TEMPERATURE_CONVERSIONS.set('K>F', (k) => cToF(kToC(k)))
  TEMPERATURE_CONVERSIONS.set('F>K', (f) => cToK(fToC(f)))
}

/**
 * 登记一个仿射温度单位（基准 = 开尔文）。
 * @param temperatureKey - 'K' | 'C' | 'F'，用于在直接换算表中定位。
 * @param factor - 相对开尔文的斜率（每单位多少 K），只用于 factor 字段。
 * @param spellings - 所有可接受的写法。
 */
function registerTemperatureUnit(temperatureKey, factor, spellings) {
  for (const spelling of spellings) {
    UNIT_TABLE.set(spelling, { dimension: 'temperature', factor, temperatureKey })
  }
}

// 长度（基准：米）
registerLinearUnit('length', 1, ['m', 'metre', 'meter'])
registerLinearUnit('length', 1000, ['km'])
registerLinearUnit('length', 0.01, ['cm'])
registerLinearUnit('length', 1e-3, ['mm'])
registerLinearUnit('length', 1e-6, ['um', 'µm', 'μm'])
registerLinearUnit('length', 1e-9, ['nm'])
registerLinearUnit('length', 1e-12, ['pm'])
registerLinearUnit('length', 0.0254, ['in', 'inch'])
registerLinearUnit('length', 0.3048, ['ft', 'foot'])
registerLinearUnit('length', 0.9144, ['yd', 'yard'])
registerLinearUnit('length', 1609.344, ['mi', 'mile'])
registerLinearUnit('length', 1852, ['nmi'])

// 质量（基准：千克）
registerLinearUnit('mass', 1, ['kg'])
registerLinearUnit('mass', 1e-3, ['g'])
registerLinearUnit('mass', 1e-6, ['mg'])
registerLinearUnit('mass', 1e-9, ['ug', 'µg', 'μg'])
registerLinearUnit('mass', 1e-12, ['ng'])
registerLinearUnit('mass', 1e-15, ['pg'])
registerLinearUnit('mass', 1000, ['t', 'tonne'])
registerLinearUnit('mass', 0.45359237, ['lb', 'lbs', 'pound'])
registerLinearUnit('mass', 0.028349523125, ['oz', 'ounce'])

// 时间（基准：秒）
registerLinearUnit('time', 1, ['s', 'sec', 'second'])
registerLinearUnit('time', 1e-3, ['ms'])
registerLinearUnit('time', 1e-6, ['us', 'µs', 'μs'])
registerLinearUnit('time', 1e-9, ['ns'])
registerLinearUnit('time', 60, ['min', 'minute'])
registerLinearUnit('time', 3600, ['h', 'hr', 'hour'])
registerLinearUnit('time', 86400, ['d', 'day'])

// 体积（基准：立方米）
registerLinearUnit('volume', 1e-3, ['L', 'l', 'litre', 'liter'])
registerLinearUnit('volume', 1e-6, ['mL', 'ml'])
registerLinearUnit('volume', 1e-9, ['uL', 'µL', 'μL'])
registerLinearUnit('volume', 1, ['m3'])
registerLinearUnit('volume', 1e-6, ['cm3'])
registerLinearUnit('volume', 1e-9, ['mm3'])
registerLinearUnit('volume', 3.785411784e-3, ['gal', 'gallon'])

// 物质的量（基准：摩尔）
registerLinearUnit('amount', 1, ['mol'])
registerLinearUnit('amount', 1e-3, ['mmol'])
registerLinearUnit('amount', 1e-6, ['umol', 'µmol', 'μmol'])
registerLinearUnit('amount', 1e-9, ['nmol'])
registerLinearUnit('amount', 1e-12, ['pmol'])

// 温度（基准：开尔文）——仿射刻度，绝不是单纯的比例系数
registerTemperatureUnit('K', 1, ['K', 'kelvin'])
registerTemperatureUnit('C', 1, ['C', 'celsius', 'degC', '°C'])
registerTemperatureUnit('F', 5 / 9, ['F', 'fahrenheit', 'degF', '°F'])

// 压强（基准：帕斯卡）
registerLinearUnit('pressure', 1, ['Pa'])
registerLinearUnit('pressure', 1e3, ['kPa'])
registerLinearUnit('pressure', 1e6, ['MPa'])
registerLinearUnit('pressure', 1e9, ['GPa'])
registerLinearUnit('pressure', 1e5, ['bar'])
registerLinearUnit('pressure', 100, ['mbar'])
registerLinearUnit('pressure', 101325, ['atm'])
registerLinearUnit('pressure', 133.322387415, ['mmHg'])
registerLinearUnit('pressure', 101325 / 760, ['torr'])
registerLinearUnit('pressure', 6894.757293168361, ['psi'])

// 能量（基准：焦耳）
registerLinearUnit('energy', 1, ['J'])
registerLinearUnit('energy', 1e3, ['kJ'])
registerLinearUnit('energy', 1e6, ['MJ'])
registerLinearUnit('energy', 4.184, ['cal'])
registerLinearUnit('energy', 4184, ['kcal'])
registerLinearUnit('energy', 4184, ['Cal'])
registerLinearUnit('energy', 1.602176634e-19, ['eV'])
registerLinearUnit('energy', 1.602176634e-16, ['keV'])
registerLinearUnit('energy', 1.602176634e-13, ['MeV'])
registerLinearUnit('energy', 3600, ['Wh'])
registerLinearUnit('energy', 3.6e6, ['kWh'])

// 浓度（基准：mol/m³；1 M = 1000 mol/m³）
registerLinearUnit('concentration', 1000, ['M'])
registerLinearUnit('concentration', 1, ['mM'])
registerLinearUnit('concentration', 1e-3, ['uM', 'µM', 'μM'])
registerLinearUnit('concentration', 1e-6, ['nM'])
registerLinearUnit('concentration', 1e-9, ['pM'])

// 数据（基准：字节；KB/MB/GB/TB 为 1000 进制，KiB/MiB/GiB/TiB 为 1024 进制）
registerLinearUnit('data', 1, ['B', 'byte'])
registerLinearUnit('data', 1e3, ['KB'])
registerLinearUnit('data', 1e6, ['MB'])
registerLinearUnit('data', 1e9, ['GB'])
registerLinearUnit('data', 1e12, ['TB'])
registerLinearUnit('data', 1024, ['KiB'])
registerLinearUnit('data', 1024 ** 2, ['MiB'])
registerLinearUnit('data', 1024 ** 3, ['GiB'])
registerLinearUnit('data', 1024 ** 4, ['TiB'])

/**
 * 「本来就是小写」的多字符写法构成的宽松别名表。
 *
 * 只在输入**本身全为小写**时兜底，因此 'ML'、'KM' 这类大写变体不会命中
 * （m 与 M、mL 与 ML 必须区分）；单字母一律不做宽松匹配，避免把 M 摩尔当成 m 米。
 */
const LOWER_FALLBACK = new Map()
for (const [key, unit] of UNIT_TABLE) {
  if (key !== key.toLowerCase()) continue
  if (key.length < 2) continue
  const existing = LOWER_FALLBACK.get(key)
  if (existing !== undefined && existing !== unit) continue
  LOWER_FALLBACK.set(key, unit)
}

/**
 * 解析单位串（先精确匹配，再对小写输入做别名兜底）。
 * @param label - 用户写的单位串。
 * @returns 规范化后的键与单位记录。
 */
function resolveUnit(label) {
  const key = typeof label === 'string' ? label.trim() : ''
  if (key.length === 0) throw new Error('单位不能为空字符串')
  const direct = UNIT_TABLE.get(key)
  if (direct !== undefined) return { key, unit: direct }
  if (key === key.toLowerCase()) {
    const loose = LOWER_FALLBACK.get(key)
    if (loose !== undefined) return { key, unit: loose }
  }
  throw new Error(`未知单位 "${key}"：单位串区分大小写（m = 米、M = mol/L、mL = 毫升、ML 不是已知单位）`)
}

/**
 * 量纲感知的换算核心。
 * @param value - 待换算的数值。
 * @param fromLabel - 源单位串。
 * @param toLabel - 目标单位串。
 * @returns 量纲、换算结果、线性系数（仿射单位下为斜率比）。
 */
function convertValue(value, fromLabel, toLabel) {
  const from = resolveUnit(fromLabel)
  const to = resolveUnit(toLabel)
  if (from.unit.dimension !== to.unit.dimension) {
    throw new Error(
      `量纲不匹配：无法把 ${from.unit.dimension} 单位 "${from.key}" 换算成 ${to.unit.dimension} 单位 "${to.key}"（跨量纲换算被拒绝）`,
    )
  }
  const factor = cleanFloat(from.unit.factor / to.unit.factor)
  if (from.unit.dimension === 'temperature') {
    const convert = TEMPERATURE_CONVERSIONS.get(`${from.unit.temperatureKey}>${to.unit.temperatureKey}`)
    if (convert === undefined) throw new Error(`温度换算 "${from.key}" -> "${to.key}" 未登记`)
    return { dimension: 'temperature', result: cleanFloat(convert(value)), factor }
  }
  const base = cleanFloat(from.unit.toBase(value))
  return {
    dimension: from.unit.dimension,
    result: cleanFloat(to.unit.fromBase(base)),
    factor,
  }
}

/* ------------------------------------------------------------------ *
 * CODATA 2022 常数表
 * uncertainty 为**绝对**不确定度（与 value 同单位）；由定义固定的取 null。
 * convertUnit 只在「value 的单位本身就是 unit_convert 认识的单一单位」时给出，
 * 其余（m/s、J·s、C/mol 这类复合单位）在请求 unit 时显式报错而不是乱算。
 * ------------------------------------------------------------------ */

const CONSTANTS = [
  {
    symbol: 'c',
    name: 'speed of light in vacuum',
    value: 299792458,
    unit: 'm/s',
    uncertainty: null,
    exact: true,
    aliases: ['c', 'speed of light', 'speed of light in vacuum', 'lightspeed'],
  },
  {
    symbol: 'h',
    name: 'Planck constant',
    value: 6.62607015e-34,
    unit: 'J·s',
    uncertainty: null,
    exact: true,
    aliases: ['h', 'planck', 'planck constant'],
  },
  {
    symbol: 'hbar',
    name: 'reduced Planck constant',
    value: 1.054571817e-34,
    unit: 'J·s',
    uncertainty: null,
    exact: true,
    aliases: ['hbar', 'h-bar', 'reduced planck constant', 'dirac constant'],
  },
  {
    symbol: 'kB',
    name: 'Boltzmann constant',
    value: 1.380649e-23,
    unit: 'J/K',
    uncertainty: null,
    exact: true,
    aliases: ['kB', 'k_B', 'boltzmann', 'boltzmann constant'],
  },
  {
    symbol: 'NA',
    name: 'Avogadro constant',
    value: 6.02214076e23,
    unit: '1/mol',
    uncertainty: null,
    exact: true,
    aliases: ['NA', 'N_A', 'avogadro', 'avogadro constant'],
  },
  {
    symbol: 'R',
    name: 'molar gas constant',
    value: 8.31446261815324,
    unit: 'J/(mol·K)',
    uncertainty: null,
    exact: true,
    aliases: ['R', 'gas constant', 'molar gas constant', 'universal gas constant'],
  },
  {
    symbol: 'G',
    name: 'Newtonian constant of gravitation',
    value: 6.6743e-11,
    unit: 'm³/(kg·s²)',
    uncertainty: 1.5e-15,
    exact: false,
    aliases: ['G', 'gravity', 'gravitational constant', 'newtonian constant of gravitation', 'big g'],
  },
  {
    symbol: 'g_n',
    name: 'standard acceleration of gravity',
    value: 9.80665,
    unit: 'm/s²',
    uncertainty: null,
    exact: true,
    aliases: ['g_n', 'gn', 'standard gravity', 'standard acceleration of gravity'],
  },
  {
    symbol: 'e',
    name: 'elementary charge',
    value: 1.602176634e-19,
    unit: 'C',
    uncertainty: null,
    exact: true,
    aliases: ['e', 'elementary charge', 'electron charge'],
  },
  {
    symbol: 'me',
    name: 'electron mass',
    value: 9.1093837139e-31,
    unit: 'kg',
    uncertainty: 2.8e-40,
    exact: false,
    aliases: ['me', 'm_e', 'electron mass'],
    convertUnit: 'kg',
  },
  {
    symbol: 'mp',
    name: 'proton mass',
    value: 1.67262192595e-27,
    unit: 'kg',
    uncertainty: 5.2e-37,
    exact: false,
    aliases: ['mp', 'm_p', 'proton mass'],
    convertUnit: 'kg',
  },
  {
    symbol: 'mn',
    name: 'neutron mass',
    value: 1.67492750056e-27,
    unit: 'kg',
    uncertainty: 8.5e-37,
    exact: false,
    aliases: ['mn', 'm_n', 'neutron mass'],
    convertUnit: 'kg',
  },
  {
    symbol: 'u',
    name: 'atomic mass constant',
    value: 1.66053906892e-27,
    unit: 'kg',
    uncertainty: 5.2e-37,
    exact: false,
    aliases: ['u', 'atomic mass', 'atomic mass constant', 'dalton', 'Da'],
    convertUnit: 'kg',
  },
  {
    symbol: 'mu0',
    name: 'vacuum magnetic permeability',
    value: 1.25663706212e-6,
    unit: 'N/A²',
    uncertainty: 1.9e-16,
    exact: false,
    aliases: ['mu0', 'mu_0', 'vacuum permeability', 'magnetic constant'],
  },
  {
    symbol: 'eps0',
    name: 'vacuum electric permittivity',
    value: 8.8541878188e-12,
    unit: 'F/m',
    uncertainty: 1.4e-21,
    exact: false,
    aliases: ['eps0', 'epsilon0', 'epsilon_0', 'vacuum permittivity', 'electric constant'],
  },
  {
    symbol: 'alpha',
    name: 'fine-structure constant',
    value: 7.2973525643e-3,
    unit: '1',
    uncertainty: 1.1e-12,
    exact: false,
    aliases: ['alpha', 'fine structure', 'fine-structure constant', 'fine structure constant'],
  },
  {
    symbol: 'F',
    name: 'Faraday constant',
    value: 96485.33212331001,
    unit: 'C/mol',
    uncertainty: null,
    exact: true,
    aliases: ['F', 'faraday', 'faraday constant'],
  },
  {
    symbol: 'sigma',
    name: 'Stefan-Boltzmann constant',
    value: 5.670374419e-8,
    unit: 'W/(m²·K⁴)',
    uncertainty: null,
    exact: true,
    aliases: ['sigma', 'stefan', 'stefan-boltzmann', 'stefan boltzmann constant'],
  },
  {
    symbol: 'Rinf',
    name: 'Rydberg constant',
    value: 10973731.568157,
    unit: '1/m',
    uncertainty: 1.2e-5,
    exact: false,
    aliases: ['Rinf', 'R_inf', 'rydberg', 'rydberg constant'],
  },
  {
    symbol: 'a0',
    name: 'Bohr radius',
    value: 5.29177210544e-11,
    unit: 'm',
    uncertainty: 8.2e-21,
    exact: false,
    aliases: ['a0', 'a_0', 'bohr', 'bohr radius'],
    convertUnit: 'm',
  },
  {
    symbol: 'muB',
    name: 'Bohr magneton',
    value: 9.2740100657e-24,
    unit: 'J/T',
    uncertainty: 2.8e-33,
    exact: false,
    aliases: ['muB', 'mu_B', 'bohr magneton'],
  },
  {
    symbol: 'muN',
    name: 'nuclear magneton',
    value: 5.0507837393e-27,
    unit: 'J/T',
    uncertainty: 1.5e-36,
    exact: false,
    aliases: ['muN', 'mu_N', 'nuclear magneton'],
  },
  {
    symbol: 'lambdaC',
    name: 'Compton wavelength of the electron',
    value: 2.42631023538e-12,
    unit: 'm',
    uncertainty: 7.6e-22,
    exact: false,
    aliases: ['lambdaC', 'compton wavelength', 'electron compton wavelength'],
    convertUnit: 'm',
  },
  {
    symbol: 're',
    name: 'classical electron radius',
    value: 2.8179403205e-15,
    unit: 'm',
    uncertainty: 1.3e-24,
    exact: false,
    aliases: ['re', 'r_e', 'classical electron radius'],
    convertUnit: 'm',
  },
  {
    symbol: 'Eh',
    name: 'Hartree energy',
    value: 4.359744722206e-18,
    unit: 'J',
    uncertainty: 4.8e-30,
    exact: false,
    aliases: ['Eh', 'hartree', 'hartree energy'],
    convertUnit: 'J',
  },
  {
    symbol: 'eV',
    name: 'electron volt',
    value: 1.602176634e-19,
    unit: 'J',
    uncertainty: null,
    exact: true,
    aliases: ['eV', 'electronvolt', 'electron volt'],
    convertUnit: 'J',
  },
  {
    symbol: 'Vm',
    name: 'molar volume of ideal gas (273.15 K, 100 kPa)',
    value: 22.71095464e-3,
    unit: 'm³/mol',
    uncertainty: null,
    exact: true,
    aliases: ['Vm', 'molar volume', 'molar volume of ideal gas'],
  },
  {
    symbol: 'n0',
    name: 'Loschmidt constant (273.15 K, 101.325 kPa)',
    value: 2.686780111e25,
    unit: '1/m³',
    uncertainty: null,
    exact: true,
    aliases: ['n0', 'loschmidt', 'loschmidt constant'],
  },
  {
    symbol: 'b',
    name: 'Wien wavelength displacement law constant',
    value: 2.897771955e-3,
    unit: 'm·K',
    uncertainty: null,
    exact: true,
    aliases: ['b', 'wien', 'wien displacement constant'],
  },
  {
    symbol: 'c1',
    name: 'first radiation constant',
    value: 3.741771852e-16,
    unit: 'W·m²',
    uncertainty: null,
    exact: true,
    aliases: ['c1', 'first radiation constant'],
  },
  {
    symbol: 'c2',
    name: 'second radiation constant',
    value: 1.438776877e-2,
    unit: 'm·K',
    uncertainty: null,
    exact: true,
    aliases: ['c2', 'second radiation constant'],
  },
  {
    symbol: 'G0',
    name: 'conductance quantum',
    value: 7.748091729e-5,
    unit: 'S',
    uncertainty: null,
    exact: true,
    aliases: ['G0', 'conductance quantum'],
  },
  {
    symbol: 'Phi0',
    name: 'magnetic flux quantum',
    value: 2.067833848e-15,
    unit: 'Wb',
    uncertainty: null,
    exact: true,
    aliases: ['Phi0', 'phi_0', 'magnetic flux quantum'],
  },
  {
    symbol: 'RK',
    name: 'von Klitzing constant',
    value: 25812.80745,
    unit: 'Ω',
    uncertainty: null,
    exact: true,
    aliases: ['RK', 'R_K', 'von klitzing', 'von klitzing constant'],
  },
  {
    symbol: 'KJ',
    name: 'Josephson constant',
    value: 483597.8484e9,
    unit: 'Hz/V',
    uncertainty: null,
    exact: true,
    aliases: ['KJ', 'K_J', 'josephson', 'josephson constant'],
  },
  {
    symbol: 'T0',
    name: 'triple point of water',
    value: 273.16,
    unit: 'K',
    uncertainty: null,
    exact: true,
    aliases: ['T0', 'triple point of water', 'water triple point'],
    convertUnit: 'K',
  },
  {
    symbol: 'h_eV',
    name: 'Planck constant in eV',
    value: 4.135667696e-15,
    unit: 'eV·s',
    uncertainty: null,
    exact: true,
    aliases: ['h_eV', 'planck ev', 'planck constant in ev'],
  },
  {
    symbol: 'kB_eV',
    name: 'Boltzmann constant in eV',
    value: 8.617333262e-5,
    unit: 'eV/K',
    uncertainty: null,
    exact: true,
    aliases: ['kB_eV', 'boltzmann ev', 'boltzmann constant in ev'],
  },
  {
    symbol: 'm_p_me',
    name: 'proton-electron mass ratio',
    value: 1836.152673426,
    unit: '1',
    uncertainty: 3.2e-7,
    exact: false,
    aliases: ['m_p_me', 'proton electron mass ratio', 'mp/me'],
  },
  {
    symbol: 'mPlanck',
    name: 'Planck mass',
    value: 2.176434e-8,
    unit: 'kg',
    uncertainty: 2.4e-13,
    exact: false,
    aliases: ['mPlanck', 'planck mass'],
    convertUnit: 'kg',
  },
  {
    symbol: 'lPlanck',
    name: 'Planck length',
    value: 1.616255e-35,
    unit: 'm',
    uncertainty: 1.8e-40,
    exact: false,
    aliases: ['lPlanck', 'planck length'],
    convertUnit: 'm',
  },
  {
    symbol: 'tPlanck',
    name: 'Planck time',
    value: 5.391247e-44,
    unit: 's',
    uncertainty: 6.0e-49,
    exact: false,
    aliases: ['tPlanck', 'planck time'],
    convertUnit: 's',
  },
]

/**
 * 归一化常量名：去空白/下划线/连字符并转小写。
 * @param raw - 原始名称。
 * @returns 归一化键。
 */
function normalizeConstantName(raw) {
  return String(raw).trim().toLowerCase().replace(/[\s_\-·]+/g, '')
}

/** 精确（区分大小写）索引：符号 + 原始别名。 */
const CONSTANT_EXACT_INDEX = new Map()
/** 归一化索引：大小写不敏感的主查找表。 */
const CONSTANT_ALIAS_INDEX = new Map()
for (const entry of CONSTANTS) {
  CONSTANT_EXACT_INDEX.set(entry.symbol, entry)
  CONSTANT_ALIAS_INDEX.set(normalizeConstantName(entry.symbol), entry)
  for (const alias of entry.aliases) {
    if (!CONSTANT_EXACT_INDEX.has(alias)) CONSTANT_EXACT_INDEX.set(alias, entry)
    CONSTANT_ALIAS_INDEX.set(normalizeConstantName(alias), entry)
  }
  CONSTANT_ALIAS_INDEX.set(normalizeConstantName(entry.name), entry)
}

/**
 * 查一个常量：先精确匹配，再大小写不敏感匹配。
 * @param raw - 名称或别名。
 * @returns 常量记录，未命中返回 undefined。
 */
function lookupConstant(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return undefined
  const exact = CONSTANT_EXACT_INDEX.get(text)
  if (exact !== undefined) return exact
  return CONSTANT_ALIAS_INDEX.get(normalizeConstantName(text))
}

/**
 * 子串匹配用的检索串（名称 + 符号 + 全部别名）。
 * @param entry - 常量记录。
 * @returns 小写检索串。
 */
function constantHaystack(entry) {
  return [entry.name, entry.symbol, ...entry.aliases].join(' ').toLowerCase()
}

/**
 * 编辑距离，用于「查不到时给出最接近的几个名字」。
 * @param a - 字符串 a。
 * @param b - 字符串 b。
 * @returns 距离。
 */
function editDistance(a, b) {
  const previous = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j]
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost)
      diagonal = temp
    }
  }
  return previous[b.length]
}

/**
 * 找出最接近的若干常量名。
 * @param raw - 未命中的名称。
 * @returns 「符号 (名称)」列表。
 */
function closestConstantNames(raw) {
  const target = normalizeConstantName(raw)
  return CONSTANTS
    .map((entry) => ({
      entry,
      score: Math.min(
        editDistance(target, normalizeConstantName(entry.symbol)),
        editDistance(target, normalizeConstantName(entry.name)),
      ),
    }))
    .sort((left, right) => left.score - right.score)
    .slice(0, 5)
    .map(({ entry }) => `${entry.symbol} (${entry.name})`)
}

/**
 * 组装输出用的常量记录；给了 targetUnit 就走同一套换算器。
 * @param entry - 常量表条目。
 * @param targetUnit - 目标单位串，可为 undefined。
 * @returns 输出记录（所有字段恒在）。
 */
function constantRecord(entry, targetUnit) {
  const record = {
    symbol: entry.symbol,
    name: entry.name,
    value: entry.value,
    unit: entry.unit,
    uncertainty: entry.uncertainty,
    exact: entry.exact,
    codataValue: entry.value,
    codataUnit: entry.unit,
    converted: false,
  }
  if (targetUnit === undefined) return record
  if (entry.convertUnit === undefined) {
    throw new Error(
      `常量 ${entry.symbol} 的单位 "${entry.unit}" 是复合单位或本插件未收录的单位，`
      + `unit_convert 只能处理单一单位，无法换算到 "${String(targetUnit).trim()}"`,
    )
  }
  const { result, factor } = convertValue(entry.value, entry.convertUnit, targetUnit)
  if (!Number.isFinite(result)) throw new Error(`常量 ${entry.symbol} 换算到 "${targetUnit}" 后超出双精度浮点范围`)
  record.value = result
  record.unit = String(targetUnit).trim()
  record.uncertainty = entry.uncertainty === null ? null : cleanFloat(Math.abs(entry.uncertainty * factor))
  record.converted = true
  return record
}

/* ------------------------------------------------------------------ *
 * ODE：受限公式语言的词法分析、递归下降解析与求值
 * ------------------------------------------------------------------ */

/** 允许调用的函数（元数固定，未知函数或元数不符都在解析期报错）。 */
const ODE_FUNCTIONS = new Map(Object.entries({
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log },
  log10: { arity: 1, fn: Math.log10 },
  log2: { arity: 1, fn: Math.log2 },
  sqrt: { arity: 1, fn: Math.sqrt },
  abs: { arity: 1, fn: Math.abs },
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  min: { arity: 2, fn: Math.min },
  max: { arity: 2, fn: Math.max },
  pow: { arity: 2, fn: Math.pow },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  sign: { arity: 1, fn: Math.sign },
  heaviside: { arity: 1, fn: (x) => (x < 0 ? 0 : 1) },
}))

/** 状态变量 / 参数名必须匹配的标识符形式。 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** 这些名字会污染普通对象的原型链，直接拒绝。 */
const FORBIDDEN_IDENTIFIERS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 词法分析：数字（含科学计数法）、标识符、运算符与括号。
 * @param source - 公式文本。
 * @returns token 列表（末尾恒有 eof）。
 */
function tokenizeFormula(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    if (/\s/.test(ch)) {
      index += 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const start = index
      while (index < source.length && /[0-9]/.test(source[index])) index += 1
      if (source[index] === '.') {
        index += 1
        while (index < source.length && /[0-9]/.test(source[index])) index += 1
      }
      if (source[index] === 'e' || source[index] === 'E') {
        let probe = index + 1
        if (source[probe] === '+' || source[probe] === '-') probe += 1
        if (/[0-9]/.test(source[probe] ?? '')) {
          while (probe < source.length && /[0-9]/.test(source[probe])) probe += 1
          index = probe
        }
      }
      const text = source.slice(start, index)
      tokens.push({ type: 'number', text, value: Number(text), position: start })
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = index
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index += 1
      tokens.push({ type: 'identifier', text: source.slice(start, index), position: start })
      continue
    }
    if ('+-*/^(),'.includes(ch)) {
      tokens.push({ type: 'punctuation', text: ch, position: index })
      index += 1
      continue
    }
    throw new Error(`公式解析失败：位置 ${index} 出现非法字符 "${ch}"（公式：${source}）`)
  }
  tokens.push({ type: 'eof', text: '', position: source.length })
  return tokens
}

/**
 * 递归下降解析成 AST（不使用 eval / new Function / vm）。
 *
 * 文法（^ 右结合且优先级高于 * /）：
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/') unary)*
 *   unary      := ('+' | '-') unary | power
 *   power      := primary ('^' unary)?
 *   primary    := number | name | func '(' expression (',' expression)* ')' | '(' expression ')'
 * @param source - 公式文本。
 * @param allowedNames - 该公式可引用的标识符集合（状态变量 + 参数）。
 * @returns AST 根节点。
 */
function parseFormula(source, allowedNames) {
  const tokens = tokenizeFormula(source)
  const allowedText = [...allowedNames].sort().join(', ')
  let cursor = 0

  const peek = () => tokens[cursor]
  const advance = () => tokens[cursor++]
  const fail = (token, message) => {
    throw new Error(`公式解析失败（位置 ${token.position}，记号 ${JSON.stringify(token.text)}）：${message}；公式：${source}`)
  }

  function parseExpression() {
    let left = parseTerm()
    while (peek().type === 'punctuation' && (peek().text === '+' || peek().text === '-')) {
      const op = advance().text
      left = { kind: 'binary', op, left, right: parseTerm() }
    }
    return left
  }

  function parseTerm() {
    let left = parseUnary()
    while (peek().type === 'punctuation' && (peek().text === '*' || peek().text === '/')) {
      const op = advance().text
      left = { kind: 'binary', op, left, right: parseUnary() }
    }
    return left
  }

  function parseUnary() {
    const token = peek()
    if (token.type === 'punctuation' && (token.text === '-' || token.text === '+')) {
      advance()
      return { kind: 'unary', op: token.text, operand: parseUnary() }
    }
    return parsePower()
  }

  function parsePower() {
    const base = parsePrimary()
    if (peek().type === 'punctuation' && peek().text === '^') {
      advance()
      return { kind: 'binary', op: '^', left: base, right: parseUnary() }
    }
    return base
  }

  function parsePrimary() {
    const token = peek()
    if (token.type === 'number') {
      advance()
      return { kind: 'number', value: token.value }
    }
    if (token.type === 'identifier') {
      advance()
      if (peek().type === 'punctuation' && peek().text === '(') {
        const spec = ODE_FUNCTIONS.get(token.text)
        if (spec === undefined) {
          fail(token, `未知函数 "${token.text}"；可用函数：${[...ODE_FUNCTIONS.keys()].join(', ')}`)
        }
        advance()
        const args = []
        if (!(peek().type === 'punctuation' && peek().text === ')')) {
          for (;;) {
            args.push(parseExpression())
            if (peek().type === 'punctuation' && peek().text === ',') {
              advance()
              continue
            }
            break
          }
        }
        const close = peek()
        if (!(close.type === 'punctuation' && close.text === ')')) fail(close, `函数 "${token.text}" 缺少右括号`)
        advance()
        if (args.length !== spec.arity) {
          fail(token, `函数 "${token.text}" 需要 ${spec.arity} 个参数，收到 ${args.length} 个`)
        }
        return { kind: 'call', name: token.text, args }
      }
      if (!allowedNames.has(token.text)) {
        fail(token, `未知标识符 "${token.text}"（既不是状态变量也不是提供的参数）；可用名称：${allowedText}`)
      }
      return { kind: 'name', name: token.text }
    }
    if (token.type === 'punctuation' && token.text === '(') {
      advance()
      const inner = parseExpression()
      const close = peek()
      if (!(close.type === 'punctuation' && close.text === ')')) fail(close, '缺少右括号')
      advance()
      return inner
    }
    return fail(token, '表达式不完整或出现了不该出现的记号')
  }

  const ast = parseExpression()
  const rest = peek()
  if (rest.type !== 'eof') fail(rest, '公式末尾有多余内容（不支持赋值、比较或成员访问）')
  return ast
}

/**
 * 求值 AST。
 * @param node - AST 节点。
 * @param scope - 变量表（状态变量 + 参数），已由解析期校验过键存在。
 * @returns 求值结果（可能是 NaN / Infinity，由调用方检查）。
 */
function evaluateFormula(node, scope) {
  switch (node.kind) {
    case 'number':
      return node.value
    case 'name':
      return scope[node.name]
    case 'unary': {
      const value = evaluateFormula(node.operand, scope)
      return node.op === '-' ? -value : value
    }
    case 'binary': {
      const left = evaluateFormula(node.left, scope)
      const right = evaluateFormula(node.right, scope)
      switch (node.op) {
        case '+': return left + right
        case '-': return left - right
        case '*': return left * right
        case '/': return left / right
        case '^': return Math.pow(left, right)
        default: return Number.NaN
      }
    }
    case 'call': {
      const spec = ODE_FUNCTIONS.get(node.name)
      if (spec === undefined) return Number.NaN
      const args = node.args.map((argument) => evaluateFormula(argument, scope))
      return spec.fn(...args)
    }
    default:
      return Number.NaN
  }
}

/* ------------------------------------------------------------------ *
 * ODE：积分器
 * ------------------------------------------------------------------ */

/** steps 的硬上限。 */
const MAX_ODE_STEPS = 100000
/** series 的采样点上限。 */
const MAX_SERIES_POINTS = 200
/** RK45 的默认相对/绝对容差。 */
const DEFAULT_RTOL = 1e-6
const DEFAULT_ATOL = 1e-9

/** Dormand-Prince 的 a 系数（第 i 行对应第 i 级，缺项为 0）。 */
const DP_A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
]
/** Dormand-Prince 的 c 系数（节点位置）。 */
const DP_C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1]
/** 5 阶解的权重（第 7 项为 0，所以只用 k1..k6）。 */
const DP_B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0]
/** 4 阶解的权重，用于误差估计。 */
const DP_B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40]

/**
 * 一步 Dormand-Prince（同时给出 5 阶解与 4 阶解）。
 * @param rhs - 右端项函数 (t, y, stepIndex) => number[]。
 * @param t - 当前时刻。
 * @param y - 当前状态。
 * @param h - 步长。
 * @param stepIndex - 步号（仅用于报错定位）。
 * @returns { y5, y4 }。
 */
function dormandPrinceStep(rhs, t, y, h, stepIndex) {
  const stages = [rhs(t, y, stepIndex)]
  for (let stage = 1; stage < 7; stage += 1) {
    const coefficients = DP_A[stage]
    const trial = y.slice()
    for (let j = 0; j < stage; j += 1) {
      const scale = h * coefficients[j]
      if (scale === 0) continue
      const previous = stages[j]
      for (let i = 0; i < trial.length; i += 1) trial[i] += scale * previous[i]
    }
    stages.push(rhs(t + DP_C[stage] * h, trial, stepIndex))
  }
  const y5 = new Array(y.length)
  const y4 = new Array(y.length)
  for (let i = 0; i < y.length; i += 1) {
    let sum5 = 0
    for (let j = 0; j < 6; j += 1) sum5 += DP_B5[j] * stages[j][i]
    let sum4 = 0
    for (let j = 0; j < 7; j += 1) sum4 += DP_B4[j] * stages[j][i]
    y5[i] = y[i] + h * sum5
    y4[i] = y[i] + h * sum4
  }
  return { y5, y4 }
}

/**
 * 在 [t, tTarget] 上做自适应 RK45，必要时内部细分，终点精确落在 tTarget。
 * @param rhs - 右端项函数。
 * @param t - 区间起点。
 * @param y - 起点状态。
 * @param tTarget - 区间终点。
 * @param rtol - 相对容差。
 * @param atol - 绝对容差。
 * @param stepIndex - 步号（报错定位）。
 * @returns 终点状态数组。
 */
function integrateIntervalRK45(rhs, t, y, tTarget, rtol, atol, stepIndex) {
  let current = t
  let state = y.slice()
  let h = (tTarget - t) / 4
  let guard = 0
  while (current < tTarget) {
    guard += 1
    if (guard > 10_000_000) throw new Error(`RK45 在第 ${stepIndex} 步附近无法推进（步长被反复拒绝）`)
    const trial = Math.min(h, tTarget - current)
    const { y5, y4 } = dormandPrinceStep(rhs, current, state, trial, stepIndex)
    let error = 0
    for (let i = 0; i < state.length; i += 1) {
      const scale = atol + rtol * Math.max(Math.abs(state[i]), Math.abs(y5[i]))
      const ratio = Math.abs(y5[i] - y4[i]) / scale
      if (!Number.isFinite(ratio)) {
        throw new Error(`RK45 在第 ${stepIndex} 步的误差估计非有限（容差过小或方程发散）`)
      }
      if (ratio > error) error = ratio
    }
    if (error <= 1) {
      current += trial
      state = y5
      const growth = error === 0 ? 5 : Math.min(5, Math.max(0.2, 0.9 * error ** -0.2))
      h = trial * growth
    } else {
      h = trial * Math.max(0.2, 0.9 * error ** -0.2)
    }
    if (h < Number.EPSILON * Math.max(1, Math.abs(current))) {
      throw new Error(`RK45 在第 ${stepIndex} 步的步长收缩到机器精度以下，无法达到要求的容差`)
    }
  }
  return state
}

/**
 * 主积分流程：三种方法都输出同一套结果结构。
 * @param args - 工具参数。
 * @returns 结果对象。
 */
function simulateOde(args) {
  const equations = args.equations
  if (equations === null || typeof equations !== 'object' || Array.isArray(equations)) {
    throw new Error('equations 必须是 { 状态变量: 公式字符串 } 形式的对象')
  }
  const initial = args.initial
  if (initial === null || typeof initial !== 'object' || Array.isArray(initial)) {
    throw new Error('initial 必须是 { 状态变量: 初始值 } 形式的对象')
  }
  const rawParameters = args.parameters ?? {}
  if (rawParameters === null || typeof rawParameters !== 'object' || Array.isArray(rawParameters)) {
    throw new Error('parameters 必须是 { 参数名: 数值 } 形式的对象')
  }

  const stateNames = Object.keys(equations)
  if (stateNames.length === 0) throw new Error('equations 至少要有一个状态变量')
  const initialNames = Object.keys(initial)
  const missing = stateNames.filter((key) => !initialNames.includes(key))
  const extra = initialNames.filter((key) => !stateNames.includes(key))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `initial 的键必须与 equations 完全一致`
      + `${missing.length > 0 ? `；缺少：${missing.join(', ')}` : ''}`
      + `${extra.length > 0 ? `；多余：${extra.join(', ')}` : ''}`,
    )
  }

  const checkName = (key, kind) => {
    if (!IDENTIFIER_PATTERN.test(key) || FORBIDDEN_IDENTIFIERS.has(key)) {
      throw new Error(`${kind} "${key}" 不是合法标识符（只允许 [A-Za-z_][A-Za-z0-9_]*，且不能是 __proto__/prototype/constructor）`)
    }
  }
  for (const key of stateNames) checkName(key, '状态变量名')

  const parameterValues = Object.create(null)
  for (const [key, raw] of Object.entries(rawParameters)) {
    checkName(key, '参数名')
    if (stateNames.includes(key)) throw new Error(`参数 "${key}" 与状态变量同名，会产生歧义`)
    parameterValues[key] = toFiniteNumber(raw, `参数 ${key}`)
  }

  const allowedNames = new Set([...stateNames, ...Object.keys(parameterValues)])
  const compiled = stateNames.map((key) => {
    const formula = equations[key]
    if (typeof formula !== 'string' || formula.trim().length === 0) {
      throw new Error(`状态变量 "${key}" 的公式必须是非空字符串`)
    }
    return { name: key, ast: parseFormula(formula, allowedNames) }
  })

  const method = args.method === undefined ? 'rk4' : String(args.method)
  if (!['rk4', 'rk45', 'euler'].includes(method)) {
    throw new Error(`未知 method "${method}"；可用：rk4（默认）、rk45（自适应 Dormand-Prince）、euler（最低精度，仅供对照）`)
  }

  const stepsRaw = toFiniteNumber(args.steps, 'steps')
  if (!Number.isInteger(stepsRaw) || stepsRaw <= 0) throw new Error(`steps 必须是正整数（收到 ${stepsRaw}）`)
  if (stepsRaw > MAX_ODE_STEPS) throw new Error(`steps 超出上限 ${MAX_ODE_STEPS}（收到 ${stepsRaw}）`)
  const steps = stepsRaw

  const t0 = args.t0 === undefined ? 0 : toFiniteNumber(args.t0, 't0')
  const tEnd = toFiniteNumber(args.tEnd, 'tEnd')
  if (!(tEnd > t0)) throw new Error(`tEnd 必须大于 t0（收到 t0=${t0}、tEnd=${tEnd}）`)
  const rtol = args.rtol === undefined ? DEFAULT_RTOL : toFiniteNumber(args.rtol, 'rtol')
  const atol = args.atol === undefined ? DEFAULT_ATOL : toFiniteNumber(args.atol, 'atol')
  if (!(rtol > 0)) throw new Error(`rtol 必须为正数（收到 ${rtol}）`)
  if (!(atol > 0)) throw new Error(`atol 必须为正数（收到 ${atol}）`)

  const y0 = stateNames.map((key) => toFiniteNumber(initial[key], `initial.${key}`))
  const scope = Object.create(null)
  for (const [key, value] of Object.entries(parameterValues)) scope[key] = value

  /** 求右端项；任何非有限分量立刻点名「第几步 / 哪个变量」。 */
  const rhs = (t, y, stepIndex) => {
    for (let i = 0; i < stateNames.length; i += 1) scope[stateNames[i]] = y[i]
    const out = new Array(stateNames.length)
    for (let i = 0; i < compiled.length; i += 1) {
      const value = evaluateFormula(compiled[i].ast, scope)
      if (!Number.isFinite(value)) {
        throw new Error(
          `第 ${stepIndex} 步（t=${formatSignificant(t, 6)}）计算 d${compiled[i].name}/dt 得到非有限值 ${String(value)}；`
          + `请检查公式 "${equations[compiled[i].name]}" 是否存在除零、log/sqrt 定义域或数值溢出`,
        )
      }
      out[i] = value
    }
    return out
  }

  /** 更新后逐分量检查，把发散暴露成异常。 */
  const assertFiniteState = (y, stepNumber, t) => {
    for (let i = 0; i < y.length; i += 1) {
      if (!Number.isFinite(y[i])) {
        throw new Error(`积分在第 ${stepNumber} 步（t=${formatSignificant(t, 6)}）发散：变量 "${stateNames[i]}" 变为 ${String(y[i])}（非有限值）`)
      }
    }
  }

  const h = (tEnd - t0) / steps
  const grid = [{ t: t0, y: y0.slice() }]
  let state = y0.slice()
  let time = t0
  for (let step = 0; step < steps; step += 1) {
    const nextTime = t0 + (step + 1) * h
    if (method === 'euler') {
      const k1 = rhs(time, state, step)
      state = state.map((value, i) => value + h * k1[i])
    } else if (method === 'rk4') {
      const k1 = rhs(time, state, step)
      const y2 = state.map((value, i) => value + (h / 2) * k1[i])
      const k2 = rhs(time + h / 2, y2, step)
      const y3 = state.map((value, i) => value + (h / 2) * k2[i])
      const k3 = rhs(time + h / 2, y3, step)
      const y4 = state.map((value, i) => value + h * k3[i])
      const k4 = rhs(time + h, y4, step)
      state = state.map((value, i) => value + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]))
    } else {
      state = integrateIntervalRK45(rhs, time, state, nextTime, rtol, atol, step)
    }
    time = nextTime
    assertFiniteState(state, step + 1, time)
    grid.push({ t: time, y: state.slice() })
  }

  const rows = grid.map((point) => {
    const row = { t: point.t }
    for (let i = 0; i < stateNames.length; i += 1) row[stateNames[i]] = point.y[i]
    return row
  })
  const sampled = rows.length <= MAX_SERIES_POINTS
    ? rows
    : Array.from({ length: MAX_SERIES_POINTS }, (_unused, index) => rows[Math.round((index * (rows.length - 1)) / (MAX_SERIES_POINTS - 1))])

  const final = {}
  const min = {}
  const max = {}
  for (let i = 0; i < stateNames.length; i += 1) {
    let low = grid[0].y[i]
    let high = grid[0].y[i]
    for (const point of grid) {
      if (point.y[i] < low) low = point.y[i]
      if (point.y[i] > high) high = point.y[i]
    }
    final[stateNames[i]] = state[i]
    min[stateNames[i]] = low
    max[stateNames[i]] = high
  }

  return {
    method,
    stateVariables: stateNames,
    steps,
    t0,
    tEnd,
    downsampled: sampled.length !== rows.length,
    sampledPoints: sampled.length,
    final,
    series: sampled,
    min,
    max,
  }
}

/* ------------------------------------------------------------------ *
 * 工具注册
 * ------------------------------------------------------------------ */

/** 单位换算工具的渲染文本（永不抛错）。 */
function renderUnitConvert(_args, value) {
  try {
    if (value !== null && typeof value === 'object' && typeof value.formatted === 'string' && value.formatted.length > 0) {
      return [{ type: 'text', text: value.formatted }]
    }
    return [{ type: 'text', text: '单位换算完成（缺少可渲染的 formatted 字段）' }]
  } catch (error) {
    return [{ type: 'text', text: '单位换算完成（渲染失败）' }]
  }
}

/** 常数查询工具的渲染文本（永不抛错）。 */
function renderConstantLookup(_args, value) {
  try {
    const records = value !== null && typeof value === 'object' && Array.isArray(value.constants) ? value.constants : []
    if (records.length === 0) return [{ type: 'text', text: '（没有匹配的常量）' }]
    const width = records.reduce((widest, record) => {
      const symbol = record !== null && typeof record === 'object' ? String(record.symbol ?? '?') : '?'
      return Math.max(widest, symbol.length)
    }, 1)
    const lines = records.map((record) => {
      const entry = record !== null && typeof record === 'object' ? record : {}
      const symbol = String(entry.symbol ?? '?').padEnd(width, ' ')
      const amount = formatSignificant(typeof entry.value === 'number' ? entry.value : Number.NaN, 7)
      const uncertainty = typeof entry.uncertainty === 'number' ? ` ± ${formatSignificant(entry.uncertainty, 2)}` : ''
      const unit = typeof entry.unit === 'string' ? ` ${entry.unit}` : ''
      const exact = entry.exact === true ? ' (exact)' : ''
      return `${symbol}  ${amount}${uncertainty}${unit}${exact}`
    })
    return [{ type: 'text', text: `${lines.join('\n')}\n（共 ${records.length} 个常量，CODATA 2022）` }]
  } catch (error) {
    return [{ type: 'text', text: '常量查询完成（渲染失败，请读取结构化字段）' }]
  }
}

/** ODE 工具的渲染文本（永不抛错）。 */
function renderOdeSimulate(_args, value) {
  try {
    const holder = value !== null && typeof value === 'object' ? value : {}
    const names = Array.isArray(holder.stateVariables) ? holder.stateVariables.map((item) => String(item)) : []
    const final = holder.final !== null && typeof holder.final === 'object' ? holder.final : {}
    const min = holder.min !== null && typeof holder.min === 'object' ? holder.min : {}
    const max = holder.max !== null && typeof holder.max === 'object' ? holder.max : {}
    const lines = [
      `ode_simulate ${String(holder.method ?? '?')}：${names.length} 个状态变量 × ${String(holder.steps ?? '?')} 步，`
      + `t ∈ [${formatSignificant(holder.t0, 6)}, ${formatSignificant(holder.tEnd, 6)}]`,
      `final @ t=${formatSignificant(holder.tEnd, 6)}: ${names.map((key) => `${key}=${formatSignificant(final[key], 6)}`).join(', ') || '(无状态变量)'}`,
    ]
    for (const key of names) {
      lines.push(`  ${key}: min=${formatSignificant(min[key], 6)} max=${formatSignificant(max[key], 6)} 终值=${formatSignificant(final[key], 6)}`)
    }
    if (holder.downsampled === true) {
      lines.push(`（series 已按 ${String(holder.sampledPoints ?? '?')} 点均匀降采样；min/max 仍取自完整网格）`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  } catch (error) {
    return [{ type: 'text', text: 'ODE 积分完成（渲染失败，请读取结构化字段）' }]
  }
}

/**
 * 注册科研计算工具。
 * @param ctx - 挂载上下文；插件只使用 `tools` 注册表。
 */
export function apply(ctx) {
  ctx.tools.register(toToolDefinition({
    name: 'unit_convert',
    description: [
      'Convert a physical quantity between units of the SAME dimension. Dimensions:',
      'length (m, metre, meter, km, cm, mm, um/µm, nm, pm, in, inch, ft, foot, yd, yard, mi, mile, nmi),',
      'mass (kg, g, mg, ug/µg, ng, pg, t, tonne, lb, lbs, pound, oz, ounce),',
      'time (s, sec, second, ms, us/µs, ns, min, minute, h, hr, hour, d, day),',
      'volume (L, l, litre, liter, mL, ml, uL/µL, m3, cm3, mm3, gal, gallon),',
      'amount (mol, mmol, umol/µmol, nmol, pmol), temperature (K, kelvin, C, celsius, degC, F, fahrenheit, degF only),',
      'pressure (Pa, kPa, MPa, GPa, bar, mbar, atm, mmHg, torr, psi),',
      'energy (J, kJ, MJ, cal, kcal, Cal, eV, keV, MeV, Wh, kWh),',
      'concentration (M, mM, uM/µM, nM, pM as mol/m3), data (B, byte, KB, MB, GB, TB = powers of 1000; KiB, MiB, GiB, TiB = powers of 1024).',
      'Unit strings are trimmed and then matched CASE-SENSITIVELY (m = metre, M = molar, mL = millilitre, ML is unknown); the aliases above are accepted, and an all-lowercase string may fall back to a lowercase alias.',
      'Temperature is affine, not proportional (K = C + 273.15, F = (C x 9/5) + 32), and only K/C/F exist: same-unit conversion is the identity (1 F -> F is exactly 1) and the anchor points are exact (0 C = 32 F, 100 C = 373.15 K), while other affine round-trips agree to within a few ULPs of double precision rather than bit-exactly.',
      'Cross-dimension conversion is REFUSED with an error naming both dimensions (e.g. kg -> m fails); there is no compound-unit arithmetic, so "m/s", "J*s" or "kg/m3" are not valid unit strings.',
      '`factor` is the multiplicative factor from `from` to `to` for linear units; for temperature it is only the slope ratio, because an offset applies.',
      'Results and factors are rounded to 15 significant digits, which removes binary floating-point noise (1 L -> cm3 is exactly 1000) while staying inside double precision.',
    ].join(' '),
    parameters: {
      value: { type: 'number', required: true, description: 'The numeric quantity to convert (must be finite).' },
      from: { type: 'string', required: true, description: 'Source unit, e.g. "km", "C", "mg", "KiB".' },
      to: { type: 'string', required: true, description: 'Target unit of the same dimension, e.g. "m", "F", "ug", "MiB".' },
      precision: { type: 'number', description: `Significant digits used in the rendered text (default ${DEFAULT_PRECISION}, clamped to 1..${MAX_PRECISION}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'number', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          dimension: { type: 'string', required: true },
          result: { type: 'number', required: true },
          formatted: { type: 'string', required: true },
          factor: { type: 'number', required: true },
        },
      },
      render: renderUnitConvert,
    },
    async execute(args) {
      const value = toFiniteNumber(args.value, 'value')
      const from = typeof args.from === 'string' ? args.from.trim() : ''
      const to = typeof args.to === 'string' ? args.to.trim() : ''
      if (from.length === 0) throw new Error('from 不能为空')
      if (to.length === 0) throw new Error('to 不能为空')
      const precision = args.precision === undefined
        ? DEFAULT_PRECISION
        : Math.min(MAX_PRECISION, Math.max(1, Math.round(toFiniteNumber(args.precision, 'precision'))))
      const { dimension, result, factor } = convertValue(value, from, to)
      if (!Number.isFinite(result)) {
        throw new Error(`换算结果超出双精度浮点范围：${formatSignificant(value, precision)} ${from} -> ${to}`)
      }
      const formatted = `${formatSignificant(value, precision)} ${from} = ${formatSignificant(result, precision)} ${to}`
      return { value, from, to, dimension, result, formatted, factor }
    },
  }))

  ctx.tools.register(toToolDefinition({
    name: 'constant_lookup',
    description: [
      'Look up physical constants from the CODATA 2022 recommended values (exact-by-definition constants such as c, h, e, kB and NA carry uncertainty null and exact true).',
      'Constants known by this plugin include c (speed of light), h, hbar, kB (Boltzmann), NA (Avogadro), R (molar gas constant), G (gravitation), g_n, e (elementary charge), me, mp, mn, u (atomic mass), mu0, eps0, alpha (fine structure), F (Faraday), sigma (Stefan-Boltzmann), Rinf (Rydberg), a0 (Bohr radius), muB, muN, lambdaC, re, Eh (Hartree), eV, Vm, n0, b, c1, c2, G0, Phi0, RK, KJ, T0, h_eV, kB_eV, m_p_me and the Planck units.',
      '`name` is case-insensitive and accepts symbols, full names and aliases; when nothing matches, the error lists the closest known names.',
      '`list: true` returns every known constant; `search` is a case-insensitive substring filter over names and aliases and is normally combined with `list: true`.',
      '`unit` converts a single constant into a unit understood by unit_convert (same dimension rules, cross-dimension conversion is refused) and therefore requires `name`; composite stored units (m/s, J*s, C/mol) cannot be converted and are reported as an error instead of being converted wrongly.',
      'Uncertainties are absolute, in the same unit as the reported value; every numeric field is finite or explicitly null.',
    ].join(' '),
    parameters: {
      name: { type: 'string', description: 'Constant name, symbol or alias (case-insensitive), e.g. "c", "speed of light", "kB", "avogadro", "fine structure".' },
      list: { type: 'boolean', description: 'When true, return every constant the plugin knows (combine with `search` to filter).' },
      search: { type: 'string', description: 'Case-insensitive substring filter over constant names and aliases.' },
      unit: { type: 'string', description: 'Target unit for a single constant (requires `name`), e.g. "km" for a length-valued constant; must have the same dimension as the constant\'s own unit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          constants: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                symbol: { type: 'string', required: true },
                name: { type: 'string', required: true },
                value: { type: 'number', required: true },
                unit: { type: 'string', required: true },
                uncertainty: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                exact: { type: 'boolean', required: true },
                codataValue: { type: 'number', required: true },
                codataUnit: { type: 'string', required: true },
                converted: { type: 'boolean', required: true },
              },
            },
          },
          count: { type: 'number', required: true },
        },
      },
      render: renderConstantLookup,
    },
    async execute(args) {
      const rawName = typeof args.name === 'string' ? args.name.trim() : ''
      const search = typeof args.search === 'string' && args.search.trim().length > 0 ? args.search.trim().toLowerCase() : undefined
      const targetUnit = typeof args.unit === 'string' && args.unit.trim().length > 0 ? args.unit.trim() : undefined

      if (targetUnit !== undefined && rawName.length === 0) {
        throw new Error('unit 只能与 name 一起使用：单位换算只对单个常量有意义，请给出 name 或去掉 unit')
      }
      if (rawName.length > 0) {
        const entry = lookupConstant(rawName)
        if (entry === undefined) {
          throw new Error(`未知常量 "${rawName}"；最接近的候选：${closestConstantNames(rawName).join('、')}`)
        }
        return { constants: [constantRecord(entry, targetUnit)], count: 1 }
      }
      if (args.list !== true && search === undefined) {
        throw new Error('请给出 name（查询单个常量）、list: true（列出全部）或 search（子串过滤）之一')
      }
      const matches = search === undefined
        ? CONSTANTS
        : CONSTANTS.filter((entry) => constantHaystack(entry).includes(search))
      return { constants: matches.map((entry) => constantRecord(entry, undefined)), count: matches.length }
    },
  }))

  ctx.tools.register(toToolDefinition({
    name: 'ode_simulate',
    description: [
      'Integrate a small system of first-order ODEs dy/dt = f(t, y) and return the trajectory on a uniform time grid.',
      '`equations` maps each state variable name to a FORMULA STRING over the state variables and the supplied parameters, e.g. {"S":"-beta*S*I/N","I":"beta*S*I/N - gamma*I","R":"gamma*I"}.',
      'The formula language is a deliberately restricted, hand-written interpreter (never eval/new Function/vm): numbers with scientific notation, state variables, parameters, + - * / ^ (^ is right-associative and binds tighter than * and /), unary minus, parentheses, and the functions exp, ln, log (= ln), log10, log2, sqrt, abs, sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, min, max, pow, floor, ceil, sign, heaviside.',
      'There is NO time variable, NO assignment, comparison, member access, arrays or any other identifier: a name that is neither a state variable nor a supplied parameter is an error, and malformed formulas report the offending token and its position.',
      '`initial` must have exactly the same keys as `equations`.',
      'Method `rk4` (default) is classic fourth-order Runge-Kutta; `rk45` is an adaptive Dormand-Prince integrator with max-norm error control (rtol default 1e-6, atol default 1e-9) that subdivides internally but still reports on the uniform grid; `euler` is plain forward Euler, the lowest-accuracy option, present only for comparison.',
      '`steps` is a positive integer capped at 100000, and tEnd must be greater than t0 (t0 defaults to 0).',
      'Any non-finite intermediate value aborts with an error naming the step and the state variable, so a blowing-up or ill-defined system is reported rather than returned as Infinity.',
      '`series` is evenly downsampled to at most 200 points when steps exceeds that (flagged by `downsampled`); `min`/`max` are always taken over the full grid.',
    ].join(' '),
    parameters: {
      equations: { type: 'object', required: true, additionalProperties: true, description: 'Map of state variable name -> formula string, e.g. {"S":"-beta*S*I/N","I":"beta*S*I/N - gamma*I","R":"gamma*I"}.' },
      initial: { type: 'object', required: true, additionalProperties: true, description: 'Map of state variable name -> finite initial value; the key set must equal the key set of `equations`.' },
      parameters: { type: 'object', additionalProperties: true, description: 'Map of parameter name -> finite numeric value referenced by the formulas. A parameter may not share a name with a state variable.' },
      t0: { type: 'number', description: 'Start time (default 0).' },
      tEnd: { type: 'number', required: true, description: 'End time; must be strictly greater than t0.' },
      steps: { type: 'number', required: true, description: `Positive integer number of uniform steps (max ${MAX_ODE_STEPS}).` },
      method: { type: 'string', description: 'Integration method: "rk4" (default), "rk45" (adaptive Dormand-Prince), or "euler" (lowest accuracy, for comparison).' },
      rtol: { type: 'number', description: `Relative tolerance for method "rk45" (default ${DEFAULT_RTOL}); ignored by rk4/euler.` },
      atol: { type: 'number', description: `Absolute tolerance for method "rk45" (default ${DEFAULT_ATOL}); ignored by rk4/euler.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', required: true },
          stateVariables: { type: 'array', required: true, items: { type: 'string' } },
          steps: { type: 'number', required: true },
          t0: { type: 'number', required: true },
          tEnd: { type: 'number', required: true },
          downsampled: { type: 'boolean', required: true },
          sampledPoints: { type: 'number', required: true },
          final: { type: 'object', required: true, additionalProperties: true },
          series: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          min: { type: 'object', required: true, additionalProperties: true },
          max: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: renderOdeSimulate,
    },
    async execute(args) {
      return simulateOde(args)
    },
  }))
}
