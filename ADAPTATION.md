# 版本适配记录：DSH 0.1.5-rc.3 → 0.1.7-rc.1

本文件记录 `dsh-whale-purse` 为适配 DSH `0.1.7-rc.1` 所做的改动、验证方式与回退办法。
上游基线是备份里的 `0.2.1`；本次适配后版本号为 **`0.2.2`**，随后因
「当前会话」解析在 0.1.7 上失效，追加修复并升到 **`0.3.0`**（见第六节）。

## 一、为什么需要适配

`0.1.7-rc.1` 没有破坏本插件用到的任何内核契约（逐项核对见第三节），真正变化的是
**插件与宿主之间的声明方式**：

1. **兼容性预检**（`@deepseek-ai/dsh-app-boot`）。启动/安装时，`evaluatePluginCompatibility()`
   读插件 `package.json` 的 `peerDependencies` 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
   条目，与运行中的 dsh 版本比对；不匹配就**明确禁用该行**（bundle 行则是直接抛错），
   并提示用 `dsh plugin allow-version` 放行。自造的 `dsh.engines.dsh` 字段不再被任何代码读取。
2. **linked 插件的模块解析规则**。linked 的插件目录保留自己的 `node_modules`，
   而插件与宿主必须**共用同一个实例**的 dsh 包，要在 `peerDependencies` **和**
   `devDependencies` 里同时声明。
3. **浏览器路由改为文档相对**。官方 Web 端自己的路由（如 `/plugins/events`）从
   0.1.7-rc.1 起统一写成 `new URL('...', document.baseURI)`，以便页面被反向代理挂在
   子路径下时仍然可用；插件里写死的 `/api/...` 在那种部署下会打到站点根而不是应用根。

## 二、改动清单

### `package.json`

| 改动 | 原因 |
| --- | --- |
| 删除 `dsh.engines.dsh` | 0.1.7-rc.1 不读它，留着会有「声明了却没生效」的错觉 |
| 新增 `peerDependencies["@deepseek-ai/dsh"] = ">=0.1.5-rc.2"` | 接入新的兼容性预检；下限取本插件真实可用过的最低版本，不误伤 0.1.5/0.1.6 |
| 新增 `devDependencies["@deepseek-ai/dsh"] = "0.1.7-rc.1"` | 官方约定的成对声明：dev 侧供独立类型检查/测试，运行期用宿主实例 |
| 新增 `engines.node >= 22` | 与 DSH 0.1.7-rc.1 自身的 Node 下限一致 |
| 新增 `author` / `repository` / `homepage` / `bugs` | 此前整个包没有仓库字段，与 `amap-trip` 的元数据形状对齐 |
| `version` 0.2.1 → 0.2.2 | 预检按 `name@version` 记录豁免，必须换版本号 |

### `lib/client.js`（浏览器半边）

- 新增 `apiUrl(path)`：把 `/api/...` 解析成 `new URL(path, document.baseURI)`。
- 6 处请求改走它：`fetchJson()` 的 5 个调用点（balance / refresh / settings /
  daily / messages / cost）＋ `saveSettings()` 里那个直写的 `fetch`。
- 页面在站点根（baseURI = `https://host/`）时，解析结果与原来的绝对路径**逐字相同**，
  因此这是一处零回归的向前兼容改动。

### `lib/index.js`（宿主半边）

- **修复：历史趋势此前只统计当前进程。** 旧代码用
  `typeof persistence.readFrom === 'function'` 作为读取已落盘会话的闸门，并回退探测
  `listSnapshots()`。这两个名字在**任何版本**的 `@deepseek-ai/dsh-session-persistence`
  上都不存在（0.1.5-rc.3 与 0.1.7-rc.1 的抽象类都只有 `create/open/flush/stat/list`），
  因此那段分支从未执行过，`coverage` 永远停在 `'live'`。
  现按真实契约读取：
  ```
  sessionPersistence.list()               → 存储快照（header + revision）
  sessionPersistence.open(id, 'read')     → 只读句柄
  handle.read(0)                          → { events } 全量已校验事件
  handle.inheritedEventCount              → 分支继承前缀长度（header 里没有这个数）
  handle.close()                          → 释放（幂等，放在 finally）
  ```
  新增模块级 helper `readPersistedSession()`；单条会话读失败（损坏/格式过新/权限）
  仍旧只跳过该条，不拖垮整份统计；`revision` 事件缓存保留。
- `seedStartSeq()` 现在优先读 `session.inheritedEventCount`（0.1.5 起就在 `Session`
  上公开的权威字段），`seedLength` 降为回退——后者只是持久化 wire header 上的旧名字。

## 三、逐项核对过、确认无需改动的契约

