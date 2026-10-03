import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageRecognition } from '../composables/chat/useMessageRecognition'

const message = id => ({ id: `db:t:${id}`, serverIdStr: String(id), createTime: id, content: `人工${id}`, renderType: 'text' })
const wrappers = []
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))
const settle = async () => { await flushPromises(); await new Promise(resolve => setTimeout(resolve, 20)); await flushPromises() }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function setup(rows = [message(1)]) {
  const account = ref('account'), contact = ref({ username: 'friend' }), messages = ref(rows)
  const engine = ref('api'), modelChoice = ref({ profile_id: 'provider', model_id: 'model' })
  const server = { scopeId: 'scope-old', enabled: false, batch: null, cache: new Map(), pauseState: null, pausePost: null, pauseGet: null }
  let sequence = 0, callback, state
  const label = r => ({ ...r, source: r.identity, sender_id: 'friend', emotion: '期待', intent: '邀约', reason: '人工测试', sources: [r.identity] })
  const snapshot = refs => ({ scope_id: server.scopeId, enabled: server.enabled, batch: structuredClone(server.batch),
    mood: null, items: refs.map(r => server.cache.get(r.identity)).filter(Boolean) })
  const request = vi.fn(async (path, options) => {
    if (path.endsWith('/state')) {
      const value = snapshot(options.body.messages)
      if (server.pauseState) { const gate = server.pauseState; server.pauseState = null; await gate.promise }
      return value
    }
    if (path.endsWith('/settings')) {
      server.enabled = options.body.enabled
      if (!server.enabled && server.batch) server.batch = { ...server.batch, status: 'cancelled' }
      return snapshot([])
    }
    if (path.endsWith('/batches')) {
      const { messages: targets, context } = options.body
      if (context.length && Math.max(...context.map(r => r.time)) > Math.min(...targets.map(r => r.time))) {
        throw new Error('422 相邻上下文必须早于当前批次')
      }
      server.batch = { id: `batch${++sequence}`, scope_id: server.scopeId, status: 'running',
        messages: targets, items: [], mood: null, error: null, progress: { total: targets.length, analyzed: 0 } }
      const value = structuredClone(server.batch)
      if (server.pausePost) { const gate = server.pausePost; server.pausePost = null; await gate.promise }
      return value
    }
    const value = structuredClone(server.batch)
    if (server.pauseGet) { const gate = server.pauseGet; server.pauseGet = null; await gate.promise }
    return value
  })
  wrappers.push(mount(defineComponent({ setup() {
    state = useMessageRecognition({ account, contact, messages, engine, modelChoice, api: {
      request, events: (_, fn) => { callback = fn; return vi.fn() },
    } })
    return () => null
  } })))
  const finish = async () => {
    const items = server.batch.messages.map(label)
    items.forEach(item => server.cache.set(item.identity, item))
    server.batch = { ...server.batch, items, status: 'completed', progress: { total: items.length, analyzed: items.length } }
    callback({ kind: 'insight_live', body: { scope_id: server.scopeId, batch_id: server.batch.id, status: 'completed' } })
    await settle()
  }
  return { state, request, server, account, contact, messages, finish,
    emit: body => callback({ kind: 'insight_live', body: { scope_id: server.scopeId, batch_id: server.batch?.id, ...body } }),
    posts: () => request.mock.calls.filter(([p]) => p.endsWith('/batches')) }
}

