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
  transcribeVoiceNatively: vi.fn(),
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
    expect(wrapper.find('.wechat-voice-transcript__native-action').exists()).toBe(false)
  })

  it('微信入口不依赖本地能力检查，并明确提示激活微信和定位歧义', async () => {
    const state = { ...makeState(), voiceTranscriptionAvailable: false,
      voiceTranscriptionStatusKnown: false, voiceTranscriptionStatusLoading: true }
    const message = makeMessage()
    const wrapper = mount(MessageContent, { ...mountOptions, props: { state, message } })
    const button = wrapper.get('button[aria-label="微信转文字"]')
    expect(button.attributes('title')).toContain('切换微信')
    expect(button.attributes('title')).toContain('同一分钟')
    await button.trigger('click')
    expect(state.transcribeVoiceNatively).toHaveBeenCalledWith(message)
    expect(state.transcribeVoiceLocally).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('本地模型未就绪')
  })

  it('微信失败保留真实错误和两个显式入口，不追加本地模型错误', async () => {
    const state = { ...makeState(), voiceTranscriptionAvailable: false }
    const message = makeMessage({ voiceTranscriptStatus: 'error', _voiceTranscriptionSource: 'wechat',
      voiceTranscriptError: '该分钟存在多条语音，无法唯一定位' })
    const wrapper = mount(MessageContent, { ...mountOptions, props: { state, message } })
    expect(wrapper.text()).toContain('该分钟存在多条语音，无法唯一定位')
    expect(wrapper.text()).not.toContain('本地模型未就绪')
    expect(wrapper.get('button[aria-label="本地转文字"]').exists()).toBe(true)
    await wrapper.get('button[aria-label="微信转文字"]').trigger('click')
    expect(state.transcribeVoiceNatively).toHaveBeenCalledWith(message)
    expect(state.transcribeVoiceLocally).not.toHaveBeenCalled()
  })

  it('已有文字不会隐藏后续微信请求错误，保留原文字及其来源', () => {
    const message = makeMessage({ voiceTranscript: '保留原有本地文字', voiceTranscriptModel: 'small',
      voiceTranscriptStatus: 'error', _voiceTranscriptionSource: 'wechat', voiceTranscriptError: '当前微信账号与消息来源不一致' })
    const wrapper = mount(MessageContent, { ...mountOptions, props: { state: makeState(), message } })
    expect(wrapper.text()).toContain('保留原有本地文字')
    expect(wrapper.get('[data-transcript-source="project"]').text()).toBe('本项目转写')
    expect(wrapper.text()).toContain('当前微信账号与消息来源不一致')
  })

  it('微信转写中移除两种操作，成功后沿用微信来源标记', async () => {
    const wrapper = mount(MessageContent, { ...mountOptions, props: {
      state: makeState(), message: makeMessage({ voiceTranscriptStatus: 'loading', _voiceTranscriptionSource: 'wechat' })
    } })
    expect(wrapper.text()).toContain('正在微信转文字')
    expect(wrapper.find('button[aria-label="微信转文字"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="本地转文字"]').exists()).toBe(false)
    await wrapper.setProps({ message: makeMessage({ voiceTranscriptStatus: 'success',
      voiceTranscript: '微信识别结果', voiceTranscriptModel: 'wechat-native' }) })
    expect(wrapper.get('[data-transcript-source="wechat"]').text()).toBe('微信原生转写')
    expect(wrapper.text()).toContain('微信识别结果')
  })

  it('合并转发浮窗即使原会话有微信方法也不提供新转写入口', () => {
    const state = { ...makeState(), floatingWindows: [{ id: 'history-1', kind: 'chatHistory',
      title: '聊天记录', x: 10, y: 10, zIndex: 10, width: 420, height: 500, records: [makeMessage()] }],
      focusFloatingWindow: vi.fn(), startFloatingWindowDrag: vi.fn(), closeFloatingWindow: vi.fn() }
    const wrapper = mount(ChatHistoryFloatingWindows, { ...mountOptions, props: { state } })
    expect(wrapper.find('button[aria-label="微信转文字"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="本地转文字"]').exists()).toBe(false)
  })
})
