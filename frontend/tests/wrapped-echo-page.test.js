import { flushPromises, mount } from '@vue/test-utils'
import * as vue from 'vue'
import { defineComponent, h, ref, reactive, inject, onMounted } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WrappedPage from '../pages/wrapped/index.vue'
import { ECHO_KINDS, periodDayCount } from '../lib/wrapped-echo-model'

let api, store, privacy, route, router, navigation, wrapper, selection, prepareCapture, restoredSelection, selectionFailure
vi.mock('pinia', () => ({ storeToRefs: value => value }))
vi.mock('~/stores/chatAccounts', () => ({ useChatAccountsStore: () => store }))
vi.mock('~/stores/privacy', () => ({ usePrivacyStore: () => privacy }))
vi.mock('~/composables/useApi', () => ({ useApi: () => api }))
vi.mock('~/composables/useApiBase', () => ({ useApiBase: () => '/api' }))
vi.mock('~/components/wrapped/echo/EchoExperience.vue', () => ({ default: defineComponent({
  name: 'EchoExperience', props: ['scene', 'year', 'cards', 'privacy', 'motion', 'exportMode', 'resolveMedia'], emits: ['scene', 'retry', 'detail', 'share', 'error'],
  setup(props, { expose }) {
    expose({ prepareCapture: () => prepareCapture(), closeOverlays() {}, getSelection: () => ({ ...selection }), setSelection: value => { if (selectionFailure) throw selectionFailure; restoredSelection = value; selection = { ...value } } })
    return () => h('div', { 'data-world-scene': props.scene }, String(props.scene))
  },
}) }))
vi.mock('~/components/wrapped/echo/EchoDetailPanel.vue', () => ({ default: defineComponent({ name: 'EchoDetailPanel', props: ['detail', 'title', 'privacy'], emits: ['source', 'retry', 'more', 'close'], setup: () => () => h('div', { 'data-detail': true }) }) }))
vi.mock('~/components/wrapped/echo/EchoSharePanel.vue', () => ({ default: defineComponent({ name: 'EchoSharePanel', props: ['document', 'busy'], emits: ['close', 'error'], setup: () => () => h('div', { 'data-share': true }) }) }))
vi.mock('~/components/wrapped/shared/WrappedStage.vue', () => ({ default: defineComponent({
  setup(_, { slots }) { const stage = inject(Symbol.for('wrapped.stage')), el = ref(null); onMounted(() => { stage.stageEl.value = el.value; stage.hostSize.value = { w: 1200, h: 800 } }); return () => h('div', [h('div', { ref: el, class: 'test-stage' }, slots.default?.()), slots.chrome?.()]) },
}) }))
vi.mock('~/components/wrapped/shared/WrappedFrameMenu.vue', () => ({ default: defineComponent({
  props: ['modelValue', 'exporting'], emits: ['export', 'export-all', 'update:modelValue'], setup(props, { emit, expose }) { expose({ close() {} }); return () => h('div', [h('button', { 'data-capture': true, disabled: props.exporting, onClick: () => emit('export') }, '截图'), h('button', { 'data-batch': true, disabled: props.exporting, onClick: () => emit('export-all') }, '批量截图')]) },
}) }))

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { resolve, reject, promise } }
const meta = (account = 'a', year = 2024) => ({ account, year, contractVersion: 1, availableYears: [year], cards: ECHO_KINDS.map((kind, id) => ({ id, kind, title: `类别 ${id}` })) })
const card = (id, account = 'a', year = 2024) => {
  const data = [
    { year, totalMessages: 0, activeDays: 0, messagesPerDay: 0, sentMediaCount: 0, sentStickerCount: 0, addedFriends: 0, annualHeatmap: { dailyCounts: Array(periodDayCount(year)).fill(0) } },
    { matrix: Array.from({ length: 7 }, () => Array(24).fill(0)), totalMessages: 0 },
    { sentChars: 0, receivedChars: 0, voice: { sentCount: 0, sentSeconds: 0, receivedCount: 0, receivedSeconds: 0 }, calls: { totalCount: 0, totalSeconds: 0, voiceCount: 0, videoCount: 0 } },
    { topTotals: [], allContacts: [], replyEvents: 0, sentToContacts: 0 },
    { months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, winner: null })), summary: { monthsWithWinner: 0 } },
    { topStickers: [], topWechatEmojis: [], topTextEmojis: [], topUnicodeEmojis: [], sentStickerCount: 0, uniqueStickerTypeCount: 0, revivedStickerCount: 0 },
    { keywords: [] }, {},
  ][id]
  return { id, account, year, kind: ECHO_KINDS[id], contractVersion: 1, status: 'ok', data }
}
const experience = () => wrapper.findComponent({ name: 'EchoExperience' })
const open = async () => { wrapper = mount(WrappedPage, { attachTo: document.body, global: { stubs: { WrappedYearSelector: true, ErrorNotice: true } } }); await flushPromises(); return wrapper }
beforeEach(() => {
  store = { selectedAccount: ref('a'), accounts: ref(['a', 'b']), loading: ref(false), error: '', ensureLoaded: vi.fn(async () => {}), setSelectedAccount: value => { store.selectedAccount.value = value } }
  privacy = { privacyMode: ref(false), init: vi.fn(), toggle: () => { privacy.privacyMode.value = !privacy.privacyMode.value } }
  route = reactive({ query: { year: '2024' } })
  router = { options: { history: { state: {} } }, back: vi.fn(), push: vi.fn(async () => {}), replace: vi.fn(async value => { route.query = value.query }) }
  api = { getWrappedAnnualMeta: vi.fn(async ({ account, year }) => meta(account, year)), getWrappedAnnualCard: vi.fn(async (id, { account, year }) => card(id, account, year)), getWrappedAnnualDetail: vi.fn() }
  navigation = ref(null); selection = { month: 2, phrase: 0, metric: 'voice', gather: true }; restoredSelection = null; selectionFailure = null; prepareCapture = vi.fn(async () => document.createElement('canvas'))
  vi.stubGlobal('useRoute', () => route); vi.stubGlobal('useRouter', () => router); vi.stubGlobal('useHead', vi.fn()); vi.stubGlobal('useState', () => navigation)
  for (const name of ['ref', 'computed', 'provide', 'watch', 'onMounted', 'onBeforeUnmount', 'nextTick']) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('requestAnimationFrame', callback => setTimeout(() => callback(performance.now()), 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 30, width: 1200, height: 800 })
  delete window.wechatDesktop
})
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.wechatDesktop })

