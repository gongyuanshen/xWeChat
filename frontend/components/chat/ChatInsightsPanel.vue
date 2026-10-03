<script setup>
import { computed, ref } from 'vue'
import { ArrowLeft, SlidersHorizontal, Heart, UserRound, Users, MessageCircle, FileText, Activity } from '@lucide/vue'
import AgentModelPicker from './AgentModelPicker.vue'
import InsightRadar from './InsightRadar.vue'
import InsightEvidence from './InsightEvidence.vue'
import MessageRecognitionControl from './MessageRecognitionControl.vue'

const props = defineProps({ state: { type: Object, required: true }, recognition: Object, contact: Object, locateSource: Function, privacyMode: Boolean, showSettings: Boolean })
const emit = defineEmits(['close'])
const { range, engine, localModel, localLoading, localBusy, localError, localModelPath, loadLocalModel, downloadLocalModel, pauseLocalModel, importLocalModel,
  member, members, membersLoading, tasks, activeTask, labelsEnabled, loading, busy, error, running,
  includeHidden, historyConfirmation, historyNotice, removeHistory,
  profiles, profilesLoading, profilesError, modelChoice, modelSelection, loadProfiles, loadHistory, loadMembers, selectTask, create, cancel } = props.state
const settingsOpen = ref(props.showSettings), memberPickerOpen = ref(false)
const portrait = computed(() => activeTask.value?.portrait)
const isGroup = computed(() => Boolean(props.contact?.isGroup || props.contact?.username?.endsWith('@chatroom')))
const groupOverview = computed(() => isGroup.value && !member.value)
const subjectName = computed(() => member.value ? members.value.find(item => item.username === member.value)?.displayName || member.value : props.contact?.name || props.contact?.username)
const engineName = computed(() => engine.value === 'laya' ? '本地 Laya' : 'API 模型')
const coverage = computed(() => activeTask.value?.coverage)
const memberRead = computed(() => activeTask.value?.read_scope === 'member')
const peerRead = computed(() => activeTask.value?.read_scope === 'peer')
const readSubject = computed(() => memberRead.value ? '成员' : peerRead.value ? '对方' : null)
const taskSubject = computed(() => {
  const id = activeTask.value?.member_username
  return isGroup.value ? id ? members.value.find(item => item.username === id)?.displayName || id : '群整体' : subjectName.value
})
// 升级前私聊及成员任务也分析全会话文本；进度必须按保存的任务范围解释。
const analysisText = computed(() => ['member', 'peer'].includes(activeTask.value?.analysis_scope) ? coverage.value?.target_text : coverage.value?.text)
const progressLabel = computed(() => (activeTask.value?.engine ?? engine.value) === 'api' ? '消息标签' : '已分析')
const portraitFailed = computed(() => activeTask.value?.status === 'failed' && activeTask.value.error?.phase === 'portrait')
const reuseProgress = computed(() => {
  const progress = activeTask.value?.progress
  return progress?.reused === undefined ? null : `其中复用 ${progress.reused} 条，新识别 ${progress.analyzed - progress.reused} 条`
})
const legacyMemberTask = computed(() => Boolean(activeTask.value?.member_username && activeTask.value.analysis_scope === undefined))
const legacyPeerTask = computed(() => Boolean(activeTask.value && !isGroup.value && (activeTask.value.analysis_scope === undefined || activeTask.value.analysis_scope === 'conversation')))
const mbtiAxes = ['EI', 'SN', 'TF', 'JP']
const formatDate = value => new Date(value * 1000).toLocaleString()
const inputDate = value => {
  const date = new Date(value * 1000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}
const changeDate = (key, event) => { range[key] = Math.floor(new Date(event.target.value).getTime() / 1000) }
const statuses = { queued: '等待分析', running: '分析中', completed: '已完成', failed: '分析失败', cancelled: '已取消' }
const failureStatuses = { reading: '消息读取失败', labels: '消息标签识别失败', portrait: '画像生成失败', local: '本地分析失败' }
const taskStatus = task => task.status === 'failed' ? failureStatuses[task.error?.phase] || statuses.failed : statuses[task.status]
const localStatuses = { missing: '尚未下载', downloading: '下载中', verifying: '校验中', ready: '已就绪', paused: '已暂停', failed: '模型准备失败' }
const formatBytes = value => `${(value / 1000000).toFixed(1)} MB`
const canChooseDirectory = typeof window !== 'undefined' && typeof window.wechatDesktop?.chooseDirectory === 'function'
const chooseLocalDirectory = async () => {
  localError.value = ''
  try {
    const result = await window.wechatDesktop.chooseDirectory({ title: '选择已有 Laya 模型目录' })
    if (result.canceled) return
    if (!result.filePaths?.[0]) throw new Error('目录选择未返回路径')
    localModelPath.value = result.filePaths[0]
  } catch (err) { localError.value = err.message }
}
const traitNames = { energy: '活力', humor: '幽默', calm: '平静', initiative: '主动', care: '关怀', closeness: '亲近' }
const mbtiType = computed(() => {
  const axes = portrait.value?.mbti
  if (!axes || Object.values(axes).some(v => v.score === null || v.score === 50)) return null
  return ['EI', 'SN', 'TF', 'JP'].map(key => key[axes[key].score > 50 ? 0 : 1]).join('')
})
const toggleMembers = () => { memberPickerOpen.value = !memberPickerOpen.value; if (memberPickerOpen.value) void loadMembers() }
const locate = async source => {
  const taskId = activeTask.value.id
  error.value = ''
  try {
    const reference = activeTask.value.references.find(item => item.source === source)
    if (!reference) throw new Error('画像来源缺少消息定位信息')
    if (!props.locateSource) throw new Error('消息定位接口未连接')
    const found = await props.locateSource(reference)
    if (activeTask.value?.id !== taskId) return
    if (found === false) throw new Error('未定位到来源消息')
    emit('close')
  } catch (err) { if (activeTask.value?.id === taskId) error.value = `${err.message}${err.diagnostic_id ? ` · 诊断 ${err.diagnostic_id}` : ''}` }
}
</script>
<template>
  <section class="chat-insights-panel" aria-label="聊天画像">
    <header class="dashboard-header">
      <div class="dashboard-title"><Users v-if="isGroup" :size="18" /><UserRound v-else :size="18" /><strong :class="{ 'privacy-blur': privacyMode }">{{ contact?.name || contact?.username }}</strong><span class="engine-badge">{{ engineName }} · {{ groupOverview ? '群聊画像' : '聊天画像' }}</span></div>
      <button type="button" aria-label="画像分析设置" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen"><SlidersHorizontal :size="14" />分析设置</button>
      <button type="button" aria-label="返回聊天" @click="emit('close')"><ArrowLeft :size="14" />返回聊天</button>
    </header>
    <div class="insights-scroll">
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <section class="analysis-launch" aria-label="分析对象与启动">
        <div class="launch-target" :class="{ 'privacy-blur': privacyMode }">
          <strong>分析对象</strong>
          <button v-if="isGroup" type="button" aria-label="选择分析对象" :disabled="busy || running" :aria-expanded="memberPickerOpen" @click="toggleMembers"><Users :size="14" />{{ member ? subjectName : '群整体' }} · 选择对象</button>
          <span v-else>{{ subjectName }}</span>
          <p class="muted">{{ member ? '只读取并分析该成员在所选时段内的消息，标签和画像均属于该成员。' : isGroup ? '读取所选时段内全部群成员的消息，分析群体交流。' : '只读取并分析对方在所选时段内发送的消息，本人消息不进入本任务。' }}</p>
        </div>
        <div v-if="isGroup && memberPickerOpen" class="member-picker" :class="{ 'privacy-blur': privacyMode }"><label>选择群整体或单个成员<select v-model="member" :disabled="membersLoading || busy || running" aria-label="画像分析对象"><option value="">群整体</option><option v-for="item in members" :key="item.username" :value="item.username">{{ item.displayName }}（{{ item.username }}）</option></select></label><p v-if="membersLoading" role="status">正在读取已发言成员…</p><button type="button" :disabled="membersLoading || busy || running" @click="loadMembers">刷新成员</button></div>
        <div class="launch-actions" :class="{ 'privacy-blur': privacyMode }">
          <button class="start-analysis" type="button" :disabled="busy || running || membersLoading || (engine === 'api' ? profilesLoading : localBusy || localModel?.state !== 'ready')" @click="create()">{{ busy ? '提交中…' : running ? '正在分析' : activeTask ? '重新分析（复用已完成标签）' : '开始分析' }} · {{ groupOverview ? '群整体' : subjectName }}</button>
          <button type="button" aria-label="从头重算全部消息" :disabled="busy || running || membersLoading || (engine === 'api' ? profilesLoading : localBusy || localModel?.state !== 'ready')" @click="create(true)">从头重算全部消息</button>
          <button v-if="running" type="button" :disabled="busy" @click="cancel">取消分析</button>
        </div>
        <p class="muted">默认复用符合当前设置的已保存标签，其余消息重新识别；最终画像仍根据所选范围内的全部材料重新整理。如需结合新增对话重新判断已有标签，请从头重算全部所选消息。</p>
        <p v-if="running || busy" class="muted">本次对象已固定，取消当前分析后再切换对象。</p>
        <small>{{ formatDate(range.start) }} — {{ formatDate(range.end) }} · {{ engineName }}<button type="button" @click="settingsOpen = !settingsOpen">调整时间与模型</button></small>
      </section>
      <div class="insight-overview" :class="{ 'privacy-blur': privacyMode }" role="status">
        <span><i class="status-dot" />{{ readSubject ? `已读取${readSubject}消息` : '已扫描会话消息' }}：<b>{{ coverage?.total ?? '—' }}</b></span>
        <span>{{ groupOverview ? '群聊文本' : member ? '目标成员文本' : '对方文本' }}：<b>{{ coverage?.target_text ?? '—' }}</b></span>
        <span>{{ progressLabel }}：<b>{{ activeTask ? `${activeTask.progress.analyzed} / ${analysisText ?? '—'}` : '—' }}</b> 条文本</span>
        <span v-if="reuseProgress" class="label-reuse">{{ reuseProgress }}</span>
        <span>状态：<b>{{ activeTask ? taskStatus(activeTask) : loading ? '读取中' : '尚未分析' }}</b></span>
        <button v-if="running" type="button" :disabled="busy" @click="cancel">取消分析</button>
      </div>
      <p v-if="activeTask" class="range-caption" :class="{ 'privacy-blur': privacyMode }">统计范围：{{ formatDate(activeTask.start) }} — {{ formatDate(activeTask.end) }}（结束不含）</p>
      <p v-if="peerRead" class="analysis-scope muted">本次仅读取并分析 {{ taskSubject }} 发送的消息，本人消息不进入本任务。</p>
      <p v-else-if="memberRead" class="analysis-scope muted">本次仅读取并分析 {{ taskSubject }} 的消息，其他成员不进入本任务。</p>
      <p v-else-if="activeTask?.analysis_scope === 'member'" class="analysis-scope muted">此历史任务扫描过全会话，模型仅分析所选成员的文本；重新分析将只读取该成员消息。</p>
      <p v-else-if="legacyMemberTask" class="analysis-scope muted">此历史任务的分析范围为全会话文本；重新分析将仅处理所选成员文本。</p>
      <p v-else-if="legacyPeerTask" class="analysis-scope muted">此历史任务分析了双方文本，计数保留当时的实际范围；重新分析将只读取并分析对方消息。</p>
      <p v-if="portraitFailed" class="portrait-failure muted" :class="{ 'privacy-blur': privacyMode }">已保存消息标签 {{ activeTask.progress.analyzed }} / {{ analysisText ?? '—' }} 条；{{ activeTask.error.code === 'INSIGHT_MODEL_REFUSED' ? '画像生成被模型服务拒绝' : '画像生成失败' }}。已保存的标签仍可查看；使用相同模型和分析范围重新分析时，可复用符合当前设置的标签。</p>
      <p v-if="activeTask?.error" role="alert" class="error">{{ activeTask.error.code }}：{{ activeTask.error.message }} · 诊断：{{ activeTask.error.diagnostic_id }}</p>
      <details class="analysis-settings" :open="settingsOpen" @toggle="settingsOpen = $event.target.open">
        <summary>分析设置与历史</summary>
      <div class="analysis-controls">
        <label>分析方式<select v-model="engine" :disabled="busy || running" aria-label="画像分析方式"><option value="laya">本地 Laya · 统计画像</option><option value="api">API 模型 · 详细文字分析</option></select></label>
        <MessageRecognitionControl v-if="recognition" :state="recognition" :engine="engine" />
        <template v-if="engine === 'api'">
          <fieldset :disabled="busy || running"><AgentModelPicker v-model="modelChoice" :profiles="profiles" :profiles-loading="profilesLoading" :profiles-error="profilesError" @refresh="loadProfiles" /></fieldset>
          <p v-if="modelSelection.state.notice" role="status">{{ modelSelection.state.notice }}<button v-if="modelSelection.state.dirty" type="button" @click="modelSelection.choose(modelChoice)">重试保存</button></p>
        </template>
        <div v-else class="local-model">
          <div class="section-heading"><strong>Laya 多语言模型</strong><button type="button" :disabled="localLoading || localBusy" @click="loadLocalModel">刷新状态</button></div>
          <p class="muted">约 681 MB · CPU 本地运行。Laya 对文本分类评分，由统计规则整理画像；详细文字分析请选择 API 模式。模型准备好后，聊天分析无需联网。</p>
          <p class="muted">本地分类为实验性结果，可能误判情绪和意图；请结合消息原文核对。</p>
          <p v-if="localLoading && !localModel" role="status">正在读取模型状态…</p>
          <template v-if="localModel">
            <p role="status">{{ localStatuses[localModel.state] }} · {{ formatBytes(localModel.downloaded_bytes) }} / {{ formatBytes(localModel.total_bytes) }}</p>
            <progress v-if="localModel.state !== 'ready'" aria-label="本地模型下载进度" :value="localModel.downloaded_bytes" :max="localModel.total_bytes" />
            <div class="local-actions">
              <button v-if="['missing', 'paused', 'failed'].includes(localModel.state)" type="button" aria-label="下载本地画像模型" :disabled="localBusy" @click="downloadLocalModel">{{ localModel.state === 'paused' ? '继续下载' : localModel.state === 'failed' ? '重试下载' : '下载模型' }}</button>
              <button v-if="localModel.state === 'downloading'" type="button" aria-label="暂停本地模型下载" :disabled="localBusy" @click="pauseLocalModel">暂停下载</button>
            </div>
            <p v-if="localModel.error" role="alert" class="error">{{ localModel.error.code }}：{{ localModel.error.message }}<br />诊断：{{ localModel.error.diagnostic_id }}</p>
          </template>
          <details class="local-import"><summary>导入已有模型目录</summary><label>模型目录<input v-model="localModelPath" type="text" aria-label="已有画像模型目录" placeholder="填写完整模型目录路径" /></label><div class="local-actions"><button v-if="canChooseDirectory" type="button" aria-label="选择已有模型目录" :disabled="localBusy" @click="chooseLocalDirectory">选择目录</button><button type="button" aria-label="导入已有画像模型" :disabled="localBusy || !localModelPath.trim() || ['downloading', 'verifying'].includes(localModel?.state)" @click="importLocalModel">导入并校验</button></div><small>导入需校验完整模型文件，不会直接信任目录内容。</small></details>
          <p v-if="localError" role="alert" class="error">{{ localError }}</p>
        </div>
        <div class="date-range"><label>开始（含）<input type="datetime-local" step="1" aria-label="画像开始时间" :disabled="busy || running" :value="inputDate(range.start)" @change="changeDate('start', $event)" required /></label><label>结束（不含）<input type="datetime-local" step="1" aria-label="画像结束时间" :disabled="busy || running" :value="inputDate(range.end)" @change="changeDate('end', $event)" required /></label></div>
        <small>默认最近七天；点击开始后才调用模型。画像仅表示选定文本中的交流倾向。</small>
      </div>
      <label class="tag-toggle"><input v-model="labelsEnabled" type="checkbox" aria-label="显示消息情绪与意图标签" />显示消息情绪与意图标签<small>仅显示保存结果</small></label>
      <section class="history">
        <div class="section-heading"><h3>分析历史 · {{ engine === 'laya' ? '本地 Laya' : 'API' }}</h3><button type="button" :disabled="loading || busy || running" @click="loadHistory">{{ loading ? '加载中…' : '刷新' }}</button></div>
        <label class="history-view"><input v-model="includeHidden" type="checkbox" aria-label="查看保留画像结果" :disabled="loading || busy || running" @change="loadHistory" />查看保留结果</label>
        <select :value="tasks.some(task => task.id === activeTask?.id) ? activeTask.id : ''" :disabled="busy || running" aria-label="画像分析历史" @change="selectTask($event.target.value)"><option value="" disabled>选择已保存任务</option><option v-for="task in tasks" :key="task.id" :value="task.id">{{ formatDate(task.created) }} · {{ taskStatus(task) }} · {{ task.model?.model || task.selected_model?.model_id }}{{ task.history_hidden ? ' · 已移除' : '' }}</option></select>
        <p v-if="!loading && !tasks.length" class="muted">{{ includeHidden ? '该对象在此分析方式下暂无保存结果。' : '该对象在此分析方式下暂无历史入口。' }}</p>
        <p v-if="activeTask?.history_hidden" class="muted">当前结果的历史入口已移除，画像、消息标签与原文依据仍可查看。</p>
        <div class="history-actions"><button type="button" aria-label="移除当前分析记录" :disabled="busy || running || !activeTask || activeTask.history_hidden" @click="historyConfirmation = 'single'">移除当前记录</button><button type="button" aria-label="清空画像分析历史" :disabled="busy || !tasks.length" @click="historyConfirmation = 'all'">清空历史</button></div>
        <div v-if="historyConfirmation" class="history-confirmation" role="group" aria-label="确认移除分析历史">
          <p>{{ historyConfirmation === 'all' ? '清空当前聊天、分析对象和分析方式下的已结束历史记录（包含该方式下的所有模型）？运行中的任务会保留。' : '移除当前分析记录？' }}</p>
          <p>仅移除历史入口，消息标签、画像与原文依据仍保留。</p>
          <div class="history-actions"><button type="button" aria-label="确认移除分析历史" :disabled="busy" @click="removeHistory(historyConfirmation === 'all')">确认移除</button><button type="button" aria-label="取消移除分析历史" :disabled="busy" @click="historyConfirmation = ''">取消</button></div>
        </div>
        <p v-if="historyNotice" role="status">{{ historyNotice }}</p>
      </section>
      <section v-if="activeTask" class="task-detail" :class="{ 'privacy-blur': privacyMode }">
        <div class="section-heading"><h3>{{ taskStatus(activeTask) }}</h3><button v-if="running" type="button" :disabled="busy" @click="cancel">取消分析</button></div>
        <p role="status">分析对象：{{ taskSubject }} · {{ progressLabel }} {{ activeTask.progress.analyzed }} / {{ analysisText ?? '—' }} 条文本</p>
        <p v-if="reuseProgress" class="label-reuse muted">{{ reuseProgress }}</p>
        <p class="muted">{{ activeTask.stage }} · {{ readSubject ? `已读取${readSubject}消息` : '已扫描' }} {{ activeTask.progress.read }} · 批次 {{ activeTask.progress.batches }}</p>
        <p class="muted">{{ formatDate(activeTask.start) }} — {{ formatDate(activeTask.end) }}<br />数据源：{{ activeTask.data_source }} · 模型：{{ activeTask.model?.model || activeTask.selected_model?.model_id }}</p>
        <p v-if="activeTask.context_budget" class="muted">上下文预算 {{ activeTask.context_budget.window.toLocaleString() }} · 压缩阈值 {{ activeTask.context_budget.compression_at.toLocaleString() }} · 已压缩 {{ activeTask.context_budget.compressions }} 次（UTF-8 保守估算）<br />{{ activeTask.context_budget.source === 'user_assumed' ? '用户指定，未经服务商确认' : '容量来自模型元数据' }}</p>
        <p v-if="activeTask.coverage" class="muted">{{ readSubject ? `${readSubject}消息` : '会话消息' }} {{ activeTask.coverage.total }} · {{ readSubject ? `${readSubject}文本` : '会话文本' }} {{ activeTask.coverage.text }} · 跳过 {{ activeTask.coverage.skipped }}<template v-if="!readSubject"> · {{ member ? '目标成员文本' : '目标文本' }} {{ activeTask.coverage.target_text }} · 会话发言人数 {{ activeTask.coverage.participants }}</template></p>
        <p v-if="activeTask.error" role="alert" class="error">{{ activeTask.error.code }}：{{ activeTask.error.message }}<br />诊断：{{ activeTask.error.diagnostic_id }}</p>
        <p v-if="['failed', 'cancelled'].includes(activeTask.status)" class="muted">勾选上方「显示消息情绪与意图标签」，可在聊天消息下方查看已保存的标签；重新分析会创建新任务，默认复用符合当前设置的标签。</p>
      </section>
      </details>
      <section class="portrait-hero" :class="{ 'privacy-blur': privacyMode }">
        <div class="subject-identity">
          <img v-if="contact?.avatar && !member" class="subject-avatar" :src="contact.avatar" :alt="subjectName" referrerpolicy="no-referrer" />
          <div v-else class="subject-avatar avatar-placeholder"><Users v-if="groupOverview" :size="28" /><UserRound v-else :size="28" /></div>
          <div><h2>{{ subjectName }}</h2><p>{{ groupOverview ? '群体交流 · 所选时段' : '人格属性 · 聊天推测' }} <b v-if="!groupOverview">{{ mbtiType || '证据不足' }}</b></p><small v-if="member">{{ contact?.name }} · 群成员画像</small></div>
        </div>
        <div v-if="!isGroup" class="affinity-score">
          <div class="section-heading"><h3><Heart :size="14" />亲近倾向</h3><strong>{{ portrait?.affinity?.score ?? '证据不足' }}</strong></div>
          <template v-if="portrait?.affinity && portrait.affinity.score !== null"><meter min="0" max="100" :value="portrait.affinity.score" aria-label="对方对本人的亲近倾向" /><div class="scale-labels"><span>0</span><span>对方对本人的聊天表现</span><span>100</span></div><details><summary>依据与说明</summary><InsightEvidence :text="portrait.affinity.reason" :sources="portrait.affinity.sources" @locate="locate" /></details></template>
          <p v-else class="muted">有足够交流线索时显示，分数不代表真实关系。</p>
        </div>
        <div v-else-if="member" class="group-stats"><div><b>{{ coverage?.target_text ?? '—' }}</b><span>成员文本</span></div><div><b>{{ activeTask?.progress.analyzed ?? '—' }}</b><span>{{ progressLabel }}</span></div><div v-if="memberRead"><b>{{ coverage?.skipped ?? '—' }}</b><span>跳过的非文本</span></div></div>
        <div v-else class="group-stats"><div><b>{{ coverage?.participants ?? '—' }}</b><span>发言人数</span></div><div><b>{{ coverage?.target_text ?? '—' }}</b><span>群聊文本</span></div><div><b>{{ coverage?.skipped ?? '—' }}</b><span>跳过消息</span></div></div>
      </section>
      <div v-if="!portrait" class="empty-portrait"><p>{{ running ? '正在分析所选文本，完成后显示画像。' : activeTask ? '本任务没有生成画像，可在分析设置中查看详情或重新分析。' : '尚无当前对象的画像，选择时间范围后开始本地分析。' }}</p><button type="button" @click="settingsOpen = true">打开分析设置</button></div>
      <div class="portrait-grid" :class="{ 'privacy-blur': privacyMode }">
        <section v-if="!groupOverview" class="portrait-card mbti-card">
          <div class="card-heading"><h3><UserRound :size="15" />MBTI · 聊天推测</h3><small>{{ mbtiType || '证据不足' }} · 聊天倾向</small></div>
          <div v-for="axis in mbtiAxes" :key="axis" class="mbti-axis" :data-mbti-axis="axis"><span>{{ axis }}</span><template v-if="portrait?.mbti && portrait.mbti[axis].score !== null"><p>{{ axis[0] }} {{ portrait.mbti[axis].score }}% · {{ axis[1] }} {{ 100 - portrait.mbti[axis].score }}%</p><meter min="0" max="100" :value="portrait.mbti[axis].score" :aria-label="`${axis[0]} / ${axis[1]} 聊天倾向`" /></template><p v-else class="muted">证据不足</p></div>
          <details><summary>依据与说明</summary><p>完整类型：{{ mbtiType || '证据不足' }}</p><small>分数高表示 E / S / T / J，50 表示无倾向。至少需要 100 条目标本人文本；聊天文本推断不能替代人格测量。</small><template v-if="portrait?.mbti"><div v-for="axis in mbtiAxes" :key="axis" class="score"><strong>{{ axis }}</strong><InsightEvidence :text="portrait.mbti[axis].reason" :sources="portrait.mbti[axis].sources" @locate="locate" /></div></template></details>
        </section>
        <section v-else class="portrait-card group-atmosphere">
          <div class="card-heading"><h3><Users :size="15" />群聊氛围</h3><small>群体交流</small></div>
          <InsightEvidence v-if="portrait?.mood" v-bind="portrait.mood" @locate="locate" /><p v-else class="muted">情绪证据不足</p>
          <h4>交流特点</h4><template v-if="portrait?.communication.length"><InsightEvidence v-for="(item, i) in portrait.communication" :key="i" v-bind="item" @locate="locate" /></template><p v-else class="muted">证据不足</p>
          <small>描述所选文本的群体表现，不推断群体人格或私人关系。</small>
        </section>
        <section class="portrait-card radar-card"><div class="card-heading"><h3><Activity :size="15" />互动风格</h3><small>聊天表现</small></div><InsightRadar v-if="portrait" :traits="portrait.traits" /><p v-else class="card-empty">完成分析后显示六维特征</p><details v-if="portrait"><summary>六维特征依据</summary><div v-for="(value, key) in portrait.traits" :key="key" class="score"><strong>{{ traitNames[key] }}：{{ value.score === null ? '证据不足' : value.score }}</strong><InsightEvidence :text="value.reason" :sources="value.sources" @locate="locate" /></div></details></section>
        <section class="portrait-card topics-card"><div class="card-heading"><h3><MessageCircle :size="15" />常见话题</h3><small>{{ engineName }}画像</small></div><div v-if="portrait?.topics.length" class="topic-tags"><details v-for="(item, i) in portrait.topics" :key="i" class="topic-tag"><summary>{{ item.text }}</summary><InsightEvidence v-bind="item" @locate="locate" /></details></div><p v-else class="muted">尚无足够话题证据</p></section>
        <section class="portrait-card summary-card"><div class="card-heading"><h3><FileText :size="15" />画像摘要</h3><small>{{ groupOverview ? '群整体摘要' : '人物摘要' }}</small></div><div v-if="portrait" class="summary-quote"><InsightEvidence v-bind="portrait.summary" @locate="locate" /></div><p v-else class="muted">完成分析后显示摘要</p><small v-if="activeTask" class="updated-at">{{ engineName }} · {{ formatDate(activeTask.created) }}</small></section>
        <section v-if="portrait && !groupOverview" class="portrait-card communication-card"><div class="card-heading"><h3><MessageCircle :size="15" />交流特点与情绪</h3></div><InsightEvidence v-for="(item, i) in portrait.communication" :key="i" v-bind="item" @locate="locate" /><h4>情绪</h4><InsightEvidence v-if="portrait.mood" v-bind="portrait.mood" @locate="locate" /><p v-else class="muted">证据不足</p></section>
        <section v-if="portrait?.uncertain.length" class="portrait-card uncertainty-card"><div class="card-heading"><h3>依据与局限</h3></div><ul><li v-for="(item, i) in portrait.uncertain" :key="i">{{ item }}</li></ul></section>
      </div>

    </div>
  </section>
</template>
<style scoped>
.chat-insights-panel { container-type: inline-size; display: flex; flex: 1; flex-direction: column; width: 100%; min-width: 0; min-height: 0; background: var(--app-shell-bg, #f6f8f7); color: var(--app-text-primary, #25352d); font-size: 12px; line-height: 1.65; }
.dashboard-header { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 18px 22px; border-bottom: 1px solid var(--app-border, #e4e9e6); }
.dashboard-title { display: flex; align-items: center; flex: 1; gap: 10px; min-width: 120px; } .dashboard-title strong { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .dashboard-title>svg, h3>svg { color: #72a58a; flex-shrink: 0; }
.engine-badge { border: 1px solid var(--app-border, #dfe7e2); border-radius: 5px; padding: 2px 8px; font-size: 10px; white-space: nowrap; color: var(--app-text-secondary, #75877c); }
.dashboard-header button, .subject-picker>button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
.insights-scroll { overflow-y: auto; min-height: 0; flex: 1; padding: 18px 22px 24px; scrollbar-width: thin; }
.insight-overview { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 20px; padding: 10px 14px; margin-bottom: 16px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 7px; background: var(--app-surface-bg, #fff); color: var(--app-text-secondary, #75877c); }
.insight-overview b { color: var(--app-text-primary, #25352d); } .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #72a58a; margin-right: 7px; }
.range-caption { color: var(--app-text-secondary, #75877c); font-size: 10px; margin: -7px 0 14px; }
.portrait-hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 22px; margin-bottom: 16px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 9px; background: var(--app-surface-bg, #fff); }
.subject-identity { display: flex; align-items: center; gap: 16px; min-width: 0; flex: 1; } .subject-identity>div:last-child { min-width: 0; } h2 { margin: 0 0 3px; font-size: 19px; overflow-wrap: anywhere; } .subject-identity p { margin: 0; font-size: 11px; color: var(--app-text-secondary, #75877c); } .subject-identity p b { margin-left: 5px; color: var(--app-text-primary, #25352d); }
.subject-avatar { width: 58px; height: 58px; flex-shrink: 0; border-radius: 9px; object-fit: cover; border: 2px solid #72a58a; } .avatar-placeholder { display: grid; place-items: center; background: var(--app-surface-soft, #edf6f0); color: #72a58a; }
.affinity-score { flex: 1; min-width: 0; padding: 12px 16px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 8px; } .affinity-score strong { color: #72a58a; font-size: 18px; } .scale-labels { display: flex; justify-content: space-between; color: var(--app-text-secondary, #75877c); font-size: 10px; margin-top: 5px; }
.group-stats { display: flex; justify-content: space-around; gap: 28px; } .group-stats div { display: flex; flex-direction: column; text-align: center; } .group-stats b { font-size: 23px; color: #72a58a; } .group-stats span { color: var(--app-text-secondary, #75877c); }
.analysis-launch { margin-bottom: 16px; padding: 14px 18px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 8px; background: var(--app-surface-bg, #fff); }
.launch-target { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; } .launch-target button { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; overflow-wrap: anywhere; } .launch-target p { flex-basis: 100%; margin: 0; }
.launch-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 8px; } .launch-actions .start-analysis { flex: 1; min-width: 0; overflow-wrap: anywhere; } .analysis-launch>small { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.member-picker { margin-top: 8px; max-width: 620px; } fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.portrait-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } .portrait-card { min-width: 0; border: 1px solid var(--app-border, #dfe7e2); border-radius: 9px; padding: 16px 18px; background: var(--app-surface-bg, #fff); }
.card-heading { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 6px; padding-bottom: 9px; margin-bottom: 12px; border-bottom: 1px solid var(--app-border, #dfe7e2); } .card-heading h3 { margin: 0; } .card-heading small { font-size: 10px; }
.mbti-axis { margin-bottom: 15px; } .mbti-axis>span { font-size: 10px; } .mbti-axis p { margin: 2px 0 5px; font-size: 11px; }
meter { display: block; width: 100%; height: 7px; border: 0; border-radius: 5px; background: var(--app-surface-soft, #edf6f0); } meter::-webkit-meter-bar { height: 7px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 5px; background: var(--app-surface-soft, #edf6f0); } meter::-webkit-meter-optimum-value { background: linear-gradient(90deg, #24a8d6, #09b66d); border-radius: 5px; } meter::-moz-meter-bar { background: linear-gradient(90deg, #24a8d6, #09b66d); border-radius: 5px; }
.topic-tags { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; } .topic-tag { max-width: 100%; border: 1px solid var(--app-border, #dfe7e2); border-radius: 16px; padding: 3px 10px; } .topic-tag summary { color: inherit; overflow-wrap: anywhere; } .topic-tag[open] { width: 100%; border-radius: 8px; }
.summary-quote { border-left: 3px solid #72a58a; border-radius: 5px; padding: 6px 12px; background: var(--app-surface-soft, #f5f8f6); } .updated-at { display: block; margin-top: 20px; } .topics-card, .summary-card { min-height: 160px; }
details>summary { cursor: pointer; color: #72a58a; font-size: 11px; } details[open]>summary { margin-bottom: 10px; } .empty-portrait { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 0 18px; } .card-empty { min-height: 260px; display: grid; place-items: center; color: var(--app-text-secondary, #75877c); }
.analysis-settings { margin-bottom: 16px; padding: 14px 18px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 8px; background: var(--app-surface-bg, #fff); } .analysis-settings>summary { font-size: 12px; }
.history-view { display: inline-flex; flex-direction: row; justify-content: flex-start; align-items: center; gap: 6px; margin-bottom: 8px; } .history-view input { width: auto; margin: 0; } .history-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; } .history-confirmation { margin-top: 10px; padding: 10px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 6px; }
button, input, select { font: inherit; color: inherit; } button { border: 1px solid var(--app-border, #dfe7e2); border-radius: 6px; background: var(--app-surface-soft, #f5f8f6); padding: 5px 9px; cursor: pointer; } button:disabled { opacity: .5; cursor: default; } button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #079b57; outline-offset: 2px; }
.analysis-controls { display: flex; flex-direction: column; gap: 12px; }
.local-model { padding: 10px; border: 1px solid var(--app-border, #dfe7e2); border-radius: 8px; } .local-model p { margin: 8px 0; } .local-model progress { display: block; width: 100%; accent-color: #079b57; } .local-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; } .local-import { margin-top: 10px; } .local-import summary { cursor: pointer; } .local-import label { margin-top: 8px; }
.analysis-controls :deep(.agent-model-menu>summary) { display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 8px; }
.analysis-controls :deep(.agent-selection-popover) { top: calc(100% + 6px); bottom: auto; right: 0; }
label { display: flex; flex-direction: column; gap: 4px; } input:not([type=checkbox]), select { display: block; min-width: 0; width: 100%; box-sizing: border-box; border: 1px solid var(--app-border, #dfe7e2); background: var(--app-surface-bg, #fff); border-radius: 6px; padding: 7px; }
.date-range { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.start-analysis { background: #079b57; color: #fff; border-color: #079b57; padding: 9px; }
small, .muted { color: var(--app-text-secondary, #75877c); font-size: 11px; } .tag-toggle { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; margin: 18px 0; } .tag-toggle small { width: 100%; }
.history, .task-detail { border-top: 1px solid var(--app-border, #e4e9e6); padding-top: 12px; margin-top: 16px; } h3 { display: flex; align-items: center; gap: 7px; margin: 0 0 8px; font-size: 12px; font-weight: 600; } h4 { margin: 20px 0 8px; } .section-heading { display: flex; justify-content: space-between; align-items: baseline; } .section-heading button { font-size: 11px; }
.error { color: #b42318; overflow-wrap: anywhere; white-space: pre-wrap; } .score { padding: 8px 0; border-bottom: 1px solid var(--app-border, #e4e9e6); } p { overflow-wrap: anywhere; } ul { padding-left: 18px; }
@container (max-width: 680px) { .portrait-grid { grid-template-columns: 1fr; } .portrait-hero { flex-direction: column; align-items: stretch; padding: 16px; gap: 16px; } .dashboard-header { padding: 12px; gap: 8px; } .dashboard-title { width: 100%; flex: auto; } .insights-scroll { padding: 12px; } .date-range { grid-template-columns: 1fr; } .group-stats { gap: 14px; } }
</style>
