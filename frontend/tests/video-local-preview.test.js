import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatOverlays from '~/components/chat/ChatOverlays.vue'
import { useChatMessages } from '~/composables/chat/useChatMessages'
import { useApi } from '~/composables/useApi'

vi.mock('~/lib/server-error-logging', () => ({ reportServerError: vi.fn() }))

const SOURCE = 'http://localhost:8000/api/chat/media/video?account=account-a&md5=abcdef&username=friend%40chatroom'
const PREVIEW = `http://localhost:8000/api/chat/media/video/preview/${'1'.repeat(64)}?account=account-a`
const wrappers = []
let originalClient
beforeEach(() => {
  originalClient = process.client
  process.client = true
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  process.client = originalClient
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const setup = (generate = vi.fn()) => {
  let state
  const selectedAccount = ref('account-a')
  const selectedContact = ref({ username: 'friend' })
  const wrapper = mount(defineComponent({
    setup() {
      state = useChatMessages({
        api: { generateChatVideoPreview: generate }, apiBase: 'http://localhost:8000/api',
        selectedAccount, selectedContact,
        privacyMode: ref(false), searchContext: ref({ active: false })
      })
      return () => h(ChatOverlays, { state: {
        ...state, contextMenu: { visible: false }, mediaContextMenu: { visible: false },
        multiSelectMode: false, chatHistoryModalVisible: false,
        timeSidebarOpen: false, messageSearchOpen: false, avatarPreviewUrl: null,
        editMessageDialog: { visible: false }, privacyMode: false,
        ...state
      } })
    }
  }), { global: {
    stubs: {
      ChatExportDialog: true, ChatHistoryFloatingWindows: true, ContactProfileCard: true,
      ErrorNotice: { props: ['message'], template: '<div role="alert">{{ message }}</div>' }
    },
    config: { warnHandler: () => {} }
  } })
  wrappers.push(wrapper)
  state.openVideoPreview(SOURCE, '/poster.jpg')
  return { wrapper, state, selectedAccount, selectedContact, generate }
}

const readiness = async (wrapper, { width = 0, height = 0, readyState = 2, event = 'loadeddata' } = {}) => {
  await nextTick()
  const video = wrapper.get('video')
  Object.defineProperties(video.element, {
    videoWidth: { configurable: true, value: width }, videoHeight: { configurable: true, value: height },
    readyState: { configurable: true, value: readyState }
  })
  await video.trigger(event)
  return video
}

describe('explicit local video preview', () => {
  it('waits for media readiness, exposes missing picture, and never starts conversion automatically', async () => {
    const { wrapper, state, generate } = setup()
    await readiness(wrapper, { event: 'loadedmetadata', readyState: 1 })
    expect(state.previewVideoError.value).toBe('')
    await readiness(wrapper)
    expect(wrapper.text()).toContain('当前环境无法显示此视频的画面')
    expect(wrapper.text()).not.toContain('HEVC')
    expect(wrapper.get('[data-action="generate-video-preview"]').text()).toBe('生成本地预览')
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('does not offer conversion for a video with a decoded picture', async () => {
    const { wrapper, state, generate } = setup()
    await readiness(wrapper, { width: 640, height: 480 })
    expect(state.previewVideoError.value).toBe('')
    expect(wrapper.find('[data-action="generate-video-preview"]').exists()).toBe(false)
    expect(generate).not.toHaveBeenCalled()
  })

  it('runs only on click, switches to the returned preview and preserves the original URL', async () => {
    const task = deferred()
    const { wrapper, state, generate } = setup(vi.fn(() => task.promise))
    await readiness(wrapper)
    await wrapper.get('[data-action="generate-video-preview"]').trigger('click')
    expect(generate).toHaveBeenCalledWith('?account=account-a&md5=abcdef&username=friend%40chatroom', { signal: expect.any(AbortSignal) })
    expect(wrapper.text()).toContain('正在生成本地预览')
    expect(wrapper.find('[data-action="cancel-video-preview"]').exists()).toBe(true)
    expect(state.previewVideoUrl.value).toBe(SOURCE)
    await state.generateVideoPreview()
    expect(generate).toHaveBeenCalledTimes(1)
    task.resolve({ status: 'success', url: PREVIEW })
    await flushPromises()
    expect(wrapper.get('video').attributes('src')).toBe(PREVIEW)
    expect(state.previewVideoSourceUrl.value).toBe(SOURCE)
    expect(wrapper.text()).toContain('本地预览已生成')
  })

  it.each(['cancel', 'close', 'switch', 'conversation', 'account', 'unmount'])('aborts on %s and discards late completion', async (action) => {
    const task = deferred()
    const { wrapper, state, selectedAccount, selectedContact, generate } = setup(vi.fn(() => task.promise))
    await readiness(wrapper)
    const pending = state.generateVideoPreview()
    const signal = generate.mock.calls[0][1].signal
    if (action === 'cancel') state.cancelVideoPreviewGeneration()
    if (action === 'close') state.closeVideoPreview()
    if (action === 'switch') state.openVideoPreview(SOURCE.replace('abcdef', 'fedcba'))
    if (action === 'conversation') selectedContact.value = { username: 'another' }
    if (action === 'account') selectedAccount.value = 'account-b'
    if (action === 'unmount') wrapper.unmount()
    await nextTick()
    expect(signal.aborted).toBe(true)
    task.resolve({ status: 'success', url: PREVIEW })
    await pending
    expect(state.previewVideoUrl.value).not.toBe(PREVIEW)
    expect(state.previewVideoGenerating.value).toBe(false)
  })

  it('displays the backend error and permits an explicit retry', async () => {
    const { wrapper, state, generate } = setup(vi.fn().mockRejectedValue({ data: { detail: '视频源不存在' } }))
    await readiness(wrapper)
    await wrapper.get('[data-action="generate-video-preview"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('视频源不存在')
    expect(state.previewVideoUrl.value).toBe(SOURCE)
    expect(wrapper.get('[data-action="generate-video-preview"]').exists()).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('does not request conversion for a remote video', async () => {
    const { wrapper, state, generate } = setup()
    state.openVideoPreview('https://example.invalid/video.mp4')
    await nextTick()
    await wrapper.get('video').trigger('error')
    expect(wrapper.text()).toContain('此视频来源不支持生成本地预览')
    expect(wrapper.find('[data-action="generate-video-preview"]').exists()).toBe(false)
    await state.generateVideoPreview()
    expect(generate).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'success', url: 'https://example.invalid/preview.mp4' },
    { status: 'success', url: PREVIEW.replace('account-a', 'account-b') },
    { status: 'success' }, { status: 'pending', url: PREVIEW }
  ])('rejects an invalid success response without changing the source', async result => {
    const { wrapper, state } = setup(vi.fn().mockResolvedValue(result))
    await readiness(wrapper)
    await state.generateVideoPreview()
    expect(state.previewVideoUrl.value).toBe(SOURCE)
    expect(state.previewVideoError.value).toContain('预览响应')
    expect(state.previewVideoGenerating.value).toBe(false)
  })

  it('ignores readiness events from the video replaced while conversion completed', async () => {
    const { wrapper, state } = setup(vi.fn().mockResolvedValue({ status: 'success', url: PREVIEW }))
    const oldVideo = await readiness(wrapper)
    await state.generateVideoPreview()
    state.onPreviewVideoReady({ currentTarget: oldVideo.element })
    expect(state.previewVideoError.value).toBe('')
  })
})

it('sends a bodyless explicit POST with cancellation and no automatic retry', async () => {
  vi.stubGlobal('useApiBase', () => 'http://localhost:8000/api')
  const fetch = vi.fn().mockResolvedValue({ status: 'success', url: PREVIEW })
  vi.stubGlobal('$fetch', fetch)
  const signal = new AbortController().signal
  await useApi().generateChatVideoPreview('?account=a&file_id=x%26y', { signal })
  expect(fetch).toHaveBeenCalledWith('/chat/media/video/preview?account=a&file_id=x%26y', expect.objectContaining({ method: 'POST', signal, retry: 0 }))
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('body')
})
