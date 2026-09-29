import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { expect, it } from 'vitest'
import AgentToolCall from '../components/chat/AgentToolCall.vue'

it('只有重复摘要的读取子命令不可展开，旧展开状态也不会恢复空详情', async () => {
  const items = [175, 179].map((returned, index) => ({ id:`read-${index}`, action:'read_messages', status:'completed',
    started_at:100, finished_at:103, result:{returned,has_more:index === 0} }))
  const view = mount(AgentToolCall, {props:{items,now:103000,viewState:{'tool:read-0':true,'tool-detail:read-0':true}}})
  expect(view.element.tagName).toBe('DETAILS')
  expect(view.findAll('.agent-tool-attempt-row').map(row => row.element.tagName)).toEqual(['DIV','DIV'])
  expect(view.findAll('.agent-tool-attempt-row').map(row => row.text())).toEqual(['首次读取175 条 · 3秒','第 2 次读取179 条 · 3秒'])
  expect(view.find('.agent-attempt-chevron').exists()).toBe(false)
  expect(view.find('.agent-tool-inspection-panel').exists()).toBe(false)
  expect(view.find('.agent-tool-attempt-row').attributes('aria-controls')).toBeUndefined()
  await view.setProps({items:[{...items[0],result:{...items[0].result,warning:'部分消息无法读取'}},items[1]]})
  expect(view.find('.agent-tool-inspection').element.tagName).toBe('DETAILS')
  expect(view.find('.agent-tool-inspection-panel').text()).toContain('部分消息无法读取')
  await view.setProps({items})
  expect(view.find('.agent-tool-inspection-panel').exists()).toBe(false)
  view.unmount()
})

it('单次命令没有额外信息时只显示摘要，有错误详情后才可展开', async () => {
  const item = {id:'scope',action:'select_chat_scope',status:'completed',started_at:100,finished_at:108}
  const view = mount(AgentToolCall, {props:{items:[item],now:108000}})
  expect(view.element.tagName).toBe('DIV')
  expect(view.find('.agent-tool-heading').text()).toContain('确定查询范围')
  expect(view.find('.agent-tool-heading').text()).toContain('8秒')
  expect(view.find('summary').exists()).toBe(false)
  expect(view.find('.agent-tool-chevron').exists()).toBe(false)
  expect(view.find('.agent-tool-detail').exists()).toBe(false)
  await view.setProps({items:[{...item,status:'failed',result:{error:'未找到指定会话'}}]})
  expect(view.element.tagName).toBe('DETAILS')
  expect(view.find('.agent-tool-error').text()).toBe('未找到指定会话')
  view.unmount()
})

it.each([true, false])('读取节点独立展开并在进度更新后保留选择（外部状态：%s）', async external => {
  const items = [0, 1].map(index => ({ id:`read-${index}`,action:'read_messages',status:'completed',username:'sample',offset:index*200,started_at:100,finished_at:105,result:{returned:176-index*2} }))
  const viewState = external ? reactive({}) : undefined
  const props = {items,viewState,now:105000,nameFor:()=> '测试聊天'}
  let view = mount(AgentToolCall, {props})
  const group = view.find('.agent-tool')
  group.element.open = true; await group.trigger('toggle')
  const nodes = view.findAll('.agent-tool-inspection')
  expect(nodes.every(node => !node.element.open)).toBe(true)
  nodes[0].element.open = true; await nodes[0].trigger('toggle')
  expect(nodes[1].element.open).toBe(false)
  const panel = nodes[0].find('.agent-tool-inspection-panel')
  expect(panel.find('header').text()).toBe('读取聊天记录')
  expect(panel.find('.agent-tool-request').text()).toContain('分页位置：0')
  expect(panel.find('.agent-tool-response').text()).toContain('176 条结果')
  expect(panel.find('footer').text()).toContain('已完成')
  await view.setProps({items:items.map(item=>({...item})),now:110000})
  expect(view.findAll('.agent-tool-inspection')[0].element.open).toBe(true)
  expect(view.findAll('.agent-tool-inspection')[1].element.open).toBe(false)
  if (external) {
    view.unmount(); view = mount(AgentToolCall, {props})
    expect(view.findAll('.agent-tool-inspection')[0].element.open).toBe(true)
  }
  view.unmount()
})

const failed = { id: 'failed', action: 'search_messages', text: '搜索聊天记录', status: 'failed',
  result: { error: '本轮尚未选择查询范围，请先调用 select_chat_scope', error_code: 'scope_required' } }

it('执行失败展示具体原因，不冒充成功的零结果检索', () => {
  const view = mount(AgentToolCall, { props: { items: [{ ...failed, result: { ...failed.result, note: failed.result.error } }], now: 0 } })
  expect(view.text()).toContain(failed.result.error)
  expect(view.text().split(failed.result.error)).toHaveLength(2)
  expect(view.text()).not.toContain('0 条结果')
  expect(view.find('.agent-retrieval-label').exists()).toBe(false)
})

it('成功零结果保留结果数量和实际检索方式', () => {
  const view = mount(AgentToolCall, { props: { items: [{ ...failed, status: 'completed',
    result: { returned: 0, retrieval_mode: 'hybrid' } }], now: 0 } })
  expect(view.text()).toContain('0 条结果')
  expect(view.text()).toContain('关键词＋语义')
  expect(view.find('.agent-tool-error').exists()).toBe(false)
})

