// Smoke test for whale-purse non-DeepSeek detection (runs against real lib/index.js source).
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  + '\n;globalThis.__wpTest = { normalizeModel, isDeepSeekModel, BalanceService, CURRENT_PRESETS, PEAK_PRESETS, PEAK_PRESETS_V1, PEAK_PRESETS_V2, eraOf, priceSections, parseCurrentTable, parsePeakTable, sessionEvents, liveSessions }\n'

const sandbox = {
  console, Date, Intl, URL, URLSearchParams, Map, Set, WeakMap,
  Number, String, Math, JSON, Promise, AbortController,
  setTimeout, clearTimeout, setInterval, clearInterval,
  // 模块顶层常量用到的导入符号（方法内部用到的 fs 符号不会被本次测试触达）
  join: (...args) => args.join('/'),
  homedir: () => '/home/test',
  process: { env: {} },
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox)
const { normalizeModel, isDeepSeekModel, BalanceService, CURRENT_PRESETS, PEAK_PRESETS, PEAK_PRESETS_V2, eraOf, priceSections, parseCurrentTable, parsePeakTable, sessionEvents, liveSessions } = sandbox.__wpTest

let failures = 0
function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  =>  ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

// --- normalizeModel / isDeepSeekModel ---
check('deepseek-v4-flash -> flash', normalizeModel('deepseek-v4-flash'), 'flash')
check('deepseek-v4-pro -> pro', normalizeModel('deepseek-v4-pro'), 'pro')
check('deepseek-v4-flash-vision-exp -> flash', normalizeModel('deepseek-v4-flash-vision-exp'), 'flash')
check('deepseek-chat (legacy) -> flash', normalizeModel('deepseek-chat'), 'flash')
check('gpt-5-pro -> other (KEY FIX)', normalizeModel('gpt-5-pro'), 'other')
check('qwen2.5-flash -> other (KEY FIX)', normalizeModel('qwen2.5-flash'), 'other')
check('claude-sonnet-4 -> other', normalizeModel('claude-sonnet-4'), 'other')
check('gpt-4o -> other', normalizeModel('gpt-4o'), 'other')
check("'' -> undefined", normalizeModel(''), undefined)
check('undefined -> undefined', normalizeModel(undefined), undefined)
check('gpt-5-pro on deepseek provider -> other', normalizeModel('gpt-5-pro', 'deepseek-official'), 'other')
check('qwen2.5-flash on deepseek provider -> other', normalizeModel('qwen2.5-flash', 'deepseek-official'), 'other')
check('custom model on deepseek provider -> other', normalizeModel('my-custom', 'deepseek-official'), 'other')
check('deepseek model on foreign provider -> pro', normalizeModel('deepseek-v4-pro', 'openai'), 'pro')
check('isDeepSeekModel gpt-4o -> false', isDeepSeekModel('gpt-4o'), false)
check('isDeepSeekModel deepseek-v4-flash -> true', isDeepSeekModel('deepseek-v4-flash'), true)
check('isDeepSeekModel empty model + official provider -> true', isDeepSeekModel('', 'deepseek-official'), true)

// --- service-level behavior (avoid constructor network call) ---
const svc = Object.create(BalanceService.prototype)
svc.model = 'auto'
svc.pricingSnapshot = { fetchedAt: Date.now(), current: CURRENT_PRESETS, peak: PEAK_PRESETS }
svc.ctx = { get: () => undefined }
svc.sessionUsageCache = new WeakMap()

check('modelOf deepseek-v4-flash -> flash', svc.modelOf('deepseek-v4-flash'), 'flash')
check('modelOf gpt-5-pro -> other', svc.modelOf('gpt-5-pro'), 'other')
check('modelOf undefined -> flash fallback', svc.modelOf(undefined), 'flash')
check('modelOf gpt-4o provider openai -> other', svc.modelOf('gpt-4o', 'openai'), 'other')

