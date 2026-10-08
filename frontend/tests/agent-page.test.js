import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPage from '../pages/agent.vue'

let account, accounts, api, navigation, navigate, wrapper
vi.mock('pinia', () => ({ storeToRefs: store => store }))
vi.mock('~/stores/chatAccounts', () => ({ useChatAccountsStore: () => accounts }))
vi.mock('~/composables/useApi', () => ({ useApi: () => api }))
vi.mock('~/components/chat/ChatAgentPanel.vue', () => ({ default: defineComponent({
  name: 'ChatAgentPanel', props: ['account', 'presentation', 'prepareSource', 'locateSource'],
  setup: () => () => h('div', { class: 'agent-panel-fixture' }),
}) }))

beforeEach(() => {
  account = ref('account-a')
  accounts = { selectedAccount: account, loading: false, error: '', ensureLoaded: vi.fn(async () => {}) }
  api = { getChatMessagesAround: vi.fn(async () => ({ messages: [{ id: 'anchor' }], anchorId: 'anchor', anchorIndex: 0 })) }
  navigation = ref(null)
  navigate = vi.fn(async () => {})
  vi.stubGlobal('useState', () => navigation)
  vi.stubGlobal('navigateTo', navigate)
  vi.stubGlobal('useHead', vi.fn())
})
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals() })
const open = async () => { wrapper = mount(AgentPage, { global: { stubs: { ErrorNotice: true } } }); await flushPromises(); return wrapper.findComponent({ name: 'ChatAgentPanel' }) }
const source = { username: 'friend', anchor: 'anchor', source: 'source-1' }

describe('独立 AI 助手页面接入', () => {
  it('从共享账号 store 挂载页面形态，无需当前聊天联系人', async () => {
    const panel = await open()
    expect(accounts.ensureLoaded).toHaveBeenCalledOnce()
    expect(panel.props('presentation')).toBe('page')
    expect(panel.props('account')).toBe('account-a')
    expect(panel.attributes('contact')).toBeUndefined()
    account.value = 'account-b'; await flushPromises()
    expect(panel.props('account')).toBe('account-b')
  })
  it('引用预读复用真实上下文参数和缓存，并在切换账号后失效', async () => {
    const panel = await open()
    const prepare = panel.props('prepareSource')
    await expect(prepare(source)).resolves.toMatchObject({ anchorId: 'anchor' })
    await prepare(source)
    expect(api.getChatMessagesAround).toHaveBeenCalledOnce()
    expect(api.getChatMessagesAround).toHaveBeenCalledWith({ account: 'account-a', username: 'friend', anchor_id: 'anchor', before: 35, after: 35, source: 'auto', ai_diagnostic: true })
    account.value = 'account-b'; await flushPromises(); await prepare(source)
    expect(api.getChatMessagesAround).toHaveBeenLastCalledWith(expect.objectContaining({ account: 'account-b' }))
    expect(api.getChatMessagesAround).toHaveBeenCalledTimes(2)
  })
  it('缺失原消息暴露错误，手动再次预读会重新请求', async () => {
    const panel = await open()
    api.getChatMessagesAround.mockResolvedValueOnce({ messages: [] })
    await expect(panel.props('prepareSource')(source)).rejects.toThrow('未找到原消息')
    await expect(panel.props('prepareSource')(source)).resolves.toMatchObject({ anchorId: 'anchor' })
    expect(api.getChatMessagesAround).toHaveBeenCalledTimes(2)
  })
  it('定位发布来源目标并进入聊天页，保留消息引用标识', async () => {
    const panel = await open()
    await expect(panel.props('locateSource')(source)).resolves.toBe(true)
    expect(navigation.value).toEqual({ ...source, kind: 'source', account: 'account-a' })
    expect(navigate).toHaveBeenCalledWith('/chat')
  })
  it('路由导航失败清除本次目标并把异常交给引用卡片', async () => {
    const panel = await open()
    navigate.mockRejectedValueOnce(new Error('路由加载失败'))
    await expect(panel.props('locateSource')(source)).rejects.toThrow('路由加载失败')
    expect(navigation.value).toBeNull()
  })
  it('路由守卫取消导航也必须暴露失败，不报告已定位', async () => {
    const panel = await open()
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/chat', component: { render: () => null } }] })
    router.beforeEach(() => false)
    navigate.mockResolvedValueOnce(await router.push('/chat'))
    await expect(panel.props('locateSource')(source)).rejects.toThrow('未能打开聊天原消息')
    expect(navigation.value).toBeNull()
  })
})
