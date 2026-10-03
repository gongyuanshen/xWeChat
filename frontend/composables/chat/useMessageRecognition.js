import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const active = value => ['queued', 'running'].includes(value?.status)
const keyOf = value => `${value.identity}:${value.time}:${value.fingerprint}`
const identityOf = message => message.serverIdStr && message.serverIdStr !== '0' ? `s:${message.serverIdStr}` : String(message.id).split(':').length === 3 ? `l:${message.id}:${message.createTime}` : String(message.id)
const describeError = err => `${err.code ? `${err.code}：` : ''}${err.message}${err.diagnostic_id ? ` · 诊断 ${err.diagnostic_id}` : ''}`

export function useMessageRecognition({ account, contact, messages, engine, modelChoice, api }) {
  const enabled = ref(false), ready = ref(false), loading = ref(false), saving = ref(false), error = ref('')
  const records = ref({}), batch = ref(null), mood = ref(null), pending = ref(0)
  const scopeId = ref('')
  const scope = computed(() => ({ account: account.value, username: contact.value?.username, engine: engine.value,
    selected_model: engine.value === 'api' ? { ...modelChoice.value } : null }))
  const scopeKey = computed(() => JSON.stringify(scope.value))
  const isGroup = computed(() => Boolean(contact.value?.isGroup || contact.value?.username?.endsWith('@chatroom')))
  const validScope = computed(() => Boolean(account.value && contact.value?.username && (engine.value === 'laya' || modelChoice.value.profile_id)))
  const labels = computed(() => enabled.value ? records.value : {})
  const header = computed(() => {
    if (!enabled.value) return null
    const group = isGroup.value
    const currentMood = mood.value?.kind === (group ? 'group' : 'person') ? mood.value : null
    return { title: group ? '群聊氛围（其他成员近20条）' : '对方最新情绪', label: currentMood?.label || '证据不足',
      detail: currentMood ? `已分析 ${currentMood.sample_count} 条 · 有效情绪 ${currentMood.known_count} 条` : '尚无已分析消息' }
  })
  let generation = 0, settingVersion = 0, disposed = false, syncing = false, syncAgain = false, submitting = false, refreshing = false, refreshAgain = false
  let closeEvents, queue = [], refs = [], known = new Set(), hashes = new Map(), retryNext = false
  const current = ticket => !disposed && ticket === generation
  const fail = (err, ticket) => { if (current(ticket)) error.value = describeError(err) }
  const adoptScope = id => {
    if (scopeId.value && scopeId.value !== id) {
      records.value = {}; batch.value = null; mood.value = null; queue = []; known.clear(); error.value = ''; ready.value = false
      syncAgain = true
    }
    scopeId.value = id
  }
  const mergeItems = items => {
    const next = { ...records.value }
    for (const item of items) {
      const reference = refs.find(r => r.identity === item.identity)
      if (reference && keyOf(reference) === keyOf(item)) next[item.identity] = item
    }
    records.value = next
    queue = queue.filter(r => !next[r.identity] || keyOf(next[r.identity]) !== keyOf(r))
    pending.value = queue.length
  }
  const adoptMood = value => { if (value && (!mood.value || value.revision >= mood.value.revision)) mood.value = value }
  const adoptBatch = (value, force = false) => {
    if (!value || value.scope_id !== scopeId.value) return
    mergeItems(value.items)
    adoptMood(value.mood)
    if (!force && batch.value && batch.value.id !== value.id) return
    if (batch.value?.id === value.id && !active(batch.value) && active(value)) return
    batch.value = batch.value?.id === value.id
      ? { ...value, progress: { ...value.progress, analyzed: Math.max(batch.value.progress.analyzed, value.progress.analyzed) } }
      : value
    if (value.status === 'failed') error.value = describeError(value.error)
  }
  const refresh = async () => {
    if (refreshing) { refreshAgain = true; return }
    const selectedBatch = batch.value, ticket = generation
    if (!selectedBatch || !enabled.value) return
    refreshing = true
    try {
      const value = await api.request(`/insights/live/batches/${encodeURIComponent(selectedBatch.id)}`, { query: { account: account.value }, retry: 0 })
      if (!current(ticket) || batch.value?.id !== selectedBatch.id) return
      adoptBatch(value)
    } catch (err) { fail(err, ticket) }
    finally {
      if (current(ticket)) {
        refreshing = false
        if (refreshAgain) { refreshAgain = false; void refresh() }
        else void dispatch()
      }
    }
  }
  const connect = () => {
    closeEvents?.(); closeEvents = undefined
    if (!enabled.value || !scopeId.value) return
    const ticket = generation
    closeEvents = api.events(account.value, event => {
      if (!current(ticket) || !enabled.value || event.kind !== 'insight_live' || event.body.scope_id !== scopeId.value) return
      const body = event.body
      if (body.label) mergeItems([body.label])
      if (body.mood) adoptMood(body.mood)
      if (body.batch_id === batch.value?.id) {
        // 逐条先呈现；终态由 GET 取齐已持久化结果，再派下一批。
        if (body.progress) batch.value = { ...batch.value, progress: { ...body.progress, analyzed: Math.max(batch.value.progress.analyzed, body.progress.analyzed) } }
        if (body.status === 'failed' && body.error) error.value = describeError(body.error)
        if (!['queued', 'running'].includes(body.status)) void refresh()
      }
    })
  }
  const dispatch = async () => {
    if (!enabled.value || !ready.value || saving.value || syncing || submitting || refreshing || active(batch.value) || error.value || !queue.length) return
    const ticket = generation, operation = settingVersion, selectedScope = { ...scope.value }
    // 历史页追加队尾时保留 FIFO；遇时间回退拆批，避免把未来消息作为旧消息的前文。
    let count = Math.min(20, queue.length)
    for (let i = 1; i < count; i++) if (queue[i].time < queue[i - 1].time) { count = i; break }
    const items = queue.slice(0, count)
    const first = refs.findIndex(r => keyOf(r) === keyOf(items[0]))
    const context = refs.slice(Math.max(0, first - 3), first)
    submitting = true
    try {
      const value = await api.request('/insights/live/batches', { method: 'POST', retry: 0, body: { ...selectedScope, messages: items, context, retry: retryNext } })
      if (!current(ticket) || operation !== settingVersion) return
      retryNext = false; adoptBatch(value, true)
    } catch (err) { fail(err, ticket) }
    finally { if (current(ticket)) { submitting = false; if (!active(batch.value) && !error.value) void dispatch() } }
  }
  const sync = async (force = false) => {
    if (syncing) { syncAgain = true; return }
    if (!validScope.value) return
    const ticket = generation, operation = settingVersion, selectedScope = { ...scope.value }
    syncing = true; loading.value = true
    try {
      await nextTick()
      if (!current(ticket)) return
      const raw = messages.value.filter(m => !m.isSent && ['text', 'quote'].includes(m.renderType) && typeof m.content === 'string' && m.content.trim().length > 0 && !(m.renderType === 'quote' && m.content === '[引用消息]'))
      const material = await Promise.all(raw.map(async m => {
        const identity = identityOf(m), cache = hashes.get(identity)
        const fingerprint = cache?.text === m.content ? cache.fingerprint : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.content))), n => n.toString(16).padStart(2, '0')).join('')
        if (current(ticket)) hashes.set(identity, { text: m.content, fingerprint })
        return { identity, time: m.createTime, fingerprint }
      }))
      if (!current(ticket)) return
      refs = material
      const valid = new Set(refs.map(keyOf))
      known = new Set([...known].filter(key => valid.has(key)))
      queue = queue.filter(r => valid.has(keyOf(r)))
      records.value = Object.fromEntries(Object.entries(records.value).filter(([, r]) => valid.has(keyOf(r))))
      const missing = force ? refs : refs.filter(r => !known.has(keyOf(r)))
      for (let offset = 0; offset < missing.length || (!ready.value && offset === 0); offset += 200) {
        const chunk = missing.slice(offset, offset + 200)
        const beforeRequest = records.value
        const value = await api.request('/insights/live/state', { method: 'POST', retry: 0, body: { ...selectedScope, messages: chunk } })
        if (!current(ticket)) return
        adoptScope(value.scope_id)
        if (operation === settingVersion) enabled.value = value.enabled
        chunk.forEach(r => known.add(keyOf(r)))
        const requested = new Set(chunk.map(r => r.identity))
        // 该状态快照发出之后收到的逐条结果不能被较早的空快照抹除。
        records.value = Object.fromEntries(Object.entries(records.value).filter(([id, item]) => !requested.has(id) || item !== beforeRequest[id]))
        mergeItems(value.items); adoptMood(value.mood); adoptBatch(value.batch)
        ready.value = true
      }
      const queued = new Set(queue.map(keyOf))
      for (const r of refs) if ((!records.value[r.identity] || keyOf(records.value[r.identity]) !== keyOf(r)) && !queued.has(keyOf(r))) { queue.push(r); queued.add(keyOf(r)) }
      pending.value = queue.length
      connect()
    } catch (err) { fail(err, ticket) }
    finally {
      if (current(ticket)) {
        syncing = false; loading.value = false
        if (syncAgain) { syncAgain = false; void sync() }
        else void dispatch()
      }
    }
  }
  const setEnabled = async value => {
    if (saving.value) return
    if (!validScope.value) { error.value = '请先在画像面板选择可用模型'; return }
    const ticket = generation, operation = ++settingVersion
    saving.value = true
    if (!value) { enabled.value = false; connect() }
    try {
      const result = await api.request('/insights/live/settings', { method: 'POST', retry: 0, body: { ...scope.value, enabled: value } })
      if (!current(ticket) || operation !== settingVersion) return
      adoptScope(result.scope_id); enabled.value = result.enabled; ready.value = true
      adoptBatch(result.batch); adoptMood(result.mood); connect()
    } catch (err) { fail(err, ticket) }
    finally { if (current(ticket)) { saving.value = false; void sync(true) } }
  }
  const retry = async () => {
    if (saving.value || submitting) return
    error.value = ''; retryNext = true
    // 先读持久化状态：上次 POST 回包丢失时，不能直接创建重复模型调用。
    batch.value = null
    await sync(true)
    if (batch.value?.status === 'failed') { error.value = ''; void dispatch() }
  }
  watch(scopeKey, () => {
    generation++; settingVersion++; closeEvents?.(); closeEvents = undefined
    enabled.value = false; ready.value = false; loading.value = false; saving.value = false; error.value = ''; records.value = {}; batch.value = null; mood.value = null; scopeId.value = ''; pending.value = 0
    queue = []; refs = []; known = new Set(); hashes = new Map(); retryNext = false; syncing = false; syncAgain = false; submitting = false; refreshing = false; refreshAgain = false
    void sync()
  }, { immediate: true, flush: 'sync' })
  watch(() => messages.value.map(m => [m.id, m.serverIdStr, m.createTime, m.renderType, m.content, m.isSent]), () => { void sync() }, { deep: true })
  let timer
  onMounted(() => { timer = setInterval(() => { if (enabled.value && active(batch.value) && !error.value) void refresh() }, 3000) })
  onUnmounted(() => { disposed = true; generation++; closeEvents?.(); clearInterval(timer) })
  return { enabled, ready, loading, saving, error, labels, batch, mood, header, pending, validScope, setEnabled, retry, refresh }
}
