import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import LinkCard from '~/components/chat/LinkCard.vue'
import MessageContent from '~/components/chat/MessageContent.vue'
import ChatHistoryFloatingWindows from '~/components/chat/ChatHistoryFloatingWindows.vue'
import { useChatHistoryWindows } from '~/composables/chat/useChatHistoryWindows'

const global = {
  stubs: { ErrorNotice: true },
  directives: { chatLazySrc: () => {}, chatMediaPerf: () => {} }
}

const finder = {
  renderType: 'link', linkType: 'finder',
  url: 'https://support.weixin.qq.com/cgi-bin/mmsupport-bin/readtemplate?t=page/upgrade',
  title: '视频描述', content: '视频描述', from: '视频作者',
  preview: 'https://example.test/cover.jpg'
}

describe('视频号卡片由用户在微信原消息中播放', () => {
  it.each(['default', 'cover'])('视频号不产生外链，保留封面与作者（%s）', async variant => {
    const wrapper = mount(LinkCard, { props: {
      ...finder, href: finder.url, heading: finder.title, variant
    } })
    expect(wrapper.element.tagName).toBe('DIV')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.attributes('href')).toBeUndefined()
    expect(wrapper.get('.wechat-link-finder-cover-img').attributes('src')).toBe(finder.preview)
    expect(wrapper.text()).toContain(finder.from)
    expect(wrapper.text()).toContain('请在微信中打开原消息播放')
    expect(wrapper.find('.wechat-link-finder-play').exists()).toBe(false)
    await wrapper.trigger('click')
    wrapper.unmount()
  })

  it('主聊天渲染真实视频号卡片，不调用外链打开器', async () => {
    const openUrlInBrowser = vi.fn()
    const wrapper = mount(MessageContent, { global, props: { message: finder, state: { openUrlInBrowser } } })
    await wrapper.get('.wechat-link-card-finder').trigger('click')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(openUrlInBrowser).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('无封面或封面读取失败时使用静态视频号标识', async () => {
    const wrapper = mount(LinkCard, { props: { href: finder.url, linkType: 'finder' } })
    expect(wrapper.get('.wechat-link-finder-cover-placeholder img').attributes('src')).toContain('channels-logo.svg')
    await wrapper.setProps({ preview: finder.preview })
    await wrapper.get('.wechat-link-finder-cover-img').trigger('error')
    expect(wrapper.get('.wechat-link-finder-cover-placeholder img').attributes('src')).toContain('channels-logo.svg')
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
    wrapper.unmount()
  })

  it('合并记录与已解析的链接浮窗均保留视频号卡片而不提供浏览器跳转', async () => {
    const openChatHistoryLinkWindow = vi.fn()
    const openUrlInBrowser = vi.fn()
    const windowBase = { x: 0, y: 0, zIndex: 1, width: 520, height: 420 }
    const wrapper = mount(ChatHistoryFloatingWindows, { global, props: { state: {
      privacyMode: false,
      floatingWindows: [
        { ...windowBase, id: 'history', kind: 'chatHistory', records: [finder] },
        { ...windowBase, ...finder, id: 'resolved-link', kind: 'link' }
      ],
      openChatHistoryLinkWindow, openUrlInBrowser,
      focusFloatingWindow: vi.fn(), startFloatingWindowDrag: vi.fn(), closeFloatingWindow: vi.fn(),
      openMediaContextMenu: vi.fn(),
      getChatHistoryLinkFromAvatarText: () => '视',
      getChatHistoryLinkFromText: record => record.from,
      onChatHistoryLinkPreviewError: vi.fn(), onChatHistoryFromAvatarLoad: vi.fn(), onChatHistoryFromAvatarError: vi.fn()
    } } })
    expect(wrapper.findAll('.wechat-link-card-finder')).toHaveLength(2)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('在浏览器打开')
    expect(wrapper.text()).not.toContain('复制链接')
    for (const card of wrapper.findAll('.wechat-link-card-finder')) await card.trigger('click')
    expect(openChatHistoryLinkWindow).not.toHaveBeenCalled()
    expect(openUrlInBrowser).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each(['', 'mini_program'])('普通网页和小程序链接继续保留原有跳转（%s）', linkType => {
    const wrapper = mount(LinkCard, { props: { href: 'https://example.test/article', linkType, heading: '文章' } })
    expect(wrapper.element.tagName).toBe('A')
    expect(wrapper.attributes('href')).toBe('https://example.test/article')
    expect(wrapper.attributes('target')).toBe('_blank')
    wrapper.unmount()
  })

  it('链接详情浮窗保留原记录的视频号类型', () => {
    const originalClient = process.client
    process.client = true
    try {
      const history = useChatHistoryWindows({ api: {}, apiBase: '/api',
        selectedAccount: ref('account'), selectedContact: ref({ username: 'friend' }),
        openImagePreview: vi.fn(), openVideoPreview: vi.fn(), buildVoiceUrl: vi.fn()
      })
      history.openChatHistoryLinkWindow(finder)
      expect(history.floatingWindows.value[0].linkType).toBe('finder')
    } finally {
      process.client = originalClient
    }
  })

  it('浮窗异步识别为视频号后立即撤下跳转，并保留既有封面候选处理', async () => {
    const originalClient = process.client
    process.client = true
    let wrapper
    try {
      let resolve
      const pending = new Promise(done => { resolve = done })
      const history = useChatHistoryWindows({ api: { resolveAppMsg: () => pending }, apiBase: '/api',
        selectedAccount: ref('account'), selectedContact: ref({ username: 'friend' }),
        openImagePreview: vi.fn(), openVideoPreview: vi.fn(), buildVoiceUrl: vi.fn()
      })
      history.openChatHistoryLinkWindow({ ...finder, linkType: '', fromnewmsgid: '123', preview: '/local-cover.jpg' })
      wrapper = mount(ChatHistoryFloatingWindows, { global, props: { state: {
        ...history, floatingWindows: history.floatingWindows.value, privacyMode: false,
        openMediaContextMenu: vi.fn()
      } } })
      expect(wrapper.text()).toContain('在浏览器打开')
      resolve({ ...finder, thumbUrl: finder.preview })
      await flushPromises()
      expect(wrapper.find('.wechat-link-card-finder').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('在浏览器打开')
      expect(wrapper.text()).not.toContain('复制链接')
      expect(wrapper.text()).not.toContain('解析中')
      await wrapper.get('.wechat-link-finder-cover-img').trigger('error')
      expect(wrapper.get('.wechat-link-finder-cover-img').attributes('src')).toBe(finder.preview)
    } finally {
      wrapper?.unmount()
      process.client = originalClient
    }
  })
})
