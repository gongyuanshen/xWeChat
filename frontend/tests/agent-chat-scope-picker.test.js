import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentChatScopePicker from '../components/chat/AgentChatScopePicker.vue'

const directory = [
  { username: 'friend', name: '小林' },
  { username: 'project@chatroom', name: '项目群' },
  { username: 'design@chatroom', name: '设计群' },
]
let wrapper, request
beforeEach(() => {
  request = vi.fn(async () => directory)
  vi.stubGlobal('useAiApi', () => ({ request }))
})
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals() })
const open = async (modelValue = null) => {
  wrapper = mount(AgentChatScopePicker, { attachTo: document.body, props: { account: 'account', modelValue } })
  await wrapper.find('[aria-label="选择聊天范围"]').trigger('click')
  await flushPromises()
}
const click = async selector => { wrapper.find(selector).element.click(); await flushPromises() }
const options = () => wrapper.findAll('.agent-chat-scope-options input')

it('全账号范围勾选全部会话，并允许直接取消任意会话', async () => {
  await open()
  expect(options().map(input => input.element.checked)).toEqual([true, true, true])
  expect(options().every(input => !input.element.disabled)).toBe(true)
  await click('input[value="project@chatroom"]')
  expect(options().map(input => input.element.checked)).toEqual([true, false, true])
  const all = wrapper.find('[aria-label="所有聊天"]').element
  expect(all.checked).toBe(false)
  expect(all.indeterminate).toBe(true)
  await click('[aria-label="应用聊天范围"]')
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual(['friend', 'design@chatroom'])
})

it('取消全选后可以单选群聊，再多选联系人，输出真实会话 ID', async () => {
  await open()
  await click('[aria-label="所有聊天"]')
  expect(options().every(input => !input.element.checked)).toBe(true)
  expect(wrapper.find('[aria-label="应用聊天范围"]').element.disabled).toBe(true)
  await click('input[value="project@chatroom"]')
  expect(options().map(input => input.element.checked)).toEqual([false, true, false])
  await click('input[value="friend"]')
  expect(options().map(input => input.element.checked)).toEqual([true, true, false])
  await click('[aria-label="应用聊天范围"]')
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual(['project@chatroom', 'friend'])
})

it('搜索仅过滤显示，全选覆盖所有会话并恢复全账号范围', async () => {
  await open(['friend'])
  await wrapper.find('[aria-label="搜索聊天范围"]').setValue('项目')
  expect(options()).toHaveLength(1)
  expect(options()[0].element.checked).toBe(false)
  await click('[aria-label="所有聊天"]')
  expect(options()[0].element.checked).toBe(true)
  await wrapper.find('[aria-label="搜索聊天范围"]').setValue('')
  expect(options().every(input => input.element.checked)).toBe(true)
  await click('[aria-label="应用聊天范围"]')
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toBeNull()
})

it('恢复固定范围，不因手动选齐当前列表而扩大为全账号', async () => {
  const saved = ['friend']
  await open(saved)
  expect(options().map(input => input.element.checked)).toEqual([true, false, false])
  await click('input[value="project@chatroom"]')
  await click('input[value="design@chatroom"]')
  expect(wrapper.find('[aria-label="所有聊天"]').element.checked).toBe(true)
  await click('[aria-label="应用聊天范围"]')
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual(['friend', 'project@chatroom', 'design@chatroom'])
  expect(saved).toEqual(['friend'])
})
