# whale-purse 🐋

> 一只住在 DeepSeek Harness（DSH）里的鲸鱼娘桌宠，帮你盯着 DeepSeek 账户余额和当前会话的用量/花费。

把「DeepSeek 余额 + 会话 token 用量/预估花费」做成一只可拖拽的二次元鲸鱼娘，浮在 DSH Web GUI 上。点她弹出用量明细面板（当前 / 历史双 Tab），拖她换位置，位置自动记住；余额 30s、花费 3s 自动刷新。

![preview](assets/preview.png)

## About

A cute whale desktop pet for DeepSeek Harness that keeps an eye on your DeepSeek balance and session usage/cost. Drag her anywhere, click to open a live panel with real-time spend, peak/off-peak pricing, budget alerts, and history trends.


## 特性

- 🐋 **鲸鱼娘桌宠**：透明立绘悬浮在页面上，随波轻微摇摆，脚底带投影
- 🖱️ **可拖拽**：拖动换位（`localStorage` 记忆，刷新/重开保持），点击开面板
- 🔔 **任务完成提醒**：后台会话跑完时鲸鱼娘弹跳 + 头顶冒泡「任务完成啦」，点气泡直达完成会话
- 🏃 **状态动作**：有任务运行时鲸鱼娘忙碌抖动 + 「忙…」标签；点击她 squash 弹跳回应（纯 CSS，不动形象）
- 💰 **余额监视**：DeepSeek 官方 `Get User Balance` 接口，30s 轮询 + 并发去重；请求失败保留上次快照并提示过期
- ⚠️ **低余额/预算提醒**：余额低于阈值或今日花费超过预算时，面板警告 + 鲸鱼娘红点；浏览器有通知权限时低余额发送 Notification
- ⚙️ **面板设置**：点面板右上角齿轮即可改 `model` / 低余额阈值 / 今日预算 / 「Pro 按 Flash 单价计费」开关，保存到本地 JSON，无需手改 YAML
- 🧮 **会话用量**：读 `sessionProjections` 的 `tokenUsage` 投影，按官方价格折算花费（输入未命中 / 缓存命中 / 输出三桶，分桶条形图按金额占比绘制、每桶标注 token 数、金额与金额占比，避免缓存命中 token 占大头却几乎不花钱的误导；DeepSeek 官方没有「缓存写入」计费类别，故不展示该桶）；`model: auto` 时按会话实际请求头识别 flash/pro，识别为非 DeepSeek 模型（如 GPT / Claude）的会话不估算花费；已落盘消息按各自发生时的峰谷档与模型计价，进行中增量按当前档计价；DSH「在新会话中新建分支」checkout 出的历史 seed 不会重复计费，只统计新建分支后的新增用量
- 📊 **历史趋势（双 Tab 面板）**：「当前」Tab 看余额与实时花费；「历史」Tab 看近 7 天花费柱状图（有 `sessionPersistence` 时自动合并已保存会话）+ 本会话每条提问的花费明细（多步循环自动合并成一行，问题前 10 字 + Tokens + 花费）
- ⚡ **峰谷定价**：按官方口径，北京**周一至周五且非中国法定节假日**的 9:00-12:00 / 14:00-18:00 为高峰价，**其余时间（含周末与中国法定节假日全天）为谷价**；节假日表内置在 `lib/index.js` 的 `CN_HOLIDAY_RANGES`（2026 年）作兜底，并**每 6h 从 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（出处为国务院办公厅放假安排通知，逐年 JSON）自动抓取今年与前后一年的放假/调休数据**并入，落盘缓存 `~/.dsh/whale-purse.holidays.json`（离线/重启仍有效），抓取失败时保持原数据、绝不影响计价；未公布年份退化为「周一至周五」规则；**2026-09-10 12:00 起 Flash 系列降价自动生效**（谷价 0.02 / 1 / 4 元）；面板显示当前档位与距下次切换倒计时；官方定价页每 6h 自动抓取；历史消息按各自时刻的价格时代计价（8/17 前统一价 → 8/17 起峰谷 v1 → 9/10 12:00 起 v2）
- 🌗 **主题适配**：面板颜色与柱状图深浅随 DSH 浅色/深色主题切换（`--dsw-alias-*` token）
- 🖥️ **多屏适配**：外接大屏/笔记本切换时自动把桌宠夹回视口内，不会丢
- 🛡️ **友好错误**：余额/定价请求超时显示「请求超时」而非英文 `This operation was aborted`
- 🧩 **兼容 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)**：适配其 Explorer 面板的浮层层级，桌宠拖进面板区域也不会被遮挡

## 安装

