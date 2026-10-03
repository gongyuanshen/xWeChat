<script setup>
import { computed, ref, watch } from 'vue'
const props = defineProps({ message: { type: Object, required: true }, labels: { type: Object, required: true } })
const identity = computed(() => {
  const server = props.message.serverIdStr
  if (server && server !== '0') return `s:${server}`
  const anchor = String(props.message.id)
  return anchor.split(':').length === 3 ? `l:${anchor}:${props.message.createTime}` : anchor
})
const candidate = computed(() => props.labels[identity.value])
const verified = ref(null), error = ref('')
let generation = 0
watch([() => props.message.content, () => props.message.renderType, identity, candidate], async () => {
  const ticket = ++generation, label = candidate.value, text = props.message.content
  verified.value = null; error.value = ''
  if (!['text', 'quote'].includes(props.message.renderType) || !label || label.text !== text) return
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    if (ticket !== generation) return
    const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
    if (fingerprint === label.fingerprint) verified.value = label
  } catch (err) { if (ticket === generation) error.value = `消息标签指纹校验失败：${err.message}` }
}, { immediate: true, flush: 'sync' })
</script>
<template>
  <details v-if="verified" class="message-insight-label" :title="verified.reason">
    <summary :aria-label="`情绪 ${verified.emotion === null ? '证据不足' : verified.emotion}，意图 ${verified.intent === null ? '证据不足' : verified.intent}；查看分析依据`">
      <span class="insight-pair"><span class="insight-key">情绪</span><span class="insight-value">{{ verified.emotion === null ? '证据不足' : verified.emotion }}</span></span>
      <span class="insight-pair"><span class="insight-key">意图</span><span class="insight-value">{{ verified.intent === null ? '证据不足' : verified.intent }}</span></span>
    </summary>
    <p>{{ verified.reason }}</p>
  </details>
  <small v-else-if="error" role="alert">{{ error }}</small>
</template>
<style scoped>
.message-insight-label { margin-top: 5px; max-width: 100%; color: var(--app-text-secondary, #75877c); font-size: 11px; line-height: 1.5; }
summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; width: fit-content; max-width: 100%; list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary:focus-visible { outline: 2px solid #079b57; outline-offset: 3px; border-radius: 2px; }
.insight-pair { display: inline-flex; align-items: baseline; gap: 6px; max-width: 100%; }
.insight-key { flex-shrink: 0; }
.insight-value { color: var(--app-text-primary, #25352d); overflow-wrap: anywhere; }
p { margin: 5px 0 0; max-width: 280px; overflow-wrap: anywhere; }
small { color: #b42318; }
</style>
