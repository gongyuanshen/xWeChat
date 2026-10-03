import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { expect, it } from 'vitest'
import AgentRun from '../components/chat/AgentRun.vue'
import AgentToolCall from '../components/chat/AgentToolCall.vue'

const tool = (extra = {}) => ({ id: 'media', kind: 'tool', seq: 1, input_version: 2, action: 'analyze_media',
  text: '分析图片与附件', status: 'running', started_at: 100, ...extra })
const run = timeline => ({ id: 'r', version: 2, status: 'running', stage: '分析图片与附件',
  segment_started: 90, stage_started_at: 100, timeline, coverage_state: 'not_applicable' })
const mountRun = (timeline, open = true) => mount(AgentRun, { props: { run: run(timeline), now: 400000,
  viewState: reactive({ r: open }) } })

it.each([true, false])('真实媒体解析状态在过程展开%s时可见，工具等待不标为思考', open => {
  const detail = '正在提取第 3 页；已处理 2 个片段'
  const view = mountRun([tool({ detail, result: { progress: { phase: 'extracting', label: '第 3 页', completed_units: 2 } } })], open)
  expect(view.get('.agent-stream-status').text()).toBe(detail)
  expect(view.get('.agent-live-step time').text()).toBe('5分0秒')
  expect(view.text()).not.toContain('思考中')
  if (open) expect(view.get('.agent-tool-heading').text()).toContain(detail)
  view.unmount()
})

it('普通文本工具执行显示其实际操作，完成或失败后恢复模型等待而非陈旧工具进度', async () => {
  const item = tool({ action: 'read_messages', text: '读取聊天记录' })
  const view = mountRun([item])
  expect(view.get('.agent-stream-status').text()).toBe('读取聊天记录')
  for (const status of ['completed', 'failed']) {
    await view.setProps({ run: { ...run([tool({ ...item, status, detail: '陈旧解析进度' })]), stage_started_at: 399 } })
    expect(view.get('.agent-stream-status').text()).toBe('思考中')
    expect(view.get('.agent-live-step time').text()).toBe('1秒')
    expect(view.get('.agent-tool-heading').text()).not.toContain('陈旧解析进度')
  }
  view.unmount()
})

it('并行执行选最新的当前版本工具，旧版本与已结束节点不覆盖真实状态', async () => {
  const earlier = tool({ id: 'earlier', seq: 1, detail: '正在读取前一份附件' })
  const current = tool({ id: 'current', seq: 2, detail: '正在识别第 3 页扫描图；已处理 2 个片段', started_at: 399 })
  const stale = tool({ id: 'stale', seq: 3, input_version: 1, detail: '旧版本附件解析' })
  const view = mountRun([earlier, current, stale], false)
  expect(view.get('.agent-stream-status').text()).toBe(current.detail)
  expect(view.get('.agent-live-step time').text()).toBe('1秒')
  await view.setProps({ run: run([earlier, { ...current, status: 'completed' }, stale]) })
  expect(view.get('.agent-stream-status').text()).toBe(earlier.detail)
  await view.setProps({ run: run([{ ...earlier, status: 'failed' }, { ...current, status: 'completed' }, stale]) })
  expect(view.get('.agent-stream-status').text()).toBe('思考中')
  await view.setProps({ run: { ...run([earlier]), status: 'failed' } })
  expect(view.find('.agent-live-step').exists()).toBe(false)
  view.unmount()
})

it('真实模型等待没有运行中工具时显示思考状态', () => {
  const view = mountRun([tool({ status: 'completed', detail: '已处理第 3 页；共 3 个片段' })])
  expect(view.get('.agent-stream-status').text()).toBe('思考中')
  view.unmount()
})

it('运行摘要直接展示结构化真实单位进度，单个片段完成不冒充整份工具完成', async () => {
  const item = tool({ result: { progress: { phase: 'analyzing', label: '第 3 页扫描图', completed_units: 2 } } })
  const view = mount(AgentToolCall, { props: { items: [item], now: 400000 } })
  expect(view.get('.agent-tool-heading').text()).toContain('正在识别第 3 页扫描图；已处理 2 个片段')
  await view.setProps({ items: [{ ...item, result: { progress: { phase: 'completed', label: '第 3 页', completed_units: 3 } } }] })
  expect(view.get('.agent-tool-heading').text()).toContain('已处理第 3 页；共 3 个片段')
  expect(view.get('.agent-tool-outcome').text()).toBe('进行中')
  view.unmount()
})

it('分组摘要展示当前运行调用的进度，完成摘要展示覆盖范围', async () => {
  const previous = tool({ status: 'completed', result: { coverage: '已分析第一页' } })
  const current = tool({ id: 'current', detail: '正在提取第 2 页；已处理 1 个片段' })
  const view = mount(AgentToolCall, { props: { items: [previous, current], now: 400000 } })
  expect(view.get('.agent-tool-heading').text()).toContain(current.detail)
  await view.setProps({ items: [{ ...current, status: 'completed', result: { coverage: '已读取第 1 至 3 页；其余页尚未读取' } }] })
  expect(view.get('.agent-tool-heading').text()).toContain('已读取第 1 至 3 页；其余页尚未读取')
  expect(view.get('.agent-tool-heading').text()).not.toContain(current.detail)
  view.unmount()
})
