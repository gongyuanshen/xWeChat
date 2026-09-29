import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Compaction from '../components/chat/AgentContextCompaction.vue'
import AgentRun from '../components/chat/AgentRun.vue'
import { mergeTimeline } from '../utils/agentTimeline'

const entry = (status = 'completed', id = 'j') => ({ id: `context:${id}`, seq: 2, kind: 'notice', input_version: 1, status, context_job: { id, status, before: 832995, after: 273953, model_window: 1000000 } })
const run = () => ({ id: 'r', account: 'a', version: 1, status: 'running', stage: '正在整理上下文', timeline: [entry('running')], segment_started: 1, coverage_state: 'not_applicable' })
let request
beforeEach(() => { request = vi.fn(async () => ({ ...entry().context_job, summary: '保留的摘要\n未完成工作：核对转账。' })); vi.stubGlobal('useAiApi', () => ({ request })) })
afterEach(() => vi.unstubAllGlobals())

it('运行中显示触发用量，完成后同一位置默认折叠，展开才读取摘要', async () => {
  const wrapper = mount(Compaction, { props: { item: entry('running'), run: run(), viewState: reactive({}) } })
  expect(wrapper.text()).toContain('当前已用 83.3%')
  expect(wrapper.text()).toContain('原文已保留，完成后自动继续')
  expect(request).not.toHaveBeenCalled()
  await wrapper.setProps({ item: entry() })
  expect(wrapper.text()).toBe('上下文已压缩')
  expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('83.3% → 27.4%')
  expect(wrapper.text()).toContain('核对转账')
  expect(request).toHaveBeenCalledWith('/agent/runs/r/context-compactions/j', { query: { account: 'a', version: 1 } })
  await wrapper.get('button').trigger('click')
  expect(wrapper.text()).toBe('上下文已压缩')
  wrapper.unmount()
})

it('压缩记录随执行过程收起，重新展开后仍能查看原摘要', async () => {
  const state = reactive({ r: true })
  const wrapper = mount(AgentRun, { props: { run: run(), now: 2000, viewState: state } })
  expect(wrapper.findAll('.agent-compaction')).toHaveLength(1)
  expect(wrapper.find('.agent-live-step').exists()).toBe(false)
  await wrapper.get('.agent-process-toggle').trigger('click')
  expect(wrapper.findAll('.agent-compaction')).toHaveLength(0)
  expect(wrapper.get('.agent-live-step').isVisible()).toBe(true)
  await wrapper.setProps({ run: { ...run(), status: 'completed', timeline: [entry(), entry('completed', 'second')] } })
  expect(wrapper.findAll('.agent-compaction')).toHaveLength(0)
  expect(wrapper.get('.agent-process-body').attributes('style')).toContain('display: none')
  await wrapper.get('.agent-process-toggle').trigger('click')
  expect(wrapper.findAll('.agent-compaction')).toHaveLength(2)
  expect(wrapper.findAll('.compaction-summary')).toHaveLength(0)
  await wrapper.findAll('.compaction-divider')[0].trigger('click'); await flushPromises()
  expect(wrapper.get('.compaction-summary').text()).toContain('核对转账')
  await wrapper.get('.agent-process-toggle').trigger('click')
  expect(wrapper.findAll('.agent-compaction')).toHaveLength(0)
  await wrapper.get('.agent-process-toggle').trigger('click'); await flushPromises()
  expect(wrapper.findAll('.agent-compaction')).toHaveLength(2)
  expect(wrapper.get('.compaction-summary').text()).toContain('核对转账')
  wrapper.unmount()
})

it.each(['failed', 'cancelled', 'interrupted'])('任务%s后不伪装为仍压缩或已完成', status => {
  const wrapper = mount(Compaction, { props: { item: entry('running'), run: { ...run(), status }, viewState: {} } })
  expect(wrapper.text()).toBe('上下文压缩已中断')
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  wrapper.unmount()
})

it('读取失败可重试，旧记录缺少窗口时显示 Token 而非借用当前模型', async () => {
  request.mockRejectedValueOnce(new Error('暂时无法读取')).mockResolvedValueOnce({ before: 800, after: 200, summary: null })
  const wrapper = mount(Compaction, { props: { item: entry(), run: run(), viewState: {} } })
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法读取')
  await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises()
  expect(wrapper.text()).toContain('800 → 200 Token')
  expect(wrapper.text()).toContain('未保存可查看的摘要')
  wrapper.unmount()
})

it('旧版本摘要按原版本加载，切换账号或任务后丢弃晚到的结果', async () => {
  let resolveOld
  request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const wrapper = mount(Compaction, { props: { item: entry(), run: { ...run(), version: 2 }, viewState: reactive({}) } })
  await wrapper.get('button').trigger('click')
  expect(request.mock.calls[0][1].query.version).toBe(1)
  await wrapper.setProps({ run: { ...run(), id: 'other', account: 'b' }, item: entry('completed', 'new') })
  resolveOld({ summary: '不属于当前账号的旧摘要' }); await flushPromises()
  expect(wrapper.text()).toBe('上下文已压缩')
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(wrapper.text()).not.toContain('不属于当前账号')
  wrapper.unmount()
})

it('200 条步骤之后仍保留每次压缩，重放不重复', () => {
  const current = [entry(), entry('failed', 'failed')]
  const other = Array.from({ length: 220 }, (_, i) => ({ id: `t${i}`, seq: i + 3, kind: 'tool' }))
  const merged = mergeTimeline(current, other)
  expect(merged).toHaveLength(202)
  expect(mergeTimeline(merged, current)).toEqual(merged)
  expect(merged.slice(0, 2)).toEqual(current)
})
