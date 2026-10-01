import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatMessages } from '~/composables/chat/useChatMessages'

vi.mock('~/lib/server-error-logging', () => ({ reportServerError: vi.fn() }))
vi.mock('~/stores/chatAccounts', () => ({
  useChatAccountsStore: () => ({ applySourceResponse: vi.fn() })
}))

const wrappers = []
const message = (overrides = {}) => ({
  id: 'realtime:Chat_friend:10', localId: 10, serverIdStr: '1000',
  type: 1, renderType: 'text', content: '保留原文', createTime: 1000,
  isSent: true, isRevoked: false, ...overrides
})
const revoke = (overrides = {}) => message({
  type: 10000, renderType: 'system', content: '你撤回了一条消息',
  revokedServerId: '1000', revokedLocalId: 10, createTime: 1010, ...overrides
})
const mountState = (existing, incoming = []) => {
  let state
  const api = { listChatMessages: vi.fn(async () => ({ messages: incoming })) }
  const wrapper = mount(defineComponent({
    setup() {
      state = useChatMessages({
        api, apiBase: '/api', selectedAccount: ref('account-a'),
        selectedContact: ref({ username: 'wxid_friend' }), realtimeEnabled: ref(true),
        privacyMode: ref(false), searchContext: ref({ active: false })
      })
      return () => h('div')
    }
  }))
  wrappers.push(wrapper)
  state.allMessages.value = { wxid_friend: existing }
  return state
}
const emit = (state, incoming) => state.applyRealtimeMessage({
  account: 'account-a', username: 'wxid_friend', message: incoming
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('撤回事件只更新确定匹配的原消息', () => {
  it.each([['1000', ''], ['', '1000']])('仅一侧有 serverId 不凭 localId 标记：%s / %s', async (targetId, revokedId) => {
    const state = mountState([message({ serverIdStr: targetId })])
    await emit(state, revoke({ id: 'system-20', localId: 20, revokedServerId: revokedId }))
    expect(state.allMessages.value.wxid_friend[0].isRevoked).toBe(false)
  })

  it('serverId 冲突时不按 localId 标记正常消息', async () => {
    const state = mountState([message({ serverIdStr: '9999' })])
    await emit(state, revoke({ id: 'system-20', localId: 20 }))
    expect(state.allMessages.value.wxid_friend[0].isRevoked).toBe(false)
  })

  it('保留与原消息共用 ID 的系统提示，重复事件不增加行', async () => {
    const state = mountState([message()])
    await emit(state, revoke({ revokeTime: 1015 }))
    await emit(state, revoke({ revokeTime: 1015 }))
    const rows = state.allMessages.value.wxid_friend
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    expect(rows.find((row) => row.renderType === 'text').isRevoked).toBe(true)
    expect(rows.find((row) => row.renderType === 'text').revokeTime).toBe(1015)
    expect(rows.find((row) => row.renderType === 'system').isRevoked).toBe(false)
  })

  it('已存在系统提示时仍补回同 serverId 的原内容', async () => {
    const state = mountState([revoke()])
    await emit(state, message({ id: 'anti_revoke:friend:1000', isRevoked: true }))
    const rows = state.allMessages.value.wxid_friend
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.renderType === 'system').isRevoked).toBe(false)
    expect(rows.find((row) => row.renderType === 'text').isRevoked).toBe(true)
  })

  it('同批新增原消息和同 ID 系统提示时更新原消息', async () => {
    const seed = message({ id: 'seed', localId: 1, serverIdStr: '1' })
    const state = mountState([seed], [message(), revoke()])
    await state.refreshRealtimeIncremental()
    const rows = state.allMessages.value.wxid_friend
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.serverIdStr === '1000' && row.renderType === 'text').isRevoked).toBe(true)
    expect(rows.find((row) => row.renderType === 'system').isRevoked).toBe(false)
  })

  it('权威刷新清除此前错误的撤回标记', async () => {
    const state = mountState([message({ isRevoked: true, revokeTime: 1010 })], [message()])
    await state.refreshRealtimeIncremental()
    expect(state.allMessages.value.wxid_friend[0]).toMatchObject({ isRevoked: false, revokeTime: 0 })
  })

  it('局部实时事件未携带撤回状态时不清除已确认标记', async () => {
    const state = mountState([message({ isRevoked: true, revokeTime: 1010 })])
    const incoming = message()
    delete incoming.isRevoked
    await emit(state, incoming)
    expect(state.allMessages.value.wxid_friend[0].isRevoked).toBe(true)
  })
})