const explicit = Object.create(BalanceService.prototype)
explicit.model = 'pro'
check('explicit pro forces tier', explicit.modelOf('gpt-4o'), 'pro')

const headerEvent = (model, provider) => ({ type: 'request/header', data: { header: { config: { model, provider } } } })
const usage = { inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0 }
const assistantEvent = (model, provider, time = 1700000000000) => ({ type: 'assistant/message', time, data: { usage, turn: 1 } })
const userEvent = (text) => ({ type: 'user/message', data: { content: [{ kind: 'text', text }] } })

check('sessionModel deepseek -> flash', svc.sessionModel({ events: [headerEvent('deepseek-v4-flash', 'deepseek-official')] }), 'flash')
check('sessionModel gpt-4o -> other', svc.sessionModel({ events: [headerEvent('gpt-4o', 'openai')] }), 'other')
check('sessionModel no events -> flash', svc.sessionModel({ events: [] }), 'flash')
check('sessionModel last header wins (pro then gpt) -> other', svc.sessionModel({ events: [headerEvent('deepseek-v4-pro'), headerEvent('gpt-4o')] }), 'other')
check('sessionModel last header wins (gpt then pro) -> pro', svc.sessionModel({ events: [headerEvent('gpt-4o'), headerEvent('deepseek-v4-pro')] }), 'pro')
check('sessionModel user-only -> flash', svc.sessionModel({ events: [userEvent('hi')] }), 'flash')

// --- messageCostOf ---
check('messageCostOf other -> null', svc.messageCostOf(assistantEvent(), 'other'), null)
check('messageCostOf flash -> cost', svc.messageCostOf(assistantEvent(), 'flash').cost > 0, true)

// --- sessionCost ---
const pureOther = svc.sessionCost({ events: [headerEvent('gpt-4o', 'openai'), assistantEvent()] })
check('sessionCost other model -> cost 0', pureOther.cost, 0)
check('sessionCost other model -> pricing.model other', pureOther.pricing.model, 'other')
check('sessionCost other model -> breakdown zero', pureOther.breakdown.input + pureOther.breakdown.output, 0)

const pureFlash = svc.sessionCost({ events: [headerEvent('deepseek-v4-flash', 'deepseek-official'), assistantEvent()] })
check('sessionCost flash model -> cost > 0', pureFlash.cost > 0, true)
check('sessionCost flash model -> pricing.model flash', pureFlash.pricing.model, 'flash')

const mixed = svc.sessionCost({ events: [headerEvent('deepseek-v4-flash', 'deepseek-official'), assistantEvent(), headerEvent('gpt-4o', 'openai'), assistantEvent()] })
check('mixed session prices deepseek part only', mixed.cost, pureFlash.cost)
check('mixed session pricing.model other', mixed.pricing.model, 'other')

// --- messageCosts / dailyCosts fold non-deepseek away ---
const msgs = svc.messageCosts({ events: [headerEvent('deepseek-v4-flash'), assistantEvent(), headerEvent('gpt-4o'), assistantEvent()] })
check('messageCosts keeps deepseek turn only', msgs.length, 1)

// --- DSH branch session: seed history must not be billed again ---
const headerEventWithSeq = (seq, model, provider) => ({ seq, type: 'request/header', data: { header: { config: { model, provider } } } })
const assistantEventWithSeq = (seq, turn, tokens = {}) => ({
  seq,
  type: 'assistant/message',
  time: 1700000000000,
  data: { usage: { inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0, ...tokens }, turn },
})
const registryOf = (tokenUsage) => ({ get: () => ({ snapshot: () => ({ values: { tokenUsage } }) }) })
const makeBranchSvc = (ctx) => {
  const s = Object.create(BalanceService.prototype)
  s.model = 'auto'
  s.pricingSnapshot = svc.pricingSnapshot
  s.ctx = ctx
  s.sessionUsageCache = new WeakMap()
  return s
}

