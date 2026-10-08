import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptySearchContext, useChatSearch } from '~/composables/chat/useChatSearch'
import { useChatMessages } from '~/composables/chat/useChatMessages'

vi.mock('~/lib/server-error-logging', () => ({ reportServerError: vi.fn() }))
let wrapper, originalClient
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const message = (id, content = id) => ({ id, localId: 1, type: 1, renderType: 'text', content, createTime: 1000 })
beforeEach(() => {
  originalClient = process.client
  process.client = true
  vi.stubGlobal('useApiBase', () => '/api')
  vi.stubGlobal('useSettingsDialog', () => ({ openDialog: vi.fn() }))
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  wrapper?.unmount()
  process.client = originalClient
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const setup = () => {
  const account = ref('a'), contact = ref({ username: 'friend' }), context = ref(createEmptySearchContext())
  const api = {
    listChatMessages: vi.fn(async () => ({ messages: [message('latest')], total: 1, hasMore: false })),
    getChatMessagesAround: vi.fn(async () => ({ messages: [message('anchor', 'new snapshot')], anchorId: 'anchor', anchorIndex: 0 }))
  }
  let messages, search
  wrapper = mount(defineComponent({ setup() {
    messages = useChatMessages({ api, apiBase: '/api', selectedAccount: account, selectedContact: contact,
      privacyMode: ref(false), searchContext: context,
      onSnapshotChanged: () => search.refreshSnapshotWindow() })
    search = useChatSearch({ api, contacts: ref([]), selectedAccount: account, selectedContact: contact,
      privacyMode: ref(false), searchContext: context, selectContact: vi.fn(), ...messages,
      onSnapshotChanged: () => search.refreshSnapshotWindow() })
    return () => h('div')
  } }))
  const row = document.createElement('div')
  row.dataset.msgId = 'anchor'
  row.getBoundingClientRect = vi.fn().mockReturnValue({ top: 60, bottom: 110 })
  const container = document.createElement('div')
  container.append(row)
  container.scrollTop = 100
  Object.defineProperties(container, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } })
  container.getBoundingClientRect = () => ({ top: 50, bottom: 450 })
  messages.messageContainerRef.value = container
  messages.allMessages.value = { friend: [message('anchor', 'old snapshot')], other: [message('old-cache')] }
  messages.messagesMeta.value = { friend: { total: 20, hasMore: true }, other: { hasMore: true } }
  return { api, account, contact, context, messages, search, container, row }
}

