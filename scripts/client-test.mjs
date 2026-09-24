// 客户端回归测试：在假 window.__ModuleLoader__ 下取出 factory，验证
// 「当前会话 id」的跨版本解析链与「打开会话」的路由（0.1.5 / 0.1.6 / 0.1.7 三种服务形状）。
// 背景：DSH 0.1.7-rc.1 移除了 sessions.currentProvideInfo 与 list 快照上的 current，
// 当前会话改由 uiWorkspace.selection 承载；插件此前只认前两者，导致点开面板后
// 本会话花费 / 消息明细整块消失。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let failures = 0
function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  =>  ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

/** 与 dsh-client-store 快照 store 行为一致的最小实现。 */
function makeStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(callback) {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    set(next) {
      value = next
      for (const callback of [...listeners]) callback()
    },
    listenerCount: () => listeners.size,
  }
}

const reactStub = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: undefined }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: Symbol('Fragment'),
  createElement: () => null,
}

const sandbox = {
  console, Date, Math, JSON, Object, Array, Number, String, Boolean, Promise, Map, Set, WeakMap,
  URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
  window: { __ModuleLoader__: { load: (registration) => { sandbox.__captured = registration } } },
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)

const captured = sandbox.__captured
check('客户端 bundle 以 dsh-whale-purse 注册', captured?.id, 'dsh-whale-purse')
const mod = captured.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
})
check('导出 currentSessionSource', typeof mod.currentSessionSource, 'function')
check('导出 openSessionVia', typeof mod.openSessionVia, 'function')

// --- 0.1.7：当前会话在 uiWorkspace.selection ---
const selection17 = makeStore({ sessionId: 'session-17' })
const list17 = makeStore({ ids: ['session-17'], byId: { 'session-17': { id: 'session-17', running: false, retainedBy: { mainView: 1 } } }, phase: 'ready' })
const source17 = mod.currentSessionSource({ list: list17 }, { selection: selection17 })
check('0.1.7 从 uiWorkspace.selection 取当前会话', source17.getSnapshot(), 'session-17')

// 切换会话后必须跟着变（订阅有效）
let notified = 0
const off17 = source17.subscribe(() => { notified += 1 })
selection17.set({ sessionId: 'session-18' })
check('0.1.7 会话切换后快照跟随', source17.getSnapshot(), 'session-18')
check('0.1.7 订阅被通知', notified > 0, true)
check('0.1.7 同时订阅了 list', list17.listenerCount() > 0, true)
off17()
check('0.1.7 退订后不再通知', list17.listenerCount(), 0)

// --- 0.1.7 退化：selection 为空时用主视图保留的那条 ---
const source17b = mod.currentSessionSource({ list: makeStore({ ids: ['a', 'b'], byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 2 } } } }) }, { selection: makeStore({}) })
check('0.1.7 selection 为空 → 主视图保留的会话', source17b.getSnapshot(), 'b')

// --- 0.1.6：list 快照上的 current ---
const source16 = mod.currentSessionSource({ list: makeStore({ ids: ['s16'], byId: {}, current: 'session-16' }) }, undefined)
check('0.1.6 从 list.current 取当前会话', source16.getSnapshot(), 'session-16')

// --- ≤0.1.5：currentProvideInfo ---
const source15 = mod.currentSessionSource({ currentProvideInfo: makeStore({ sessionId: 'session-15' }), list: makeStore({ ids: [], byId: {} }) }, undefined)
check('0.1.5 从 currentProvideInfo 取当前会话', source15.getSnapshot(), 'session-15')

// --- 无会话 / 空服务：undefined，且不抛异常 ---
check('无服务时返回 undefined', mod.currentSessionSource(undefined, undefined).getSnapshot(), undefined)
check('空快照时返回 undefined', mod.currentSessionSource({ list: makeStore({ ids: [], byId: {} }) }, { selection: makeStore({}) }).getSnapshot(), undefined)
check('空服务可安全订阅', typeof mod.currentSessionSource(undefined, undefined).subscribe(() => {}), 'function')

