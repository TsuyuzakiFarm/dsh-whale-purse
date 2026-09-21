/**
 * dsh-whale-purse — host half.
 *
 * DeepSeek 账户余额 + 会话用量花费读出，直接挂进 DSH Web profile 的组合层
 * （`~/.dsh/profiles/web/cordis.patch.yml` 的 insert 条目，热重载生效）。
 *
 * - 通过凭据缝（credentials seam，默认 `DEEPSEEK_API_KEY`）查询官方
 *   Get User Balance 接口，30s 缓存 + 并发去重。
 * - 通过 `sessionProjections` 注册表读取当前会话的 `tokenUsage` 投影
 *   （与内置 stats 行同一套记账），按官方价格折算花费。
 * - 价格内置官方预设，并每 6h 自动抓取官方定价页；2026-08-17 起峰谷
 *   定价自动生效（北京周一至周五且非中国法定节假日的 9:00-12:00 /
 *   14:00-18:00 为高峰，周末与法定节假日全天空闲）。
 * - 价格按“时代”记账：2026-09-10 12:00（北京）起 Flash 系列降价（v2），
 *   2026-08-17 之前为统一价（standard）；历史消息按各自时刻的时代价目计价。
 * - 浏览器半边走同源 JSON 接口：/api/whale-purse/balance、/api/whale-purse/balance/refresh、
 *   /api/whale-purse/balance/cost 等。这些 exact Fetch 路由注册在 connection 的 Fetch
 *   路由表上，因而与内置 /api 通道同处浏览器认证 + Host/Origin 围栏之内。
 * - 可调参数由 ./config.js 的 Config schema 校验并补默认值（配置错误在加载期报错）。
 *
 * 除 node: 内建与同目录的 config.js 外零依赖，作为纯 ESM cordis 插件被 Loader 加载。
 * @module whale-purse
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Config, defaultConfig } from './config.js'

export { Config }

/** 插件名：与 cordis.patch.yml 的 insert.name 及客户端 bundle id 一致。 */
export const name = 'dsh-whale-purse'

/**
 * 需要的服务（Loader 会在 apply 前解析好）。
 * - connection：exact Fetch 路由注册表（/api 通道的浏览器认证 + Host/Origin 围栏）。
 * - sessions：当前会话对象。
 * 可选缝（credentials / launchEnvironment / sessionProjections / sessionPersistence）
 * 由 apply 里的 ctx.inject 绑定，不写进 inject：缝缺席时插件仍要能工作。
 */
export const inject = ['connection', 'sessions']

/** 峰谷定价生效时间：2026-08-17 00:00 北京时间（UTC+8）。 */
const PEAK_PRICING_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0)
/** Flash 系列降价生效时间：2026-09-10 12:00 北京时间（UTC+8）。 */
const FLASH_PRICE_CUT_MS = Date.UTC(2026, 8, 10, 4, 0, 0)

// ---------------------------------------------------------------------------
// 价格模型（元 / 百万 tokens）
//
// 峰谷口径按官方定价页脚注字面执行：高峰时段 = 北京时间**周一至周五且非
// 中国法定节假日**的 9:00-12:00、14:00-18:00；**其余时段，包括周末及中国
// 法定节假日全天**均为空闲时段（见 CN_HOLIDAY_RANGES）。
//
// 三个价格时代（era）：
//   standard — 2026-08-17 00:00 北京之前：统一价
//   v1       — 2026-08-17 00:00 北京起：峰谷首版
//   v2       — 2026-09-10 12:00 北京起：Flash 系列降价（官方 2026-09-09 公告）
//
// 历史消息按 event.time 落到对应时代，所以 band 标签按时代区分
// （v1: peak/off-peak，v2: peak-2/off-peak-2），分桶累加才不会跨时代串价。
// ---------------------------------------------------------------------------

/** 峰谷生效前的统一价：缓存命中输入 / 未命中输入 / 输出。 */
const CURRENT_PRESETS = {
  flash: { cacheRead: 0.02, input: 1, output: 2 },
  pro: { cacheRead: 0.025, input: 3, output: 6 },
}

/** 峰谷价目 v1（2026-08-17 ~ 2026-09-10 12:00 北京），空闲时段价格为高峰的一半。 */
const PEAK_PRESETS_V1 = {
  flash: {
    offPeak: { cacheRead: 0.05, input: 1.5, output: 4.5 },
    peak: { cacheRead: 0.10, input: 3.0, output: 9.0 },
  },
  pro: {
    offPeak: { cacheRead: 0.15, input: 4.5, output: 13.5 },
    peak: { cacheRead: 0.30, input: 9.0, output: 27.0 },
  },
}

/**
 * 峰谷价目 v2（2026-09-10 12:00 北京起）：仅 Flash 系列降价
 * （命中 0.05→0.02、未命中 1.5→1、输出 4.5→4；高峰价为谷价 2 倍）。
 * Pro 自身价目官方未调整；V4.1 Flash 上线后 Pro 请求按其单价计费，
 * 由 proBilledAsFlash 开关控制（见 billedModelOf）。
 */
const PEAK_PRESETS_V2 = {
  flash: {
    offPeak: { cacheRead: 0.02, input: 1, output: 4 },
    peak: { cacheRead: 0.04, input: 2, output: 8 },
  },
  pro: {
    offPeak: { cacheRead: 0.15, input: 4.5, output: 13.5 },
    peak: { cacheRead: 0.30, input: 9.0, output: 27.0 },
  },
}

/** @deprecated 兼容上游 scripts/smoke-test.mjs 的旧引用，等价于 v1 价目。 */
const PEAK_PRESETS = PEAK_PRESETS_V1

/** 全部计费 band：standard + v1/v2 的峰谷。 */
const ALL_BANDS = ['standard', 'off-peak', 'peak', 'off-peak-2', 'peak-2']

/** 某个时刻所属价格时代：'standard' | 'v1' | 'v2'。 */
function eraOf(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs < PEAK_PRICING_START_MS) return 'standard'
  return epochMs < FLASH_PRICE_CUT_MS ? 'v1' : 'v2'
}

/** band 标签 → { era, offPeak }；非峰谷 band（standard）返回 undefined。 */
function peakBandOf(band) {
  if (band === 'off-peak') return { era: 'v1', offPeak: true }
  if (band === 'peak') return { era: 'v1', offPeak: false }
  if (band === 'off-peak-2') return { era: 'v2', offPeak: true }
  if (band === 'peak-2') return { era: 'v2', offPeak: false }
  return undefined
}

/** （时代, 是否高峰）→ band 标签。 */
function bandLabelOf(era, inPeak) {
  if (era === 'v1') return inPeak ? 'peak' : 'off-peak'
  return inPeak ? 'peak-2' : 'off-peak-2'
}

/** 指定时代的内置价目表。 */
function builtinPeakTable(era) {
  return era === 'v2' ? PEAK_PRESETS_V2 : PEAK_PRESETS_V1
}

/** 宽松布尔解析：接受布尔 / 数字 / YAML 与面板传来的 'true'、'false' 字符串。 */
function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  return fallback
}

/** 两张峰谷价目是否完全一致（用于识别官方页是否仍停留在旧价目）。 */
function samePeakTable(a, b) {
  if (a === undefined || b === undefined) return false
  for (const model of ['flash', 'pro']) {
    for (const band of ['offPeak', 'peak']) {
      for (const key of ['cacheRead', 'input', 'output']) {
        if (a?.[model]?.[band]?.[key] !== b?.[model]?.[band]?.[key]) return false
      }
    }
  }
  return true
}

/** 去掉 HTML 标签与脚本/样式块，压平空白（保持单元格顺序）。 */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取文本里所有 `x元` 数字，顺序保留。 */
function priceValues(text) {
  const values = []
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*元/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}

