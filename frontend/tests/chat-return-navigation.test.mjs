import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createAiNavigationConsumer } from '../utils/createAiNavigationConsumer.js'

const root = process.env.CHAT_RETURN_SOURCE_ROOT || new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, typeof root === 'string' ? `file:///${root.replaceAll('\\', '/')}/` : root), 'utf8')
const chat = read('pages/chat/[[username]].vue')
const wrapped = read('pages/wrapped/index.vue')

async function selectRoute({ requested = '', selected = 'group@chatroom', active = true } = {}) {
  const selections = [], paths = []
  const contacts = [{ username: 'first' }, { username: 'group@chatroom' }, { username: 'friend' }]
  const source = chat.slice(chat.indexOf('const applyRouteSelection ='), chat.indexOf('const searchState ='))
  const state = { value: contacts.find(contact => contact.username === selected) || null }
  const context = {
    chatPageActive: { value: active },
    routeUsername: { value: requested },
    contacts: { value: contacts }, selectedContact: state,
    buildChatPath: username => `/chat/${encodeURIComponent(username)}`,
    navigateTo: async (path, options) => paths.push({ path, options }),
    buildTransientContact: ({ username }) => ({ username }),
    selectContact: async contact => { state.value = contact; selections.push(contact.username) },
  }
  await vm.runInNewContext(`${source}\napplyRouteSelection()`, context)
  return { selected: state.value?.username, selections, paths }
}

test('返回聊天根路径保留当前会话且不重新加载消息', async () => {
  const result = await selectRoute()
  assert.equal(result.selected, 'group@chatroom')
  assert.deepEqual(result.selections, [])
  assert.equal(result.paths[0].path, '/chat/group%40chatroom')
  assert.equal(result.paths[0].options.replace, true)
})

test('首次打开仍选择首个会话，显式会话链接优先', async () => {
  assert.equal((await selectRoute({ selected: '' })).selected, 'first')
  assert.equal((await selectRoute({ requested: 'friend' })).selected, 'friend')
})

test('缓存的聊天页不处理其他页面的路由变化', async () => {
  const result = await selectRoute({ active: false, requested: 'friend' })
  assert.equal(result.selected, 'group@chatroom')
  assert.deepEqual(result.paths, [])
  assert.deepEqual(result.selections, [])
})

test('年度总结返回实际来源页，直接打开时回聊天', async () => {
  const start = wrapped.indexOf('async function goBack()')
  assert.ok(start >= 0, '年度总结必须保留返回入口')
  const source = wrapped.slice(start, wrapped.indexOf('const detailTitle =', start))
  for (const back of ['/chat/group%40chatroom', '/contacts', null]) {
    const calls = []
    const router = { options: { history: { state: { back } } }, back: () => calls.push('back'), push: async path => calls.push(path) }
    await vm.runInNewContext(`${source}\ngoBack()`, { router })
    assert.deepEqual(calls, [back ? 'back' : '/chat'])
  }
})

test('Nuxt稳定缓存一个聊天页实例，年度总结保持正常卸载', () => {
  assert.match(read('app.vue'), /<NuxtPage\s+:keepalive="\{\s*include:\s*\['ChatPage'\],\s*max:\s*1\s*\}"\s*\/>/)
  assert.match(chat, /defineOptions\(\{\s*name:\s*'ChatPage'\s*\}\)/)
})

test('聊天视图离开时停用全局快捷键，回来恢复滚动且不重复注册监听', async () => {
  const source = chat.slice(chat.indexOf('const attachChatViewListeners ='), chat.indexOf('onMounted(async () =>'))
  const document = new EventTarget(), window = new EventTarget()
  const scroll = { scrollTop: 320 }, calls = []
  const context = {
    document, window, chatPageActive: { value: true }, chatInitialized: true,
    savedScrollPositions: [], accountChangeQueued: false, voiceSidebarOpen: { value: false },
    chatPageRef: { value: { querySelectorAll: selector => selector === '.overflow-y-auto' ? [scroll] : [{ pause: () => calls.push('pause') }] } },
    onActivated: fn => { context.activate = fn }, onDeactivated: fn => { context.deactivate = fn },
    onBeforeRouteLeave: fn => { context.leave = fn }, nextTick: async () => {},
    onGlobalClick: () => {}, onGlobalKeyDown: () => calls.push('key'),
    onFloatingWindowMouseMove: () => {}, onFloatingWindowMouseUp: () => {},
    onWindowFocus: () => {}, onVisibilityChange: () => {},
    applyRouteSelection: async () => {}, updateJumpToBottomState: () => {}, consumeAiNavigation: () => {},
    stopVoiceBatchPolling: () => {}, stopSessionListResize: () => {},
    closeContextMenu: () => {}, clearContactProfileHoverHideTimer: () => {}, closeContactProfileCard: () => {},
    closeImagePreview: () => {}, closeVideoPreview: () => {}, closeGroupAnnouncement: () => {},
  }
  vm.runInNewContext(source, context)
  await context.activate()
  document.dispatchEvent(new Event('keydown'))
  assert.deepEqual(calls, ['key'])
  context.leave()
  context.deactivate()
  assert.equal(context.chatPageActive.value, false)
  document.dispatchEvent(new Event('keydown'))
  assert.deepEqual(calls, ['key', 'pause'])
  scroll.scrollTop = 0
  await context.activate()
  assert.equal(scroll.scrollTop, 320)
  await context.activate()
  document.dispatchEvent(new Event('keydown'))
  assert.deepEqual(calls, ['key', 'pause', 'key'])
})

test('异步AI导航加载账号期间离开聊天，不在其他页面切换账号', async () => {
  const start = chat.indexOf('const consumeAiNavigation =')
  const source = chat.slice(start, chat.indexOf('watch(aiNavigation,', start))
  let resolveAccounts
  const calls = []
  const context = {
    createAiNavigationConsumer,
    chatPageActive: { value: true }, aiNavigation: { value: { account: 'new-account', task_id: 'task' } },
    aiDiagnosticApi: { diagnostic: (...args) => calls.push(['diagnostic', ...args]) },
    chatAccounts: { ensureLoaded: () => new Promise(resolve => { resolveAccounts = resolve }), setSelectedAccount: value => calls.push(['account', value]) },
    selectedAccount: { value: 'original-account' }, nextTick: async () => {},
    accountBootstrapInProgress: false, accountChangeInProgress: false,
    snapshotRefreshReady: { value: true }, aiSidebarOpen: { value: false },
    aiFocusTaskId: { value: '' }, insightsPanelOpen: { value: false },
    locateAiSource: async () => { calls.push(['locate']); return true },
    showErrorAlert: message => calls.push(['error', message]),
  }
  const pending = vm.runInNewContext(`${source}\nconsumeAiNavigation()`, context)
  context.chatPageActive.value = false
  resolveAccounts()
  await pending
  assert.equal(calls.some(([type]) => type === 'account'), false)
  assert.equal(calls.some(([type]) => type === 'locate' || type === 'error'), false)
  assert.equal(context.aiNavigation.value.task_id, 'task')
})
