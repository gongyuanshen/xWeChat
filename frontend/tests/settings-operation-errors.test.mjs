import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../components/SettingsDialog.vue', import.meta.url), 'utf8')
const handler = (name) => {
  const start = source.indexOf(`const ${name} =`)
  assert.notEqual(start, -1)
  return source.slice(start, source.indexOf('\nconst ', start + 1))
}
const field = (value = '') => ({ value })

for (const [name, arg, setter, refresh, errorKey] of [
  ['setDesktopAutoLaunch', true, 'setAutoLaunch', 'refreshDesktopAutoLaunch', 'desktopAutoLaunchError'],
  ['setDesktopCloseBehavior', 'exit', 'setCloseBehavior', 'refreshDesktopCloseBehavior', 'desktopCloseBehaviorError'],
  ['setMcpLanAccess', true, 'setMcpLanAccess', 'refreshMcpLanAccess', 'mcpLanAccessError'],
  ['applyDesktopOutputDir', 'D:/output', 'setOutputDir', 'refreshDesktopOutputDir', 'desktopOutputDirError'],
  ['applyDesktopBackendPort', undefined, 'setBackendPort', 'refreshDesktopBackendPort', 'desktopBackendPortError'],
  ['setVoiceDevice', 'cpu', 'setVoiceTranscriptionDevice', 'refreshVoiceTranscriptionStatus', 'voiceDeviceError'],
]) {
  test(`${name} keeps the save failure after refreshing the previous setting`, async () => {
    let reads = 0
    const context = { process: { client: true }, window: { wechatDesktop: {} }, api: {}, arg,
      desktopAutoLaunch: field(false), desktopAutoLaunchLoading: field(false),
      desktopCloseBehavior: field('tray'), desktopCloseBehaviorLoading: field(false),
      mcpLanAccessEnabled: field(false), mcpLanAccessLoading: field(false), mcpLanAccessMessage: field(),
      desktopOutputDirCanChange: field(true), desktopOutputDirApplying: field(false),
      desktopOutputDirMessage: field(), desktopOutputDirProgress: field(null),
      desktopBackendPortInput: field('10393'), desktopBackendPortApplying: field(false),
      voiceDeviceBusy: field(false), voiceDeviceLocked: field(false), voiceCudaAvailable: field(false),
      [errorKey]: field(),
    }
    const fail = async () => { throw new Error('保存失败：权限不足') }
    context.window.wechatDesktop[setter] = fail
    context.api[setter] = fail
    context[refresh] = async () => { reads += 1; context[errorKey].value = '' }
    vm.createContext(context)
    await vm.runInContext(`${handler(name)}\n${name}(arg)`, context)
    assert.equal(reads, 1)
    assert.equal(context[errorKey].value, '保存失败：权限不足')
  })
}

test('output directory changes require a positive desktop receipt', async () => {
  for (const result of [undefined, {}, { success: false, error: '移动失败' }]) {
    const context = { process: { client: true }, window: { wechatDesktop: { setOutputDir: async () => result } },
      desktopOutputDirCanChange: field(true), desktopOutputDirApplying: field(false),
      desktopOutputDirError: field(), desktopOutputDirMessage: field(), desktopOutputDirProgress: field(null),
      refreshDesktopOutputDir: async () => { context.desktopOutputDirError.value = '' }
    }
    vm.createContext(context)
    await vm.runInContext(`${handler('applyDesktopOutputDir')}\napplyDesktopOutputDir('D:/output')`, context)
    assert.match(context.desktopOutputDirError.value, /失败/)
    assert.equal(context.desktopOutputDirMessage.value, '')
  }
})

test('port read failures remain visible without filling a guessed default', async () => {
  const context = { process: { client: true }, window: {}, desktopBackendPortLoading: field(false),
    desktopBackendPortError: field(), desktopBackendPortInput: field(), desktopBackendPortDefault: field(10392),
    fetchAdminEndpoint: async () => { throw new Error('后端连接失败') }
  }
  vm.createContext(context)
  await vm.runInContext(`${handler('refreshDesktopBackendPort')}\nrefreshDesktopBackendPort()`, context)
  assert.equal(context.desktopBackendPortError.value, '后端连接失败')
  assert.equal(context.desktopBackendPortInput.value, '')
})

test('MCP clipboard denial reports an error and cannot display copied state', async () => {
  const errors = []
  const context = { process: { client: true }, window: {},
    navigator: { clipboard: { writeText: async () => { throw new Error('剪贴板权限被拒绝') } } },
    mcpCopiedKey: field('token'), mcpCopiedTimer: null, showErrorAlert: error => errors.push(error)
  }
  vm.createContext(context)
  await vm.runInContext(`${handler('copyMcpText')}\ncopyMcpText('token', 'example')`, context)
  assert.equal(context.mcpCopiedKey.value, '')
  assert.deepEqual(errors, ['复制失败：剪贴板权限被拒绝'])
})
