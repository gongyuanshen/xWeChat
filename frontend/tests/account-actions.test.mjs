import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../components/SidebarRail.vue', import.meta.url), 'utf8')
const readHandler = source.slice(source.indexOf('const loadAccountInfo ='), source.indexOf('const openAccountDialog ='))
const deleteHandler = source.slice(source.indexOf('const deleteCurrentAccountData ='), source.indexOf('</script>'))

const setup = (overrides = {}) => {
  const calls = []
  const context = {
    process: { client: true }, selectedAccount: { value: 'account-a' },
    accountInfo: { value: null }, accountInfoLoading: { value: false }, accountInfoError: { value: '' },
    accountDialogOpen: { value: true }, accountDeleteLoading: { value: false }, accountDeleteError: { value: '' },
    window: { confirm: () => true, wechatDesktop: {
      getAccountInfo: () => { calls.push('desktop-read'); return { status: 'success' } },
      deleteAccountData: () => { calls.push('desktop-delete'); return { status: 'success' } }
    } },
    chatAccounts: { ensureLoaded: async () => { calls.push('reload') } },
    navigateTo: async () => { calls.push('navigate') },
    ...overrides
  }
  vm.createContext(context)
  vm.runInContext(`${readHandler}\n${deleteHandler}`, context)
  return { context, calls, run: (name) => vm.runInContext(`${name}()`, context) }
}

test('account info HTTP failures stay visible and a later request uses the restored API', async () => {
  let count = 0
  const { context, calls, run } = setup({ getChatAccountInfo: async () => {
    count += 1
    if (count === 1) throw Object.assign(new Error('账号不存在'), { status: 404 })
    return { status: 'success', account: 'account-a', database_count: 2 }
  } })
  await run('loadAccountInfo')
  assert.equal(context.accountInfoError.value, '账号不存在')
  assert.equal(context.accountInfo.value, null)
  await run('loadAccountInfo')
  assert.equal(count, 2)
  assert.equal(context.accountInfoError.value, '')
  assert.equal(context.accountInfo.value.database_count, 2)
  assert.deepEqual(calls, [])
})

test('failed deletion does not invoke desktop deletion, close the dialog, or navigate', async () => {
  const { context, calls, run } = setup({ deleteChatAccount: async () => {
    throw Object.assign(new Error('账号仍有任务运行'), { status: 409 })
  } })
  await run('deleteCurrentAccountData')
  assert.equal(context.accountDeleteError.value, '账号仍有任务运行')
  assert.equal(context.accountDialogOpen.value, true)
  assert.equal(context.accountDeleteLoading.value, false)
  assert.deepEqual(calls, [])
})

test('empty deletion responses cannot become successful deletions', async () => {
  for (const result of [undefined, null, {}, { status: 'error', message: '删除失败' }]) {
    const { context, calls, run } = setup({ deleteChatAccount: async () => result })
    await run('deleteCurrentAccountData')
    assert.match(context.accountDeleteError.value, /删除.*失败/)
    assert.equal(context.accountDialogOpen.value, true)
    assert.deepEqual(calls, [])
  }
})

test('confirmed backend deletion refreshes accounts and returns to the guide', async () => {
  const { context, calls, run } = setup({ deleteChatAccount: async () => ({ status: 'success' }) })
  await run('deleteCurrentAccountData')
  assert.equal(context.accountDeleteError.value, '')
  assert.equal(context.accountDialogOpen.value, false)
  assert.deepEqual(calls, ['reload', 'navigate'])
})
