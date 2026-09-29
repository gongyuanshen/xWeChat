// 在独立数据目录启动真实 Electron；仅使用样例数据，不调用远程模型。
const { parseArgs } = require('node:util')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { values } = parseArgs({ options: {
  output: { type: 'string' }, data: { type: 'string' }, playwright: { type: 'string' },
  electron: { type: 'string' }, port: { type: 'string', default: '10492' },
  'static-ui': { type: 'boolean', default: false },
  fixture: { type: 'string' },
} })
if (!values.output || !values.data) throw new Error('请指定独立 --data 样例目录及新的 --output 结果目录')
const root = path.resolve(__dirname, '..')
const data = path.resolve(values.data)
const output = path.resolve(values.output)
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效端口')
const { _electron } = require(values.playwright || 'playwright')

async function main() {
  // 不允许复用上次结果；包裹入口只设置隔离目录，实际加载项目原生主进程。
  await fs.access(path.join(data, 'output', 'databases', 'wxid_ai_acceptance'))
  await fs.mkdir(output, { recursive: false })
  const userData = path.join(output, 'electron-user-data')
  await fs.mkdir(userData)
  const wrapper = path.join(output, 'launch.cjs')
  await fs.writeFile(wrapper, `globalThis.__acceptanceRequire=require;const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});require(${JSON.stringify(path.join(root, 'desktop/src/main.cjs'))});\n`)
  const result = { mode: 'native_electron_synthetic_data', platform: process.platform, arch: process.arch,
    started: new Date().toISOString(), sourceRoot: root, dataDir: data, remote_model_calls: 0,
    real_ime: 'not_verified', real_model: 'not_verified', checks: [], errors: [] }
  let app, page
  const log = []
  try {
    app = await _electron.launch({
      executablePath: values.electron || require(path.join(root, 'desktop/node_modules/electron')),
      args: [wrapper], cwd: path.join(root, 'desktop'), timeout: 120000,
      env: { ...process.env, WECHAT_TOOL_DATA_DIR: data, WECHAT_TOOL_OUTPUT_DIR: path.join(data, 'output'),
        WECHAT_TOOL_PORT: String(port), ELECTRON_START_URL: `http://127.0.0.1:${port}/chat`,
        WECHAT_TOOL_STATIC_UI: values['static-ui'] ? '1' : '0',
        WECHAT_TOOL_BACKEND_STARTUP_TIMEOUT_MS: '120000', PYTHONIOENCODING: 'utf-8' },
    })
    const proc = app.process()
    proc.stdout?.on('data', chunk => log.push(chunk.toString()))
    proc.stderr?.on('data', chunk => log.push(chunk.toString()))
    page = await app.firstWindow({ timeout: 120000 })
    page.on('pageerror', error => result.errors.push(error.message))
    page.setDefaultTimeout(30000)
    const capture = async name => {
      await page.screenshot({ path: path.join(output, name + '.png') })
      result.checks.push(name)
    }
    await page.getByRole('button', { name: '我已阅读全部内容并同意', exact: true }).click({ timeout: 120000 })
    if (values['static-ui']) await page.goto(`http://127.0.0.1:${port}/chat`)
    await page.getByRole('heading', { name: '验收 · 海桥项目', exact: true, level: 2 }).waitFor()
    await capture('electron-chat-loaded')
    await page.getByLabel('AI 助手', { exact: true }).click()
    const input = page.getByLabel('给 AI 助手的消息')
    await input.fill('跨群检索：只查看本周的报价\n这是一条保留中的草稿')
    await page.getByRole('heading', { name: '验收 · 小林', exact: true, level: 3 }).click()
    assert.equal(await input.inputValue(), '跨群检索：只查看本周的报价\n这是一条保留中的草稿')
    await capture('electron-chat-switch-draft')
    // 真实隐藏和重新显示窗口，检查窗口返回后页面、输入及实例身份。
    const windowId = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      win.hide()
      return win.id
    })
    await new Promise(resolve => setTimeout(resolve, 800))
    await app.evaluate(({ BrowserWindow }, id) => {
      const win = BrowserWindow.fromId(id)
      if (!win) throw new Error('窗口返回时原实例已丢失')
      win.show(); win.focus()
    }, windowId)
    assert.equal(await input.inputValue(), '跨群检索：只查看本周的报价\n这是一条保留中的草稿')
    assert.equal(await input.isVisible(), true)
    await capture('electron-window-return')
    await input.fill('第一行')
    await input.press('End')
    await input.press('Shift+Enter')
    await input.pressSequentially('second line')
    assert.equal(await input.inputValue(), '第一行\nsecond line')
    await capture('electron-multiline-input')
    await page.getByLabel('更多 AI 功能').click()
    await page.getByRole('button', { name: '工具与任务', exact: true }).click()
    await page.getByText('关注提醒', { exact: true }).waitFor()
    await capture('electron-existing-tools')
    // 用正式设置入口检查全账号文案、两种主题与重开后的栏目同步。
    const openSettings = () => page.getByTitle('设置', { exact: true }).click()
    const closeSettings = () => page.getByTitle('关闭设置', { exact: true }).click()
    const settingsPanel = page.locator('.settings-dialog-panel')
    const header = settingsPanel.locator('header h2')
    const openGlobalSearch = async () => {
      await settingsPanel.getByRole('button', { name: 'AI 服务', exact: true }).click()
      await header.getByText('AI 服务', { exact: true }).waitFor()
      await settingsPanel.getByRole('tab', { name: /^本地检索/ }).click()
      const globalHeading = settingsPanel.getByRole('heading', { name: '当前账号全部群聊和私聊', exact: true })
      await globalHeading.waitFor()
      // DOM 存在不能证明截图里可见；正式覆盖说明必须滚动进入视口。
      await globalHeading.scrollIntoViewIfNeeded()
      assert.equal(await globalHeading.isVisible(), true)
      assert.equal(await settingsPanel.getByRole('button', { name: '选择聊天', exact: true }).count(), 0)
      assert.equal(await settingsPanel.getByRole('button', { name: '调整聊天', exact: true }).count(), 0)
    }
    await openSettings()
    await openGlobalSearch()
    await capture('electron-global-search-settings')
    await closeSettings()
    await openSettings()
    await header.getByText('桌面行为', { exact: true }).waitFor()
    await capture('electron-settings-reopened')
    await closeSettings()
    const darkToggle = page.getByTitle('切换深色模式', { exact: true })
    if (await darkToggle.count()) await darkToggle.click()
    await openSettings()
    await openGlobalSearch()
    const background = await settingsPanel.evaluate(el => getComputedStyle(el).backgroundColor)
    assert.notEqual(background, 'rgb(255, 255, 255)', '深色设置面板不能仍为白底')
    result.settings_dark_background = background
    await capture('electron-global-search-dark')
    await closeSettings()
    await page.goto(`http://127.0.0.1:${port}/sns`)
    await page.getByText('本地验收示例：今天已完成排期确认，接下来核对交付内容。', { exact: true }).waitFor()
    await capture('electron-moments')
    if (values.fixture) {
      // 明确标记的组件样例用于桌面引用状态验收，不计真实模型或真实聊天回答。
      result.answer_mode = 'explicit_component_fixture'
      await page.goto(values.fixture)
      await page.getByLabel('调整 AI 助手宽度').press('Home')
      assert.equal(Math.round(await page.locator('.agent-panel').evaluate(el => el.getBoundingClientRect().width)), 320)
      await capture('electron-d01-answer-sidebar')
      await page.locator('.agent-final-answer').getByLabel('查看来源 1', { exact: true }).click()
      await page.getByRole('dialog', { name: '消息来源预览' }).waitFor()
      await capture('electron-d03-source')
      await page.getByLabel('关闭来源预览').click()
      await page.getByRole('button', { name: '深色', exact: true }).click()
      await page.getByLabel('展开大视图').click()
      await capture('electron-d02-answer-expanded-dark')
      await page.getByLabel('复制回答', { exact: true }).click()
      await page.getByLabel('已复制回答', { exact: true }).waitFor()
      const copiedText = await app.evaluate(({ clipboard }) => clipboard.readText())
      assert.ok(copiedText.length > 10, '桌面剪贴板应包含实际回答')
      const fixtureInput = page.getByLabel('给 AI 助手的消息')
      await fixtureInput.fill('')
      await fixtureInput.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
      assert.equal(await fixtureInput.inputValue(), copiedText)
      result.native_clipboard = { matched: true, characters: copiedText.length }
      await capture('electron-answer-copy-paste')
      await fixtureInput.fill('')
      await page.goto(values.fixture + '?references=1')
      await page.getByRole('button', { name: '排期示意图', exact: true }).click()
      const picture = page.locator('.agent-image-stage img')
      await picture.waitFor()
      await picture.evaluate(img => img.decode())
      await page.getByLabel('放大图片').click()
      await page.getByLabel('旋转图片').click()
      assert.match(await picture.getAttribute('style'), /rotate\(90deg\).*scale\(1.25\)/)
      await capture('electron-d04-image-light')
      await page.getByLabel('下一张图片').click()
      await page.getByText('图片暂不可用，可定位原消息核对。').waitFor()
      assert.match(await page.locator('.agent-image-viewer').textContent(), /图片 2 \/ 2/)
      await capture('electron-d04-image-missing')
      await page.getByLabel('关闭图片查看器').click()
      await page.getByRole('button', { name: '深色', exact: true }).click()
      await page.getByRole('button', { name: '排期示意图', exact: true }).click()
      await capture('electron-d04-image-dark')
      await page.goto(`http://127.0.0.1:${port}/sns`)
      await page.getByText('本地验收示例：今天已完成排期确认，接下来核对交付内容。', { exact: true }).waitFor()
    }
    result.hung_navigation = await app.evaluate(async ({ BrowserWindow }, projectRoot) => {
      // Playwright 的求值环境没有模块级 require，由隔离验收入口提供。
      const loadModule = globalThis.__acceptanceRequire
      const http = loadModule('node:http')
      const { loadWithRedirect } = loadModule(loadModule('node:path').join(projectRoot, 'desktop/src/renderer-startup.cjs'))
      let requests = 0
      const sockets = new Set()
      // 建立真实连接但不返回 HTTP 响应，复现开发服务卡住的状态。
      const server = http.createServer(() => { requests++ })
      server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      const originalUrl = win.webContents.getURL()
      const started = Date.now()
      let code = ''
      try { await loadWithRedirect(win, `http://127.0.0.1:${server.address().port}/`, 5000, 1000) }
      catch (error) { code = error.code }
      finally {
        for (const socket of sockets) socket.destroy()
        await new Promise(resolve => server.close(resolve))
      }
      const elapsed = Date.now() - started
      await win.loadURL(originalUrl)
      return { code, requests, elapsed_ms: elapsed }
    }, root)
    assert.equal(result.hung_navigation.code, 'ERR_NAVIGATION_TIMEOUT')
    assert.ok(result.hung_navigation.requests > 0)
    assert.ok(result.hung_navigation.elapsed_ms < 5000)
    await page.getByText('本地验收示例：今天已完成排期确认，接下来核对交付内容。', { exact: true }).waitFor()
    await capture('electron-hung-page-recovery')
    result.runtime = await app.evaluate(({ app }) => ({ electron: process.versions.electron,
      chrome: process.versions.chrome, userData: app.getPath('userData'), packaged: app.isPackaged }))
    assert.equal(result.runtime.userData, userData)
    assert.deepEqual(result.errors, [])
    result.passed = true
  } catch (error) {
    result.passed = false
    result.failure = error.stack
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    if (app) {
      // 启动错误的原生对话框可能阻塞正常退出，仅终止本次验收创建的进程。
      const proc = app.process()
      const timeout = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      }, 8000)
      try { await app.close().catch(error => log.push('close: ' + error.message)) }
      finally { clearTimeout(timeout) }
    }
    result.finished = new Date().toISOString()
    await fs.writeFile(path.join(output, 'electron.log'), log.join(''))
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