/**
 * 抽出三个 bucket 的价格单元格文本（命中读 / 未命中读 / 输出）。
 * 锚点必须容忍空白：官方页写的是 `百万tokens输入<br>（缓存命中）`，
 * stripHtml 会把 <br> 变成空格；写死无空格锚点会让整条解析链路静默失效。
 */
function priceSections(html) {
  const hit = /百万tokens输入\s*（缓存命中）([\s\S]{0,600}?)百万tokens输入\s*（缓存未命中）([\s\S]{0,600}?)百万tokens输出([\s\S]{0,600}?)(?:并发限制|扣费规则|$)/i.exec(stripHtml(html))
  return hit === null ? undefined : [hit[1], hit[2], hit[3]]
}

/**
 * 从表头（`模型 | deepseek-flash | deepseek-v4-pro | …`）解析 flash / pro
 * 在价格单元格里的列下标：官方页新增模型列（如 vision / v4.1）时不会错位。
 * 模型名兼容新旧两代写法（2026-09 起官方档位列名由 deepseek-v4-flash
 * 换成 deepseek-flash）。解析不出时返回 undefined，调用方回退两列布局。
 */
function modelColumns(html) {
  const header = /模型\s+((?:deepseek-[\w.-]+(?:\s*\(\d+\))?\s*)+)/i.exec(stripHtml(html))?.[1] ?? ''
  // 去掉档位名后的脚注标记（官方页写作 `deepseek-flash(1)`）。
  const names = header.trim().split(/\s+/).map((n) => n.replace(/\(\d+\)$/, '')).filter((n) => n !== '')
  const flash = names.findIndex((n) => /^deepseek-(v4-)?flash$/i.test(n))
  const pro = names.findIndex((n) => /^deepseek-(v4-)?pro$/i.test(n))
  return flash >= 0 && pro >= 0 ? { flash, pro } : undefined
}

/**
 * 解析无峰谷标签的“统一价”表：每个 bucket 单元格只有两个价格
 * （flash、pro）。当前官方页已是峰谷表时返回 undefined，由内置
 * CURRENT_PRESETS 继续负责生效日前的历史价。
 */
function parseCurrentTable(html) {
  const sections = priceSections(html)
  if (sections === undefined) return undefined
  if (sections.some((cell) => /空闲时段|高峰时段/.test(cell))) return undefined
  const columns = modelColumns(html) ?? { flash: 0, pro: 1 }
  const needed = Math.max(columns.flash, columns.pro) + 1
  const buckets = sections.map((cell) => priceValues(cell))
  if (buckets.some((values) => values.length < needed)) return undefined
  const pick = (column) => ({ cacheRead: buckets[0][column], input: buckets[1][column], output: buckets[2][column] })
  return { flash: pick(columns.flash), pro: pick(columns.pro) }
}

/**
 * 解析峰谷定价表。新版页面把 flash/pro 作为列放在 bucket 单元格里：
 * `空闲时段 0.05元 0.15元 高峰时段 0.10元 0.30元`；
 * 同时兼容旧版“模型名 + 空闲时段… 高峰时段…”的逐行写法。
 */
function parsePeakTable(html) {
  const sections = priceSections(html)
  if (sections !== undefined) {
    const columns = modelColumns(html) ?? { flash: 0, pro: 1 }
    const needed = Math.max(columns.flash, columns.pro) + 1
    const offPeak = sections.map((cell) => priceValues(/空闲时段([\s\S]*?)(?:高峰时段|$)/.exec(cell)?.[1] ?? ''))
    const peak = sections.map((cell) => priceValues(/高峰时段([\s\S]*?)$/.exec(cell)?.[1] ?? ''))
    if (offPeak.every((values) => values.length >= needed) && peak.every((values) => values.length >= needed)) {
      const pick = (column) => ({
        offPeak: { cacheRead: offPeak[0][column], input: offPeak[1][column], output: offPeak[2][column] },
        peak: { cacheRead: peak[0][column], input: peak[1][column], output: peak[2][column] },
      })
      return { flash: pick(columns.flash), pro: pick(columns.pro) }
    }
  }

  const text = stripHtml(html)
  const row = /deepseek-v4-(flash|pro)\s+空闲时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+高峰时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元/gi
  const result = {}
  for (const match of text.matchAll(row)) {
    result[match[1]] = {
      offPeak: { cacheRead: Number(match[2]), input: Number(match[3]), output: Number(match[4]) },
      peak: { cacheRead: Number(match[5]), input: Number(match[6]), output: Number(match[7]) },
    }
  }
  if (result.flash === undefined || result.pro === undefined) return undefined
  return result
}

/**
 * 解析 holiday-cn 的年份 JSON（\`{ days: [{ date, isOffDay, name }] }\`）：
 * isOffDay=true 为放假日期，false 为调休上班日期。数据缺失时返回空数组。
 */
function parseHolidayYear(raw) {
  const holidays = []
  const makeup = []
  const days = raw !== null && typeof raw === 'object' && Array.isArray(raw.days) ? raw.days : []
  for (const day of days) {
    if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
    if (day.isOffDay === true) holidays.push(day.date)
    else if (day.isOffDay === false) makeup.push(day.date)
  }
  return { holidays, makeup }
}

/** 需要抓取的年份：北京今年 + 前后各一年（跨年回看历史与前瞻都够用）。 */
function holidayYearsAround(epochMs) {
  const year = Number(beijingDateKey(epochMs).slice(0, 4))
  if (!Number.isFinite(year)) return []
  return [String(year - 1), String(year), String(year + 1)]
}

/**
 * 按年份抓取节假日数据，返回 { '2026': { holidays, makeup } }。
 * 单个源失败自动换下一个源，单年失败不影响其它年份；全部失败返回 {}。
 * @param years - 年份字符串数组。
 * @param options - { urls（含 {year} 占位的数据源）, fetchImpl, timeoutMs, signal }。
 */
async function fetchHolidays(years, { urls, fetchImpl = globalThis.fetch, timeoutMs = 10_000, signal } = {}) {
  const result = {}
  for (const year of years) {
    for (const template of urls ?? []) {
      // 插件已卸载：立刻收工，不再发起后续源的请求。
      if (signal?.aborted) return result
      try {
        const gate = requestGate(timeoutMs, signal)
        let response
        try {
          response = await fetchImpl(template.replace('{year}', year), { signal: gate.signal })
        } finally {
          gate.release()
        }
        if (!response.ok) continue
        const parsed = parseHolidayYear(await response.json())
        // 未公布年份的占位文件是空数组：视为“暂无数据”，继续尝试下一个源。
        if (parsed.holidays.length === 0 && parsed.makeup.length === 0) continue
        result[year] = parsed
        break
      } catch {
        // 换下一个源；全失败则本年缺席（沿用内置表与原规则）。
      }
    }
  }
  return result
}

/**
 * 抓取并解析官方定价页。失败时返回内置预设并记录 error，绝不抛出。
 * @param options - { url（定价页）, fetchImpl（测试注入）, timeoutMs, signal（生命周期）}。
 */
async function fetchPricing({ url, fetchImpl = globalThis.fetch, timeoutMs = 15_000, signal } = {}) {
  const fetchedAt = Date.now()
  try {
    const gate = requestGate(timeoutMs, signal)
    let response
    try {
      response = await fetchImpl(url, { signal: gate.signal })
    } finally {
      gate.release()
    }
    if (!response.ok) return { fetchedAt, error: `pricing page HTTP ${response.status}` }
    const html = await response.text()
    const current = parseCurrentTable(html)
    const peak = parsePeakTable(html)
    if (current === undefined && peak === undefined) return { fetchedAt, error: 'pricing table not found' }
    return {
      fetchedAt,
      ...(current === undefined ? {} : { current }),
      ...(peak === undefined ? {} : { peak }),
    }
  } catch (error) {
    return { fetchedAt, error: friendlyError(error, '定价页获取') }
  }
}

