import { afterEach, expect, it, vi } from 'vitest'
import { createDiagnosticQueue, safeDiagnostic } from '../utils/aiDiagnostics'
import { useAiApi } from '../composables/useAiApi'

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals() })

it('仅保留固定事件和白名单字段', () => {
  const value = safeDiagnostic('request.failed', { trace_id: 'a'.repeat(32), http_status: 500, message: 'SECRET', query: 'SECRET', reason_code: 'SECRET', origin: 'frontend' })
  expect(value.metadata).toEqual({ trace_id: 'a'.repeat(32), http_status: 500, origin: 'frontend' })
  expect(safeDiagnostic('SECRET', {})).toBeNull()
})

it('队列有界、按批发送，并明确上报溢出数量', async () => {
  vi.useFakeTimers()
  const send = vi.fn(async () => {})
  const queue = createDiagnosticQueue({ send })
  for (let i = 0; i < 600; i++) queue.record('request.failed', { http_status: 500 })
  expect(queue.size()).toBe(500)
  await queue.flush()
  expect(send.mock.calls[0][0]).toHaveLength(50)
  expect(send.mock.calls[0][0][0]).toMatchObject({ event: 'transport.dropped', metadata: { dropped_count: 101 } })
  expect(new TextEncoder().encode(JSON.stringify({ events: send.mock.calls[0][0] })).length).toBeLessThan(65536)
  queue.stop()
})

it('后端离线有限重试，桌面只接收脱敏兜底，不递归上报', async () => {
  vi.useFakeTimers()
  const send = vi.fn(async () => { throw new Error('SECRET_NETWORK') }), fallback = vi.fn()
  const queue = createDiagnosticQueue({ send, fallback })
  queue.record('request.failed', { http_status: 500, message: 'SECRET' })
  for (let i = 0; i < 5; i++) await queue.flush()
  expect(send).toHaveBeenCalledTimes(4)
  expect(queue.size()).toBe(0)
  expect(JSON.stringify(fallback.mock.calls)).not.toContain('SECRET')
  queue.stop()
})

it('发送中的批次计入 500 条内存上限', async () => {
  vi.useFakeTimers()
  let finish
  const queue = createDiagnosticQueue({ send: () => new Promise(resolve => { finish = resolve }) })
  for (let i = 0; i < 500; i++) queue.record('request.failed', {})
  const pending = queue.flush()
  for (let i = 0; i < 500; i++) queue.record('request.failed', {})
  expect(queue.size()).toBe(500)
  finish(); await pending; queue.stop()
})

it('保留 HTTP 状态及诊断编号，给每次业务请求单独的 trace', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('useApiBase', () => '/api')
  const fetch = vi.fn(async () => { const error = new Error('SECRET'); error.statusCode = 429; error.data = { detail: '服务限流', diagnostic_id: 'b'.repeat(32) }; throw error })
  vi.stubGlobal('$fetch', fetch)
  const api = useAiApi()
  await expect(api.request('/tasks', { method: 'POST', body: { question: 'SECRET' } })).rejects.toMatchObject({ status: 429, diagnostic_id: 'b'.repeat(32) })
  const headers = fetch.mock.calls[0][1].headers
  expect(headers['X-WCDA-AI-Trace']).toMatch(/^[a-f0-9]{32}$/)
})

it('SSE 只记录断线状态变化、恢复和解析失败', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('useApiBase', () => '/api')
  const streams = [], sent = []
  vi.stubGlobal('fetch', vi.fn(async (url, options) => { sent.push(...JSON.parse(options.body).events); return { ok: true } }))
  vi.stubGlobal('EventSource', class { constructor() { streams.push(this) } close() {} })
  const ready = vi.fn(), disconnected = vi.fn()
  const stop = useAiApi().agentEvents('account', () => {}, ready, disconnected)
  streams[0].onopen(); streams[0].onerror(); streams[0].onerror(); streams[0].onopen()
  streams[0].onmessage({ data: 'SECRET_BAD_JSON' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent.map(x => x.event)).toEqual(['sse.open', 'sse.disconnected', 'sse.recovered', 'sse.invalid'])
  expect(JSON.stringify(sent)).not.toContain('SECRET')
  expect(ready).toHaveBeenCalledTimes(2)
  expect(disconnected).toHaveBeenCalledTimes(1)
  stop()
  streams[0].onopen(); streams[0].onerror()
  expect(ready).toHaveBeenCalledTimes(2)
  expect(disconnected).toHaveBeenCalledTimes(1)
})
