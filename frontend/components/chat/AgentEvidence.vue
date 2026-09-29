<template>
  <section class="agent-evidence-panel" aria-label="回答依据">
    <strong>回答依据</strong>
    <p>已找到 {{ run.source_count ?? sources.length }} 条消息<span v-if="context"> · 本次回答请求包含 {{ context.sources?.length || 0 }} 条原文</span> · 回答标注引用 {{ cited.size }} 条</p>
    <p v-if="context?.summary_segments">本次回答使用了 {{ context.summary_segments }} 个分段的汇总，其他原文和分段发现可在详细结果中检索。</p>
    <p v-if="context?.status === 'prepared'" class="agent-evidence-hint">来源已组装，回答调用尚未完成。</p>
    <p v-else-if="!context" class="agent-evidence-hint">{{ run.answer ? '此轮未记录回答请求的来源明细，无法确认哪些原文传入了模型。' : '尚未生成回答请求。' }}</p>
    <p v-if="context?.omitted" class="agent-evidence-hint">{{ context.omitted }} 条已读消息因上下文长度限制，未放入本次回答请求的原文资料。</p>
    <details v-if="sources.length" class="agent-evidence">
      <summary>查看来源与引用情况</summary>
      <p>标记表示检索和请求记录，不代表模型一定采纳了内容。历史对话或摘要可能另含相关信息。</p>
      <article v-for="source in sources.slice(0, visible)" :key="source.source">
        <small>{{ source.name || source.username }} · {{ new Date(source.time * 1000).toLocaleString() }}</small>
        <div class="agent-source-tags">
          <span>{{ method(source) }}</span>
          <span>{{ inputLabel(source) }}</span>
          <span v-if="cited.has(source.source)">回答已引用</span>
          <span v-else>回答未标注引用</span>
        </div>
        <p>{{ source.text }}</p>
        <button type="button" @click="$emit('locate', source)">查看原消息</button>
      </article>
      <button v-if="visible < sources.length" type="button" @click="visible += 20">再显示 20 条（剩余 {{ sources.length - visible }} 条）</button>
    </details>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
const props = defineProps({ run: { type: Object, required: true } })
defineEmits(['locate'])
const visible = ref(20)
watch(() => props.run.id, () => { visible.value = 20 })
const sources = computed(() => props.run.citations || [])
const context = computed(() => props.run.answer_context)
const included = computed(() => new Map((context.value?.sources || []).map(s => [s.source, s])))
const cited = computed(() => new Set([...String(props.run.answer || '').matchAll(/\[\[([a-f0-9]{24})\]\]/g)].map(m => m[1]).filter(id => sources.value.some(s => s.source === id))))
const method = source => {
  const methods = source.match_methods || []
  if (methods.includes('semantic')) return methods.includes('keyword') ? '关键词＋语义命中' : '语义相关（按意思找到）'
  return methods.includes('keyword') ? '关键词命中' : '直接读取／未记录检索方式'
}
const inputLabel = source => {
  if (!context.value) return '本次请求来源未记录'
  const item = included.value.get(source.source)
  if (!item) return context.value.summary_sources?.includes(source.source) ? '经分段摘要提供' : '未放入本次请求原文资料'
  return `已放入本次请求${item.truncated ? `（截取前 ${item.text_chars} 字符）` : ''}`
}
</script>
