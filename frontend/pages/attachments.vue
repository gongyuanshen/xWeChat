<template>
  <main class="records-page attachments-page">
    <div class="records-page__scroll">
      <div class="records-page__frame">
        <header class="records-masthead">
          <div class="records-masthead__identity"><h1>附件中心</h1></div>
          <button type="button" class="attachment-button" @click="navigateTo('/library')">打开本地资料夹</button>
        </header>
        <p class="attachments-intro">跨聊天查找文件、图片和视频，保留原消息出处。</p>
        <p v-if="accounts.error" class="attachment-error" role="alert">{{ accounts.error }}</p>
        <p v-if="!selectedAccount" class="attachment-state">请先选择已解密或已导入的微信账号。</p>
        <template v-else>
          <form class="attachment-filters" @submit.prevent="search">
            <label class="attachment-query">搜索<input v-model="filters.q" type="search" placeholder="文件名或已提取正文，留空浏览附件" /></label>
            <label>搜索位置<select v-model="filters.search_in"><option value="all">名称与已提取正文</option><option value="name">名称</option><option value="body">仅已提取正文</option></select></label>
            <label>类型<select v-model="filters.kind"><option value="all">全部附件</option><option value="file">文件</option><option value="image">图片</option><option value="video">视频</option></select></label>
            <label>会话<select v-model="filters.username" :disabled="filtersLoading"><option value="">全部会话</option><option v-for="row in choices.conversations" :key="row.value" :value="row.value">{{ row.label }}</option></select></label>
            <label>发送者<select v-model="filters.sender" :disabled="filtersLoading"><option value="">全部发送者</option><option v-for="row in choices.senders" :key="row.value" :value="row.value">{{ row.label }}</option></select></label>
            <label>开始日期<input v-model="filters.start" type="date" /></label>
            <label>结束日期<input v-model="filters.end" type="date" /></label>
            <button type="submit" class="attachment-button primary" :disabled="loading">{{ loading ? '正在查询…' : '查询附件' }}</button>
          </form>
          <p v-if="filterError" class="attachment-error" role="alert">{{ filterError }} <button type="button" class="attachment-button" @click="loadFilters">重试筛选选项</button></p>
          <p v-else-if="filterStatus === 'index_building'" role="status" class="attachment-meta">会话和发送者筛选项正在准备，重新查询时会更新。</p>
          <div class="attachment-summary">
            <p>提取使用本地文档解析，不调用 AI。<template v-if="coverage">{{ coverage.message }} 当前筛选范围内共 {{ coverage.total_files }} 个文件，完整提取 {{ coverage.complete }} 个，部分提取 {{ coverage.partial }} 个。</template></p>
            <div class="attachment-actions">
              <button v-if="!extracting" type="button" class="attachment-button" :disabled="!extractable.length || loading" @click="extractFiles(extractable)">提取当前页文件正文</button>
              <button v-else type="button" class="attachment-button" :disabled="stopRequested" @click="stopRequested = true">{{ stopRequested ? '等待当前文件完成…' : '停止后续提取' }}</button>
            </div>
          </div>
          <p v-if="notice" role="status" class="attachment-notice">{{ notice }}</p>
          <p v-if="error" role="alert" class="attachment-error">{{ error }} <button type="button" class="attachment-button" @click="loadPage(failedOffset)">重试本页</button></p>
          <p v-if="status === 'index_building'" role="status" class="attachment-state">附件索引正在准备，请稍后点击“查询附件”刷新。</p>
          <p v-else-if="status === 'index_error'" role="alert" class="attachment-error">{{ indexError || '附件索引准备失败，请重新查询查看状态。' }}</p>
          <p v-else-if="loading && !items.length" role="status" class="attachment-state">正在读取附件…</p>
          <p v-else-if="needsSearch" class="attachment-state">筛选条件已改变，点击“查询附件”查看结果。</p>
          <p v-else-if="!items.length && !error" class="attachment-state">当前条件下没有附件。正文尚未提取的文件不会命中正文搜索。</p>
          <section v-if="items.length" aria-label="附件查询结果" class="attachment-results">
            <article v-for="item in items" :key="key(item)" class="attachment-row">
              <div class="attachment-kind" aria-hidden="true"><FileTypeIcon v-if="item.kind === 'file'" :file-name="item.name" /><ImageIcon v-else-if="item.kind === 'image'" :size="30" /><Film v-else :size="30" /></div>
              <div class="attachment-copy" :class="{ 'privacy-blur': privacyMode }">
                <h2>{{ item.name }}</h2>
                <p class="attachment-meta">{{ kindName(item.kind) }}<template v-if="item.size != null"> · {{ formatFileSize(item.size) }}</template> · {{ item.conversation_name || item.username }} · {{ item.sender_name || item.sender }} · <time>{{ formatDate(item.create_time) }}</time></p>
                <template v-if="item.kind === 'file'"><p class="attachment-extraction">{{ extractionLabel(item.extraction?.status) }}<span v-if="item.extraction?.message"> · {{ item.extraction.message }}</span></p><p v-if="item.extraction?.text_excerpt" class="attachment-snippet"><strong>正文摘录（已提取 {{ item.extraction.text_characters }} 字）</strong><br />{{ item.extraction.text_excerpt }}</p></template>
                <p v-if="rowErrors[key(item)]" class="attachment-error" role="alert">{{ rowErrors[key(item)] }}</p>
              </div>
              <div class="attachment-actions">
                <button v-if="item.kind !== 'file'" type="button" class="attachment-button" :disabled="loading" @click="openPreview(item)">预览</button>
                <button type="button" class="attachment-button" :disabled="loading || downloading === key(item)" @click="download(item)">{{ downloading === key(item) ? '正在下载…' : '下载' }}</button>
                <button type="button" class="attachment-button" :disabled="loading" @click="locate(item)">原消息</button>
                <button type="button" class="attachment-button" :disabled="loading" @click="saveItem(item)">加入资料夹</button>
                <button v-if="item.kind === 'file'" type="button" class="attachment-button" :disabled="loading || extracting" @click="extractFiles([item])">提取正文</button>
              </div>
            </article>
          </section>
          <div v-if="items.length" class="attachment-pagination"><button type="button" class="attachment-button" :disabled="loading || offset === 0" @click="loadPage(Math.max(0, offset - PAGE_SIZE))">上一页</button><span>第 {{ Math.floor(offset / PAGE_SIZE) + 1 }} 页 · {{ items.length }} 项</span><button type="button" class="attachment-button" :disabled="loading || !hasMore" @click="loadPage(nextOffset)">下一页</button></div>
          <section v-if="preview" ref="previewSection" tabindex="-1" class="attachment-preview" aria-label="附件预览">
            <div class="attachment-preview-heading"><h2 :class="{ 'privacy-blur': privacyMode }">{{ preview.name }}</h2><button type="button" class="attachment-button" @click="preview = null">关闭预览</button></div>
            <p v-if="preview.kind === 'image'" class="attachment-meta">预览使用本机当前可读取的图片，可能是缩略图，不保证原图。</p>
            <p v-if="previewError" class="attachment-error" role="alert">{{ previewError }}</p>
            <img v-if="preview.kind === 'image'" :key="key(preview)" :class="{ 'privacy-blur': privacyMode }" :src="api.contentUrl(selectedAccount, preview)" :alt="preview.name" @error="previewError = '图片无法预览。若尚未下载，请先在电脑版微信中打开并下载，再重试；若已下载仍无法预览，请点击“下载”查看具体错误。'" />
            <video v-else :key="key(preview)" :class="{ 'privacy-blur': privacyMode }" :src="api.contentUrl(selectedAccount, preview)" controls preload="metadata" @error="previewError = '视频无法预览。若尚未下载，请先在电脑版微信中打开并下载，再重试；若已下载仍无法预览，请点击“下载”查看具体错误。浏览器也可能不支持此视频编码，下载成功后可用本地播放器打开。'" />
          </section>
        </template>
      </div>
    </div>
    <LibrarySaveDialog v-if="itemToSave" :open="true" :account="selectedAccount" :item="itemToSave" @close="itemToSave = null" @saved="onSaved" />
  </main>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { isNavigationFailure } from 'vue-router';
