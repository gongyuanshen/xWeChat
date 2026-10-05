import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useApi } from '~/composables/useApi'
import { useChatMessages } from '~/composables/chat/useChatMessages'
import { createMessageNormalizer } from '~/lib/chat/message-normalizer'
import ChatOverlays from '~/components/chat/ChatOverlays.vue'

vi.mock('~/lib/server-error-logging', () => ({ reportServerError: vi.fn() }))

const wrappers = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.unstubAllGlobals()
})

const voice = (overrides = {}) => ({
  id: `message_0:Msg_${'a'.repeat(32)}:17`, renderType: 'voice',
  serverIdStr: '9007199254740993', createTime: 1791184021,
  voiceTranscript: '', voiceTranscriptStatus: 'idle', voiceTranscriptError: '',
  ...overrides
})
const payload = () => ({ account: 'account-a', username: 'friend', display_name: '好友',
  message_id: voice().id, server_id: '9007199254740993', create_time: 1791184021 })
const success = (overrides = {}) => ({ ...payload(), status: 'success', text: '微信识别结果',
  model: 'wechat-native', generation: `generation-${'b'.repeat(32)}`, already_completed: false, ...overrides })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(overrides = {}, message = voice()) {
  const api = {
    getVoiceTranscriptionStatus: vi.fn(async () => ({ available: false, reason: '本地模型尚未下载' })),
    transcribeChatVoice: vi.fn(async () => ({ text: '本地结果', model: 'small' })),
    transcribeChatVoiceNative: vi.fn(async () => success()),
    ...overrides
  }
  const selectedAccount = ref('account-a')
  const selectedContact = ref({ username: 'friend', name: '好友' })
  let state
  const wrapper = mount(defineComponent({
    setup() {
      state = useChatMessages({ api, apiBase: '/api', selectedAccount, selectedContact,
        privacyMode: ref(false), searchContext: ref({ active: false }) })
      return () => h('div')
    }
  }))
  wrappers.push(wrapper)
  state.allMessages.value.friend = [message]
  return { api, state, selectedAccount, selectedContact, message: state.allMessages.value.friend[0] }
}

