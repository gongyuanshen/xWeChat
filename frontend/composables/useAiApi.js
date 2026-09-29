import { aiDiagnostics, aiTrace } from '../utils/aiDiagnostics'

export const useAiApi = () => {
  const base = useApiBase()
  const diagnostics = aiDiagnostics(base)
  const request = async (path, options = {}) => {
    const trace = aiTrace(), started = Date.now()
    try {
      return await $fetch(`${base}/ai${path}`, { ...options, headers: { ...options.headers, 'X-WCDA-AI-Trace': trace } })
    } catch (error) {
      const detail = error?.data?.detail
      const result = new Error(typeof detail === 'string' ? detail : 'AI 服务请求失败')
      result.status = error?.status || error?.statusCode || error?.response?.status
      result.statusCode = result.status
      result.diagnostic_id = error?.data?.diagnostic_id || error?.response?.headers?.get?.('X-WCDA-AI-Diagnostic')
      result.trace_id = trace
      diagnostics.record('request.failed', { origin: 'frontend', trace_id: trace, diagnostic_id: result.diagnostic_id,
        http_status: result.status, duration_ms: Date.now() - started, method: options.method || 'GET',
        component: path.startsWith('/agent') ? 'agent' : path.startsWith('/local-search') ? 'search' : 'ai', reason_code: result.status ? 'http' : 'network' })
      throw result
    }
  }
  const stream = (path, component, onEvent, onReady, onDisconnected) => {
    const trace = aiTrace()
    // 原生 EventSource 不支持自定义请求头；只携带校验过的随机关联编号。
    const source = new EventSource(`${base}/ai${path}&ai_trace=${trace}`)
    const metadata = { origin: 'frontend', component, trace_id: trace }
    let disconnected = false, closed = false
    source.onopen = () => {
      if (closed) return
      const reconnected = disconnected
      diagnostics.record(reconnected ? 'sse.recovered' : 'sse.open', metadata); disconnected = false
      onReady?.({ reconnected })
    }
    source.onerror = () => {
      if (closed || disconnected) return
      diagnostics.record('sse.disconnected', metadata)
      disconnected = true
      onDisconnected?.()
    }
    source.onmessage = event => {
      if (closed) return
      let value
      try { value = JSON.parse(event.data) } catch { diagnostics.record('sse.invalid', { ...metadata, reason_code: 'parse' }); return }
      try { onEvent(value, { eventId: event.lastEventId || '' }) } catch { diagnostics.record('sse.invalid', { ...metadata, reason_code: 'rejected' }) }
    }
    return () => { closed = true; source.close() }
  }
  const events = (account, onEvent) => stream(`/events?account=${encodeURIComponent(account)}`, 'ai', onEvent)
  const agentEvents = (account, onEvent, onReady, onDisconnected) => stream(`/agent/events?account=${encodeURIComponent(account)}`, 'agent', onEvent, onReady, onDisconnected)
  const localSearchEvents = (account, onEvent, after = 0) => stream(`/local-search/events?after=${encodeURIComponent(after)}${account ? `&account=${encodeURIComponent(account)}` : ''}`, 'search', onEvent)
  return { request, events, agentEvents, localSearchEvents, diagnostic: (event, metadata = {}) => diagnostics.record(event, { origin: 'frontend', ...metadata }) }
}
