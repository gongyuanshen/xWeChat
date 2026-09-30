import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiApi } from '../composables/useAiApi'

describe('useAiApi EventSource Streaming Resilience', () => {
  let createdSources = []
  let diagnosticsRecords = []

  class MockEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0 // CONNECTING
      this.onopen = null
      this.onerror = null
      this.onmessage = null
      this.closed = false
      createdSources.push(this)
    }

    close() {
      this.readyState = 2 // CLOSED
      this.closed = true
    }

    // Test helper to simulate connection open
    simulateOpen() {
      this.readyState = 1 // OPEN
      this.onopen?.()
    }

    // Test helper to simulate connection error
    simulateError(close = false) {
      if (close) {
        this.readyState = 2 // CLOSED
      }
      this.onerror?.()
    }

    // Test helper to simulate message
    simulateMessage(data, lastEventId = '') {
      this.onmessage?.({
        data: typeof data === 'string' ? data : JSON.stringify(data),
        lastEventId
      })
    }
  }

  beforeEach(() => {
    window.dispatchEvent(new Event('pagehide'))
    vi.useFakeTimers()
    createdSources = []
    diagnosticsRecords = []

    vi.stubGlobal('useApiBase', () => '/api')
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      try {
        const body = JSON.parse(options?.body || '{}')
        if (body.events) {
          diagnosticsRecords.push(...body.events)
        }
      } catch {}
      return { ok: true }
    }))
  })

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'))
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('正确处理 URL 查询参数分隔符与 ai_trace 关联编号', () => {
    const api = useAiApi()

    // 路径无现有查询参数
    const stop1 = api.events('user@account', () => {})
    expect(createdSources[0].url).toContain('/api/ai/events?account=user%40account&ai_trace=')
    stop1()

    // 路径已有查询参数
    const stop2 = api.localSearchEvents('user@account', () => {}, 10)
    expect(createdSources[1].url).toContain('/api/ai/local-search/events?after=10&account=user%40account&ai_trace=')
    stop2()
  })

  it('追踪 lastEventId 并在重连时自动追加 after 参数', async () => {
    const api = useAiApi()
    const receivedEvents = []
    const readyFn = vi.fn()
    const disconnectedFn = vi.fn()

    const stop = api.agentEvents('test_acc', (ev, meta) => {
      receivedEvents.push({ ev, meta })
    }, readyFn, disconnectedFn, { initialBackoffMs: 500 })

    expect(createdSources).toHaveLength(1)
    const firstSource = createdSources[0]
    expect(firstSource.url).not.toContain('after=')

    // 连接建立
    firstSource.simulateOpen()
    expect(readyFn).toHaveBeenCalledWith({ reconnected: false })

    // 接收带有 lastEventId 的事件帧
    firstSource.simulateMessage({ type: 'run_patch', patch: { stage: '分析中' } }, '105')
    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0].meta.eventId).toBe('105')

    // 模拟原生 EventSource 崩溃并进入 CLOSED 状态
    firstSource.simulateError(true)
    expect(disconnectedFn).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, permanent: false }))

    // 快进退避定时器 (500ms)
    await vi.advanceTimersByTimeAsync(500)

    // 应自动生成第二次连接并追加 &after=105
    expect(createdSources).toHaveLength(2)
    const secondSource = createdSources[1]
    expect(secondSource.url).toContain('&after=105')
    expect(secondSource.url).toContain('/api/ai/agent/events?account=test_acc&ai_trace=')

    // 第二次连接成功，触发 reconnected: true
    secondSource.simulateOpen()
    expect(readyFn).toHaveBeenCalledWith({ reconnected: true })

    stop()
  })

  it('客户端调度指数退避重试 (1s -> 2s -> 4s)', async () => {
    const api = useAiApi()
    const disconnectedFn = vi.fn()

    const stop = api.agentEvents('test_acc', () => {}, () => {}, disconnectedFn, {
      initialBackoffMs: 1000,
      maxBackoffMs: 16000
    })

    const src1 = createdSources[0]
    src1.simulateOpen()

    // 第 1 次断开 (CLOSED) -> 预期 1s 后重连
    src1.simulateError(true)
    expect(disconnectedFn).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 1, delay: 1000 }))

    await vi.advanceTimersByTimeAsync(999)
    expect(createdSources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(createdSources).toHaveLength(2)

    // 第 2 次断开 (CLOSED) -> 预期 2s 后重连
    const src2 = createdSources[1]
    src2.simulateError(true)
    expect(disconnectedFn).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 2, delay: 2000 }))

    await vi.advanceTimersByTimeAsync(1999)
    expect(createdSources).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(createdSources).toHaveLength(3)

    // 第 3 次断开 (CLOSED) -> 预期 4s 后重连
    const src3 = createdSources[2]
    src3.simulateError(true)
    expect(disconnectedFn).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 3, delay: 4000 }))

    await vi.advanceTimersByTimeAsync(4000)
    expect(createdSources).toHaveLength(4)

    stop()
  })

  it('超过 maxRetries 时触发 Warn 日志并通知保底模式', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = useAiApi()
    const disconnectedFn = vi.fn()

    const stop = api.agentEvents('test_acc', () => {}, () => {}, disconnectedFn, {
      maxRetries: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 500,
      enableFallback: true
    })

    // 初始连接与事件
    createdSources[0].simulateOpen()
    createdSources[0].simulateMessage({ type: 'start' }, '42')

    // 连续失败 3 次
    for (let i = 0; i < 3; i++) {
      const current = createdSources.at(-1)
      current.simulateError(true)
      await vi.advanceTimersByTimeAsync(1000)
    }

    // 第 4 次进入 scheduleReconnect，已达上限 (retryAttempt >= 3)
    const lastSource = createdSources.at(-1)
    lastSource.simulateError(true)

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('EventSource 重试已达上限 (3 次)'),
      expect.objectContaining({ lastEventId: '42', attempts: 3 })
    )

    expect(disconnectedFn).toHaveBeenLastCalledWith(
      expect.objectContaining({ permanent: true, fallback: true, attempts: 3 })
    )

    // 刷新诊断队列
    await vi.advanceTimersByTimeAsync(1000)
    expect(diagnosticsRecords.some(r => r.event === 'sse.max_retries' && r.metadata?.last_event_id === '42')).toBe(true)

    consoleWarnSpy.mockRestore()
    stop()
  })

  it('调用 stop() 彻底清理所有退避定时器并关闭连接', async () => {
    const api = useAiApi()
    const stop = api.agentEvents('test_acc', () => {}, () => {}, () => {}, { initialBackoffMs: 1000 })

    const src = createdSources[0]
    src.simulateOpen()
    src.simulateError(true)

    // 定时器已安排，但在触发前主动调用关闭
    stop()
    expect(src.closed).toBe(true)

    // 快进时间，确认没有新的 EventSource 被创建
    await vi.advanceTimersByTimeAsync(5000)
    expect(createdSources).toHaveLength(1)
  })

  it('健全记录异常诊断事件 (sse.invalid JSON 与 reject)', async () => {
    const api = useAiApi()
    const badConsumer = vi.fn(() => { throw new Error('consumer rejected') })

    const stop = api.events('test_acc', badConsumer)
    const src = createdSources[0]
    src.simulateOpen()

    // 1. 非法 JSON 数据
    src.simulateMessage('INVALID_JSON{{{')

    // 2. 正常 JSON 但消费函数抛出异常
    src.simulateMessage({ valid: true })

    await vi.advanceTimersByTimeAsync(1000)
    const events = diagnosticsRecords.map(r => r.event)
    expect(events).toContain('sse.open')
    expect(events.filter(e => e === 'sse.invalid')).toHaveLength(2)

    stop()
  })
})
