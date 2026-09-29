<template>
  <section class="agent-compaction" :aria-label="label">
    <div v-if="active" class="compaction-progress" role="status" aria-live="polite">
      <div class="compaction-divider"><span><FileText :size="16" :stroke-width="1.8" aria-hidden="true" />{{ label }}</span></div>
      <p>{{ beforeUsage ? `当前已用 ${beforeUsage} · ` : '' }}{{ job.reason === 'context-overflow' ? '请求超出容量，正在整理较早对话' : '正在整理较早对话' }}</p>
      <p>原文已保留，完成后自动继续</p>
      <Ellipsis class="compaction-pulse" :size="16" :stroke-width="1.8" aria-hidden="true" />
    </div>
    <template v-else>
      <button type="button" class="compaction-divider" :aria-expanded="expanded" :aria-controls="detailId" @click="expanded = !expanded"><span><FileText :size="16" :stroke-width="1.8" aria-hidden="true" />{{ label }}</span></button>
      <div v-if="expanded" :id="detailId" class="compaction-details" role="region" :aria-label="label + '详情'">
        <p v-if="job.status !== 'completed'">本次压缩未完成，原上下文已保留。</p>
        <template v-else>
          <p v-if="usage" class="compaction-usage">上下文用量 {{ usage }}</p>
          <p v-if="loading" role="status">正在读取摘要…</p>
          <p v-else-if="error" role="alert">{{ error }} <button type="button" @click="load">重试</button></p>
          <template v-else-if="result?.summary"><p class="compaction-summary-label">压缩摘要</p><div class="compaction-summary">{{ result.summary }}</div></template>
          <p v-else>此条历史记录未保存可查看的摘要。</p>
        </template>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { Ellipsis, FileText } from '@lucide/vue'
const props = defineProps({ item: { type: Object, required: true }, run: { type: Object, required: true }, viewState: { type: Object, required: true } })
const api = useAiApi()
const job = computed(() => props.item.context_job)
const version = computed(() => props.item.input_version ?? props.run.version)
const key = computed(() => `${props.run.account}:${props.run.id}:${version.value}:compaction:${job.value.id}`)
const detailId = computed(() => `compaction-${props.run.id}-${version.value}-${job.value.id}`)
const active = computed(() => job.value.status === 'running' && ['running', 'queued'].includes(props.run.status) && version.value === props.run.version)
const label = computed(() => active.value ? '正在压缩上下文' : job.value.status === 'completed' ? '上下文已压缩' : job.value.status === 'failed' ? '上下文压缩失败' : '上下文压缩已中断')
const expanded = computed({ get: () => !!props.viewState[key.value], set: value => { props.viewState[key.value] = value } })
const result = ref(null), loading = ref(false), error = ref('')
const percent = (value, window) => Number.isFinite(value) && window > 0 ? `${(value / window * 100).toFixed(1)}%` : ''
const beforeUsage = computed(() => percent(job.value.before, job.value.model_window))
const usage = computed(() => {
  const data = result.value || job.value
  if (!Number.isFinite(data.before) || !Number.isFinite(data.after)) return ''
  // 百分比沿用本次压缩时保存的窗口；旧记录不借用当前模型的容量。
  return data.model_window > 0 ? `${percent(data.before, data.model_window)} → ${percent(data.after, data.model_window)}` : `${data.before.toLocaleString()} → ${data.after.toLocaleString()} Token`
})
let revision = 0
const load = async () => {
  const current = ++revision, identity = key.value
  loading.value = true; error.value = ''
  try {
    const data = await api.request(`/agent/runs/${encodeURIComponent(props.run.id)}/context-compactions/${encodeURIComponent(job.value.id)}`, { query: { account: props.run.account, version: version.value } })
    if (current === revision && identity === key.value) result.value = data
  } catch (e) { if (current === revision && identity === key.value) error.value = e.message || '摘要读取失败，请重试。' }
  finally { if (current === revision && identity === key.value) loading.value = false }
}
watch(key, () => { revision++; result.value = null; loading.value = false; error.value = '' })
watch([key, expanded, () => job.value.status], () => {
  if (expanded.value && job.value.status === 'completed' && !result.value && !loading.value) void load()
}, { immediate: true })
onUnmounted(() => { revision++ })
</script>

<style scoped>
.agent-compaction { margin:24px 0; min-width:0; color:var(--app-text-secondary,#737373); font-size:14px; line-height:1.7; }
/* 压缩状态和详情与其他步骤保持左对齐。 */
.agent-process .agent-compaction { position:relative; margin:0; width:100%; padding:24px 0; background:var(--ag-bg,#fff); }
.compaction-divider { display:flex; width:100%; align-items:center; gap:14px; padding:6px 0; border:0; background:transparent; color:inherit; font:inherit; }
.compaction-divider::after { content:''; flex:1; min-width:12px; border-top:1px solid var(--app-border,#e7e9ed); }
.compaction-divider span { display:inline-flex; align-items:center; gap:8px; white-space:nowrap; }
button.compaction-divider { cursor:pointer; min-height:36px; }
button.compaction-divider:hover { color:var(--app-text-primary,#333); }
button:focus-visible { outline:2px solid var(--app-text-secondary,#737373); outline-offset:3px; border-radius:3px; }
.compaction-progress { text-align:left; }
.compaction-progress p { margin:3px 0 0; font-size:12px; }
.compaction-divider :is(i,svg) { font-size:15px; }
.compaction-pulse { margin-top:9px; font-size:14px; animation:compaction-breathe 1.6s ease-in-out infinite; }
.compaction-details { padding:12px 0; margin-top:6px; border:0; border-top:1px solid var(--app-border,#e7e9ed); border-radius:0; overflow-wrap:anywhere; font-size:12px; }
.compaction-details p { margin:0 0 8px; }
.compaction-details p:last-child { margin-bottom:0; }
.compaction-usage { font-variant-numeric:tabular-nums; }
.compaction-summary-label { padding-top:6px; }
.compaction-summary { white-space:pre-wrap; color:var(--app-text-primary,#333); max-height:320px; overflow:auto; }
.compaction-details button { color:inherit; text-decoration:underline; cursor:pointer; }
@keyframes compaction-breathe { 0%,100% { opacity:.35; } 50% { opacity:1; } }
@media(prefers-reduced-motion:reduce) { .compaction-pulse { animation:none; } }
</style>
