import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

export const useSnapshotRefresh = ({ api, selectedAccount, active, onPublished, getDisplayedGeneration }) => {
  const status = ref(null)
  const loading = ref(false)
  const error = ref('')
  const paused = ref(false)
  const manualRefreshPending = ref(false)
  const commandPending = ref(false)
  const enabled = computed(() => !!status.value?.enabled)
  const otherAccount = computed(() => {
    const account = status.value?.active_account
    return account && account !== selectedAccount.value ? account : ''
  })
  const syncing = computed(() => !paused.value && (commandPending.value || manualRefreshPending.value
    || !!status.value?.running || !!otherAccount.value || (loading.value && !status.value)))
  let mounted = false
  let requestVersion = 0
  let controller = null
  let timer = null
  let appliedRevision = null
  let appliedArchiveGeneration = null
  let viewRefreshRequired = false
  let stoppingAccount = ''
  let pending = null
  let inFlight = null
  let subscription = null
  let subscriptionToken = null

  const closeSubscription = () => {
    subscription?.close()
    subscription = null
    subscriptionToken = null
  }

  const cancel = () => {
    ++requestVersion
    clearTimeout(timer)
    timer = null
    pending = null
    controller?.abort()
    controller = null
    loading.value = false
    commandPending.value = false
    closeSubscription()
  }

  const update = async ({ account, version, manual, refreshView }) => {
    const requestController = new AbortController()
    controller = requestController
    const current = () => version === requestVersion && account === selectedAccount.value && active.value && mounted
    if (!current() || (paused.value && !manual)) return
    if (manual) {
      error.value = ''
      paused.value = false
      manualRefreshPending.value = true
    }
    clearTimeout(timer)
    loading.value = true
    try {
      const params = { account, signal: requestController.signal }
      let response = await api.getSnapshotRefreshStatus(params)
      if (!current()) return
      if (response.account !== account) throw new Error('同步状态返回的账号与请求账号不一致')
      if (typeof response.refresh_available !== 'boolean') throw new Error('同步状态缺少 refresh_available 字段')
      status.value = response
      if (appliedRevision === null) appliedRevision = response.revision

      // A cancelled HTTP request cannot undo an accepted backend command.
      // The queue awaits each POST without a view-scoped abort signal before
      // reconciling the most recently selected account.
      if (otherAccount.value) {
        if (stoppingAccount !== otherAccount.value) {
          stoppingAccount = otherAccount.value
          commandPending.value = true
          await api.stopSnapshotRefresh({ account: stoppingAccount })
        }
        return
      }
      stoppingAccount = ''
      if (response.error && !manual) {
        throw new Error([response.error.stage, response.error.type, response.error.message].filter(Boolean).join(' · '))
      }
      if (response.refresh_available) {
        if (manual && response.user_paused && response.running) {
          throw new Error('当前同步任务尚未结束，请稍后重试恢复。')
        }
        if (!response.enabled && !response.running && (!response.user_paused || manual)) {
          commandPending.value = true
          response = await api.startSnapshotRefresh({ account, interval_seconds: 30, ...(manual ? { resume: true } : {}) })
        } else if (manual && !response.running) {
          commandPending.value = true
          response = await api.refreshSnapshotOnce({ account })
        }
        if (!current()) return
        if (response.account !== account) throw new Error('同步状态返回的账号与请求账号不一致')
        status.value = response
        if (response.error) {
          throw new Error([response.error.stage, response.error.type, response.error.message].filter(Boolean).join(' · '))
        }
        if (!subscription) {
          const token = Symbol('snapshot-subscription')
          subscriptionToken = token
          subscription = api.subscribeSnapshotRefresh({
            account,
            onChange: () => { if (current() && subscriptionToken === token && !paused.value) void request() },
            onError: (cause) => {
              if (!current() || subscriptionToken !== token) return
              cancel()
              error.value = cause.message
              paused.value = true
              manualRefreshPending.value = false
            },
          })
        }
      }
      const displayedGeneration = getDisplayedGeneration?.()
      const windowMismatch = displayedGeneration != null
        && displayedGeneration !== (response.generation ?? 'legacy')
      const completedManualRefresh = manualRefreshPending.value && !response.running
      const canApplyView = !manualRefreshPending.value || !response.running
      // A publication and its completed anti-revoke archive are separate content
      // changes. Initial/repeated notifications only request a status check.
      // Apply an existing archive once too: it may have completed while the
      // initial message window was still loading the same snapshot generation.
      const contentChanged = response.revision !== appliedRevision || response.archive_generation !== appliedArchiveGeneration
      if (canApplyView && (viewRefreshRequired || windowMismatch || refreshView || completedManualRefresh || contentChanged)) {
        viewRefreshRequired = true
        await onPublished({ account, revision: response.revision, generation: response.generation, signal: requestController.signal })
        if (!current()) return
        appliedRevision = response.revision
        appliedArchiveGeneration = response.archive_generation
        viewRefreshRequired = false
        if (completedManualRefresh) manualRefreshPending.value = false
      }
    } catch (cause) {
      if (!current() || requestController.signal.aborted) return
      error.value = [cause.detail?.stage, cause.message].filter(Boolean).join(' · ')
      paused.value = true
      closeSubscription()
      stoppingAccount = ''
      manualRefreshPending.value = false
    } finally {
      if (current()) {
        loading.value = false
        commandPending.value = false
        controller = null
        if (!paused.value && (status.value?.enabled || status.value?.running || status.value?.active_account)) {
          // Status polling reports progress and control completion. Publication
          // notifications independently refresh the view as soon as it changes.
          timer = setTimeout(() => { void request() }, 1500)
        }
      }
    }
  }

  const request = (manual = false, refreshView = false) => {
    if (!mounted || !active.value || !selectedAccount.value || (paused.value && !manual)) return Promise.resolve()
    clearTimeout(timer)
    timer = null
    if (manual) {
      error.value = ''
      paused.value = false
      manualRefreshPending.value = true
    }
    pending = {
      account: selectedAccount.value, version: requestVersion,
      manual: manual || !!pending?.manual,
      refreshView: refreshView || !!pending?.refreshView
    }
    if (!inFlight) {
      inFlight = (async () => {
        try {
          while (pending) {
            const next = pending
            pending = null
            await update(next)
          }
        } finally {
          inFlight = null
        }
      })()
    }
    return inFlight
  }

  watch(selectedAccount, () => {
    cancel()
    status.value = null
    error.value = ''
    paused.value = false
    manualRefreshPending.value = false
    appliedRevision = null
    appliedArchiveGeneration = null
    viewRefreshRequired = false
    stoppingAccount = ''
    void request()
  }, { flush: 'sync' })
  watch(active, (value) => {
    cancel()
    if (value) void request()
  }, { flush: 'sync' })
  if (getDisplayedGeneration) {
    watch(getDisplayedGeneration, (generation) => {
      if (status.value && generation != null
        && generation !== (status.value.generation ?? 'legacy')) void request()
    })
  }
  onMounted(() => {
    mounted = true
    void request()
  })
  onUnmounted(() => {
    mounted = false
    cancel()
    // The backend keeps the selected account current for other app pages.
    // It stops on backend shutdown or before syncing another selected account.
  })

  return {
    status, loading, error, paused, enabled, otherAccount, syncing,
    manualRefreshing: manualRefreshPending,
    refreshOnce: () => request(true),
    refreshView: () => request(false, true),
    retry: () => request(true),
  }
}
