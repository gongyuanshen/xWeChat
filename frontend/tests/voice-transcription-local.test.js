import { flushPromises, mount } from '@vue/test-utils'
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
const success = () => ({ text: '本地识别结果', model: 'small', language: 'zh' })
const deferred = () => {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

function setup(overrides = {}, message = voice()) {
  const api = {
    getVoiceTranscriptionStatus: vi.fn(async () => ({ available: true })),
    transcribeChatVoice: vi.fn(async () => success()),
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

describe('single-message local voice transcription', () => {
  it('posts the exact server ID and retry flag to the local transcription endpoint', async () => {
    const fetch = vi.fn(async () => success())
    vi.stubGlobal('useApiBase', () => '/api')
    vi.stubGlobal('$fetch', fetch)
    const payload = { account: 'account-a', server_id: '9007199254740993', force: true }
    await useApi().transcribeChatVoice(payload)
    expect(fetch).toHaveBeenCalledWith('/chat/media/voice/transcription', expect.objectContaining({
      method: 'POST', body: payload
    }))
  })

  it('checks local model availability before transcription and records its result', async () => {
    const { api, state, message } = setup()
    await state.transcribeVoiceLocally(message, { force: true })
    expect(api.getVoiceTranscriptionStatus).toHaveBeenCalledTimes(1)
    expect(api.transcribeChatVoice).toHaveBeenCalledWith({ account: 'account-a', server_id: '9007199254740993', force: true })
    expect(message).toMatchObject({ voiceTranscript: '本地识别结果', voiceTranscriptStatus: 'success',
      voiceTranscriptModel: 'small', voiceTranscriptLanguage: 'zh', voiceTranscriptError: '' })
  })

  it('shows why the local model is unavailable without starting transcription', async () => {
    const { api, state, message } = setup({
      getVoiceTranscriptionStatus: vi.fn(async () => ({ available: false, reason: '本地模型尚未下载' }))
    })
    await state.transcribeVoiceLocally(message)
    expect(api.transcribeChatVoice).not.toHaveBeenCalled()
    expect(message).toMatchObject({ voiceTranscriptStatus: 'error', voiceTranscriptError: '本地模型尚未下载' })
  })

  it('propagates status request failures while retaining their visible reason', async () => {
    const error = new Error('读取本地模型状态失败')
    const { state } = setup({ getVoiceTranscriptionStatus: vi.fn(async () => { throw error }) })
    await expect(state.refreshVoiceTranscriptionStatus()).rejects.toBe(error)
    expect(state.voiceTranscriptionAvailable.value).toBe(false)
    expect(state.voiceTranscriptionUnavailableReason.value).toBe(error.message)
    expect(state.voiceTranscriptionStatusLoading.value).toBe(false)
  })

  it('handles automatic status restoration failures and still reads cached text', async () => {
    const error = new Error('读取本地模型状态失败')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { state, message } = setup({
      getVoiceTranscriptionStatus: vi.fn(async () => { throw error }),
      lookupChatVoiceTranscriptionCache: vi.fn(async () => ({ items: {
        '9007199254740993': { text: '已有文字', model: 'small', language: 'zh' }
      } }))
    })
    await state.restoreVoiceTranscripts('friend')
    await flushPromises()
    expect(message.voiceTranscript).toBe('已有文字')
    expect(state.voiceTranscriptionUnavailableReason.value).toBe(error.message)
    expect(log).toHaveBeenCalledWith('读取本地语音转文字状态失败:', error)
    log.mockRestore()
  })

  it.each([
    [{ serverIdStr: '9007199254740993', serverId: 9007199254740992 }, '9007199254740993'],
    [{ serverIdStr: '', serverId: '9007199254740993' }, '9007199254740993'],
    [{ serverIdStr: '', serverId: 9007199254740993n }, '9007199254740993'],
    [{ serverIdStr: '', serverId: 17 }, '17'],
    [{ serverIdStr: '', serverId: 0 }, '0'],
    [{ serverIdStr: '', serverId: null }, ''],
    [{ serverIdStr: '', serverId: Number('9007199254740993') }, ''],
    [{ serverIdStr: 9007199254740992, serverId: 9007199254740992 }, '']
  ])('normalizes only exact server IDs, case %#', (identity, expected) => {
    const normalize = createMessageNormalizer({ apiBase: '/api', getSelectedAccount: () => 'account-a',
      getSelectedContact: () => ({ username: 'friend' }) })
    expect(normalize(voice(identity)).serverIdStr).toBe(expected)
  })

  it('prevents duplicate local requests while loading, including a stale message copy', async () => {
    const pending = deferred()
    const { api, state, message } = setup({ transcribeChatVoice: vi.fn(() => pending.promise) })
    const stale = { ...message }
    const first = state.transcribeVoiceLocally(message)
    expect(message.voiceTranscriptStatus).toBe('loading')
    await state.transcribeVoiceLocally(stale)
    await flushPromises()
    expect(api.transcribeChatVoice).toHaveBeenCalledTimes(1)
    expect(api.getVoiceTranscriptionStatus).toHaveBeenCalledTimes(1)
    pending.resolve(success())
    await first
  })

  it.each([
    { data: { detail: { message: '本地模型推理失败' } }, message: 'HTTP 500' },
    { data: { detail: '语音文件不可用' }, message: 'HTTP 404' }
  ])('shows the backend failure without returning a successful transcript', async (error) => {
    const { state, message } = setup({ transcribeChatVoice: vi.fn(async () => { throw error }) })
    await state.transcribeVoiceLocally(message)
    expect(message.voiceTranscriptStatus).toBe('error')
    expect(message.voiceTranscript).toBe('')
    expect(message.voiceTranscriptError).toBe(typeof error.data.detail === 'string'
      ? error.data.detail : error.data.detail.message)
  })

  it.each(['account', 'chat'])('discards a late local result after switching %s', async (scope) => {
    const pending = deferred()
    const { state, message, selectedAccount, selectedContact } = setup({ transcribeChatVoice: vi.fn(() => pending.promise) })
    const request = state.transcribeVoiceLocally(message)
    await flushPromises()
    if (scope === 'account') selectedAccount.value = 'account-b'
    else selectedContact.value = { username: 'other' }
    await nextTick()
    pending.resolve(success())
    await request
    expect(message.voiceTranscript).toBe('')
    expect(message.voiceTranscriptStatus).toBe('idle')
  })

  it('reports an empty local response as an error', async () => {
    const { state, message } = setup({ transcribeChatVoice: vi.fn(async () => ({ text: '' })) })
    await state.transcribeVoiceLocally(message)
    expect(message).toMatchObject({ voiceTranscriptStatus: 'error', voiceTranscript: '',
      voiceTranscriptError: '本地语音转文字未返回文字。' })
  })

  it('offers only local transcription in the context menu and closes it before retrying', async () => {
    const { state, message } = setup({}, voice({ voiceTranscriptStatus: 'error' }))
    const closeContextMenu = vi.fn()
    const transcribeVoiceLocally = vi.fn(() => expect(closeContextMenu).toHaveBeenCalledTimes(1))
    const wrapper = mount(ChatOverlays, { props: { state: {
      ...state, privacyMode: false, timeSidebarOpen: false, messageSearchOpen: false,
      avatarPreviewUrl: null, editMessageDialog: { visible: false }, chatHistoryModalVisible: false,
      contextMenu: { visible: true, x: 0, y: 0, message }, mediaContextMenu: { visible: false },
      voiceTranscriptionStatusLoading: false, transcribeVoiceLocally, closeContextMenu
    } }, global: { stubs: { ChatExportDialog: true, ChatHistoryFloatingWindows: true, ErrorNotice: true },
      config: { warnHandler: () => {} } } })
    wrappers.push(wrapper)
    const actions = wrapper.findAll('button').filter(button => button.text().includes('转文字'))
    expect(actions.map(button => button.text())).toEqual(['本地转文字'])
    await actions[0].trigger('click')
    expect(transcribeVoiceLocally).toHaveBeenCalledWith(message, { force: true })
  })
})
