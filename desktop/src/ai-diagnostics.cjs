const http = require('node:http');
const events = new Set('request.failed sse.open sse.disconnected sse.recovered sse.invalid response.stale source.ready source.failed navigation.started navigation.finished navigation.failed notification.requested notification.shown notification.failed notification.clicked notification.ack notification.ack_failed notification.duplicate notification.unsupported transport.dropped transport.offline'.split(' '));
const ids = new Set('trace_id operation_id diagnostic_id task_id run_id thread_id'.split(' '));
const counts = new Set('http_status duration_ms count dropped_count queued event_id version after attempt'.split(' '));
const labels = { origin: ['frontend','desktop'], phase: ['request','stream','source','navigation','notification','transport'], status: ['success','failed','pending','closed','missing','stale','ready'], reason_code: ['network','http','parse','timeout','unsupported','overflow','offline','missing','stale','rejected'], method: ['GET','POST','PUT','DELETE','PATCH'], component: ['ai','agent','search','notification','source'] };
function safeEvent(value) {
  if (!value || !events.has(value.event) || !value.metadata || typeof value.metadata !== 'object') return null;
  const metadata = {};
  for (const [key, item] of Object.entries(value.metadata)) {
    if (key === 'source_id' && typeof item === 'string' && /^[a-f0-9]{24,32}$/i.test(item)) metadata[key] = item;
    else if (ids.has(key) && typeof item === 'string' && /^[a-f0-9-]{32,36}$/i.test(item)) metadata[key] = item;
    else if (counts.has(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1e12) metadata[key] = item;
    else if (labels[key]?.includes(item)) metadata[key] = item;
  }
  return { event: value.event, metadata };
}
function writeFallback(entries, log) {
  if (!Array.isArray(entries) || entries.length > 50) return false;
  for (const item of entries) { const safe = safeEvent(item); if (safe) log(`[ai.diagnostic.undelivered] ${JSON.stringify(safe)}`); }
  return true;
}
function createAiDiagnostics({ getPort, log, send }) {
  let queue = [], timer = null, busy = false, stopped = false, dropped = 0, inFlight = 0;
  const transmit = send || (entries => new Promise((resolve, reject) => {
    const body = JSON.stringify({ events: entries });
    const req = http.request({ hostname: '127.0.0.1', port: getPort(), path: '/api/ai/diagnostics/events', method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('http'));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end(body);
  }));
  const later = (delay = 1000) => { if (!stopped && !timer && (queue.length || dropped)) { timer = setTimeout(() => { timer = null; void flush(); }, delay); timer.unref?.(); } };
  const fallback = entries => { try { writeFallback(entries, log); } catch {} };
  async function flush() {
    if (busy || stopped) return;
    busy = true;
    if (dropped) {
      if (queue.length >= 500) { queue.shift(); dropped++; }
      queue.unshift({ value: safeEvent({ event: 'transport.dropped', metadata: { origin: 'desktop', dropped_count: dropped } }), attempt: 0 }); dropped = 0;
    }
    const batch = queue.splice(0,50);
    inFlight = batch.length;
    let delay = 1000;
    try { if (batch.length) await transmit(batch.map(item => item.value)); }
    catch {
      fallback(batch.filter(item => !item.attempt).map(item => item.value));
      const retained = batch.filter(item => ++item.attempt < 4);
      if (!stopped) queue = [...retained,...queue];
      if (queue.length > 500) { dropped += queue.length - 500; queue = queue.slice(-500); }
      delay = Math.min(8000,1000 * 2 ** (batch[0]?.attempt || 1));
    } finally { busy = false; inFlight = 0; later(delay); }
  }
  return {
    record(event, metadata = {}) { if (stopped) return; const value = safeEvent({ event, metadata: { origin: 'desktop', ...metadata } }); if (!value) return;
      if (queue.length >= 500-inFlight) { queue.shift(); dropped++; } queue.push({ value, attempt: 0 }); later(); },
    flush, size: () => queue.length+inFlight,
    stop() { stopped = true; clearTimeout(timer); while (queue.length) fallback(queue.splice(0,50).map(item => item.value));
      if (dropped) fallback([safeEvent({ event:'transport.dropped', metadata:{ origin:'desktop', dropped_count:dropped } })]); },
  };
}
module.exports = { createAiDiagnostics, writeFallback, safeEvent };
