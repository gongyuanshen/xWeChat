<template>
  <details class="agent-subtasks" :open="opened" @toggle="toggle">
    <summary class="subtasks-summary">
      <ChevronRight class="disclosure-chevron" :size="16" :stroke-width="1.8" aria-hidden="true" />
      <span class="subtasks-title">{{ summary.plan_version ? phaseLabel : summary.total > 1 ? '并行分析' : '子任务分析' }}</span>
      <span v-if="summary.running" class="subtasks-count">{{ summary.running }} 项运行</span>
      <span v-if="summary.queued" class="subtasks-count">{{ summary.queued }} 项等待</span>
      <span class="subtasks-total">{{ summary.completed }}<template v-if="summary.total_known !== false">/{{ summary.total }}</template> 完成</span>
      <span v-if="summary.failed" class="subtasks-failed">{{ summary.failed }} 未完成</span>
      <span v-if="summary.interrupted" class="subtasks-count">{{ summary.interrupted }} 已暂停</span>
    </summary>
    <p v-if="summary.plan_version === 2 && summary.main_work" class="subtask-goal">主模型{{ summary.phase === 'interrupted' ? '已暂停' : summary.main_completed ? '已完成主线分析' : '正在处理' }}：{{ summary.main_work }}</p>
    <p v-if="summary.parallel_reason" class="subtasks-scan">并行安排：{{ summary.parallel_reason }}</p>
    <p v-if="summary.scanning" class="subtasks-scan" role="status">已发现 {{ summary.total }} 个分片，仍在读取并划分后续资料。</p>
    <p v-if="summary.reused" class="subtasks-scan">已复用 {{ summary.reused }} 个完成分片，继续处理剩余资料。</p>
    <p v-if="error" class="subtask-error" role="alert">{{ error }} <button type="button" @click="load()">重试</button></p>
    <p v-if="loading && !items.length" class="subtasks-empty" role="status">正在读取子任务…</p>
    <p v-else-if="!error && !items.length" class="subtasks-empty">子任务正在准备，稍后会在这里显示进展。</p>
    <ul class="subtasks-list">
      <li v-for="item in items" :key="item.id" class="subtask-item">
        <div class="subtask-heading">
          <strong>{{ item.name }}</strong>
          <span class="subtask-status" :class="[`is-${item.status}`, { 'agent-shimmer': item.status === 'running' }]"><component v-if="item.status !== 'running'" :is="statusIcons[item.status] || Info" :size="16" :stroke-width="1.8" aria-hidden="true" />{{ labels[item.status] || item.status }}</span>
          <small class="subtask-elapsed">用时 {{ elapsed(item) }}</small>
        </div>
        <p v-if="item.scope_names?.length" class="subtask-range">{{ item.scope_names.join('、') }}</p>
        <p v-if="item.time_range" class="subtask-range">{{ rangeLabel(item.time_range) }}</p>
        <p v-if="item.plan_version && item.objective" class="subtask-goal">{{ objectivePreview(item) }}</p>
        <p v-if="item.expected_output" class="subtask-range">预期交付：{{ item.expected_output }}</p>
        <p v-if="item.replacement_reason" class="subtask-wait">{{ item.replacement_reason }}</p>
        <p v-if="item.status === 'running' || item.status === 'queued'" class="subtask-action">{{ item.current_action || item.stage || labels[item.status] }}</p>
        <div v-if="item.coverage?.read != null" class="subtask-counts">
          <span>已读取 <b>{{ item.coverage.read }}</b> 条</span><span>已分析 <b>{{ item.coverage.analyzed || 0 }}</b> 条</span>
          <span v-if="item.coverage.complete" class="subtask-coverage-complete">范围已处理完成</span>
        </div>
        <div v-if="item.latest_progress?.text" class="subtask-update">
          <p :tabindex="expandedProgress[item.id] ? 0 : undefined" class="subtask-progress" :class="{ 'is-expanded': expandedProgress[item.id] }">{{ progressPreview(item) }}</p>
          <button v-if="isLongProgress(item)" class="subtask-expand" type="button" :aria-expanded="!!expandedProgress[item.id]" @click="expandedProgress[item.id] = !expandedProgress[item.id]">{{ expandedProgress[item.id] ? '收起进展' : '展开进展' }}</button>
        </div>
        <p v-if="item.status === 'running' && item.model_running && actionSeconds(item) >= 30" class="subtask-wait">等待模型返回 · {{ duration(sinceActivity(item)) }}前更新</p>
        <p v-if="item.error" class="subtask-error" role="alert">{{ item.error }}</p>
        <details class="subtask-details">
          <summary><span>查看详情</span><ChevronRight class="disclosure-chevron" :size="16" :stroke-width="1.8" aria-hidden="true" /></summary>
          <div class="subtask-detail-body">
            <section v-if="item.activity?.length" class="subtask-records">
              <h4>最近记录</h4>
              <ol class="subtask-history"><li v-for="entry in item.activity" :key="entry.id"><span>{{ entry.text }}</span><small v-if="entry.kind === 'tool'">{{ toolLabels[entry.status] || entry.status }}</small></li></ol>
            </section>
            <section v-if="(findings[item.id] || item.findings || []).length || item.result_handle" class="subtask-findings">
              <h4>分析发现</h4>
              <div class="subtask-findings-list">
                <p v-for="(finding, index) in findings[item.id] || item.findings || []" :key="index">{{ finding.text }}
                  <button v-for="(source, sourceIndex) in finding.sources" :key="source" type="button" :disabled="locating" @click="locate(source)">查看来源{{ finding.sources.length > 1 ? ` ${sourceIndex + 1}` : '' }}</button>
                </p>
              </div>
              <button v-if="item.result_handle && more[item.id] !== false" type="button" :disabled="loading" @click="details(item)">{{ findings[item.id] ? '更多发现' : '查看分析发现' }}</button>
            </section>
            <details v-if="item.objective" class="subtask-objective">
              <summary><ChevronRight class="disclosure-chevron" :size="16" :stroke-width="1.8" aria-hidden="true" />任务说明</summary>
              <p tabindex="0" aria-label="完整任务说明">{{ item.objective }}</p>
              <p v-if="item.original_goal">原始问题：{{ item.original_goal }}</p>
            </details>
            <p v-if="item.usage" class="subtask-usage">{{ item.usage.calls }} 次模型调用 · 输入 {{ item.usage.input_tokens }} / 输出 {{ item.usage.output_tokens }} Token<span v-if="item.usage.unknown"> · {{ item.usage.unknown }} 次用量未知</span></p>
            <p v-if="!item.activity?.length && !item.objective && !item.usage && !item.result_handle && !(findings[item.id] || item.findings || []).length" class="subtasks-empty">暂时没有详细记录。</p>
          </div>
        </details>
      </li>
    </ul>
    <button v-if="hasMore" type="button" :disabled="loading" @click="load(true)">更多子任务</button>
  </details>
