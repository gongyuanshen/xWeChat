<template>
  <div class="storage-locations">
    <details v-if="locations.length">
      <summary>查看存放位置</summary>
      <ul class="storage-location-list">
        <li v-for="location in locations" :key="location.path">
          <div class="storage-location-address" :class="{ 'privacy-blur': privacyMode }">
            <span>{{ location.kind === 'directory' ? '文件夹' : '文件' }}</span>
            <code>{{ location.path }}</code>
          </div>
          <button type="button" :disabled="Boolean(copying)" @click="copyAddress(location.path)">{{ copied === location.path ? '已复制' : '复制地址' }}</button>
        </li>
      </ul>
      <p v-if="copyError" class="storage-location-error" role="alert">{{ copyError }}</p>
    </details>
    <p v-else class="storage-location-empty">{{ emptyText }}</p>
  </div>
</template>

<script setup>
import { onUnmounted, ref, watch } from 'vue';

const props = defineProps({
  locations: { type: Array, required: true },
  privacyMode: Boolean,
  emptyText: { type: String, default: '尚无本分类文件' },
});
const copying = ref(''), copied = ref(''), copyError = ref('');
let generation = 0;
watch(() => props.locations, () => {
  generation++; copying.value = ''; copied.value = ''; copyError.value = '';
}, { flush: 'sync' });
async function copyAddress(path) {
  const token = ++generation;
  copying.value = path; copied.value = ''; copyError.value = '';
  try {
    await navigator.clipboard.writeText(path);
    if (token === generation) copied.value = path;
  } catch (error) {
    if (token === generation) copyError.value = `无法复制地址：${error.message}`;
  } finally {
    if (token === generation) copying.value = '';
  }
}
onUnmounted(() => { generation++; });
</script>

<style scoped>
.storage-locations { margin-top: 4px; font-size: 11px; }
.storage-locations summary { width: fit-content; cursor: pointer; color: var(--app-accent, #079b57); }
.storage-location-list { display: grid; gap: 8px; margin: 8px 0 0; padding: 0; list-style: none; max-height: 240px; overflow-y: auto; }
.storage-location-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px; }
.storage-location-address { min-width: 0; }
.storage-location-address span { display: block; color: var(--app-text-secondary, #666); }
.storage-location-address code { display: block; white-space: normal; overflow-wrap: anywhere; user-select: text; }
.storage-locations button { min-height: 28px; border: 1px solid var(--app-border, #dfe4df); border-radius: 6px; background: var(--app-surface-bg, #fff); padding: 3px 8px; font: inherit; color: inherit; cursor: pointer; white-space: nowrap; }
.storage-locations button:hover:not(:disabled) { background: var(--app-hover-bg, #f1f5f2); }
.storage-locations button:disabled { opacity: .5; cursor: not-allowed; }
.storage-locations button:focus-visible, .storage-locations summary:focus-visible { outline: 2px solid var(--app-accent, #079b57); outline-offset: 2px; }
.storage-location-error { margin: 8px 0 0; color: var(--app-danger-text, #b42318); overflow-wrap: anywhere; }
.storage-location-empty { margin: 0; color: var(--app-text-secondary, #666); }
</style>
