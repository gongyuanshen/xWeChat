import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentThreadList from '../components/chat/AgentThreadList.vue'

const items = [{ id: 'first', title: '最近的安排', username: 'friend' }, { id: 'second', title: '上周的讨论', username: 'group' }]
let wrapper
const setup = () => wrapper = mount(AgentThreadList, { attachTo: document.body, props: { items, current: 'first' } })
const open = async (index = 0) => { await wrapper.findAll('.agent-thread-more')[index].trigger('click'); await flushPromises() }
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('会话操作浮层', () => {
  it('使用独立菜单，不把操作表单插入会话条目，并支持切换锚点', async () => {
    setup(); await open()
    expect(wrapper.find('.agent-thread-item .agent-thread-management').exists()).toBe(false)
    expect(wrapper.find('[role="menu"]').attributes('popover')).toBe('auto')
    expect(document.activeElement.textContent).toContain('重命名')
    await open(1)
    expect(wrapper.findAll('[role="menu"]')).toHaveLength(1)
    expect(wrapper.findAll('.agent-thread-more')[0].attributes('aria-expanded')).toBe('false')
    expect(wrapper.findAll('.agent-thread-more')[1].attributes('aria-expanded')).toBe('true')
  })

  it('方向键移动菜单焦点，Escape 关闭并回到原按钮', async () => {
    setup(); await open()
    await wrapper.find('[role="menu"]').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement.textContent).toContain('删除对话')
    await wrapper.find('[role="menu"]').trigger('keydown', { key: 'Home' })
    expect(document.activeElement.textContent).toContain('重命名')
    await wrapper.find('[role="menu"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.agent-thread-more').element)
  })

  it('点击外部、滚动列表、调整窗口及隐藏当前条目时关闭', async () => {
    setup(); await open()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises(); expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await open(); await wrapper.find('.agent-thread-items').trigger('scroll')
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await open(); window.dispatchEvent(new Event('resize'))
    await flushPromises(); expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await open(); await wrapper.find('[aria-label="搜索 AI 会话"]').setValue('上周')
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('重命名自动选中文字，只提交有效名称，并在保存后收起', async () => {
    setup(); await open()
    await wrapper.find('[role="menuitem"]').trigger('click'); await flushPromises()
    const input = wrapper.find('[aria-label="对话新名称"]')
    expect(document.activeElement).toBe(input.element)
    expect(input.element.selectionEnd).toBe(items[0].title.length)
    await input.setValue('  明天的安排  ')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('rename')[0]).toEqual([items[0], '明天的安排'])
    await wrapper.setProps({ busy: true }); await wrapper.setProps({ busy: false })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  })

  it('删除先确认并默认聚焦取消，取消不删除会话', async () => {
    setup(); await wrapper.setProps({ runningIds: ['first'] }); await open()
    await wrapper.findAll('[role="menuitem"]')[1].trigger('click'); await flushPromises()
    expect(wrapper.find('[role="dialog"]').text()).toContain('正在运行的任务也会停止')
    expect(document.activeElement.textContent).toBe('取消')
    expect(wrapper.emitted('delete')).toBeUndefined()
    await wrapper.find('.agent-thread-menu-actions button:last-child').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.emitted('delete')).toBeUndefined()
  })

  it('底部菜单向上展开，重命名宽度受视口限制', async () => {
    vi.stubGlobal('innerWidth', 240); vi.stubGlobal('innerHeight', 300)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return this.classList.contains('agent-thread-management')
        ? { height: 90 }
        : { top: 260, bottom: 286, right: 220 }
    })
    setup(); await open()
    expect(wrapper.find('[role="menu"]').element.style.top).toBe('166px')
    expect(wrapper.find('[role="menu"]').element.style.left).toBe('44px')
    await wrapper.find('[role="menuitem"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[role="dialog"]').element.style.width).toBe('224px')
    expect(wrapper.find('[role="dialog"]').element.style.left).toBe('8px')
  })
})
