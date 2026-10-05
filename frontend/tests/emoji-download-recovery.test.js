import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MessageContent from '~/components/chat/MessageContent.vue'
import { useChatMessages } from '~/composables/chat/useChatMessages'


let originalClient
const wrappers = []
beforeEach(() => {
  originalClient = process.client
  process.client = true
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  process.client = originalClient
  vi.restoreAllMocks()
})

const mountEmoji = (downloadChatEmoji) => {
  const message = reactive({
    id: 'emoji-1', renderType: 'emoji', isSent: false,
    emojiMd5: '11111111111111111111111111111111',
    emojiRemoteUrl: 'https://example.test/emoji.gif',
    emojiLocalUrl: '/api/chat/media/emoji?account=account-a&md5=11111111111111111111111111111111&username=friend',
    _emojiDownloaded: true
  })
  message.emojiUrl = message.emojiLocalUrl
  let state
  const wrapper = mount(defineComponent({
    setup() {
      state = useChatMessages({
        api: { downloadChatEmoji }, apiBase: '/api',
        selectedAccount: ref('account-a'),
        selectedContact: ref({ username: 'friend' }),
        privacyMode: ref(false),
        searchContext: ref({ active: false })
      })
      return () => h(MessageContent, {
        message,
        state: {
          shouldShowEmojiDownload: state.shouldShowEmojiDownload,
          onEmojiDownloadClick: state.onEmojiDownloadClick,
          openImagePreview: vi.fn(), openMediaContextMenu: vi.fn(),
          privacyMode: false, selectedContact: { username: 'friend' }
        }
      })
    }
  }), {
    global: {
      stubs: { ContactProfileCard: true, ChatLocationCard: true, FileTypeIcon: true, LinkCard: true, ErrorNotice: true },
      directives: { chatLazySrc: (el, binding) => { el.src = binding.value }, chatMediaPerf: () => {} }
    }
  })
  wrappers.push(wrapper)
  return { wrapper, message, state }
}

describe('emoji download recovery', () => {
  it('keeps an explicit download action visible after a local image fails', async () => {
    const download = vi.fn()
    const { wrapper } = mountEmoji(download)
    await wrapper.get('img[alt="表情"]').trigger('error')
    expect(wrapper.text()).toContain('表情加载失败')
    expect(wrapper.get('button').text()).toBe('下载并重试')
    expect(wrapper.get('button').classes()).not.toContain('opacity-0')
    expect(download).not.toHaveBeenCalled()
  })

  it('replaces a failed cache only on click and reloads the local URL after success', async () => {
    let resolveDownload
    const download = vi.fn(() => new Promise(resolve => { resolveDownload = resolve }))
    const { wrapper, message, state } = mountEmoji(download)
    await wrapper.get('img[alt="表情"]').trigger('error')
    await wrapper.get('button').trigger('click')
    expect(download).toHaveBeenCalledWith({
      account: 'account-a', md5: message.emojiMd5,
      emoji_url: message.emojiRemoteUrl, force: true
    })
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    await state.onEmojiDownloadClick(message)
    expect(download).toHaveBeenCalledTimes(1)
    expect(message._emojiRenderError).toBe(true)
    resolveDownload({ saved: true })
    await flushPromises()
    expect(message._emojiRenderError).toBe(false)
    expect(message._emojiDownloaded).toBe(true)
    const reloaded = new URL(wrapper.get('img[alt="表情"]').attributes('src'), 'http://localhost')
    expect(reloaded.pathname).toBe('/api/chat/media/emoji')
    expect(reloaded.searchParams.get('account')).toBe('account-a')
    expect(reloaded.searchParams.get('md5')).toBe(message.emojiMd5)
    expect(reloaded.searchParams.get('v')).toBeTruthy()
    expect(message.emojiLocalUrl).not.toContain('&v=')
  })

  it('exposes download failure and leaves the manual retry available', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const download = vi.fn().mockRejectedValue(new Error('表情 MD5 不匹配'))
    const { wrapper, message } = mountEmoji(download)
    message._emojiDownloaded = false
    await wrapper.get('img[alt="表情"]').trigger('error')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('表情 MD5 不匹配'))
    expect(message._emojiRenderError).toBe(true)
    expect(message._emojiDownloaded).toBe(false)
    expect(message.emojiUrl).toBe(message.emojiLocalUrl)
    expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('button').text()).toBe('下载并重试')
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('preserves non-forced downloads when the image has not failed', async () => {
    const download = vi.fn().mockResolvedValue({ saved: true })
    const { wrapper } = mountEmoji(download)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
  })
})
