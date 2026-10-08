<template>
  <main class="theme-scope h-screen flex flex-col min-h-0 min-w-0 overflow-hidden">
    <ErrorNotice v-if="chatAccounts.error" :message="chatAccounts.error" class="m-4" />
    <p v-else-if="chatAccounts.loading && !selectedAccount" class="p-4 text-sm text-gray-500" role="status">正在加载账号…</p>
    <ChatAgentPanel v-else-if="selectedAccount" presentation="page" :account="selectedAccount" :prepare-source="prepareSource" :locate-source="locateSource" />
    <p v-else class="p-4 text-sm text-gray-500">请先选择已解密或已导入的微信账号。</p>
  </main>
</template>

<script setup>
import { onMounted, onUnmounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { isNavigationFailure } from 'vue-router'
import ChatAgentPanel from '~/components/chat/ChatAgentPanel.vue'
import { useChatAccountsStore } from '~/stores/chatAccounts'
import { useApi } from '~/composables/useApi'
import { createAnchorContextCache } from '~/utils/anchorContextCache'

useHead({ title: 'AI 助手 - xwechat' })
const chatAccounts = useChatAccountsStore()
const { selectedAccount } = storeToRefs(chatAccounts)
const api = useApi()
const navigation = useState('ai-navigation-target', () => null)
const sourceCache = createAnchorContextCache(async params => {
  const response = await api.getChatMessagesAround(params)
  if (!response?.messages?.length) throw new Error('未找到原消息，记录可能已更新或移除')
  return response
})
const sourceTarget = source => {
  if (!selectedAccount.value) throw new Error('请先选择聊天账号')
  if (!source?.username || !source?.anchor) throw new Error('该来源缺少定位信息')
  return { ...source, kind: 'source', account: selectedAccount.value }
}
const prepareSource = source => {
  const target = sourceTarget(source)
  return sourceCache.read({ account: target.account, username: target.username, anchor_id: target.anchor, before: 35, after: 35, source: 'auto', ai_diagnostic: true })
}
const locateSource = async source => {
  navigation.value = sourceTarget(source)
  const target = navigation.value
  try {
    const result = await navigateTo('/chat')
    if (result === false || isNavigationFailure(result)) throw new Error('未能打开聊天原消息，请重试定位')
    return true
  } catch (error) {
    if (navigation.value === target) navigation.value = null
    throw error
  }
}
watch(selectedAccount, () => sourceCache.clear(), { flush: 'sync' })
onUnmounted(() => sourceCache.clear())
onMounted(() => chatAccounts.ensureLoaded())
</script>