import { Image as ImageIcon, Film } from '@lucide/vue';
import FileTypeIcon from '~/components/chat/FileTypeIcon.vue';
import LibrarySaveDialog from '~/components/library/LibrarySaveDialog.vue';
import { useAttachmentsApi } from '~/composables/useAttachmentsApi';
import { useChatAccountsStore } from '~/stores/chatAccounts';
import { usePrivacyStore } from '~/stores/privacy';
import { formatFileSize } from '~/lib/chat/formatters';
import { saveAttachmentDownload } from '~/utils/attachmentDownload';
import '~/assets/css/record-pages.css';

useHead({ title: '附件中心 - xwechat' });
const accounts = useChatAccountsStore();
const { selectedAccount } = storeToRefs(accounts);
const { privacyMode } = storeToRefs(usePrivacyStore());
const api = useAttachmentsApi();
const navigation = useState('ai-navigation-target', () => null);
const PAGE_SIZE = 40;
const defaults = () => ({ q: '', search_in: 'all', kind: 'all', username: '', sender: '', start: '', end: '' });
const filters = ref(defaults()), choices = ref({ conversations: [], senders: [] });
const items = ref([]), coverage = ref(null), error = ref(''), filterError = ref(''), notice = ref('');
const loading = ref(false), filtersLoading = ref(false), filterStatus = ref(''), needsSearch = ref(false), status = ref(''), indexError = ref('');
const offset = ref(0), nextOffset = ref(0), failedOffset = ref(0), hasMore = ref(false), rowErrors = ref({});
const preview = ref(null), previewError = ref(''), itemToSave = ref(null), downloading = ref('');
const previewSection = ref(null);
const extracting = ref(false), stopRequested = ref(false);
let generation = 0, filterGeneration = 0;
let listController, filterController, extractionController, downloadController;
const key = (item) => `${item.username}:${item.id}`;
const message = (e) => typeof e.data?.detail === 'string' ? e.data.detail : e.data?.detail?.message || e.message;
const kindName = (kind) => ({ file: '文件', image: '图片', video: '视频' })[kind];
const extractionLabel = (value) => ({ not_extracted: '正文未提取', complete: '正文已提取', partial: '正文部分提取', unsupported: '格式不支持', no_text: '没有可提取正文' })[value] || '正文未提取';
const formatDate = (value) => new Date(value * 1000).toLocaleString();
const extractable = computed(() => items.value.filter((item) => item.kind === 'file' && !['complete', 'unsupported', 'no_text'].includes(item.extraction?.status)));
function invalidate() {
  generation++;
  listController?.abort(); extractionController?.abort(); downloadController?.abort();
  loading.value = false; extracting.value = false; stopRequested.value = false; downloading.value = '';
  preview.value = null; itemToSave.value = null; notice.value = ''; rowErrors.value = {};
}
watch(filters, () => {
  invalidate(); items.value = []; coverage.value = null; status.value = ''; error.value = ''; needsSearch.value = true;
}, { deep: true, flush: 'sync' });
watch(selectedAccount, () => {
  invalidate(); filterGeneration++; filterController?.abort(); choices.value = { conversations: [], senders: [] }; filterError.value = ''; filterStatus.value = '';
  filters.value = defaults();
  if (selectedAccount.value) search();
}, { immediate: true, flush: 'sync' });
async function loadFilters() {
  filterController?.abort(); filterController = new AbortController();
  const account = selectedAccount.value, token = ++filterGeneration;
  filtersLoading.value = true; filterError.value = '';
  try {
    const result = await api.filters(account, filterController.signal);
    if (token !== filterGeneration) return;
    filterStatus.value = result.status;
    if (result.status === 'index_error') filterError.value = result.message || result.index?.build?.error || '筛选项索引准备失败，请重试。';
    else choices.value = result;
  }
  catch (e) { if (token === filterGeneration && !filterController.signal.aborted) filterError.value = message(e); }
  finally { if (token === filterGeneration) filtersLoading.value = false; }
}
function query() {
  const values = filters.value;
  const start = values.start ? Math.floor(new Date(`${values.start}T00:00:00`).getTime() / 1000) : null;
  const end = values.end ? Math.floor(new Date(`${values.end}T23:59:59`).getTime() / 1000) : null;
  if (start !== null && end !== null && start > end) throw new Error('开始日期不能晚于结束日期。');
  return { q: values.q.trim(), search_in: values.search_in, kind: values.kind, username: values.username, sender: values.sender, ...(start === null ? {} : { start_time: start }), ...(end === null ? {} : { end_time: end }) };
}
function search() { loadFilters(); return loadPage(0); }
async function loadPage(pageOffset) {
  invalidate();
  const token = generation, account = selectedAccount.value;
  if (!account) return;
  const controller = new AbortController(); listController = controller;
  error.value = ''; status.value = ''; failedOffset.value = pageOffset; loading.value = true; needsSearch.value = false;
  try {
    const result = await api.list(account, { ...query(), offset: pageOffset, limit: PAGE_SIZE }, controller.signal);
    if (token !== generation) return;
    items.value = result.items; coverage.value = result.coverage; status.value = result.status;
    indexError.value = result.message || result.index?.build?.error || ''; offset.value = pageOffset; nextOffset.value = result.next_offset; hasMore.value = result.has_more;
  } catch (e) { if (token === generation && !controller.signal.aborted) error.value = message(e); }
  finally { if (token === generation) loading.value = false; }
}
async function openPreview(item) { previewError.value = ''; preview.value = item; await nextTick(); previewSection.value?.focus(); previewSection.value?.scrollIntoView({ block: 'nearest' }); }
function saveItem(item) { itemToSave.value = { kind: 'attachment', source: { username: item.username, anchor: item.id }, title: item.name }; }
function onSaved() { itemToSave.value = null; notice.value = '附件副本已保存到本地资料夹。'; }
async function download(item) {
  downloadController?.abort(); const controller = new AbortController(); downloadController = controller;
  const token = generation, account = selectedAccount.value; downloading.value = key(item); delete rowErrors.value[key(item)];
  try {
    const response = await api.download(account, item, controller.signal);
    if (token !== generation || controller.signal.aborted) return;
    saveAttachmentDownload(response);
  } catch (e) { if (token === generation && !controller.signal.aborted) rowErrors.value[key(item)] = message(e); }
  finally { if (token === generation && downloadController === controller) downloading.value = ''; }
}
async function locate(item) {
  const token = generation, target = { kind: 'source', account: selectedAccount.value, username: item.username, anchor: item.id };
  navigation.value = target;
  try { const result = await navigateTo('/chat'); if (result === false || isNavigationFailure(result)) throw new Error('未能打开聊天原消息，请重试。'); }
  catch (e) { if (navigation.value === target) navigation.value = null; if (token === generation) rowErrors.value[key(item)] = message(e); }
}
async function extractFiles(files) {
  const targets = [...files], token = generation, account = selectedAccount.value;
  const controller = new AbortController(); extractionController = controller;
  extracting.value = true; stopRequested.value = false;
  let completed = 0, failed = 0;
  try {
    for (const item of targets) {
      if (stopRequested.value || token !== generation) break;
      notice.value = `正在提取 ${completed + failed + 1} / ${targets.length}：${item.name}`;
      delete rowErrors.value[key(item)];
      try {
        const result = await api.extract(account, { username: item.username, anchor: item.id }, controller.signal);
        if (token !== generation) return;
        item.extraction = result; completed++;
      } catch (e) {
        if (token !== generation || controller.signal.aborted) return;
        rowErrors.value[key(item)] = message(e); failed++;
      }
    }
    if (token === generation) notice.value = `${stopRequested.value ? '已停止后续提取。' : '提取结束。'}处理 ${completed} 项，失败 ${failed} 项。重新查询可更新正文搜索结果。`;
  } finally { if (token === generation) extracting.value = false; }
}
onMounted(() => accounts.ensureLoaded());
onUnmounted(() => { invalidate(); filterGeneration++; filterController?.abort(); });
</script>