const branchPureSvc = makeBranchSvc(registryOf({ uncachedInputTokens: 100000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0 }))
const branchPure = {
  header: { seedLength: 2 },
  events: [
    headerEventWithSeq(0, 'deepseek-v4-flash', 'deepseek-official'),
    assistantEventWithSeq(1, 1),
  ],
}
check('branch pure checkout ignores seed model', branchPureSvc.sessionModel(branchPure), 'flash')
const branchPureCost = branchPureSvc.sessionCost(branchPure)
check('branch pure checkout cost is 0', branchPureCost.cost, 0)
check('branch pure checkout tokens are 0', branchPureCost.uncachedInputTokens + branchPureCost.outputTokens, 0)
check('messageCosts branch pure ignores seed', branchPureSvc.messageCosts(branchPure).length, 0)

const branchNewSvc = makeBranchSvc(registryOf({ uncachedInputTokens: 101000, outputTokens: 50500, cacheReadTokens: 0, cacheWriteTokens: 0 }))
const branchNew = {
  header: { seedLength: 2 },
  events: [
    headerEventWithSeq(0, 'deepseek-v4-flash', 'deepseek-official'),
    assistantEventWithSeq(1, 1),
    headerEventWithSeq(3, 'deepseek-v4-flash', 'deepseek-official'),
    assistantEventWithSeq(4, 2, { inputTokens: 1000, outputTokens: 500 }),
  ],
}
const branchNewCost = branchNewSvc.sessionCost(branchNew)
check('branch new messages cost > 0', branchNewCost.cost > 0, true)
check('branch new messages only counts post-seed input', branchNewCost.uncachedInputTokens, 1000)
check('branch new messages only counts post-seed output', branchNewCost.outputTokens, 500)


// --- 官方定价页解析（2026-09 页面结构：三模型列 + <br> 锚点）---
// 断言锚点容忍 <br> 变成的空格：写死无空格锚点会让整条解析链路静默失效。
const PRICING_FIXTURE = `<table><tr><td>模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td><td>deepseek-v4-flash-vision-exp</td></tr>
<tr><td>价格<sup>(1)(2)</sup></td><td>百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.05元</td><td>0.15元</td><td>0.05元</td></tr>
<tr><td>高峰时段</td><td>0.10元</td><td>0.30元</td><td>0.10元</td></tr>
<tr><td>百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>1.5元</td><td>4.5元</td><td>1.5元</td></tr>
<tr><td>高峰时段</td><td>3.0元</td><td>9.0元</td><td>3.0元</td></tr>
<tr><td>百万tokens输出</td><td>空闲时段</td><td>4.5元</td><td>13.5元</td><td>4.5元</td></tr>
<tr><td>高峰时段</td><td>9.0元</td><td>27.0元</td><td>9.0元</td></tr>
<tr><td>并发限制<sup>(3)</sup></td><td>2500</td><td>500</td><td>2500</td></tr></table>`

check('priceSections 解析 <br> 锚点', priceSections(PRICING_FIXTURE) !== undefined, true)
const fixturePeak = parsePeakTable(PRICING_FIXTURE)
check('解析 flash 空闲命中 0.05', fixturePeak?.flash?.offPeak?.cacheRead, 0.05)
check('解析 flash 空闲未命中 1.5', fixturePeak?.flash?.offPeak?.input, 1.5)
check('解析 flash 高峰输出 9', fixturePeak?.flash?.peak?.output, 9)
check('解析 pro 空闲未命中 4.5', fixturePeak?.pro?.offPeak?.input, 4.5)
check('解析 pro 高峰命中 0.3', fixturePeak?.pro?.peak?.cacheRead, 0.3)
check('无峰谷标签的表返回 undefined', parsePeakTable('<td>模型</td><td>deepseek-v4-flash</td>'), undefined)

