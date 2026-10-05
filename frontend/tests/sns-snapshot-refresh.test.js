import { mount, flushPromises } from '@vue/test-utils'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SnsPage from '~/pages/sns.vue'

let account, api, wrapper
vi.mock('pinia', () => ({ storeToRefs: value => value }))
vi.mock('~/stores/chatAccounts', () => ({ useChatAccountsStore: () => ({ selectedAccount: account, ensureLoaded: vi.fn() }) }))
vi.mock('~/stores/privacy', () => ({ usePrivacyStore: () => ({ privacyMode: ref(false), init: vi.fn() }) }))
vi.mock('~/lib/server-error-logging', () => ({ reportServerErrorFromError: vi.fn(), reportServerErrorFromResponse: vi.fn() }))

const state = (changes = {}) => ({ account: 'a', active_account: null, enabled: false, running: false,
  phase: 'disabled', interval_seconds: 30, probe_interval_seconds: 0.5, revision: 0, generation: null, archive_generation: null,
  error: null, refresh_available: true, unavailable_reason: '', ...changes })
const timeline = (content, generation = 'legacy') => ({ timeline: [{ id: '1', username: 'friend', type: 1,
  contentDesc: content, media: [], likes: [], comments: [], createTime: 1 }], hasMore: false, limit: 20,
  snapshotGeneration: generation })

beforeEach(() => {
  process.client = true
  vi.useFakeTimers()
  account = ref('a')
  api = {
    listSnsUsers: vi.fn(async () => ({ items: [] })),
    listSnsTimeline: vi.fn(async () => timeline('原有动态')),
    getSnsSnapshotStatus: vi.fn(async () => ({ status: 'ok', available: true, version: 'v0' })),
    getSnapshotRefreshStatus: vi.fn(async () => state()),
    subscribeSnapshotRefresh: vi.fn(() => ({ close: vi.fn() })),
    startSnapshotRefresh: vi.fn(async () => state({ enabled: true, running: true })),
    refreshSnapshotOnce: vi.fn(async () => state({ enabled: true, running: true })),
    stopSnapshotRefresh: vi.fn(async () => state()),
  }
  for (const [name, value] of Object.entries({ ref, reactive, computed, watch, nextTick, onMounted, onUnmounted,
    useHead: vi.fn(), useApi: () => api, useApiBase: () => '/api', $fetch: vi.fn(async () => ({ wxid: 'a', nickname: '测试' })) })) {
    vi.stubGlobal(name, value)
  }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.client
})
const open = async () => {
  wrapper = mount(SnsPage, { global: { directives: { 'chat-lazy-src': {} }, stubs: {
    LivePhotoIcon: true,
    ErrorNotice: { props: ['message'], template: '<div role="alert">{{ message }}</div>' },
  } } })
  await flushPromises()
}