it('重试成功仍保留首次错误和部分完成状态', () => {
  const view = mount(AgentToolCall, { props: { items: [failed, { ...failed, id: 'retry', status: 'completed',
    result: { returned: 2, retrieval_mode: 'keyword' } }], now: 0 } })
  expect(view.text()).toContain('部分完成')
  expect(view.text()).toContain(failed.result.error)
  expect(view.text()).toContain('2 条结果')
  expect(view.text()).not.toContain('0 条结果')
})

const saveAttempt = (id, status, fields = {}) => ({
  id, action: 'commit_findings', text: '保存分析发现', status, input_version: 1,
  scope_handle: 'scope-a', page_id: 'page-a', started_at: 1, finished_at: 2,
  result: status === 'completed' ? { saved: true, findings: 2 } : { error: '第 1 项来源不属于本页' },
  ...fields,
})
const renderSaves = items => mount(AgentToolCall, { props: { items, now: 2000 } })

it('同页重试成功显示已保存，详情保留失败原因和成功数量', () => {
  const items = [saveAttempt('first', 'failed'), saveAttempt('retry', 'completed')]
  const view = renderSaves(items)
  expect(view.classes()).toContain('is-completed')
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('已保存 · 重试 1 次')
  expect(view.text()).not.toContain('部分完成')
  expect(view.find('.agent-tool-error').text()).toBe('第 1 项来源不属于本页')
  expect(view.text()).toContain('后续已重试并保存成功')
  expect(view.text()).toContain('已保存 2 条发现')
  expect(view.findAll('.agent-tool-attempt-row').map(row => row.text())).toEqual([
    '首次保存失败', '第 2 次保存已保存 2 条发现 · 1秒',
  ])
  expect(view.find('.agent-tool-attempt-row').attributes('title')).toBe('展开本次保存详情')
  expect(items[0].status).toBe('failed')
})

it.each([
  ['不同页', { page_id: 'page-b' }],
  ['不同范围', { scope_handle: 'scope-b' }],
  ['不同输入版本', { input_version: 2 }],
  ['页面未知', { page_id: undefined }],
  ['范围未知', { scope_handle: undefined }],
  ['版本未知', { input_version: undefined }],
  ['无需提交', { result: { saved: false, requires_commit: false } }],
  ['没有保存确认', { result: {} }],
])('%s的成功调用不能掩盖保存失败', (_, fields) => {
  const view = renderSaves([saveAttempt('first', 'failed'), saveAttempt('retry', 'completed', fields)])
  expect(view.classes()).toContain('is-failed')
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('部分完成')
  expect(view.text()).not.toContain('后续已重试并保存成功')
})

it('旧记录缺少页面标识时不猜测恢复结果', () => {
  const view = renderSaves([saveAttempt('first', 'failed', { page_id: undefined }), saveAttempt('retry', 'completed')])
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('部分完成')
})

it('多次失败后同页成功按实际失败次数显示重试', () => {
  const view = renderSaves([saveAttempt('first', 'failed'), saveAttempt('second', 'failed'), saveAttempt('third', 'completed')])
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('已保存 · 重试 2 次')
})

it('多次重试仍失败保持失败状态', () => {
  const view = renderSaves([saveAttempt('first', 'failed'), saveAttempt('second', 'failed')])
  expect(view.classes()).toContain('is-failed')
  expect(view.find('.agent-tool-outcome').text()).toBe('失败')
  expect(view.text()).not.toContain('已保存')
})

it('重试进行中显示进行中，成功事件到达后更新为已保存', async () => {
  const first = saveAttempt('first', 'failed')
  const view = renderSaves([first, saveAttempt('retry', 'running', { finished_at: undefined, result: {} })])
  expect(view.classes()).toContain('is-running')
  expect(view.find('.agent-tool-outcome').text()).toBe('进行中')
  await view.setProps({ items: [first, saveAttempt('retry', 'completed')] })
  expect(view.classes()).toContain('is-completed')
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('已保存 · 重试 1 次')
})

it('同页恢复不能掩盖另一页的失败', () => {
  const view = renderSaves([saveAttempt('first', 'failed'), saveAttempt('retry', 'completed'),
    saveAttempt('other', 'failed', { page_id: 'page-b' })])
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('部分完成')
})

it('先前成功不能掩盖后来的同页失败', () => {
  const view = renderSaves([saveAttempt('first', 'completed'), saveAttempt('retry', 'failed')])
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('部分完成')
})

it('空发现提交也明确显示保存成功', () => {
  const view = renderSaves([saveAttempt('first', 'completed', { result: { saved: true, findings: 0 } })])
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('已保存 0 条发现')
  expect(view.find('.agent-tool-heading').text()).toContain('保存分析发现')
})

it('重复提交不重复累计发现数量', () => {
  const view = renderSaves([saveAttempt('first', 'completed'), saveAttempt('retry', 'completed', { result: { saved: true, reused: true } })])
  expect(view.find('.agent-tool > .agent-tool-heading').text()).toContain('已保存')
  expect(view.find('.agent-tool > .agent-tool-heading').text()).not.toContain('4 条')
})
