<template>
  <section class="px-3.5 py-3 text-[12px] text-[#555]" aria-label="媒体下载服务">
    <h3 class="text-[13px] font-medium text-[#222]">媒体下载服务</h3>
    <p class="mt-1 text-[#777]">WxCDN 用于补下载本地缺失的媒体，联网下载受服务额度限制。</p>
    <p v-if="!account" class="mt-2">请先选择账号</p>
    <template v-else>
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5" aria-live="polite">
        <dt>连接状态</dt><dd>{{ connectionText }}</dd>
        <dt>{{ store.error ? '上次已知剩余额度' : '剩余额度' }}</dt><dd>{{ remainingText }}</dd>
        <dt>重置时间</dt><dd>{{ resetText }}</dd>
      </dl>
      <p v-if="store.error" role="alert" class="mt-2 break-words text-red-700">
        {{ store.error.message }}<span v-if="store.error.code">（{{ store.error.code }}）</span>
      </p>
      <p v-if="store.error?.retryAfterSeconds != null" class="mt-1">服务建议等待 {{ store.error.retryAfterSeconds }} 秒后手动重试。</p>
      <p v-if="locked" class="mt-1 text-amber-700">兑换已锁定至 {{ dateTime(store.lockedUntil) }}，不影响已有下载能力。</p>
    </template>
    <div class="mt-3 flex flex-wrap gap-2">
      <button type="button" class="media-service-button" :disabled="!account || store.loading" @click="run('refresh')">刷新状态</button>
      <button type="button" class="media-service-button" :disabled="!account || store.loading" @click="run('connect')">{{ store.connected ? '重新连接' : '连接' }}</button>
    </div>
    <form class="mt-3" @submit.prevent="submitCode">
      <label for="media-redeem-code" class="block">兑换已有兑换码</label>
      <div class="mt-1 flex flex-wrap gap-2">
        <input id="media-redeem-code" v-model="codeInput" type="text" autocomplete="off" spellcheck="false"
          aria-describedby="media-redeem-hint" :disabled="!account || store.loading || locked"
          class="min-w-0 flex-1 rounded border border-[#ddd] bg-white px-2 py-1.5 font-mono"
          placeholder="wx-XXXX-XXXX-XXXX-XXXX-XXXX">
        <button type="submit" class="media-service-button" :disabled="!canRedeem">兑换</button>
      </div>
      <p id="media-redeem-hint" class="mt-1 text-[#777]">需要 20 位有效字符，可粘贴含 wx- 前缀和分隔符的兑换码。提交失败不会自动重试。</p>
      <p v-if="notice" role="status" class="mt-2 text-[#078446]">{{ notice }}</p>
    </form>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useCdnPlanStore } from '~/stores/cdnPlan'
import { fmtB, normalizeRedeemCode } from '~/lib/media-service-format.js'

const props = defineProps({ account: { type: String, required: true } })
const store = useCdnPlanStore()
const codeInput = ref('')
const notice = ref('')
const now = ref(Date.now() / 1000)
let viewRevision = 0
let timer
onMounted(() => { timer = setInterval(() => { now.value = Date.now() / 1000 }, 1000) })
const locked = computed(() => store.lockedUntil > now.value)
const normalizedCode = computed(() => normalizeRedeemCode(codeInput.value).code)
const canRedeem = computed(() => !!props.account && !store.loading && !locked.value && normalizedCode.value.length === 20)
const connectionText = computed(() => store.loading ? '正在读取…' : store.error ? '状态查询失败' : store.frozen ? '已冻结' : store.connected ? '已连接' : '未连接')
const remainingText = computed(() => {
  const quota = store.snapshot?.quota
  if (quota?.remainingBytes != null) return fmtB(quota.remainingBytes)
  if (quota?.limitBytes === null && quota?.period === 'lifetime') return '不限量'
  return '未知'
})
const dateTime = seconds => new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })
const resetText = computed(() => {
  const quota = store.snapshot?.quota
  if (quota?.resetsAt != null) return dateTime(quota.resetsAt)
  return quota?.period === 'lifetime' ? '不重置' : '未知'
})

const run = async (action, refresh = true) => {
  if (!props.account || store.loading) return
  const current = viewRevision
  notice.value = ''
  try {
    if (action === 'refresh') await store.refresh(props.account, { refresh })
    else if (action === 'connect') await store.connect(props.account)
    else await store.redeem(props.account, normalizedCode.value)
    if (current === viewRevision && action === 'redeem' && !store.error) {
      codeInput.value = ''
      notice.value = '兑换成功，额度已更新。'
    }
  } catch (failure) {
    // Known request failures are visible in store.error. Log unexpected failures
    // without request bodies, account identifiers, tokens, or exception messages.
    if (!failure.code && !failure.status) {
      console.error('[media-service] unexpected failure', {
        action, name: failure.name, stack: failure.stack?.split('\n').slice(1).join('\n'),
      })
    }
  }
}
const submitCode = () => { if (canRedeem.value) return run('redeem') }
watch(() => props.account, account => {
  viewRevision += 1
  codeInput.value = ''
  notice.value = ''
  store.selectAccount(account)
  if (account) void run('refresh', false)
}, { immediate: true })
onUnmounted(() => {
  clearInterval(timer)
  viewRevision += 1
  store.selectAccount('')
})
</script>

<style scoped>
.media-service-button { border: 1px solid #ddd; border-radius: 6px; background: #fafafa; color: #222; padding: 5px 10px; }
.media-service-button:hover:not(:disabled) { background: #f0f0f0; }
.media-service-button:disabled { opacity: .45; cursor: not-allowed; }
</style>
