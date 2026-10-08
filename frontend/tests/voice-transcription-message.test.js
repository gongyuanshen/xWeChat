import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import MessageContent from '~/components/chat/MessageContent.vue'
import ChatHistoryFloatingWindows from '~/components/chat/ChatHistoryFloatingWindows.vue'
import MessageItem from '~/components/chat/MessageItem.vue'

const makeMessage = (overrides = {}) => ({
  id: 'voice-1',
  serverIdStr: '1234567890123456789',
  renderType: 'voice',
  sender: '好友',
  senderDisplayName: '好友',
  isSent: false,
  isGroup: false,
  voiceUrl: '/api/chat/media/voice?server_id=1234567890123456789',
  voiceDuration: 3000,
  voiceTranscript: '',
  voiceTranscriptStatus: 'idle',
  voiceTranscriptError: '',
  ...overrides
})

const makeState = () => ({
  privacyMode: false,
  voiceTranscriptionStatusKnown: true,
  voiceTranscriptionStatusLoading: false,
  voiceTranscriptionAvailable: true,
  voiceTranscriptionUnavailableReason: '',
  selectedContact: { username: 'wxid_friend' },
  transcribeVoiceLocally: vi.fn(),
  getVoiceWidth: () => '96px',
  getVoiceDurationInSeconds: () => 3,
  playVoice: vi.fn(),
  setVoiceRef: vi.fn(),
  playingVoiceId: null,
  openMediaContextMenu: vi.fn(),
  onMessageAvatarMouseEnter: vi.fn(),
  onMessageAvatarMouseLeave: vi.fn(),
  isMentionContactProfileCardForMessage: () => false,
  contactProfileCardOpen: false,
  contactProfileCardMessageId: '',
  highlightServerIdStr: '',
  highlightMessageId: ''
})

const mountOptions = {
  global: {
    stubs: {
      ContactProfileCard: true,
      ChatLocationCard: true,
      FileTypeIcon: true,
      LinkCard: true,
      ErrorNotice: true
    },
    directives: {
      chatLazySrc: () => {},
      chatMediaPerf: () => {}
    }
  }
}

