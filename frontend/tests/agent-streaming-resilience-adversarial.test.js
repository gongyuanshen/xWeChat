import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiApi } from '../composables/useAiApi'

describe('M4 Adversarial Stress Suite: Streaming Reconnection & Exponential Backoff', () => {
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

    simulateOpen() {
      this.readyState = 1 // OPEN
      this.onopen?.()
    }

    simulateError(close = false) {
      this.readyState = close ? 2 : 0
      this.onerror?.()
    }

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

  // =========================================================================
  // Challenge 1: Query Delimiter Handling
  // =========================================================================
  describe('Challenge 1: Query Delimiter Handling Under Adversarial Inputs', () => {
    it('1.1 Path without query params creates valid URL with ?ai_trace=', () => {
      const api = useAiApi()
      const stop = api.events('', () => {})
      const url = createdSources[0].url
      expect(url).toMatch(/\/api\/ai\/events\?account=&ai_trace=[a-f0-9]+$/)
      stop()
    })

    it('1.2 Path with single query param creates valid URL with &ai_trace=', () => {
      const api = useAiApi()
      const stop = api.agentEvents('alice@company', () => {})
      const url = createdSources[0].url
      expect(url).toContain('/api/ai/agent/events?account=alice%40company&ai_trace=')
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('account')).toBe('alice@company')
      expect(parsed.searchParams.get('ai_trace')).toBeTruthy()
      stop()
    })

    it('1.3 Path with multiple complex query params preserves all parameters cleanly', () => {
      const api = useAiApi()
      const stop = api.localSearchEvents('alice@company', () => {}, 42)
      const url = createdSources[0].url
      expect(url).toContain('/api/ai/local-search/events?after=42&account=alice%40company&ai_trace=')
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('42')
      expect(parsed.searchParams.get('account')).toBe('alice@company')
      expect(parsed.searchParams.get('ai_trace')).toBeTruthy()
      stop()
    })

    it('1.4 Path with special encoded characters (spaces, %, ampersands) parses without corruption', () => {
      const api = useAiApi()
      const complexAccount = 'user with spaces & special=chars?'
      const stop = api.agentEvents(complexAccount, () => {})
      const url = createdSources[0].url
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('account')).toBe(complexAccount)
      expect(parsed.searchParams.get('ai_trace')).toBeTruthy()
      stop()
    })
  })

  // =========================================================================
  // Challenge 2: Persistent lastEventId Tracking & Re-attachment
  // =========================================================================
  describe('Challenge 2: Persistent lastEventId Tracking & URL Re-attachment', () => {
    it('2.1 Tracks lastEventId monotonically across successive message frames', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      const src1 = createdSources[0]
      src1.simulateOpen()
      src1.simulateMessage({ delta: '1' }, 'evt_001')
      src1.simulateMessage({ delta: '2' }, 'evt_002')
      src1.simulateMessage({ delta: '3' }, 'evt_003')

      // Disconnect
      src1.simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      expect(createdSources).toHaveLength(2)
      const src2 = createdSources[1]
      const parsed = new URL(src2.url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('evt_003')

      stop()
    })

    it('2.2 Empty or missing lastEventId frame does NOT overwrite existing lastEventId', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      const src1 = createdSources[0]
      src1.simulateOpen()
      src1.simulateMessage({ delta: '1' }, 'cursor_999')
      // Message with empty lastEventId
      src1.simulateMessage({ delta: '2' }, '')

      src1.simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      expect(createdSources).toHaveLength(2)
      const parsed = new URL(createdSources[1].url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('cursor_999')

      stop()
    })

    it('2.3 lastEventId with "0" as string is tracked properly', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      const src1 = createdSources[0]
      src1.simulateOpen()
      src1.simulateMessage({ delta: 'init' }, '0')

      src1.simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      expect(createdSources).toHaveLength(2)
      const parsed = new URL(createdSources[1].url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('0')

      stop()
    })

    it('2.4 Successive reconnections without intermediate messages preserve lastEventId across attempts', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 100, maxBackoffMs: 200 })

      const src1 = createdSources[0]
      src1.simulateOpen()
      src1.simulateMessage({ type: 'start' }, 'stable_cursor_42')

      // 1st disconnect & reconnect
      src1.simulateError(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(createdSources).toHaveLength(2)
      expect(new URL(createdSources[1].url, 'http://localhost').searchParams.get('after')).toBe('stable_cursor_42')

      // 2nd disconnect without new messages
      createdSources[1].simulateError(true)
      await vi.advanceTimersByTimeAsync(200)
      expect(createdSources).toHaveLength(3)
      expect(new URL(createdSources[2].url, 'http://localhost').searchParams.get('after')).toBe('stable_cursor_42')

      stop()
    })

    it('2.5 InitialAfter option passes initial cursor on first connect and updates after messages', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, {
        initialAfter: 'initial_cursor_10',
        initialBackoffMs: 100
      })

      // 1st connection should have initialAfter
      const parsed1 = new URL(createdSources[0].url, 'http://localhost')
      expect(parsed1.searchParams.get('after')).toBe('initial_cursor_10')

      createdSources[0].simulateOpen()
      createdSources[0].simulateMessage({ val: 'new' }, 'updated_cursor_20')

      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      expect(createdSources).toHaveLength(2)
      const parsed2 = new URL(createdSources[1].url, 'http://localhost')
      expect(parsed2.searchParams.get('after')).toBe('updated_cursor_20')

      stop()
    })

    it('2.6 Adversarial check: localSearchEvents with existing after=0 in path when cursor advances', async () => {
      const api = useAiApi()
      const stop = api.localSearchEvents('alice', () => {}, 0, { initialBackoffMs: 100 })

      // Initial URL has after=0
      const parsed1 = new URL(createdSources[0].url, 'http://localhost')
      expect(parsed1.searchParams.get('after')).toBe('0')

      createdSources[0].simulateOpen()
      // Message arrives with lastEventId = 77
      createdSources[0].simulateMessage({ search: 'result' }, '77')

      // Disconnect
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      expect(createdSources).toHaveLength(2)
      const parsed2 = new URL(createdSources[1].url, 'http://localhost')
      const afterParam = parsed2.searchParams.get('after')
      expect(afterParam).toBe('77')
      expect(createdSources[1].url).toContain('after=77')

      stop()
    })
  })

  // =========================================================================
  // Challenge 3: Client-Managed Reconnection on CLOSED (2)
  // =========================================================================
  describe('Challenge 3: Client-Managed Reconnection When EventSource Enters CLOSED (2)', () => {
    it('3.1 When readyState === 0 (CONNECTING), client does NOT schedule reconnect, letting browser handle it', async () => {
      const api = useAiApi()
      const disconnectedFn = vi.fn()
      const stop = api.agentEvents('test_user', () => {}, () => {}, disconnectedFn, { initialBackoffMs: 100 })

      const src1 = createdSources[0]
      src1.simulateOpen()

      // simulateError with close=false -> readyState remains 0 (CONNECTING)
      src1.simulateError(false)
      expect(src1.readyState).toBe(0)
      expect(disconnectedFn).toHaveBeenCalledWith(expect.objectContaining({ permanent: false }))

      // Advance time beyond initialBackoffMs
      await vi.advanceTimersByTimeAsync(500)
      // No new client EventSource created because browser is expected to auto-reconnect
      expect(createdSources).toHaveLength(1)

      stop()
    })

    it('3.2 When readyState === 2 (CLOSED), client actively schedules reconnect and closes old source', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      const src1 = createdSources[0]
      src1.simulateOpen()

      // simulateError with close=true -> readyState becomes 2 (CLOSED)
      src1.simulateError(true)
      expect(src1.closed).toBe(true)

      await vi.advanceTimersByTimeAsync(100)
      expect(createdSources).toHaveLength(2)
      expect(createdSources[1].readyState).toBe(0) // new connection initiated

      stop()
    })

    it('3.3 Repeated onerror events while in CLOSED state do NOT cause duplicate timer storms', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 200 })

      const src1 = createdSources[0]
      src1.simulateOpen()

      // Fire error with close=true 5 times rapidly
      src1.simulateError(true)
      src1.simulateError(true)
      src1.simulateError(true)
      src1.simulateError(true)
      src1.simulateError(true)

      await vi.advanceTimersByTimeAsync(200)
      // Exactly 1 new EventSource created, not 5
      expect(createdSources).toHaveLength(2)

      stop()
    })

    it('3.4 Calling stop() during backoff timer immediately aborts reconnection', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 500 })

      const src1 = createdSources[0]
      src1.simulateOpen()
      src1.simulateError(true)

      // Stop before timer fires (at 200ms)
      await vi.advanceTimersByTimeAsync(200)
      stop()

      // Advance past timer duration
      await vi.advanceTimersByTimeAsync(1000)
      expect(createdSources).toHaveLength(1) // No second source created
    })

    it('3.5 Synchronous constructor failure in EventSource gracefully triggers scheduleReconnect without throwing', async () => {
      let failNext = true
      class ThrowingMockEventSource extends MockEventSource {
        constructor(url) {
          if (failNext) {
            failNext = false
            throw new Error('CSP violation: EventSource blocked')
          }
          super(url)
        }
      }
      vi.stubGlobal('EventSource', ThrowingMockEventSource)

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = useAiApi()
      const stop = api.agentEvents('test_user', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      // First creation threw, scheduleReconnect was called
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('创建 EventSource 失败'),
        expect.any(Error)
      )
      expect(createdSources).toHaveLength(0)

      // Advance timer to trigger 2nd attempt
      await vi.advanceTimersByTimeAsync(100)
      expect(createdSources).toHaveLength(1)

      consoleWarnSpy.mockRestore()
      stop()
    })
  })

  // =========================================================================
  // Challenge 4: Exponential Backoff Calculation & Retry Ceiling
  // =========================================================================
  describe('Challenge 4: Exponential Backoff Progression & Hard Retry Ceiling', () => {
    it('4.1 Verifies exact exponential delay progression (1000, 2000, 4000, 8000, 16000, clamped at 16000)', async () => {
      const api = useAiApi()
      const delaysRecorded = []
      const disconnectedFn = vi.fn((status) => {
        if (status?.delay != null) {
          delaysRecorded.push(status.delay)
        }
      })

      const stop = api.agentEvents('test_user', () => {}, () => {}, disconnectedFn, {
        initialBackoffMs: 1000,
        maxBackoffMs: 16000,
        maxRetries: 8
      })

      createdSources[0].simulateOpen()

      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 16000, 16000, 16000]

      for (let i = 0; i < 8; i++) {
        const currentSrc = createdSources.at(-1)
        currentSrc.simulateError(true)
        expect(delaysRecorded[i]).toBe(expectedDelays[i])
        await vi.advanceTimersByTimeAsync(expectedDelays[i])
        expect(createdSources).toHaveLength(i + 2)
      }

      stop()
    })

    it('4.2 Strictly enforces max retry ceiling: halts retries when attempt >= maxRetries', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = useAiApi()
      const disconnectedFn = vi.fn()

      const stop = api.agentEvents('test_user', () => {}, () => {}, disconnectedFn, {
        maxRetries: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 500
      })

      createdSources[0].simulateOpen()

      // Retry 1
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)
      expect(createdSources).toHaveLength(2)

      // Retry 2
      createdSources[1].simulateError(true)
      await vi.advanceTimersByTimeAsync(200)
      expect(createdSources).toHaveLength(3)

      // Retry 3
      createdSources[2].simulateError(true)
      await vi.advanceTimersByTimeAsync(400)
      expect(createdSources).toHaveLength(4)

      // Failure after 3 retries (total 4 sources created)
      createdSources[3].simulateError(true)
      await vi.advanceTimersByTimeAsync(2000)

      // No 5th source created
      expect(createdSources).toHaveLength(4)
      expect(disconnectedFn).toHaveBeenLastCalledWith(
        expect.objectContaining({ permanent: true, fallback: true, attempts: 3 })
      )

      consoleWarnSpy.mockRestore()
      stop()
    })

    it('4.3 Boundary test: maxRetries: 0 triggers immediate fallback on first failure without retrying', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = useAiApi()
      const disconnectedFn = vi.fn()

      const stop = api.agentEvents('test_user', () => {}, () => {}, disconnectedFn, {
        maxRetries: 0,
        initialBackoffMs: 100
      })

      createdSources[0].simulateOpen()
      createdSources[0].simulateError(true)

      // Immediate terminal call
      expect(disconnectedFn).toHaveBeenCalledWith(
        expect.objectContaining({ permanent: true, fallback: true, attempts: 0 })
      )

      await vi.advanceTimersByTimeAsync(1000)
      expect(createdSources).toHaveLength(1)

      consoleWarnSpy.mockRestore()
      stop()
    })

    it('4.4 Successful reconnect (onopen) resets retry counter to 0', async () => {
      const api = useAiApi()
      const delaysRecorded = []
      const disconnectedFn = vi.fn((status) => {
        if (status?.delay != null) delaysRecorded.push(status.delay)
      })

      const stop = api.agentEvents('test_user', () => {}, () => {}, disconnectedFn, {
        initialBackoffMs: 1000,
        maxBackoffMs: 16000
      })

      // Fail 2 times
      createdSources[0].simulateOpen()
      createdSources[0].simulateError(true) // delay 1000
      await vi.advanceTimersByTimeAsync(1000)

      createdSources[1].simulateError(true) // delay 2000
      await vi.advanceTimersByTimeAsync(2000)

      expect(delaysRecorded).toEqual([1000, 2000])

      // 3rd source succeeds and opens!
      createdSources[2].simulateOpen()

      // Later fails again -> should reset and start from delay 1000
      createdSources[2].simulateError(true)
      expect(delaysRecorded[2]).toBe(1000)

      stop()
    })
  })

  // =========================================================================
  // Challenge 5: Non-Silent Degradation (RULE[user_global] Compliance)
  // =========================================================================
  describe('Challenge 5: Non-Silent Degradation & Diagnostics Recording', () => {
    it('5.1 Exceeding maxRetries emits explicit console.warn with full diagnostics payload', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = useAiApi()

      const stop = api.agentEvents('user_abc', () => {}, () => {}, () => {}, {
        maxRetries: 2,
        initialBackoffMs: 50,
        maxBackoffMs: 100
      })

      createdSources[0].simulateOpen()
      createdSources[0].simulateMessage({ stage: 'running' }, 'cursor_xyz')

      // Fail 1
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(50)

      // Fail 2
      createdSources[1].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      // Fail 3 -> reached maxRetries
      createdSources[2].simulateError(true)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[AI Stream] EventSource 重试已达上限 (2 次)'),
        expect.objectContaining({
          component: 'agent',
          lastEventId: 'cursor_xyz',
          attempts: 2
        })
      )

      consoleWarnSpy.mockRestore()
      stop()
    })

    it('5.2 Exceeding maxRetries records sse.max_retries diagnostic event with exact metadata', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = useAiApi()

      const stop = api.agentEvents('user_abc', () => {}, () => {}, () => {}, {
        maxRetries: 1,
        initialBackoffMs: 50
      })

      createdSources[0].simulateOpen()
      createdSources[0].simulateMessage({ stage: 'running' }, 'cursor_999')

      // Fail 1
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(50)

      // Fail 2 -> reached maxRetries
      createdSources[1].simulateError(true)

      // Flush diagnostic queue (1000ms debounce)
      await vi.advanceTimersByTimeAsync(1000)

      const maxRetryDiag = diagnosticsRecords.find(r => r.event === 'sse.max_retries')
      expect(maxRetryDiag).toBeDefined()
      expect(maxRetryDiag.metadata).toMatchObject({
        origin: 'frontend',
        component: 'agent',
        max_retries: 1,
        last_event_id: 'cursor_999',
        reason_code: 'max_retries_exceeded'
      })

      stop()
    })

    it('5.3 Respects enableFallback: false option when max retries exceeded', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const api = useAiApi()
      const disconnectedFn = vi.fn()

      const stop = api.agentEvents('user_abc', () => {}, () => {}, disconnectedFn, {
        maxRetries: 1,
        initialBackoffMs: 50,
        enableFallback: false
      })

      createdSources[0].simulateOpen()
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(50)

      createdSources[1].simulateError(true)

      expect(disconnectedFn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          permanent: true,
          fallback: false,
          attempts: 1
        })
      )

      stop()
    })
  })
})
