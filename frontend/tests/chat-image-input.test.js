import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, reactive, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import MessageInputWorkspace from '../components/chat/MessageInputWorkspace.vue'
import { useApi } from '../composables/useApi'

const image = {
  canceled: false,
  path: 'C:\\照片\\测试.png',
  name: '测试.png',
  previewDataUrl: 'data:image/png;base64,aW1hZ2U='
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('图片选择与独立发送', () => {
  let state
  let api
  let wrapper

  beforeEach(() => {
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useState', () => ref({ selected: {}, drafts: {}, pinned: {} }))
    state = reactive({
      selectedAccount: 'wx_account',
      selectedContact: { username: 'wx_peer', name: '甲' },
      refreshSelectedMessages: vi.fn()
    })
    api = {
      sendChatImage: vi.fn().mockResolvedValue({ success: true }),
      sendChatMessage: vi.fn().mockResolvedValue({ success: true })
    }
    window.wechatDesktop = { platform: 'win32', chooseImage: vi.fn().mockResolvedValue(image) }
    wrapper = mount(MessageInputWorkspace, { props: { state, api } })
  })

  afterEach(() => {
    wrapper.unmount()
    delete window.wechatDesktop
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  const pick = async () => {
    expect(wrapper.find('.chat-input-btn-image').exists()).toBe(true)
    await wrapper.get('.chat-input-btn-image').trigger('click')
    await flushPromises()
  }

  it('选图预览使用 data URL，空文字可独立发送图片并刷新消息', async () => {
    await pick()
    expect(wrapper.get('.chat-input-image-preview').attributes('src')).toBe(image.previewDataUrl)
    expect(wrapper.get('.chat-input-btn-send-image').attributes('disabled')).toBeUndefined()
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    await flushPromises()
    expect(api.sendChatImage).toHaveBeenCalledExactlyOnceWith({
      account: 'wx_account', username: 'wx_peer', display_name: '甲', image_path: image.path
    })
    expect(api.sendChatMessage).not.toHaveBeenCalled()
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(false)
    expect(state.refreshSelectedMessages).toHaveBeenCalledOnce()
  })

  it('选择取消不丢失已有图片，移除不触发发送', async () => {
    await pick()
    window.wechatDesktop.chooseImage.mockResolvedValueOnce({ canceled: true })
    await pick()
    expect(wrapper.get('.chat-input-image-preview').attributes('src')).toBe(image.previewDataUrl)
    await wrapper.get('.chat-input-image-remove').trigger('click')
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(false)
    expect(api.sendChatImage).not.toHaveBeenCalled()
  })

  it.each([new Error('读取图片失败'), { code: 'WECHAT_SEND_UNCONFIRMED', message: '图片气泡未确认' }])(
    '发送错误保留图片和文字，并暴露真实错误', async (error) => {
      await wrapper.get('textarea').setValue('保留文字')
      await pick()
      api.sendChatImage.mockRejectedValueOnce(error)
      await wrapper.get('.chat-input-btn-send-image').trigger('click')
      await flushPromises()
      expect(wrapper.get('.chat-input-image-preview').attributes('src')).toBe(image.previewDataUrl)
      expect(wrapper.get('textarea').element.value).toBe('保留文字')
      expect(wrapper.get(error.code === 'WECHAT_SEND_UNCONFIRMED' ? '[role="status"]' : '[role="alert"]').text()).toContain(error.message)
      expect(state.refreshSelectedMessages).not.toHaveBeenCalled()
    }
  )

  it.each([{ success: false }, {}])('未明确 success=true 时不得清除图片', async (receipt) => {
    await pick()
    api.sendChatImage.mockResolvedValueOnce(receipt)
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    await flushPromises()
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(true)
    expect(wrapper.get('[role="status"]').text()).toContain('WECHAT_SEND_UNCONFIRMED')
    expect(state.refreshSelectedMessages).not.toHaveBeenCalled()
  })

  it('图片请求期间与文字发送共用互斥锁，重复点击只发一次', async () => {
    await wrapper.get('textarea').setValue('文字')
    await pick()
    const pending = deferred()
    api.sendChatImage.mockReturnValueOnce(pending.promise)
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    await wrapper.get('textarea').trigger('keydown.enter.exact')
    expect(api.sendChatImage).toHaveBeenCalledOnce()
    expect(api.sendChatMessage).not.toHaveBeenCalled()
    expect(wrapper.get('.chat-input-image-remove').attributes('disabled')).toBeDefined()
    pending.resolve({ success: true })
    await flushPromises()
    expect(wrapper.get('textarea').element.value).toBe('文字')
  })

  it('待确认使用独立提示，禁止直接重发，人工确认仅清除图片并刷新原会话', async () => {
    await wrapper.get('textarea').setValue('保留正文')
    await pick()
    api.sendChatImage.mockRejectedValueOnce({ code: 'WECHAT_SEND_UNCONFIRMED', message: '未确认方向' })
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').text()).toContain('待核对')
    expect(wrapper.get('.chat-input-btn-send-image').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.chat-input-btn-image').attributes('disabled')).toBeDefined()
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    await wrapper.get('.chat-input-image-confirm').trigger('click')
    expect(api.sendChatImage).toHaveBeenCalledOnce()
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(false)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.get('textarea').element.value).toBe('保留正文')
    expect(state.refreshSelectedMessages).toHaveBeenCalledOnce()
  })

  it('切换会话不能确认原图；核对未发送只解锁按钮，不自动重发', async () => {
    await pick()
    api.sendChatImage.mockRejectedValueOnce({ code: 'WECHAT_SEND_UNCONFIRMED', message: '结果未知' })
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    await flushPromises()
    state.selectedContact = { username: 'other', name: '乙' }
    await flushPromises()
    expect(wrapper.get('.chat-input-image-confirm').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.chat-input-image-retry-ready').attributes('disabled')).toBeDefined()
    state.selectedContact = { username: 'wx_peer', name: '甲' }
    await flushPromises()
    await wrapper.get('.chat-input-image-retry-ready').trigger('click')
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(true)
    expect(wrapper.get('.chat-input-btn-send-image').attributes('disabled')).toBeUndefined()
    expect(api.sendChatImage).toHaveBeenCalledOnce()
  })

  it('文字发送保留已选图片，图片不会随正文自动发送', async () => {
    await pick()
    await wrapper.get('textarea').setValue('只发文字')
    await wrapper.get('.chat-input-btn-send').trigger('click')
    await flushPromises()
    expect(api.sendChatMessage).toHaveBeenCalledOnce()
    expect(api.sendChatImage).not.toHaveBeenCalled()
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(true)
  })

  it.each(['contact', 'account'])('切换 %s 后不能把原图片发到新目标', async (kind) => {
    await pick()
    if (kind === 'contact') state.selectedContact = { username: 'wx_other', name: '乙' }
    else state.selectedAccount = 'wx_other_account'
    await flushPromises()
    expect(wrapper.get('.chat-input-btn-send-image').attributes('disabled')).toBeDefined()
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    expect(api.sendChatImage).not.toHaveBeenCalled()
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(true)
  })

  it('选择对话框返回前切换会话，迟到结果不会绑定新目标', async () => {
    const pending = deferred()
    window.wechatDesktop.chooseImage.mockReturnValueOnce(pending.promise)
    await wrapper.get('.chat-input-btn-image').trigger('click')
    state.selectedContact = { username: 'wx_other', name: '乙' }
    pending.resolve(image)
    await flushPromises()
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('IMAGE_TARGET_CHANGED')
    expect(api.sendChatImage).not.toHaveBeenCalled()
  })

  it('发送期间切换会话仍使用原目标，成功不刷新新会话', async () => {
    await pick()
    const pending = deferred()
    api.sendChatImage.mockReturnValueOnce(pending.promise)
    await wrapper.get('.chat-input-btn-send-image').trigger('click')
    state.selectedContact = { username: 'wx_other', name: '乙' }
    pending.resolve({ success: true })
    await flushPromises()
    expect(api.sendChatImage).toHaveBeenCalledExactlyOnceWith({
      account: 'wx_account', username: 'wx_peer', display_name: '甲', image_path: image.path
    })
    expect(state.refreshSelectedMessages).not.toHaveBeenCalled()
  })

  it('桥接缺失明确提示 Windows 桌面支持范围', async () => {
    delete window.wechatDesktop
    await pick()
    expect(wrapper.get('[role="alert"]').text()).toContain('Windows')
    expect(api.sendChatImage).not.toHaveBeenCalled()
  })

  it('原生选择出错保留已有选择并显示错误', async () => {
    await pick()
    window.wechatDesktop.chooseImage.mockRejectedValueOnce(new Error('磁盘读取失败'))
    await pick()
    expect(wrapper.find('.chat-input-image-preview').exists()).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain('磁盘读取失败')
  })

  it('useApi 使用独立图片 endpoint，只发送图片路径与明确目标', async () => {
    setActivePinia(createPinia())
    vi.stubGlobal('useApiBase', () => 'http://127.0.0.1:10392/api')
    const fetch = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('$fetch', fetch)
    const client = useApi()
    expect(typeof client.sendChatImage).toBe('function')
    await client.sendChatImage({
      account: 'wx_account', username: 'wx_peer', display_name: '甲', image_path: image.path,
      content: '不可自动混发', previewDataUrl: image.previewDataUrl
    })
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/chat/send/image', expect.objectContaining({
      method: 'POST', body: {
        account: 'wx_account', username: 'wx_peer', display_name: '甲', image_path: image.path
      }
    }))
  })
})
