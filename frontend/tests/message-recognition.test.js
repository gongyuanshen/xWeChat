import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, ref } from 'vue'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMessageRecognition } from '../composables/chat/useMessageRecognition'

const message = id => ({ id: `db:t:${id}`, serverIdStr: String(id), createTime: id, content: `消息${id}`, renderType: 'text', isSent: false })
const wrappers = []
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.useRealTimers() })
async function settle() { await flushPromises(); await new Promise(resolve => setTimeout(resolve, 15)); await flushPromises() }
function setup({ saved = false, messages = [message(1)], contact: initialContact = { username: 'friend' }, intercept, keepAlive = false } = {}) {
  const account = ref('acc'), contact = ref(initialContact), loaded = ref(messages), engine = ref('api'), choice = ref({ profile_id: 'p', model_id: 'm' })
  let enabled = saved, sequence = 0, batch = null, callback, state
  const cache = new Map()
  const record = r => ({ ...r, text: `消息${r.time}`, emotion: '温和友善', intent: '日常交流', reason: '依据原文', source: r.identity, sources: [r.identity], sender_id: 'friend' })
  const request = vi.fn(async (path, options) => {
    const custom = intercept?.(path, options); if (custom !== undefined) return custom
    if (path.endsWith('/state')) return { scope_id: options.body.username, enabled, items: options.body.messages.map(r => cache.get(r.identity)).filter(Boolean), batch, mood: null }
    if (path.endsWith('/settings')) { enabled = options.body.enabled; if (!enabled && batch) batch = { ...batch, status: 'cancelled' }; return { scope_id: options.body.username, enabled, items: [], batch, mood: null } }
    if (path.endsWith('/batches')) { if (options.body.context.length && Math.max(...options.body.context.map(r => r.time)) > Math.min(...options.body.messages.map(r => r.time))) throw new Error('前文不能晚于批次目标消息'); batch = { id: `batch${++sequence}`, scope_id: options.body.username, status: 'running', progress: { total: options.body.messages.length, analyzed: 0 }, delivery_mode: 'stream', items: [], mood: null, error: null, messages: options.body.messages }; return batch }
    return batch
  })
  const visible = ref(true), closeEvents = vi.fn()
  const component = defineComponent({ setup() { state = useMessageRecognition({ account, contact, messages: loaded, engine, modelChoice: choice, api: { request, events: (_, fn) => { callback = fn; return closeEvents } } }); return () => null } })
  wrappers.push(mount(keepAlive ? defineComponent({ setup: () => () => h(KeepAlive, null, () => visible.value ? h(component) : null) }) : component))
  const emit = body => callback({ kind: 'insight_live', body: { scope_id: contact.value.username, batch_id: batch.id, ...body } })
  const finish = async (status = 'completed') => { const items = batch.messages.map(record); items.forEach(r => cache.set(r.identity, r)); batch = { ...batch, items, status, progress: { total: items.length, analyzed: items.length }, error: status === 'failed' ? { code: 'MODEL', message: '模型失败', diagnostic_id: 'd' } : null }; emit({ status, error: batch.error }); await settle() }
  return { state, request, loaded, account, contact, engine, choice, emit, finish, cache, record, visible, closeEvents, batch: () => batch }
}