| 用到的能力 | 0.1.5-rc.3 → 0.1.7-rc.1 |
| --- | --- |
| `export const inject = ['connection','sessions']` | 服务名与语义未变 |
| `ctx.provide('whalePurse', service)` | cordis 4.0.2 → 4.0.4 未变 |
| `ctx.inject([name], scope => …)` / `ctx.effect(fn, label)` | 未变 |
| `ctx.connection.fetch.register({path,methods,requestBody,fetch})` | `ConnectionFetchRoute` 逐字未变 |
| `ctx.sessions.get(id)` | 宿主侧未变 |
| 客户端 `sessions.list` 快照 store | **变了**：0.1.7 起快照是 `{ids,byId,phase,projectionsBySession}`，**没有 `current`**；`currentProvideInfo` 整块移除，当前会话改由 `uiWorkspace.selection`（`{sessionId?,subagentAddress?}`，持久化名 `dsh.sessions.current`）承载 |
| 客户端 `sessions.open(id)` | **没了**；0.1.7 用 `uiWorkspace.openSession(sessionId)` |
| 可选缝 `credentials` / `launchEnvironment` / `sessionProjections` / `sessionPersistence` | 四个包的 `.d.ts` 中 `dsh-credentials`、`dsh-launch-environment`、`dsh-session-projection` **整包未变**；`dsh-session-persistence` 的 `list/stat/open` 签名未变 |
| `session.snapshotEvents()` / `.events` 回退 | 未变 |
| `assistant/message.data.usage` 的 `TokenUsage` | 字段逐字未变（`inputTokens`/`outputTokens`/`totalTokens?`/`cacheReadTokens?`/`cacheWriteTokens?`/`reasoningTokens?`） |
| `request/header.data.header.config.{model,provider}` | `dsh-session/lib/types/request-header.d.ts` 未变 |
| 客户端 `window.__ModuleLoader__.load({id, factory})` | 注册协议未变（`factory` 的 `require` 新增了可选的 `.async`，不影响） |
| 客户端 `ctx.slots.register({name,id,order,locale,inject}, Component)` + `shell.overlay` | 槽位与注册契约未变 |
| 客户端 `ctx.locale.register(ns, {zh,en})` | 未变 |
| `dsh.bundle.patch` / `dsh.client.{platform,inject}` | 未变（`patch` 新增支持数组，非必需） |

> 会话格式从 v3 升到 v4（`SessionHeader.version`）。本插件只消费**已解码**的
> `SessionEvent`，不碰物理格式；实测 v3 存档在 0.1.7-rc.1 下读取与计价均正常。

## 四、验证方式（全部在 DSH 0.1.7-rc.1 上跑）

1. **真实进程内探针**：用 npm 装的 `@deepseek-ai/dsh@0.1.7-rc.1` 起一个独立
   `DSH_HOME`（工作区内）＋ web profile，额外挂一个只读探针插件，核对
   - `ctx.get('whalePurse')` 能跨插件读到，`view/refresh/settingsView/applySettings/dailyCosts/sessionCost` 全在；
   - 四个可选缝全部就位（`credentials, launchEnvironment, sessionProjections, sessionPersistence`）；
   - `dailyCosts()` 在真实 v3 存档上返回 `coverage: "live+persisted"` 并算出非零花费
     （这是第二节那处修复的直接证据）。
2. **插件自带测试**：`npm test`（smoke + plugin-test）全绿。
3. **客户端冒烟**：用假 `window.__ModuleLoader__` + 真 React 加载 `lib/client.js`，
   确认工厂可执行、导出 `{apply,inject,UsageMeter}`、`apply()` 注册进
   `shell.overlay`（`id=dsh-whale-purse`、`order=130`、`locale=whale-purse`）并登记中英字典。
4. **客户端会话源回归测试**（`scripts/client-test.mjs`，0.3.0 起随 `npm test` 一起跑）：
   在假 `__ModuleLoader__` 下取出工厂，对 0.1.5 / 0.1.6 / 0.1.7 三种服务形状逐一断言
   `currentSessionSource()` 的结果、订阅/退订、以及 `openSessionVia()` 的路由。
5. **对着正在跑的 DSH 做端到端验证**（0.3.0）：用 systemd 日志里的启动 token 换 cookie，
   带认证直连 `/api/whale-purse/balance/cost?session=<真实会话>` 与
   `.../balance/messages?session=<真实会话>&limit=3`，均返回 `ok:true` 与真实金额；
   `/balance/daily?days=7` 返回 `coverage:"live+persisted"` 与每日金额。
6. **兼容性预检本身**：把 peer 范围临时改成 `0.1.4`，启动时如期出现
   `dsh: disabling profile plugin row "dsh-whale-purse": Plugin dsh-whale-purse@0.2.2 is incompatible with dsh 0.1.7-rc.1 …`，
   改回后消失——证明这条声明是真的接线了，不是装饰。

## 五、安装与回退

安装（组合包形态，推荐）：

```bash
dsh plugin --profile web add /path/to/dsh-whale-purse
```

