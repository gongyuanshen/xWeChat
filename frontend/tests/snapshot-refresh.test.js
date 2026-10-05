import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSnapshotRefresh } from '~/composables/chat/useSnapshotRefresh'
import { useApi } from '~/composables/useApi'

vi.mock('~/lib/server-error-logging', () => ({ reportServerError: vi.fn() }))

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const status = (overrides = {}) => ({
  account: 'a', active_account: null, enabled: false, running: false, phase: 'disabled',
  interval_seconds: 30, probe_interval_seconds: 0.5, last_checked_at: null, last_success_at: null, revision: 0,
  generation: null, archive_generation: null, guarantee: 'stable_observation', error: null, retained_bytes: 0,
  restart_policy: 'disabled', refresh_available: true, unavailable_reason: '', ...overrides
})
let wrapper, originalClient
beforeEach(() => {
  originalClient = process.client
  process.client = true
  vi.useFakeTimers()
  vi.stubGlobal('useApiBase', () => '/api')
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  process.client = originalClient
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const setup = (overrides = {}, getDisplayedGeneration) => {
  const api = {
    getSnapshotRefreshStatus: vi.fn(async ({ account }) => status({ account })),
    subscribeSnapshotRefresh: vi.fn(() => ({ close: vi.fn() })),
    startSnapshotRefresh: vi.fn(async ({ account }) => status({ account, enabled: true, running: true, phase: 'checking' })),
    stopSnapshotRefresh: vi.fn(async ({ account }) => status({ account })),
    refreshSnapshotOnce: vi.fn(async ({ account }) => status({ account, running: true, phase: 'checking' })),
    ...overrides
  }
  const selectedAccount = ref('a'), active = ref(true), onPublished = vi.fn(async () => {})
  let state
  wrapper = mount(defineComponent({ setup() {
    state = useSnapshotRefresh({ api, selectedAccount, active, onPublished, getDisplayedGeneration })
    return () => h('div')
  } }))
  return { api, selectedAccount, active, onPublished, state }
}

describe('聊天自动同步', () => {
  it('首连和重复推送只核对状态，实际发布和归档完成才更新内容', async () => {
    const initial = status({ enabled: true, revision: 1, generation: 'g1' })
    const { api, state, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => initial) })
    await flushPromises()
    const subscription = api.subscribeSnapshotRefresh.mock.calls[0][0]
    for (let i = 0; i < 2; ++i) {
      subscription.onChange()
      await flushPromises()
    }
    expect(api.getSnapshotRefreshStatus).toHaveBeenCalledTimes(3)
    expect(onPublished).not.toHaveBeenCalled()

    api.getSnapshotRefreshStatus.mockResolvedValue({ ...initial, revision: 2, generation: 'g2', running: true, phase: 'archiving' })
    subscription.onChange()
    await flushPromises()
    expect(onPublished).toHaveBeenCalledOnce()
    expect(state.manualRefreshing.value).toBe(false)

    api.getSnapshotRefreshStatus.mockResolvedValue({ ...initial, revision: 2, generation: 'g2', archive_generation: 'g2' })
    subscription.onChange()
    await flushPromises()
    expect(onPublished).toHaveBeenCalledTimes(2)
    subscription.onChange()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    expect(onPublished).toHaveBeenCalledTimes(2)
    expect(api.refreshSnapshotOnce).not.toHaveBeenCalled()

    await state.refreshView()
    expect(onPublished).toHaveBeenCalledTimes(3)
    expect(state.manualRefreshing.value).toBe(false)
  })

  it('首次状态读取前已完成归档时，同代首屏也必须应用归档结果', async () => {
    const displayed = ref('g1')
    const { api, state, onPublished } = setup({
      getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true, revision: 1, generation: 'g1', archive_generation: 'g1' })),
    }, () => displayed.value)
    await flushPromises()
    expect(onPublished).toHaveBeenCalledOnce()
    expect(state.manualRefreshing.value).toBe(false)
    api.subscribeSnapshotRefresh.mock.calls[0][0].onChange()
    await flushPromises()
    expect(onPublished).toHaveBeenCalledOnce()
  })

  it('快照推送立即更新页面，断开后关闭订阅并由明确重试恢复', async () => {
    const { api, state, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true, revision: 1 })) })
    await flushPromises()
    expect(api.subscribeSnapshotRefresh).toHaveBeenCalledOnce()
    const subscription = api.subscribeSnapshotRefresh.mock.calls[0][0]
    api.getSnapshotRefreshStatus.mockResolvedValue(status({ enabled: true, revision: 2 }))
    subscription.onChange()
    await flushPromises()
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }))
    subscription.onError(new Error('推送连接断开'))
    expect(state.paused.value).toBe(true)
    expect(api.subscribeSnapshotRefresh.mock.results[0].value.close).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.subscribeSnapshotRefresh).toHaveBeenCalledOnce()
    await state.retry()
    expect(api.subscribeSnapshotRefresh).toHaveBeenCalledTimes(2)
  })

  it('账号切换关闭旧推送，迟到通知不能刷新新账号', async () => {
    const { api, selectedAccount, onPublished } = setup()
    await flushPromises()
    const previous = api.subscribeSnapshotRefresh.mock.calls[0][0]
    selectedAccount.value = 'b'
    await flushPromises()
    expect(api.subscribeSnapshotRefresh.mock.results[0].value.close).toHaveBeenCalledOnce()
    const checks = api.getSnapshotRefreshStatus.mock.calls.length
    previous.onChange()
    previous.onError(new Error('旧账号断开'))
    await flushPromises()
    expect(api.getSnapshotRefreshStatus).toHaveBeenCalledTimes(checks)
    expect(onPublished).not.toHaveBeenCalled()
    wrapper.unmount()
    wrapper = null
    expect(api.subscribeSnapshotRefresh.mock.results[1].value.close).toHaveBeenCalledOnce()
  })

  it('推送断开时作废正在读取的状态，迟到响应不能重新启动页面更新', async () => {
    const { api, state, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true })) })
    await flushPromises()
    const pendingStatus = deferred()
    api.getSnapshotRefreshStatus.mockReturnValueOnce(pendingStatus.promise)
    const subscription = api.subscribeSnapshotRefresh.mock.calls[0][0]
    subscription.onChange()
    await flushPromises()
    subscription.onError(new Error('合成断开'))
    pendingStatus.resolve(status({ enabled: true, revision: 20 }))
    await flushPromises()
    expect(state.error.value).toBe('合成断开')
    expect(state.paused.value).toBe(true)
    expect(onPublished).not.toHaveBeenCalled()
    expect(state.status.value.revision).toBe(0)
  })

  it('读取错误后重建订阅，旧连接的迟到错误不能关闭新连接', async () => {
    const { api, state } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true })) })
    await flushPromises()
    const old = api.subscribeSnapshotRefresh.mock.calls[0][0]
    api.getSnapshotRefreshStatus.mockRejectedValueOnce(new Error('状态读取失败'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(state.paused.value).toBe(true)
    await state.retry()
    expect(api.subscribeSnapshotRefresh).toHaveBeenCalledTimes(2)
    old.onError(new Error('旧连接断开'))
    expect(state.paused.value).toBe(false)
    expect(api.subscribeSnapshotRefresh.mock.results[1].value.close).not.toHaveBeenCalled()
  })

  it('打开本地账号自动启动，接受请求后等待真实发布才更新页面', async () => {
    const { api, state, onPublished } = setup()
    await flushPromises()
    expect(api.startSnapshotRefresh).toHaveBeenCalledOnce()
    expect(api.startSnapshotRefresh).toHaveBeenCalledWith({ account: 'a', interval_seconds: 30 })
    expect(state.syncing.value).toBe(true)
    expect(onPublished).not.toHaveBeenCalled()
    api.getSnapshotRefreshStatus.mockResolvedValue(status({ enabled: true, phase: 'waiting', revision: 1, generation: 'g1' }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ account: 'a', revision: 1 }))
    expect(state.syncing.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.startSnapshotRefresh).toHaveBeenCalledOnce()
    expect(onPublished).toHaveBeenCalledOnce()
  })

  it('已经自动同步的账号不重复启动', async () => {
    const { api } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true, phase: 'waiting' })) })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.startSnapshotRefresh).not.toHaveBeenCalled()
  })

  it('导入归档不启动采集，顶部刷新只重读已有资料', async () => {
    const { api, state, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ refresh_available: false, unavailable_reason: '导入的历史记录，不连接本机微信' })) })
    await flushPromises()
    expect(api.startSnapshotRefresh).not.toHaveBeenCalled()
    await state.refreshOnce()
    expect(api.refreshSnapshotOnce).not.toHaveBeenCalled()
    expect(onPublished).toHaveBeenCalledOnce()
    expect(state.error.value).toBe('')
  })

  it('顶部刷新唤醒等待任务，源数据没变也要在检查完成后重读页面', async () => {
    const waiting = status({ enabled: true, phase: 'waiting', revision: 3, generation: 'g3' })
    const { api, state, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => waiting), refreshSnapshotOnce: vi.fn(async () => ({ ...waiting, running: true, phase: 'checking' })) })
    await flushPromises()
    expect(state.manualRefreshing.value).toBe(false)
    await state.refreshOnce()
    expect(api.refreshSnapshotOnce).toHaveBeenCalledOnce()
    expect(onPublished).not.toHaveBeenCalled()
    expect(state.syncing.value).toBe(true)
    expect(state.manualRefreshing.value).toBe(true)
    const publication = deferred()
    onPublished.mockReturnValueOnce(publication.promise)
    await vi.advanceTimersByTimeAsync(1500)
    expect(onPublished).toHaveBeenCalledOnce()
    expect(state.manualRefreshing.value).toBe(true)
    publication.resolve()
    await flushPromises()
    expect(state.syncing.value).toBe(false)
    expect(state.manualRefreshing.value).toBe(false)
  })

  it('已有同步正在执行时手动刷新等它完成，不并发提交第二轮', async () => {
    const { api, state, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true, running: true, phase: 'building' })) })
    await flushPromises()
    expect(state.manualRefreshing.value).toBe(false)
    await state.refreshOnce()
    expect(api.refreshSnapshotOnce).not.toHaveBeenCalled()
    expect(state.manualRefreshing.value).toBe(true)
    api.getSnapshotRefreshStatus.mockResolvedValue(status({ enabled: true, phase: 'waiting', revision: 1 }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(onPublished).toHaveBeenCalledOnce()
    expect(state.manualRefreshing.value).toBe(false)
  })

  it('初次窗口仍旧代时重读，首屏迟到也会核对代次', async () => {
    const displayed = ref(null)
    const { api, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true, phase: 'waiting', revision: 2, generation: 'g2' })) }, () => displayed.value)
    await flushPromises()
    expect(onPublished).not.toHaveBeenCalled()
    displayed.value = 'g1'
    await flushPromises()
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ generation: 'g2' }))
    expect(api.startSnapshotRefresh).not.toHaveBeenCalled()
  })

  it('账号切换先停止旧账号，等后台空闲才启动最新选择', async () => {
    const getStatus = vi.fn(async ({ account }) => status({ account, active_account: 'a' }))
    const { api, selectedAccount, state } = setup({ getSnapshotRefreshStatus: getStatus })
    await flushPromises()
    selectedAccount.value = 'b'
    await flushPromises()
    expect(api.stopSnapshotRefresh).toHaveBeenCalledWith(expect.objectContaining({ account: 'a' }))
    expect(api.startSnapshotRefresh.mock.calls.filter(([p]) => p.account === 'b')).toHaveLength(0)
    getStatus.mockImplementation(async ({ account }) => status({ account }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.startSnapshotRefresh).toHaveBeenLastCalledWith(expect.objectContaining({ account: 'b' }))
    expect(state.status.value.account).toBe('b')
  })

  it('A→B→C期间旧启动尚未返回，串行收尾后只启动最新账号', async () => {
    const pendingStart = deferred()
    let activeAccount = null
    const start = vi.fn(async ({ account }) => {
      if (account === 'a') await pendingStart.promise
      activeAccount = account
      return status({ account, active_account: account, enabled: true, running: true, phase: 'checking' })
    })
    const stop = vi.fn(async ({ account }) => { activeAccount = null; return status({ account }) })
    const getStatus = vi.fn(async ({ account }) => status({ account, active_account: activeAccount }))
    const { selectedAccount, state } = setup({ getSnapshotRefreshStatus: getStatus, startSnapshotRefresh: start, stopSnapshotRefresh: stop })
    await flushPromises()
    selectedAccount.value = 'b'
    await flushPromises()
    selectedAccount.value = 'c'
    await flushPromises()
    expect(start.mock.calls.map(([p]) => p.account)).toEqual(['a'])
    pendingStart.resolve()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    expect(start.mock.calls.map(([p]) => p.account)).toEqual(['a', 'c'])
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ account: 'a' }))
    expect(state.status.value.account).toBe('c')
  })

  it('A→B→A旧GET响应不得覆盖当前账号，取消只读请求', async () => {
    const old = deferred(), current = deferred()
    const fetchStatus = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const { state, selectedAccount } = setup({ getSnapshotRefreshStatus: fetchStatus })
    await flushPromises()
    selectedAccount.value = 'b'
    await nextTick()
    selectedAccount.value = 'a'
    await nextTick()
    expect(fetchStatus.mock.calls[0][0].signal.aborted).toBe(true)
    old.resolve(status({ revision: 99 }))
    await flushPromises()
    expect(state.status.value).toBe(null)
    current.resolve(status({ enabled: true, phase: 'waiting', revision: 2 }))
    await flushPromises()
    expect(state.status.value.revision).toBe(2)
  })

  it('旧账号异常不得覆盖当前账号', async () => {
    const old = deferred()
    const { state, selectedAccount } = setup({ getSnapshotRefreshStatus: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(status({ account: 'b', enabled: true, phase: 'waiting' })) })
    await flushPromises()
    selectedAccount.value = 'b'
    await flushPromises()
    old.reject(new Error('A 的旧网络错误'))
    await flushPromises()
    expect(state.error.value).toBe('')
    expect(state.status.value.account).toBe('b')
  })

  it('网络失败停止轮询，页面重新激活不重试，顶部刷新明确恢复', async () => {
    const fetchStatus = vi.fn().mockResolvedValueOnce(status({ enabled: true, phase: 'waiting' })).mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(status({ enabled: true, phase: 'waiting' }))
    const { state, active } = setup({ getSnapshotRefreshStatus: fetchStatus })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1500)
    expect(state.error.value).toBe('connection lost')
    active.value = false
    await nextTick()
    active.value = true
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60000)
    await state.refreshView()
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    await state.refreshOnce()
    expect(fetchStatus).toHaveBeenCalledTimes(3)
    expect(state.error.value).toBe('')
  })

  it('后台失败显示原始原因，不自动重启；用户重试恢复持续同步', async () => {
    const fetchStatus = vi.fn(async () => status({ phase: 'failed', error: { stage: 'build', type: 'ValueError', message: 'bad hmac' } }))
    const { state, api } = setup({ getSnapshotRefreshStatus: fetchStatus })
    await flushPromises()
    expect(state.error.value).toContain('build · ValueError · bad hmac')
    await vi.advanceTimersByTimeAsync(60000)
    expect(api.startSnapshotRefresh).not.toHaveBeenCalled()
    await state.retry()
    expect(api.startSnapshotRefresh).toHaveBeenCalledOnce()
    expect(state.paused.value).toBe(false)
  })

  it('自动状态请求失败前排队的手动刷新仍能清错并继续观察', async () => {
    const old = deferred()
    const fetchStatus = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(status({ enabled: true, phase: 'waiting' }))
    const { state, api, onPublished } = setup({ getSnapshotRefreshStatus: fetchStatus })
    await flushPromises()
    const manual = state.refreshOnce()
    old.reject(new Error('old connection failed'))
    await manual
    expect(state.error.value).toBe('')
    expect(state.paused.value).toBe(false)
    expect(api.refreshSnapshotOnce).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1500)
    expect(onPublished).toHaveBeenCalledOnce()
  })

  it('页面读取失败后丢弃已经排队的自动代次检查', async () => {
    const displayed = ref('g1')
    const publication = deferred()
    const { state, api, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true, phase: 'waiting', revision: 1, generation: 'g1' })) }, () => displayed.value)
    await flushPromises()
    onPublished.mockImplementationOnce(async () => {
      displayed.value = 'late-old-generation'
      await nextTick()
      await publication.promise
    })
    api.getSnapshotRefreshStatus.mockResolvedValue(status({ enabled: true, phase: 'waiting', revision: 2, generation: 'g2' }))
    await vi.advanceTimersByTimeAsync(1500)
    publication.reject(new Error('session read failed'))
    await flushPromises()
    expect(state.paused.value).toBe(true)
    expect(state.error.value).toBe('session read failed')
    expect(onPublished).toHaveBeenCalledOnce()
    expect(api.getSnapshotRefreshStatus).toHaveBeenCalledTimes(2)
  })

  it('自动启动、后台采集和内容读取期间手动按钮保持空闲', async () => {
    const started = deferred()
    const { api, state, onPublished } = setup({ startSnapshotRefresh: vi.fn(() => started.promise) })
    expect(state.manualRefreshing.value).toBe(false)
    await flushPromises()
    expect(state.syncing.value).toBe(true)
    expect(state.manualRefreshing.value).toBe(false)
    started.resolve(status({ enabled: true, running: true, phase: 'checking' }))
    await flushPromises()
    expect(state.syncing.value).toBe(true)
    expect(state.manualRefreshing.value).toBe(false)
    const publication = deferred()
    onPublished.mockReturnValueOnce(publication.promise)
    api.getSnapshotRefreshStatus.mockResolvedValue(status({ enabled: true, running: true, revision: 1, phase: 'archiving' }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(onPublished).toHaveBeenCalledOnce()
    expect(state.manualRefreshing.value).toBe(false)
    publication.resolve()
    await flushPromises()
  })

  it('手动刷新失败或切换账号后释放手动按钮状态', async () => {
    const { api, state, selectedAccount } = setup({
      getSnapshotRefreshStatus: vi.fn(async ({ account }) => status({ account, enabled: true })),
      refreshSnapshotOnce: vi.fn().mockRejectedValueOnce(new Error('手动采集失败')).mockResolvedValue(status({ enabled: true, running: true })),
    })
    await flushPromises()
    await state.refreshOnce()
    expect(state.error.value).toBe('手动采集失败')
    expect(state.manualRefreshing.value).toBe(false)
    await state.retry()
    expect(state.manualRefreshing.value).toBe(true)
    selectedAccount.value = 'b'
    await flushPromises()
    expect(state.manualRefreshing.value).toBe(false)
    expect(api.refreshSnapshotOnce).toHaveBeenCalledTimes(2)
  })

  it('页面读取失败保留未应用revision，手动恢复重新应用', async () => {
    const { state, api, onPublished } = setup({ getSnapshotRefreshStatus: vi.fn(async () => status({ enabled: true, phase: 'waiting' })) })
    await flushPromises()
    onPublished.mockRejectedValueOnce(new Error('anchor missing'))
    api.getSnapshotRefreshStatus.mockResolvedValue(status({ enabled: true, phase: 'waiting', revision: 1 }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(state.error.value).toBe('anchor missing')
    await state.retry()
    api.getSnapshotRefreshStatus.mockResolvedValue(status({ enabled: true, phase: 'waiting', revision: 1 }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(onPublished).toHaveBeenCalledTimes(2)
  })
})

describe('快照 API 禁止自动重试', () => {
  it('推送使用明确账号并在协议错误或断线时关闭自动重连', () => {
    class Source {
      constructor(url) { this.url = url; this.close = vi.fn(); this.handlers = {} }
      addEventListener(name, callback) { this.handlers[name] = callback }
    }
    vi.stubGlobal('EventSource', Source)
    const api = useApi(), onChange = vi.fn(), onError = vi.fn()
    const stream = api.subscribeSnapshotRefresh({ account: 'a+中文', onChange, onError })
    expect(stream.url).toBe('/api/decrypt/snapshot-refresh/events?account=a%2B%E4%B8%AD%E6%96%87')
    stream.handlers.snapshot_changed({ data: JSON.stringify({ account: 'a+中文', sequence: 3 }) })
    expect(onChange).toHaveBeenCalledOnce()
    stream.handlers.snapshot_changed({ data: JSON.stringify({ account: 'other', sequence: 4 }) })
    expect(stream.close).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onChange).toHaveBeenCalledOnce()
    const disconnected = api.subscribeSnapshotRefresh({ account: 'a', onChange, onError })
    disconnected.onerror()
    expect(disconnected.close).toHaveBeenCalledOnce()
  })
  it.each([undefined, '', 'generation-wrong', 42])('消息读取拒绝不完整快照代次协议：%s', async (generation) => {
    vi.stubGlobal('$fetch', vi.fn(async () => ({ messages: [], snapshotGeneration: generation })))
    const api = useApi()
    await expect(api.listChatMessages({ account: 'a', username: 'friend' })).rejects.toThrow('snapshotGeneration')
    await expect(api.getChatMessagesAround({ account: 'a', username: 'friend', anchor_id: '1' })).rejects.toThrow('snapshotGeneration')
  })
  it.each(['legacy', 'generation-0123456789abcdef0123456789abcdef'])('消息读取接受已声明的代次协议：%s', async (generation) => {
    vi.stubGlobal('$fetch', vi.fn(async () => ({ messages: [], snapshotGeneration: generation })))
    const api = useApi()
    expect((await api.listChatMessages({ account: 'a', username: 'friend' })).snapshotGeneration).toBe(generation)
    expect((await api.getChatMessagesAround({ account: 'a', username: 'friend', anchor_id: '1' })).snapshotGeneration).toBe(generation)
  })
  it('四个端点传递取消信号并关闭 HTTP retry', async () => {
    const fetch = vi.fn(async () => status())
    vi.stubGlobal('$fetch', fetch)
    const api = useApi(), signal = new AbortController().signal
    await api.getSnapshotRefreshStatus({ account: 'a', signal })
    await api.startSnapshotRefresh({ account: 'a', interval_seconds: 30, signal })
    await api.stopSnapshotRefresh({ account: 'a', signal })
    await api.refreshSnapshotOnce({ account: 'a', signal })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/decrypt/snapshot-refresh/status?account=a', '/decrypt/snapshot-refresh/start', '/decrypt/snapshot-refresh/stop', '/decrypt/snapshot-refresh/once'
    ])
    for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ signal, retry: 0 })
    expect(fetch.mock.calls[1][1].body).toEqual({ account: 'a', interval_seconds: 30 })
  })
})
