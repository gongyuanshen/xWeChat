<template>
  <component :is="expandable ? 'details' : 'div'" class="agent-tool" :class="[`is-${status}`, { 'is-grouped': grouped }]" :open="expandable ? expanded : undefined" @toggle="expanded = $event.target.open">
    <component :is="expandable ? 'summary' : 'div'" class="agent-tool-heading">
      <component v-if="status !== 'running'" :is="icon" :size="16" :stroke-width="1.8" aria-hidden="true" />
      <span class="agent-tool-title"><span class="agent-tool-label" :class="{ 'agent-shimmer': status === 'running' }">{{ label }}</span><small v-if="first.query" class="agent-tool-query" :title="first.query">{{ first.query }}</small><small v-if="grouped" class="agent-tool-count">{{ items.length }} 次</small></span>
      <span v-if="status !== 'completed'" class="agent-tool-outcome">{{ groupOutcome }}</span>
      <span v-else class="agent-tool-summary">{{ summary }}</span>
      <ChevronRight v-if="expandable" class="agent-tool-chevron" :size="16" :stroke-width="1.8" aria-hidden="true" />
    </component>
    <div v-if="expandable" class="agent-tool-detail" :class="{ 'agent-tool-timeline': grouped }">
      <section v-for="(item, index) in items" :key="item.id" class="agent-tool-attempt">
        <component :is="grouped && hasInspectionDetails(item) ? 'details' : 'div'" class="agent-tool-inspection" :open="grouped && hasInspectionDetails(item) ? inspectionOpen(item.id) : undefined" @toggle.stop="setInspectionOpen(item.id, $event.target.open)">
        <component v-if="grouped" :is="hasInspectionDetails(item) ? 'summary' : 'div'" class="agent-tool-attempt-row" :title="hasInspectionDetails(item) ? (item.action === 'commit_findings' ? '展开本次保存详情' : '展开本次操作详情') : undefined" :aria-controls="hasInspectionDetails(item) ? `tool-inspection-${item.id}` : undefined">
          <strong>{{ item.action === 'commit_findings' ? (index === 0 ? '首次保存' : `第 ${index + 1} 次保存`) : item.action === 'compact_context' ? `第 ${index + 1} 次整理` : item.cached ? '复用已读结果' : index === 0 ? '首次读取' : `第 ${index + 1} 次读取` }}</strong>
          <span>{{ item.status !== 'completed' ? outcome(item.status) : item.cached ? '无需重复读取' : callSummary(item) }}</span>
          <ChevronRight v-if="hasInspectionDetails(item)" class="agent-attempt-chevron" :size="16" :stroke-width="1.8" aria-hidden="true" />
        </component>
        <div v-if="hasInspectionDetails(item)" :id="`tool-inspection-${item.id}`" class="agent-tool-inspection-panel" :class="`is-${item.status}`">
          <header><strong>{{ toolLabel(item.action) }}</strong></header>
        <div class="agent-tool-request">
        <p v-if="item.username">会话：{{ nameFor(item.username) || item.username }}</p>
        <p v-if="item.query">搜索：{{ item.query }}</p>
        <p v-if="item.start != null || item.end != null">范围：{{ date(item.start) }} — {{ date(item.end) }}</p>
        <p v-if="item.offset != null">分页位置：{{ item.offset }}</p>
        </div>
        <div class="agent-tool-response">
        <p v-if="item.detail && item.status === 'running'">{{ item.detail }}</p>
        <p v-if="item.action === 'compact_context' && item.result?.saved">笔记已保存 · 上下文 {{ item.result.before }} → {{ item.result.after }} 预算单位 · {{ item.result.covered_fragments }} 个原文片段</p>
        <p v-else-if="item.action === 'commit_findings' && item.status === 'completed'">{{ saveSummary(item) }}</p>
        <p v-else-if="returned(item) !== null">{{ item.cached ? '复用已读结果 · ' : '' }}{{ item.result.returned }} 条结果{{ item.result.has_more ? ' · 还有更多' : '' }}</p>
        <p v-if="item.result?.error" class="agent-tool-error">{{ item.result.error }}</p>
        <p v-if="item.action === 'search_messages' && (item.status !== 'failed' || item.result?.retrieval_mode || item.result?.data_source)" class="agent-retrieval-label">{{ retrievalLabel(item) }}</p>
        <p v-if="item.result?.match_counts">本页关键词命中 {{ item.result.match_counts.keyword }} 条 · 语义命中 {{ item.result.match_counts.semantic }} 条（同一消息可同时命中）</p>
        <p v-if="item.result?.realtime_coverage">实时回查：本机已检查 {{ item.result.realtime_coverage.scanned }} 条，匹配 {{ item.result.realtime_coverage.matched }} 条；已查 {{ item.result.realtime_coverage.conversations_completed }} / {{ item.result.realtime_coverage.conversations }} 个会话。{{ item.result.realtime_coverage.recent_gap_complete ? '本次实时缺口已查完，不代表全部历史完整覆盖。' : '仍有实时消息待查。' }}</p>
        <p v-if="item.result?.warning" class="agent-coverage">{{ item.result.warning }}</p>
        <p v-if="item.result?.note && item.result.note !== item.result.error">{{ item.result.note }}</p>
        <p v-if="['failed','paused','superseded'].includes(item.status)">{{ recovered.has(item.id) ? '本次保存失败，后续已重试并保存成功。' : item.status === 'failed' ? '这一步未完成，已读取资料会保留。' : item.status === 'superseded' ? '已根据补充要求调整。' : '这一步已暂停。' }}</p>
        </div>
        <footer class="agent-tool-inspection-status">
          <span>{{ duration(elapsed(item)) }}</span>
          <span :class="{ 'agent-shimmer': item.status === 'running' }">
            <Check v-if="item.status === 'completed'" :size="16" :stroke-width="1.8" aria-hidden="true" />
            <CircleAlert v-else-if="item.status === 'failed'" :size="16" :stroke-width="1.8" aria-hidden="true" />
            <CirclePause v-else-if="item.status !== 'running'" :size="16" :stroke-width="1.8" aria-hidden="true" />
            {{ outcome(item.status) || '状态未知' }}
          </span>
        </footer>
        </div>
        </component>
      </section>
    </div>
  </component>
