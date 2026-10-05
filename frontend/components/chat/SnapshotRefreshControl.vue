<script setup>
const props = defineProps({ state: { type: Object, required: true } })
const { loading, error, syncing, retry } = props.state
</script>

<template>
  <div v-if="error" class="chat-sync-error">
    <ErrorNotice :message="error" compact />
    <button type="button" :disabled="loading || syncing" @click="retry">重试同步</button>
  </div>
</template>

<style scoped>
.chat-sync-error { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 10px; min-width: 0; color: var(--app-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
button { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; border: 1px solid var(--app-border); border-radius: 8px; padding: 5px 8px; background: var(--chat-subtle-bg); color: var(--app-text-primary); font: inherit; cursor: pointer; white-space: nowrap; }
button:hover:not(:disabled) { border-color: var(--chat-focus-ring); }
button:focus-visible { outline: 2px solid var(--chat-focus-ring); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: default; }
</style>
