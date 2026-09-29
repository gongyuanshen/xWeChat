import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentAnswer from '../components/chat/AgentAnswer.vue'
import { createAnchorContextCache } from '../utils/anchorContextCache'

const sources = ['a', 'b'].map((id, i) => ({ source:id.repeat(24), username:'chat', anchor:`msg${i}`, name:'测试会话', sender:'测试发送者', time:100, text:`原文 ${i + 1}` }))
let wrapper
const mountAnswer = navigation => {
  wrapper = mount(AgentAnswer, { attachTo:document.body, props:{ text:sources.map(s => `内容 [[${s.source}]]`).join('\n'), citations:sources }, global:{ provide:{ agentSourceNavigation:navigation } } })
  wrapper.findAll('.agent-ref').forEach((button, i) => { button.element.getBoundingClientRect = () => ({ top:100 + i * 40, bottom:124 + i * 40, left:100, right:124 }) })
  return wrapper
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes; reject=no }); return { promise, resolve, reject } }
afterEach(() => { wrapper?.unmount(); wrapper=null; vi.restoreAllMocks() })

describe('引用预览交互', () => {
  it('人物打开实际来源序号，未在正文编号的关联原文不冒充来源 1', async () => {
    const id = 'c'.repeat(24), inspect = vi.fn(() => true)
    wrapper = mount(AgentAnswer, {attachTo:document.body, props:{
      text:`[[${sources[0].source}]] [[person:${id}]] [[${sources[1].source}]]`, citations:sources,
      references:[{id,kind:'person',name:'330',sources:[sources[1].source],mentioned_sources:[sources[1].source]}],
    },global:{provide:{agentSourceNavigation:{inspect}}}})
    await wrapper.find('[data-person]').trigger('click'); await flushPromises()
    expect(inspect.mock.calls[0][1]).toBe(2)
    await wrapper.setProps({text:`[[person:${id}]]`})
    await wrapper.find('[data-person]').trigger('click'); await flushPromises()
    expect(inspect.mock.calls[1][1]).toBe(0)
  })

  it('人物胶囊优先显示谈到该人物的原消息，头像仍属于实际发送者', async () => {
    const id = 'c'.repeat(24)
    const own = {...sources[0], sender:'乙', text:'乙自己说的话'}
    const mention = {...sources[1], sender:'甲', text:'甲谈到乙的安排'}
    const old = {...sources[0], source:'e'.repeat(24), sender:'丙', text:'无关的旧提及'}
    wrapper = mount(AgentAnswer, {attachTo:document.body, props:{
      text:`[[person:${id}]] [[${mention.source}]]`, citations:[own, old, mention],
      references:[{id, kind:'person', name:'乙', sources:[own.source, old.source, mention.source], mentioned_sources:[old.source, mention.source]}],
    }})
    const button = wrapper.find('[data-person]')
    button.element.getBoundingClientRect = () => ({top:100,bottom:124,left:100,right:124})
    await button.trigger('click'); await flushPromises()
    expect(wrapper.find('.agent-citation-preview').text()).toContain('甲谈到乙的安排')
    expect(wrapper.find('.agent-citation-preview').text()).not.toContain('乙自己说的话')
    expect(wrapper.find('.agent-citation-preview').text()).not.toContain('无关的旧提及')
  })
  it('悬停后点击固定，流式更新保持预览，点击外部关闭', async () => {
    const prepare = vi.fn(), view = mountAnswer({prepare})
    const button = view.find('.agent-ref')
    await button.trigger('pointerover'); await flushPromises()
    expect(view.find('.agent-citation-preview').attributes('popover')).toBe('manual')
    expect(prepare).not.toHaveBeenCalled()
    await button.trigger('click'); await flushPromises()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(view.find('.agent-citation-preview').exists()).toBe(true)
    await view.setProps({text: `新增内容 [[${sources[0].source}]]`, streaming: true})
    // 新一轮 Markdown 节点在真实布局中仍位于视口内。
    view.find('.agent-ref').element.getBoundingClientRect = () => ({top:100,bottom:124,left:100,right:124})
    await flushPromises()
    expect(view.find('.agent-citation-preview').exists()).toBe(true)
    document.body.dispatchEvent(new Event('pointerdown', {bubbles:true}))
    await flushPromises()
    expect(view.find('.agent-citation-preview').exists()).toBe(false)
  })
  it('紧贴引用打开，预读一次，Esc 关闭并将焦点还给原编号', async () => {
    const prepare = vi.fn(), view = mountAnswer({prepare})
    const button = view.find('.agent-ref')
    await button.trigger('click'); await flushPromises()
    expect(prepare).toHaveBeenCalledWith(sources[0])
    expect(view.find('.agent-citation-preview').element.style.top).toBe('132px')
    expect(button.attributes('aria-expanded')).toBe('true')
    await view.find('.agent-citation-preview').trigger('keydown', {key:'Escape'})
    expect(view.find('.agent-citation-preview').exists()).toBe(false)
    expect(document.activeElement).toBe(button.element)
    expect(button.attributes('aria-expanded')).toBe('false')
  })
  it('定位中阻止重复点击，失败保留原文并允许重试', async () => {
    const task = deferred(), locate = vi.fn().mockReturnValueOnce(task.promise).mockResolvedValueOnce(true)
    const view = mountAnswer({locate})
    await view.find('.agent-ref').trigger('click'); await flushPromises()
    await view.find('.agent-citation-locate').trigger('click')
    expect(view.find('.agent-citation-locate').attributes('disabled')).toBeDefined()
    expect(view.text()).toContain('正在定位')
    await view.find('.agent-citation-locate').trigger('click')
    expect(locate).toHaveBeenCalledTimes(1)
    task.reject(new Error('连接暂时中断')); await flushPromises()
    expect(view.find('[role="alert"]').text()).toBe('连接暂时中断')
    expect(view.text()).toContain('原文 1')
    await view.find('.agent-citation-locate').trigger('click'); await flushPromises()
    expect(view.text()).toContain('已定位原消息')
    expect(view.find('[role="alert"]').exists()).toBe(false)
  })
  it('切换到另一引用后，旧定位失败不会污染新预览', async () => {
    const task = deferred(), view = mountAnswer({locate:() => task.promise})
    await view.findAll('.agent-ref')[0].trigger('click'); await flushPromises()
    await view.find('.agent-citation-locate').trigger('click')
    await view.findAll('.agent-ref')[1].trigger('click'); await flushPromises()
    task.reject(new Error('旧请求失败')); await flushPromises()
    expect(view.find('.agent-citation-preview').text()).toContain('原文 2')
    expect(view.find('[role="alert"]').exists()).toBe(false)
    expect(view.find('.agent-citation-locate').attributes('disabled')).toBeUndefined()
  })
})

describe('来源上下文预读缓存', () => {
  const params = { account:'a', username:'u', anchor_id:'m' }
  it('预读和点击共用进行中的请求，按账号隔离', async () => {
    const task = deferred(), fetch = vi.fn(() => task.promise), cache = createAnchorContextCache(fetch)
    const first = cache.read(params)
    expect(cache.read(params)).toBe(first)
    const other = cache.read({...params,account:'b'})
    expect(other).not.toBe(first)
    task.resolve({messages:[{id:'m'}]}); await Promise.all([first,other])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('失败不缓存，过期或清空后重新读取', async () => {
    const now = vi.spyOn(Date,'now').mockReturnValue(0)
    const fetch = vi.fn().mockRejectedValueOnce(new Error('断线')).mockResolvedValue({messages:[]})
    const cache = createAnchorContextCache(fetch)
    await expect(cache.read(params)).rejects.toThrow('断线')
    await cache.read(params); await cache.read(params)
    expect(fetch).toHaveBeenCalledTimes(2)
    now.mockReturnValue(30001); await cache.read(params)
    cache.clear(); await cache.read(params)
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