临时试用（overlay，路径必须绝对）：

```yaml
# extra.yml
- insert:
    - id: dsh-whale-purse
      name: '/abs/path/to/dsh-whale-purse'
```

```bash
dsh --profile web --patch ./extra.yml
```

回退：备份里的 `0.2.1` 原样可用（只是在新版下享受不到兼容性预检与
「历史趋势」修复）；把 `package.json`、`lib/index.js`、`lib/client.js`
换回 `0.2.1` 即可。

## 六、0.3.0：面板内容大面积缺失的真因（客户端「当前会话」解析）

**症状**：点开鲸鱼娘，面板内容少了一大半——「本会话 · 预估花费」整块（含三桶条形图、
计价行、峰谷档）消失，只剩余额；「历史」Tab 的「本会话消息花费」恒为空。

**定位过程**：

1. 先怀疑宿主半边。用 systemd 日志里的启动 token 换到认证 cookie，
   带认证直连插件接口，结果**宿主完全正常**：
   `/balance` 200、`/balance/daily?days=7` 返回 `coverage:"live+persisted"` 与每日真实金额、
   `/cost?session=<真实会话>` 返回 `ok:true`（¥7.47 与三桶明细）、
   `/messages?session=<真实会话>` 返回逐轮明细。**数据都在，是客户端没去取。**
2. 再查客户端：面板用
   `sessions.currentProvideInfo?.getSnapshot()?.sessionId ?? sessions.list?.getSnapshot()?.current`
   解析当前会话 id。而在 0.1.7-rc.1：
   - `grep -rl currentProvideInfo @deepseek-ai/*/lib/client.js` → **0 命中**（整块 API 已删）；
   - `sessions.list` 快照构造处只有 `{ids, byId, phase, projectionsBySession}`，**没有 `current`**。

   于是 `sessionId` 恒为 `undefined`：
   - `pollCost` 退化成不带参数的 `/balance/cost` → 宿主回 `{ok:false,error:'missing-session'}`
     → `costOk=false` → 整个花费区块按「暂无数据」渲染（这正是"内容少了非常多"）；
   - `pollHistory` 里 `encodeURIComponent(undefined)` → `?session=undefined` →
     `unknown-session` → 消息明细恒空；
   - 「任务完成」气泡的 `sessions.open?.(id)` 也已是空操作（0.1.7 无此方法）。

**0.1.7 的正确来源**（读官方实现得到）：
`dsh-client-ui-workspace` 的 `UiWorkspaceService` 上挂着
`selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } })`，
写入 `{sessionId, subagentAddress?}`；官方 `ui-session.publishMain()` 的兜底是取
`list.byId` 里 `retainedBy.mainView > 0` 的那条。会话切换用 `uiWorkspace.openSession(id)`。

**同一族的第二处静默回归**：「任务完成」气泡的判定读 `summary.completed`，而 0.1.7 的
列表摘要只剩 `{id,displayTitle,running,retainedBy,blank,updatedAt,projectionValues?,title?,cwd?,parentId?,origin?}`
——`completed` 已移除，于是气泡再也不会出现。改用 `completionNoticeOf()`：
有 `completed`（≤0.1.6）就用它，否则用「未被主视图保留」`retainedBy.mainView === 0`
等价表达「跑完了而且用户没在看」。

**修复**（`lib/client.js`）：

- 新增 `currentSessionSource(sessions, uiWorkspace)`：按
  `currentProvideInfo.sessionId`（≤0.1.5）→ `list.current`（0.1.5/0.1.6）→
  `uiWorkspace.selection.sessionId`（≥0.1.7）→ `byId` 中 `retainedBy.mainView > 0` 的顺序取，
  并同时订阅所有可用 store；组件里用 `useMemo` 固定 source 再交给 `useSyncExternalStore`。
- `uiWorkspace` 是 0.1.7 才有的服务：**不写进 `inject`**（否则旧版插件直接不激活），
  改用 `ctx.inject(['uiWorkspace'], scope => …)` 按需绑定到稳定对象 `runtime`，
  再由槽位 `inject: () => ({ sessions, runtime, uiWorkspace })` 透给组件；
  服务缺席时自动退回旧版解析链。
- 新增 `openSessionVia(sessions, uiWorkspace, id)`：0.1.7 走 `uiWorkspace.openSession`，
  旧版回退 `sessions.open`。
- 新增 `completionNoticeOf(summary, id)`：完成提醒的跨版本判定（见上）。
- `package.json`：`dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-workspace`；
  `npm test` 增加 `scripts/client-test.mjs`。

**验证**：`scripts/client-test.mjs` 19 项断言全过（三种版本形状 + 订阅退订 + 打开会话路由 +
`apply` 接线）；对真机接口的探测（见第四节第 5 条）证明修复后客户端会发出的那两个请求
都返回真实数据。
