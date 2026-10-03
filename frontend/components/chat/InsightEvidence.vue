<script setup>
defineProps({ text: { type: String, required: true }, sources: { type: Array, required: true } })
defineEmits(['locate'])
</script>
<template>
  <div class="insight-evidence"><p>{{ text }}</p><div v-if="sources.length" class="sources"><button v-for="(source, i) in sources" :key="source" type="button" :data-source="source" @click="$emit('locate', source)">原文 {{ i + 1 }}</button></div></div>
</template>
<style scoped>
p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.sources { display: flex; flex-wrap: wrap; gap: 5px; }
button { border: 0; background: var(--app-surface-soft, #edf6f0); color: #079b57; border-radius: 4px; font: inherit; font-size: 11px; padding: 2px 6px; cursor: pointer; }
</style>
