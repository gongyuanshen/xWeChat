import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatMessages } from '~/composables/chat/useChatMessages'

const wrappers = []
let originalClient
beforeEach(() => {
  originalClient = process.client
  process.client = true
  window.localStorage.clear()
  vi.stubGlobal('Image', class {
    naturalWidth = 1280
    naturalHeight = 960
    set src(_value) { queueMicrotask(() => this.onload?.()) }
  })
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  process.client = originalClient
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function setup(rows) {
  let state
  const wrapper = mount(defineComponent({
    setup() {
      state = useChatMessages({ api: {}, apiBase: '/api',
        selectedAccount: ref('account-a'), selectedContact: ref({ username: 'friend' }),
        privacyMode: ref(false), searchContext: ref({ active: false }) })
      return () => h('div')
    }
  }))
  wrappers.push(wrapper)
  state.allMessages.value.friend = rows
  return state
}

const image = (db, serverIdStr) => ({
  id: `${db}:Msg_friend:7`, localId: 7, serverIdStr,
  renderType: 'image', imageMd5: serverIdStr.padStart(32, '0'), imageUrl: `/thumb-${db}.png`
})

describe('large image refresh preserves complete message identity', () => {
  it('updates the selected shard only when two image rows share localId', async () => {
    const first = image('message_0', '9007199254740993')
    const second = image('message_1', '9007199254740994')
    const state = setup([first, second])
    await state.onTryLoadLargeImageClick({ ...second })
    expect(state.allMessages.value.friend[0].imageUrl).toBe('/thumb-message_0.png')
    expect(state.allMessages.value.friend[1].imageUrl).toContain('server_id=9007199254740994')
  })

  it('uses exact serverIdStr when a preview omits the full message id', async () => {
    const first = image('message_0', '9007199254740993')
    const second = image('message_1', '9007199254740994')
    const state = setup([first, second])
    await state.onTryLoadLargeImageClick({ ...second, id: '' })
    expect(state.allMessages.value.friend[0].imageUrl).toBe('/thumb-message_0.png')
    expect(state.allMessages.value.friend[1].imageUrl).toContain('server_id=9007199254740994')
  })

  it('does not update a loaded row using only an ambiguous localId', async () => {
    const first = image('message_0', '9007199254740993')
    const state = setup([first])
    await state.onTryLoadLargeImageClick({ ...first, id: '', serverIdStr: '', imageMd5: 'a'.repeat(32) })
    expect(state.allMessages.value.friend[0].imageUrl).toBe('/thumb-message_0.png')
  })

  it('does not treat two zero server IDs as a message identity', async () => {
    const first = image('message_0', '0')
    const state = setup([first])
    await state.onTryLoadLargeImageClick({ ...first, id: '', imageMd5: 'a'.repeat(32) })
    expect(state.allMessages.value.friend[0].imageUrl).toBe('/thumb-message_0.png')
  })

  it('does not match different server IDs rounded to the same unsafe number', async () => {
    const first = { ...image('message_0', '9007199254740992'),
      id: '', serverIdStr: '', serverId: Number('9007199254740992') }
    const second = { ...image('message_1', '9007199254740993'),
      id: '', serverIdStr: '', serverId: Number('9007199254740993') }
    const state = setup([first, second])
    await state.onTryLoadLargeImageClick({ ...second })
    expect(state.allMessages.value.friend[0].imageUrl).toBe('/thumb-message_0.png')
    expect(state.allMessages.value.friend[1].imageUrl).toBe('/thumb-message_1.png')
  })

  it.each([17, '9007199254740993'])('preserves precise legacy serverId %s', async (serverId) => {
    const first = { ...image('message_0', ''), id: '', serverId }
    const state = setup([first])
    await state.onTryLoadLargeImageClick({ ...first })
    expect(state.allMessages.value.friend[0].imageUrl).toContain(`server_id=${serverId}`)
  })

  it('still matches the complete message identity without a server ID', async () => {
    const first = image('message_0', '')
    const state = setup([first])
    await state.onTryLoadLargeImageClick({ ...first })
    expect(state.allMessages.value.friend[0].imageUrl).toContain('prefer_live=true')
  })
})