</template>

<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { Check, ChevronRight, CircleAlert, Clock, Info, Pause, RotateCw } from '@lucide/vue'
import { useAiApi } from '~/composables/useAiApi'
const props = defineProps({ run: { type: Object, required: true }, now: Number })
const emit = defineEmits(['locate'])
const api = useAiApi(), items = ref([]), findings = ref({}), more = ref({}), expandedProgress = ref({})
const fetchedSummary = ref(null)
const summary = computed(() => fetchedSummary.value || props.run.subtasks)
const phaseLabel = computed(() => ({ partitioning: '读取并分片', analyzing: '并行分析', reducing: '汇总关联',
  planning: '主模型分析与规划', checking: '核查疑点', retrieving: '专题检索', interrupted: '分析已暂停', completed: summary.value.plan_version === 2 ? '分工已完成' : '分片分析完成' })[summary.value.phase] || '子任务分析')
const rangeLabel = range => {
  const format = seconds => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date((seconds + (props.run.timezone_offset || 0)) * 1000))
  return `${format(range.start)} 至 ${format(Math.max(range.start, range.end - 1))}`
}
const loading = ref(false), error = ref(''), hasMore = ref(false), opened = ref(['queued', 'running'].includes(props.run.status)), locating = ref(false)
const labels = { queued:'等待执行', running:'分析中', completed:'已完成', failed:'未完成', interrupted:'已暂停', cancelled:'已停止', superseded:'已更新范围' }
const statusIcons = { queued: Clock, completed: Check, failed: CircleAlert, interrupted: Pause, superseded: RotateCw }
// 只限制默认摘要的篇幅，原始进展始终可以展开查看。
const progressText = item => String(item.latest_progress?.text || '')
const objectivePreview = item => { const first = String(item.objective || '').split('\n')[0]; return first.length > 72 ? `${first.slice(0, 72)}…` : first }
const isLongProgress = item => progressText(item).length > 72 || progressText(item).split('\n').length > 3
const progressPreview = item => expandedProgress.value[item.id] || !isLongProgress(item) ? progressText(item) : `${progressText(item).replace(/\s+/g, ' ').slice(0, 72)}…`
const toolLabels = { running:'进行中', completed:'已完成', failed:'未成功', paused:'已暂停' }
let generation = 0, disposed = false, timer, refreshTimer
const scheduleRefresh = () => {
  clearTimeout(refreshTimer)
  if (!disposed && opened.value && ['queued', 'running'].includes(props.run.status)) {
    refreshTimer = setTimeout(() => load(), 3000)
  }
}
const identity = () => `${props.run.account}:${props.run.id}:${props.run.version}`
const duration = value => { const seconds = Math.max(0, Math.round(value)); return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒` }
const actionSeconds = item => Math.max(0, (props.now || Date.now()) / 1000 - (item.action_started_at || (props.now || Date.now()) / 1000))
const sinceActivity = item => Math.max(0, (props.now || Date.now()) / 1000 - (item.last_activity_at || item.started_at || (props.now || Date.now()) / 1000))
const elapsed = item => duration(item.elapsed_seconds ?? ((item.finished_at || (props.now || Date.now()) / 1000) - (item.started_at || (props.now || Date.now()) / 1000)))
const load = async (append = false) => {
  if (loading.value) return
  const key = identity(), revision = ++generation, startedStatus = props.run.status
  loading.value = true; error.value = ''
  try {
    const value = await api.request(`/agent/runs/${props.run.id}/subtasks`, { query: { account:props.run.account, version:props.run.version, offset:append ? items.value.length : 0, limit:20 } })
    if (disposed || identity() !== key || revision !== generation) return
    items.value = append ? [...items.value, ...value.items] : value.items
    if (value.summary) fetchedSummary.value = value.summary
    hasMore.value = value.has_more
  } catch (e) { if (!disposed && identity() === key) error.value = `子任务加载失败：${e.message}` }
  finally { if (revision === generation) { loading.value = false; if (opened.value && startedStatus !== props.run.status) void load(); else scheduleRefresh() } }
}
const details = async item => {
  const key = identity()
  try {
    const result = await api.request(`/agent/runs/${props.run.id}/subtasks/${item.id}`, {query:{account:props.run.account,version:props.run.version,offset:findings.value[item.id]?.length || 0}})
    if (!disposed && identity() === key) { findings.value[item.id] = [...(findings.value[item.id] || []), ...result.items]; more.value[item.id] = result.has_more }
  } catch(e) { if (!disposed && identity() === key) error.value = e.message }
}
const locate = async source => {
  const key = identity(); locating.value = true
  try {
    const result = await api.request(`/agent/runs/${props.run.id}/materials/${source}`, {query:{account:props.run.account,version:props.run.version}})
    if (!disposed && identity() === key) emit('locate', result)
  } catch(e) { if (!disposed && identity() === key) error.value = e.message }
  finally { if (identity() === key) locating.value = false }
}
const toggle = event => { if (event.target !== event.currentTarget) return; const changed = opened.value !== event.target.open; opened.value = event.target.open; clearTimeout(refreshTimer); if (opened.value) { if (changed) void load(); else scheduleRefresh() } }
watch(identity, () => { ++generation; loading.value = false; fetchedSummary.value = null; items.value = []; expandedProgress.value = {}; findings.value = {}; more.value = {}; error.value = ''; if (opened.value) void load() }, { immediate: true })
watch(() => JSON.stringify(props.run.subtasks), () => { fetchedSummary.value = null; clearTimeout(timer); if (opened.value) timer = setTimeout(() => load(), 250) })
watch(() => props.run.status, status => { clearTimeout(refreshTimer); if (opened.value && !['queued', 'running'].includes(status)) void load(); else scheduleRefresh() })
onUnmounted(() => { disposed = true; ++generation; clearTimeout(timer); clearTimeout(refreshTimer) })
</script>

<style scoped>
.agent-subtasks { --subtask-accent: color-mix(in srgb, var(--app-accent, #07c160) 55%, var(--app-text-primary, #191919)); --subtask-danger: color-mix(in srgb, #fa5151 65%, var(--app-text-primary, #191919)); margin-block: 16px; color: var(--app-text-primary, #191919); font-size: 13px; line-height: 1.6; }
summary { display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; overflow-wrap: anywhere; }
summary::-webkit-details-marker { display: none; }
.disclosure-chevron { flex: 0 0 auto; font-size: 10px; transition: transform 150ms ease-out; }
details[open] > summary > .disclosure-chevron { transform: rotate(90deg); }
.subtasks-summary { min-height: 36px; flex-wrap: wrap; color: var(--app-text-secondary, #666); }
.subtasks-title { color: var(--app-text-primary, #191919); font-weight: 500; }
.subtasks-total { margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; }
.subtasks-failed { font-size: 12px; color: var(--subtask-danger); }
.subtasks-count, .subtasks-scan, .subtask-range { font-size: 12px; color: var(--app-text-secondary, #666); }
.subtasks-scan { margin-block: 6px; }
.subtask-range, .subtask-goal { margin-top: 8px; }
.subtask-goal { line-height: 1.7; }
.subtasks-list { list-style: none; padding: 0; margin: 6px 0 0; display: grid; gap: 10px; }
.subtask-item { min-width: 0; padding: 14px 0 0; border: 0; border-top: 1px solid var(--app-border, #e7e7e7); border-radius: 0; overflow: hidden; }
.subtask-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.subtask-heading strong { flex: 1 1 100%; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.subtask-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--app-text-secondary, #666); }
.subtask-status.is-running, .subtask-status.is-completed { color: var(--subtask-accent); }
.subtask-status.is-failed { color: var(--subtask-danger); }
.subtask-elapsed { margin-left: auto; font-size: 12px; color: var(--app-text-secondary, #666); font-variant-numeric: tabular-nums; }
p { margin: 0; overflow-wrap: anywhere; }
.subtask-action { margin-top: 12px; font-weight: 500; }
.subtask-counts { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 6px; color: var(--app-text-secondary, #666); font-size: 12px; }
.subtask-counts b { font-weight: 600; color: var(--app-text-primary, #191919); font-variant-numeric: tabular-nums; }
.subtask-coverage-complete { flex-basis: 100%; }
.subtask-update { margin-top: 12px; }
.subtask-progress { line-height: 1.75; white-space: pre-wrap; }
.subtask-progress.is-expanded { max-height: 240px; overflow-y: auto; }
.subtask-wait { margin-top: 8px; font-size: 12px; color: var(--app-text-secondary, #666); }
.subtask-details { margin-top: 14px; border-top: 1px solid var(--app-border, #e7e7e7); }
.subtask-details > summary { justify-content: space-between; min-height: 40px; color: var(--app-text-secondary, #666); font-size: 12px; }
.subtask-detail-body { padding: 4px 0 14px; }
h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
.subtask-history { max-height: 220px; overflow-y: auto; list-style: none; padding: 0; margin: 0; }
.subtask-history li { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; overflow-wrap: anywhere; }
.subtask-history li > span { min-width: 0; flex: 1; }
.subtask-history small { flex-shrink: 0; color: var(--app-text-secondary, #666); font-size: 11px; }
.subtask-findings { margin-block: 16px; }
.subtask-findings-list { max-height: 280px; overflow-y: auto; }
.subtask-findings p + p { margin-top: 12px; }
.subtask-objective { margin-top: 12px; }
.subtask-objective > summary { min-height: 32px; color: var(--app-text-secondary, #666); font-size: 12px; }
.subtask-objective p { max-height: 200px; overflow-y: auto; margin-top: 8px; padding: 12px 0; background: var(--app-surface-soft, #f7f7f7); border-radius: 6px; white-space: pre-wrap; font-size: 12px; }
.subtask-usage { margin-top: 12px; color: var(--app-text-secondary, #666); font-size: 11px; }
.subtasks-empty { padding-block: 12px; color: var(--app-text-secondary, #666); }
.subtask-error { margin-block: 10px; color: var(--subtask-danger); }
button { min-height: 32px; cursor: pointer; color: var(--app-text-primary, #191919); text-decoration: underline; text-underline-offset: 3px; margin-inline-end: 10px; }
button:hover, summary:hover { color: var(--subtask-accent); }
button:disabled { opacity: .5; cursor: wait; }
button:focus-visible, summary:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--app-accent, #16854b); outline-offset: 2px; border-radius: 3px; }
.subtask-progress, .subtask-history, .subtask-findings-list, .subtask-objective p { scrollbar-width: thin; scrollbar-color: var(--app-border, #ddd) transparent; overscroll-behavior: contain; }
@media (prefers-reduced-motion: reduce) { .disclosure-chevron { transition: none; } .agent-icon-spin { animation: none; } }
</style>
