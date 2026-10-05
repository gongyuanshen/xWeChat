<template>
  <div class="conversation-pane flex-1 flex flex-col min-h-0 min-w-0">
    <div v-if="selectedContact" class="flex-1 flex flex-col min-h-0 min-w-0 relative">
      <div class="chat-header" :class="{ 'chat-header-ai': aiSidebarOpen || insightsPanelOpen }">
        <div class="chat-header-identity">
          <div class="chat-header-avatar" :class="{ 'privacy-blur': privacyMode }">
            <img v-if="selectedContact.avatar" :src="selectedContact.avatar" alt="" referrerpolicy="no-referrer" @error="onAvatarError($event, selectedContact)">
            <span v-else>{{ selectedContact.name.charAt(0) }}</span>
          </div>
          <div class="chat-header-heading">
          <h2 class="chat-header-title flex min-w-0 items-center gap-1.5 text-base font-medium">
            <span class="min-w-0 truncate" :class="{ 'privacy-blur': privacyMode }">{{ selectedContact.name }}</span>
            <span
              v-if="selectedContact.enterpriseName"
              class="min-w-0 max-w-[16rem] truncate text-[14px] text-[#ff8000]"
              :class="{ 'privacy-blur': privacyMode }"
            >@{{ selectedContact.enterpriseName }}</span>
            <img
              v-if="selectedContact.isEnterpriseGroup"
              src="/assets/images/wechat/wecom.png"
              alt="企业微信群"
              title="企业微信群"
              class="h-4 w-4 shrink-0"
            >
          </h2>
          <div class="chat-header-context">
            <span class="chat-header-kind">{{ selectedContact.isGroup ? '群聊' : '聊天记录' }}</span>
            <span v-if="recognitionHeader" class="recognition-mood" :class="{ 'privacy-blur': privacyMode }" :title="recognitionHeader.detail">{{ recognitionHeader.title }}：{{ recognitionHeader.label }}</span>
          </div>
          </div>
          <button
            v-if="groupAnnouncement"
            type="button"
            class="chat-announcement-btn inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium"
            aria-haspopup="dialog"
            title="查看群公告"
            @click="openGroupAnnouncement"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 13V7l12-3v12L4 13Z" />
              <path d="M8 13v6h3l1-5M19 8v4" />
            </svg>
            <span>群公告</span>
          </button>
        </div>
        <div class="chat-header-tools" aria-label="聊天工具">
          <button type="button" class="header-btn-icon header-ai-button" :class="{ 'header-btn-icon-active': aiSidebarOpen }" aria-label="AI 助手" title="AI 助手" :aria-pressed="aiSidebarOpen" @click="toggleAiSidebar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" /></svg>
            <span>AI</span>
          </button>
          <button type="button" class="header-btn-icon header-portrait-button w-auto whitespace-nowrap px-2" :class="{ 'header-btn-icon-active': insightsPanelOpen }" aria-label="聊天画像" title="聊天画像" :aria-pressed="insightsPanelOpen" @click="state.toggleInsightsPanel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3" /><path d="M6 20v-2a6 6 0 0 1 12 0v2M4 4v4M2 6h4M20 3v4M18 5h4" /></svg>
            <span>画像</span>
          </button>
          <button
            type="button"
            class="header-btn-icon"
            :disabled="isLoadingMessages || isJumpingToFirst"
            :aria-busy="isJumpingToFirst"
            aria-label="从第一条消息开始阅读"
            title="从第一条消息开始阅读"
            @click="jumpToConversationFirst"
          >
            <svg class="w-4 h-4" :class="{ 'animate-pulse': isJumpingToFirst }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" aria-hidden="true">
              <path d="M5 4h14" />
              <path d="M12 20V7" />
              <path d="m7.5 11.5 4.5-4.5 4.5 4.5" />
            </svg>
          </button>
          <button type="button" class="header-btn-icon" data-testid="chat-refresh" @click="refreshChatFromWechat" :disabled="isRefreshingMessages" :aria-busy="isRefreshingMessages" aria-label="刷新消息" :title="isRefreshingMessages ? '正在刷新消息' : '刷新消息'">
            <svg class="w-4 h-4" :class="{ 'motion-safe:animate-spin': isRefreshingMessages }" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
          </button>
          <button class="header-btn-icon" @click="openExportModal" :disabled="isExportCreating" title="导出聊天记录">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
            </svg>
          </button>
          <button
            type="button"
            class="header-btn-icon"
            :class="{ 'header-btn-icon-active': voiceSidebarOpen }"
            :disabled="!selectedContact"
            :aria-pressed="voiceSidebarOpen"
            aria-label="语音转文字"
            title="语音转文字"
            @click="toggleVoiceSidebar"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="8" y="3" width="8" height="12" rx="4" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
            </svg>
          </button>
          <button class="header-btn-icon" :class="{ 'header-btn-icon-active': resourceSidebarOpen }" @click="toggleResourceSidebar" :disabled="!selectedContact" title="查看图片和视频资源">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9" r="1.5" />
              <path d="M21 15l-5-5L5 20" />
              <path d="M14 7l4 2.5-4 2.5V7z" />
            </svg>
          </button>
          <button class="header-btn-icon" :class="{ 'header-btn-icon-active': messageSearchOpen }" @click="toggleMessageSearch" :title="messageSearchOpen ? '关闭搜索 (Esc)' : '搜索聊天记录 (Ctrl+F)'">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 16 16">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7.33333 12.6667C10.2789 12.6667 12.6667 10.2789 12.6667 7.33333C12.6667 4.38781 10.2789 2 7.33333 2C4.38781 2 2 4.38781 2 7.33333C2 10.2789 4.38781 12.6667 7.33333 12.6667Z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14 14L11.1 11.1" />
            </svg>
          </button>
          <button class="header-btn-icon" :class="{ 'header-btn-icon-active': timeSidebarOpen }" @click="toggleTimeSidebar" :disabled="!selectedContact || isLoadingMessages" title="按日期定位">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 7V3m8 4V3M3 11h18" />
              <rect x="4" y="5" width="16" height="16" rx="2" ry="2" stroke-width="1.8" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M7 14h2m3 0h2m3 0h2M7 18h2m3 0h2" />
            </svg>
          </button>
          <select
            v-model="messageTypeFilter"
            class="message-filter-select"
            :disabled="isLoadingMessages || searchContext.active"
            :title="searchContext.active ? '上下文模式下暂不可筛选' : '筛选消息类型'"
          >
            <option v-for="opt in messageTypeFilterOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <button
            v-if="selectedContact.isGroup"
            type="button"
            class="header-btn-icon"
            :class="{ 'header-btn-icon-active': groupMembersSidebarOpen }"
            :title="groupMembersSidebarOpen ? '关闭群成员' : '更多（群成员）'"
            :aria-label="groupMembersSidebarOpen ? '关闭群成员' : '更多（群成员）'"
            :aria-expanded="groupMembersSidebarOpen"
            aria-controls="group-members-sidebar"
            @click="toggleGroupMembersSidebar"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
        </div>
      </div>

      <MessageList :state="state" />

      <MessageInputWorkspace :state="state" />

      <button
        v-if="showJumpToBottom || searchContext.active"
        type="button"
        class="jump-to-bottom-btn absolute bottom-44 right-6 z-20 w-10 h-10 rounded-full border shadow flex items-center justify-center"
        title="回到最新"
        @click="searchContext.active ? refreshSelectedMessages() : scrollToBottom()"
      >
        <svg class="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>

    <div v-else class="conversation-empty flex-1 flex items-center justify-center">
      <div class="text-center">
        <div class="w-20 h-20 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-[#03C160]/10 to-[#03C160]/5 flex items-center justify-center">
          <svg class="w-10 h-10 text-[#03C160]/60" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 19.8C17.52 19.8 22 15.99 22 11.3C22 6.6 17.52 2.8 12 2.8C6.48 2.8 2 6.6 2 11.3C2 13.29 2.8 15.12 4.15 16.57C4.6 17.05 4.82 17.29 4.92 17.44C5.14 17.79 5.21 17.99 5.23 18.4C5.24 18.59 5.22 18.81 5.16 19.26C5.1 19.75 5.07 19.99 5.13 20.16C5.23 20.49 5.53 20.71 5.87 20.72C6.04 20.72 6.27 20.63 6.72 20.43L8.07 19.86C8.43 19.71 8.61 19.63 8.77 19.59C8.95 19.55 9.04 19.54 9.22 19.54C9.39 19.53 9.64 19.57 10.14 19.65C10.74 19.75 11.37 19.8 12 19.8Z"/>
          </svg>
        </div>
        <h3 class="conversation-empty-title text-base font-medium mb-1.5">选择一个会话</h3>
        <p class="conversation-empty-text text-sm">
          从左侧列表选择联系人查看聊天记录
        </p>
        <button v-if="selectedAccount" type="button" class="mt-5 rounded-lg border px-4 py-2 text-sm" :aria-pressed="aiSidebarOpen" @click="toggleAiSidebar">向全部聊天提问</button>
      </div>
    </div>

    <GuideDialog
      :open="groupAnnouncementOpen"
      eyebrow=""
      title="群公告"
      description=""
      primary-label="关闭"
      tone="info"
      @primary="closeGroupAnnouncement"
      @close="closeGroupAnnouncement"
    >
      <p
        class="whitespace-pre-wrap break-words text-sm leading-7 text-[#3f4a44]"
        :class="{ 'privacy-blur': privacyMode }"
      >{{ groupAnnouncement }}</p>
    </GuideDialog>
  </div>
