# whale-purse

DeepSeek Harness 的鲸鱼娘桌宠插件：显示 DeepSeek 账户余额 + 当前会话用量/花费，透明立绘悬浮、可拖拽、点击开面板。

## 技术栈

- 语言：纯 ES（无构建步骤），服务端纯 ESM cordis 插件，浏览器端经 `window.__ModuleLoader__` 注入
- 框架：React（经 require 种子词注入）、cordis（DSH 组合层）
- 素材：dafeiyu-pet 鲸鱼娘立绘（base64 内联）

## 开发

```bash
# 安装进 DSH web profile（组合包形态，推荐；包内自带 cordis.patch.yml 层）
dsh plugin --profile web add "$(pwd)"

# 或临时软链 + 手写 insert（见 README.md），保存即热重载；刷新浏览器：Cmd+Shift+R

# 测试：模型识别/计价 + 配置 schema + 插件契约（假 cordis 上下文驱动真实模块）
npm test
```

## 注意

- 立绘 base64 内联在 `lib/client.js` 里（WebP，约 100KB），改动后刷新浏览器即可生效，无需构建。
- 立绘素材以 `assets/whale-sprite.webp` 为准；改动素材后运行 `npm run embed`（或 `node scripts/embed-asset.mjs`）重新内联。
- 服务端 `lib/index.js` 改动需重启 DSH 进程才完全生效（客户端有兜底）。
- 可调参数一律进 `lib/config.js` 的 schema（默认值 + 范围），别在代码里写死；非法配置必须在加载期报错。
- HTTP 路由只许注册到 `ctx.connection.fetch`（`/api` 通道，带浏览器认证 + Host/Origin 围栏）；不要用 `ctx.webServer.register()` 直挂裸路由。
- 外部资源（定时器、在途请求）走 `ctx.effect`，卸载时中止并等待收敛；可选服务用 `ctx.inject` 绑定，不要用 `ctx.get` 探测。
- 截图脚本 `scripts/screenshot.mjs` 依赖本机 playwright-core 缓存路径，仅本地调试用。
