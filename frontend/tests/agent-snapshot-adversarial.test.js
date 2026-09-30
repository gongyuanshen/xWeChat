import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentRun from '../components/chat/AgentRun.vue'
import AgentSubtasks from '../components/chat/AgentSubtasks.vue'
import AgentAnswer from '../components/chat/AgentAnswer.vue'
import AgentMaterials from '../components/chat/AgentMaterials.vue'
import { mergeRunEvent, mergeTimeline, mergeReferenceData, groupTimelineTools } from '../utils/agentTimeline'
import { renderAgentMarkdown, copyAgentText } from '../utils/agentMarkdown'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../composables/useAiApi', () => ({
  useAiApi: () => ({
    request,
    diagnostic: vi.fn()
  })
}))

describe('M4 Adversarial Challenge: Snapshot State Recovery & Defensive Rendering', () => {
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

  describe('Challenge 1: Corrupted & Null Payloads Defense (Zero White-Screen / Zero TypeError)', () => {
    it('AgentRun: passes completely empty snapshot without errors', async () => {
      const minimal = {
        id: 'min_run_1',
        account: 'user_test',
        version: 1,
        status: 'queued'
      }

      let error = null
      try {
        const wrapper = mount(AgentRun, {
          props: {
            run: minimal,
            viewState: {}
          }
        })
        await flushPromises()
        expect(wrapper.exists()).toBe(true)
        expect(wrapper.text()).not.toContain('NaN')
        wrapper.unmount()
      } catch (err) {
        error = err
      }
      expect(error).toBeNull()
    })

    it('AgentRun: handles null/undefined/missing values for citations, references, subtasks, timeline, segment_started', async () => {
      const corruptedSnapshot = {
        id: 'run_corrupted_adversarial',
        account: 'user_adv',
        version: 1,
        status: 'running',
        stage: '正在分析',
        citations: null,
        references: null,
        subtasks: null,
        timeline: null,
        stage_notes: null,
        read_count: null,
        usage: null,
        segment_started: undefined,
        stage_started_at: undefined,
        elapsed_seconds: undefined,
        answer: null
      }

      let error = null
      try {
        const wrapper = mount(AgentRun, {
          props: {
            run: corruptedSnapshot,
            now: undefined,
            viewState: {}
          }
        })
        await flushPromises()
        expect(wrapper.exists()).toBe(true)
        expect(wrapper.text()).not.toContain('NaN分')
        expect(wrapper.text()).not.toContain('NaN秒')
        wrapper.unmount()
      } catch (err) {
        error = err
      }
      expect(error).toBeNull()
    })

    it('AgentRun: handles valid status timeline items without white-screen', async () => {
      const timeline = [
        { id: 'item_1', seq: 1, kind: 'status', status: 'completed', text: '正在读取群聊', started_at: 100, finished_at: 110 },
        { id: 'item_2', seq: 2, kind: 'status', status: 'running', text: '正在进行两阶段归并', started_at: 110 },
        { id: 'item_3', seq: 3, kind: 'tool', action: 'search', username: 'group1', query: '协议' },
        { id: 'item_4', seq: 4, kind: 'notice', text: '通知信息' }
      ]

      const run = {
        id: 'valid_timeline_run',
        account: 'user1',
        version: 1,
        status: 'running',
        timeline,
        subtasks: { total: 0 }
      }

      let error = null
      try {
        const wrapper = mount(AgentRun, {
          props: {
            run,
            viewState: { valid_timeline_run: true }
          }
        })
        await flushPromises()
        expect(wrapper.exists()).toBe(true)
        expect(wrapper.text()).toContain('读取群聊')
        expect(wrapper.text()).toContain('进行两阶段归并')
        wrapper.unmount()
      } catch (err) {
        error = err
      }
      expect(error).toBeNull()
    })

    it('AgentSubtasks: handles corrupted items and missing time_range fields', async () => {
      request.mockResolvedValue({
        items: [
          { id: 't1', name: null, status: null, elapsed_seconds: null },
          { id: 't2', name: '子任务2', status: 'running', time_range: null },
          { id: 't3', name: '子任务3', status: 'completed', time_range: { start: null, end: null } },
          { id: 't4', name: '子任务4', status: 'queued', coverage: null },
          { id: 't5', name: '子任务5', status: 'failed', latest_progress: null },
          { id: 't6', name: '子任务6', status: 'interrupted', activity: null, findings: null }
        ],
        has_more: false
      })

      const run = {
        id: 'sub_corrupted_run',
        account: 'user1',
        version: 1,
        status: 'running',
        subtasks: {
          total: 6,
          completed: 1,
          running: 1,
          failed: 1,
          interrupted: 1,
          plan_version: 2,
          main_work: null
        }
      }

      let error = null
      try {
        const wrapper = mount(AgentSubtasks, {
          props: { run, now: Date.now() }
        })
        await flushPromises()
        expect(wrapper.exists()).toBe(true)
        wrapper.unmount()
      } catch (err) {
        error = err
      }
      expect(error).toBeNull()
    })

    it('AgentAnswer: safely renders when text is null or undefined', async () => {
      let error = null
      try {
        const wrapper1 = mount(AgentAnswer, {
          props: { text: null, citations: null, references: null }
        })
        await flushPromises()
        expect(wrapper1.exists()).toBe(true)
        wrapper1.unmount()

        const wrapper2 = mount(AgentAnswer, {
          props: { text: undefined, citations: [], references: [] }
        })
        await flushPromises()
        expect(wrapper2.exists()).toBe(true)
        wrapper2.unmount()
      } catch (err) {
        error = err
      }
      expect(error).toBeNull()
    })

    it('AgentAnswer: handles citations with missing fields (empty objects)', async () => {
      const partialCitations = [
        {},
        { source: 'invalid_short_hex' },
        { source: 'abcdef0123456789abcdef01', sender_id: null, sender: null, time: null }
      ]

      let error = null
      try {
        const wrapper = mount(AgentAnswer, {
          props: {
            text: '包含部分出处 [[abcdef0123456789abcdef01]]',
            citations: partialCitations,
            references: null
          }
        })
        await flushPromises()
        expect(wrapper.exists()).toBe(true)
        wrapper.unmount()
      } catch (err) {
        error = err
      }
      expect(error).toBeNull()
    })
  })

  describe('Challenge 2: Citing Non-Existent Sources & Degradation to [来源待核实]', () => {
    it('renderAgentMarkdown: degrades single non-existent source to [来源待核实]', () => {
      const nonexistentId = '111122223333444455556666'
      const markdown = `根据会议纪要 [[${nonexistentId}]]，项目按期推进。`
      const rendered = renderAgentMarkdown(markdown, [], false, [])
      expect(rendered).toContain('class="agent-ref-unresolved"')
      expect(rendered).toContain('[来源待核实]')
      expect(rendered).not.toContain('class="agent-ref"')
    })

    it('renderAgentMarkdown: handles different syntax formats with non-existent source', () => {
      const id1 = 'aaaaaaaaaaaaaaaaaaaaaaaa'
      const id2 = 'bbbbbbbbbbbbbbbbbbbbbbbb'
      const id3 = 'cccccccccccccccccccccccc'
      const id4 = 'dddddddddddddddddddddddd'

      const text = [
        `语法1: [[${id1}]]`,
        `语法2: (source: ${id2})`,
        `语法3: （source：${id3}）`,
        `语法4: [source: ${id4}]`
      ].join('\n')

      const rendered = renderAgentMarkdown(text, [], false, [])
      const count = (rendered.match(/\[来源待核实\]/g) || []).length
      expect(count).toBe(4)
    })

    it('renderAgentMarkdown: mixes valid and non-existent citations correctly', () => {
      const validId = '1234567890abcdef12345678'
      const invalidId = 'ffffffffffffffffffffffff'

      const citations = [
        { source: validId, name: '会话1', sender: '张三', text: '有效引用', time: 1700000000 }
      ]

      const text = `有效：[[${validId}]]，无效：[[${invalidId}]]`
      const rendered = renderAgentMarkdown(text, citations, false, [])

      expect(rendered).toContain(`data-source="${validId}"`)
      expect(rendered).toContain('class="agent-ref"')
      expect(rendered).toContain('[来源待核实]')
    })

    it('copyAgentText: degrades non-existent citations to [来源待核实] in clipboard text', () => {
      const validId = '1234567890abcdef12345678'
      const invalidId = 'ffffffffffffffffffffffff'

      const citations = [
        { source: validId, name: '项目群', sender: '李四', text: '有效引用' }
      ]

      const text = `有效结论 [[${validId}]]，补充待定 [[${invalidId}]]`
      const copied = copyAgentText(text, citations, [])

      expect(copied).toContain('〔项目群 · 李四〕')
      expect(copied).toContain('[来源待核实]')
    })

    it('AgentAnswer: renders unresolved badge and clicking it does not crash or open preview', async () => {
      const invalidId = '999988887777666655554444'
      const wrapper = mount(AgentAnswer, {
        props: {
          text: `未核实信息 [[${invalidId}]]`,
          citations: [],
          references: []
        }
      })
      await flushPromises()

      const badge = wrapper.find('.agent-ref-unresolved')
      expect(badge.exists()).toBe(true)
      expect(badge.text()).toBe('[来源待核实]')

      // Clicking unresolved badge should not trigger any popover
      await badge.trigger('click')
      await flushPromises()

      expect(wrapper.find('.agent-citation-preview').exists()).toBe(false)
      wrapper.unmount()
    })
  })

  describe('Challenge 4: Full Page Refresh Simulation & Complete State Recovery', () => {
    it('simulates full page refresh: serialized snapshot roundtrip perfectly restores all components', async () => {
      // 1. Construct realistic rich snapshot before refresh
      const initialSnapshot = {
        id: 'run_e2e_refresh_1',
        account: 'user_manager',
        version: 8,
        status: 'completed',
        elapsed_seconds: 128,
        read_count: 1420,
        cursor: 'cursor_page_008',
        stage: '报告已生成',
        usage: { input_tokens: 48500, output_tokens: 8200 },
        timeline: [
          { id: 'step_1', seq: 1, kind: 'status', status: 'completed', text: '正在读取 1420 条群聊记录', started_at: 100, finished_at: 112 },
          { id: 'step_2', seq: 2, kind: 'tool', action: 'search', username: 'project_group', query: '交付时间', start: 0, end: 500 },
          { id: 'step_3', seq: 3, kind: 'notice', context_job: { id: 'cmp_99', before: 64000, status: 'completed' }, text: '中间中继压缩完成' },
          { id: 'step_4', seq: 4, kind: 'progress', status: 'completed', text: '第一阶段事实提取完成，参考：[[abcdef0123456789abcdef01]]' },
          { id: 'step_5', seq: 5, kind: 'status', status: 'completed', text: '两阶段全局长报告综合统稿', started_at: 115, finished_at: 128 }
        ],
        subtasks: {
          total: 5,
          completed: 5,
          running: 0,
          queued: 0,
          failed: 0,
          plan_version: 2,
          phase: 'completed',
          main_work: '主模型两阶段长报告统稿',
          parallel_reason: '微批次独立切片提取事实'
        },
        stage_notes: {
          count: 5,
          total_facts: 42,
          covered_ranges: [
            { path: '/notes/batch_00001.json', batch_index: 1, messages_count: 100, facts_count: 8 },
            { path: '/notes/batch_00002.json', batch_index: 2, messages_count: 120, facts_count: 10 },
            { path: '/notes/batch_00003.json', batch_index: 3, messages_count: 95, facts_count: 7 },
            { path: '/notes/batch_00004.json', batch_index: 4, messages_count: 110, facts_count: 9 },
            { path: '/notes/batch_00005.json', batch_index: 5, messages_count: 105, facts_count: 8 }
          ]
        },
        answer: '## 综合长报告\n\n项目核心结论已汇总完毕。详细请参阅群聊记录 [[abcdef0123456789abcdef01]] 与补充记录 [[abcdef0123456789abcdef02]]。',
        citations: [
          { source: 'abcdef0123456789abcdef01', name: '项目推进群', sender: '项目经理', text: '第一阶段需求确认完毕。', time: 1700001000 },
          { source: 'abcdef0123456789abcdef02', name: '项目推进群', sender: '架构师', text: '两阶段事实汇聚完成。', time: 1700002000 }
        ],
        references: [
          { id: 'abcdef0123456789abcdef01', kind: 'source', name: '项目经理' },
          { id: 'abcdef0123456789abcdef02', kind: 'source', name: '架构师' }
        ]
      }

      // 2. Simulate JSON serialization as received over HTTP REST from GET /runs/{id}
      const serialized = JSON.stringify(initialSnapshot)
      const refreshedSnapshot = JSON.parse(serialized)

      // Mock subtask detail page response on reload
      request.mockImplementation((url, options) => {
        if (url.includes('/subtasks')) {
          return Promise.resolve({
            items: [
              { id: 'sub_b1', name: '微批次 1', status: 'completed', coverage: { read: 100, analyzed: 100 } },
              { id: 'sub_b2', name: '微批次 2', status: 'completed', coverage: { read: 120, analyzed: 120 } }
            ],
            has_more: false
          })
        }
        return Promise.resolve({})
      })

      // 3. Mount fresh Vue instance with brand-new viewState (simulating complete refresh)
      const freshViewState = {}
      const wrapper = mount(AgentRun, {
        props: {
          run: refreshedSnapshot,
          now: 1700003000 * 1000,
          viewState: freshViewState
        }
      })

      await flushPromises()

      // A. Verify Process panel and timeline recovery
      expect(wrapper.find('.agent-process-title').text()).toBe('执行过程')
      expect(wrapper.text()).toContain('读取 1420 条群聊记录')
      expect(wrapper.text()).toContain('两阶段全局长报告综合统稿')
      expect(wrapper.text()).toContain('上下文已压缩') // Rendered via AgentContextCompaction

      // B. Verify Subtasks card recovery
      const subtasks = wrapper.findComponent(AgentSubtasks)
      expect(subtasks.exists()).toBe(true)
      expect(wrapper.text()).toContain('5/5 完成')
      expect(wrapper.text()).toContain('主模型正在处理：主模型两阶段长报告统稿')

      // C. Verify Stage Notes count and facts summary in footer
      expect(wrapper.text()).toContain('阶段笔记 5 份 (42 条事实)')
      expect(wrapper.text()).toContain('已读取 1420 条')

      // D. Verify Final Answer and Citations recovery
      const finalAnswerEl = wrapper.find('.agent-final-answer')
      expect(finalAnswerEl.exists()).toBe(true)
      expect(finalAnswerEl.text()).toContain('综合长报告')
      const finalRefButtons = finalAnswerEl.findAll('.agent-ref')
      expect(finalRefButtons).toHaveLength(2)
      expect(finalRefButtons[0].text()).toBe('1')
      expect(finalRefButtons[1].text()).toBe('2')

      wrapper.unmount()
    })
  })
})
