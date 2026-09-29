import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import AgentSubtasks from '../components/chat/AgentSubtasks.vue'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../composables/useAiApi', () => ({ useAiApi: () => ({ request }) }))

afterEach(() => { vi.useRealTimers(); request.mockReset() })

it('新规划显示主线、具体分工及交付，不把资料页显示为子任务', async () => {
  const summary = {plan_version:2,total:1,completed:0,running:1,queued:0,phase:'analyzing',
    main_work:'核对第一项约定的条件',parallel_reason:'两项约定使用独立原文',scanning:false}
  request.mockResolvedValue({summary,items:[{id:'one',plan_version:2,name:'第二项约定核查',status:'running',
    objective:'核对第二项约定是否取消',expected_output:'取消条件、来源与疑点',original_goal:'比较两项约定',
    current_action:'提取局部事实',coverage:{read:100,analyzed:50}}],has_more:false})
  const wrapper = mount(AgentSubtasks,{props:{run:{id:'p',account:'a',version:2,status:'running',subtasks:summary}}})
  await flushPromises()
  expect(wrapper.text()).toContain('主模型正在处理：核对第一项约定的条件')
  expect(wrapper.find('.subtask-item > .subtask-goal').text()).toBe('核对第二项约定是否取消')
  expect(wrapper.find('.subtask-item > .subtask-range').text()).toContain('预期交付：取消条件、来源与疑点')
  expect(wrapper.find('.subtask-objective').text()).toContain('原始问题：比较两项约定')
  expect(wrapper.text()).not.toContain('个分片')
  expect(wrapper.findAll('.subtask-item')).toHaveLength(1)
  wrapper.unmount()
})

it('扫描时只显示已发现数量，汇总阶段与分片完成状态分开', async () => {
  request.mockResolvedValue({items:[], has_more:false})
  const run = {id:'plan', account:'a', version:1, status:'running', subtasks:{plan_version:1,
    total:12, completed:4, running:4, queued:4, scanning:true, total_known:false, phase:'analyzing'}}
  const wrapper = mount(AgentSubtasks, {props:{run}})
  await flushPromises()
  expect(wrapper.find('.subtasks-summary').text()).toContain('4 项运行')
  expect(wrapper.find('.subtasks-summary').text()).toContain('4 项等待')
  expect(wrapper.find('.subtasks-total').text()).toBe('4 完成')
  expect(wrapper.find('.subtasks-scan').text()).toContain('已发现 12 个分片')
  await wrapper.setProps({run:{...run,subtasks:{...run.subtasks,scanning:false,total_known:true,
    phase:'reducing',completed:12,running:0,queued:0}}})
  expect(wrapper.find('.subtasks-title').text()).toBe('汇总关联')
  expect(wrapper.find('.subtasks-total').text()).toBe('12/12 完成')
  wrapper.unmount()
})

it('分片日期按任务时区显示，目标和等待原因直接可见', async () => {
  request.mockResolvedValue({items:[{id:'one', plan_version:1, name:'好友 · 分片 1',
    status:'queued', objective:'核对活动安排的变更', stage:'等待执行槽位',
    time_range:{start:0,end:60}}],has_more:false})
  const wrapper = mount(AgentSubtasks,{props:{run:{id:'p',account:'a',version:1,status:'running',
    timezone_offset:28800,subtasks:{total:1,completed:0}}}})
  await flushPromises()
  expect(wrapper.find('.subtask-range').text()).toContain('08:00')
  expect(wrapper.find('.subtask-goal').text()).toBe('核对活动安排的变更')
  expect(wrapper.find('.subtask-action').text()).toBe('等待执行槽位')
  wrapper.unmount()
})

it('单个子任务显示实际分析进度，并在数量未变化时刷新', async () => {
  vi.useFakeTimers()
  const page = analyzed => ({ items: [{ id: 'child', name: '当前聊天 · 范围分析', status: 'running',
    stage: '保存分析发现', started_at: 100, coverage: { read: 20, analyzed, complete: false } }], has_more: false })
  request.mockResolvedValueOnce(page(0)).mockResolvedValue(page(20))
  const wrapper = mount(AgentSubtasks, { props: { now: 110000,
    run: { id: 'parent', account: 'account', version: 1, status: 'running', subtasks: { total: 1, completed: 0 } } } })
  expect(wrapper.find('summary').text()).toContain('子任务分析')
  wrapper.element.open = true
  await wrapper.trigger('toggle')
  await flushPromises()
  expect(wrapper.text()).toContain('已分析 0 条')
  await vi.advanceTimersByTimeAsync(3100)
  await flushPromises()
  expect(wrapper.text()).toContain('已分析 20 条')
  expect(wrapper.text()).toContain('保存分析发现')
  wrapper.element.open = false
  await wrapper.trigger('toggle')
  const calls = request.mock.calls.length
  await vi.advanceTimersByTimeAsync(6000)
  expect(request).toHaveBeenCalledTimes(calls)
  wrapper.unmount()
})

