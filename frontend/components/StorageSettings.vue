<template>
  <div class="storage-settings">
    <div class="storage-toolbar">
      <label>微信账号
        <select v-model="account" :disabled="cleaning || syncPending || !accountNames.length" :class="{ 'privacy-blur': privacyMode }">
          <option v-if="!accountNames.length" value="">暂无已导入账号</option>
          <option v-for="name in accountNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <button type="button" :disabled="!account || loading || cleaning || syncPending" @click="scan">{{ loading ? '正在统计…' : '刷新占用' }}</button>
    </div>
    <p v-if="accounts.error" class="storage-error" role="alert">{{ accounts.error }}</p>
    <p v-if="!account">请先导入或解密一个微信账号。</p>
    <p v-else-if="!attempted">进入本栏目后统计该账号的文件占用。</p>
    <p v-if="notice" class="storage-notice" role="status">{{ notice }}</p>
    <p v-if="error" class="storage-error" role="alert">{{ error }}</p>
    <div v-if="summary" :aria-busy="loading">
      <div class="storage-total"><span>账号文件合计</span><strong>{{ formatFileSize(summary.total_bytes) }}</strong></div>
      <p class="storage-note">{{ summary.scope_note }}</p>
      <dl class="storage-categories">
        <div v-for="row in summary.categories" :key="`${summary.account}:${row.id}`" class="storage-category">
          <dt>{{ row.label }}<small v-if="row.description">{{ row.description }}</small><StorageLocations :locations="row.locations" :privacy-mode="privacyMode" /></dt>
          <dd>{{ formatFileSize(row.bytes) }}<small>{{ row.files }} 个文件</small></dd>
        </div>
      </dl>
      <div class="storage-shared"><span>共享数据（不计入账号合计）</span><strong>{{ formatFileSize(summary.shared.bytes) }}</strong><p>{{ summary.shared.description }}</p><StorageLocations :key="summary.account" :locations="summary.shared.locations" :privacy-mode="privacyMode" empty-text="尚无共享数据文件" /></div>
      <div class="storage-cleanup">
        <div class="storage-cleanup-heading"><strong>可重建的搜索索引</strong><span>{{ formatFileSize(summary.cleanup.bytes) }}</span></div>
        <p>清理后，下次搜索需要重新建立索引。聊天数据库、媒体、资料夹副本和所有快照都会保留。</p>
        <p v-if="summary.cleanup.reason" role="status">{{ summary.cleanup.reason }}</p>
        <div v-if="summary.sync.refresh_available" class="storage-sync">
          <template v-if="summary.sync.user_paused">
            <p>{{ summary.sync.running ? '同步任务尚未结束，结束前不能清理。请稍后刷新占用。' : '自动同步已暂停，清理后可在这里恢复。重新启动应用也会恢复默认同步行为。' }}</p>
            <button type="button" :disabled="loading || cleaning || syncPending || summary.sync.running" @click="setSyncPaused(false)">{{ syncPending ? '正在提交…' : '恢复自动同步' }}</button>
          </template>
          <template v-else-if="summary.sync.enabled || summary.sync.running">
            <p>自动同步会占用此账号。请先暂停，等待当前同步安全结束，再刷新占用并清理。</p>
            <button type="button" :disabled="loading || cleaning || syncPending" @click="setSyncPaused(true)">{{ syncPending ? '正在提交…' : '暂停自动同步' }}</button>
          </template>
        </div>
        <template v-if="confirming">
          <p class="storage-confirm">确认清理所选账号的搜索索引？预计移除 {{ formatFileSize(summary.cleanup.bytes) }} 的索引文件。</p>
          <div class="storage-actions"><button type="button" :disabled="cleaning" @click="clean">{{ cleaning ? '正在清理…' : '确认清理' }}</button><button type="button" :disabled="cleaning" @click="confirming = false">取消</button></div>
        </template>
        <button v-else type="button" :disabled="loading || syncPending || !summary.cleanup.available" @click="confirming = true">清理搜索索引…</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useChatAccountsStore } from '~/stores/chatAccounts';
import { usePrivacyStore } from '~/stores/privacy';
import { formatFileSize as formatSmallFileSize } from '~/lib/chat/formatters';
import StorageLocations from './StorageLocations.vue';

const props = defineProps({ active: Boolean });
const accounts = useChatAccountsStore();
const { privacyMode } = storeToRefs(usePrivacyStore());
const accountNames = computed(() => accounts.accounts);
const account = ref(accounts.selectedAccount || accounts.accounts[0] || '');
const apiBase = useApiBase();
const base = `${apiBase}/storage`;
const formatFileSize = bytes => bytes === 0 ? '0 B' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : formatSmallFileSize(bytes);
const summary = ref(null), loading = ref(false), cleaning = ref(false), confirming = ref(false);
const syncPending = ref(false);
const attempted = ref(false), notice = ref(''), error = ref('');
let generation = 0, scanController;
const message = e => typeof e.data?.detail === 'string' ? e.data.detail : e.data?.detail?.message || e.message;