<style scoped>
.attachments-page { height: 100vh; }
.attachments-page .records-page__scroll { overflow-y: auto; }
.attachments-page .records-page__frame { height: auto; min-height: 100%; overflow: visible; padding: 0 24px 20px; }
.attachments-page .records-masthead { margin: 0 -24px 20px; }
.attachments-intro, .attachment-summary, .attachment-meta, .attachment-extraction, .attachment-pagination { color: var(--app-text-secondary); font-size: 13px; }
.attachments-intro { margin: 0 0 20px; }
.attachment-filters { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; padding-bottom: 20px; border-bottom: 1px solid var(--app-border); }
.attachment-filters label { display: grid; gap: 6px; font-size: 12px; min-width: 0; flex: 1 1 150px; }
.attachment-filters .attachment-query { flex: 3 1 300px; }
.attachment-filters input, .attachment-filters select { width: 100%; min-width: 0; height: 36px; padding: 6px 10px; border: 1px solid var(--app-border); border-radius: 7px; color: var(--app-text-primary); background: var(--app-surface-bg); }
.attachment-button { border: 1px solid var(--app-border); border-radius: 7px; padding: 7px 11px; font-size: 13px; white-space: nowrap; background: var(--app-surface-bg); color: var(--app-text-primary); }
.attachment-button:hover:not(:disabled) { background: var(--app-neutral-btn-hover); }
.attachment-button:disabled { opacity: .5; cursor: not-allowed; }
.attachment-button.primary { color: var(--chat-input-bg); background: var(--chat-accent); border-color: var(--chat-accent); }
.attachment-filters :focus-visible, .attachment-button:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 2px; }
.attachment-summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 0; }
.attachment-summary p { max-width: 70ch; }
.attachment-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.attachment-row { display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: start; gap: 16px; padding: 18px 0; border-top: 1px solid var(--app-border); }
.attachment-kind { padding-top: 4px; color: var(--chat-accent); }
.attachment-kind :deep(.wechat-file-icon) { width: 34px; height: 40px; }
.attachment-copy h2, .attachment-preview h2 { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.attachment-meta { margin-top: 5px; line-height: 1.7; overflow-wrap: anywhere; }
.attachment-extraction { margin-top: 5px; }
.attachment-snippet { margin-top: 8px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.attachment-error { color: var(--wx-red); margin: 10px 0; font-size: 13px; overflow-wrap: anywhere; }
.attachment-state { padding: 32px 0; color: var(--app-text-secondary); }
.attachment-notice { padding: 10px 0; font-size: 13px; }
.attachment-pagination { display: flex; gap: 14px; align-items: center; justify-content: center; padding: 20px 0; }
.attachment-preview { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--app-border); }
.attachment-preview-heading { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 14px; }
.attachment-preview img, .attachment-preview video { display: block; max-width: 100%; max-height: 65vh; object-fit: contain; }
@media (max-width: 1000px) { .attachment-row { grid-template-columns: 36px minmax(0, 1fr); gap: 12px; } .attachment-row > .attachment-actions { grid-column: 2; } }
@media (max-width: 600px) { .attachment-summary { align-items: start; flex-direction: column; } .attachment-filters label { flex-basis: calc(50% - 12px); } .attachment-filters .attachment-query { flex-basis: 100%; } .attachment-pagination { gap: 8px; } }
</style>
