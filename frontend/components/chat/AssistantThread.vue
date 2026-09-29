<template>
  <div ref="host" class="agent-assistant-thread" data-chat-library="ai-elements-vue">
    <Conversation v-if="mounted" ref="conversation" class="agent-thread-root" :initial="false" resize="instant" aria-label="AI 对话" @scroll.capture="onScroll" @wheel.capture.passive="onWheel" @keydown.capture="onKeydown" @touchstart.capture.passive="onTouchStart" @touchmove.capture.passive="onTouchMove">
      <ConversationContent class="agent-message-list">
        <slot v-if="!messages.length" name="welcome" />
        <Message v-for="message in messages" :key="message.id" :from="message.role" class="agent-message">
          <slot name="message" :message="message" />
        </Message>
      </ConversationContent>
    </Conversation>
  </div>
</template>
<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import Conversation from '../ai-elements/conversation/Conversation.vue'
import ConversationContent from '../ai-elements/conversation/ConversationContent.vue'
import Message from '../ai-elements/message/Message.vue'
const props = defineProps({ messages: { type: Array, default: () => [] }, running: Boolean, expanded: Boolean })
const emit = defineEmits(['scroll', 'ready'])
const host = ref(null), mounted = ref(false)
const conversation = ref(null)
let viewport, lastTop = 0, downwardUntil = 0, hideTimer, touchY = null
const hideScrollbar = () => { clearTimeout(hideTimer); viewport?.classList.remove('is-scrolling-down') }
const scrollIntent = down => {
  downwardUntil = down ? Date.now() + 1200 : 0
  if (!down) hideScrollbar()
}
const onWheel = event => { if (event.deltaY && !event.ctrlKey) scrollIntent(event.deltaY > 0) }
const onKeydown = event => {
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return
  if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || (event.key === ' ' && !event.shiftKey)) scrollIntent(true)
  else if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) scrollIntent(false)
}
const onTouchStart = event => { touchY = event.touches[0]?.clientY ?? null }
const onTouchMove = event => {
  const nextY = event.touches[0]?.clientY
  if (touchY != null && nextY != null && nextY !== touchY) scrollIntent(nextY < touchY)
  touchY = nextY ?? null
}
const onScroll = event => {
  if (event.target !== viewport) return
  const top = viewport.scrollTop
  if (props.expanded && top > lastTop && Date.now() < downwardUntil) {
    viewport.classList.add('is-scrolling-down')
    clearTimeout(hideTimer)
    hideTimer = setTimeout(hideScrollbar, 800)
  } else if (top < lastTop) hideScrollbar()
  lastTop = top
  emit('scroll', event)
}
watch(() => props.expanded, () => { downwardUntil = 0; lastTop = viewport?.scrollTop || 0; hideScrollbar() })
onUnmounted(hideScrollbar)
// 后端消息 ID 决定节点生命周期；只由 Conversation 管理自动跟随滚动。
onMounted(async () => {
  mounted.value = true
  await nextTick()
  viewport = conversation.value?.getViewport()
  lastTop = viewport?.scrollTop || 0
  if (viewport) { viewport.classList.add('agent-conversation'); emit('ready', viewport) }
})
</script>