// 列顺序被打乱（vision 在前）时按表头取列，不能写死第 0/1 列。
const PRICING_REORDERED = `<table><tr><td>模型</td><td>deepseek-v4-flash-vision-exp</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td>百万tokens输入<br>（缓存命中）</td><td>空闲时段 9.99元 0.02元 0.15元 高峰时段 9.98元 0.04元 0.30元</td></tr>
<tr><td>百万tokens输入<br>（缓存未命中）</td><td>空闲时段 9.97元 1元 4.5元 高峰时段 9.96元 2元 9元</td></tr>
<tr><td>百万tokens输出</td><td>空闲时段 9.95元 4元 13.5元 高峰时段 9.94元 8元 27元</td></tr>
<tr><td>并发限制</td><td>2500</td><td>2500</td><td>500</td></tr></table>`
check('乱序列：flash 高峰命中取第 1 列 0.04', parsePeakTable(PRICING_REORDERED)?.flash?.peak?.cacheRead, 0.04)
check('乱序列：pro 高峰输出取第 2 列 27', parsePeakTable(PRICING_REORDERED)?.pro?.peak?.output, 27)

// --- 价格时代：8/17 前统一价、8/17 起峰谷 v1、9/10 12:00 起 Flash 降价 v2 ---
const B = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min, 0) // 北京时间 -> epoch
const pricingSvc = (proBilledAsFlash = true) => {
  const s = Object.create(BalanceService.prototype)
  s.model = 'auto'
  s.proBilledAsFlash = proBilledAsFlash
  s.pricingSnapshot = { fetchedAt: Date.now(), current: CURRENT_PRESETS, peak: PEAK_PRESETS_V2 }
  s.ctx = { get: () => undefined }
  s.sessionUsageCache = new WeakMap()
  return s
}
const priced = pricingSvc()

check('eraOf 8/16 -> standard', eraOf(B(2026, 8, 16, 10)), 'standard')
check('eraOf 8/17 -> v1', eraOf(B(2026, 8, 17, 10)), 'v1')
check('eraOf 9/10 11:59 -> v1', eraOf(B(2026, 9, 10, 11, 59)), 'v1')
check('eraOf 9/10 12:00 -> v2', eraOf(B(2026, 9, 10, 12)), 'v2')

check('8/16 统一价 输出 2', priced.pricesFor('flash', B(2026, 8, 16, 10)).output, 2)
check('8/17 周一 10:00 -> v1 高峰', priced.pricesFor('flash', B(2026, 8, 17, 10)).band, 'peak')
check('8/17 周一 10:00 输出 9', priced.pricesFor('flash', B(2026, 8, 17, 10)).output, 9)
check('8/22 周六 10:00 -> v1 谷价', priced.pricesFor('flash', B(2026, 8, 22, 10)).band, 'off-peak')
check('9/10 11:59 周四 -> 仍 v1 高峰输出 9', priced.pricesFor('flash', B(2026, 9, 10, 11, 59)).output, 9)
check('9/10 12:01 周四 -> v2 谷价', priced.pricesFor('flash', B(2026, 9, 10, 12, 1)).band, 'off-peak-2')
check('9/10 12:01 周四 输出 4', priced.pricesFor('flash', B(2026, 9, 10, 12, 1)).output, 4)
check('9/10 15:00 周四 -> v2 高峰命中 0.04', priced.pricesFor('flash', B(2026, 9, 10, 15)).cacheRead, 0.04)
check('9/10 15:00 周四 -> v2 高峰未命中 2', priced.pricesFor('flash', B(2026, 9, 10, 15)).input, 2)
check('9/10 高峰价 = 谷价 2 倍', priced.pricesFor('flash', B(2026, 9, 10, 15)).output / priced.pricesFor('flash', B(2026, 9, 10, 12, 1)).output, 2)
check('9/12 周六 15:00 -> v2 仍谷价（周末规则成立）', priced.pricesFor('flash', B(2026, 9, 12, 15)).band, 'off-peak-2')
check('9/14 周一 15:00 -> v2 高峰', priced.pricesFor('flash', B(2026, 9, 14, 15)).band, 'peak-2')