// --- 打开会话的跨版本路由 ---
const opened = []
check('0.1.7 走 uiWorkspace.openSession',
  mod.openSessionVia({ open: (id) => opened.push(`sessions:${id}`) }, { openSession: (id) => opened.push(`uiWorkspace:${id}`) }, 'session-17'),
  'uiWorkspace')
check('≤0.1.6 回退 sessions.open',
  mod.openSessionVia({ open: (id) => opened.push(`sessions:${id}`) }, undefined, 'session-16'),
  'sessions')
check('两者都没有时安全返回', mod.openSessionVia(undefined, undefined, 'x'), undefined)
check('空 id 不触发跳转', mod.openSessionVia(undefined, { openSession: () => opened.push('bad') }, ''), undefined)
check('跳转调用记录', opened.join(','), 'uiWorkspace:session-17,sessions:session-16')

// --- 完成提醒判定：0.1.6 有 completed，0.1.7 改为「未被主视图保留」 ---
check('0.1.6：completed=true → 提醒', mod.completionNoticeOf({ completed: true, displayTitle: '会话A' }, 's1')?.title, '会话A')
check('0.1.6：completed=false → 不提醒', mod.completionNoticeOf({ completed: false, displayTitle: '会话A' }, 's1'), undefined)
check('0.1.7：主视图未保留 → 提醒', mod.completionNoticeOf({ displayTitle: '会话B', running: false, retainedBy: { mainView: 0 } }, 's2')?.sessionId, 's2')
check('0.1.7：主视图正在看 → 不提醒', mod.completionNoticeOf({ displayTitle: '会话B', retainedBy: { mainView: 1 } }, 's2'), undefined)
check('0.1.7：缺 displayTitle → 回退 id', mod.completionNoticeOf({ id: 's3', retainedBy: { mainView: 0 } }, 's3')?.title, 's3')
check('摘要缺失 → 不提醒', mod.completionNoticeOf(undefined, 's4'), undefined)

// --- apply 接线：槽位注册 + 可选 uiWorkspace 缝 ---
function makeCtx(services) {
  const record = { registered: undefined, injected: [], effects: [] }
  // slots 是插件真正要用的注册表；其余服务由用例注入（缺席即模拟旧版 DSH）。
  const all = {
    ...services,
    slots: { register: (options, component) => { record.registered = { options, component }; return () => {} } },
  }
  const ctx = {
    effect: (setup) => { const dispose = setup(); record.effects.push(dispose); return dispose },
    locale: { register: () => () => {} },
    inject: (names, callback) => {
      record.injected.push(names.join(','))
      if (!names.every((name) => all[name] !== undefined)) return
      const scope = { effect: (setup) => setup(), get: (name) => all[name] }
      for (const name of names) Object.defineProperty(scope, name, { get: () => all[name], configurable: true })
      callback(scope)
    },
  }
  return { ctx, record, services: all }
}

const workspaceService = { selection: selection17, openSession: () => {} }
const modern = makeCtx({ sessions: { list: list17 }, uiWorkspace: workspaceService })
mod.apply(modern.ctx)
check('注册 shell.overlay', modern.record.registered?.options?.name, 'shell.overlay')
check('槽位 id 与包名一致', modern.record.registered?.options?.id, 'dsh-whale-purse')
check('槽位 locale 命名空间', modern.record.registered?.options?.locale, 'whale-purse')
check('组件即 UsageMeter', modern.record.registered?.component, mod.UsageMeter)
check('按需注入 uiWorkspace', modern.record.injected.includes('uiWorkspace'), true)
const modernProps = modern.record.registered.options.inject()
check('props 透出 sessions 服务', modernProps.sessions !== undefined, true)
check('props 透出稳定 runtime', typeof modernProps.runtime, 'object')
check('0.1.7：runtime 已绑定 uiWorkspace', modernProps.runtime.uiWorkspace === workspaceService, true)

const legacy = makeCtx({ sessions: { list: list17 } })
mod.apply(legacy.ctx)
const legacyProps = legacy.record.registered.options.inject()
check('≤0.1.6：runtime 里没有 uiWorkspace（不阻塞激活）', legacyProps.runtime.uiWorkspace, undefined)
check('≤0.1.6：槽位仍然注册成功', legacy.record.registered !== undefined, true)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
