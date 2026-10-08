import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatEditing } from '~/composables/chat/useChatEditing'
import { showErrorAlert } from '~/composables/useErrorNotice'
import ChatHistoryFloatingWindows from '~/components/chat/ChatHistoryFloatingWindows.vue'

vi.mock('~/composables/useErrorNotice', () => ({ showErrorAlert: vi.fn() }))

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const setup = (writeText) => {
  vi.stubGlobal('process', { ...process, client: true })
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText)
  return useChatEditing({ api: {}, selectedAccount: ref('account'), selectedContact: ref({ username: 'friend' }) })
}

describe('message clipboard results', () => {
  it('returns success only after the clipboard write completes', async () => {
    const writeText = vi.fn(async () => {})
    const state = setup(writeText)
    await expect(state.copyTextToClipboard(' message ')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('message')
  })

  it('propagates clipboard rejection without offering a prompt as success', async () => {
    const error = new Error('剪贴板权限被拒绝')
    const state = setup(async () => { throw error })
    const prompt = vi.spyOn(window, 'prompt')
    await expect(state.copyTextToClipboard('message')).rejects.toBe(error)
    expect(prompt).not.toHaveBeenCalled()
  })

  it.each(['onCopyMessageTextClick', 'onCopyMessageJsonClick'])('%s exposes the failure and closes its context menu', async (action) => {
    const state = setup(async () => { throw new Error('剪贴板权限被拒绝') })
    state.contextMenu.value = { visible: true, message: { content: 'message', serverId: 9007199254740993n } }
    await state[action]()
    expect(showErrorAlert).toHaveBeenCalledWith('复制失败：剪贴板权限被拒绝')
    expect(state.contextMenu.value.visible).toBe(false)
  })

  it('forwarded-history link copying also exposes clipboard failures', async () => {
    setup(async () => { throw new Error('剪贴板权限被拒绝') })
    const wrapper = mount(ChatHistoryFloatingWindows, { props: { state: { floatingWindows: [] } } })
    await wrapper.vm.copyRecordUrl('https://example.com')
    expect(showErrorAlert).toHaveBeenCalledWith('复制失败：剪贴板权限被拒绝')
    wrapper.unmount()
  })
})
