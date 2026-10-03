<script setup>
import { computed, nextTick, onMounted, reactive, ref, watchEffect } from 'vue'
import ChatInsightsPanel from '../../components/chat/ChatInsightsPanel.vue'
import MessageItem from '../../components/chat/MessageItem.vue'
import { useChatInsights } from '../../composables/chat/useChatInsights'

// 全部为界面验收的合成数据；request 仅访问下方内存集合，不连接后端或模型。
const privateContact = { username: 'friend', name: '合成样本 · 小林' }
const groupContact = { username: 'group@chatroom', name: '合成样本 · 周五项目群', isGroup: true }
const dark = ref(false), open = ref(true), account = ref('synthetic'), contact = ref(privateContact)
const located = ref(''), postCount = ref(0), memberReads = ref(0), settingsReads = ref(0), changed = ref(false), longLabels = ref(false)
const choice = { profile_id: 'synthetic', model_id: 'synthetic', reasoning_effort: null }
const profiles = [{ id: 'synthetic', name: '隔离测试配置', model: 'synthetic', model_metadata: { name: '合成测试模型' } }]
const text = '明天我带早餐过来，你想吃什么？', replyText = '好呀，来一份豆浆和包子，谢谢你！'
const fingerprint = ref(''), replyFingerprint = ref('')
onMounted(async () => {
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('')
  ;[fingerprint.value, replyFingerprint.value] = await Promise.all([hash(text), hash(replyText)])
})
const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400
const evidence = value => ({ text: value, sources: ['a'] })
const score = value => ({ score: value, reason: '合成界面样例：这些分数只用于核对展示和原文入口，不是对真实人物的判断。', sources: ['a'] })
function savedTask(id, target, member = '', older = false) {
  const group = Boolean(target.isGroup), wholeGroup = group && !member
  const subject = wholeGroup ? '群整体' : member ? `成员 ${member}` : '小林'
  return {
    id, account: 'synthetic', username: target.username, member_username: member, engine: 'laya', start, end,
    analysis_scope: member ? 'member' : 'conversation', read_scope: member ? 'member' : 'conversation',
    selected_model: null, model: { provider: 'local', model: 'laya-multilingual', device: 'cpu', revision: 'synthetic-revision' },
    status: 'completed', stage: '本地统计画像完成', created: end - (older ? 3600 : 60), data_source: 'snapshot', context_budget: null,
    progress: { read: member ? 135 : 240, analyzed: member ? 120 : 200, batches: member ? 120 : 200 }, coverage: { total: member ? 135 : 240, text: member ? 120 : 200, skipped: member ? 15 : 40, target_text: wholeGroup ? 200 : 120, participants: member ? 1 : group ? 6 : 2 },
    portrait: {
      summary: evidence(wholeGroup ? '合成群整体摘要：围绕周五活动分工交流，成员会补充具体安排，也会互相确认进展。不同成员的意见仍有差异。' : `合成${subject}摘要：表达直接，习惯用具体行动关心对方，讨论安排时会主动确认细节。结论仅依据所选时段的合成聊天。`),
      topics: ['日常安排与相处', '周五活动和分工', '饮食与生活分享', '近期工作进展'].map(evidence),
      communication: ['主动提出帮助，问题简短明确。', '通过确认时间和具体行动推动讨论。', '回应对方时会表达感谢。'].map(evidence),
      mood: evidence(wholeGroup ? '合成群氛围：讨论总体平和，夹杂轻松的玩笑。' : '合成情绪观察：轻松，表达了对后续安排的期待。'),
      traits: { energy: score(70), humor: score(55), calm: score(60), initiative: score(80), care: score(85), closeness: score(65) },
      affinity: group ? null : score(65),
      mbti: wholeGroup ? null : { EI: score(60), SN: score(40), TF: score(35), JP: score(65) },
      uncertain: ['此页全部为隔离界面验收的合成材料。', '文本推测只能描述聊天表现，不能替代人格测量。'],
    },
    references: [{ source: 'a', username: target.username, anchor: 'synthetic:message:1', time: start + 10, text, sender_id: member || (group ? 'a' : 'friend') }], error: null,
  }
}
const history = ref([savedTask('saved-private', privateContact), savedTask('saved-private-older', privateContact, '', true), savedTask('saved-group', groupContact), savedTask('saved-member-a', groupContact, 'a'), savedTask('saved-member-b', groupContact, 'b')])
let event
let modelStatus = { id: 'laya', name: 'Laya', revision: 'synthetic-revision', license: 'Apache-2.0', total_bytes: 681000000, downloaded_bytes: 681000000, state: 'ready', path: 'synthetic-local-model', device: 'cpu', context_window: 1024, error: null }
const api = { events: (_, callback) => { event = callback; return () => { event = null } }, request: async (path, options) => {
  if (path === '/settings') { settingsReads.value++; return { profiles, selected_model: choice } }
  if (path === '/selected-model') return options.body
  if (path === '/insights/local-model/download') { modelStatus = { ...modelStatus, state: 'downloading', error: null }; return modelStatus }
  if (path === '/insights/local-model/pause') { modelStatus = { ...modelStatus, state: 'paused' }; return modelStatus }
  if (path === '/insights/local-model/import') { modelStatus = { ...modelStatus, state: 'ready', downloaded_bytes: 681000000, path: options.body.path, error: null }; return modelStatus }
  if (path === '/insights/local-model') return modelStatus
  if (path === '/insights/members') { memberReads.value++; return [{ username: 'a', displayName: '同名成员' }, { username: 'b', displayName: '同名成员' }] }
  if (path === '/insights/tasks' && options?.method === 'POST') {
    postCount.value++
    const task = { ...savedTask(`new-${postCount.value}`, contact.value, options.body.member_username), ...options.body, created: Date.now() / 1000, status: 'running', portrait: null, stage: '分析合成批次', progress: { read: 240, analyzed: 0, batches: 0 } }
    if (options.body.engine === 'api') {
      task.model = { provider: 'synthetic', model: options.body.selected_model.model_id }
      task.context_budget = { window: 258000, compression_at: 232200, compressions: 0, source: 'user_assumed', measurement: 'utf8_upper_bound' }
    }
    history.value.unshift(task)
    return task
  }
  if (path === '/insights/tasks' || path === '/insights/tasks/history') {
    const query = options.query, model = query.selected_model ? JSON.parse(query.selected_model) : null
    const rows = history.value.filter(t => t.account === query.account && t.username === query.username && t.member_username === query.member_username && t.engine === query.engine
      && (!model || ['profile_id', 'model_id', 'reasoning_effort', 'thinking_mode', 'thinking_budget'].every(key => (t.selected_model?.[key] ?? null) === (model[key] ?? null))))
    if (options.method === 'DELETE') {
      const removed = rows.filter(t => !t.history_hidden && !['queued', 'running'].includes(t.status))
      removed.forEach(t => { t.history_hidden = true })
      return { removed: removed.length }
    }
    return rows.filter(t => query.include_hidden || !t.history_hidden).slice(query.offset || 0, (query.offset || 0) + query.limit)
  }
  const id = path.split('/')[3], task = history.value.find(t => t.id === id)
  if (!task) throw new Error(`合成任务不存在：${id}`)
  if (path.endsWith('/history') && options.method === 'DELETE') {
    if (['queued', 'running'].includes(task.status)) throw new Error('运行中的任务不能移除历史')
    const removed = Number(!task.history_hidden)
    task.history_hidden = true
    return { removed }
  }
  if (path.endsWith('/messages')) return { items: [
    { ...task.references[0], identity: 's:123', text, fingerprint: fingerprint.value, emotion: '温暖', intent: '关心', reason: '合成样本：主动询问早餐偏好。', sources: ['a'] },
    { source: 'b', username: task.username, anchor: 'synthetic:message:2', time: start + 11, text: replyText, sender_id: 'synthetic', identity: 's:124', fingerprint: replyFingerprint.value, emotion: '愉快', intent: '回应', reason: '合成样本：接受提议并表达感谢。', sources: ['b'] },
  ], total: 2 }
  if (path.endsWith('/cancel')) { task.status = 'cancelled'; task.stage = '已取消'; event?.({ kind: 'insight', body: { task_id: id } }) }
  return task
} }
const state = useChatInsights({ account, contact, open, api, shared: reactive({}) })
state.engine.value = 'laya'
const labels = computed(() => longLabels.value ? Object.fromEntries(Object.entries(state.labels.value).map(([key, value]) => [key, { ...value, emotion: '积极友善并表达对后续安排的期待', intent: '回应具体问题并主动确认下一步的详细安排' }])) : state.labels.value)
const messageState = { insightLabels: labels, privacyMode: false, onMessageAvatarMouseEnter: () => {}, onMessageAvatarMouseLeave: () => {}, openMediaContextMenu: () => {}, contactProfileCardOpen: false, contactProfileCardMessageId: '', highlightServerIdStr: '', highlightMessageId: '', isMentionContactProfileCardForMessage: () => false }
const message = computed(() => ({ id: 'synthetic:message:1', sender: '林', isSent: false, serverIdStr: '123', createTime: start + 10, fullTime: '合成消息', renderType: 'text', content: changed.value ? '原消息已编辑，旧标签应隐藏。' : text }))
const replyMessage = computed(() => ({ id: 'synthetic:message:2', sender: '我', isSent: true, serverIdStr: '124', createTime: start + 11, fullTime: '合成消息', renderType: 'text', content: changed.value ? '回复已编辑，旧标签应隐藏。' : replyText }))
const chooseContact = value => { contact.value = value; open.value = true; located.value = '' }
const toggleGroup = () => chooseContact(contact.value.isGroup ? privateContact : groupContact)
const toggleUnknown = () => {
  const portrait = state.activeTask.value.portrait, unknown = portrait.traits.humor.score !== null
  portrait.traits.humor.score = unknown ? null : 55
  if (portrait.mbti) portrait.mbti.JP.score = unknown ? null : 65
}
const toggleFailure = () => {
  const task = state.activeTask.value
  task.status = task.status === 'failed' ? 'completed' : 'failed'
  task.stage = task.status === 'failed' ? '合成失败：保留已完成结果' : '本地统计画像完成'
  task.error = task.status === 'failed' ? { code: 'SYNTHETIC_FAILURE', message: '合成校验失败，未重试也未替换已保存结果。', diagnostic_id: 'synthetic-diag-001' } : null
}
const toggleModelReady = async () => {
  const missing = modelStatus.state === 'ready'
  modelStatus = { ...modelStatus, state: missing ? 'missing' : 'ready', downloaded_bytes: missing ? 0 : 681000000 }
  await state.loadLocalModel()
}
const locateSource = async source => {
  open.value = false
  await nextTick()
  if (getComputedStyle(document.querySelector('.fake-conversation')).display === 'none') throw new Error('原文定位前聊天区域仍不可见')
  located.value = source.anchor
  return true
}
watchEffect(() => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light' })
</script>
<template>
  <div class="preview-app">
    <header class="preview-toolbar"><strong>聊天画像 · 隔离合成验收</strong><button aria-label="预览切换主题" @click="dark = !dark">{{ dark ? '浅色模式' : '深色模式' }}</button><button aria-label="预览切换群聊" @click="toggleGroup">切换单聊/群聊</button><button @click="changed = !changed">编辑示例消息</button><button @click="longLabels = !longLabels">切换长标签样例</button><button aria-label="预览切换证据不足" :disabled="!state.activeTask.value?.portrait" @click="toggleUnknown">切换证据不足样例</button><button aria-label="预览模拟任务失败" :disabled="!state.activeTask.value" @click="toggleFailure">切换失败样例</button><button aria-label="预览模拟模型缺失" @click="toggleModelReady">切换模型就绪</button><button v-if="!open" aria-label="预览打开画像" @click="open = true">重新打开画像</button><output>真实模型调用 0 · 新建合成任务 {{ postCount }} · 成员读取 {{ memberReads }} · API 配置读取 {{ settingsReads }}</output></header>
    <main class="preview-main">
      <aside class="preview-sessions" aria-label="合成会话列表"><div class="preview-session-title">聊天</div><div class="preview-search">搜索合成会话</div><button :class="{ selected: !contact.isGroup }" @click="chooseContact(privateContact)"><span class="session-avatar">林</span><span><strong>合成样本 · 小林</strong><small>明天我带早餐过来</small></span></button><button :class="{ selected: contact.isGroup }" @click="chooseContact(groupContact)"><span class="session-avatar group-avatar">群</span><span><strong>合成样本 · 周五项目群</strong><small>确认活动安排和分工</small></span></button><p>当前列表及画像均为合成样本，不读取私人聊天。</p></aside>
      <div class="preview-content">
        <section v-show="!open" class="fake-conversation"><h2>{{ contact.name }}</h2><MessageItem :message="message" :state="messageState" /><MessageItem :message="replyMessage" :state="messageState" /><p v-if="located" class="located-source" role="status">已定位：{{ located }}</p></section>
        <ChatInsightsPanel v-if="open" :key="contact.username" :state="state" :contact="contact" :locate-source="locateSource" @close="open = false" />
      </div>
    </main>
  </div>
</template>
<style>
:root { --app-shell-bg: #f6f8f7; --app-surface-bg: #fff; --app-surface-soft: #f4f7f5; --app-border: #e1e7e3; --app-text-primary: #263b2d; --app-text-secondary: #75877c; }
html[data-theme=dark] { --app-shell-bg: #1b1b1b; --app-surface-bg: #222629; --app-surface-soft: #2b3033; --app-border: #3b4245; --app-text-primary: #e0e7e2; --app-text-secondary: #a5b1a9; }
body { margin: 0; font-family: system-ui, sans-serif; color: var(--app-text-primary); background: var(--app-surface-soft); } * { box-sizing: border-box; }
.preview-app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.preview-toolbar { display: flex; flex-shrink: 0; gap: 8px 12px; align-items: center; flex-wrap: wrap; padding: 10px 18px; font-size: 11px; border-bottom: 1px solid var(--app-border); } button { color: inherit; } .preview-toolbar button { padding: 4px 8px; background: var(--app-surface-bg); border: 1px solid var(--app-border); border-radius: 6px; cursor: pointer; } .preview-toolbar output { color: var(--app-text-secondary); }
.preview-main { position: relative; display: flex; flex: 1; min-height: 0; min-width: 0; } .preview-content { display: flex; flex: 1; min-width: 0; min-height: 0; }
.preview-sessions { flex: 0 0 240px; padding: 20px 10px; background: var(--app-surface-bg); border-right: 1px solid var(--app-border); } .preview-session-title { padding: 0 12px 16px; font-size: 22px; font-weight: 650; } .preview-search { margin: 0 8px 20px; padding: 9px 12px; color: var(--app-text-secondary); border-radius: 8px; background: var(--app-surface-soft); font-size: 12px; } .preview-sessions>button { display: flex; width: 100%; gap: 10px; align-items: center; text-align: left; border: 0; border-radius: 8px; background: transparent; padding: 12px 8px; cursor: pointer; } .preview-sessions>button.selected { background: var(--app-surface-soft); } .preview-sessions strong { display: block; font-size: 12px; font-weight: 600; } .preview-sessions small { display: block; color: var(--app-text-secondary); font-size: 11px; margin-top: 4px; } .session-avatar { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 10px; background: #d9e5f5; color: #405574; } .group-avatar { background: #e7dfef; color: #765887; } .preview-sessions>p { font-size: 11px; color: var(--app-text-secondary); padding: 12px; line-height: 1.6; }
.fake-conversation { flex: 1; padding: 28px; min-width: 0; overflow: auto; } .fake-conversation h2 { font-size: 16px; margin-bottom: 30px; } .located-source { overflow-wrap: anywhere; }
@media (max-width: 680px) { .preview-sessions { display: none; } .preview-toolbar { padding: 8px; gap: 6px; } .preview-toolbar>strong { width: 100%; } .preview-toolbar output { width: 100%; } .fake-conversation { padding: 16px; } }
</style>