</template>

<script setup>
import { computed, ref } from 'vue'
import { Check, ChevronRight, CircleAlert, CirclePause, FileText, Images, Search } from '@lucide/vue'
const props = defineProps({ items: { type: Array, required: true }, now: Number, nameFor: { type: Function, default: () => '' }, viewState: Object })
const first = computed(() => props.items[0])
const grouped = computed(() => props.items.length > 1)
// 过程面板展开时先显示操作摘要，逐次读取明细由用户按需展开。
const localExpanded = ref(false)
const expanded = computed({get:()=>props.viewState?.[`tool:${first.value.id}`] ?? localExpanded.value,set:value=>{if(props.viewState) props.viewState[`tool:${first.value.id}`]=value; else localExpanded.value=value}})
// 每个读取节点独立展开，刷新进度与收起外层时保留用户的阅读位置。
const localInspections = ref({})
const inspectionOpen = id => !!(props.viewState || localInspections.value)[`tool-detail:${id}`]
const setInspectionOpen = (id, value) => { (props.viewState || localInspections.value)[`tool-detail:${id}`] = value }
// 只有同一范围、页面和输入版本的后续明确保存成功，才能解除历史失败提示。
// 旧记录缺少标识时保留原状态，不能根据相邻顺序猜测已恢复。
const pageKey = item => item.action === 'commit_findings' && item.scope_handle && item.page_id && item.input_version != null
  ? JSON.stringify([item.input_version, item.scope_handle, item.page_id]) : null