describe('single-message native voice transcription', () => {
  it('posts exact message identity to the explicit native endpoint', async () => {
    const fetch = vi.fn(async () => success())
    vi.stubGlobal('useApiBase', () => '/api')
    vi.stubGlobal('$fetch', fetch)
    await useApi().transcribeChatVoiceNative(payload())
    expect(fetch).toHaveBeenCalledWith('/chat/media/voice/transcription/native', expect.objectContaining({
      method: 'POST', body: payload()
    }))
  })

  it('runs without consulting local model availability and records the native source', async () => {
    const { api, state, message } = setup()
    await state.transcribeVoiceNatively(message)
    expect(api.transcribeChatVoiceNative).toHaveBeenCalledWith(payload())
    expect(api.getVoiceTranscriptionStatus).not.toHaveBeenCalled()
    expect(api.transcribeChatVoice).not.toHaveBeenCalled()
    expect(message).toMatchObject({ voiceTranscript: '微信识别结果', voiceTranscriptStatus: 'success',
      voiceTranscriptModel: 'wechat-native', voiceTranscriptError: '' })
  })

  it.each([
    { serverIdStr: '', serverId: Number('9007199254740993') },
    { serverIdStr: 9007199254740992 },
    { serverIdStr: '0' }, { id: '17' }, { id: '' }, { createTime: 0 }, { createTime: undefined }
  ])('rejects missing or imprecise identity before the native request: %j', async (identity) => {
    const { api, state, message } = setup({}, voice(identity))
    await state.transcribeVoiceNatively(message)
    expect(api.transcribeChatVoiceNative).not.toHaveBeenCalled()
    expect(message.voiceTranscriptStatus).toBe('error')
    expect(message.voiceTranscriptError).toContain('消息身份')
  })

  it('does not invent an exact server ID from an unsafe legacy Number during normalization', () => {
    const normalize = createMessageNormalizer({ apiBase: '/api', getSelectedAccount: () => 'account-a',
      getSelectedContact: () => ({ username: 'friend' }) })
    const normalized = normalize(voice({ serverIdStr: '', serverId: Number('9007199254740993') }))
    expect(normalized.serverIdStr).toBe('')
    expect(normalize(voice({ serverId: Number('9007199254740993') })).serverIdStr).toBe('9007199254740993')
  })

  it.each([
    [{ serverIdStr: '9007199254740993', serverId: 9007199254740992 }, '9007199254740993'],
    [{ serverIdStr: '', serverId: '9007199254740993' }, '9007199254740993'],
    [{ serverIdStr: '', serverId: 9007199254740993n }, '9007199254740993'],
    [{ serverIdStr: '', serverId: 17 }, '17'],
    [{ serverIdStr: '', serverId: 0 }, '0'],
    [{ serverIdStr: '', serverId: null }, ''],
    [{ serverIdStr: 9007199254740992, serverId: 9007199254740992 }, '']
  ])('normalizes only exact server IDs, case %#', (identity, expected) => {
    const normalize = createMessageNormalizer({ apiBase: '/api', getSelectedAccount: () => 'account-a',
      getSelectedContact: () => ({ username: 'friend' }) })
    expect(normalize(voice(identity)).serverIdStr).toBe(expected)
  })

  it('prevents another native or local request while this message is loading, including a stale copy', async () => {
    const pending = deferred()
    const { api, state, message } = setup({ transcribeChatVoiceNative: vi.fn(() => pending.promise) })
    const stale = { ...message }
    const first = state.transcribeVoiceNatively(message)
    expect(message.voiceTranscriptStatus).toBe('loading')
    await state.transcribeVoiceNatively(stale)
    await state.transcribeVoiceLocally(stale)
    expect(api.transcribeChatVoiceNative).toHaveBeenCalledTimes(1)
    expect(api.transcribeChatVoice).not.toHaveBeenCalled()
    expect(api.getVoiceTranscriptionStatus).not.toHaveBeenCalled()
    pending.resolve(success())
    await first
  })

  it.each([
    { data: { detail: { message: '该分钟存在多条语音，无法唯一定位' } }, message: 'HTTP 409' },
    { data: { detail: '微信窗口未就绪' }, message: 'HTTP 503' }
  ])('shows the backend error without falling back to local transcription', async (error) => {
    const { api, state, message } = setup({ transcribeChatVoiceNative: vi.fn(async () => { throw error }) })
    await state.transcribeVoiceNatively(message)
    expect(message.voiceTranscriptStatus).toBe('error')
    expect(message.voiceTranscriptError).toBe(typeof error.data.detail === 'string'
      ? error.data.detail : error.data.detail.message)
    expect(api.transcribeChatVoice).not.toHaveBeenCalled()
    expect(api.getVoiceTranscriptionStatus).not.toHaveBeenCalled()
  })

  it.each(['account', 'username', 'message_id', 'server_id', 'model', 'status'])('rejects a mismatched %s in the response', async (field) => {
    const { state, message } = setup({ transcribeChatVoiceNative: vi.fn(async () => success({ [field]: 'wrong' })) })
    await state.transcribeVoiceNatively(message)
    expect(message.voiceTranscriptStatus).toBe('error')
    expect(message.voiceTranscript).toBe('')
    expect(message.voiceTranscriptError).toContain('响应')
  })

  it.each(['account', 'chat'])('discards a late native result after switching %s', async (scope) => {
    const pending = deferred()
    const { state, message, selectedAccount, selectedContact } = setup({ transcribeChatVoiceNative: vi.fn(() => pending.promise) })
    const request = state.transcribeVoiceNatively(message)
    if (scope === 'account') selectedAccount.value = 'account-b'
    else selectedContact.value = { username: 'other' }
    await nextTick()
    pending.resolve(success())
    await request
    expect(message.voiceTranscript).toBe('')
    expect(message.voiceTranscriptStatus).toBe('idle')
  })

  it('keeps the explicit local path and local model availability check', async () => {
    const { api, state, message } = setup()
    await state.transcribeVoiceLocally(message)
    expect(api.getVoiceTranscriptionStatus).toHaveBeenCalledTimes(1)
    expect(api.transcribeChatVoiceNative).not.toHaveBeenCalled()
    expect(message.voiceTranscriptError).toBe('本地模型尚未下载')
  })

  it('preserves successful local retries without selecting the native provider', async () => {
    const { api, state, message } = setup({ getVoiceTranscriptionStatus: vi.fn(async () => ({ available: true })) })
    await state.transcribeVoiceLocally(message, { force: true })
    expect(api.transcribeChatVoice).toHaveBeenCalledWith({ account: 'account-a', server_id: '9007199254740993', force: true })
    expect(api.transcribeChatVoiceNative).not.toHaveBeenCalled()
    expect(message).toMatchObject({ voiceTranscriptStatus: 'success', voiceTranscript: '本地结果', voiceTranscriptModel: 'small' })
  })

  it.each([{ text: '' }, { server_id: 9007199254740992 }])('does not accept an empty or imprecise native response, case %#', async (result) => {
    const { state, message } = setup({ transcribeChatVoiceNative: vi.fn(async () => success(result)) })
    await state.transcribeVoiceNatively(message)
    expect(message.voiceTranscriptStatus).toBe('error')
    expect(message.voiceTranscript).toBe('')
  })

  it('exposes an independent native context-menu action and closes the menu before dispatch', async () => {
    const { state, message } = setup()
    const closeContextMenu = vi.fn()
    const transcribeVoiceNatively = vi.fn(() => expect(closeContextMenu).toHaveBeenCalledTimes(1))
    const wrapper = mount(ChatOverlays, { props: { state: {
      ...state, privacyMode: false, timeSidebarOpen: false, messageSearchOpen: false,
      avatarPreviewUrl: null, editMessageDialog: { visible: false }, chatHistoryModalVisible: false,
      contextMenu: { visible: true, x: 0, y: 0, message }, mediaContextMenu: { visible: false },
      voiceTranscriptionStatusLoading: true, transcribeVoiceNatively, closeContextMenu
    } }, global: { stubs: { ChatExportDialog: true, ChatHistoryFloatingWindows: true, ErrorNotice: true },
      config: { warnHandler: () => {} } } })
    wrappers.push(wrapper)
    const nativeAction = wrapper.findAll('button').find(button => button.text() === '微信转文字')
    expect(nativeAction).toBeDefined()
    await nativeAction.trigger('click')
    expect(transcribeVoiceNatively).toHaveBeenCalledWith(message)
  })
})
