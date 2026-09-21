# dsh-whale-purse 🐋

> 住在 DeepSeek Harness（DSH）里的鲸鱼娘桌宠：盯着你的 DeepSeek 余额，顺手把当前会话花了多少钱算给你看。

![preview](assets/preview.png)

一只可拖拽的二次元鲸鱼娘，浮在 DSH Web GUI 上；点她弹出「当前 / 历史」双 Tab 用量面板。余额 30s、当前会话花费 3s 自动刷新，拖过的位置自动记住。

| | |
| --- | --- |
| 形态 | DSH 组合包（`dsh.bundle`）+ Web 客户端 bundle；纯 ES，无构建步骤 |
| 需要 | DSH `>= 0.1.5-rc.2`；可解析 `DEEPSEEK_API_KEY` 的凭据缝（缺失时只影响余额，不影响花费统计） |
| 仓库 | 上游 [Suiwan/whale-purse](https://github.com/Suiwan/whale-purse) → 本仓库 [TsuyuzakiFarm/dsh-whale-purse](https://github.com/TsuyuzakiFarm/dsh-whale-purse) |
| 许可 | MIT |

## About

A cute whale desktop pet for DeepSeek Harness: she watches your DeepSeek balance and the token usage/cost of the current session. Drag her anywhere, click to open a live panel with real-time spend, peak/off-peak pricing, budget alerts and a 7-day history.

## 特性

**桌宠**

- 🐋 透明立绘悬浮、随波轻微摇摆、脚底投影；可拖拽换位（`localStorage` 记忆）
- 🔔 后台会话跑完时弹跳 + 冒泡「任务完成啦」，点气泡直达该会话
- 🏃 有任务运行时忙碌抖动 + 「忙…」标签，点击 squash 弹跳回应（纯 CSS，不动形象）
- 🖥️ 多屏/分辨率变化时自动夹回视口；🌗 面板配色跟随 DSH 浅色/深色主题
- 🧩 兼容 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的浮层层级，拖进面板区域也不被遮挡

**用量与花费**

- 💰 **余额**：官方 `Get User Balance`，30s 轮询 + 并发去重；请求失败保留上次快照并提示「显示的是过期数据」
- 🧮 **花费**：读 `sessionProjections` 的 `tokenUsage` 投影，按官方价格折算。三桶（输入未命中 / 缓存命中 / 输出）条形图按**金额占比**绘制，避免「缓存命中 token 占大头、却几乎不花钱」的误导
- 📊 **双 Tab 面板**：「当前」看余额与实时花费；「历史」看近 7 天柱状图（有 `sessionPersistence` 时自动合并已保存会话）+ 本会话每条提问的花费明细（多步循环自动合并成一行）
- 🛡️ 余额/定价请求超时显示「请求超时」，不把英文 `This operation was aborted` 丢给用户

**提醒与设置**

- ⚠️ 余额低于阈值 / 今日花费超预算 → 面板警告 + 鲸鱼娘红点；浏览器有通知权限时低余额发送 Notification
- ⚙️ 面板右上角齿轮即可改计价模型、低余额阈值、今日预算等，写入本地 JSON，无需手改 YAML

**计价**（口径细节见[计价口径](#计价口径)）

- ⚡ **峰谷定价**：北京时间工作日 9:00-12:00 / 14:00-18:00 为高峰价，其余时段（含周末与法定节假日全天）为谷价
- 🗓️ **节假日自动跟进**：中国法定节假日/调休数据每 6h 自动抓取并落盘缓存，无需改代码跟次年安排，「调休上班日算不算高峰」有开关
- 🕰️ **价格时代记账**：历史消息按各自发生时刻的价格时代计价，官方调价不会改写旧账单

## 安装

本包是标准 DSH **组合包**（`package.json` 里的 `dsh.bundle`），推荐用插件管理器安装：

```bash
dsh plugin --profile web add /path/to/dsh-whale-purse
dsh --profile web --dump-config | grep -A3 dsh-whale-purse   # 确认层已生效
```

插件行由包内 `cordis.patch.yml` 层提供。**若你之前手写过 insert 行，请先删掉**——同一个 id 在组合期会冲突（`duplicate loader entry id`）。只想临时试用也可以继续用旧写法：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-whale-purse
      name: 'dsh-whale-purse'
      config:
        model: auto          # auto | pro | flash
        dailyBudget: 5       # 今日花费超过 5 元时提醒（不写则不提醒）
```

生效方式：只改插件配置 → host 侧热重载即可；改过 `dsh.profile.bundles` 或 `lib/index.js` → 需**重启 DSH 进程**；浏览器端一律记得硬刷新 **`Cmd/Ctrl+Shift+R`**。

### 依赖：DEEPSEEK_API_KEY

余额查询需要能解析到 key，按「凭据缝（`~/.dsh/.credentials.yaml` 的 `refs`）→ 启动环境 → `process.env`」逐层回退。

### 安全

HTTP 接口注册在 DSH `connection` 服务的 exact Fetch 路由表（`/api` 通道），因此**与内置 `/api` 共用浏览器认证 + Host/Origin 检查**：未认证请求返回 401，跨站 / DNS rebinding 请求被拒。不要把这几条路由改回 `ctx.webServer.register()` 的裸路由——那会绕过围栏（0.2.0 之前就是这么写的）。

## 配置

配置在**加载期**由 `lib/config.js` 的 schema 校验：类型/范围不合法会让插件**加载失败并指出字段名**（不会再静默退化成奇怪行为，比如把刷新间隔算成 `NaN`、被 Node 当成 1ms 热循环），未声明字段剔除，缺失字段落默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | `auto` | 计价模型：`auto`（按会话请求头识别；非 DeepSeek 模型不估算花费）/ `pro` / `flash` |
| `enabled` | `true` | 是否启用余额查询与后台刷新 |
| `refreshIntervalSeconds` | `30` | 余额结果缓存间隔（秒），5–86400 |
| `pricingRefreshHours` | `6` | 官方定价页 + 节假日数据抓取间隔（小时），0.25–720 |
| `pricingUrl` | 官方定价页 | 价格自动抓取的来源页 |
| `holidayDataUrls` | holiday-cn（jsdelivr 优先、raw 备用） | 节假日数据源模板数组，`{year}` 为年份占位 |
| `requestTimeoutMs` | `15000` | 单次外部请求超时（毫秒），1000–120000 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | API key 的环境变量名 |
| `baseUrl` | `https://api.deepseek.com` | 余额接口 base URL（http/https） |
| `lowBalanceThreshold` | `10` | 余额低于该值（CNY）时触发提示 |
| `dailyBudget` | 未设置 | 今日花费预算（CNY），超过后面板提示 |
| `proBilledAsFlash` | `true` | V4 Pro 请求按 Flash 单价计费（2026-09-10 12:00 起官方口径）；`false` 则按 Pro 自身价目估算 |
| `makeupWorkdaysArePeak` | `false` | 官方调休上班的周末是否按工作日计高峰（9:00-12:00 / 14:00-18:00）。默认 `false`：按官网页脚注字面口径「周末全天均为空闲时段」 |
| `statePath` | `~/.dsh/dsh-whale-purse.settings.json` | 面板设置的落盘路径 |
| `holidayCachePath` | `~/.dsh/dsh-whale-purse.holidays.json` | 节假日缓存的落盘路径 |

> 面板 ⚙ 设置写入 `statePath`，**优先级高于 YAML 里的同名配置**，保存即生效、无需重启。
> 客户端轮询节奏（余额 30s、花费 3s）跟随浏览器渲染，属客户端常量，不走配置。

## 计价口径

- **峰谷时段**：按官方定价页脚注，高峰 = 北京时间**周一至周五且非中国法定节假日**的 9:00-12:00、14:00-18:00；**其余时段（含周末与中国法定节假日全天）为谷价**（谷价 = 高峰价的一半）。面板显示当前档位与距下次切换的倒计时，切换点会整段跳过周末/假期（例如 9/30 19:00 之后直接指向 10/8 09:00）。
- **节假日数据**：来源 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（出处为国务院办公厅放假安排通知），每 6h 抓取「今年 ±1 年」并落盘缓存（离线/重启仍有效）；内置 `CN_HOLIDAY_RANGES`（2026 年）只作兜底。抓取失败保持原数据、**绝不影响计价**；未公布年份退化为「周一至周五」规则。
- **价格时代**：`standard`（2026-08-17 前统一价）→ `v1`（8/17 起峰谷）→ `v2`（9/10 12:00 起 Flash 降价：谷价 0.02 / 1 / 4 元/百万 tokens）。历史消息按各自 `event.time` 落到对应时代计价。
- **模型识别**：`auto` 按会话实际请求头识别 flash/pro；识别为非 DeepSeek 模型（GPT / Claude / Qwen 等）的会话**不估算花费**，面板显示「未估算花费」。
- **分支会话**：DSH「在新会话中新建分支」checkout 出的历史 seed 不重复计费，只统计新建分支后的新增用量。
- **价格自动刷新**：每 6h 抓官方定价页；抓到仍是旧价目（官方页为静态构建，调价当天常还没重新发布）时会识别并忽略，**不会把新价倒灌回旧价**。

## 项目结构

```
dsh-whale-purse/
├── cordis.patch.yml    # 组合包层：profile 列出本包时插入插件行（dsh.bundle.patch）
├── lib/
│   ├── config.js       # 配置契约：Standard Schema v1 校验 + 默认值（零依赖实现）
│   ├── index.js        # host 端：余额服务 + exact Fetch 路由
│   │                   #   /api/whale-purse/{balance,balance/refresh,settings,balance/cost,balance/daily,balance/messages}
│   └── client.js       # 浏览器端：桌宠 + 双 Tab 面板（WebP 立绘 base64 内联）
├── assets/             # whale-sprite.webp（内联用） / .png（源图） / preview.png
└── scripts/
    ├── embed-asset.mjs # 把 whale-sprite.webp 重新内联进 lib/client.js（npm run embed）
    ├── screenshot.mjs  # Playwright 截图（仅本地调试，依赖本机缓存路径）
    ├── smoke-test.mjs  # 模型识别 / 计价 / 节假日 / 配置 schema 冒烟测试
    └── plugin-test.mjs # 插件契约测试：假 cordis 上下文驱动真实模块（路由围栏 / 可选缝 / 卸载收敛）
```

## 开发与验证

```bash
npm test                                          # = smoke-test + plugin-test
bash ~/.dsh/skills/shared/whale-purse-check.sh    # 本机一键体检（源码/语法/测试/profile 注册/接口）
```

- 体检脚本里接口返回 **401 属正常**（未认证 → `/api` 围栏生效）；要看真实数据请用已登录的浏览器页面。
- 立绘以 `assets/whale-sprite.webp` 为准，改完素材重跑 `npm run embed`；源图转 webp：`cwebp -q 90 -alpha_q 100 -m 6 assets/whale-sprite.png -o assets/whale-sprite.webp`。
- 排障：桌宠不出现 → 先硬刷新；再确认 `dsh.profile.bundles` 里有 `dsh-whale-purse`，且 profile 的 `cordis.patch.yml` 里**没有**同名 insert。余额「不可用」→ 检查 `DEEPSEEK_API_KEY` 能否被凭据缝解析。

## 更新日志

### 0.2.1（2026-09-21）更名 dsh-whale-purse

- 插件包名 / 组合层 id+name / 客户端 bundle id / 插件导出名统一为 `dsh-whale-purse`（社区惯例的 `dsh-*` 命名），仓库与安装目录同步更名
- 状态文件改为 `~/.dsh/dsh-whale-purse.{settings,holidays}.json`（旧文件已就地迁移，配置不丢）
- 不变：HTTP 路由仍是 `/api/whale-purse/*`，客户端 i18n 命名空间与 CSS 前缀仍是 `whale-purse.*` / `.wp-*`

### 0.2.0（2026-09-21）规范对齐

- **安全**：路由从 `ctx.webServer` 裸路由改挂 `connection` 的 exact Fetch 路由表，回到浏览器认证 + Host/Origin 围栏之内（此前 `/api/whale-purse/*` 未认证即可读写）；`inject` 改为 `['connection','sessions']`
- **配置契约**：新增 `lib/config.js`（Standard Schema v1），全部可调参数集中校验并补默认值，非法值加载期报错；新增 `pricingUrl` / `holidayDataUrls` / `requestTimeoutMs` / `statePath` / `holidayCachePath`
- **生命周期**：构造函数去副作用，后台刷新由 `ctx.effect` 启停；外部请求带 `AbortController`，`dispose()` 停表 → 中止在途 → 等待收敛
- **依赖声明**：`credentials` / `launchEnvironment` / `sessionProjections` / `sessionPersistence` 四个可选缝改用 `ctx.inject` 绑定与自动解绑，去掉运行时 `ctx.get()` 探测
- **打包**：补 `dsh.bundle` / `dsh.engines` / `files` / `peerDependencies` 与 `npm test`；修正 `dsh.client.inject` 里两个并不存在的包名
- **清理 / 测试**：移除失效的 `/api/balance` 回退与常驻调试钩子（改为仅 `?whale-debug`）；新增 `scripts/plugin-test.mjs`，smoke test 增加配置 schema 用例

### 2026-09-20 节假日数据自动更新

- 中国法定节假日/调休数据每 6h 自动抓取（holiday-cn，jsdelivr 优先 / `raw.githubusercontent` 备用，抓「今年 ±1 年」），落盘缓存，抓取失败保持原数据
- 新增 `makeupWorkdaysArePeak` 开关（默认 `false`）：调休上班日全部落在周末，默认按脚注字面口径算空闲，置 `true` 则按工作日计高峰
- 新增 26 条测试（年份 JSON 解析、多源回退、空占位年份、坏数据、并入语义、缓存缺失、开关透传到计价）

### 2026-09-20 峰谷口径补中国法定节假日

- 高峰判定补上「不含中国法定节假日」：此前元旦/春节/国庆等落在工作日会被按 2 倍高峰价多收
- 新增 2026 年 7 组放假共 33 天（`CN_HOLIDAY_RANGES`）与跨假期跳转的切换点计算
- 兼容官方页 2026-09 改版后的表头（`deepseek-flash` 与旧名 `deepseek-v4-flash`、`deepseek-flash(1)` 脚注标记）

### 2026-09-10 Flash 降价 + 价格时代

- Flash 降价生效（谷价 0.02 / 1 / 4 元，高峰为其 2 倍）；新增价格时代记账与 `proBilledAsFlash` 开关
- 修复：定价页解析失效（`<br>` 变空格导致锚点失配）、写死列号导致串价、官方页未更新时把新价倒灌回旧价
- 修复：新版 DSH 会话 API 漂移（`snapshotEvents()` / `sessions.list` 快照 store），此前会导致提问明细恒空、跨峰谷切换时花费凭空翻倍

### 2026-08-28

- 分支会话 checkout 出的 seed 不再重复计费；非 DeepSeek 模型不再被误按 flash/pro 记账
- 条形图改按金额占比绘制并标注占比，移除 DeepSeek 不存在的「缓存写入」桶
- 新增 `scripts/smoke-test.mjs` 冒烟测试

## 素材来源与版权

- 鲸鱼娘立绘来自 [dafeiyu-pet](https://github.com/1190fasheqi/dafeiyu-pet)（MIT License），是 DeepSeek 鲸鱼形象的二创桌宠。
- 本项目为 DeepSeek / DSH 的**非官方**插件，与 DeepSeek 官方无关联。

## License

[MIT](LICENSE)