</template>

<script>
import { defineComponent, toRef } from 'vue'
import MessageList from '~/components/chat/MessageList.vue'
import MessageInputWorkspace from '~/components/chat/MessageInputWorkspace.vue'

export default defineComponent({
  name: 'ConversationPane',
  components: { MessageList, MessageInputWorkspace },
  props: {
    state: { type: Object, required: true }
  },
  setup(props) {
    return {
      ...props.state,
      isRefreshingMessages: toRef(props.state, 'isRefreshingMessages'),
      insightsPanelOpen: toRef(props.state, 'insightsPanelOpen'),
      recognitionHeader: toRef(props.state, 'recognitionHeader')
    }
  }
})
</script>

<style scoped>
.conversation-pane { container-type: inline-size; }
.chat-header { height: auto; min-height: 84px; flex-shrink: 0; flex-wrap: wrap; gap: 14px; padding: 16px 24px; }
.chat-header-identity { display: flex; flex: 1 1 220px; align-items: center; gap: 12px; min-width: 0; }
.chat-header-avatar { display: flex; flex: 0 0 42px; width: 42px; height: 42px; align-items: center; justify-content: center; overflow: hidden; border-radius: 14px; background: var(--chat-subtle-bg); color: var(--chat-accent); font-size: 17px; font-weight: 600; }
.chat-header-avatar img { width: 100%; height: 100%; object-fit: cover; }
.chat-header-heading { flex: 1; min-width: 0; }
.chat-header-title { font-size: 18px; font-weight: 650; line-height: 1.5; }
.chat-header-context { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 9px; margin-top: 3px; color: var(--app-text-secondary); font-size: 11px; line-height: 1.5; }
.chat-header-kind { flex-shrink: 0; }
.recognition-mood { min-width: 0; max-width: 320px; overflow-wrap: anywhere; }
.chat-announcement-btn { flex-shrink: 0; color: var(--chat-accent); }
.chat-announcement-btn:hover { background: var(--chat-subtle-bg); }
.chat-header-tools { display: flex; align-items: center; gap: 3px; min-width: 0; max-width: 100%; margin-left: auto; padding: 3px; }
.header-btn-icon { flex-shrink: 0; width: 32px; height: 34px; border-radius: 10px; }
.header-btn-icon svg { width: 17px; height: 17px; }
.header-btn-icon:hover:not(:disabled), .header-btn-icon-active { background: var(--chat-subtle-bg); color: var(--chat-accent); }
.header-ai-button, .header-portrait-button { width: auto; gap: 5px; padding: 0 9px; white-space: nowrap; font-size: 12px; font-weight: 600; }
.header-ai-button { color: var(--chat-ai-text); background: var(--chat-ai-bg); margin-right: 3px; }
.message-filter-select { flex-shrink: 0; max-width: 112px; height: 34px; color: var(--app-text-secondary); background: var(--chat-subtle-bg); border-radius: 10px; }
.header-btn-icon:focus-visible, .message-filter-select:focus-visible, .chat-announcement-btn:focus-visible { outline: 2px solid var(--chat-focus-ring); outline-offset: 2px; }
@container (max-width: 840px) {
  .chat-header { gap: 8px; padding: 14px 20px 10px; }
  .chat-header-identity { flex-basis: 100%; }
  .chat-header-tools { width: 100%; margin-left: 0; overflow-x: auto; scrollbar-width: thin; }
}
@container (max-width: 480px) {
  .chat-header { padding-right: 14px; padding-left: 14px; }
  .chat-header-avatar { flex-basis: 36px; width: 36px; height: 36px; border-radius: 12px; }
  .chat-header-title { font-size: 15px; }
  .chat-announcement-btn { padding-right: 0; }
}
</style>
