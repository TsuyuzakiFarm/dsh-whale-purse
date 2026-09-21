/**
 * dsh-whale-purse — 配置契约（Config schema）。
 *
 * DSH 约定：凡是两个部署可能取值不同的量都必须是配置字段，并且配置错误要在
 * 插件加载时响亮地失败。Cordis 对此只要求一个 Standard Schema v1：它同步调用
 * `runtime.Config['~standard'].validate(config)`（cordis/src/fiber.ts），issues
 * 非空即抛 ValidationError。
 *
 * 为什么这里不用 `@deepseek-ai/schemastery`：本插件以 profile link / marketplace
 * clone 两种方式安装，两者都不会为被链接的包安装依赖，实测在两个副本里
 * `import('@deepseek-ai/schemastery')` 都是 ERR_MODULE_NOT_FOUND。引入运行时依赖
 * 会把“插件能加载”变成“插件加载失败”，所以这里用零依赖的 Standard Schema 实现：
 * 语义与 Schemastery object 的默认行为一致——未声明字段剔除、缺失字段落默认值、
 * 类型/范围不合法则报错并带上字段路径。
 *
 * @module dsh-whale-purse/config
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 家目录：面板设置与节假日缓存的默认落点。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 官方定价页（价格自动刷新的默认来源）。 */
export const DEFAULT_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** 中国法定节假日数据源模板（`{year}` 占位，按顺序回退）。 */
export const DEFAULT_HOLIDAY_DATA_URLS = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
]

/**
 * 字段表：type 决定校验分支，default/optional 决定缺失时的行为，
 * min/max/maxLength/pattern/values 是取值范围约束。
 */
const FIELDS = {
  enabled: { type: 'boolean', default: true },
  model: { type: 'enum', values: ['auto', 'pro', 'flash'], default: 'auto' },
  apiKeyEnv: { type: 'string', default: 'DEEPSEEK_API_KEY', pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ },
  baseUrl: { type: 'string', default: 'https://api.deepseek.com', pattern: /^https?:\/\//, maxLength: 256 },
  refreshIntervalSeconds: { type: 'number', default: 30, min: 5, max: 86_400 },
  pricingRefreshHours: { type: 'number', default: 6, min: 0.25, max: 720 },
  pricingUrl: { type: 'string', default: DEFAULT_PRICING_URL, pattern: /^https?:\/\//, maxLength: 512 },
  holidayDataUrls: { type: 'stringList', default: DEFAULT_HOLIDAY_DATA_URLS },
  requestTimeoutMs: { type: 'number', default: 15_000, min: 1_000, max: 120_000 },
  lowBalanceThreshold: { type: 'number', default: 10, min: 0 },
  dailyBudget: { type: 'number', min: 0, optional: true },
  proBilledAsFlash: { type: 'boolean', default: true },
  makeupWorkdaysArePeak: { type: 'boolean', default: false },
  statePath: { type: 'string', default: join(DSH_HOME, 'dsh-whale-purse.settings.json'), maxLength: 1024 },
  holidayCachePath: { type: 'string', default: join(DSH_HOME, 'dsh-whale-purse.holidays.json'), maxLength: 1024 },
}

/** 值的类型名（错误信息用）。 */
function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 单个字段的校验：合法返回解析后的值，非法 push issue 并返回 undefined。 */
function readField(key, spec, raw, issues) {
  const reject = (message) => {
    issues.push({ path: [key], message })
    return undefined
  }
  if (spec.type === 'boolean') {
    return typeof raw === 'boolean' ? raw : reject(`expected boolean, got ${typeName(raw)}`)
  }
  if (spec.type === 'number') {
    const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN)
    if (!Number.isFinite(value)) return reject(`expected a finite number, got ${JSON.stringify(raw)}`)
    if (spec.min !== undefined && value < spec.min) return reject(`must be >= ${spec.min}, got ${value}`)
    if (spec.max !== undefined && value > spec.max) return reject(`must be <= ${spec.max}, got ${value}`)
    return value
  }
  if (spec.type === 'enum') {
    return spec.values.includes(raw) ? raw : reject(`expected one of ${spec.values.join(' | ')}, got ${JSON.stringify(raw)}`)
  }
  if (spec.type === 'stringList') {
    if (!Array.isArray(raw) || raw.length === 0) return reject(`expected a non-empty array of strings, got ${typeName(raw)}`)
    const bad = raw.findIndex((item) => typeof item !== 'string' || item === '')
    if (bad >= 0) return reject(`entry #${bad} must be a non-empty string`)
    return [...raw]
  }
  if (typeof raw !== 'string' || raw === '') return reject(`expected a non-empty string, got ${typeName(raw)}`)
  if (spec.maxLength !== undefined && raw.length > spec.maxLength) return reject(`must be at most ${spec.maxLength} characters`)
  if (spec.pattern !== undefined && !spec.pattern.test(raw)) return reject(`does not match ${String(spec.pattern)}`)
  return raw
}

/** 默认配置（对空输入跑一遍 schema 的结果）。 */
export function defaultConfig() {
  return Config['~standard'].validate({}).value
}

/**
 * 插件配置。导出普通对象无效：Cordis 需要的是实现了 Standard Schema v1 的
 * schema 对象（`~standard.validate`），不是字段清单。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-whale-purse',
    /**
     * 同步校验 + 补默认值。
     * @param raw - cordis.patch.yml 里该插件行 config 字段的原始值。
     * @returns `{ value }` 或 `{ issues }`（issues 非空时插件加载失败）。
     */
    validate(raw) {
      const input = raw === undefined || raw === null ? {} : raw
      if (typeof input !== 'object' || Array.isArray(input)) {
        return { issues: [{ message: `expected an object, got ${typeName(input)}` }] }
      }
      const value = {}
      const issues = []
      for (const [key, spec] of Object.entries(FIELDS)) {
        const provided = input[key]
        const missing = provided === undefined || provided === null || provided === ''
        if (missing) {
          if (spec.default !== undefined) value[key] = spec.default
          continue
        }
        const parsed = readField(key, spec, provided, issues)
        if (parsed !== undefined) value[key] = parsed
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}

/** 字段名清单（README 与设置面板共用）。 */
export const CONFIG_KEYS = Object.keys(FIELDS)