const saved = item => item.action === 'commit_findings' && item.status === 'completed' && item.result?.saved === true
const recovered = computed(() => {
  const successfulPages = new Set(), failures = new Set()
  for (const item of [...props.items].reverse()) {
    const key = pageKey(item)
    if (!key) continue
    if (saved(item)) successfulPages.add(key)
    else if (item.status === 'failed' && successfulPages.has(key)) failures.add(item.id)
  }
  return failures
})
const effectiveItems = computed(() => props.items.filter(item => !recovered.value.has(item.id)))
// 未恢复的失败、运行或暂停仍显露，不能被另一页的成功掩盖。
const status = computed(() => ['running', 'failed', 'paused', 'cancelled', 'interrupted', 'superseded'].find(status => effectiveItems.value.some(item => item.status === status)) || effectiveItems.value[0]?.status)
const icon = computed(() => status.value === 'failed' ? CircleAlert : status.value !== 'completed' ? CirclePause : first.value.action?.includes('search') ? Search : first.value.action === 'analyze_media' ? Images : FileText)
const toolLabel = action => ({ compact_context: '整理上下文', select_chat_scope: '确定查询范围', commit_findings: '保存分析发现', search_messages: '搜索聊天记录', read_messages: '读取聊天记录', read_context: '读取消息上下文', analyze_media: '分析媒体', find_conversations: '查找会话', search_material: '搜索附件内容', read_material: '读取附件', read_results: '读取分析结果' }[action] || '工具调用')
const label = computed(() => first.value.action === 'compact_context' ? '整理上下文' : ['search_messages', 'read_context'].includes(first.value.action) ? toolLabel(first.value.action) : (first.value.text || toolLabel(first.value.action)).replace(/^(核对|读取)了/, '$1'))
const outcome = status => ({ completed: '已完成', running: '进行中', failed: '失败', paused: '已暂停', cancelled: '已停止', interrupted: '已中断', superseded: '已调整' }[status] || '')
const groupOutcome = computed(() => status.value !== 'running' && grouped.value && props.items.some(item => item.status === 'completed') && props.items.some(item => item.status !== 'completed') ? '部分完成' : outcome(status.value))
const duration = value => { const n = Math.max(0, Math.floor(value || 0)); return n >= 60 ? `${Math.floor(n / 60)}分${n % 60}秒` : `${n}秒` }
const elapsed = item => item.started_at == null ? 0 : Math.max(0, (item.finished_at ?? props.now / 1000) - item.started_at)
const returned = item => Number.isFinite(item.result?.returned) ? item.result.returned : null
// 条数、耗时、状态和“还有更多”已属于摘要，不单独构成可展开的详情。
const hasInspectionDetails = item => Boolean(
  item.username || (grouped.value && item.query) || item.start != null || item.end != null || item.offset != null
  || (item.status === 'running' && item.detail)
  || (item.action === 'compact_context' && item.result?.saved)
  || item.result?.error || item.result?.warning || item.result?.note
  || item.result?.match_counts || item.result?.realtime_coverage
  || (item.action === 'search_messages' && (item.result?.retrieval_mode || item.result?.data_source))
  || (!grouped.value && item.action?.includes('search') && returned(item) !== null)
  || ['failed', 'paused', 'superseded'].includes(item.status)
)
const expandable = computed(() => grouped.value || hasInspectionDetails(first.value))
const saveSummary = item => saved(item)
  ? (Number.isFinite(item.result.findings) ? `已保存 ${item.result.findings} 条发现` : '已保存')
  : item.result?.requires_commit === false ? '无需保存' : '未确认保存'
const callSummary = item => [item.action === 'commit_findings' ? saveSummary(item) : returned(item) == null ? '' : `${returned(item)} 条`, duration(elapsed(item))].filter(Boolean).join(' · ')
const summary = computed(() => {
  if (first.value.action === 'commit_findings') {
    if (recovered.value.size) return `已保存 · 重试 ${recovered.value.size} 次`
    if (!grouped.value) return saveSummary(first.value)
    // 重复提交只计一次；没有页标识或数量时不推测保存总数。
    const pages = new Map(props.items.map(item => [pageKey(item), item]))
    const counts = [...pages.values()]
    if (!pages.has(null) && counts.every(item => saved(item) && Number.isFinite(item.result.findings))) {
      return `已保存 ${counts.reduce((sum, item) => sum + item.result.findings, 0)} 条发现`
    }
    return props.items.every(saved) ? '已保存' : '调用完成'
  }
  if (!grouped.value) return first.value.cached ? '复用已读结果' : first.value.action?.includes('search') ? duration(elapsed(first.value)) : callSummary(first.value)
  // 缓存命中不计作新读取，避免将 21 条已读消息重复显示成 42 条。
  const fresh = props.items.filter(item => !item.cached && returned(item) != null)
  const reused = props.items.filter(item => item.cached).length
  return [fresh.length ? `${fresh.reduce((sum, item) => sum + returned(item), 0)} 条消息` : '', reused ? `含 ${reused} 次复用` : ''].filter(Boolean).join(' · ')
})
const date = value => value != null ? new Date(value * 1000).toLocaleString() : '不限'
const retrievalLabel = item => item.result?.data_source === 'realtime_keyword' ? '实时关键词回查 · 无关原文仅在本机过滤' : item.result?.retrieval_mode === 'hybrid' ? '智能检索：关键词＋语义（按意思查找）' : item.result?.retrieval_mode === 'keyword' ? '已退回关键词检索 · 展开查看原因' : item.status === 'running' ? '正在确认检索方式' : '此步骤未记录实际检索方式'
</script>
