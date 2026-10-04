import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentRun from '../components/chat/AgentRun.vue'
import AgentSubtasks from '../components/chat/AgentSubtasks.vue'
import AgentAnswer from '../components/chat/AgentAnswer.vue'
import { mergeRunEvent, mergeTimeline, mergeReferenceData, groupTimelineTools } from '../utils/agentTimeline'
import { renderAgentMarkdown, copyAgentText } from '../utils/agentMarkdown'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../composables/useAiApi', () => ({
  useAiApi: () => ({
    request,
    diagnostic: vi.fn()
  })
}))

describe('Frontend UI State Restoration & Defensive Rendering', () => {
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

  it('页面刷新快照无损复原完整执行状态与阶段笔记', async () => {
    request.mockResolvedValue({
      items: [{
        id: 'sub_1',
        name: '分片 1',
        status: 'completed',
        objective: '分析前 100 条消息',
        coverage: { read: 100, analyzed: 100 }
      }],
      has_more: false
    })

    const snapshot = {
      id: 'run_recovery_1',
      account: 'user1',
      version: 5,
      status: 'completed',
      elapsed_seconds: 45,
      read_count: 350,
      cursor: 'cur_003',
      usage: { input_tokens: 12000, output_tokens: 3500 },
      timeline: [
        { id: 'step_1', seq: 1, kind: 'status', status: 'completed', text: '读取消息记录', started_at: 100, finished_at: 110 },
        { id: 'step_2', seq: 2, kind: 'tool', action: 'search', username: 'contact1', query: '合同', start: 0, end: 100 },
        { id: 'step_3', seq: 3, kind: 'progress', status: 'completed', text: '初步发现：[[abcdef0123456789abcdef01]]' },
        { id: 'step_4', seq: 4, kind: 'notice', context_job: { id: 'cmp_1', before: 50000, status: 'completed' }, text: '上下文压缩完成' }
      ],
      subtasks: {
        total: 2,
        completed: 1,
        running: 1,
        queued: 0,
        plan_version: 2,
        phase: 'analyzing',
        main_work: '主模型核对核心约定'
      },
      stage_notes: {
        count: 3,
        total_facts: 28,
        covered_ranges: [
          { path: '/notes/batch_00001.json', batch_index: 1, messages_count: 120, facts_count: 10 }
        ]
      },
      answer: '最终分析结果如下，参考：[[abcdef0123456789abcdef01]]',
      citations: [
        { source: 'abcdef0123456789abcdef01', name: '会话一', sender: '张三', text: '已收到合同原件。', time: 1700000000 }
      ],
      references: [
        { id: 'abcdef0123456789abcdef01', kind: 'source', name: '张三' }
      ]
    }

    const viewState = {}
    const wrapper = mount(AgentRun, {
      props: {
        run: snapshot,
        now: 1700000050 * 1000,
        viewState
      }
    })

    await flushPromises()

    // 验证过程展开状态
    expect(wrapper.find('.agent-process-title').text()).toBe('执行过程')
    expect(wrapper.text()).toContain('读取消息记录')
    expect(wrapper.text()).toContain('上下文已压缩')

    // 验证子任务组件正常复原
    expect(wrapper.findComponent(AgentSubtasks).exists()).toBe(true)
    expect(wrapper.text()).toContain('主模型正在处理：主模型核对核心约定')

    // 验证回答及出处正常渲染
    expect(wrapper.findComponent(AgentAnswer).exists()).toBe(true)
    expect(wrapper.find('.agent-ref').exists()).toBe(true)
    expect(wrapper.find('.agent-ref').text()).toBe('1')

    // 验证阶段笔记信息在摘要中显示
    expect(wrapper.text()).toContain('阶段笔记 3 份 (28 条事实)')

    wrapper.unmount()
  })

  it('全空与边缘数据防御渲染 (无白屏/无 TypeError)', async () => {
    // 模拟完全缺失/null 的极端快照数据
    const corruptedSnapshot = {
      id: 'run_corrupted',
      account: 'user1',
      version: 1,
      status: 'running',
      stage: '正在初始化',
      citations: null,
      references: null,
      subtasks: null,
      timeline: null,
      stage_notes: null,
      read_count: null,
      usage: null,
      segment_started: undefined,
      stage_started_at: undefined,
      answer: null
    }

    const viewState = {}
    let errorCaught = null

    try {
      const wrapper = mount(AgentRun, {
        props: {
          run: corruptedSnapshot,
          now: undefined, // now 为 undefined
          viewState
        }
      })
      await flushPromises()

      // 验证未崩溃白屏
      expect(wrapper.exists()).toBe(true)
      expect(wrapper.find('.agent-stream-status').text()).toBe('思考中')
      expect(wrapper.text()).not.toContain('NaN')

      wrapper.unmount()
    } catch (e) {
      errorCaught = e
    }

    expect(errorCaught).toBeNull()
  })

  it('AgentSubtasks 接收 null subtasks 时不崩溃', async () => {
    request.mockResolvedValue({ items: [], has_more: false })

    const wrapper = mount(AgentSubtasks, {
      props: {
        run: {
          id: 'sub_null_test',
          account: 'user1',
          version: 1,
          status: 'running',
          subtasks: null
        },
        now: undefined
      }
    })

    await flushPromises()
    expect(wrapper.find('.subtasks-title').text()).toBe('子任务分析')
    expect(wrapper.findAll('.subtask-item')).toHaveLength(0)

    wrapper.unmount()
  })

  it('AgentAnswer 接收 null references / citations 时安全降级', async () => {
    const wrapper = mount(AgentAnswer, {
      props: {
        text: '回答引用 [[abcdef0123456789abcdef01]]',
        citations: null,
        references: null,
        streaming: false
      }
    })

    await flushPromises()
    expect(wrapper.exists()).toBe(true)
    // 缺少 citations 时，未解析的出处降级显示为 [来源待核实]
    expect(wrapper.text()).toContain('[来源待核实]')

    wrapper.unmount()
  })

  it('AgentAnswer 遇缺失时间戳时不产生 Invalid Date', async () => {
    const citation = {
      source: 'abcdef0123456789abcdef02',
      name: '会话二',
      sender: '李四',
      text: '时间缺失的消息',
      time: null
    }

    const wrapper = mount(AgentAnswer, {
      props: {
        text: '回答测试 [[abcdef0123456789abcdef02]]',
        citations: [citation],
        references: [{ id: citation.source, kind: 'source', name: '李四' }],
        streaming: false
      }
    })

    await flushPromises()
    // 点击出处编号触发浮层
    const refBtn = wrapper.find('button[data-source="abcdef0123456789abcdef02"]')
    expect(refBtn.exists()).toBe(true)
    await refBtn.trigger('click')
    await flushPromises()

    const preview = wrapper.find('.agent-citation-preview')
    if (preview.exists()) {
      expect(preview.text()).not.toContain('Invalid Date')
      expect(preview.text()).toContain('未知时间')
    }

    wrapper.unmount()
  })

  it('agentTimeline 工具函数对 null 参数具备完备防御性', () => {
    // 验证 mergeReferenceData 对 null 参数
    expect(() => mergeReferenceData(null, null)).not.toThrow()
    expect(mergeReferenceData(null, [{ id: '1' }], 'id')).toEqual([{ id: '1' }])

    // 验证 mergeTimeline 对 null 参数
    expect(() => mergeTimeline(null, null)).not.toThrow()
    expect(mergeTimeline(null, [{ id: 's1', revision: 1 }])).toEqual([{ id: 's1', revision: 1 }])

    // 验证 groupTimelineTools 对 null 参数
    expect(() => groupTimelineTools(null)).not.toThrow()
    expect(groupTimelineTools(null)).toEqual([])

    // 验证 mergeRunEvent 版本前进与空值安全
    const current = { id: 'r1', version: 1, status: 'running' }
    const event = { run_id: 'r1', version: 2, status: 'completed', citations: null, references: null }
    const next = mergeRunEvent(current, event)
    expect(next.version).toBe(2)
    expect(next.status).toBe('completed')
  })

  it('agentMarkdown 工具函数对 null 参数具备完备防御性', () => {
    expect(() => renderAgentMarkdown(null, null, false, null)).not.toThrow()
    expect(renderAgentMarkdown(null, null, false, null)).toBe('')

    expect(() => copyAgentText(null, null, null)).not.toThrow()
    expect(copyAgentText(null, null, null)).toBe('')

    // 复制存在未解析出处的文本
    const copied = copyAgentText('引用测试 [[0123456789abcdef01234567]]', null, null)
    expect(copied).toContain('[来源待核实]')
  })
})
