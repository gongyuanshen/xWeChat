import { reactive } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { agentModelSelection } from '../lib/agent-model-selection'

const a = { profile_id: 'a', model_id: 'manual-a', reasoning_effort: 'high' }
const b = { profile_id: 'b', model_id: 'model-b', reasoning_effort: null }
const data = choice => ({ profiles: [{ id: 'a' }, { id: 'b' }], selected_model: choice })

describe('全局模型记忆', () => {
  it('开关和预算可以保存恢复，恢复默认不遗留旧字段', async () => {
    const request = vi.fn(async (_, { body }) => body)
    const selection = agentModelSelection(reactive({}), request)
    const budget = { ...b, thinking_budget: 2048 }
    await selection.choose(budget)
    const restored = agentModelSelection(reactive({}), request)
    restored.loaded(data(budget), restored.beginLoad())
    expect(restored.state.choice).toEqual(budget)
    await restored.choose({ ...b, thinking_mode: 'disabled' })
    expect(restored.state.choice).toEqual({ ...b, thinking_mode: 'disabled' })
    await restored.choose(b)
    expect(request.mock.calls.at(-1)[1].body).toEqual(b)
  })
  it('按切换顺序保存，共享视图状态，重启后从服务恢复完整选择', async () => {
    const resolvers = [], shared = reactive({})
    let stored
    const request = vi.fn((_, { body }) => new Promise(resolve => resolvers.push(() => { stored = body; resolve(body) })))
    const first = agentModelSelection(shared, request)
    const second = agentModelSelection(shared, request)
    const one = first.choose(a), two = second.choose(b)
    expect(first.state.choice).toEqual(b)
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    resolvers.shift()(); await one; await flushPromises()
    expect(request).toHaveBeenCalledTimes(2)
    resolvers.shift()(); await two
    const restarted = agentModelSelection(reactive({}), request)
    restarted.loaded(data(stored), restarted.beginLoad())
    expect(restarted.state.choice).toEqual(b)
    expect(request.mock.calls.map(call => call[1].body)).toEqual([a, b])
  })

  it('加载迟到和保存失败不覆盖主动选择，重试后清除错误', async () => {
    const request = vi.fn().mockRejectedValueOnce(Error('离线')).mockResolvedValue(a)
    const selection = agentModelSelection(reactive({}), request)
    const ticket = selection.beginLoad()
    await selection.choose(a)
    selection.loaded(data(b), ticket)
    selection.loaded(data(b), selection.beginLoad())
    expect(selection.state.choice).toEqual(a)
    expect(selection.state.notice).toContain('未保存')
    await selection.choose(selection.state.choice)
    expect(selection.state.notice).toBe('')
  })

  it('删除服务清除选择，手动模型不因目录缺失而清除', () => {
    const selection = agentModelSelection(reactive({}), vi.fn())
    selection.loaded(data(a), selection.beginLoad())
    expect(selection.state.choice).toEqual(a)
    selection.loaded({ profiles: [{ id: 'b' }], selected_model: { unavailable: true } }, selection.beginLoad())
    expect(selection.state.choice).toEqual({})
    expect(selection.state.notice).toContain('删除')
    selection.loaded(data({ unavailable: true }), selection.beginLoad())
    expect(selection.state.choice).toEqual({})
  })

  it('保存进行期间发起的加载，即使迟于保存完成也不回滚模型', async () => {
    let resolve
    const selection = agentModelSelection(reactive({}), () => new Promise(done => { resolve = done }))
    const saved = selection.choose(a)
    const ticket = selection.beginLoad()
    await flushPromises(); resolve(a); await saved
    selection.loaded(data(b), ticket)
    expect(selection.state.choice).toEqual(a)
  })
})
