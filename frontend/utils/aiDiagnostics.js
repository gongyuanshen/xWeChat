const events = new Set('request.failed sse.open sse.disconnected sse.recovered sse.invalid response.stale source.ready source.failed navigation.started navigation.finished navigation.failed notification.requested notification.shown notification.failed notification.clicked notification.ack notification.ack_failed notification.duplicate notification.unsupported transport.dropped transport.offline'.split(' '))
const ids = new Set('trace_id operation_id diagnostic_id task_id run_id thread_id'.split(' '))
const counts = new Set('http_status duration_ms count dropped_count queued event_id version after attempt'.split(' '))
const labels = {
  origin: ['frontend', 'desktop'], phase: ['request', 'stream', 'source', 'navigation', 'notification', 'transport'],
  status: ['success', 'failed', 'pending', 'closed', 'missing', 'stale', 'ready'],
  reason_code: ['network', 'http', 'parse', 'timeout', 'unsupported', 'overflow', 'offline', 'missing', 'stale', 'rejected'],
  method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], component: ['ai', 'agent', 'search', 'notification', 'source'],
}

export function safeDiagnostic(event, metadata = {}) {
  if (!events.has(event)) return null
  const safe = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'source_id' && typeof value === 'string' && /^[a-f0-9]{24,32}$/i.test(value)) safe[key] = value
    else if (ids.has(key) && typeof value === 'string' && /^[a-f0-9-]{32,36}$/i.test(value)) safe[key] = value
    else if (counts.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12) safe[key] = value
    else if (labels[key]?.includes(value)) safe[key] = value
  }
  return { event, metadata: safe }
}

export const aiTrace = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '') || 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))

export function createDiagnosticQueue({ send, fallback = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let queue = [], timer = null, busy = false, dropped = 0, stopped = false, inFlight = 0
  const later = (delay = 1000) => {
    if (!stopped && !timer && (queue.length || dropped)) {
      timer = schedule(() => { timer = null; void flush() }, delay)
      timer?.unref?.()
    }
  }
  const backup = entries => {
    for (let index = 0; index < entries.length; index += 50) {
      try { Promise.resolve(fallback(entries.slice(index, index + 50))).catch(() => {}) } catch {}
    }
  }
  const flush = async () => {
    if (busy || stopped) return
    busy = true
    if (dropped) {
      // 溢出计数占用一个位置，队列永不超过 500 条。
      if (queue.length >= 500) { queue.shift(); dropped++ }
      queue.unshift({ value: safeDiagnostic('transport.dropped', { origin: 'frontend', dropped_count: dropped }), attempt: 0 })
      dropped = 0
    }
    const batch = []
    let bytes = 14
    while (queue.length && batch.length < 50) {
      const item = queue[0]
      const size = new TextEncoder().encode(JSON.stringify(item.value)).length + 1
      if (bytes + size > 65536) break
      bytes += size; batch.push(queue.shift())
    }
    inFlight = batch.length
    let delay = 1000
    try {
      if (batch.length) await send(batch.map(item => item.value))
    } catch {
      const first = batch.filter(item => item.attempt === 0)
      if (first.length) backup(first.map(item => item.value))
      const retained = batch.filter(item => ++item.attempt < 4)
      const expired = batch.length - retained.length
      if (expired) backup([safeDiagnostic('transport.dropped', { origin: 'frontend', dropped_count: expired, reason_code: 'offline' })])
      if (!stopped) queue = [...retained, ...queue]
      if (queue.length > 500) { dropped += queue.length - 500; queue = queue.slice(-500) }
      delay = Math.min(8000, 1000 * 2 ** (batch[0]?.attempt || 1))
    } finally {
      busy = false; inFlight = 0; later(delay)
    }
  }
  return {
    record(event, metadata) {
      if (stopped) return
      const value = safeDiagnostic(event, metadata)
      if (!value) return
      if (queue.length >= 500 - inFlight) { queue.shift(); dropped++ }
      queue.push({ value, attempt: 0 }); later()
    },
    flush,
    stop() { stopped = true; cancel(timer); timer = null; if (queue.length) backup(queue.map(item => item.value));
      if (dropped) backup([safeDiagnostic('transport.dropped', { origin: 'frontend', dropped_count: dropped })]); queue = [] },
    size: () => queue.length + inFlight,
  }
}

const reporters = new Map()
export function aiDiagnostics(base) {
  if (typeof window === 'undefined') return { record() {} }
  if (!reporters.has(base)) {
    const queue = createDiagnosticQueue({
      send: async events => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
          // 使用原生 fetch，诊断入口不会触发 useAiApi 的再次上报。
          const response = await fetch(`${base}/ai/diagnostics/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }), signal: controller.signal })
          if (!response.ok) throw new Error('diagnostics unavailable')
        } finally { clearTimeout(timeout) }
      },
      fallback: events => window.wechatDesktop?.aiDiagnosticFallback?.(events),
    })
    reporters.set(base, queue)
    window.addEventListener('pagehide', () => { queue.stop(); reporters.delete(base) }, { once: true })
  }
  return reporters.get(base)
}
