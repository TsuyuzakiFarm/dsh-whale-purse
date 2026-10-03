/**
 * 截取悬浮球 + 面板高清图，供 kimi_vision 查看。
 *
 * 依赖解析是可移植的：`playwright-core`（或 `playwright`）按裸包名解析，
 * 浏览器可执行文件优先用 playwright 自己登记的那一份，其次读
 * `DSH_SCREENSHOT_BROWSER` 覆盖。**不要**把 npx 缓存目录或某台机器的
 * 绝对路径写死——npx 的缓存目录名是内容哈希，重装一次就变；写死的
 * 绝对路径在别的机器上必然失效（旧版本正是这样，已经跑不起来）。
 *
 * 用法：
 *   node scripts/screenshot.mjs
 *   DSH_SCREENSHOT_URL=http://127.0.0.1:3080/ DSH_SCREENSHOT_BROWSER=/path/to/chrome node scripts/screenshot.mjs
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 页面地址与产物目录（可用环境变量覆盖）。 */
const TARGET_URL = process.env.DSH_SCREENSHOT_URL || 'http://127.0.0.1:3080'
const OUT_DIR = process.env.DSH_SCREENSHOT_OUT || './verify-out'

/**
 * 按裸包名解析 playwright 的浏览器自动化实现，二选一。
 * @returns {Promise<any>} 含 `chromium` 的模块。
 */
async function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const tried = []
  for (const name of ['playwright-core', 'playwright']) {
    try {
      return await import(pathToFileURL(require.resolve(name)).href)
    } catch (error) {
      tried.push(`${name} (${error?.code ?? error?.message})`)
    }
  }
  throw new Error(
    `找不到 playwright。请先 npm i -D playwright-core 或设置 NODE_PATH：${tried.join(' / ')}`,
  )
}

/**
 * 选浏览器可执行文件：显式覆盖 → playwright 登记的那一份 → 交给 playwright 自行探测。
 * @param {any} chromium - playwright 的 chromium 入口。
 * @returns {string | undefined} 可执行文件路径。
 */
function resolveExecutable(chromium) {
  if (process.env.DSH_SCREENSHOT_BROWSER) return process.env.DSH_SCREENSHOT_BROWSER
  try {
    const registered = chromium.executablePath()
    if (typeof registered === 'string' && registered !== '') return registered
  } catch {
    /* 未安装浏览器时交由 launch 自己报错，错误信息更准确 */
  }
  return undefined
}

const { chromium } = await loadPlaywright()
mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  ...(resolveExecutable(chromium) === undefined ? {} : { executablePath: resolveExecutable(chromium) }),
  args: ['--headless=new'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 })
page.setDefaultTimeout(90_000)

try {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' })
  const ball = page.getByTestId('whale-purse-ball')
  await ball.waitFor({ state: 'visible', timeout: 60_000 })
  // 等余额加载出来
  await page.waitForTimeout(4000)
  await ball.screenshot({ path: `${OUT_DIR}/ball-closeup.png` })

  // 点开面板截图
  await ball.click()
  const panel = page.getByTestId('whale-purse-panel')
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(1500)
  await panel.screenshot({ path: `${OUT_DIR}/panel-closeup.png` })

  console.log(`screenshots saved to ${OUT_DIR}`)
} catch (e) {
  console.log('ERROR:', e instanceof Error ? e.message : String(e))
} finally {
  await browser.close()
}
