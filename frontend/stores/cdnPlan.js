import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

// The backend snapshot is authoritative. Account selection invalidates all older requests.
export const useCdnPlanStore = defineStore('cdnPlan', () => {
  const snapshot = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const fetchedAt = ref(0)
  const account = ref('')
  let revision = 0

  const connected = computed(() => !!snapshot.value?.connected && !!snapshot.value?.account)
  const frozen = computed(() => !!snapshot.value?.frozen)
  const lockedUntil = computed(() => Math.max(
    Number(snapshot.value?.redeemLockedUntil || 0), Number(error.value?.lockedUntil || 0)
  ))
  const exhausted = computed(() => {
    const quota = snapshot.value?.quota
    return quota?.remainingBytes != null && Number(quota.remainingBytes) <= 0
  })

  const selectAccount = (value) => {
    account.value = String(value || '').trim()
    revision += 1
    snapshot.value = null
    error.value = null
    fetchedAt.value = 0
    loading.value = false
  }

  const request = async (action, value, options) => {
    const selected = String(value || '').trim()
    if (!selected) throw new Error('请先选择账号')
    if (selected !== account.value) selectAccount(selected)
    if (loading.value) throw new Error('媒体服务正在处理请求')
    const current = ++revision
    loading.value = true
    error.value = null
    const api = useApi()
    try {
      let result
      if (action === 'refresh') result = await api.getCdnPlan(selected, options)
      else if (action === 'connect') result = await api.connectCdn(selected)
      else result = await api.redeemCdnCode(selected, options)
      const next = action === 'redeem' ? result.snapshot : result
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        throw new TypeError('媒体服务未返回有效状态快照')
      }
      if (current === revision) {
        snapshot.value = next
        error.value = next.error || null
        fetchedAt.value = Date.now()
      }
      return result
    } catch (failure) {
      if (current === revision) {
        error.value = {
          code: failure.code,
          message: failure.message,
          retryAfterSeconds: failure.detail?.retryAfterSeconds,
          lockedUntil: failure.detail?.lockedUntil,
        }
      }
      throw failure
    } finally {
      if (current === revision) loading.value = false
    }
  }

  const refresh = (value, { refresh = false } = {}) => request('refresh', value, { refresh })
  const connect = (value) => request('connect', value)
  const redeem = (value, code) => request('redeem', value, code)

  return { snapshot, loading, error, fetchedAt, account, connected, frozen, lockedUntil, exhausted, selectAccount, refresh, connect, redeem }
})