describe('缓存聊天页的识别生命周期', () => {
  it('离开时停止轮询和自动提交，返回读取漏掉的结果并仅识别新增消息', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const c = setup({ saved: true, keepAlive: true }); await settle()
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/state'))).toHaveLength(1)
    const selectedModel = c.choice.value
    c.closeEvents.mockClear(); c.visible.value = false; await settle()
    expect(c.closeEvents).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    const requests = c.request.mock.calls.length
    c.loaded.value.push(message(2)); await settle(); await c.finish()
    await vi.advanceTimersByTimeAsync(9000); await settle()
    expect(c.request).toHaveBeenCalledTimes(requests)
    expect(c.state.enabled.value).toBe(true)
    expect(c.choice.value).toBe(selectedModel)
    c.visible.value = true; await settle()
    expect(c.state.labels.value['s:1']).toBeTruthy()
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/batches')).map(([, options]) => options.body.messages.map(r => r.identity))).toEqual([['s:1'], ['s:2']])
    expect(c.request.mock.calls.some(([path]) => path.endsWith('/settings') || path.endsWith('/cancel'))).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('返回发生在旧同步请求完成之前仍保留强制刷新，不重复分析已完成消息', async () => {
    let hold = false, resolveState, oldBatch
    const c = setup({ saved: true, keepAlive: true, intercept: (path, options) => {
      if (hold && path.endsWith('/state') && options.body.messages.length === 1 && options.body.messages[0].identity === 's:2') {
        hold = false
        return new Promise(resolve => { resolveState = resolve })
      }
    } }); await settle()
    oldBatch = c.batch(); hold = true; c.loaded.value.push(message(2)); await settle()
    expect(resolveState).toBeTypeOf('function')
    c.visible.value = false; await settle(); await c.finish()
    c.visible.value = true; await settle()
    resolveState({ scope_id: 'friend', enabled: true, items: [], batch: oldBatch, mood: null }); await settle()
    const states = c.request.mock.calls.filter(([path]) => path.endsWith('/state'))
    expect(states.at(-1)[1].body.messages.map(r => r.identity)).toEqual(['s:1', 's:2'])
    expect(c.state.labels.value['s:1']).toBeTruthy()
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/batches')).map(([, options]) => options.body.messages.map(r => r.identity))).toEqual([['s:1'], ['s:2']])
    expect(c.state.loading.value).toBe(false)
  })

  it('未开启识别的缓存页返回后仍关闭且不创建批次', async () => {
    const c = setup({ keepAlive: true }); await settle()
    c.visible.value = false; await settle(); c.loaded.value.push(message(2)); await settle()
    c.visible.value = true; await settle()
    expect(c.state.enabled.value).toBe(false)
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/batches') || path.endsWith('/settings'))).toEqual([])
    expect(c.state.pending.value).toBe(2)
  })

  it('离开后在途批次完成保留队列，回来确认已存结果后才派发下一批', async () => {
    let resolveBatch, submitted, completed
    const c = setup({ saved: true, keepAlive: true, messages: Array.from({ length: 21 }, (_, i) => message(i + 1)), intercept: (path, options) => {
      if (path.endsWith('/batches') && !submitted) {
        submitted = options.body.messages
        return new Promise(resolve => { resolveBatch = resolve })
      }
      if (path.endsWith('/state') && completed) return { scope_id: 'friend', enabled: true, items: completed.items, batch: completed, mood: null }
    } }); await settle()
    expect(submitted).toHaveLength(20)
    c.visible.value = false; await settle()
    completed = { id: 'in-flight', scope_id: 'friend', status: 'completed', items: submitted.map(c.record), progress: { total: 20, analyzed: 20 }, mood: null, error: null }
    resolveBatch(completed); await settle()
    const posts = () => c.request.mock.calls.filter(([path]) => path.endsWith('/batches'))
    expect(posts()).toHaveLength(1)
    expect(c.state.pending.value).toBe(1)
    expect(c.state.enabled.value).toBe(true)
    c.visible.value = true; await settle()
    expect(posts()).toHaveLength(2)
    expect(posts()[1][1].body.messages.map(r => r.identity)).toEqual(['s:21'])
    expect(Object.keys(c.state.labels.value)).toHaveLength(20)
  })
})

describe('已加载消息自动识别', () => {
  it.each([{ username: 'friend' }, { username: 'group@chatroom' }])('私聊与群聊同步、识别、追加前文及迟到标签均排除本人（%j）', async contact => {
    const c = setup({ contact, messages: [{ ...message(1), isSent: true }, message(2), { ...message(3), isSent: true }, message(4)] })
    await settle(); await c.state.setEnabled(true); await settle()
    const posts = () => c.request.mock.calls.filter(([path]) => path.endsWith('/batches'))
    expect(posts()[0][1].body.messages.map(r => r.identity)).toEqual(['s:2', 's:4'])
    expect(posts()[0][1].body.context).toEqual([])
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/state')).flatMap(([, options]) => options.body.messages.map(r => r.identity))).not.toContain('s:1')
    await c.finish()
    c.loaded.value.push({ ...message(5), isSent: true }, message(6)); await settle()
    expect(posts()[1][1].body.messages.map(r => r.identity)).toEqual(['s:6'])
    expect(posts()[1][1].body.context.map(r => r.identity)).toEqual(['s:2', 's:4'])
    c.emit({ label: c.record({ identity: 's:5', time: 5, fingerprint: createHash('sha256').update('消息5').digest('hex') }) })
    expect(c.state.labels.value['s:5']).toBeUndefined()
  })
  it.each([{ username: 'friend' }, { username: 'group@chatroom' }])('私聊与群聊旧state及旧批次均不恢复本人标签或重新分析（%j）', async contact => {
    const items = [1, 2].map(id => ({ identity: `s:${id}`, time: id, text: `消息${id}`, fingerprint: createHash('sha256').update(`消息${id}`).digest('hex'), emotion: '期待', intent: '邀约', sender_id: id === 1 ? 'acc' : 'friend' }))
    const c = setup({ contact, saved: true, messages: [{ ...message(1), isSent: true }, message(2)], intercept: path => path.endsWith('/state') ? {
      scope_id: contact.username, enabled: true, items, mood: null,
      batch: { id: 'saved-both-senders', scope_id: contact.username, status: 'completed', items, mood: null, progress: { total: 2, analyzed: 2 } },
    } : undefined })
    await settle()
    expect(Object.keys(c.state.labels.value)).toEqual(['s:2'])
    expect(c.state.pending.value).toBe(0)
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/batches'))).toHaveLength(0)
  })
  it.each([{ username: 'friend' }, { username: 'group@chatroom' }])('发送方属性更新后及时移除本人待识别消息与已有标签（%j）', async contact => {
    const c = setup({ contact }); await settle()
    c.loaded.value[0].isSent = true; await settle()
    await c.state.setEnabled(true); await settle()
    expect(c.state.pending.value).toBe(0)
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/batches'))).toHaveLength(0)
    c.loaded.value[0].isSent = false; await settle(); await c.finish()
    expect(c.state.labels.value['s:1']).toBeTruthy()
    c.loaded.value[0].isSent = true; await settle()
    expect(c.state.labels.value['s:1']).toBeUndefined()
  })
  it.each([{ username: 'group@chatroom' }, { username: 'group', isGroup: true }])('群聊只识别其他成员并保留其他成员前文（%j）', async contact => {
    const c = setup({ contact, messages: [{ ...message(1), isSent: true }, message(2)] })
    await settle(); await c.state.setEnabled(true); await settle()
    const posts = () => c.request.mock.calls.filter(([path]) => path.endsWith('/batches'))
    expect(posts()[0][1].body.messages.map(r => r.identity)).toEqual(['s:2'])
    await c.finish()
    expect(c.state.labels.value['s:1']).toBeUndefined()
    expect(c.state.labels.value['s:2']).toBeTruthy()
    expect(c.state.header.value.title).toBe('群聊氛围（其他成员近20条）')
    c.loaded.value.push(message(3)); await settle()
    expect(posts()[1][1].body.messages.map(r => r.identity)).toEqual(['s:3'])
    expect(posts()[1][1].body.context.map(r => r.identity)).toEqual(['s:2'])
  })
  it('默认关闭只读取持久状态；开启分20条串行，新到与历史追加队尾且缓存不重计费', async () => {
    const c = setup({ messages: Array.from({ length: 25 }, (_, i) => message(i + 1)) }); await settle()
    const posts = () => c.request.mock.calls.filter(([p]) => p.endsWith('/batches'))
    expect(c.state.enabled.value).toBe(false); expect(posts()).toHaveLength(0)
    await c.state.setEnabled(true); await settle()
    expect(posts()).toHaveLength(1); expect(posts()[0][1].body.messages).toHaveLength(20)
    c.loaded.value = [message(0), ...c.loaded.value, message(26)]; await settle(); expect(posts()).toHaveLength(1)
    await c.finish(); expect(posts()).toHaveLength(2)
    expect(posts()[1][1].body.messages.map(r => r.time)).toEqual([21,22,23,24,25])
    await c.finish(); expect(posts()[2][1].body.messages.map(r => r.time)).toEqual([0,26])
    await c.finish(); c.loaded.value = [...c.loaded.value]; await settle(); expect(posts()).toHaveLength(3)
  })
  it('SSE逐条即显示；关闭隐藏自动标签并保留缓存，重开不重分析', async () => {
    const c = setup(); await settle(); await c.state.setEnabled(true); await settle()
    const label = c.record(c.batch().messages[0]); c.emit({ status: 'running', label }); await settle()
    expect(c.state.labels.value['s:1'].emotion).toBe('温和友善')
    await c.finish(); await c.state.setEnabled(false)
    expect(c.state.labels.value).toEqual({})
    await c.state.setEnabled(true); await settle()
    expect(c.state.labels.value['s:1']).toBeTruthy()
    expect(c.request.mock.calls.filter(([p]) => p.endsWith('/batches'))).toHaveLength(1)
  })
  it('新文本完成后上翻恢复撤回原文，同serverId系统提示不入队或进入前文', async () => {
    const c = setup({ messages: [message(100)] }); await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    const posts = () => c.request.mock.calls.filter(([path]) => path.endsWith('/batches'))
    const restored = { ...message(50), id: 'anti_revoke:friend:50', isRevoked: true, revokeTime: 51 }
    const notice = { ...message(50), id: 'db:t:51', createTime: 51, type: 10000, renderType: 'system', content: '对方撤回了一条消息', revokedServerId: '50' }
    const reference = { identity: 's:50', time: 50, fingerprint: createHash('sha256').update(restored.content).digest('hex') }
    c.loaded.value = [restored, notice, ...c.loaded.value]; await settle()
    expect(posts()).toHaveLength(2)
    expect(posts()[1][1].body.messages).toEqual([reference])
    expect(posts()[1][1].body.context).toEqual([])
    expect(c.request.mock.calls.filter(([path]) => path.endsWith('/state')).at(-1)[1].body.messages).toEqual([reference])
    await c.finish()
    expect(c.state.error.value).toBe('')
    expect(c.state.pending.value).toBe(0)
    expect(c.state.labels.value['s:50']).toMatchObject({ ...reference, text: '消息50' })
    expect(c.state.labels.value['s:100']).toBeTruthy()
    c.loaded.value.push(message(101)); await settle()
    expect(posts()).toHaveLength(3)
    expect(posts()[2][1].body.messages.map(item => item.identity)).toEqual(['s:101'])
    expect(posts()[2][1].body.context.map(item => [item.identity, item.time])).toEqual([['s:50', 50], ['s:100', 100]])
    expect(posts()[2][1].body.context[0]).toEqual(reference)
  })
  it('消息窗口暂时移除后重新载入，先恢复持久标签而非再创建批次', async () => {
    const c = setup(); await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    c.loaded.value = []; await settle(); c.loaded.value = [message(1)]; await settle()
    expect(c.state.labels.value['s:1']).toBeTruthy()
    expect(c.request.mock.calls.filter(([p]) => p.endsWith('/batches'))).toHaveLength(1)
  })
  it('权威状态已移除失效缓存时不沿用内存中的旧标签', async () => {
    const c = setup(); await settle(); await c.state.setEnabled(true); await settle(); await c.finish()
    await c.state.setEnabled(false); await settle()
    c.cache.clear(); c.batch().items = []
    await c.state.setEnabled(true); await settle()
    expect(c.state.labels.value['s:1']).toBeUndefined()
    expect(c.request.mock.calls.filter(([p]) => p.endsWith('/batches'))).toHaveLength(2)
  })
  it('失败停止派发，显式重试仅提交缺失消息且retry=true', async () => {
    let failed = true
    const c = setup({ intercept: (p, o) => p.endsWith('/batches') && failed ? Promise.reject(new Error('429调用失败')) : undefined }); await settle()
    await c.state.setEnabled(true); await settle()
    expect(c.state.error.value).toContain('429调用失败')
    c.loaded.value.push(message(2)); await settle()
    expect(c.request.mock.calls.filter(([p]) => p.endsWith('/batches'))).toHaveLength(1)
    failed = false; await c.state.retry(); await settle()
    expect(c.request.mock.calls.filter(([p]) => p.endsWith('/batches')).at(-1)[1].body.retry).toBe(true)
  })
  it('切账号/会话/模型后迟到批次和事件不能串结果；local不带API选择', async () => {
    let resolvePost
    const c = setup({ intercept: p => p.endsWith('/batches') ? new Promise(resolve => { resolvePost = resolve }) : undefined }); await settle()
    await c.state.setEnabled(true); await settle()
    c.contact.value = { username: 'next' }; c.loaded.value = []; c.engine.value = 'laya'; await settle()
    resolvePost({ id: 'old', scope_id: 'friend', status: 'completed', items: [{ identity: 's:1', text: '私密', fingerprint: 'x' }], progress: { total: 1, analyzed: 1 }, mood: null }); await settle()
    expect(c.state.labels.value).toEqual({}); expect(c.state.batch.value?.id).not.toBe('old')
    expect(c.request.mock.calls.filter(([p]) => p.endsWith('/state')).at(-1)[1].body.selected_model).toBe(null)
  })
})
