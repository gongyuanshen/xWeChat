<script setup>
import { computed, onUnmounted, ref, watchEffect } from 'vue'
import ConversationPane from '../../components/chat/ConversationPane.vue'
import { useMessageRecognition } from '../../composables/chat/useMessageRecognition'

const account = ref('synthetic-live'), contact = ref({ username: 'friend', name: '合成伙伴 · 小林', isGroup: false })
const engine = ref('api'), modelChoice = ref({ profile_id: 'synthetic', model_id: 'model-a', reasoning_effort: null })
const dark = ref(false), requests = ref([]), events = ref([])
let serial = 0, revision = 0, subscriber = 0
const scopes = new Map(), batches = new Map(), listeners = new Map()
const copy = value => JSON.parse(JSON.stringify(value))
const message = (id, text, sent = false) => ({ id: `synthetic:messages:${id}`, serverIdStr: String(id), createTime: id,
  fullTime: `人工样例 ${id}`, renderType: 'text', content: text, sender: sent ? '我' : '林', isSent: sent })
const conversations = new Map([
  ['friend', [message(101, '明天下午一起去公园散步吧。'), message(102, '好呀，最近正想出去走走！', true), message(103, '我会带两瓶水，期待明天见面。')]],
  ['group@chatroom', [message(201, '社区活动的海报我来准备。'), message(202, '收到，饮水由我负责。', true), message(203, '大家一起完成，感觉很开心。')]],
])
const messages = ref(conversations.get('friend'))
const scopeFor = body => {
  const key = JSON.stringify([body.account, body.username, body.engine, body.selected_model])
  if (!scopes.has(key)) scopes.set(key, { id: `scope-${scopes.size + 1}`, enabled: false, username: body.username, cache: new Map(), batch: null })
  return scopes.get(key)
}
const options = () => ({ account: account.value, username: contact.value.username, engine: engine.value,
  selected_model: engine.value === 'api' ? { ...modelChoice.value } : null })
const moodFor = scope => {
  const group = scope.username.endsWith('@chatroom')
  const items = [...scope.cache.values()].filter(item => group || item.sender_id === scope.username)
    .sort((a, b) => b.time - a.time).slice(0, group ? 20 : 1)
  if (!items.length) return null
  const known = items.filter(item => !item.invalidated && item.emotion !== null)
  return { kind: group ? 'group' : 'person', label: known.length * 2 >= items.length ? (group ? '积极' : '期待') : null,
    sample_count: items.length, known_count: known.length, time: items[0].time, revision }
}
const cached = (scope, reference) => {
  const item = scope.cache.get(reference.identity)
  return item && !item.invalidated && item.time === reference.time && item.fingerprint === reference.fingerprint ? item : null
}
const batchView = batch => ({ ...batch, items: batch.messages.map(r => cached(scopes.get(batch.scope_key), r)).filter(Boolean),
  mood: moodFor(scopes.get(batch.scope_key)) })
const stateView = (scope, refs = []) => ({ scope_id: scope.id, enabled: scope.enabled,
  items: refs.map(r => cached(scope, r)).filter(Boolean), batch: scope.batch ? batchView(scope.batch) : null, mood: moodFor(scope) })