/**
 * 北京时刻读取器（星期 + 小时）：复用 formatter，避免每条事件都新建。
 * 官方高峰口径：高峰时段为北京时间周一至周五（**不含中国法定节假日**）
 * 9:00-12:00、14:00-18:00；**其余时间（含周末、法定节假日全天）为空闲时段**。
 */
const BEIJING_PEAK_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  hour: 'numeric',
  hour12: false,
  hourCycle: 'h23',
  weekday: 'short',
})

/**
 * 中国法定节假日（北京日期）——官方定价页脚注口径：
 * 高峰时段 = 北京时间**周一至周五且非中国法定节假日**的 9:00-12:00、
 * 14:00-18:00；**其余时段，包括周末及中国法定节假日全天**均为空闲时段。
 *
 * 日期取自国务院办公厅放假安排通知（2026 年共 7 组）：
 *   https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 * 这里收录的是放假日期（含调休形成的连休）；调休上班的周末仍按“周末 = 空闲
 * 时段”处理，符合脚注“周末全天均为空闲时段”的字面口径。
 * 新增年份按同样的 [首日, 末日] 追加即可；未收录的年份退化为“周一至周五”规则。
 */
const CN_HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明节
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午节
  ['2026-09-25', '2026-09-27'], // 中秋节
  ['2026-10-01', '2026-10-07'], // 国庆节
]

/** 把 CN_HOLIDAY_RANGES 展开成 'YYYY-MM-DD' 集合（含首尾）。 */
const CN_HOLIDAYS = (() => {
  const days = new Set()
  for (const [from, to] of CN_HOLIDAY_RANGES) {
    const start = Date.parse(from + 'T00:00:00Z')
    const end = Date.parse(to + 'T00:00:00Z')
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    for (let ms = start; ms <= end; ms += 86_400_000) days.add(new Date(ms).toISOString().slice(0, 10))
  }
  return days
})()

/** 运行时抓取到的放假 / 调休上班日期（北京日期），与内置表取并集。 */
const fetchedHolidays = new Set()
const fetchedMakeupDays = new Set()

/** 'YYYY-MM-DD' 形状校验。 */
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * 并入 holiday-cn 的解析结果：{ '2026': { holidays: [...], makeup: [...] } }。
 * 只做增量并入（内置表不删除、坏值一律跳过），返回新增的放假天数。
 */
function applyHolidayData(years) {
  if (years === null || typeof years !== 'object') return 0
  let added = 0
  for (const entry of Object.values(years)) {
    if (entry === null || typeof entry !== 'object') continue
    for (const date of Array.isArray(entry.holidays) ? entry.holidays : []) {
      if (!DATE_KEY_PATTERN.test(String(date))) continue
      if (CN_HOLIDAYS.has(date) || fetchedHolidays.has(date)) continue
      fetchedHolidays.add(date)
      added += 1
    }
    for (const date of Array.isArray(entry.makeup) ? entry.makeup : []) {
      if (DATE_KEY_PATTERN.test(String(date))) fetchedMakeupDays.add(date)
    }
  }
  return added
}

/**
 * 当前时刻是否为北京高峰时段：周一至周五（不含中国法定节假日）
 * 9:00-12:00、14:00-18:00。makeupAsPeak 见 isPeakDay。
 */
function isPeakHour(now = new Date(), makeupAsPeak = false) {
  if (!isPeakDay(now.getTime(), makeupAsPeak)) return false
  const hour = Number(BEIJING_PEAK_FORMATTER.formatToParts(now).find((p) => p.type === 'hour')?.value)
  if (Number.isNaN(hour)) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** 北京完整时间读取器，用于计算下一个峰/谷切换点。 */
const BEIJING_DATETIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 北京星期的 ISO 星期几读取器。（Weekday of an epoch moment in Beijing.) */
const BEIJING_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
})

/** 某个时刻的北京星期几（'Mon'..'Sun'）。 */
function beijingWeekday(epochMs) {
  return BEIJING_WEEKDAY_FORMATTER.format(new Date(epochMs))
}

/** 某个时刻的北京日期（'YYYY-MM-DD'），用于查节假日表。 */
function beijingDateKey(epochMs) {
  const parts = BEIJING_DATETIME_FORMATTER.formatToParts(new Date(epochMs))
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 该北京日期是否为中国法定节假日（含调休连休）：内置表 ∪ 官方数据抓取结果。 */
function isChinaHoliday(epochMs) {
  const key = beijingDateKey(epochMs)
  return CN_HOLIDAYS.has(key) || fetchedHolidays.has(key)
}

/**
 * 该时刻是否为“可能处于高峰”的北京工作日：周一至周五且非中国法定节假日。
 * makeupAsPeak=false（默认，官方页脚注字面口径）：周末全天空闲，调休上班的
 * 周末也算空闲；makeupAsPeak=true：官方公布的调休上班日按工作日计高峰。
 */
function isPeakDay(epochMs, makeupAsPeak = false) {
  if (isChinaHoliday(epochMs)) return false
  const weekday = beijingWeekday(epochMs)
  if (weekday !== 'Sat' && weekday !== 'Sun') return true
  return makeupAsPeak && fetchedMakeupDays.has(beijingDateKey(epochMs))
}

/** 给定时刻的北京日期加 offsetDays 天后的 9:00 北京（= 01:00 UTC）。 */
function beijingBoundaryAt(epochMs, offsetDays) {
  const parts = BEIJING_DATETIME_FORMATTER.formatToParts(new Date(epochMs))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(get('year'), get('month') - 1, get('day') + offsetDays, 1, 0, 0)
}

/**
 * 下一个峰谷切换的 UTC epoch ms（北京 9:00 / 12:00 / 14:00 / 18:00）。
 * 只有“北京工作日”（周一至周五且非法定节假日）才有高峰窗口；当前不在高峰
 * 日时，切换点直接指向下一个高峰日的 9:00（跨周末、跨节假日整段跳过）。
 */
function nextPeakBoundary(now = new Date(), makeupAsPeak = false) {
  const epochMs = now.getTime()
  const parts = BEIJING_DATETIME_FORMATTER.formatToParts(now)
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  const minuteOfDay = get('hour') * 60 + get('minute')
  if (isPeakDay(epochMs, makeupAsPeak)) {
    const todayNine = beijingBoundaryAt(epochMs, 0)
    for (const hour of [9, 12, 14, 18]) {
      if (minuteOfDay < hour * 60) return todayNine + (hour - 9) * 3_600_000
    }
  }
  // 向前最多找 60 天（国庆+中秋连休最长也远小于此），保证一定能落到高峰日。
  for (let offset = 1; offset <= 60; offset += 1) {
    const dayNine = beijingBoundaryAt(epochMs, offset)
    if (isPeakDay(dayNine, makeupAsPeak)) return dayNine
  }
  return beijingBoundaryAt(epochMs, 1)
}

/**
 * 是否 DeepSeek 系模型：以 model id 为主，provider 只在 model id 缺失时兜底。
 * 第三方 provider 可能也带 deepseek 字样，不能作为主要判定依据。
 */
function isDeepSeekModel(modelId, provider) {
  if (typeof modelId === 'string' && modelId !== '' && /deepseek/i.test(modelId)) return true
  const empty = modelId === undefined || modelId === ''
  return empty && typeof provider === 'string' && /^(deepseek|deepseek-official)$/i.test(provider)
}

/**
 * 把 provider/model id 归一化到 flash/pro。
 * 非 DeepSeek model（如 gpt-5-pro / qwen2.5-flash）返回 'other' —— 调用方应跳过计价；
 * 无模型信息返回 undefined。
 */
function normalizeModel(modelId, provider) {
  if (typeof modelId !== 'string' || modelId === '') return undefined
  if (!isDeepSeekModel(modelId, provider)) return 'other'
  if (/pro/i.test(modelId)) return 'pro'
  if (/flash/i.test(modelId)) return 'flash'
  // DeepSeek 但无法细分档位（如 deepseek-chat / deepseek-reasoner）按 flash 估算。
  return 'flash'
}

/** 解析 base URL 为 `{ origin, prefix }`。 */
function parseBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`whale-purse: invalid baseUrl "${raw}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`whale-purse: baseUrl must be http(s), got "${url.protocol}"`)
  }
  return { origin: url.origin, prefix: url.pathname.replace(/\/+$/, '') }
}

/** 截断错误正文。 */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}..`
}

