import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentSourceInspector from '../components/chat/AgentSourceInspector.vue'

const source = { source:'a'.repeat(24), anchor:'m2', username:'chat', name:'测试会话', sender:'甲', time:100, text:'引用原文' }
let wrapper
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }

describe('展开视图原文对照', () => {
  it('显示真实引用附近的上下文，保留接口返回的发送者和时间', async () => {
    const messages = Array.from({length:9},(_,i)=>({id:`m${i}`,senderDisplayName:`发送者${i}`,createTime:100,content:`原消息${i}`}))
    wrapper=mount(AgentSourceInspector,{props:{source,number:1,prepare:async()=>({messages})}})
    await flushPromises()
    expect(wrapper.findAll('.agent-source-context article')).toHaveLength(5)
    expect(wrapper.text()).toContain('发送者2')
    expect(wrapper.text()).not.toContain('原消息5')
    expect(wrapper.find('.agent-source-context .is-selected').text()).toContain('原消息2')
  })
  it('切换引用时丢弃上一条延迟返回的上下文', async () => {
    const first=deferred(),prepare=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({messages:[{id:'new',content:'新上下文'}]})
    wrapper=mount(AgentSourceInspector,{props:{source,number:1,prepare}})
    await wrapper.setProps({source:{...source,anchor:'new',text:'新的引用'},number:2});await flushPromises()
    first.resolve({messages:[{id:'m2',content:'过期上下文'}]});await flushPromises()
    expect(wrapper.text()).toContain('新上下文')
    expect(wrapper.text()).not.toContain('过期上下文')
  })
  it('定位失败保留引用，允许重试且禁止重复提交', async () => {
    const pending=deferred(),locate=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true)
    wrapper=mount(AgentSourceInspector,{props:{source,number:1,locate}});await flushPromises()
    await wrapper.find('.agent-source-locate').trigger('click')
    expect(wrapper.find('.agent-source-locate').attributes('disabled')).toBeDefined()
    pending.reject(new Error('网络断开'));await flushPromises()
    expect(wrapper.text()).toContain('引用原文')
    expect(wrapper.find('[role="alert"]').text()).toBe('网络断开')
    await wrapper.find('.agent-source-locate').trigger('click');await flushPromises()
    expect(locate).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('没有返回锚点时不展示不相关的上下文', async () => {
    wrapper=mount(AgentSourceInspector,{props:{source,number:1,prepare:async()=>({messages:[{id:'other',content:'不相关消息'}]})}})
    await flushPromises()
    expect(wrapper.text()).not.toContain('不相关消息')
    expect(wrapper.text()).toContain('定位到聊天，查看这条消息前后的完整记录')
  })
})