describe('朋友圈沿用独立快照自动同步', () => {
  it('直接打开页面启动同步，发布后更新已显示动态', async () => {
    await open()
    expect(api.startSnapshotRefresh).toHaveBeenCalledWith({ account: 'a', interval_seconds: 30 })
    expect(wrapper.text()).toContain('原有动态')
    api.getSnapshotRefreshStatus.mockResolvedValue(state({ enabled: true, revision: 1, generation: 'g1' }))
    api.getSnsSnapshotStatus.mockResolvedValue({ status: 'ok', available: true, version: 'v1' })
    api.listSnsTimeline.mockResolvedValue(timeline('更新后的动态', 'g1'))
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(wrapper.text()).toContain('更新后的动态')
    expect(wrapper.text()).not.toContain('原有动态')
  })

  it('导入历史记录不启动源采集，手动刷新仍可重读', async () => {
    api.getSnapshotRefreshStatus.mockResolvedValue(state({ refresh_available: false, unavailable_reason: '导入历史记录' }))
    await open()
    expect(api.startSnapshotRefresh).not.toHaveBeenCalled()
    const button = wrapper.findAll('button').find(button => button.text() === '刷新')
    await button.trigger('click')
    await flushPromises()
    expect(api.refreshSnapshotOnce).not.toHaveBeenCalled()
    expect(api.listSnsTimeline.mock.calls.length).toBeGreaterThan(1)
  })

  it('发布后读取失败明确停止前端更新并保留当前动态', async () => {
    await open()
    api.getSnapshotRefreshStatus.mockResolvedValue(state({ enabled: true, revision: 1, generation: 'g1' }))
    api.getSnsSnapshotStatus.mockResolvedValue({ status: 'ok', available: true, version: 'v1' })
    api.listSnsTimeline.mockRejectedValue(new Error('合成时间线读取失败'))
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(wrapper.text()).toContain('合成时间线读取失败')
    expect(wrapper.text()).toContain('原有动态')
    const calls = api.getSnapshotRefreshStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.getSnapshotRefreshStatus).toHaveBeenCalledTimes(calls)
  })

  it('读取失败后明确重试成功会清除旧错误', async () => {
    await open()
    const ready = state({ enabled: true, revision: 1, generation: 'g1' })
    api.getSnapshotRefreshStatus.mockResolvedValue(ready)
    api.getSnsSnapshotStatus.mockResolvedValue({ status: 'ok', available: true, version: 'v1' })
    api.listSnsTimeline.mockRejectedValueOnce(new Error('需要消除的旧错误'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(wrapper.text()).toContain('需要消除的旧错误')
    api.refreshSnapshotOnce.mockResolvedValue({ ...ready, running: true })
    api.listSnsTimeline.mockResolvedValue(timeline('恢复后动态', 'g1'))
    await wrapper.findAll('button').find(button => button.text() === '重试同步').trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    expect(wrapper.text()).toContain('恢复后动态')
    expect(wrapper.text()).not.toContain('需要消除的旧错误')
  })
})


describe('independent review races', () => {
  it('late initial old generation is reconciled to the already published generation', async () => {
    let resolveInitial
    api.listSnsTimeline.mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve }))
    api.listSnsTimeline.mockResolvedValue(timeline('current generation', 'g1'))
    api.getSnapshotRefreshStatus.mockResolvedValue(state({ enabled: true, revision: 1, generation: 'g1' }))
    api.getSnsSnapshotStatus.mockResolvedValue({ status: 'ok', available: true, version: 'v1' })
    await open()
    resolveInitial(timeline('late initial old generation', 'g0'))
    await flushPromises()
    expect(wrapper.text()).toContain('current generation')
    expect(wrapper.text()).not.toContain('late initial old generation')
  })

  it('late published timeline from old account cannot overwrite selected account', async () => {
    await open()
    let resolveOld
    api.listSnsTimeline.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    api.getSnapshotRefreshStatus.mockImplementation(async ({ account }) => state({ account, enabled: true, revision: 1, generation: account + '-g1' }))
    api.getSnsSnapshotStatus.mockResolvedValue({ status: 'ok', available: true, version: 'v1' })
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    api.listSnsTimeline.mockResolvedValue(timeline('account b current timeline', 'b-g1'))
    account.value = 'b'
    await flushPromises()
    resolveOld(timeline('account a late timeline', 'a-g1'))
    await flushPromises()
    expect(wrapper.text()).toContain('account b current timeline')
    expect(wrapper.text()).not.toContain('account a late timeline')
  })

  it('late published timeline from previous filter cannot overwrite selected contact', async () => {
    api.listSnsUsers.mockResolvedValue({ items: [{ username: 'second-user', displayName: 'Second User', postCount: 1 }] })
    await open()
    let resolveOld
    api.listSnsTimeline.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    api.getSnapshotRefreshStatus.mockResolvedValue(state({ enabled: true, revision: 1, generation: 'g1' }))
    api.getSnsSnapshotStatus.mockResolvedValue({ status: 'ok', available: true, version: 'v1' })
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    api.listSnsTimeline.mockResolvedValue(timeline('selected contact timeline', 'g1'))
    const contact = wrapper.findAll('div.cursor-pointer').find(node => node.text().includes('Second User'))
    await contact.trigger('click')
    await flushPromises()
    resolveOld(timeline('late all contacts timeline', 'g1'))
    await flushPromises()
    expect(wrapper.text()).toContain('selected contact timeline')
    expect(wrapper.text()).not.toContain('late all contacts timeline')
  })
})
