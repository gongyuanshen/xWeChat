import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const sources = directory => readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap(entry => {
  const path = `${directory}/${entry.name}`
  return entry.isDirectory() ? sources(path) : /\.(vue|js|ts|css)$/.test(path) ? [path] : []
})
test('应用源码无推广入口、演示钩子和官网演示依赖', () => {
  const files = ['app.vue', 'nuxt.config.ts', ...['components', 'composables', 'stores', 'lib', 'pages', 'assets/css'].flatMap(sources)]
  for (const file of files) {
    const text = readFileSync(new URL(file, root), 'utf8')
    for (const symbol of ['AdvancedFeaturesDialog', 'PlanWindow', 'developer-support', '__pwMock', '@website', 'wxcdn-card', 'openFeatureUnavailableDialog', 'qm.qq.com', 'chat-composer']) {
      assert.equal(text.includes(symbol), false, `${file} 仍引用 ${symbol}`)
    }
  }
})
test('设置和请求层不再暴露原项目媒体服务与更新入口', () => {
  const settings = readFileSync(new URL('components/SettingsDialog.vue', root), 'utf8')
  for (const symbol of ['MediaDownloadSettings', 'toggleCdnImage', 'useDesktopUpdate']) {
    assert.equal(settings.includes(symbol), false, `设置页仍包含 ${symbol}`)
  }
  const api = readFileSync(new URL('composables/useApi.js', root), 'utf8')
  for (const route of ['/cdn/plan', '/cdn/connect', '/cdn/redeem', '/system/cdn_image']) {
    assert.equal(api.includes(route), false, `请求层仍包含 ${route}`)
  }
})

test('桌面入口没有原项目更新请求或安装通道', () => {
  for (const file of ['../desktop/src/main.cjs', '../desktop/src/preload.cjs', 'app.vue']) {
    const text = readFileSync(new URL(file, root), 'utf8')
    for (const symbol of ['autoUpdater', 'checkForUpdates', 'downloadAndInstall', 'installUpdate', 'DesktopUpdateDialog']) {
      assert.equal(text.includes(symbol), false, `${file} 仍包含 ${symbol}`)
    }
  }
  const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', root), 'utf8'))
  assert.equal(pkg.dependencies['electron-updater'], undefined)
  assert.equal(pkg.build.publish, undefined)
})

test('清理演示样式后保留公共导航图标及选中态', () => {
  const sidebar = readFileSync(new URL('components/SidebarRail.vue', root), 'utf8')
  assert.match(sidebar, /\.sidebar-rail-icon\s*\{[^}]*var\(--sidebar-rail-icon-color\)/)
  assert.match(sidebar, /\.sidebar-rail-icon-active\s*\{[^}]*var\(--sidebar-rail-icon-active-color\)/)
})
