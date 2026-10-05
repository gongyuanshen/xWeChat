// Isolated UI acceptance only: synthetic status and messages, no backend/WeChat.
import { computed, createApp, defineComponent, h, nextTick, ref } from 'vue'
import SnapshotRefreshControl from '../../components/chat/SnapshotRefreshControl.vue'
import ErrorNotice from '../../components/ErrorNotice.vue'
import { useSnapshotRefresh } from '../../composables/chat/useSnapshotRefresh'
import { useChatMessages } from '../../composables/chat/useChatMessages'
import { createEmptySearchContext, useChatSearch } from '../../composables/chat/useChatSearch'
import '../../assets/css/tailwind.css'
import '../../assets/css/chat.css'

globalThis.process = { client: true }
globalThis.computed = computed
globalThis.useApiBase = () => '/isolated-no-api'
globalThis.useSettingsDialog = () => ({ openDialog() {} })
let backend = { account: 'synthetic', active_account: null, enabled: false, running: false, phase: 'disabled',
  revision: 0, generation: null, archive_generation: null, interval_seconds: 30, error: null, last_success_at: null,
  guarantee: 'stable_observation', refresh_available: true, unavailable_reason: '' }
const rows = Array.from({ length: 120 }, (_, i) => ({ id: `m-${i}`, localId: i, type: 1, renderType: 'text', content: `合成消息 ${i}`, createTime: 1000 + i }))
const app = createApp(defineComponent({ setup() {
  const account = ref('synthetic'), selectedContact = ref({ username: 'friend' }), searchContext = ref(createEmptySearchContext())
  const api = {
    getSnapshotRefreshStatus: async () => ({ ...backend }),
    subscribeSnapshotRefresh: () => ({ close() {} }),
    startSnapshotRefresh: async () => (backend = { ...backend, enabled: true, running: false, phase: 'waiting', error: null }),
    stopSnapshotRefresh: async () => (backend = { ...backend, enabled: false, running: true, phase: 'stopping' }),
    refreshSnapshotOnce: async () => (backend = { ...backend, running: true, phase: 'checking', error: null }),
    listChatMessages: async () => ({ messages: rows.slice(-50), total: rows.length, hasMore: true, snapshotGeneration: backend.generation ?? 'legacy' }),
    getChatMessagesAround: async ({ anchor_id }) => {
      const index = rows.findIndex(row => row.id === anchor_id)
      return { messages: rows.slice(Math.max(0, index - 35), index + 36).map(row => ({ ...row, content: row.content + ' · 新快照' })), anchorId: anchor_id, anchorIndex: Math.min(35, index), snapshotGeneration: backend.generation }
    }
  }
  const messageState = useChatMessages({ api, apiBase: '/isolated-no-api', selectedAccount: account, selectedContact,
    searchContext, privacyMode: ref(false), onSnapshotChanged: () => snapshot.refreshView() })
  const search = useChatSearch({ api, selectedAccount: account, selectedContact, contacts: ref([]), privacyMode: ref(false),
    searchContext, selectContact() {}, ...messageState, onSnapshotChanged: () => snapshot.refreshView() })
  messageState.allMessages.value = { friend: rows }
  messageState.messagesMeta.value = { friend: { total: 120, hasMore: true, snapshotGeneration: 'legacy' } }
  const snapshot = useSnapshotRefresh({ api, selectedAccount: account, active: ref(true), onPublished: search.refreshSnapshotWindow,
    getDisplayedGeneration: () => messageState.messagesMeta.value.friend?.snapshotGeneration })
  window.snapshotFixture = {
    snapshot, messageState, searchContext,
    async publish() { backend = { ...backend, enabled: true, running: false, phase: 'waiting', revision: 1, generation: 'generation-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', last_success_at: '2026-10-04T06:00:00Z' }; await snapshot.refreshView(); await nextTick() },
    async fail() { backend = { ...backend, enabled: false, running: false, phase: 'failed', error: { stage: 'publish', type: 'OSError', message: '合成测试：磁盘空间不足，发布已停止' } }; await snapshot.refreshView() }
  }
  return () => h('main', { style: 'display:flex;height:720px;color:var(--app-text-primary);background:var(--app-bg)' }, [
    h('aside', { id: 'controls', style: 'width:220px;flex:none;padding:16px;box-sizing:border-box;background:var(--session-list-bg)' }, [h('h2', '聊天 · 合成验收'), h(SnapshotRefreshControl, { state: snapshot })]),
    h('section', { ref: messageState.messageContainerRef, id: 'history', style: 'flex:1;overflow:auto;padding:16px' },
      messageState.messages.value.map(row => h('div', { 'data-msg-id': row.id, style: 'height:72px;box-sizing:border-box;padding:12px;border-bottom:1px solid var(--app-border)' }, row.content)))
  ])
} }))
app.component('ErrorNotice', ErrorNotice)
app.mount('#app')