watch(accountNames, names => {
  if (!names.includes(account.value)) account.value = names[0] || '';
});
watch(account, () => {
  generation++; scanController?.abort(); loading.value = false; summary.value = null;
  confirming.value = false; attempted.value = false; notice.value = ''; error.value = '';
  if (props.active && account.value) scan();
}, { flush: 'sync' });
watch(() => props.active, active => {
  if (active && account.value && !attempted.value) scan();
}, { immediate: true });

async function scan() {
  scanController?.abort();
  const controller = new AbortController(); scanController = controller;
  const token = ++generation, owner = account.value;
  loading.value = true; attempted.value = true; error.value = ''; confirming.value = false;
  try {
    const result = await $fetch(base, { query: { account: owner }, signal: controller.signal, retry: 0 });
    if (token === generation) summary.value = result;
  } catch (e) {
    if (token === generation && !controller.signal.aborted) { error.value = message(e); summary.value = null; }
  } finally { if (token === generation) loading.value = false; }
}

async function clean() {
  const owner = account.value, token = generation;
  cleaning.value = true; error.value = ''; notice.value = '';
  let completed = false;
  try {
    const result = await $fetch(`${base}/cleanup`, { method: 'POST', query: { account: owner }, body: { category: 'search_index' }, retry: 0 });
    if (token !== generation) return;
    notice.value = `已清理 ${result.removed_files} 个索引文件，共 ${formatFileSize(result.removed_bytes)}。实际释放空间以文件系统为准。`;
    completed = true;
  } catch (e) {
    if (token !== generation) return;
    const detail = e.data?.detail;
    error.value = e.data ? message(e) : `清理结果未确认：${e.message}。请刷新占用核对后再操作。`;
    if (detail?.removed_files > 0) error.value += ` 本次已删除 ${detail.removed_files} 个文件，共 ${formatFileSize(detail.removed_bytes)}；其余文件未完成清理。`;
    summary.value = null;
  } finally {
    cleaning.value = false;
    if (token === generation) confirming.value = false;
  }
  if (completed) await scan();
}

async function setSyncPaused(paused) {
  const owner = account.value, token = generation;
  syncPending.value = true; confirming.value = false; error.value = ''; notice.value = '';
  let completed = false;
  try {
    await $fetch(`${apiBase}/decrypt/snapshot-refresh/${paused ? 'stop' : 'start'}`, {
      method: 'POST', body: paused ? { account: owner, user_paused: true } : { account: owner, resume: true, interval_seconds: 30 }, retry: 0,
    });
    if (token !== generation) return;
    notice.value = paused ? '已提交暂停请求，等待当前同步安全结束后即可清理。' : '已提交恢复请求，同步进度由后台继续处理。';
    completed = true;
  } catch (e) {
    if (token !== generation) return;
    error.value = e.data ? message(e) : `操作结果未确认：${e.message}。请刷新占用核对同步状态。`;
    summary.value = null;
  } finally { syncPending.value = false; }
  if (completed) await scan();
}
onUnmounted(() => { generation++; scanController?.abort(); });
</script>

<style scoped>
.storage-settings { color: var(--app-text, #222); font-size: 12px; line-height: 1.65; }
.storage-toolbar { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.storage-toolbar label { display: grid; gap: 5px; min-width: 0; flex: 1; max-width: 360px; }
.storage-settings select, .storage-settings button { min-height: 32px; border: 1px solid var(--app-border, #dfe4df); border-radius: 6px; background: var(--app-surface-bg, #fff); padding: 5px 10px; font: inherit; color: inherit; }
.storage-settings select { width: 100%; min-width: 0; }
.storage-settings button { cursor: pointer; white-space: nowrap; }
.storage-settings button:hover:not(:disabled) { background: var(--app-hover-bg, #f1f5f2); }
.storage-settings button:disabled { opacity: .5; cursor: not-allowed; }
.storage-settings button:focus-visible, .storage-settings select:focus-visible { outline: 2px solid var(--app-accent, #079b57); outline-offset: 2px; }
.storage-settings p { margin: 8px 0; overflow-wrap: anywhere; }
.storage-total, .storage-cleanup-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.storage-total strong { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.storage-note, .storage-shared p, .storage-category small { color: var(--app-text-secondary, #666); font-size: 11px; }
.storage-categories { margin-top: 14px; }
.storage-category { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--app-border, #e4e8e4); }
.storage-category dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.storage-category small { display: block; }
.storage-shared { margin: 14px 0 20px; }
.storage-shared strong { margin-left: 10px; font-weight: 500; font-variant-numeric: tabular-nums; }
.storage-cleanup { padding: 14px; border: 1px solid var(--app-border, #dfe4df); border-radius: 8px; }
.storage-sync { margin: 12px 0; }
.storage-actions { display: flex; gap: 8px; margin-top: 12px; }
.storage-confirm { font-weight: 600; }
.storage-error { color: var(--app-danger-text, #b42318); }
.storage-notice { font-weight: 500; }
</style>
