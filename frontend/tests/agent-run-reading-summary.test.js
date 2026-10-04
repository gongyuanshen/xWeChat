import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import AgentRun from '../components/chat/AgentRun.vue'

const run = { id: 'r', account: 'a', version: 2, status: 'completed', answer: '', timeline: [], analysis: { known: true, analyzed: 100, segments: 3, findings: 2, complete: false, coverage: [{ username: 'chat', read: 120, analyzed: 100, complete: false }] }, read_count: 120, source_count: 120 }

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
