import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import MessageList from '~/components/chat/MessageList.vue'
import { useChatMessages } from '~/composables/chat/useChatMessages'

let wrapper
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })

it('prepending history updates the former first divider without rerendering unchanged message contents', async () => {
  const updated = []
  let state
  wrapper = mount(defineComponent({
    setup() {
      const selectedContact = ref({ username: 'bench', name: '测试会话' })
      state = useChatMessages({ api: {}, apiBase: '/api', selectedAccount: ref('bench'),
        selectedContact, privacyMode: ref(false),
        searchContext: ref({ active: false }) })
      state.allMessages.value.bench = [1000, 1040].map((createTime, index) => state.normalizeMessage({
        id: `m${index + 1}`, createTime, content: `原文 ${index + 1}`, renderType: 'text'
      }))
      return () => h(MessageList, { state: { ...state, selectedContact, insightLabels: null,
        privacyMode: false, onMessageScroll: () => {}, openMediaContextMenu: () => {} } })
    }
  }), { global: {
    directives: { chatLazySrc: () => {}, chatMediaPerf: () => {} },
    stubs: { ErrorNotice: true },
    mixins: [{ updated() { if (this.$options.name === 'MessageContent') updated.push(this.message.id) } }]
  } })
  const first = wrapper.find('[data-msg-id="m1"]')
  expect(first.find('.message-time-divider').exists()).toBe(true)
  state.allMessages.value.bench = [state.normalizeMessage({ id: 'older', createTime: 960, content: '更早原文' }), ...state.allMessages.value.bench]
  await nextTick()
  expect(first.find('.message-time-divider').exists()).toBe(false)
  expect(updated).toEqual([])
  state.allMessages.value.bench[2].content = '原文内容已更新'
  await nextTick()
  expect(wrapper.find('[data-msg-id="m2"]').text()).toContain('原文内容已更新')
})