it('运行时不需要展开两次，就能看到动作、最近回复及长时间等待原因', async () => {
  vi.useFakeTimers()
  request.mockResolvedValue({ items: [{ id:'child', name:'好友 · 范围分析', status:'running',
    started_at:100, action_started_at:500, last_activity_at:490, model_running:true,
    current_action:'正在分析已读取的消息', latest_progress:{text:'已整理约饭安排，接下来归纳费用变化。'},
    coverage:{read:350,analyzed:175,complete:false}, activity:[{id:'t',kind:'tool',text:'读取聊天记录',status:'completed'}],
  }], has_more:false })
  const wrapper = mount(AgentSubtasks, { props:{ now:610000, run:{id:'p',account:'a',version:1,status:'running',subtasks:{total:1,completed:0}} } })
  await flushPromises()
  expect(wrapper.element.open).toBe(true)
  expect(wrapper.find('.subtask-progress').text()).toContain('已整理约饭安排')
  expect(wrapper.find('.subtask-progress').element.closest('li > details')).toBe(null)
  expect(wrapper.find('.subtask-action').text()).toContain('正在分析已读取的消息')
  expect(wrapper.find('.subtask-wait').text()).toContain('2分0秒')
  expect(wrapper.find('.subtask-heading').text()).toContain('8分30秒')
  await wrapper.setProps({ run:{...wrapper.props('run'),status:'completed'} })
  await flushPromises()
  const calls = request.mock.calls.length
  await vi.advanceTimersByTimeAsync(6000)
  expect(request).toHaveBeenCalledTimes(calls)
  expect(wrapper.element.open).toBe(true)
  wrapper.unmount()
})

it('旧任务迟到的响应不能覆盖新任务', async () => {
  let resolveOld
  request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValue({ items: [{ id: 'new-child', name: '新任务', status: 'completed' }], has_more: false })
  const run = { id: 'old', account: 'account', version: 1, status: 'running', subtasks: { total: 1, completed: 0 } }
  const wrapper = mount(AgentSubtasks, { props: { run } })
  wrapper.element.open = true
  await wrapper.trigger('toggle')
  await wrapper.setProps({ run: { ...run, id: 'new', status: 'completed' } })
  await flushPromises()
  resolveOld({ items: [{ id: 'old-child', name: '旧任务', status: 'running' }], has_more: false })
  await flushPromises()
  expect(wrapper.text()).toContain('新任务')
  expect(wrapper.text()).not.toContain('旧任务')
  wrapper.unmount()
})

it('长进展可展开且不丢原文，查看详情不会自动暴露长任务说明', async () => {
  const progress = '需要继续核对前后文，确认费用的实际方向。'.repeat(20)
  request.mockResolvedValue({items:[{id:'child',name:'费用分析',status:'running',
    latest_progress:{text:progress},objective:'完整任务说明'.repeat(100),
    activity:[{id:'record',kind:'tool',text:'读取消息',status:'completed'}],
  }],has_more:false})
  const wrapper = mount(AgentSubtasks, {props:{run:{id:'p',account:'a',version:1,status:'running',subtasks:{total:1,completed:0}}}})
  await flushPromises()
  expect(wrapper.find('.subtask-progress').text().length).toBeLessThan(120)
  await wrapper.find('.subtask-expand').trigger('click')
  expect(wrapper.find('.subtask-progress').text()).toBe(progress)
  expect(wrapper.find('.subtask-expand').attributes('aria-expanded')).toBe('true')
  const details = wrapper.find('.subtask-details')
  details.element.open = true
  await details.trigger('toggle')
  expect(wrapper.find('.subtask-objective').element.open).toBe(false)
  expect(wrapper.element.open).toBe(true)
  await wrapper.find('.subtask-expand').trigger('click')
  expect(wrapper.find('.subtask-progress').text().length).toBeLessThan(120)
  wrapper.unmount()
})

it('重新组织的详情仍支持发现分页及来源定位', async () => {
  request.mockResolvedValueOnce({items:[{id:'child',name:'分析',status:'completed',result_handle:'result'}],has_more:false})
    .mockResolvedValueOnce({items:[{text:'待确认分摊方式',sources:['source']}],has_more:false})
    .mockResolvedValueOnce({source:'source',text:'原始消息'})
  const wrapper = mount(AgentSubtasks, {props:{run:{id:'p',account:'a',version:1,status:'running',subtasks:{total:1,completed:0}}}})
  await flushPromises()
  await wrapper.find('.subtask-findings > button').trigger('click')
  await flushPromises()
  expect(wrapper.find('.subtask-findings').text()).toContain('待确认分摊方式')
  expect(wrapper.find('.subtask-findings > button').exists()).toBe(false)
  await wrapper.find('.subtask-findings-list button').trigger('click')
  await flushPromises()
  expect(wrapper.emitted('locate')[0][0]).toEqual({source:'source',text:'原始消息'})
  wrapper.unmount()
})