describe('快照发布后的消息窗口', () => {
  it('搜索响应缺少状态时显示失败，不伪装成成功的空结果', async () => {
    const { api, search } = setup()
    api.searchChatMessages = vi.fn(async () => ({ hits: [], total: 0 }))
    search.messageSearchQuery.value = '合成查询'
    await search.runMessageSearch({ reset: true })
    expect(search.messageSearchError.value).toBe('搜索失败')
    expect(search.messageSearchBackendStatus.value).not.toBe('success')
    expect(search.messageSearchLoading.value).toBe(false)
  })

  it('发送者列表响应缺少状态时暴露错误', async () => {
    const { api, search } = setup()
    api.listChatSearchSenders = vi.fn(async () => ({ senders: [] }))
    await search.fetchMessageSearchSenders()
    expect(search.messageSearchSenderError.value).toBe('加载发送者失败')
    expect(search.messageSearchSenderOptionsKey.value).toBe('')
  })

  it('历史浏览收到快照后直接读取最新消息，不建立定位上下文，并清除旧代缓存', async () => {
    const { search, messages, context, api, container } = setup()
    await search.refreshSnapshotWindow({ signal: new AbortController().signal })
    expect(api.listChatMessages).toHaveBeenCalledWith(expect.objectContaining({ account: 'a', username: 'friend', offset: 0 }))
    expect(api.getChatMessagesAround).not.toHaveBeenCalled()
    expect(messages.messages.value[0].id).toBe('latest')
    expect(messages.allMessages.value.other).toBeUndefined()
    expect(context.value).toEqual(createEmptySearchContext())
    expect(messages.hasMoreMessages.value).toBe(false)
    expect(container.scrollTop).toBe(container.scrollHeight)
  })

  it('位于底部时重读最新窗口，不沿用旧 offset', async () => {
    const { search, messages, container, api } = setup()
    container.scrollTop = 600
    await search.refreshSnapshotWindow({ signal: new AbortController().signal })
    expect(api.listChatMessages).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }))
    expect(api.getChatMessagesAround).not.toHaveBeenCalled()
    expect(messages.messages.value[0].id).toBe('latest')
  })

  it('发布前发出的普通分页即使不遵从abort，也不能合并旧代', async () => {
    const { search, messages, api } = setup()
    const old = deferred()
    api.listChatMessages.mockReturnValueOnce(old.promise)
    const oldLoad = messages.loadMessages({ username: 'friend', reset: false })
    await search.refreshSnapshotWindow({ signal: new AbortController().signal })
    old.resolve({ messages: [message('stale')], total: 100 })
    await oldLoad
    expect(messages.messages.value.map(row => row.id)).toEqual(['latest'])
  })

  it('旧上下文分页不能覆盖重建窗口或其他账号同名会话', async () => {
    const { search, messages, context, api, account } = setup()
    context.value = { ...createEmptySearchContext(), active: true, username: 'friend', hasMoreBefore: true }
    const old = deferred()
    api.getChatMessagesAround.mockReturnValueOnce(old.promise)
    const oldLoad = search.loadMoreSearchContextBefore()
    await search.refreshSnapshotWindow({ signal: new AbortController().signal })
    account.value = 'b'
    old.resolve({ messages: [message('stale')] })
    await oldLoad
    expect(messages.messages.value.map(row => row.id)).toEqual(['latest'])
  })

  it('最新消息加载失败暴露错误且停止旧窗口分页，明确重试可恢复', async () => {
    const { search, messages, context, api } = setup()
    api.listChatMessages.mockRejectedValueOnce(new Error('latest unavailable'))
    await expect(search.refreshSnapshotWindow({ signal: new AbortController().signal })).rejects.toThrow('latest unavailable')
    expect(messages.messagesError.value).toBe('latest unavailable')
    expect(messages.hasMoreMessages.value).toBe(false)
    expect(context.value.hasMoreBefore).toBe(false)
    expect(context.value.hasMoreAfter).toBe(false)
    await search.refreshSnapshotWindow({ signal: new AbortController().signal })
    expect(context.value.active).toBe(false)
    expect(messages.messages.value[0].id).toBe('latest')
    expect(api.getChatMessagesAround).not.toHaveBeenCalled()
  })

  it('状态轮询前分页已读到新代时，拒绝跨代合并并重读当前窗口', async () => {
    const { messages, api, context } = setup()
    messages.messagesMeta.value.friend.snapshotGeneration = 'generation-old'
    api.listChatMessages
      .mockResolvedValueOnce({ snapshotGeneration: 'generation-new', messages: [message('do-not-merge')] })
      .mockResolvedValue({ snapshotGeneration: 'generation-new', messages: [message('latest')] })
    await messages.loadMessages({ username: 'friend', reset: false })
    expect(messages.messages.value.map(row => row.id)).toEqual(['latest'])
    expect(messages.messagesMeta.value.friend.snapshotGeneration).toBe('generation-new')
    expect(context.value.active).toBe(false)
    expect(api.getChatMessagesAround).not.toHaveBeenCalled()
  })

  it.each(['Before', 'After'])('上下文%s分页跨代时整窗重读', async (direction) => {
    const { messages, api, context, search } = setup()
    context.value = { ...createEmptySearchContext(), active: true, username: 'friend', hasMoreBefore: true, hasMoreAfter: true }
    messages.messagesMeta.value.friend.snapshotGeneration = 'generation-old'
    api.getChatMessagesAround
      .mockResolvedValueOnce({ snapshotGeneration: 'generation-new', messages: [message('do-not-merge')] })
    api.listChatMessages.mockResolvedValue({ snapshotGeneration: 'generation-new', messages: [message('latest')] })
    await search[`loadMoreSearchContext${direction}`]()
    expect(messages.messages.value.map(row => row.id)).toEqual(['latest'])
    expect(messages.messagesMeta.value.friend.snapshotGeneration).toBe('generation-new')
    expect(context.value.active).toBe(false)
    expect(api.getChatMessagesAround).toHaveBeenCalledTimes(1)
  })

  it('发布前的搜索定位迟到响应不能覆盖新代窗口', async () => {
    const { api, search, messages } = setup(), old = deferred()
    api.getChatMessagesAround.mockReturnValueOnce(old.promise)
    const locate = search.locateSearchHit({ id: 'anchor', username: 'friend' })
    await search.refreshSnapshotWindow()
    old.resolve({ messages: [message('stale')] })
    await locate
    expect(messages.messages.value.map(row => row.id)).toEqual(['latest'])
  })

  it('快照废弃在途搜索时清除loading、总数和索引状态，旧finally不能重新污染', async () => {
    const { api, search } = setup(), old = deferred()
    api.searchChatMessages = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ status: 'success', hits: [], total: 0 })
    search.messageSearchQuery.value = '合成查询'
    search.messageSearchTotal.value = 50
    search.messageSearchIndexInfo.value = { status: 'ready' }
    const pending = search.runMessageSearch({ reset: true })
    expect(search.messageSearchLoading.value).toBe(true)
    await search.refreshSnapshotWindow()
    expect(search.messageSearchLoading.value).toBe(false)
    expect(search.messageSearchTotal.value).toBe(0)
    expect(search.messageSearchIndexInfo.value).toBe(null)
    old.resolve({ status: 'success', hits: [message('stale')], total: 1 })
    await pending
    expect(search.messageSearchResults.value).toEqual([])
    await search.runMessageSearch({ reset: true })
    expect(api.searchChatMessages).toHaveBeenCalledTimes(2)
  })
})
