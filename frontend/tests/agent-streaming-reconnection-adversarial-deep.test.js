import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiApi } from '../composables/useAiApi'

/**
 * Mirror of the exact buildUrl implementation in frontend/composables/useAiApi.js
 * used to test adversarial paths that may not currently be exposed by public wrappers.
 */
function createBuildUrlHarness(base, path) {
  let activeTrace = null
  const aiTrace = () => 'mock_trace_12345'
  return (afterCursor) => {
    activeTrace = aiTrace()
    const delimiter = path.includes('?') ? '&' : '?'
    let url = `${base}/ai${path}${delimiter}ai_trace=${activeTrace}`
    if (afterCursor != null) {
      if (/([?&])after=[^&]*/.test(url)) {
        url = url.replace(/([?&])after=[^&]*/, `$1after=${encodeURIComponent(afterCursor)}`)
      } else {
        url += `&after=${encodeURIComponent(afterCursor)}`
      }
    }
    return url
  }
}

describe('M4 Deep Adversarial Challenge: Streaming Reconnection & URL Building', () => {
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
  // Challenge Group 1: Test 2.6 Deep Verification & Multi-Step Progression
  // =========================================================================
  describe('Challenge Group 1: Test 2.6 Deep Verification & Multi-Step Progression', () => {
    it('1.1 Verifies localSearchEvents with pre-existing after=0 replaces URL parameter to after=77 on advance', async () => {
      const api = useAiApi()
      const eventsReceived = []
      const stop = api.localSearchEvents('alice', (e) => eventsReceived.push(e), 0, { initialBackoffMs: 100 })

      // Initial URL must contain after=0
      expect(createdSources).toHaveLength(1)
      const url1 = new URL(createdSources[0].url, 'http://localhost')
      expect(url1.searchParams.get('after')).toBe('0')
      expect(url1.searchParams.get('account')).toBe('alice')
      expect(url1.searchParams.get('ai_trace')).toBeTruthy()

      // Connect and receive event with lastEventId=77
      createdSources[0].simulateOpen()
      createdSources[0].simulateMessage({ search: 'result1' }, '77')
      expect(eventsReceived).toHaveLength(1)

      // Simulate disconnect CLOSED
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      // Reconnection source #2 must have after=77
      expect(createdSources).toHaveLength(2)
      const url2 = new URL(createdSources[1].url, 'http://localhost')
      expect(url2.searchParams.get('after')).toBe('77')
      expect(url2.searchParams.get('account')).toBe('alice')
      expect(createdSources[1].url).toContain('after=77')
      expect(createdSources[1].url).not.toContain('after=0')

      stop()
    })

    it('1.2 Multi-step cursor progression: after=0 -> after=77 -> after=105 -> disconnects', async () => {
      const api = useAiApi()
      const stop = api.localSearchEvents('bob', () => {}, 0, { initialBackoffMs: 100, maxBackoffMs: 500 })

      // 1st connection
      createdSources[0].simulateOpen()
      createdSources[0].simulateMessage({ step: 1 }, '77')

      // Disconnect #1
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      // 2nd connection has after=77
      expect(createdSources).toHaveLength(2)
      expect(new URL(createdSources[1].url, 'http://localhost').searchParams.get('after')).toBe('77')

      // Advance to 105 on connection #2
      createdSources[1].simulateOpen()
      createdSources[1].simulateMessage({ step: 2 }, '105')

      // Disconnect #2
      createdSources[1].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      // 3rd connection has after=105
      expect(createdSources).toHaveLength(3)
      const url3 = new URL(createdSources[2].url, 'http://localhost')
      expect(url3.searchParams.get('after')).toBe('105')
      expect(createdSources[2].url).not.toContain('after=77')
      expect(createdSources[2].url).not.toContain('after=0')

      stop()
    })
  })

  // =========================================================================
  // Challenge Group 2: Substring Collisions with 'after'
  // =========================================================================
  describe('Challenge Group 2: Parameter Names with "after" as Substring', () => {
    it('2.1 Substring parameter isolation in buildUrl: hereafter, crafter, afternoon, after_id, before_and_after', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events?crafter=123&afternoon=tea&hereafter=999&after_id=456&before_and_after=xyz')
      const initialUrl = buildUrl(null)
      const parsedInitial = new URL(initialUrl, 'http://localhost')
      expect(parsedInitial.searchParams.get('crafter')).toBe('123')
      expect(parsedInitial.searchParams.get('afternoon')).toBe('tea')
      expect(parsedInitial.searchParams.get('hereafter')).toBe('999')
      expect(parsedInitial.searchParams.get('after_id')).toBe('456')
      expect(parsedInitial.searchParams.get('before_and_after')).toBe('xyz')
      expect(parsedInitial.searchParams.get('after')).toBeNull()

      // When afterCursor=8888 is provided, buildUrl should append &after=8888 without touching any other params
      const updatedUrl = buildUrl('8888')
      const parsedUpdated = new URL(updatedUrl, 'http://localhost')
      expect(parsedUpdated.searchParams.get('after')).toBe('8888')
      expect(parsedUpdated.searchParams.get('crafter')).toBe('123')
      expect(parsedUpdated.searchParams.get('afternoon')).toBe('tea')
      expect(parsedUpdated.searchParams.get('hereafter')).toBe('999')
      expect(parsedUpdated.searchParams.get('after_id')).toBe('456')
      expect(parsedUpdated.searchParams.get('before_and_after')).toBe('xyz')
      expect(parsedUpdated.searchParams.get('ai_trace')).toBeTruthy()
    })

    it('2.2 When path has both substring parameter and real after=0, only real after is replaced', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events?hereafter=true&after=0&afternoon=pleasant')
      const updatedUrl = buildUrl('77')
      const parsed = new URL(updatedUrl, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('77')
      expect(parsed.searchParams.get('hereafter')).toBe('true')
      expect(parsed.searchParams.get('afternoon')).toBe('pleasant')
      expect(updatedUrl).toContain('hereafter=true')
      expect(updatedUrl).toContain('afternoon=pleasant')
      expect(updatedUrl).toContain('after=77')
      expect(updatedUrl).not.toContain('after=0')
    })
  })

  // =========================================================================
  // Challenge Group 3: Position of 'after' in Query String
  // =========================================================================
  describe('Challenge Group 3: Position of "after" (Start, Middle, End of Query)', () => {
    it('3.1 "after" at START of query (e.g. ?after=0&account=alice)', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events?after=0&account=alice')
      const url = buildUrl('99')
      expect(url).toMatch(/\/events\?after=99&account=alice/)
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('99')
      expect(parsed.searchParams.get('account')).toBe('alice')
    })

    it('3.2 "after" in MIDDLE of query (e.g. ?account=alice&after=0&role=admin)', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events?account=alice&after=0&role=admin')
      const url = buildUrl('99')
      expect(url).toMatch(/\/events\?account=alice&after=99&role=admin/)
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('99')
      expect(parsed.searchParams.get('account')).toBe('alice')
      expect(parsed.searchParams.get('role')).toBe('admin')
    })

    it('3.3 "after" at END of query (e.g. ?account=alice&after=0)', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events?account=alice&after=0')
      const url = buildUrl('99')
      expect(url).toMatch(/\/events\?account=alice&after=99&ai_trace=/)
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('99')
      expect(parsed.searchParams.get('account')).toBe('alice')
    })

    it('3.4 Path without any query params (e.g. /events)', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events')
      const url = buildUrl('99')
      expect(url).toMatch(/\/events\?ai_trace=[^&]+&after=99$/)
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('99')
    })

    it('3.5 "after" with empty value (e.g. ?after=&account=alice)', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events?after=&account=alice')
      const url = buildUrl('99')
      expect(url).toMatch(/\/events\?after=99&account=alice/)
      const parsed = new URL(url, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe('99')
    })
  })

  // =========================================================================
  // Challenge Group 4: Adversarial Analysis of Multiple "after=" Parameters
  // =========================================================================
  describe('Challenge Group 4: Adversarial Analysis of Multiple "after=" Parameters', () => {
    it('4.1 Empirical finding: buildUrl replaces ONLY the first after= match when duplicate after= exist', () => {
      // If path has duplicate after: /events?after=0&foo=bar&after=10
      const buildUrl = createBuildUrlHarness('/api', '/events?after=0&foo=bar&after=10')
      const url = buildUrl('77')

      // Notice: /([?&])after=[^&]*/ without /g replaces only the first match!
      expect(url).toContain('after=77')
      expect(url).toContain('after=10')

      const parsed = new URL(url, 'http://localhost')
      const allAfter = parsed.searchParams.getAll('after')
      expect(allAfter).toEqual(['77', '10'])
    })

    it('4.2 Verify frontend public APIs never inject duplicate after= parameters across repeated reconnect cycles', async () => {
      const api = useAiApi()
      const stop = api.localSearchEvents('alice', () => {}, 0, { initialBackoffMs: 50, maxBackoffMs: 200 })

      // Initial connect
      createdSources[0].simulateOpen()
      createdSources[0].simulateMessage({ val: 1 }, '10')

      // Reconnect 1
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(50)
      const url1 = createdSources[1].url
      expect(new URL(url1, 'http://localhost').searchParams.getAll('after')).toEqual(['10'])

      // Reconnect 2 with new message
      createdSources[1].simulateOpen()
      createdSources[1].simulateMessage({ val: 2 }, '20')
      createdSources[1].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)
      const url2 = createdSources[2].url
      expect(new URL(url2, 'http://localhost').searchParams.getAll('after')).toEqual(['20'])

      // Reconnect 3 without new message
      createdSources[2].simulateError(true)
      await vi.advanceTimersByTimeAsync(200)
      const url3 = createdSources[3].url
      expect(new URL(url3, 'http://localhost').searchParams.getAll('after')).toEqual(['20'])

      stop()
    })
  })

  // =========================================================================
  // Challenge Group 5: Reconnection Cursor Monotonicity Under Stress
  // =========================================================================
  describe('Challenge Group 5: Reconnection Cursor Monotonicity', () => {
    it('5.1 Out-of-order, null, or empty event IDs do NOT regress cursor', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('alice', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      createdSources[0].simulateOpen()
      // Message with id 100
      createdSources[0].simulateMessage({ step: 1 }, '100')
      // Heartbeat message without event id
      createdSources[0].simulateMessage({ step: 2 }, '')
      // Another message with empty event id
      createdSources[0].simulateMessage({ step: 3 })

      // Disconnect
      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      // Cursor must remain 100
      const parsed1 = new URL(createdSources[1].url, 'http://localhost')
      expect(parsed1.searchParams.get('after')).toBe('100')

      // Reconnect #2: advance to 200
      createdSources[1].simulateOpen()
      createdSources[1].simulateMessage({ step: 4 }, '200')

      createdSources[1].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      const parsed2 = new URL(createdSources[2].url, 'http://localhost')
      expect(parsed2.searchParams.get('after')).toBe('200')

      stop()
    })

    it('5.2 Special characters in cursor are properly URI encoded', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('alice', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      createdSources[0].simulateOpen()
      const complexCursor = 'cursor with spaces & symbols=true?yes'
      createdSources[0].simulateMessage({ step: 1 }, complexCursor)

      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      const url2 = createdSources[1].url
      const parsed = new URL(url2, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe(complexCursor)

      stop()
    })

    it('5.3 Unicode and Chinese characters in cursor are properly encoded and decoded', async () => {
      const api = useAiApi()
      const stop = api.agentEvents('alice', () => {}, () => {}, () => {}, { initialBackoffMs: 100 })

      createdSources[0].simulateOpen()
      const unicodeCursor = '事件游标_2026_09_30'
      createdSources[0].simulateMessage({ step: 1 }, unicodeCursor)

      createdSources[0].simulateError(true)
      await vi.advanceTimersByTimeAsync(100)

      const url2 = createdSources[1].url
      const parsed = new URL(url2, 'http://localhost')
      expect(parsed.searchParams.get('after')).toBe(unicodeCursor)
      expect(url2).toContain(encodeURIComponent(unicodeCursor))

      stop()
    })

    it('5.4 Null or undefined cursor does not append after= query param', () => {
      const buildUrl = createBuildUrlHarness('/api', '/events?account=bob')
      const urlNull = buildUrl(null)
      expect(urlNull).not.toContain('after=')
      const urlUndefined = buildUrl(undefined)
      expect(urlUndefined).not.toContain('after=')
    })
  })
})
