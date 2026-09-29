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
test('媒体设置挂载于设置页，保留原图开关和真实接口', () => {
  const settings = readFileSync(new URL('components/SettingsDialog.vue', root), 'utf8')
  assert.match(settings, /<MediaDownloadSettings :account="keySelectedAccount"/)
  assert.match(settings, /@click="toggleCdnImage"/)
  const api = readFileSync(new URL('composables/useApi.js', root), 'utf8')
  for (const route of ['/cdn/plan', '/cdn/connect', '/cdn/redeem']) assert.ok(api.includes(route))
})