describe('自动识别独立竞态与真实边界审查', () => {
  it('翻入旧历史与未完成队列混合时，后续批次前文仍早于其全部目标', async () => {
    const c = setup(Array.from({ length: 25 }, (_, i) => message(i + 1)))
    await settle(); await c.state.setEnabled(true); await settle()
    c.messages.value = [message(0), ...c.messages.value, message(26)]
    await settle(); await c.finish()
    expect(c.posts()).toHaveLength(2)
    expect(c.state.error.value).toBe('')
    const { context, messages } = c.posts()[1][1].body
    expect(context.length === 0 || Math.max(...context.map(r => r.time)) <= Math.min(...messages.map(r => r.time))).toBe(true)
  })

  it('同一profile编辑后新scope不能沿用旧标签或漏掉重新分析的消息', async () => {
    const c = setup()
    await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    expect(c.state.labels.value['s:1']).toBeTruthy()
    c.server.scopeId = 'scope-new-revision'; c.server.enabled = false; c.server.batch = null; c.server.cache.clear()
    c.messages.value.push(message(2)); await settle()
    expect(c.state.enabled.value).toBe(false)
    await c.state.setEnabled(true); await settle()
    expect(c.state.labels.value['s:1']).toBeUndefined()
    expect(c.posts().at(-1)[1].body.messages.map(r => r.identity)).toEqual(['s:1', 's:2'])
  })

  it('settings先返回新scope时也必须清理旧模型标签', async () => {
    const c = setup()
    await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    c.server.scopeId = 'scope-new-revision'; c.server.enabled = false; c.server.batch = null; c.server.cache.clear()
    await c.state.setEnabled(false); await settle()
    await c.state.setEnabled(true); await settle()
    expect(c.state.labels.value['s:1']).toBeUndefined()
    expect(c.posts()).toHaveLength(2)
  })

  it('空白文本与无本人文本的引用占位不提交，但纯标点仍提交', async () => {
    const c = setup([{ ...message(1), content: '   ' },
      { ...message(2), content: '[引用消息]', renderType: 'quote' }, { ...message(3), content: '？？？' }])
    await settle(); await c.state.setEnabled(true); await settle()
    expect(c.posts()[0][1].body.messages.map(item => item.identity)).toEqual(['s:3'])
  })

  it('迟到GET不能将同批SSE已确认的进度倒退', async () => {
    const c = setup()
    await settle(); await c.state.setEnabled(true); await settle()
    const gate = deferred(); c.server.pauseGet = gate
    const request = c.state.refresh(); await settle()
    c.emit({ status: 'running', progress: { total: 1, analyzed: 1 } })
    expect(c.state.batch.value.progress.analyzed).toBe(1)
    gate.resolve(); await request; await settle()
    expect(c.state.batch.value.progress.analyzed).toBe(1)
  })

  it('关闭期间迟到POST不能重新显示标签或派发后续批次', async () => {
    const c = setup(Array.from({ length: 21 }, (_, i) => message(i + 1)))
    await settle()
    const gate = deferred(); c.server.pausePost = gate
    await c.state.setEnabled(true); await settle()
    expect(c.posts()).toHaveLength(1)
    await c.state.setEnabled(false); await settle()
    expect(c.state.labels.value).toEqual({})
    gate.resolve(); await settle()
    expect(c.state.enabled.value).toBe(false)
    expect(c.posts()).toHaveLength(1)
    expect(c.state.batch.value?.status).not.toBe('running')
  })

  it('换账号后旧state响应不得恢复旧开关、标签或scope', async () => {
    const c = setup()
    await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    const gate = deferred(); c.server.pauseState = gate
    c.messages.value.push(message(2)); await settle()
    c.server.scopeId = 'new-account'; c.server.enabled = false; c.server.batch = null; c.server.cache.clear()
    c.account.value = 'other'; c.messages.value = []
    await settle(); gate.resolve(); await settle()
    expect(c.state.enabled.value).toBe(false)
    expect(c.state.labels.value).toEqual({})
    expect(c.state.batch.value).toBe(null)
    expect(c.posts()).toHaveLength(1)
  })

  it('已保存失败批次恢复与新消息都不自动重试，只有显式retry继续', async () => {
    const c = setup()
    c.server.enabled = true
    c.server.batch = { id: 'failed-before-reload', scope_id: 'scope-old', status: 'failed',
      messages: [], items: [], mood: null, progress: { total: 1, analyzed: 0 },
      error: { code: 'INSIGHT_INTERRUPTED', message: '上次被中断' } }
    await settle()
    expect(c.state.error.value).toContain('INSIGHT_INTERRUPTED')
    c.messages.value.push(message(2)); await settle()
    expect(c.posts()).toHaveLength(0)
    await c.state.retry(); await settle()
    expect(c.posts()).toHaveLength(1)
    expect(c.posts()[0][1].body.retry).toBe(true)
  })

  it('旧历史情绪与重复终态事件不覆盖最新header或新增分析', async () => {
    const c = setup()
    await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    c.emit({ mood: { kind: 'person', label: '期待', time: 100, revision: 1, sample_count: 1, known_count: 1 } })
    c.emit({ status: 'completed', mood: { kind: 'person', label: '难过', time: 50, revision: 0, sample_count: 1, known_count: 1 } })
    await settle()
    expect(c.state.header.value.label).toBe('期待')
    expect(c.posts()).toHaveLength(1)
    c.emit({ mood: { kind: 'person', label: null, time: 100, revision: 3, sample_count: 1, known_count: 0 } })
    expect(c.state.header.value.label).toBe('证据不足')
  })

  it('同一消息时间的旧GET与旧SSE不能撤销较新revision的失效情绪', async () => {
    const c = setup()
    await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    const old = { kind: 'person', label: '期待', time: 100, revision: 1, sample_count: 1, known_count: 1 }
    c.server.batch.mood = old
    c.emit({ mood: old })
    const gate = deferred(); c.server.pauseGet = gate
    const request = c.state.refresh(); await settle()
    c.emit({ mood: { ...old, label: null, known_count: 0, revision: 2 } })
    expect(c.state.header.value.label).toBe('证据不足')
    gate.resolve(); await request; await settle()
    expect(c.state.header.value.label).toBe('证据不足')
    c.emit({ mood: old })
    expect(c.state.header.value.label).toBe('证据不足')
  })
})
