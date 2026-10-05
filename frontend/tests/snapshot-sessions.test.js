import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatSessions } from '~/composables/chat/useChatSessions'

let wrapper, originalClient
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { originalClient = process.client; process.client = true })
afterEach(() => { wrapper?.unmount(); process.client = originalClient; vi.restoreAllMocks() })
const setup = () => {
  const account = ref('a'), api = { listChatSessions: vi.fn() }
  let state
  wrapper = mount(defineComponent({ setup() {
    state = useChatSessions({ chatAccounts: {}, selectedAccount: account, api })
    return () => h('div')
  } }))
  return { account, api, state }
}

describe('快照更新会话列表', () => {
  it('发布后强制新请求，取消旧同账号会话读取', async () => {
    const { api, state } = setup(), old = deferred()
    api.listChatSessions.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sessions: [{ id: 'new', username: 'new' }] })
    const previous = state.refreshSessionsForSelectedAccount()
    const current = state.refreshSessionsForSelectedAccount({ force: true, throwOnError: true })
    expect(api.listChatSessions.mock.calls[0][0].signal.aborted).toBe(true)
    await current
    old.resolve({ sessions: [{ id: 'old', username: 'old' }] })
    await previous
    expect(state.contacts.value.map(row => row.id)).toEqual(['new'])
  })

  it('切走再切回同账号后旧失败不能污染新列表', async () => {
    const { api, state, account } = setup(), old = deferred()
    api.listChatSessions.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sessions: [{ id: 'new', username: 'new' }] })
    const previous = state.loadSessionsForSelectedAccount()
    account.value = 'b'
    await nextTick()
    account.value = 'a'
    await nextTick()
    await state.loadSessionsForSelectedAccount()
    old.reject(new Error('stale account error'))
    await previous
    expect(state.contactsError.value).toBe('')
    expect(state.contacts.value.map(row => row.id)).toEqual(['new'])
  })

  it('快照调用方收到会话刷新失败，手动重试成功清除错误', async () => {
    const { api, state } = setup()
    api.listChatSessions.mockRejectedValueOnce(new Error('corrupt snapshot')).mockResolvedValueOnce({ sessions: [] })
    await expect(state.refreshSessionsForSelectedAccount({ throwOnError: true })).rejects.toThrow('corrupt snapshot')
    await state.refreshSessionsForSelectedAccount({ throwOnError: true })
    expect(state.contactsError.value).toBe('')
  })
})