本包是标准 DSH **组合包**（`package.json` 声明 `dsh.bundle`），用插件管理器安装即可：

```bash
dsh plugin --profile web add /path/to/whale-purse
dsh --profile web --dump-config | grep -A3 whale-purse   # 确认层已生效
```

安装后插件行来自包内的 `cordis.patch.yml` 层。**如果之前按旧方式手写过 insert 行，请先删掉它**：同一个 id 在组合期会冲突。只想临时试用也可以继续用旧写法：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: whale-purse
      name: 'whale-purse'
      config:
        model: auto          # auto | pro | flash
        dailyBudget: 5       # 今日花费超过 5 元时提醒（不写则不提醒）
```

配置保存后热重载；浏览器端记得硬刷新（`Cmd+Shift+R`）。余额接口需要能解析到 `DEEPSEEK_API_KEY`（凭据缝 → 启动环境 → `process.env`，逐层回退）。

> 推荐在鲸鱼娘面板右上角点 **⚙ 设置** 修改 `model`、低余额阈值、今日预算、`proBilledAsFlash`、`makeupWorkdaysArePeak`；保存后写入 `statePath`（默认 `~/.dsh/whale-purse.settings.json`），优先级高于 YAML 里的同名配置，无需重启。

### 安全说明

HTTP 接口注册在 DSH `connection` 服务的 exact Fetch 路由表上（`/api` 通道），因此**与内置 `/api` 通道共用浏览器认证与 Host/Origin 检查**：未认证请求返回 401，跨站 / DNS rebinding 请求被拒。不要把这几条路由改回 `ctx.webServer.register()`——那是裸路由，会绕过围栏（0.2.0 之前的版本就是这么写的）。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
配置在**加载期**由 `lib/config.js` 的 schema 校验：类型/范围不合法会让插件加载失败并指出字段名（不再静默退化成奇怪行为，例如把刷新间隔变成 1ms 热循环），未声明字段按 Schemastery 语义剔除，缺失字段落默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | `auto` | 计价模型：`auto`（按会话实际请求头识别；非 DeepSeek 模型不估算花费）/ `pro` / `flash` |
| `enabled` | `true` | 是否启用余额查询与后台刷新 |
| `refreshIntervalSeconds` | `30` | 余额结果缓存间隔（秒），5–86400 |
| `pricingRefreshHours` | `6` | 官方定价页 + 节假日数据抓取间隔（小时），0.25–720 |
| `pricingUrl` | 官方定价页 | 价格自动抓取的来源页 |
| `holidayDataUrls` | holiday-cn（jsdelivr 优先、raw 备用） | 节假日数据源模板数组，`{year}` 为年份占位 |
| `requestTimeoutMs` | `15000` | 单次外部请求超时（毫秒），1000–120000 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | API key 的环境变量名 |
| `baseUrl` | `https://api.deepseek.com` | 余额接口 base URL（http/https） |
| `lowBalanceThreshold` | `10` | 余额低于该值（CNY）时触发低余额提示 |
| `dailyBudget` | 未设置 | 今日花费预算（CNY），超过后面板提示 |
| `proBilledAsFlash` | `true` | 2026-09-10 12:00 起官方把 V4 Pro 请求路由到 V4.1 Flash 并按 Flash 单价计费；`false` 则按 Pro 自身价目估算 |
| `makeupWorkdaysArePeak` | `false` | 官方调休上班的周末（如 2026-09-20、10-10）是否按工作日计高峰（9:00-12:00 / 14:00-18:00）。默认 `false`：按官网页脚注字面口径「周末全天均为空闲时段」 |
| `statePath` | `~/.dsh/whale-purse.settings.json` | 面板设置的落盘路径 |
| `holidayCachePath` | `~/.dsh/whale-purse.holidays.json` | 节假日缓存的落盘路径 |

> 客户端轮询节奏（余额 30s、当前会话花费 3s）跟随浏览器渲染，属于客户端常量，不走配置。

## 项目结构

```
whale-purse/
├── cordis.patch.yml    # 组合包层：profile 列出本包时插入插件行（dsh.bundle.patch）
├── lib/
│   ├── config.js       # 配置契约：Standard Schema v1 校验 + 默认值（零依赖实现）
│   ├── index.js        # host 端：余额服务 + exact Fetch 路由（/api/whale-purse/balance、…/daily、…/messages、…/settings）
│   └── client.js       # 浏览器端：鲸鱼娘桌宠 + 双 Tab 面板（WebP 立绘 base64 内联）
├── assets/
│   ├── whale-sprite.webp       # 内联立绘（280×373，透明，约 41KB）
│   ├── whale-sprite.png        # 鲸鱼娘立绘源 PNG（280×373，透明）
│   ├── whale-front-source.png  # 立绘源图
│   └── preview.png             # 预览图
└── scripts/
    ├── embed-asset.mjs         # 把 whale-sprite.webp/png 重新内联进 lib/client.js
    ├── screenshot.mjs          # Playwright 截图脚本
    ├── smoke-test.mjs          # 模型识别 / 计价 / 配置 schema 冒烟测试
    └── plugin-test.mjs         # 插件契约测试：假 cordis 上下文驱动真实模块（路由围栏 / 可选缝 / 卸载收敛）
```