/**
 * 把底层错误映射为可读文案：超时/中断（AbortError）统一归为「请求超时」，
 * 避免把浏览器的 "This operation was aborted" 原样抛给用户。
 */
function friendlyError(error, label) {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'AbortError' || /abort/i.test(message)) return `${label}（请求超时）`
  return message || `${label}失败`
}

/**
 * 建一个「超时 + 生命周期」合流的请求闸门：超时或插件卸载都会中止 fetch。
 * 每个请求配一对 release()，负责清掉定时器与监听，不留下跨卸载的孤儿。
 * @param timeoutMs - 单次请求超时毫秒。
 * @param lifecycleSignal - 插件生命周期的 AbortSignal（卸载时 abort）。
 */
function requestGate(timeoutMs, lifecycleSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const forward = () => controller.abort(lifecycleSignal?.reason)
  if (lifecycleSignal?.aborted) forward()
  else lifecycleSignal?.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer)
      lifecycleSignal?.removeEventListener('abort', forward)
    },
  }
}

/** token 数按单价折算金额。 */
function costOfTokens(count, perMillion) {
  if (count <= 0 || !Number.isFinite(count)) return 0
  return (count / 1_000_000) * perMillion
}

/** 四桶 token 计数的零值。 */
function emptyTokenBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** 从 provider usage 读数生成四桶 token 计数。 */
function tokenBucketsOf(usage) {
  return {
    uncachedInputTokens: Number(usage?.inputTokens) || 0,
    outputTokens: Number(usage?.outputTokens) || 0,
    cacheReadTokens: Number(usage?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(usage?.cacheWriteTokens) || 0,
  }
}

/** 从 tokenUsage 投影读数生成四桶 token 计数（字段名与 provider usage 不同）。 */
function projectionBucketsOf(usage) {
  return {
    uncachedInputTokens: Number(usage?.uncachedInputTokens) || 0,
    outputTokens: Number(usage?.outputTokens) || 0,
    cacheReadTokens: Number(usage?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(usage?.cacheWriteTokens) || 0,
  }
}

/**
 * 读取会话事件：新版 DSH（2026-08 更新起）的会话对象不再暴露 `.events` 属性，
 * 改为方法 `session.snapshotEvents()`；旧版直接挂 `.events`。两版都兼容，
 * 都取不到时返回 undefined（调用方跳过事件相关计算）。
 */
function sessionEvents(session) {
  if (session === null || typeof session !== 'object') return undefined
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch { /* 读取异常时回退旧属性 */ }
  }
  return Array.isArray(session.events) ? session.events : undefined
}

/**
 * 列出当前 live 会话：旧版 DSH 的 `sessions.list()` 是函数、返回会话数组；
 * 新版改成快照 store（`sessions.list.getSnapshot()`，含 ids/byId），
 * 需要用 ids + `sessions.get(id)` 取回会话对象。
 */
function liveSessions(sessions) {
  if (sessions === null || sessions === undefined) return []
  const store = sessions.list
  if (store !== null && typeof store === 'object' && typeof store.getSnapshot === 'function') {
    const snapshot = store.getSnapshot()
    const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : []
    const out = []
    for (const id of ids) {
      const session = typeof sessions.get === 'function' ? sessions.get(id) : undefined
      if (session !== undefined && session !== null) out.push(session)
    }
    return out
  }
  if (typeof store === 'function') {
    const value = store.call(sessions)
    return Array.isArray(value) ? value : []
  }
  return []
}

/**
 * DSH「在新会话中新建分支」会在新会话里带入父会话已发生的 seed 事件，
 * 同时用 `seedLength` 标记 seed 的末尾 seq。seed 部分已在父会话计过费，
 * 不应再算进当前分支会话；非分支会话返回 0（从第一条事件开始计费）。
 * @param {object} sessionLike - session 或持久化 snapshot header。
 * @returns {number} seed 边界 seq（该 seq 及之后的事件才属于本会话新产生的内容）。
 */
function seedStartSeq(sessionLike) {
  const raw = sessionLike?.seedLength
    ?? sessionLike?.header?.seedLength
    ?? sessionEvents(sessionLike)?.[0]?.seedLength
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 事件是否属于分支 seed 之前的“历史 checkout”部分。 */
function isSeedEvent(event, boundary) {
  if (boundary <= 0) return false
  const seq = Number(event?.seq)
  return Number.isFinite(seq) && seq < boundary
}

/** 把 addend 的四桶 token 计数累加到 target（原地修改 target）。 */
function addTokenBuckets(target, addend) {
  target.uncachedInputTokens += addend.uncachedInputTokens
  target.outputTokens += addend.outputTokens
  target.cacheReadTokens += addend.cacheReadTokens
  target.cacheWriteTokens += addend.cacheWriteTokens
  return target
}

/** total - subtrahend，每桶下限 0（投影可能落后于已落盘事件）。 */
function subtractTokenBuckets(total, subtrahend) {
  return {
    uncachedInputTokens: Math.max(0, total.uncachedInputTokens - subtrahend.uncachedInputTokens),
    outputTokens: Math.max(0, total.outputTokens - subtrahend.outputTokens),
    cacheReadTokens: Math.max(0, total.cacheReadTokens - subtrahend.cacheReadTokens),
    cacheWriteTokens: Math.max(0, total.cacheWriteTokens - subtrahend.cacheWriteTokens),
  }
}

/** 把 buckets 按 prices 折算的金额累加进 breakdown（缓存写入不单独计费）。 */
function addBucketCost(breakdown, buckets, prices) {
  breakdown.input += costOfTokens(buckets.uncachedInputTokens, prices.input)
  breakdown.cacheRead += costOfTokens(buckets.cacheReadTokens, prices.cacheRead)
  breakdown.cacheWrite += 0
  breakdown.output += costOfTokens(buckets.outputTokens, prices.output)
  return breakdown
}

// ---------------------------------------------------------------------------
// 余额服务
// ---------------------------------------------------------------------------

class BalanceService {
  constructor(ctx, config = defaultConfig()) {
    this.ctx = ctx
    this.config = config
    /** 可选服务缝：由 apply 里的 ctx.inject 绑定/解绑（不用 ctx.get 运行时探测）。 */
    this.seams = {}
    /** 生命周期：卸载时中止在途请求。 */
    this.lifecycle = new AbortController()
    /** 在途后台任务（定价页/节假日抓取）：dispose 等它们收敛后再结束。 */
    this.pendingTasks = new Set()
    this.refreshTimer = undefined

    this.apiKeyEnv = config.apiKeyEnv
    this.baseUrl = config.baseUrl
    this.refreshIntervalMs = config.refreshIntervalSeconds * 1_000
    const userSettings = this.loadUserSettings()
    this.userSettings = userSettings
    const model = userSettings.model ?? config.model
    this.model = model === 'pro' ? 'pro' : model === 'flash' ? 'flash' : 'auto'
    this.lowBalanceThreshold = userSettings.lowBalanceThreshold ?? config.lowBalanceThreshold
    this.dailyBudget = userSettings.dailyBudget ?? config.dailyBudget
    // V4.1 Flash 上线后官方把 Pro 请求路由到 Flash 并按 Flash 单价计费：
    // 默认按该口径计费；可在 YAML 或面板把 proBilledAsFlash 关掉，退回 Pro 自身价目。
    this.proBilledAsFlash = userSettings.proBilledAsFlash ?? config.proBilledAsFlash
    // 官方公布的“调休上班日”都在周末。默认按官网页脚注字面口径：周末一律空闲；
    // 置 true 则把那几天当工作日，按 9:00-12:00 / 14:00-18:00 计高峰。
    this.makeupWorkdaysArePeak = userSettings.makeupWorkdaysArePeak ?? config.makeupWorkdaysArePeak
    this.enabled = config.enabled
    this.cached = undefined
    this.cachedAt = 0
    /** 余额查询的并发去重（与 pendingTasks 不同：这是对外查询的共享结果）。 */
    this.inflight = undefined
    /** 已落盘事件的分桶缓存：key 为 live session 对象，价格快照变化时重扫。 */
    this.sessionUsageCache = new WeakMap()
    /** 已持久化会话的事件缓存：key 为 session id，按 persistence revision 复用。 */
    this.persistedEventCache = new Map()
    /** 价格快照：先落内置预设（最新时代 = v2），后台再刷新官方页。 */
    this.pricingSnapshot = { fetchedAt: Date.now(), current: CURRENT_PRESETS, peak: PEAK_PRESETS_V2 }
    /** 节假日数据：先用本地缓存（离线/重启后可用），再后台抓取官方数据。 */
    this.holidayCache = this.loadHolidayCache()
    this.holidayFetchedAt = this.holidayCache?.fetchedAt ?? 0
    this.holidayError = undefined
  }

  /**
   * 启动后台刷新：立即跑一轮，随后按 pricingRefreshHours 周期重跑。
   * 由 apply 的 ctx.effect 负责关闭（构造函数不做任何副作用）。
   */
  start() {
    const cadenceMs = this.config.pricingRefreshHours * 3_600_000
    this.refreshTimer = setInterval(() => {
      this.track(this.refreshPricing())
      this.track(this.refreshHolidays())
    }, cadenceMs)
    this.refreshTimer.unref?.()
    this.track(this.refreshHolidays())
    this.track(this.refreshPricing())
  }

  /** 记录在途任务：dispose 会等它们全部落地，不把孤儿请求留在卸载之后。 */
  track(task) {
    const tracked = Promise.resolve(task).then(() => {}, () => {}).finally(() => {
      this.pendingTasks.delete(tracked)
    })
    this.pendingTasks.add(tracked)
    return tracked
  }

  /** 卸载：停定时器 → 中止在途请求 → 等它们收敛（异步 disposer，cordis 会 await）。 */
  async dispose() {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
    this.lifecycle.abort()
    await Promise.allSettled([...this.pendingTasks])
  }

  /** 读取节假日缓存并把数据并入内存（不存在/损坏返回 undefined）。 */
  loadHolidayCache() {
    try {
      if (!existsSync(this.config.holidayCachePath)) return undefined
      const raw = JSON.parse(readFileSync(this.config.holidayCachePath, 'utf8'))
      const years = raw === null || typeof raw !== 'object' ? undefined : raw.years
      if (years === null || typeof years !== 'object') return undefined
      applyHolidayData(years)
      return { fetchedAt: Number(raw.fetchedAt) || 0, years }
    } catch {
      return undefined
    }
  }

  /** 写入节假日缓存（目录不存在时自动创建）。 */
  saveHolidayCache(cache) {
    try {
      const dir = join(this.config.holidayCachePath, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.config.holidayCachePath, JSON.stringify(cache, null, 2), 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * 抓取中国法定节假日/调休数据（holiday-cn，出处为国务院办公厅放假安排通知）。
   * 逐年并入并落盘；抓取失败保持现有数据（内置表兜底），绝不影响计价。
   */
  async refreshHolidays() {
    const fetched = await fetchHolidays(holidayYearsAround(Date.now()), {
      urls: this.config.holidayDataUrls,
      timeoutMs: this.config.requestTimeoutMs,
      signal: this.lifecycle.signal,
    })
    if (Object.keys(fetched).length === 0) {
      this.holidayError = 'holiday data unavailable'
      return this.holidayCache
    }
    this.holidayError = undefined
    this.holidayFetchedAt = Date.now()
    applyHolidayData(fetched)
    this.holidayCache = {
      fetchedAt: this.holidayFetchedAt,
      years: { ...(this.holidayCache?.years ?? {}), ...fetched },
    }
    this.saveHolidayCache(this.holidayCache)
    return this.holidayCache
  }


  /** 当前生效单价（默认模型）：官方页优先；峰谷表在生效日后按北京时段取带。 */

  /** 读取面板内设置的本地 JSON；不存在或损坏时返回空对象。 */
  loadUserSettings() {
    try {
      if (!existsSync(this.config.statePath)) return {}
      const raw = JSON.parse(readFileSync(this.config.statePath, 'utf8'))
      if (raw === null || typeof raw !== 'object') return {}
      return {
        model: raw.model === 'pro' || raw.model === 'flash' || raw.model === 'auto' ? raw.model : undefined,
        lowBalanceThreshold: Number.isFinite(Number(raw.lowBalanceThreshold)) ? Math.max(0, Number(raw.lowBalanceThreshold)) : undefined,
        dailyBudget: raw.dailyBudget === undefined || raw.dailyBudget === null || raw.dailyBudget === ''
          ? undefined
          : (Number.isFinite(Number(raw.dailyBudget)) ? Math.max(0, Number(raw.dailyBudget)) : undefined),
        proBilledAsFlash: raw.proBilledAsFlash === undefined ? undefined : toBool(raw.proBilledAsFlash, true),
        makeupWorkdaysArePeak: raw.makeupWorkdaysArePeak === undefined ? undefined : toBool(raw.makeupWorkdaysArePeak, false),
      }
    } catch {
      return {}
    }
  }

  /** 把面板设置写入本地 JSON（目录不存在时自动创建）。 */
  saveUserSettings(settings) {
    try {
      const dir = join(this.config.statePath, '..')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.config.statePath, JSON.stringify(settings, null, 2), 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** 当前面板设置视图。 */
  settingsView() {
    return {
      model: this.model,
      lowBalanceThreshold: this.lowBalanceThreshold,
      dailyBudget: this.dailyBudget,
      proBilledAsFlash: this.proBilledAsFlash,
      makeupWorkdaysArePeak: this.makeupWorkdaysArePeak,
    }
  }

  /** 应用面板设置：立即更新内存并持久化。 */
  applySettings(patch = {}) {
    const next = {
      model: patch.model === 'pro' || patch.model === 'flash' || patch.model === 'auto' ? patch.model : this.model,
      lowBalanceThreshold: Number.isFinite(Number(patch.lowBalanceThreshold))
        ? Math.max(0, Number(patch.lowBalanceThreshold))
        : this.lowBalanceThreshold,
      dailyBudget: patch.dailyBudget === undefined || patch.dailyBudget === null || patch.dailyBudget === ''
        ? undefined
        : (Number.isFinite(Number(patch.dailyBudget)) ? Math.max(0, Number(patch.dailyBudget)) : this.dailyBudget),
      proBilledAsFlash: patch.proBilledAsFlash === undefined
        ? this.proBilledAsFlash
        : toBool(patch.proBilledAsFlash, this.proBilledAsFlash),
      makeupWorkdaysArePeak: patch.makeupWorkdaysArePeak === undefined
        ? this.makeupWorkdaysArePeak
        : toBool(patch.makeupWorkdaysArePeak, this.makeupWorkdaysArePeak),
    }
    this.userSettings = next
    this.model = next.model
    this.lowBalanceThreshold = next.lowBalanceThreshold
    this.dailyBudget = next.dailyBudget
    this.proBilledAsFlash = next.proBilledAsFlash
    this.makeupWorkdaysArePeak = next.makeupWorkdaysArePeak
    this.saveUserSettings(next)
    return this.settingsView()
  }

  effectivePrices() {
    return this.pricesFor(this.model, Date.now())
  }

  /** 指定模型 + 时刻的单价。历史消息按各自 event.time 和实际模型调用本方法。 */
  pricesFor(model, epochMs) {
    const snapshot = this.pricingSnapshot ?? { current: CURRENT_PRESETS }
    const safe = model === 'pro' || model === 'flash' ? model : 'flash'
    const era = eraOf(epochMs)
    if (era === 'standard') {
      const current = snapshot.current?.[safe] ?? CURRENT_PRESETS[safe]
      return { ...current, band: 'standard' }
    }
    const inPeak = isPeakHour(new Date(epochMs), this.makeupWorkdaysArePeak)
    const table = this.peakTableFor(era, this.billedModelOf(safe, era))
    return { ...(inPeak ? table.peak : table.offPeak), band: bandLabelOf(era, inPeak) }
  }

  /**
   * 指定时代的峰谷价目：最新时代（v2）优先用抓取到的官方页，
   * 更早的时代一律用内置预设——历史账单不能被后来的调价改写。
   */
  peakTableFor(era, model) {
    const safe = model === 'pro' || model === 'flash' ? model : 'flash'
    const fetched = era === 'v2' ? this.pricingSnapshot?.peak?.[safe] : undefined
    return fetched ?? builtinPeakTable(era)[safe]
  }

  /**
   * v2 时代 Pro 的计费模型：官方把 Pro 请求路由到 V4.1 Flash 并按 Flash
   * 单价计费，故默认取 flash 价目；proBilledAsFlash=false 时退回 Pro 自身。
   */
  billedModelOf(model, era) {
    if (model === 'pro' && era === 'v2' && this.proBilledAsFlash) return 'flash'
    return model
  }

  /**
   * 指定时刻生效的单价（使用当前配置模型）。
   */
  effectivePricesAt(epochMs) {
    return this.pricesFor(this.model, epochMs)
  }

  /** 已按 band 分桶的历史 tokens 折算时，直接取对应时代 + 模型 + band 的单价。 */
  pricesForBand(model, band) {
    const snapshot = this.pricingSnapshot ?? { current: CURRENT_PRESETS }
    const safe = model === 'pro' || model === 'flash' ? model : 'flash'
    const info = peakBandOf(band)
    if (info === undefined) {
      const current = snapshot.current?.[safe] ?? CURRENT_PRESETS[safe]
      return { ...current, band: 'standard' }
    }
    const table = this.peakTableFor(info.era, this.billedModelOf(safe, info.era))
    return { ...(info.offPeak ? table.offPeak : table.peak), band }
  }

  /** auto 模式下把 provider/model 归一化；显式 pro/flash 时始终返回该模型。
      非 DeepSeek 模型返回 'other'（调用方跳过计价）。 */
  modelOf(modelId, provider) {
    if (this.model === 'pro' || this.model === 'flash') return this.model
    const model = normalizeModel(modelId, provider)
    if (model === 'other') return 'other'
    return model ?? 'flash'
  }

  /** 从 request/header 事件读取实际模型（含 provider 判定）。 */
  headerModelOf(event) {
    const header = event?.data?.header
    return this.modelOf(header?.config?.model, header?.config?.provider)
  }

  /** auto 模式无任何请求头时的兜底模型。 */
  fallbackModel() {
    return this.model === 'pro' || this.model === 'flash' ? this.model : 'flash'
  }

  /** 会话最近一次 request/header 里实际使用的模型；auto 模式下用于整会话计价。
      最近一条头即当前模型：确认非 DeepSeek 立即返回 'other'，不回溯更旧的头。
      分支会话会忽略 seed 里的历史 request/header，只看新建分支后的事件。 */
  sessionModel(session) {
    if (this.model === 'pro' || this.model === 'flash') return this.model
    const events = sessionEvents(session)
    if (Array.isArray(events)) {
      const boundary = seedStartSeq(session)
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event?.type !== 'request/header') continue
        if (isSeedEvent(event, boundary)) continue
        const model = this.headerModelOf(event)
        if (model === 'other') return 'other'
        if (model !== undefined) return model
      }
    }
    return 'flash'
  }

  /** RPC/HTTP：最近的余额视图；缓存窗口内直接返回，并发查询去重。 */
  async view() {
    if (!this.enabled) return { fetchedAt: Date.now(), available: false, balances: [], error: 'disabled' }
    const now = Date.now()
    if (this.cached !== undefined && now - this.cachedAt < this.refreshIntervalMs && this.refreshIntervalMs > 0) {
      return this.cached
    }
    if (this.inflight !== undefined) return this.inflight
    /** 缓存窗口从“发起请求”起算：否则客户端按 refreshIntervalSeconds 精确轮询时，响应耗时会让下一次轮询总是命中旧缓存，实际刷新周期翻倍。 */
    const startedAt = now
    this.inflight = this.query().then((view) => {
      this.cached = view
      this.cachedAt = startedAt
      return view
    }).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** 强制刷新（绕过缓存窗口）。 */
  async refresh() {
    const view = await this.query()
    this.cached = view
    this.cachedAt = Date.now()
    return view
  }

  /**
   * 刷新价格快照。抓到的表只在“确实已不是 v1 旧价目”时才覆盖内置 v2：
   * 官方定价页是静态构建，调价当天往往还没重新发布，直接采信会把已生效的
   * 新价回退成旧价（v2 时代的价格凭空变回 v1）。更早的时代另有内置预设兜底。
   */
  async refreshPricing() {
    const snapshot = await fetchPricing({
      url: this.config.pricingUrl,
      timeoutMs: this.config.requestTimeoutMs,
      signal: this.lifecycle.signal,
    })
    const previous = this.pricingSnapshot
    const pagePeak = snapshot.peak
    const peak = pagePeak !== undefined && !samePeakTable(pagePeak, PEAK_PRESETS_V1)
      ? pagePeak
      : PEAK_PRESETS_V2
    if (snapshot.current !== undefined || pagePeak !== undefined) {
      this.pricingSnapshot = {
        fetchedAt: snapshot.fetchedAt,
        current: snapshot.current ?? previous?.current ?? CURRENT_PRESETS,
        peak,
        ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
      }
    } else {
      this.pricingSnapshot = { fetchedAt: snapshot.fetchedAt, current: CURRENT_PRESETS, peak, error: snapshot.error }
    }
  }

  /**
   * 从 live session 的已落盘 assistant/message 事件扫描最终用量，按事件时间
   * 分入 standard 与各时代的峰谷 band（off-peak/peak、off-peak-2/peak-2），
   * 并按实际模型拆 flash/pro。
   * 结果按 session 对象 + 事件尾部引用 + 价格快照缓存；事件日志或价格快照变化时重扫。
   */
  finalizedUsage(session) {
    const events = sessionEvents(session)
    if (!Array.isArray(events)) return undefined
    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined
    const boundary = seedStartSeq(session)
    const cached = this.sessionUsageCache.get(session)
    if (cached !== undefined
      && cached.eventCount === events.length
      && cached.lastEvent === lastEvent
      && cached.boundary === boundary
      && cached.pricingSnapshot === this.pricingSnapshot) {
      return cached
    }
    const fullTotals = emptyTokenBuckets()
    const totals = emptyTokenBuckets()
    const byBand = {}
    for (const band of ALL_BANDS) byBand[band] = { flash: emptyTokenBuckets(), pro: emptyTokenBuckets() }
    let currentModel = this.fallbackModel()
    for (const event of events) {
      if (event.type === 'request/header') {
        currentModel = this.headerModelOf(event)
        continue
      }
      if (event.type !== 'assistant/message') continue
      const usage = event.data?.usage
      if (usage === undefined || usage === null) continue
      // 非 DeepSeek 模型的用量不计入花费（'other' 只在 auto 模式出现）。
      if (currentModel === 'other') continue
      const time = Number(event.time) || 0
      const band = this.pricesFor(currentModel, time > 0 ? time : Date.now()).band
      const buckets = tokenBucketsOf(usage)
      addTokenBuckets(fullTotals, buckets)
      // 分支会话里 seed 部分已经在父会话计过费，只累计 seed 之后的新增消息。
      if (isSeedEvent(event, boundary)) continue
      addTokenBuckets(totals, buckets)
      addTokenBuckets(byBand[band][currentModel], buckets)
    }
    const entry = {
      eventCount: events.length,
      lastEvent,
      boundary,
      pricingSnapshot: this.pricingSnapshot,
      totals,
      byBand,
      fullTotals,
      seedTotals: subtractTokenBuckets(fullTotals, totals),
    }
    this.sessionUsageCache.set(session, entry)
    return entry
  }

  /**
   * 一个会话的 token 用量 + 估算花费。
   * 历史部分按每条消息的 event.time + 实际模型计价；投影总量超出已落盘事件
   * 的部分视为进行中的增量，按会话当前模型和当前时段价计价。
   */
  sessionCost(session) {
    const finalized = this.finalizedUsage(session)
    const sessionModel = this.sessionModel(session)
    const registry = this.seams.sessionProjections
    let projected
    if (registry !== undefined && typeof registry.snapshot === 'function') {
      const value = registry.snapshot(session)?.values?.tokenUsage
      if (value !== null && typeof value === 'object') projected = projectionBucketsOf(value)
    }
    // 分支会话的 tokenUsage 投影也包含 seed 历史，这里把 seed 用量扣掉，
    // 让「本会话」只反映新建分支后实际新产生的 token/花费。
    if (projected !== undefined && finalized?.seedTotals !== undefined) {
      projected = subtractTokenBuckets(projected, finalized.seedTotals)
    }
    const totals = projected ?? finalized?.totals ?? emptyTokenBuckets()
    const live = projected !== undefined && finalized !== undefined
      ? subtractTokenBuckets(projected, finalized.totals)
      : projected ?? emptyTokenBuckets()
    // 会话当前模型非 DeepSeek：不估算花费。已落盘的 DeepSeek 用量（混合会话里
    // 切到其它模型之前的部分）仍按实际模型计价，进行中/投影部分不计。
    const nonDeepSeek = sessionModel === 'other'
    const currentPrices = nonDeepSeek ? undefined : this.pricesFor(sessionModel, Date.now())
    const breakdown = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    if (finalized !== undefined) {
      for (const band of ALL_BANDS) {
        for (const model of ['flash', 'pro']) {
          addBucketCost(breakdown, finalized.byBand[band][model], this.pricesForBand(model, band))
        }
      }
    }
    if (currentPrices !== undefined) addBucketCost(breakdown, live, currentPrices)
    const cost = breakdown.input + breakdown.cacheRead + breakdown.cacheWrite + breakdown.output
    return {
      uncachedInputTokens: totals.uncachedInputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      cost,
      currency: 'CNY',
      breakdown,
      pricing: nonDeepSeek
        ? {
          model: 'other',
          cacheReadPerMillion: 0,
          inputPerMillion: 0,
          outputPerMillion: 0,
          band: 'standard',
          peakPricingActive: Date.now() >= PEAK_PRICING_START_MS,
          nextChangeAt: nextPeakBoundary(new Date(), this.makeupWorkdaysArePeak),
        }
        : {
          model: sessionModel,
          cacheReadPerMillion: currentPrices.cacheRead,
          inputPerMillion: currentPrices.input,
          outputPerMillion: currentPrices.output,
          band: currentPrices.band,
          peakPricingActive: Date.now() >= PEAK_PRICING_START_MS,
          nextChangeAt: nextPeakBoundary(new Date(), this.makeupWorkdaysArePeak),
        },
    }
  }

  /** 单条 assistant 消息事件 → 花费条目；按事件时间和实际模型计价，无 usage 返回 null。 */
  messageCostOf(event, model = this.fallbackModel()) {
    const usage = event?.data?.usage
    if (usage === undefined || usage === null) return null
    // 非 DeepSeek 模型不估算花费。
    if (model === 'other') return null
    const time = Number(event.time) || 0
    const buckets = tokenBucketsOf(usage)
    const prices = this.pricesFor(model, time > 0 ? time : Date.now())
    const cost = costOfTokens(buckets.uncachedInputTokens, prices.input)
      + costOfTokens(buckets.cacheReadTokens, prices.cacheRead)
      + costOfTokens(buckets.outputTokens, prices.output)
    return {
      time,
      tokens: buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens,
      cost,
    }
  }

  /** 一个会话的最近 N 条消息花费（倒序：最新在前），附带对应的用户问题文本。
      同一个 turn 的多条 assistant 消息（agent 多步循环）合并为一条。 */
  messageCosts(session, limit = 20) {
    const events = sessionEvents(session)
    if (!Array.isArray(events)) return []
    const byTurn = new Map()
    const boundary = seedStartSeq(session)
    let currentQuestion = ''
    let currentModel = this.fallbackModel()
    for (const event of events) {
      if (isSeedEvent(event, boundary)) continue
      if (event.type === 'request/header') {
        currentModel = this.headerModelOf(event)
      } else if (event.type === 'user/message') {
        const blocks = event.data?.content
        if (Array.isArray(blocks)) {
          const text = blocks
            .filter((b) => (b?.kind === 'text' || b?.type === 'text'))
            .map((b) => b?.text ?? '')
            .join('')
            .trim()
          if (text !== '') currentQuestion = text
        }
      } else if (event.type === 'assistant/message') {
        const cost = this.messageCostOf(event, currentModel)
        if (cost === null) continue
        const turn = Number(event.data?.turn)
        const entry = byTurn.get(turn)
        if (entry !== undefined) {
          entry.tokens += cost.tokens
          entry.cost += cost.cost
          entry.time = cost.time
        } else {
          byTurn.set(turn, {
            turn,
            question: currentQuestion.slice(0, 120),
            tokens: cost.tokens,
            cost: cost.cost,
            time: cost.time,
          })
        }
      }
    }
    return [...byTurn.values()]
      .sort((a, b) => a.turn - b.turn)
      .slice(-limit)
      .reverse()
  }

  /**
   * 近 N 天每天花费。live 会话之外，在 sessionPersistence 可用时合并
   * 已保存会话（按 revision 复用上次读到的事件，避免每 10s 全量重读）；
   * 每条 assistant 消息按自己的事件时间计价。
   */
  async dailyCosts(sessionsList, days = 7) {
    const dayKey = (epochMs) => {
      const d = new Date(epochMs)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const now = new Date()
    const buckets = new Map()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = dayKey(d.getTime())
      buckets.set(key, { date: d.getTime(), cost: 0, tokens: 0 })
    }
    const foldEvents = (events, boundary = 0) => {
      if (!Array.isArray(events)) return
      let currentModel = this.fallbackModel()
      for (const event of events) {
        if (isSeedEvent(event, boundary)) continue
        if (event.type === 'request/header') {
          currentModel = this.headerModelOf(event)
        } else if (event.type === 'assistant/message') {
          const cost = this.messageCostOf(event, currentModel)
          if (cost === null) continue
          const bucket = buckets.get(dayKey(cost.time))
          if (bucket !== undefined) {
            bucket.cost += cost.cost
            bucket.tokens += cost.tokens
          }
        }
      }
    }

    const seen = new Set()
    for (const session of sessionsList ?? []) {
      const events = sessionEvents(session)
      if (!Array.isArray(events)) continue
      if (session?.id !== undefined) seen.add(String(session.id))
      foldEvents(events, seedStartSeq(session))
    }

    let coverage = 'live'
    const persistence = this.seams.sessionPersistence
    if (persistence !== undefined && typeof persistence.readFrom === 'function') {
      try {
        const hasSnapshots = typeof persistence.listSnapshots === 'function'
        const hasList = typeof persistence.list === 'function'
        if (hasSnapshots || hasList) {
          coverage = 'live+persisted'
          const snapshots = hasSnapshots
            ? await persistence.listSnapshots()
            : (await persistence.list()).map((header) => ({ header }))
          for (const snapshot of snapshots) {
            const id = snapshot.header?.id
            if (id === undefined) continue
            const key = String(id)
            if (seen.has(key)) continue
            const cached = this.persistedEventCache.get(key)
            let events
            if (cached !== undefined && snapshot.revision !== undefined && cached.revision === snapshot.revision) {
              events = cached.events
            } else {
              try {
                const read = await persistence.readFrom(id, 0)
                events = Array.isArray(read?.events) ? read.events : []
                this.persistedEventCache.set(key, { revision: snapshot.revision, events })
              } catch {
                continue
              }
            }
            seen.add(key)
            foldEvents(events, seedStartSeq(snapshot?.header ?? snapshot) || seedStartSeq({ events }))
          }
        }
      } catch (error) {
        this.ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
        coverage = 'live'
      }
    }

    const items = [...buckets.values()].map((b) => ({
      date: b.date,
      cost: Math.round(b.cost * 10000) / 10000,
      tokens: b.tokens,
    }))
    const todayCost = items.length > 0 ? items[items.length - 1].cost : 0
    return {
      coverage,
      budget: this.dailyBudget,
      budgetExceeded: this.dailyBudget !== undefined && todayCost > this.dailyBudget,
      items,
    }
  }

  /** 查询官方 Get User Balance。 */
  async query() {
    const fetchedAt = Date.now()
    try {
      const key = await this.resolveApiKey()
      if (key === undefined) {
        return {
          fetchedAt,
          available: false,
          balances: [],
          error: `no API key (store ${this.apiKeyEnv} via the credentials seam, or export it in the environment)`,
        }
      }
      const { origin, prefix } = parseBaseUrl(this.baseUrl)
      const url = `${origin}${prefix}/user/balance`
      const gate = requestGate(this.config.requestTimeoutMs, this.lifecycle.signal)
      let response
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: gate.signal,
        })
      } finally {
        gate.release()
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        return {
          fetchedAt,
          available: false,
          balances: [],
          error: `Get User Balance failed: HTTP ${response.status}${body ? ` — ${truncate(body, 200)}` : ''}`,
        }
      }
      const payload = await response.json()
      const buckets = Array.isArray(payload.balance_infos)
        ? payload.balance_infos.map((b) => ({
          currency: String(b.currency ?? ''),
          total_balance: String(b.total_balance ?? '0'),
          granted_balance: String(b.granted_balance ?? '0'),
          topped_up_balance: String(b.topped_up_balance ?? '0'),
        })).filter((b) => b.currency !== '')
        : []
      const total = buckets.length === 1 ? Number(buckets[0].total_balance) : undefined
      return {
        fetchedAt,
        available: payload.is_available !== false,
        balances: buckets,
        ...(total === undefined || Number.isNaN(total) ? {} : {
          total,
          currency: buckets[0].currency,
          lowBalance: total < this.lowBalanceThreshold,
          lowBalanceThreshold: this.lowBalanceThreshold,
        }),
      }
    } catch (error) {
      return {
        fetchedAt,
        available: false,
        balances: [],
        error: friendlyError(error, '余额查询'),
      }
    }
  }

  /** 凭据缝 → 启动环境 → process.env，逐层解析 API key。 */
  async resolveApiKey() {
    const credentials = this.seams.credentials
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(this.apiKeyEnv)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    }
    const launchEnvironment = this.seams.launchEnvironment
    const ambient = launchEnvironment?.get?.(String(this.apiKeyEnv))
    if (ambient !== undefined && typeof ambient.value === 'string' && ambient.value.length > 0) return ambient.value
    const env = process.env[this.apiKeyEnv]
    if (typeof env === 'string' && env.length > 0) return env
    return undefined
  }
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

/** JSON 响应：/api 通道会把 WHATWG Response 写回 HTTP。 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * 一条 exact Fetch 路由。注册进 connection 的 Fetch 路由表（而不是 webServer
 * 的裸路由），因此与内置 /api 通道共用浏览器认证与 Host/Origin 检查；
 * handler 抛错一律收敛成 500，不把异常抛回 dispatcher。
 * @param path - 完整路径（必须位于 /api 通道之下）。
 * @param methods - 允许的方法。
 * @param run - 处理函数：返回可 JSON 序列化的值，或直接返回 Response。
 */
function jsonRoute(path, methods, run) {
  return {
    path,
    methods,
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const result = await run(request)
        return result instanceof Response ? result : jsonResponse(200, result)
      } catch (error) {
        return jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

/** 读查询参数（空串按未提供处理）。 */
function queryParam(request, name) {
  const value = new URL(request.url).searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

/** 读整数查询参数并夹到 [min, max]。 */
function intParam(request, name, fallback, min, max) {
  const raw = queryParam(request, name)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 注册余额服务与 HTTP 路由。
 * @param ctx - cordis 上下文。
 * @param config - 组合配置（cordis.patch.yml insert 里的 config 字段）。
 */
export function apply(ctx, config = defaultConfig()) {
  const service = new BalanceService(ctx, config)
  /** 暴露给其它插件/诊断用。 */
  ctx.provide('whalePurse', service)

  // 可选依赖：缝在场时绑定，缺席/消失时自动解绑。不写进 inject（缺缝仍要能工作），
  // 也不用 ctx.get 运行时探测服务是否存在。
  for (const name of ['credentials', 'launchEnvironment', 'sessionProjections', 'sessionPersistence']) {
    ctx.inject([name], (scope) => {
      scope.effect(() => {
        service.seams[name] = scope[name]
        return () => { delete service.seams[name] }
      }, `whale-purse: ${name} seam`)
    })
  }

  // 后台刷新（定价页/节假日）：卸载时停表 → 中止在途请求 → 等它们收敛。
  if (config.enabled) {
    ctx.effect(() => {
      service.start()
      return () => service.dispose()
    }, 'whale-purse: background refresh')
  }

  const resolveSession = (id) => {
    const session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(id) : undefined
    if (session === undefined) return undefined
    return { session, cost: service.sessionCost(session) }
  }

  const routes = [
    jsonRoute('/api/whale-purse/balance', ['GET'], () => service.view()),
    jsonRoute('/api/whale-purse/balance/refresh', ['GET'], () => service.refresh()),
    jsonRoute('/api/whale-purse/settings', ['GET', 'POST'], async (request) => {
      if (request.method === 'GET') return { ok: true, ...service.settingsView() }
      const body = await request.json().catch(() => undefined)
      if (body === undefined || body === null || typeof body !== 'object') {
        return jsonResponse(400, { ok: false, error: 'invalid-json' })
      }
      return { ok: true, ...service.applySettings(body) }
    }),
    jsonRoute('/api/whale-purse/balance/cost', ['GET'], (request) => {
      const id = queryParam(request, 'session')
      if (id === undefined) return { ok: false, error: 'missing-session' }
      const resolved = resolveSession(id)
      if (resolved === undefined) return { ok: false, error: 'unknown-session' }
      return { ok: true, ...resolved.cost }
    }),
    /** 近 N 天每天花费（live + 可用时的持久化会话）。 */
    jsonRoute('/api/whale-purse/balance/daily', ['GET'], async (request) => {
      const list = liveSessions(ctx.sessions)
      const daily = await service.dailyCosts(list, intParam(request, 'days', 7, 1, 30))
      return { ok: true, coverage: daily.coverage, budget: daily.budget, budgetExceeded: daily.budgetExceeded, items: daily.items }
    }),
    /** 当前会话最近 N 条消息花费。 */
    jsonRoute('/api/whale-purse/balance/messages', ['GET'], (request) => {
      const id = queryParam(request, 'session')
      if (id === undefined) return { ok: false, error: 'missing-session' }
      const resolved = resolveSession(id)
      if (resolved === undefined) return { ok: false, error: 'unknown-session' }
      return { ok: true, items: service.messageCosts(resolved.session, intParam(request, 'limit', 20, 1, 100)) }
    }),
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.connection.fetch.register(route))
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 卸载时尽力而为 */ }
      }
    }
  }, 'whale-purse: fetch routes')
}