// --- Pro 路由口径开关（默认按 Flash 单价）---
check('v2 时代 Pro 默认按 Flash 单价 输出 8', priced.pricesFor('pro', B(2026, 9, 10, 15)).output, 8)
check('v2 时代 Pro 关闭开关后按自身价目 输出 27', pricingSvc(false).pricesFor('pro', B(2026, 9, 10, 15)).output, 27)
check('v1 时代 Pro 不受开关影响 输出 27', priced.pricesFor('pro', B(2026, 9, 10, 11)).output, 27)

// --- 历史分桶按 band 取价：v1/v2 不得串价 ---
check('pricesForBand off-peak-2 flash 输出 4', priced.pricesForBand('flash', 'off-peak-2').output, 4)
check('pricesForBand peak flash 仍 v1 输出 9', priced.pricesForBand('flash', 'peak').output, 9)
check('pricesForBand standard flash 输出 2', priced.pricesForBand('flash', 'standard').output, 2)
check('pricesForBand peak-2 pro 默认按 Flash 输出 8', priced.pricesForBand('pro', 'peak-2').output, 8)

// --- 跨时代会话：v1 与 v2 用量分别按各自价目累计（v1 高峰 9 元 + v2 高峰 8 元）---
const oneMillionOutput = { inputTokens: 0, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 }
const crossSvc = pricingSvc()
crossSvc.ctx = {
  get: (name) => (name === 'sessionProjections'
    ? { snapshot: () => ({ values: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 } } }) }
    : undefined),
}
const crossSession = {
  events: [
    headerEvent('deepseek-v4-flash', 'deepseek-official'),
    { type: 'assistant/message', time: B(2026, 9, 10, 11, 0), data: { usage: oneMillionOutput, turn: 1 } },
    { type: 'assistant/message', time: B(2026, 9, 10, 15, 0), data: { usage: oneMillionOutput, turn: 2 } },
  ],
}
check('跨时代会话按各自价目累计（9+8=17）', crossSvc.sessionCost(crossSession).cost, 17)

// --- 新版 DSH API 漂移：事件只经 snapshotEvents() 暴露、list 是快照 store ---
const million = { inputTokens: 0, outputTokens: 1000000, cacheReadTokens: 0, cacheWriteTokens: 0 }
const snapshotSession = {
  id: 'session-snapshot',
  // 注意：刻意不提供 .events 属性，模拟新版 DSH 的 Session
  snapshotEvents: () => [
    headerEvent('deepseek-v4-flash', 'deepseek-official'),
    { type: 'assistant/message', time: B(2026, 9, 10, 11, 0), data: { usage: million, turn: 1 } },
  ],
}
check('sessionEvents 读到 snapshotEvents', sessionEvents(snapshotSession)?.length, 2)
check('无事件源时返回 undefined', sessionEvents({ id: 'x' }), undefined)
const compatSvc = pricingSvc()
// 该消息发生在 9/10 11:00（v1 高峰，输出 9 元/1M）——必须按“发生时段”而不是“当前时段”计价
check('新版会话仍按消息发生时段计价（v1 高峰 9 元）', compatSvc.sessionCost(snapshotSession).cost, 9)
check('消息明细非空（历史 Tab 依赖）', compatSvc.messageCosts(snapshotSession).length > 0, true)
const legacySession = { id: 'session-legacy', events: snapshotSession.snapshotEvents() }
check('旧版 .events 仍然可用', compatSvc.sessionCost(legacySession).cost, 9)

const storeSessions = {
  list: { getSnapshot: () => ({ ids: ['a', 'b'], byId: {} }) },
  get: (id) => ({ id, snapshotEvents: () => [] }),
}
check('新版 list 快照 store 可枚举', liveSessions(storeSessions).map((s) => s.id).join(','), 'a,b')
check('旧版 list() 函数仍可用', liveSessions({ list: () => [{ id: 'x' }] }).length, 1)
check('无 sessions 时返回空数组', liveSessions(undefined).length, 0)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