const publish = (batch, extra = {}) => {
  const event = { kind: 'insight_live', body: { scope_id: batch.scope_id, batch_id: batch.id,
    status: batch.status, progress: copy(batch.progress), error: batch.error, ...extra } }
  events.value.push(copy(event))
  for (const callback of listeners.values()) callback(copy(event))
}
const api = {
  events: (_, callback) => { const id = ++subscriber; listeners.set(id, callback); return () => listeners.delete(id) },
  request: async (path, request = {}) => {
    requests.value.push({ path, method: request.method || 'GET', body: copy(request.body || null) })
    if (path.endsWith('/state')) {
      const scope = scopeFor(request.body)
      for (const reference of request.body.messages) {
        const old = scope.cache.get(reference.identity)
        if (old && (old.fingerprint !== reference.fingerprint || old.time !== reference.time)) { old.invalidated = true; revision++ }
      }
      return copy(stateView(scope, request.body.messages))
    }
    if (path.endsWith('/settings')) {
      const scope = scopeFor(request.body); scope.enabled = request.body.enabled
      if (!scope.enabled && scope.batch && ['running', 'queued'].includes(scope.batch.status)) {
        scope.batch.status = 'cancelled'; publish(scope.batch)
      }
      return copy(stateView(scope))
    }
    if (path.endsWith('/batches') && request.method === 'POST') {
      const body = request.body, scope = scopeFor(body)
      if (!scope.enabled) throw new Error('当前合成会话未开启')
      if (scope.batch && ['running', 'queued'].includes(scope.batch.status)) throw new Error('已有批次运行，必须串行')
      if (scope.batch?.status === 'failed' && !body.retry) throw new Error('失败后需要显式重试')
      if (body.context.length > 3 || (body.context.length && Math.max(...body.context.map(r => r.time)) > Math.min(...body.messages.map(r => r.time)))) throw new Error('上下文晚于当前批次')
      const refs = body.messages.filter(r => !cached(scope, r))
      const batch = { id: `batch-${++serial}`, scope_id: scope.id, scope_key: [...scopes].find(([, value]) => value === scope)[0],
        status: refs.length ? 'running' : 'completed', messages: refs, context: body.context, error: null,
        progress: { total: refs.length, analyzed: 0 }, delivery_mode: engine.value === 'api' ? 'stream' : 'local' }
      scope.batch = batch; batches.set(batch.id, batch)
      return copy(batchView(batch))
    }
    const id = path.split('/')[4], batch = batches.get(id)
    if (!batch) throw new Error(`未声明的合成请求 ${path}`)
    if (path.endsWith('/cancel')) { batch.status = 'cancelled'; publish(batch) }
    return copy(batchView(batch))
  },
}
const recognition = useMessageRecognition({ account, contact, messages, engine, modelChoice, api })
const activeBatch = () => scopeFor(options()).batch
const oneLabel = () => {
  const batch = activeBatch()
  if (!batch || batch.status !== 'running') throw new Error('没有运行中的合成批次')
  const scope = scopes.get(batch.scope_key), reference = batch.messages.find(r => !cached(scope, r))
  if (!reference) return
  const original = conversations.get(scope.username).find(m => `s:${m.serverIdStr}` === reference.identity)
  const source = `${scope.username}:${reference.identity}`
  const record = { ...reference, source, sources: [source], text: original.content, emotion: scope.username.endsWith('@chatroom') ? '积极' : '期待',
    intent: '日常交流', reason: '人工样例表达了对共同安排的期待，仅用于界面验证。', sender_id: original.isSent ? 'synthetic-self' : scope.username }
  scope.cache.set(reference.identity, record); batch.progress.analyzed++; revision++
  publish(batch, { label: record, mood: moodFor(scope) })
}
const finish = () => {
  const batch = activeBatch()
  if (!batch || batch.status !== 'running') throw new Error('没有运行中的合成批次')
  while (batch.progress.analyzed < batch.progress.total) oneLabel()
  batch.status = 'completed'; publish(batch)
}
const fail = () => { const batch = activeBatch(); batch.status = 'failed'; batch.error = { code: 'INSIGHT_MODEL_FAILED', message: '合成接口主动返回429', diagnostic_id: 'synthetic-429' }; publish(batch) }
const addMessage = historical => {
  const current = conversations.get(contact.value.username), id = historical ? Math.min(...current.map(m => m.createTime)) - 1 : Math.max(...current.map(m => m.createTime)) + 1
  const item = message(id, historical ? '这是新加载的更早历史，不能盖过最新情绪。' : '新消息到了，稍后一起确认时间。')
  const next = historical ? [item, ...current] : [...current, item]
  conversations.set(contact.value.username, next); messages.value = next
}
const toggleGroup = () => {
  contact.value = contact.value.isGroup ? { username: 'friend', name: '合成伙伴 · 小林', isGroup: false }
    : { username: 'group@chatroom', name: '合成样本 · 社区活动群', isGroup: true }
  messages.value = conversations.get(contact.value.username)
}
const switchModel = () => { modelChoice.value = { ...modelChoice.value, model_id: modelChoice.value.model_id === 'model-a' ? 'model-b' : 'model-a' } }
const noop = () => {}
const state = {
  selectedAccount: account, selectedContact: contact, messages, renderMessages: computed(() => messages.value.map(message => ({ message, showTimeDivider: false, timeDivider: '' }))),
  recognitionState: recognition, recognitionEngine: engine, recognitionHeader: recognition.header, insightLabels: recognition.labels,
  searchContext: ref({ active: false }), messageTypeFilter: ref('all'), messageTypeFilterOptions: [{ value: 'all', label: '全部消息' }],
  privacyMode: false, isLoadingMessages: false, hasMoreMessages: false, messagesError: '', isJumpingToFirst: false, isExportCreating: false,
  groupAnnouncement: '', groupAnnouncementOpen: false, groupMembersSidebarOpen: false, insightsPanelOpen: false, aiSidebarOpen: false,
  voiceSidebarOpen: false, resourceSidebarOpen: false, messageSearchOpen: false, timeSidebarOpen: false, showJumpToBottom: false,
  contactProfileCardOpen: false, contactProfileCardMessageId: '', highlightServerIdStr: '', highlightMessageId: '',
  toggleAiSidebar: noop, toggleInsightsPanel: noop, jumpToConversationFirst: noop, refreshSelectedMessages: noop,
  openExportModal: noop, toggleVoiceSidebar: noop, toggleResourceSidebar: noop, toggleMessageSearch: noop, toggleTimeSidebar: noop,
  toggleGroupMembersSidebar: noop, openGroupAnnouncement: noop, closeGroupAnnouncement: noop, onMessageScroll: noop,
  onMessageAvatarMouseEnter: noop, onMessageAvatarMouseLeave: noop, openMediaContextMenu: noop, isMentionContactProfileCardForMessage: () => false,
  api: { getAiSuggestedReply: () => { throw new Error('验收禁止真实发送/AI建议') } },
}
watchEffect(() => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'; document.documentElement.classList.toggle('dark', dark.value) })
window.liveAcceptance = {
  snapshot: () => ({ enabled: recognition.enabled.value, ready: recognition.ready.value, error: recognition.error.value,
    batch: copy(recognition.batch.value), labels: copy(recognition.labels.value), header: copy(recognition.header.value), pending: recognition.pending.value,
    scope: options(), requests: copy(requests.value), events: copy(events.value) }),
  oneLabel, finish, fail, addMessage, toggleGroup, switchModel,
}
onUnmounted(() => { delete window.liveAcceptance })
</script>
<template>
  <div class="acceptance-shell">
    <nav class="acceptance-toolbar" aria-label="合成验收控制">
      <strong>自动识别 · 人工样例</strong>
      <button data-test="partial" @click="oneLabel">发出一条标签</button><button data-test="finish" @click="finish">完成本批</button>
      <button data-test="new" @click="addMessage(false)">添加新消息</button><button data-test="history" @click="addMessage(true)">加载历史</button>
      <button data-test="fail" @click="fail">模拟失败</button><button data-test="group" @click="toggleGroup">切换单聊/群聊</button>
      <button data-test="model" @click="switchModel">切换模型</button><button data-test="theme" @click="dark = !dark">{{ dark ? '浅色模式' : '深色模式' }}</button>
      <output>真实模型调用 0 · 合成请求 {{ requests.filter(r => r.path.endsWith('/batches')).length }} · {{ modelChoice.model_id }}</output>
    </nav>
    <ConversationPane :state="state" />
  </div>
</template>
<style>
:root { --app-surface-bg:#fff; --app-surface-soft:#f4f7f5; --app-border:#dfe7e2; --app-text-primary:#263b2d; --app-text-secondary:#75877c; --chat-page-bg:#f4f7f5; }
html[data-theme=dark] { --app-surface-bg:#222629; --app-surface-soft:#2b3033; --app-border:#414b45; --app-text-primary:#e0e7e2; --app-text-secondary:#a5b1a9; --chat-page-bg:#202523; }
body { margin:0; font-family:system-ui,sans-serif; color:var(--app-text-primary); background:var(--app-surface-soft); }
* { box-sizing:border-box; }
.acceptance-shell { display:flex; flex-direction:column; height:100vh; min-width:0; }
.acceptance-toolbar { flex-shrink:0; display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:10px 14px; font-size:11px; background:var(--app-surface-bg); border-bottom:1px solid var(--app-border); }
.acceptance-toolbar button { padding:4px 7px; border:1px solid var(--app-border); border-radius:5px; background:var(--app-surface-soft); color:inherit; cursor:pointer; }
.acceptance-toolbar output { overflow-wrap:anywhere; }
</style>