describe('语音消息转写状态', () => {
  it('MessageContent 在 message prop 被替换后立即刷新缓存文字', async () => {
    const wrapper = mount(MessageContent, {
      ...mountOptions,
      props: { state: makeState(), message: makeMessage() }
    })

    expect(wrapper.text()).toContain('转文字')
    expect(wrapper.get('.wechat-voice-transcript__local-action').text()).toContain('本地转文字')
    expect(wrapper.get('.wechat-voice-transcript__icon').classes()).toContain('fa-language')
    expect(wrapper.findAll('.wechat-voice-transcript__action')).toHaveLength(1)
    expect(wrapper.find('button[aria-label="微信转文字"]').exists()).toBe(false)
    await wrapper.setProps({
      message: makeMessage({
        voiceTranscriptStatus: 'success',
        voiceTranscript: '缓存恢复的简体文字',
        voiceTranscriptModel: 'tiny'
      })
    })

    expect(wrapper.text()).toContain('缓存恢复的简体文字')
    expect(wrapper.text()).toContain('本项目转写')
    expect(wrapper.get('[data-transcript-source="project"]').attributes('title')).toContain('tiny')
    expect(wrapper.text()).not.toContain('转文字')
  })

  it('MessageItem 跟随父级替换消息对象展示 loading、成功、失败和重试', async () => {
    const state = makeState()
    const wrapper = mount(MessageItem, {
      ...mountOptions,
      props: { state, message: makeMessage() }
    })

    await wrapper.get('.wechat-voice-transcript__action').trigger('click')
    expect(state.transcribeVoiceLocally).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ message: makeMessage({ voiceTranscriptStatus: 'loading' }) })
    expect(wrapper.text()).toContain('正在转文字')

    await wrapper.setProps({
      message: makeMessage({ voiceTranscriptStatus: 'success', voiceTranscript: '识别成功的文字', voiceTranscriptModel: 'medium' })
    })
    expect(wrapper.text()).toContain('识别成功的文字')
    expect(wrapper.text()).toContain('本项目转写')

    const failedMessage = makeMessage({
      voiceTranscriptStatus: 'error',
      voiceTranscriptError: 'CUDA 不可用，已回退失败'
    })
    await wrapper.setProps({ message: failedMessage })
    expect(wrapper.text()).toContain('CUDA 不可用，已回退失败')
    expect(wrapper.get('.wechat-voice-transcript__local-action').attributes('title')).toContain('使用本地转文字')

    await wrapper.get('.wechat-voice-transcript__local-action').trigger('click')
    await nextTick()
    expect(state.transcribeVoiceLocally).toHaveBeenLastCalledWith(failedMessage, { force: true })
  })

  it('本地模型尚未下载时仍显示本地入口并保留模型原因', async () => {
    const state = {
      ...makeState(),
      voiceTranscriptionAvailable: false,
      voiceTranscriptionUnavailableReason: 'Whisper 模型尚未下载到本机缓存。'
    }
    const wrapper = mount(MessageContent, {
      ...mountOptions,
      props: { state, message: makeMessage() }
    })

    expect(wrapper.get('.wechat-voice-transcript__local-action').text()).toContain('本地转文字')
    expect(wrapper.get('.wechat-voice-transcript__local-action').attributes('title')).toContain('Whisper 模型尚未下载到本机缓存。')
    await wrapper.get('.wechat-voice-transcript__local-action').trigger('click')
    expect(state.transcribeVoiceLocally).toHaveBeenCalledWith(expect.objectContaining({ id: 'voice-1' }))
  })

  it('合并转发浮窗在不提供新转写操作时仍展示微信原生文字', () => {
    const state = {
      ...makeState(),
      floatingWindows: [{
        id: 'history-1',
        kind: 'chatHistory',
        title: '聊天记录',
        x: 10,
        y: 10,
        zIndex: 10,
        width: 420,
        height: 500,
        records: [makeMessage({
          voiceTranscriptStatus: '',
          voiceTranscript: '微信已经转写的合成文字',
          voiceTranscriptModel: 'wechat-native'
        })]
      }],
      focusFloatingWindow: vi.fn(),
      startFloatingWindowDrag: vi.fn(),
      closeFloatingWindow: vi.fn()
    }
    const wrapper = mount(ChatHistoryFloatingWindows, {
      ...mountOptions,
      props: { state }
    })

    expect(wrapper.text()).toContain('微信已经转写的合成文字')
    expect(wrapper.text()).toContain('微信原生转写')
    expect(wrapper.get('[data-transcript-source="wechat"]').attributes('title')).toContain('微信客户端原生')
    expect(wrapper.find('.wechat-voice-transcript__action').exists()).toBe(false)
    expect(wrapper.find('.wechat-voice-transcript__local-action').exists()).toBe(false)
  })

  it('检查本地模型时显示进度且不提供其他转写入口', () => {
    const state = { ...makeState(), voiceTranscriptionAvailable: false,
      voiceTranscriptionStatusKnown: false, voiceTranscriptionStatusLoading: true }
    const message = makeMessage()
    const wrapper = mount(MessageContent, { ...mountOptions, props: { state, message } })
    expect(wrapper.text()).toContain('正在检查本地模型')
    expect(wrapper.findAll('.wechat-voice-transcript__action')).toHaveLength(0)
    expect(wrapper.find('button[aria-label="微信转文字"]').exists()).toBe(false)
  })

  it('本地模型未就绪时保留真实错误和本地重试入口', async () => {
    const state = { ...makeState(), voiceTranscriptionAvailable: false }
    const message = makeMessage({ voiceTranscriptStatus: 'error',
      voiceTranscriptError: 'Whisper 模型尚未下载到本机缓存。' })
    const wrapper = mount(MessageContent, { ...mountOptions, props: { state, message } })
    expect(wrapper.text()).toContain('Whisper 模型尚未下载到本机缓存。')
    expect(wrapper.text()).toContain('本地模型未就绪')
    expect(wrapper.findAll('.wechat-voice-transcript__action')).toHaveLength(1)
    expect(wrapper.find('button[aria-label="微信转文字"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="本地转文字"]').trigger('click')
    expect(state.transcribeVoiceLocally).toHaveBeenCalledWith(message, { force: true })
  })

  it('本地转写中隐藏操作，恢复已有微信文字时保留来源标记', async () => {
    const wrapper = mount(MessageContent, { ...mountOptions, props: {
      state: makeState(), message: makeMessage({ voiceTranscriptStatus: 'loading' })
    } })
    expect(wrapper.text()).toContain('正在转文字')
    expect(wrapper.find('button[aria-label="微信转文字"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="本地转文字"]').exists()).toBe(false)
    await wrapper.setProps({ message: makeMessage({ voiceTranscriptStatus: 'success',
      voiceTranscript: '微信识别结果', voiceTranscriptModel: 'wechat-native' }) })
    expect(wrapper.get('[data-transcript-source="wechat"]').text()).toBe('微信原生转写')
    expect(wrapper.text()).toContain('微信识别结果')
  })

  it('合并转发浮窗即使原会话支持本地转写也不提供新转写入口', () => {
    const state = { ...makeState(), floatingWindows: [{ id: 'history-1', kind: 'chatHistory',
      title: '聊天记录', x: 10, y: 10, zIndex: 10, width: 420, height: 500, records: [makeMessage()] }],
      focusFloatingWindow: vi.fn(), startFloatingWindowDrag: vi.fn(), closeFloatingWindow: vi.fn() }
    const wrapper = mount(ChatHistoryFloatingWindows, { ...mountOptions, props: { state } })
    expect(wrapper.find('button[aria-label="微信转文字"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="本地转文字"]').exists()).toBe(false)
  })
})
