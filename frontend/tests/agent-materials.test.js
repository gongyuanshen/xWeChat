import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import AgentMaterials from '../components/chat/AgentMaterials.vue'
import AgentRun from '../components/chat/AgentRun.vue'

let request
beforeEach(() => {
  request = vi.fn(async () => ({ items: [{ text: '报价待确认', sources: [], citations: [] }], total: 21, has_more: true }))
  vi.stubGlobal('useAiApi', () => ({ request }))
})
const run = { id: 'r', account: 'a', version: 2, status: 'completed', answer: '', timeline: [], analysis: { known: true, analyzed: 100, segments: 3, findings: 2, complete: false, coverage: [{ username: 'chat', read: 120, analyzed: 100, complete: false }] }, read_count: 120, source_count: 120 }

it('详细结果分页携带账号和任务版本，搜索重置页码', async () => {
  const wrapper = mount(AgentMaterials, { props: { run } })
  await flushPromises()
  expect(request.mock.calls[0][1].query).toMatchObject({ account: 'a', version: 2, offset: 0, kind: 'findings' })
  await wrapper.findAll('button').find(b => b.text() === '下一页').trigger('click')
  await flushPromises()
  expect(request.mock.lastCall[1].query.offset).toBe(20)
  await wrapper.find('input').setValue('日期')
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  expect(request.mock.lastCall[1].query).toMatchObject({ offset: 0, query: '日期' })
  wrapper.unmount()
})

it('切换任务后丢弃旧资料响应', async () => {
  let resolveOld
  request.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const wrapper = mount(AgentMaterials, { props: { run } })
  await wrapper.setProps({ run: { ...run, id: 'new', account: 'b' } })
  await flushPromises()
  resolveOld({ items: [{ text: '不应显示的旧账号资料' }] })
  await flushPromises()
  expect(wrapper.text()).not.toContain('不应显示')
  expect(request.mock.lastCall[1].query.account).toBe('b')
  wrapper.unmount()
})

it('过程区不展示已读与已分析统计', () => {
  const wrapper = mount(AgentRun, { props: { run, now: Date.now(), nearBottom: true, latest: true, viewState: {} } })
  expect(wrapper.text()).not.toContain('已读取 120 条')
  expect(wrapper.text()).not.toContain('范围尚未处理完成')
  expect(wrapper.text()).not.toContain('%')
  wrapper.unmount()
})

it('普通问答在运行中和完成后均隐藏读取提示', async () => {
  const wrapper = mount(AgentRun, { props: { run: { ...run, analysis: { ...run.analysis, tracked: false, analyzed: 0 } }, now: Date.now(), viewState: {} } })
  expect(wrapper.find('.agent-coverage-summary').exists()).toBe(false)
  await wrapper.setProps({ run: { ...run, status: 'running', analysis: { ...run.analysis, tracked: false, analyzed: 0 } } })
  expect(wrapper.text()).not.toContain('已读取 120 条，按需检索。')
  expect(wrapper.text()).not.toContain('已分析 0 条')
  wrapper.unmount()
})
