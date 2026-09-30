import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentRun from '../components/chat/AgentRun.vue'
import AgentSubtasks from '../components/chat/AgentSubtasks.vue'
import AgentAnswer from '../components/chat/AgentAnswer.vue'
import AgentMaterials from '../components/chat/AgentMaterials.vue'
import { renderAgentMarkdown, copyAgentText } from '../utils/agentMarkdown'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../composables/useAiApi', () => ({
  useAiApi: () => ({
    request,
    diagnostic: vi.fn()
  })
}))

describe('M4 Deep Empirical Challenge: Active Task Snapshot Restoration & Citation Hardening', () => {
  beforeEach(() => {
    request.mockReset()
    vi.stubGlobal('useApiBase', () => '/api')
    vi.stubGlobal('useAiApi', () => ({
      request,
      diagnostic: vi.fn()
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('restores active RUNNING snapshot with dynamic subtasks, superseded tasks, and stage notes summary', async () => {
    const runningSnapshot = {
      id: 'run_active_deep_snap',
      account: 'tester_adv',
      version: 4,
      status: 'running',
      stage: '正在分析第 3 批次',
      elapsed_seconds: 45,
      read_count: 320,
      cursor: 'cur_page_03',
      subtasks: {
        total: 5,
        completed: 2,
        running: 1,
        queued: 1,
        failed: 0,
        superseded: 1,
        plan_version: 2,
        phase: 'analyzing',
        main_work: '微批次独立切片提取事实'
      },
      stage_notes: {
        count: 2,
        total_facts: 18,
        covered_ranges: [
          { path: '/notes/batch_00001.json', batch_index: 1, messages_count: 100, facts_count: 8 },
          { path: '/notes/batch_00002.json', batch_index: 2, messages_count: 120, facts_count: 10 }
        ]
      },
      timeline: [
        { id: 'tl_1', seq: 1, kind: 'status', status: 'completed', text: '读取消息' },
        { id: 'tl_2', seq: 2, kind: 'status', status: 'running', text: '分析第 3 批次' }
      ],
      citations: [
        { source: 'src_valid_1', name: '项目群', sender: '张三', text: '第一阶段完成', time: 1700000100 }
      ],
      references: [
        { id: 'src_valid_1', kind: 'source', name: '张三' }
      ]
    }

    request.mockImplementation((url) => {
      if (url.includes('/subtasks')) {
        return Promise.resolve({
          items: [
            { id: 'sub_1', name: '微批次 1', status: 'completed' },
            { id: 'sub_2', name: '微批次 2', status: 'completed' },
            { id: 'sub_3', name: '微批次 3 (重试)', status: 'running' },
            { id: 'sub_3_old', name: '微批次 3 (原批次)', status: 'superseded' },
            { id: 'sub_4', name: '微批次 4', status: 'queued' }
          ],
          has_more: false
        })
      }
      return Promise.resolve({})
    })

    const wrapper = mount(AgentRun, {
      props: {
        run: runningSnapshot,
        now: 1700000200 * 1000,
        viewState: {}
      }
    })

    await flushPromises()

    // 1. Check Subtasks component mounted and recovered
    const subtasks = wrapper.findComponent(AgentSubtasks)
    expect(subtasks.exists()).toBe(true)
    expect(wrapper.text()).toContain('2/5 完成')
    expect(wrapper.text()).toContain('主模型正在处理：微批次独立切片提取事实')

    // 2. Check running status and live steps
    expect(wrapper.text()).toContain('分析第 3 批次')
    expect(wrapper.text()).toContain('思考中')

    wrapper.unmount()
  })

  it('restores COMPLETED snapshot with final answer, copy action, citations, and stage notes summary', async () => {
    const completedSnapshot = {
      id: 'run_completed_deep_snap',
      account: 'tester_adv',
      version: 5,
      status: 'completed',
      elapsed_seconds: 120,
      read_count: 500,
      answer: '## 研讨总结报告\n根据群聊记录 [[a1b2c3d4e5f60718293a4b5c]]，系统测试全部通过。',
      subtasks: {
        total: 3,
        completed: 3,
        running: 0,
        queued: 0,
        failed: 0,
        plan_version: 2,
        phase: 'completed',
        main_work: '主模型两阶段长报告统稿'
      },
      stage_notes: {
        count: 2,
        total_facts: 18,
        covered_ranges: [
          { path: '/notes/batch_00001.json', batch_index: 1, messages_count: 100, facts_count: 8 },
          { path: '/notes/batch_00002.json', batch_index: 2, messages_count: 120, facts_count: 10 }
        ]
      },
      timeline: [
        { id: 'tl_1', seq: 1, kind: 'status', status: 'completed', text: '两阶段全局统稿完成' }
      ],
      citations: [
        { source: 'a1b2c3d4e5f60718293a4b5c', name: '项目群', sender: '张三', text: '系统测试通过', time: 1700000100 }
      ],
      references: [
        { id: 'a1b2c3d4e5f60718293a4b5c', kind: 'source', name: '张三' }
      ]
    }

    const wrapper = mount(AgentRun, {
      props: {
        run: completedSnapshot,
        now: 1700000500 * 1000,
        viewState: { run_completed_deep_snap: true }
      }
    })

    await flushPromises()

    // 1. Check Subtasks summary
    expect(wrapper.text()).toContain('3/3 完成')

    // 2. Check Stage notes summary in completed footer
    expect(wrapper.text()).toContain('阶段笔记 2 份 (18 条事实)')
    expect(wrapper.text()).toContain('已读取 500 条')

    // 3. Check Final Answer & Citations
    expect(wrapper.text()).toContain('研讨总结报告')
    const refBadge = wrapper.find('.agent-ref')
    expect(refBadge.exists()).toBe(true)
    expect(refBadge.text()).toBe('1')

    wrapper.unmount()
  })

  it('safely handles adjacent and multiple citations without crash or malformed HTML', () => {
    const id1 = '111111111111111111111111'
    const id2 = '222222222222222222222222'
    const id3 = '333333333333333333333333'

    const citations = [
      { source: id1, name: '群1', sender: '李四', text: '引用内容1' },
      { source: id3, name: '群2', sender: '王五', text: '引用内容3' }
    ]

    // id2 is non-existent
    const text = `多引用连续测试：[[${id1}]][[${id2}]][[${id3}]]，以及标点后引用。[[${id1}]]`
    const rendered = renderAgentMarkdown(text, citations, false, [])

    expect(rendered).toContain(`data-source="${id1}"`)
    expect(rendered).toContain('[来源待核实]')
    expect(rendered).toContain(`data-source="${id3}"`)

    // Verify copyAgentText
    const copied = copyAgentText(text, citations, [])
    expect(copied).toContain('〔群1 · 李四〕')
    expect(copied).toContain('[来源待核实]')
    expect(copied).toContain('〔群2 · 王五〕')
  })

  it('AgentMaterials: handles virtual notes rendering and chunk switching', async () => {
    request.mockImplementation((url) => {
      if (url.includes('kind=notes')) {
        return Promise.resolve({
          items: [
            {
              path: '/notes/batch_00001.json',
              batch_index: 1,
              cursor: 'cur_1',
              messages_count: 80,
              facts_count: 5,
              committed_at: '2026-09-30 15:00:00',
              facts: [{ text: '关键发现1', quote: '原文1', sources: ['s1'] }]
            }
          ],
          total: 1,
          total_facts: 5,
          has_more: false,
          offset: 0
        })
      }
      return Promise.resolve({})
    })

    const run = {
      id: 'run_mat_deep',
      account: 'tester_adv',
      version: 1,
      status: 'completed',
      evidence: {}
    }

    const wrapper = mount(AgentMaterials, {
      props: {
        run,
        modelValue: null
      }
    })

    await flushPromises()
    expect(wrapper.exists()).toBe(true)
    wrapper.unmount()
  })
})