跑测试：`npm test`（= `node scripts/smoke-test.mjs && node scripts/plugin-test.mjs`）。

`whale-sprite.webp` 由 PNG 源图生成：`cwebp -q 90 -alpha_q 100 -m 6 assets/whale-sprite.png -o assets/whale-sprite.webp`。改完素材后运行 `npm run embed` 重新内联。

## 更新日志

### 0.2.0 —— 规范对齐（2026-09-21）

- **安全**：HTTP 路由从 `ctx.webServer` 裸路由改挂 `connection` 的 exact Fetch 路由表，回到 DSH 的浏览器认证 + Host/Origin 围栏之内（此前 `/api/whale-purse/*` 未认证即可读写，实测 `GET /api/whale-purse/settings` 返回 200）；同步移除 `webServer` 依赖，`inject` 改为 `['connection', 'sessions']`
- **配置契约**：新增 `lib/config.js`（Standard Schema v1），全部可调参数集中校验并补默认值——非法值在加载期报错（此前 `refreshIntervalSeconds: abc` 会算出 `NaN`，Node 把 `setInterval(fn, NaN)` 当 1ms，直接变成热循环）；新增可配置项 `pricingUrl`、`holidayDataUrls`、`requestTimeoutMs`、`statePath`、`holidayCachePath`
- **生命周期**：构造函数不再产生副作用，后台刷新改由 `ctx.effect` 启停；所有外部请求带 `AbortController`，`dispose()` 停表 → 中止在途 → `await` 收敛（卸载后不再留下仍在写盘的孤儿请求）
- **依赖声明**：`credentials` / `launchEnvironment` / `sessionProjections` / `sessionPersistence` 四个可选缝改用 `ctx.inject` 绑定与自动解绑，去掉运行时的 `ctx.get()` 探测
- **打包**：补 `dsh.bundle`（`cordis.patch.yml` 层）、`dsh.engines`、`files`、`peerDependencies` 与 `npm test`；修正 `dsh.client.inject` 里两个并不存在的包名
- **清理**：移除客户端早已失效的 `/api/balance` legacy 回退；调试钩子 `window.__whalePurseNotify` 改为仅在 `?whale-debug` 下挂载
- **测试**：新增 `scripts/plugin-test.mjs`（假 cordis 上下文驱动真实模块：路由围栏、可选缝绑定/解绑、卸载收敛），smoke test 增加配置 schema 用例

### 2026-09-20（二）节假日数据自动更新

- 新增：**中国法定节假日/调休数据每 6h 自动抓取** —— 数据源 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（逐年 JSON，`papers` 字段给出国务院办公厅放假安排通知原文），jsdelivr 优先、`raw.githubusercontent` 备用，抓取「今年 ± 1 年」三份；国务院通常 11 月公布次年安排，公布后插件**无需改代码即可自动跟进**（内置 `CN_HOLIDAY_RANGES` 只作兜底，抓取失败或未公布年份退回原规则）
- 新增：抓取结果落盘 `~/.dsh/whale-purse.holidays.json`，重启/离线时先读缓存再后台刷新；并入语义是**只增不减**（坏数据、空占位年份一律忽略），绝不因网络问题改变已生效的计价
- 新增：`makeupWorkdaysArePeak` 开关（默认 `false`）—— 官方调休上班日全部落在周末（2026 年 6 天：01-04、02-14、02-28、05-09、09-20、10-10）。默认按官网页脚注字面口径「周末全天均为空闲时段」计；置 `true` 则把这些天当工作日，按 9:00-12:00 / 14:00-18:00 计高峰。面板 ⚙ 设置与 YAML 都可改
- 测试：冒烟测试 141 条全通过（新增 26 条：年份 JSON 解析、数据源回退、空占位年份、坏数据、并入语义、缓存缺失、调休开关与切换点、开关透传到计价）

### 2026-09-20

