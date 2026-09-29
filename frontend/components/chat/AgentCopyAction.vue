<template>
  <button type="button" class="agent-copy-action" :aria-label="label" :title="label" @click="copy"><component :is="copied ? Check : Copy" :size="16" :stroke-width="1.8" aria-hidden="true" /></button>
  <span v-if="failed" class="agent-error" role="status">复制失败，请重试</span>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { Check, Copy } from '@lucide/vue'
import { copyAgentText } from '~/utils/agentMarkdown'
const props = defineProps({ text: String, citations: Array, references: Array })
const copied = ref(false), failed = ref(false)
const label = computed(() => copied.value ? '已复制回答' : '复制回答')
// 历史摘要和完整运行共用同一复制入口，复制内容包含可读的出处。
watch(() => [props.text, props.citations, props.references], () => { copied.value = false; failed.value = false })
const copy = async () => {
  try {
    await navigator.clipboard.writeText(copyAgentText(props.text, props.citations, props.references))
    copied.value = true; failed.value = false
  } catch { copied.value = false; failed.value = true }
}
</script>
