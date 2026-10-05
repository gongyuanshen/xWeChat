import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MessageItem from '~/components/chat/MessageItem.vue'
import { createMessageNormalizer } from '~/lib/chat/message-normalizer'

const normalize = createMessageNormalizer({ apiBase: '/api', getSelectedAccount: () => 'fixture', getSelectedContact: () => null })

const render = (message) => mount(MessageItem, {
  props: {
    message: normalize({ id: 'revocation', renderType: 'system', content: '对方撤回了一条消息', ...message }),
    state: { highlightServerIdStr: '', highlightMessageId: '' },
  },
  global: { directives: { chatLazySrc: () => {}, chatMediaPerf: () => {} } },
})

describe('撤回原文捕获状态', () => {
  it('保留微信撤回提示并明确原文未匹配', () => {
    const wrapper = render({ revokeOriginalStatus: 'unresolved' })
    expect(wrapper.text()).toContain('对方撤回了一条消息')
    expect(wrapper.text()).toContain('未匹配到已归档原文')
  })

  it('捕获原文或普通系统通知不会误显示未捕获', () => {
    for (const revokeOriginalStatus of ['captured', undefined]) {
      const wrapper = render({ revokeOriginalStatus })
      expect(wrapper.text()).not.toContain('未匹配到已归档原文')
    }
  })

  it('后续归档成功替换消息时清除未知状态提示', async () => {
    const wrapper = render({ revokeOriginalStatus: 'unresolved' })
    expect(wrapper.text()).toContain('未匹配到已归档原文')
    await wrapper.setProps({ message: normalize({
      id: 'revocation', renderType: 'system', content: '对方撤回了一条消息',
      revokeOriginalStatus: 'captured',
    }) })
    expect(wrapper.text()).not.toContain('未匹配到已归档原文')
  })
})
