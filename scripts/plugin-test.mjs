// Plugin contract test: 用假 cordis 上下文驱动真实的 lib/index.js + lib/config.js，
// 验证「路由走 connection 的 Fetch 围栏」「可选缝用 ctx.inject 绑定」「卸载收敛」三件事。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const load = (name) => readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')

let failures = 0
function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  =>  ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

/** 每个用例一份新的模块沙箱（模块级状态互不串扰）。 */
function makeModule() {
  const requests = []
  const sandbox = {
    console, Date, Intl, URL, URLSearchParams, Map, Set, WeakMap,
    Number, String, Math, JSON, Promise, AbortController, Response, Request,
    setTimeout, clearTimeout, setInterval, clearInterval,
    join: (...args) => args.join('/'),
    existsSync: () => false,
    mkdirSync: () => {},
    readFileSync: () => { throw new Error('no file') },
    writeFileSync: () => {},
    homedir: () => '/home/test',
    process: { env: {} },
    /** 外部网络桩：记录请求，abort 时按 fetch 语义拒绝。 */
    fetch: (url, options = {}) => {
      requests.push({ url: String(url), hasAuth: String(options.headers?.authorization ?? '').startsWith('Bearer ') })
      return new Promise((resolve, reject) => {
        const signal = options.signal
        if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        resolve({ ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.5', granted_balance: '0', topped_up_balance: '42.5' }] }), text: async () => '' })
      })
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(
    `${load('config.js')}\n${load('index.js')}\n;globalThis.__wp = { name, inject, apply, Config, defaultConfig, BalanceService }`,
    sandbox,
  )
  return { mod: sandbox.__wp, requests }
}

/** 假 cordis 上下文：记录注册行为，并把 effect/inject 真的跑起来。 */
function makeCtx() {
  const seamValues = {
    credentials: { resolve: async (name) => ({ value: name === 'DEEPSEEK_API_KEY' ? 'sk-test' : undefined }) },
    launchEnvironment: { get: () => undefined },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    sessionPersistence: { list: async () => [] },
  }
  const record = { provided: [], routes: [], routeDisposals: 0, effects: new Map(), injects: [], unbinds: [], webServerTouched: false }
  const ctx = {
    connection: {
      fetch: {
        register: (route) => {
          record.routes.push(route)
          return () => { record.routeDisposals += 1 }
        },
      },
    },
    // 故意不提供 webServer：插件若仍直挂裸路由，本用例就会失败。
    get webServer() { record.webServerTouched = true; throw new Error('webServer must not be used') },
    sessions: { get: () => undefined },
    logger: { warn: () => {} },
    provide: (name, value) => { record.provided.push([name, value]) },
    effect: (setup, label) => {
      const disposer = setup()
      record.effects.set(label, disposer)
      return disposer
    },
    inject: (names, callback) => {
      const name = names[0]
      record.injects.push(name)
      const disposers = []
      const scope = {
        [name]: seamValues[name],
        effect: (setup) => { const disposer = setup(); disposers.push(disposer); return disposer },
      }
      callback(scope)
      record.unbinds.push(() => { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose() })
      return undefined
    },
  }
  return { ctx, record, seamValues }
}

const { mod, requests } = makeModule()
check('导出插件名', mod.name, 'dsh-whale-purse')
check('inject 声明 connection（不再需要 webServer）', mod.inject.includes('connection'), true)
check('inject 声明 sessions', mod.inject.includes('sessions'), true)
check('inject 不再声明 webServer', mod.inject.includes('webServer'), false)

const { ctx, record } = makeCtx()
mod.apply(ctx, mod.defaultConfig())

check('ctx.webServer 完全没被碰过', record.webServerTouched, false)
check('暴露 whalePurse 服务', record.provided[0]?.[0], 'whalePurse')
const service = record.provided[0][1]
check('启动即发起后台刷新且可追踪（在途任务 > 0）', service.pendingTasks.size > 0, true)
check('可选缝全部用 ctx.inject 绑定', record.injects.sort().join(','), 'credentials,launchEnvironment,sessionPersistence,sessionProjections')
check('credentials 缝已就位', service.seams.credentials !== undefined, true)
check('sessionProjections 缝已就位', service.seams.sessionProjections !== undefined, true)
check('注册了后台刷新 effect', record.effects.has('whale-purse: background refresh'), true)
check('注册了 fetch 路由 effect', record.effects.has('whale-purse: fetch routes'), true)
check('路由条数', record.routes.length, 6)
check('路由路径', record.routes.map((r) => r.path).join(','), [
  '/api/whale-purse/balance',
  '/api/whale-purse/balance/refresh',
  '/api/whale-purse/settings',
  '/api/whale-purse/balance/cost',
  '/api/whale-purse/balance/daily',
  '/api/whale-purse/balance/messages',
].join(','))
check('所有路由都在 /api 通道下（connection 才认）', record.routes.every((r) => r.path.startsWith('/api/')), true)
check('settings 路由同时接受 GET/POST', record.routes.find((r) => r.path.endsWith('/settings')).methods.join(','), 'GET,POST')
check('其余路由只接受 GET', record.routes.filter((r) => !r.path.endsWith('/settings')).every((r) => r.methods.join(',') === 'GET'), true)
check('每条路由都声明了请求体模式', record.routes.every((r) => typeof r.requestBody === 'string'), true)

const call = (pathWithQuery, init) => {
  const route = record.routes.find((r) => r.path === pathWithQuery.split('?')[0])
  return route.fetch(new Request(`http://dsh.test${pathWithQuery}`, init))
}

const balance = await call('/api/whale-purse/balance')
check('余额路由 200', balance.status, 200)
const balanceBody = await balance.json()
check('余额路由返回 JSON', balanceBody.total, 42.5)
const balanceCall = requests.find((r) => r.url.includes('/user/balance'))
check('余额查询带上了 Bearer（走凭据缝）', balanceCall?.hasAuth, true)
check('余额查询用的是配置里的 baseUrl', balanceCall?.url, 'https://api.deepseek.com/user/balance')

const settingsGet = await call('/api/whale-purse/settings')
check('设置读取 200', (await settingsGet.json()).ok, true)
const settingsPost = await call('/api/whale-purse/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'pro', lowBalanceThreshold: 20 }),
})
const settingsPosted = await settingsPost.json()
check('设置写入生效', settingsPosted.model, 'pro')
check('设置写入后服务状态同步', service.model, 'pro')

const badPost = await call('/api/whale-purse/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })
check('非法 JSON 返回 400', badPost.status, 400)
const costRoute = await call('/api/whale-purse/balance/cost')
check('缺少 session 参数时返回错误体', (await costRoute.json()).error, 'missing-session')
const dailyRoute = await call('/api/whale-purse/balance/daily?days=3')
check('daily 路由正常返回', (await dailyRoute.json()).items.length, 3)
const dailyClamped = await call('/api/whale-purse/balance/daily?days=999')
check('daily days 被夹到上限 30', (await dailyClamped.json()).items.length, 30)

// 卸载：路由 disposer 全部调用 + 后台刷新收敛（停表 → 中止在途 → 等待落地）。
record.effects.get('whale-purse: fetch routes')()
check('卸载时路由 disposer 全部执行', record.routeDisposals, 6)
await record.effects.get('whale-purse: background refresh')()
check('卸载后定时器已停', service.refreshTimer, undefined)
check('卸载后生命周期信号已中止', service.lifecycle.signal.aborted, true)
check('卸载后在途任务收敛为 0', service.pendingTasks.size, 0)
for (const unbind of record.unbinds) unbind()
check('缝解绑后 credentials 归零', service.seams.credentials, undefined)
check('缝解绑后 sessionProjections 归零', service.seams.sessionProjections, undefined)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
