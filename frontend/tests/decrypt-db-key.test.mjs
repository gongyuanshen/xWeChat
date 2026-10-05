import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../pages/decrypt.vue', import.meta.url), 'utf8')
const start = source.indexOf('const formatDbKeyError =')
const handlerStart = source.indexOf('const handleGetDbKey =')
const end = source.indexOf('\nconst applyManualKeys', handlerStart)
const handler = source.slice(start < 0 ? handlerStart : start, end)
const dbPath = 'D:\\xwechat_files\\wxid_test\\db_storage'
const key = 'a'.repeat(64)

async function run({ path = dbPath, response, failure } = {}) {
  const calls = [], dialogs = []
  const context = {
    platformCapabilitiesLoaded: { value: true }, platformCapabilitiesError: { value: '' },
    isGettingDbKey: { value: false }, dbKeyRequestRevision: 0, dbKeyRequestController: null,
    error: { value: '' }, warning: { value: '' }, formErrors: {},
    formData: { key: '', db_storage_path: path, wechat_install_path: '' },
    AbortController, setTimeout: () => {}, console: { error: () => {} },
    normalizeWechatInstallPath: value => value, readStoredWechatInstallPath: () => '',
    requestGuideDialog: async options => { dialogs.push(options); return true },
    isDbKeyRequestActive: (revision, controller) => revision === context.dbKeyRequestRevision && !controller.signal.aborted,
    getKeys: async params => {
      calls.push(params.key_mode)
      if (failure) throw failure
      return response || { status: 0, data: { db_key: key, method: 'pure_memory' } }
    },
  }
  vm.createContext(context)
  await vm.runInContext(`${handler}\nhandleGetDbKey()`, context)
  return { ...context, calls, dialogs }
}

test('offline requires an explicit db_storage directory before any scanner or Hook request', async () => {
  for (const path of ['', 'db_storage', 'D:relative\\db_storage', 'D:\\xwechat_files\\wxid_test']) {
    const result = await run({ path })
    assert.deepEqual(result.calls, [])
    assert.equal(result.dialogs.length, 0)
    assert.match(result.formErrors.db_storage_path, /db_storage/)
  }
})

test('offline explicitly requests pure_memory and describes verified pure source scanning', async () => {
  const result = await run({ response: { status: 0, data: { method: 'pure_memory', db_key: key } } })
  assert.deepEqual(result.calls, ['pure_memory'])
  assert.equal(result.formData.key, key)
  assert.match(result.warning.value, /纯源码.*验证/)
  assert.doesNotMatch(JSON.stringify(result.dialogs), /Hook|重启/)
})

test('offline rejects native key_v4 and Hook successes without applying a key', async () => {
  for (const method of ['key_v4', 'hook']) {
    const result = await run({ response: { status: 0, data: { method, db_key: key } } })
    assert.equal(result.formData.key, '')
    assert.match(result.error.value, /方法/)
    assert.equal(result.warning.value, '')
  }
})

test('absolute db_storage directories are accepted at a drive root and with trailing separators', async () => {
  for (const path of ['D:\\db_storage', `${dbPath}\\`]) {
    const result = await run({ path })
    assert.equal(result.formData.key, key)
    assert.deepEqual(result.calls, ['pure_memory'])
  }
})

test('offline scan failure cannot opt into Hook even when a response advertises it', async () => {
  const result = await run({ response: { status: -1, errmsg: 'scan failed', data: { can_fallback_to_hook: true } } })
  assert.deepEqual(result.calls, ['pure_memory'])
  assert.match(result.error.value, /scan failed/)
  assert.equal(result.dialogs.length, 1)
  assert.doesNotMatch(JSON.stringify(result.dialogs), /Hook/)
})

test('backend structured failure details remain readable', async () => {
  const failure = Object.assign(new Error('fetch failed'), { data: { detail: { code: 'KEY_SCAN_FAILED', message: '未找到经过认证的密钥' } } })
  const result = await run({ failure })
  assert.match(result.error.value, /KEY_SCAN_FAILED.*未找到经过认证的密钥/)
  assert.doesNotMatch(result.error.value, /\[object Object\]/)
  assert.deepEqual(result.calls, ['pure_memory'])
})

test('unknown success methods and missing keys remain errors without applying a key', async () => {
  for (const data of [{ method: 'unrecognized', db_key: key }, { method: 'pure_memory' }]) {
    const result = await run({ response: { status: 0, data } })
    assert.equal(result.formData.key, '')
    assert.match(result.error.value, /方法|密钥/)
    assert.equal(result.warning.value, '')
  }
})