- 更新：**峰谷口径补上中国法定节假日** —— 官方定价页脚注现为「北京时间周一至周五（**不含中国法定节假日**）9:00-12:00、14:00-18:00 为高峰时段；其余时段，**包括周末及中国法定节假日全天**均为空闲时段」。此前只判定星期，元旦/春节/清明/劳动节/端午/中秋/国庆落在工作日时会**被按高峰价（2 倍）多收**
- 新增：`CN_HOLIDAY_RANGES` / `CN_HOLIDAYS`（2026 年 7 组放假、共 33 天，取自国务院办公厅放假安排通知）与 `beijingDateKey` / `isChinaHoliday` / `isPeakDay` 判定函数；峰谷切换点（面板倒计时）跨周末与节假日整段跳过，例如 9/30 19:00 之后直接指向 10/8 09:00
- 说明：**调休上班的周末仍按周末 = 空闲时段**计（脚注「周末全天均为空闲时段」的字面口径）；未收录年份退化为「周一至周五」规则，2027 年放假安排公布后按同样格式追加 `['2027-01-01', '2027-01-03']` 即可
- 兼容：官方定价页 2026-09 改版后档位列名为 `deepseek-flash`（旧名 `deepseek-v4-flash` 仍可调用、同价），表头列定位同时兼容新旧两代写法与 `deepseek-flash(1)` 这类脚注标记
- 测试：冒烟测试新增 25 条用例（节假日/周末/调休判定、节假日价档、跨节假日切换点、新表头解析），共 115 条全通过

### 2026-09-10

- 更新：**Flash 系列降价**（官方 2026-09-09 公告，北京时间 2026-09-10 12:00 生效）—— 空闲时段缓存命中 0.05→**0.02**、未命中 1.5→**1**、输出 4.5→**4** 元/百万 tokens；高峰时段为谷价 2 倍（0.04 / 2 / 8）
- 新增：**价格时代（era）记账** —— 2026-08-17 之前为统一价、8/17–9/10 12:00 为峰谷 v1、9/10 12:00 起为 v2；历史消息按各自 `event.time` 落到对应时代计价，调价不会把旧会话的账单一起改写
- 新增：`proBilledAsFlash` 开关（默认开）—— 官方在 V4.1 Flash 上线后把 V4 Pro 请求路由到 V4.1 Flash 并按 Flash 单价计费；关掉则按 Pro 自身价目估算。面板 ⚙ 设置与 `cordis.patch.yml` 的 `config` 都可改
- 修复：**官方定价页解析失效** —— 页面写的是 `百万tokens输入<br>（缓存命中）`，`stripHtml` 把 `<br>` 变成空格，而锚点正则写死无空格，导致 `priceSections` / `parsePeakTable` 恒返回 `undefined`、每 6h 的自动抓取形同虚设（内置预设一直在兜底）。现锚点容忍空白
- 优化：价格表按**表头模型列**取值，不再写死第 0/1 列 —— 官方页新增模型列（vision / 未来的 v4.1）时不会串价
- 修复：官方页仍是旧价目时不再**倒灌回退** —— 抓取到的 v1 旧表会被识别并忽略，继续使用内置 v2 新价（官方定价页是静态构建，调价当天往往还没重新发布）
- 测试：冒烟测试新增价格时代边界、v2 价目、Pro 路由开关、跨时代会话累计与定价页解析回归用例
- 修复：**新版 DSH 会话 API 漂移** —— 会话对象不再暴露 `.events` 属性（改为方法 `session.snapshotEvents()`），`sessions.list` 也从函数改成快照 store。此前插件读不到事件，导致「每条提问明细」恒为空、每日柱状图漏掉当前会话，并且**整个会话被按「查看时刻」的时段价折算**（跨峰谷切换时花费会凭空翻倍）。现已新旧版本双兼容

### 2026-08-28

- 修复：DSH「在新会话中新建分支」后，新会话不再重复计算 checkout（seed）之前的花费，只统计分支后的新增用量
- 修复：非 DeepSeek 模型（GPT / Qwen / Claude 等）不再被误按 DeepSeek flash/pro 计费，auto 模式下显示「未估算花费」
- 优化：分桶条形图改为按金额占比绘制，并显示每桶金额占比；移除 DeepSeek 不存在的「缓存写入」展示桶
- 测试：新增 `scripts/smoke-test.mjs` 冒烟测试，覆盖模型识别、分支 seed 跳过与混合模型计价


## 素材来源与版权

- 鲸鱼娘立绘来自 [dafeiyu-pet](https://github.com/1190fasheqi/dafeiyu-pet)（MIT License），是 DeepSeek 鲸鱼形象的二创桌宠。
- 本项目为 DeepSeek / DSH 的非官方插件，与 DeepSeek 官方无关联。

## License

[MIT](LICENSE)
