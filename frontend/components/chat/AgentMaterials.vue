<template>
  <section class="agent-materials" aria-label="任务资料与详细结果">
    <header><strong>资料与详细结果</strong><button type="button" aria-label="关闭详细结果" @click="$emit('close')"><X :size="16" :stroke-width="1.8" aria-hidden="true" /></button></header>
    <nav aria-label="结果类型">
      <button v-for="option in kinds" :key="option.value" type="button" :aria-pressed="kind === option.value" @click="kind = option.value; offset = 0; load()">{{ option.label }}</button>
    </nav>
    <label v-if="kind === 'statistics'">统计维度 <select v-model="statisticKind" aria-label="统计维度" @change="offset = 0; load()"><option value="daily_sender">每天各会话发言人</option><option value="daily">每天消息总数</option><option value="sender">发言人排行</option></select></label>
    <form v-if="kind !== 'statistics'" @submit.prevent="offset = 0; load()"><input v-model="query" type="search" maxlength="500" aria-label="搜索任务资料" placeholder="搜索已读原文或分段发现" /><button type="submit">搜索</button></form>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取…</p>
    <template v-else>
      <p v-if="kind === 'statistics'">已读取 {{ page.total_messages || 0 }} 条消息的精确计数{{ run.analysis?.complete ? '' : '（范围尚未读完）' }}</p>
      <p v-else-if="page.total != null">共 {{ page.total }} 条{{ kind === 'findings' ? '分析结果' : '来源' }}</p>
      <p v-if="!items.length">当前没有结果。</p>
      <article v-for="(item, index) in items" :key="item.id || item.source || index">
        <template v-if="kind === 'sources'"><small>{{ item.name || item.username }} · {{ date(item.time) }} · {{ item.sender }}</small><p>{{ item.text }}</p><button type="button" @click="$emit('locate', item)">查看原消息</button></template>
        <template v-else-if="kind === 'findings'"><p v-if="item.needs_check" class="agent-coverage">需要核对前后文</p><AgentAnswer :text="findingText(item)" :citations="item.citations || []" :references="item.references || []" @locate="$emit('locate', $event)" /></template>
        <template v-else><p>{{ statisticKind === 'daily' ? item.day : statisticKind === 'sender' ? `${offset + index + 1}. ${item.sender || item.sender_id || '未知发言人'}` : `${item.day} · ${nameFor(item.username)} · ${item.sender || item.sender_id || '未知发言人'}` }}</p><strong>{{ item.count }} 条消息</strong></template>
      </article>
    </template>
    <footer><button type="button" :disabled="loading || offset === 0" @click="offset = Math.max(0, offset - 20); load()">上一页</button><span>第 {{ Math.floor(offset / 20) + 1 }} 页</span><button type="button" :disabled="loading || !hasMore" @click="offset += 20; load()">下一页</button></footer>
  </section>
</template>

<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { X } from '@lucide/vue'
import AgentAnswer from './AgentAnswer.vue'
const props = defineProps({ run: { type: Object, required: true }, nameFor: { type: Function, default: value => value } })
defineEmits(['locate', 'close'])
const api = useAiApi()
const kinds = [{ value: 'sources', label: '已读原文' }, { value: 'findings', label: '分段发现' }, { value: 'statistics', label: '消息统计' }]
const kind = ref(props.run.intent?.mode === 'statistics' ? 'statistics' : 'findings'), query = ref(''), offset = ref(0), page = ref({ items: [] }), loading = ref(false), error = ref('')
const statisticKind = ref('daily_sender')
const items = computed(() => (kind.value === 'statistics' && statisticKind.value === 'daily' ? page.value.daily_totals : kind.value === 'statistics' && statisticKind.value === 'sender' ? page.value.sender_ranking : page.value.items) || [])
const hasMore = computed(() => kind.value === 'statistics' && statisticKind.value === 'daily' ? page.value.daily_has_more : kind.value === 'statistics' && statisticKind.value === 'sender' ? page.value.sender_has_more : page.value.has_more)
let revision = 0
const load = async () => {
  const current = ++revision, id = props.run.id, account = props.run.account
  loading.value = true; error.value = ''; page.value = { items: [] }
  try {
    const result = await api.request(`/agent/runs/${id}/materials`, { query: { account, version: props.run.version, kind: kind.value, offset: offset.value, limit: 20, query: query.value } })
    if (current === revision && account === props.run.account && id === props.run.id) page.value = result
    else api.diagnostic?.('response.stale', { run_id: id, component: 'agent' })
  } catch (e) { if (current === revision) error.value = e.message }
  finally { if (current === revision) loading.value = false }
}
watch(() => `${props.run.account}:${props.run.id}:${props.run.version}`, () => { offset.value = 0; query.value = ''; void load() }, { immediate: true })
onUnmounted(() => { revision++ })
const date = value => new Date(value * 1000).toLocaleString()
const findingText = item => `${item.text}\n${(item.sources || []).map(id => `[[${id}]]`).join(' ')}`
</script>

<style scoped>
.agent-materials { margin:12px 0; border:1px solid var(--app-border,#e7e9ed); border-radius:10px; padding:12px; min-width:0; }
header,nav,form,footer { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
header strong,form input { flex:1; min-width:0; } button,input { border:1px solid var(--app-border,#e7e9ed); border-radius:6px; padding:6px 10px; color:inherit; background:transparent; }
button[aria-pressed=true] { color:#079b57; background:#079b5710; } button:disabled { opacity:.45; } article { padding:12px 0; border-top:1px solid var(--app-border,#e7e9ed); overflow-wrap:anywhere; } p { white-space:pre-wrap; margin:6px 0; } small { color:var(--app-text-secondary,#79828e); } footer { justify-content:space-between; margin-top:12px; }
</style>
