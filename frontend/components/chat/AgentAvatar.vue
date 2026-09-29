<script setup>
import { computed, ref, watch } from 'vue'
import { referenceUrl } from '~/utils/agentMarkdown'
import { useApiBase } from '~/composables/useApiBase'
const props = defineProps({ path: String, name: String })
const apiBase = useApiBase(), failed = ref(false)
const url = computed(() => referenceUrl(props.path, apiBase))
const initial = computed(() => Array.from((props.name || '').trim())[0] || '?')
watch(() => props.path, () => { failed.value = false })
</script>
<template>
  <span class="agent-avatar" role="img" :aria-label="`${name || '未知发送者'}的头像`">
    <span aria-hidden="true">{{ initial }}</span>
    <img v-if="url && !failed" :src="url" alt="" @error="failed = true" />
  </span>
</template>
