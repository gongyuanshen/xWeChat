<template>
  <div
    class="message-input-workspace flex flex-col shrink-0 border-t border-[var(--app-border,#e5e7eb)] bg-[var(--chat-page-bg,#ffffff)] dark:bg-[#1e1e1e] relative select-text"
    :style="{ height: `${inputHeight}px`, minHeight: selectedImage?.confirmation ? '260px' : selectedImage ? '200px' : undefined }"
  >
    <!-- Top Draggable Resizer Handle -->
    <div
      class="chat-input-resizer h-1.5 w-full cursor-row-resize bg-transparent hover:bg-[#07c160]/30 transition-colors select-none flex items-center justify-center group shrink-0"
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      aria-label="调整输入框高度"
      :aria-valuenow="inputHeight"
      :aria-valuemin="MIN_HEIGHT"
      :aria-valuemax="MAX_HEIGHT"
      @pointerdown="startResize"
      @dblclick="resetHeight"
    >
      <div class="h-0.5 w-8 rounded-full bg-gray-300/80 dark:bg-gray-600/80 group-hover:bg-[#07c160] transition-colors" />
    </div>

    <!-- Verbatim Error Alert Banner (Debug-First / Let-It-Fail) -->
    <div
      v-if="errorInfo"
      class="chat-input-error-banner mx-3 my-1 p-2 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-start justify-between gap-2 shadow-sm shrink-0"
      role="alert"
    >
      <div class="flex items-start gap-1.5 min-w-0">
        <span class="inline-block shrink-0 px-1 py-0.5 rounded font-mono font-bold text-[11px] bg-red-200/80 dark:bg-red-900/80 text-red-800 dark:text-red-200">
          {{ errorInfo.code }}
        </span>
        <span class="chat-input-error-message break-words">{{ errorInfo.message }}</span>
      </div>
      <button
        type="button"
        class="chat-input-error-dismiss shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-200 text-sm font-bold px-1 leading-none"
        title="关闭提示"
        aria-label="关闭错误提示"
        @click="errorInfo = null"
      >
        ×
      </button>
    </div>

    <div v-if="selectedImage?.confirmation" role="status" class="chat-input-image-pending mx-3 my-1 p-2 rounded border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-xs shrink-0">
      <p>图片发送结果待核对：请在微信「{{ selectedImage.display_name || selectedImage.username }}」中检查对应的新图片，避免重复发送。</p>
      <div class="flex flex-wrap gap-3 mt-1">
        <button type="button" class="chat-input-image-confirm underline disabled:opacity-40" :disabled="!imageTargetMatches || isSending" @click="confirmImageSent">已在微信确认发送</button>
        <button type="button" class="chat-input-image-retry-ready underline disabled:opacity-40" :disabled="!imageTargetMatches || isSending" @click="allowImageRetry">已核对未发送，允许重试</button>
      </div>
      <details class="mt-1 max-h-20 overflow-y-auto">
        <summary class="cursor-pointer">查看原因</summary>
        <p class="break-words">{{ selectedImage.confirmation.code }}：{{ selectedImage.confirmation.message }}</p>
      </details>
    </div>

    <!-- Action Toolbar -->
    <div class="chat-input-toolbar flex items-center justify-between px-3 py-1 text-xs border-b border-gray-100 dark:border-gray-800/80 select-none shrink-0">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="chat-input-btn-ai inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-[#07c160] hover:bg-[#07c160]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          :disabled="!canAiSuggest"
          :aria-busy="isGeneratingAiReply"
          title="根据最近上下文生成智能回复建议"
          @click="handleAiSuggest"
        >
          <svg v-if="isGeneratingAiReply" class="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span v-else>✨</span>
          <span>{{ isGeneratingAiReply ? '生成中...' : 'AI 建议' }}</span>
        </button>

        <button
          type="button"
          class="chat-input-btn-image inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          :disabled="!canPickImage"
          :aria-busy="isSelectingImage"
          title="选择 PNG 或 JPEG 图片（Windows 桌面版）"
          @click="handlePickImage"
        >
          <span>▧</span>
          <span>{{ isSelectingImage ? '选图中...' : '图片' }}</span>
        </button>

        <button
          type="button"
          class="chat-input-btn-clear inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          :disabled="!canClear"
          title="清空输入框与错误提示"
          @click="clearDraft"
        >
          <span>🗑️</span>
          <span>清空</span>
        </button>
      </div>

      <div class="text-[11px] text-gray-400 dark:text-gray-500">
        Enter 发送，Shift + Enter 换行
      </div>
    </div>

    <!-- Textarea & Send Button -->
    <div class="chat-input-body flex-1 flex flex-col min-h-0 relative px-3 py-1.5">
      <div v-if="selectedImage" class="flex items-center gap-2 mb-1 shrink-0 text-xs">
        <img :src="selectedImage.previewDataUrl" :alt="selectedImage.name" class="chat-input-image-preview w-12 h-10 object-contain rounded border border-gray-200 dark:border-gray-700" />
        <div class="min-w-0 flex-1">
          <div class="truncate">{{ selectedImage.name }}</div>
          <div class="text-gray-500 truncate">{{ imageTargetMatches ? `发送给 ${selectedImage.display_name || selectedImage.username}` : '图片属于原会话，请切回原会话或移除图片' }}</div>
        </div>
        <button type="button" class="chat-input-image-remove px-2 py-1 text-gray-500 disabled:opacity-40" :disabled="isSending || isSelectingImage" aria-label="移除图片" @click="removeImage">移除</button>
      </div>
      <textarea
        ref="textareaRef"
        v-model="draftText"
        class="chat-input-textarea flex-1 w-full resize-none outline-none bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-60 disabled:cursor-not-allowed leading-relaxed overflow-y-auto"
        :placeholder="placeholderText"
        :disabled="isDisabled || isSending"
        rows="2"
        @input="onInput"
        @keydown.enter.exact="onEnter"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
      />

      <div class="chat-input-footer flex items-center justify-end gap-2 pt-1 pb-0.5 shrink-0">
        <button
          v-if="selectedImage"
          type="button"
          class="chat-input-btn-send-image px-3 py-1.5 rounded-md text-xs font-medium border border-[#07c160] text-[#07c160] disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!canSendImage"
          :aria-busy="isSending"
          @click="handleSendImage"
        >发送图片</button>
        <button
          type="button"
          class="chat-input-btn-send inline-flex items-center justify-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium bg-[#07c160] hover:bg-[#06ad56] text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          :disabled="!canSend"
          :aria-busy="isSending"
          @click="handleSend"
        >
          <svg v-if="isSending" class="animate-spin h-3.5 w-3.5 text-white" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span>{{ isSending ? '发送中...' : '发送' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, unref, onMounted, onUnmounted, nextTick } from 'vue'
import { useApi as defaultUseApi } from '~/composables/useApi'

const props = defineProps({
  state: {
    type: Object,
    required: true
  },
  api: {
    type: Object,
    default: null
  }
})

// Resolve API service instance
const getApi = () => {
  if (props.api) return props.api
  if (props.state?.api) return props.state.api
  if (typeof globalThis !== 'undefined' && typeof globalThis.useApi === 'function') {
    return globalThis.useApi()
  }
  return defaultUseApi()
}

// Resizer constants & state
const MIN_HEIGHT = 100
const MAX_HEIGHT = 400
const DEFAULT_HEIGHT = 150
const STORAGE_KEY = 'ui.chat.input_height'

const inputHeight = ref(DEFAULT_HEIGHT)
const textareaRef = ref(null)
const draftText = ref('')
const isSending = ref(false)
const isSelectingImage = ref(false)
const selectedImage = ref(null)
const isGeneratingAiReply = ref(false)
const isComposing = ref(false)
const errorInfo = ref(null)
const aiView = useState('chat-agent-ui', () => ({ selected: {}, drafts: {}, pinned: {} }))

// Computed helpers to extract data from props.state safely
const account = computed(() => {
  const acc = unref(props.state?.selectedAccount)
  if (!acc) return ''
  if (typeof acc === 'object') return String(acc.account || acc.username || '').trim()
  return String(acc).trim()
})

const contact = computed(() => unref(props.state?.selectedContact) || null)
const contactUsername = computed(() => contact.value?.username || '')
const contactDisplayName = computed(() => {
  return contact.value?.name || contact.value?.enterpriseName || contact.value?.remark || contact.value?.nickname || ''
})

const hasAccount = computed(() => !!account.value)
const hasContact = computed(() => !!contactUsername.value)
const isDisabled = computed(() => !hasAccount.value || !hasContact.value)

const placeholderText = computed(() => {
  if (!hasAccount.value) {
    return '未选择解密账号，请先在左侧选择账号'
  }
  if (!hasContact.value) {
    return '未选定会话，请从左侧选择联系人或群聊'
  }
  return '输入消息，Enter 发送，Shift + Enter 换行'
})

const canSend = computed(() => {
  return hasAccount.value && hasContact.value && !isSending.value && !isSelectingImage.value && !!draftText.value.trim()
})

const canPickImage = computed(() => hasAccount.value && hasContact.value && !isSending.value && !isSelectingImage.value && !selectedImage.value?.confirmation)
const imageTargetMatches = computed(() => selectedImage.value?.account === account.value && selectedImage.value?.username === contactUsername.value)
const canSendImage = computed(() => canPickImage.value && !!selectedImage.value && imageTargetMatches.value)

const canAiSuggest = computed(() => {
  return hasAccount.value && hasContact.value && !isSending.value && !isGeneratingAiReply.value
})

const canClear = computed(() => {
  return hasAccount.value && hasContact.value && !isSending.value && (!!draftText.value || !!errorInfo.value)
})

// Auto-resizing textarea logic
const resizeDraft = () => {
  const textarea = textareaRef.value
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.max(28, textarea.scrollHeight)}px`
}

const onInput = () => {
  resizeDraft()
}

// Drag Resizer Handlers
let startY = 0
let startHeight = 0

const onPointerMove = (e) => {
  // Dragging up increases height
  const deltaY = startY - e.clientY
  inputHeight.value = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + deltaY))
}

const onPointerUp = () => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(inputHeight.value))
  } catch {}
}

const startResize = (e) => {
  startY = e.clientY
  startHeight = inputHeight.value
  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }
}

const resetHeight = () => {
  inputHeight.value = DEFAULT_HEIGHT
  try {
    localStorage.setItem(STORAGE_KEY, String(DEFAULT_HEIGHT))
  } catch {}
}

// Keyboard Enter & IME Guard
const onEnter = (e) => {
  if (e.isComposing || isComposing.value) {
    return
  }
  e.preventDefault()
  void handleSend()
}

// Send Message Handler
const handleSend = async () => {
  // Synchronous concurrency lock check
  if (isSending.value) return
  if (!canSend.value) return

  const content = draftText.value.trim()
  if (!content) return

  isSending.value = true
  errorInfo.value = null

  try {
    const api = getApi()
    await api.sendChatMessage({
      account: account.value,
      username: contactUsername.value,
      display_name: contactDisplayName.value || null,
      content: draftText.value
    })

    // Debug-First / Let-It-Fail: Draft is ONLY cleared on successful send!
    draftText.value = ''
    await nextTick()
    resizeDraft()
    textareaRef.value?.focus()

    if (typeof props.state?.refreshSelectedMessages === 'function') {
      props.state.refreshSelectedMessages()
    }
  } catch (err) {
    // Debug-First / Let-It-Fail:
    // Draft text is strictly PRESERVED on error. NEVER cleared!
    const code = err.code || err.data?.code || (typeof err.detail === 'object' ? err.detail?.code : '') || 'SEND_ERROR'
    const message = err.message || err.detail || err.data?.detail || '发送消息失败'
    errorInfo.value = {
      code: String(code),
      message: typeof message === 'object' ? (message.message || message.detail || JSON.stringify(message)) : String(message)
    }
  } finally {
    isSending.value = false
  }
}

const showImageError = (err) => {
  const code = err.code || err.data?.code || (typeof err.detail === 'object' ? err.detail?.code : '') || 'IMAGE_SEND_ERROR'
  const message = err.message || err.detail || err.data?.detail || String(err)
  errorInfo.value = {
    code: String(code),
    message: typeof message === 'object' ? (message.message || message.detail || JSON.stringify(message)) : String(message)
  }
}

const handlePickImage = async () => {
  if (!canPickImage.value) return
  const target = { account: account.value, username: contactUsername.value, display_name: contactDisplayName.value || null }
  isSelectingImage.value = true
  errorInfo.value = null
  try {
    const desktop = window.wechatDesktop
    if (desktop?.platform !== 'win32' || typeof desktop.chooseImage !== 'function') {
      throw Object.assign(new Error('图片发送仅支持 Windows 桌面版，请使用桌面应用选择图片'), { code: 'IMAGE_SEND_UNSUPPORTED' })
    }
    const result = await desktop.chooseImage()
    if (result.canceled) return
    if (account.value !== target.account || contactUsername.value !== target.username) {
      throw Object.assign(new Error('选图期间会话已切换，请在当前会话重新选择图片'), { code: 'IMAGE_TARGET_CHANGED' })
    }
    selectedImage.value = { ...result, ...target }
  } catch (err) {
    showImageError(err)
  } finally {
    isSelectingImage.value = false
  }
}

const removeImage = () => {
  if (isSending.value || isSelectingImage.value) return
  selectedImage.value = null
}

const confirmImageSent = () => {
  if (!selectedImage.value?.confirmation || !imageTargetMatches.value || isSending.value) return
  // User acknowledgement only; no backend success is manufactured and no resend occurs.
  selectedImage.value = null
  if (typeof props.state?.refreshSelectedMessages === 'function') {
    props.state.refreshSelectedMessages()
  }
}

const allowImageRetry = () => {
  if (!selectedImage.value?.confirmation || !imageTargetMatches.value || isSending.value) return
  delete selectedImage.value.confirmation
}

const handleSendImage = async () => {
  if (!canSendImage.value) return
  const image = selectedImage.value
  isSending.value = true
  errorInfo.value = null
  try {
    const receipt = await getApi().sendChatImage({
      account: image.account,
      username: image.username,
      display_name: image.display_name,
      image_path: image.path
    })
    if (receipt?.success !== true) {
      throw Object.assign(new Error('后端未确认图片发送成功，图片已保留，请检查微信后再决定是否重试'), { code: 'WECHAT_SEND_UNCONFIRMED' })
    }
    selectedImage.value = null
    if (account.value === image.account && contactUsername.value === image.username && typeof props.state?.refreshSelectedMessages === 'function') {
      props.state.refreshSelectedMessages()
    }
  } catch (err) {
    showImageError(err)
    if (errorInfo.value.code === 'WECHAT_SEND_UNCONFIRMED') {
      selectedImage.value.confirmation = errorInfo.value
      errorInfo.value = null
    }
  } finally {
    isSending.value = false
  }
}

// AI Reply Suggestion Handler
const handleAiSuggest = async () => {
  if (!canAiSuggest.value) return
  isGeneratingAiReply.value = true
  errorInfo.value = null

  try {
    const api = getApi()
    const choice = aiView.value.modelSelection?.choice
    const res = await api.getAiSuggestedReply({
      account: account.value,
      username: contactUsername.value,
      display_name: contactDisplayName.value || null,
      count: 10,
      ...(choice?.profile_id ? { selected_model: { ...choice } } : {})
    })

    if (res?.suggestion) {
      draftText.value = res.suggestion
      await nextTick()
      resizeDraft()
      textareaRef.value?.focus()
    }
  } catch (err) {
    const code = err.code || err.data?.code || (typeof err.detail === 'object' ? err.detail?.code : '') || 'AI_SUGGEST_ERROR'
    const message = err.message || err.detail || err.data?.detail || '获取 AI 建议失败'
    errorInfo.value = {
      code: String(code),
      message: typeof message === 'object' ? (message.message || message.detail || JSON.stringify(message)) : String(message)
    }
  } finally {
    isGeneratingAiReply.value = false
  }
}

// Clear Draft Handler
const clearDraft = () => {
  if (isSending.value) return
  draftText.value = ''
  errorInfo.value = null
  nextTick(() => {
    resizeDraft()
    textareaRef.value?.focus()
  })
}

// Lifecycle Hooks
onMounted(() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = Number.parseInt(saved, 10)
      if (!Number.isNaN(parsed)) {
        inputHeight.value = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, parsed))
      }
    }
  } catch {}
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }
})

defineExpose({
  draftText,
  isSending,
  isGeneratingAiReply,
  errorInfo,
  inputHeight,
  handleSend,
  handleAiSuggest,
  clearDraft,
  resizeDraft
})
</script>

<style scoped>
.message-input-workspace {
  background-color: var(--chat-page-bg, #ffffff);
  border-top-color: var(--app-border, #e5e7eb);
}
</style>