describe('年度回声生产页面 controller', () => {
  it('keeps initial directory wording stable until the shared account store finishes', async () => {
    const pending = deferred()
    store.accounts.value = []; store.selectedAccount.value = null
    store.ensureLoaded.mockReturnValue(pending.promise)
    await open()
    expect(wrapper.get('.echo-page-empty p').text()).toBe('正在读取这一年的目录…')
    store.loading.value = true; await flushPromises()
    expect(wrapper.get('.echo-page-empty p').text()).toBe('正在读取这一年的目录…')
    store.loading.value = false; pending.resolve(); await flushPromises()
    expect(wrapper.get('.echo-page-empty p').text()).toContain('尚无可用账号')
  })

  it('keeps raw account identifiers and existing errors outside anonymous DOM', async () => {
    store.accounts.value = ['wxid_private_owner', 'wxid_private_second']; store.selectedAccount.value = 'wxid_private_owner'
    await open()
    experience().vm.$emit('error', new Error('私人姓名 的图片加载失败')); await flushPromises()
    expect(wrapper.text()).toContain('私人姓名')
    privacy.privacyMode.value = true; await flushPromises()
    expect(wrapper.html()).not.toContain('wxid_private_owner')
    expect(wrapper.html()).not.toContain('wxid_private_second')
    expect(wrapper.html()).not.toContain('私人姓名')
    expect(wrapper.text()).toContain('关闭匿名')
    await wrapper.get('select[aria-label="年度总结账号"]').setValue('1'); await flushPromises()
    expect(api.getWrappedAnnualMeta.mock.lastCall[0].account).toBe('wxid_private_second')
  })

  it('waits for the shared account store, loads current scene first, then background cards without duplicate year-snap reload', async () => {
    const accountReady = deferred(), overview = deferred()
    route.query.year = '2025'
    store.ensureLoaded.mockReturnValue(accountReady.promise)
    api.getWrappedAnnualMeta.mockResolvedValue(meta('a', 2024))
    api.getWrappedAnnualCard.mockImplementation((id, { account, year }) => id === 0 ? overview.promise : Promise.resolve(card(id, account, year)))
    await open(); expect(api.getWrappedAnnualMeta).not.toHaveBeenCalled()
    accountReady.resolve(); await flushPromises()
    expect(api.getWrappedAnnualCard.mock.calls.map(([id]) => id)).toEqual([0])
    overview.resolve(card(0)); await flushPromises()
    expect(api.getWrappedAnnualMeta).toHaveBeenCalledOnce()
    expect(new Set(api.getWrappedAnnualCard.mock.calls.map(([id]) => id))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
    expect(experience().props('year')).toBe(2024)
    expect(route.query.year).toBe('2024')
  })

  it('preserves current account identity when an older directory arrives late', async () => {
    const old = deferred()
    api.getWrappedAnnualMeta.mockImplementation(({ account }) => account === 'a' ? old.promise : Promise.resolve(meta('b', 2023)))
    await open(); store.selectedAccount.value = 'b'; await flushPromises()
    old.resolve(meta('a', 2022)); await flushPromises()
    expect(experience().props('year')).toBe(2023)
    expect(experience().props('cards')[0].account).toBe('b')
  })

  it('restores each account reading position and keeps selection across refresh', async () => {
    await open(); experience().vm.$emit('scene', 5); await flushPromises()
    selection = { phrase: 2, phraseMonth: 3, phraseOrder: 'length', hour: 22 }
    store.selectedAccount.value = 'b'; await flushPromises()
    expect(experience().props('scene')).toBe(0)
    experience().vm.$emit('scene', 3); await flushPromises(); selection = { month: 7, hour: 11 }
    store.selectedAccount.value = 'a'; await flushPromises()
    expect(experience().props('scene')).toBe(5)
    expect(restoredSelection).toEqual({ phrase: 2, phraseMonth: 3, phraseOrder: 'length', hour: 22 })
    restoredSelection = null
    await wrapper.get('button[aria-label="刷新年度统计"]').trigger('click'); await flushPromises()
    expect(experience().props('scene')).toBe(5)
    expect(restoredSelection).toEqual({ phrase: 2, phraseMonth: 3, phraseOrder: 'length', hour: 22 })
  })

  it('restores reading positions separately for each snapped year', async () => {
    api.getWrappedAnnualMeta.mockImplementation(async ({ account, year }) => ({ ...meta(account, year), availableYears: [2024, 2023] }))
    await open(); experience().vm.$emit('scene', 4); await flushPromises(); selection = { hour: 20 }
    wrapper.findComponent({ name: 'WrappedYearSelector' }).vm.$emit('update:modelValue', 2023); await flushPromises()
    expect(experience().props('scene')).toBe(0)
    experience().vm.$emit('scene', 2); await flushPromises(); selection = { contact: 3 }
    wrapper.findComponent({ name: 'WrappedYearSelector' }).vm.$emit('update:modelValue', 2024); await flushPromises()
    expect(experience().props('scene')).toBe(4)
    expect(restoredSelection).toEqual({ hour: 20 })
  })

  it('does not retry a failed card by navigating away and back; explicit retry starts one request', async () => {
    api.getWrappedAnnualCard.mockImplementation(async (id, { account, year }) => id === 3 ? { ...card(id, account, year), status: 'error', error: 'read failed', data: null } : card(id, account, year))
    await open(); experience().vm.$emit('scene', 2); await flushPromises()
    experience().vm.$emit('scene', 1); await flushPromises(); experience().vm.$emit('scene', 2); await flushPromises()
    expect(api.getWrappedAnnualCard.mock.calls.filter(([id]) => id === 3)).toHaveLength(1)
    experience().vm.$emit('retry'); await flushPromises()
    expect(api.getWrappedAnnualCard.mock.calls.filter(([id]) => id === 3)).toHaveLength(2)
  })

  it('publishes only the scoped source anchor to chat and shares only successfully loaded details', async () => {
    await open()
    const item = { username: 'friend', dbStem: 'message_0', table: 'Msg_real', localId: 27, timestamp: 1704067200, isSent: true, text: '已展开正文' }
    api.getWrappedAnnualDetail.mockImplementation(async query => ({ ...query, contractVersion: 1, status: 'ok', items: [item], summary: { sent: 1, received: 0, messageCount: 1, conversationCount: 1 }, total: 1, hasMore: false, offset: 0, limit: 40 }))
    experience().vm.$emit('detail', { kind: 'phrase', value: '已展开正文', period: 'all' }); await flushPromises()
    const detail = wrapper.findComponent({ name: 'EchoDetailPanel' })
    expect(detail.props('title')).not.toContain('已展开正文')
    detail.vm.$emit('source', item); await flushPromises()
    expect(navigation.value).toEqual({ kind: 'source', origin: 'wrapped', account: 'a', username: 'friend', anchor: 'message_0:Msg_real:27' })
    expect(router.push).toHaveBeenCalledWith('/chat')
    experience().vm.$emit('share'); await flushPromises()
    expect(wrapper.findComponent({ name: 'EchoSharePanel' }).exists(), wrapper.text()).toBe(true)
    expect(JSON.stringify(wrapper.findComponent({ name: 'EchoSharePanel' }).props('document'))).toContain('已展开正文')
  })

  it('rejects browser scene capture explicitly and exposes the independent share route', async () => {
    await open(); await wrapper.get('[data-capture]').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('独立海报')
    expect(prepareCapture).not.toHaveBeenCalled()
  })

  it('removes this navigation target when the router rejects the source request', async () => {
    await open()
    const item = { username: 'friend', dbStem: 'message_0', table: 'Msg_real', localId: 27, timestamp: 1704067200, isSent: true, text: '消息' }
    api.getWrappedAnnualDetail.mockImplementation(async query => ({ ...query, contractVersion: 1, status: 'ok', items: [item], summary: { sent: 1, received: 0, messageCount: 1, conversationCount: 1, conversations: [{ username: 'friend', displayName: '好友', messageCount: 1 }] }, total: 1, hasMore: false, offset: 0, limit: 40 }))
    experience().vm.$emit('detail', { kind: 'day', value: '2024-01-01' }); await flushPromises()
    router.push.mockResolvedValueOnce(false)
    wrapper.findComponent({ name: 'EchoDetailPanel' }).vm.$emit('source', item); await flushPromises()
    expect(navigation.value).toBeNull()
    expect(wrapper.text()).toContain('未能打开聊天页')
    expect(wrapper.findComponent({ name: 'EchoDetailPanel' }).exists()).toBe(true)
  })

  it('waits for the world before desktop capture and restores motion after failure', async () => {
    const ready = deferred(); prepareCapture.mockReturnValue(ready.promise)
    const captureRegion = vi.fn(async () => { expect(document.querySelector('.echo-page-export-progress')).toBeNull(); return { ok: false, error: '写盘失败' } }); window.wechatDesktop = { captureRegion }
    await open(); await wrapper.get('[data-capture]').trigger('click'); await flushPromises()
    expect(captureRegion).not.toHaveBeenCalled(); expect(experience().props('exportMode')).toBe(true)
    ready.resolve()
    await vi.waitFor(() => expect(experience().props('exportMode')).toBe(false))
    expect(captureRegion).toHaveBeenCalledOnce(); expect(wrapper.text()).toContain('写盘失败')
    expect(experience().props('exportMode')).toBe(false); expect(experience().props('motion')).toBe(true)
  })

  it('shows cancellation in the fit frame while the world is pending and never captures after cancellation', async () => {
    const ready = deferred(); prepareCapture.mockReturnValue(ready.promise)
    const captureRegion = vi.fn(async () => ({ ok: true })); window.wechatDesktop = { captureRegion }
    await open(); await wrapper.get('[data-capture]').trigger('click'); await flushPromises()
    expect(wrapper.get('.echo-page-export-progress').isVisible()).toBe(true)
    expect(wrapper.get('.echo-page-export-progress').attributes('style')).toContain('top: 12px')
    await wrapper.get('.echo-page-export-progress button').trigger('click'); await flushPromises()
    expect(experience().props('exportMode')).toBe(false)
    expect(wrapper.text()).toContain('已取消本次导出')
    ready.resolve(); await flushPromises()
    expect(captureRegion).not.toHaveBeenCalled()
  })

  it('hides progress for a rendered frame before batch capture and restores cancellation between pages', async () => {
    const firstCapture = deferred(), nextWorld = deferred(), frameProgress = []
    vi.stubGlobal('requestAnimationFrame', callback => setTimeout(() => { frameProgress.push(!!document.querySelector('.echo-page-export-progress')); callback(performance.now()) }, 0))
    prepareCapture.mockResolvedValueOnce(document.createElement('canvas')).mockReturnValue(nextWorld.promise)
    const bridge = { wrappedBatchBegin: vi.fn(async () => ({ ok: true, batchId: 'batch' })), wrappedBatchCapture: vi.fn(() => {
      expect(document.querySelector('.echo-page-export-progress')).toBeNull()
      expect(frameProgress).toEqual([true, false])
      return firstCapture.promise
    }), wrappedBatchFinish: vi.fn(), wrappedBatchAbort: vi.fn(async () => ({ ok: true })) }
    window.wechatDesktop = bridge
    await open(); await wrapper.get('[data-batch]').trigger('click')
    await vi.waitFor(() => expect(bridge.wrappedBatchCapture).toHaveBeenCalledOnce())
    expect(wrapper.find('.echo-page-export-progress').exists()).toBe(false)
    firstCapture.resolve({ ok: true }); await flushPromises()
    expect(prepareCapture).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.echo-page-export-progress').isVisible()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); await flushPromises()
    expect(bridge.wrappedBatchAbort).toHaveBeenCalledWith({ batchId: 'batch' })
    expect(bridge.wrappedBatchFinish).not.toHaveBeenCalled()
    expect(experience().props('exportMode')).toBe(false)
    nextWorld.resolve(); await flushPromises()
    expect(bridge.wrappedBatchCapture).toHaveBeenCalledOnce()
  })

  it('handles Escape only during export and removes its window listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener')
    const ready = deferred(); prepareCapture.mockReturnValue(ready.promise)
    window.wechatDesktop = { captureRegion: vi.fn(async () => ({ ok: true })) }
    await open()
    const idleEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); window.dispatchEvent(idleEscape)
    expect(idleEscape.defaultPrevented).toBe(false)
    await wrapper.get('[data-capture]').trigger('click'); await flushPromises()
    const activeEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); window.dispatchEvent(activeEscape); await flushPromises()
    expect(activeEscape.defaultPrevented).toBe(true)
    expect(experience().props('exportMode')).toBe(false)
    const handler = add.mock.calls.find(([name]) => name === 'keydown')[1]
    wrapper.unmount(); wrapper = null
    expect(remove).toHaveBeenCalledWith('keydown', handler)
    ready.resolve(); await flushPromises()
  })

  it('aborts batch output on the first failed page and restores the scene and selection', async () => {
    const bridge = { wrappedBatchBegin: vi.fn(async () => ({ ok: true, batchId: 'batch' })), wrappedBatchCapture: vi.fn(async () => ({ ok: false, error: '截图失败' })), wrappedBatchFinish: vi.fn(), wrappedBatchAbort: vi.fn(async () => ({ ok: true })) }
    window.wechatDesktop = bridge
    await open(); experience().vm.$emit('scene', 4); await flushPromises()
    await wrapper.get('[data-batch]').trigger('click')
    await vi.waitFor(() => expect(experience().props('exportMode')).toBe(false))
    expect(bridge.wrappedBatchCapture).toHaveBeenCalledOnce(); expect(bridge.wrappedBatchAbort).toHaveBeenCalledWith({ batchId: 'batch' }); expect(bridge.wrappedBatchFinish).not.toHaveBeenCalled()
    expect(experience().props('scene')).toBe(4); expect(restoredSelection).toEqual({ month: 2, phrase: 0, metric: 'voice', gather: true }); expect(experience().props('exportMode')).toBe(false)
  })

  it('captures exactly ten ready scenes then finishes once and returns to the original chapter', async () => {
    const bridge = { wrappedBatchBegin: vi.fn(async () => ({ ok: true, batchId: 'batch' })), wrappedBatchCapture: vi.fn(async () => ({ ok: true })), wrappedBatchFinish: vi.fn(async () => ({ ok: true, count: 10 })), wrappedBatchAbort: vi.fn(async () => ({ ok: true })) }
    window.wechatDesktop = bridge
    await open(); experience().vm.$emit('scene', 6); await flushPromises()
    await wrapper.get('[data-batch]').trigger('click')
    await vi.waitFor(() => {
      expect(bridge.wrappedBatchFinish).toHaveBeenCalledOnce()
      expect(experience().props('exportMode')).toBe(false)
    })
    expect(bridge.wrappedBatchCapture.mock.calls.map(([options]) => options.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(prepareCapture).toHaveBeenCalledTimes(10)
    expect(bridge.wrappedBatchAbort).not.toHaveBeenCalled()
    expect(experience().props('scene')).toBe(6)
    expect(experience().props('motion')).toBe(true)
  })

  it('rejects an incomplete ZIP response instead of reporting all chapters saved', async () => {
    const bridge = { wrappedBatchBegin: vi.fn(async () => ({ ok: true, batchId: 'batch' })), wrappedBatchCapture: vi.fn(async () => ({ ok: true })), wrappedBatchFinish: vi.fn(async () => ({ ok: true, count: 9 })), wrappedBatchAbort: vi.fn(async () => ({ ok: true })) }
    window.wechatDesktop = bridge
    await open(); await wrapper.get('[data-batch]').trigger('click')
    await vi.waitFor(() => {
      expect(bridge.wrappedBatchFinish).toHaveBeenCalledOnce()
      expect(experience().props('exportMode')).toBe(false)
    })
    expect(wrapper.text()).toContain('返回图片数量与 10 个章节不一致')
    expect(wrapper.text()).not.toContain('已保存 9')
    expect(experience().props('exportMode')).toBe(false)
  })

  it('exits capture mode and retains both failures when selection restoration throws', async () => {
    window.wechatDesktop = { captureRegion: vi.fn(async () => ({ ok: false, error: '写盘失败' })) }
    await open(); selectionFailure = new Error('选择状态损坏')
    await wrapper.get('[data-capture]').trigger('click')
    await vi.waitFor(() => expect(experience().props('exportMode')).toBe(false))
    expect(window.wechatDesktop.captureRegion).toHaveBeenCalledOnce()
    expect(experience().props('motion')).toBe(true)
    expect(wrapper.text()).toContain('写盘失败')
    expect(wrapper.text()).toContain('选择状态损坏')
  })

  it('cancels a pending capture on account change and never restores the old selection into the new report', async () => {
    const pending = deferred(); prepareCapture.mockReturnValue(pending.promise)
    const bridge = { wrappedBatchBegin: vi.fn(async () => ({ ok: true, batchId: 'batch' })), wrappedBatchCapture: vi.fn(async () => ({ ok: true })), wrappedBatchFinish: vi.fn(), wrappedBatchAbort: vi.fn(async () => ({ ok: true })) }
    window.wechatDesktop = bridge
    await open(); await wrapper.get('[data-batch]').trigger('click'); await flushPromises()
    expect(prepareCapture).toHaveBeenCalledOnce()
    store.selectedAccount.value = 'b'; await flushPromises()
    expect(bridge.wrappedBatchAbort).toHaveBeenCalledWith({ batchId: 'batch' })
    expect(bridge.wrappedBatchCapture).not.toHaveBeenCalled()
    expect(restoredSelection).toBeNull()
    pending.resolve(); await flushPromises()
    expect(bridge.wrappedBatchCapture).not.toHaveBeenCalled()
    expect(experience().props('cards')[0].account).toBe('b')
    expect(experience().props('exportMode')).toBe(false)
  })

  it('rejects broken scene images without calling the desktop capture bridge', async () => {
    const captureRegion = vi.fn(async () => ({ ok: true })); window.wechatDesktop = { captureRegion }
    await open()
    const image = document.createElement('img'); image.decode = vi.fn(async () => { throw new Error('broken image') })
    wrapper.get('.echo-page-stage').element.appendChild(image)
    await wrapper.get('[data-capture]').trigger('click'); await flushPromises()
    expect(captureRegion).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('图片解码失败')
    expect(experience().props('exportMode')).toBe(false)
  })
})
