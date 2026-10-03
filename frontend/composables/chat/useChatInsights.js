import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { agentModelSelection } from '../../lib/agent-model-selection'

const modelKey = choice => JSON.stringify(['profile_id', 'model_id', 'reasoning_effort', 'thinking_mode', 'thinking_budget'].map(key => choice[key] ?? null))

export function useChatInsights({ account, contact, open, api, shared }) {
  const end = Math.floor(Date.now() / 1000)
  const range = reactive({ start: end - 7 * 86400, end })
  const engine = ref('laya')
  const localModel = ref(null), localLoading = ref(false), localBusy = ref(false), localError = ref(''), localModelPath = ref('')
  const selectedMember = ref(''), members = ref([]), membersLoading = ref(false)
  const tasks = ref([]), activeTask = ref(null), labels = ref({}), labelsEnabled = ref(false)
  const includeHidden = ref(false), historyConfirmation = ref(''), historyNotice = ref('')
  const loading = ref(false), busy = ref(false), error = ref('')
  const profiles = ref([]), profilesLoading = ref(false), profilesError = ref('')
  const modelSelection = agentModelSelection(shared, api.request)
  const modelChoice = computed({ get: () => modelSelection.state.choice, set: value => { void modelSelection.choose(value) } })
  const running = computed(() => ['queued', 'running'].includes(activeTask.value?.status))
  const member = computed({
    get: () => selectedMember.value,
    set: value => {
      if (value === selectedMember.value) return
      if (busy.value || running.value) { error.value = '当前分析尚未结束，请等待完成或取消后再切换分析对象。'; return }
      selectedMember.value = value
    },
  })
  const scope = computed(() => JSON.stringify([account.value, contact.value?.username, member.value, engine.value, engine.value === 'api' ? modelChoice.value : null]))
  let generation = 0, selected = 0, detailRequest = 0, labelRequest = 0, memberRequest = 0, profilesRequest = 0, historyRequest = 0
  let disposed = false, refreshing = false, refreshQueued = false, closeEvents, timer, localRequest = 0
  const invalidateDetail = () => { detailRequest++; refreshing = false; refreshQueued = false }
  const current = ticket => !disposed && ticket === generation
  const query = () => ({ account: account.value, username: contact.value.username, member_username: member.value, engine: engine.value })
  const showError = (err, ticket) => { if (current(ticket)) error.value = `${err.message}${err.diagnostic_id ? ` · 诊断 ${err.diagnostic_id}` : ''}` }
  const loadProfiles = async () => {
    const ticket = ++profilesRequest, modelTicket = modelSelection.beginLoad()
    profilesLoading.value = true; profilesError.value = ''
    try {
      const data = await api.request('/settings')
      if (disposed || ticket !== profilesRequest) return
      if (!Array.isArray(data.profiles)) throw new Error('模型配置返回格式异常')
      profiles.value = data.profiles; modelSelection.loaded(data, modelTicket)
    } catch (err) { if (!disposed && ticket === profilesRequest) profilesError.value = err.message }
    finally { if (!disposed && ticket === profilesRequest) profilesLoading.value = false }
  }
  const requestLocalModel = async (action, body) => {
    if (localBusy.value || (!action && localLoading.value)) return
    const request = ++localRequest
    localLoading.value = !action; localBusy.value = Boolean(action); localError.value = ''
    try {
      const status = await api.request(`/insights/local-model${action ? `/${action}` : ''}`, action ? { method: 'POST', ...(body ? { body } : {}) } : undefined)
      if (disposed || request !== localRequest) return
      if (!['missing', 'downloading', 'verifying', 'ready', 'paused', 'failed'].includes(status.state) || !Number.isFinite(status.total_bytes) || !Number.isFinite(status.downloaded_bytes)) throw new Error('本地模型状态返回格式异常')
      localModel.value = status
    } catch (err) { if (!disposed && request === localRequest) localError.value = `${err.message}${err.diagnostic_id ? ` · 诊断 ${err.diagnostic_id}` : ''}` }
    finally { if (!disposed && request === localRequest) { localLoading.value = false; localBusy.value = false } }
  }
  const loadLocalModel = () => requestLocalModel()
  const downloadLocalModel = () => requestLocalModel('download')
  const pauseLocalModel = () => requestLocalModel('pause')
  const importLocalModel = () => {
    if (!localModelPath.value.trim()) { localError.value = '请填写已有模型目录'; return }
    return requestLocalModel('import', { path: localModelPath.value.trim() })
  }
  const loadLabels = async () => {
    const task = activeTask.value, ticket = generation, version = selected, request = ++labelRequest
    if (!task || !labelsEnabled.value) return
    try {
      const result = {}; let offset = 0, total
      do {
        const page = await api.request(`/insights/tasks/${encodeURIComponent(task.id)}/messages`, { query: { account: account.value, limit: 100, offset } })
        if (!current(ticket) || version !== selected || request !== labelRequest || !labelsEnabled.value) return
        if (!Array.isArray(page.items) || !Number.isInteger(page.total) || page.total < 0) throw new Error('消息标签分页返回格式异常')
        for (const label of page.items) result[label.identity] = label
        offset += page.items.length; total = page.total
        if (!page.items.length && offset < total) throw new Error('消息标签分页中断，未返回声明的全部记录')
      } while (offset < total)
      labels.value = result
    } catch (err) { if (version === selected && request === labelRequest) showError(err, ticket) }
  }
  const adopt = async task => {
    invalidateDetail()
    selected++; labelRequest++; labels.value = {}; activeTask.value = task
    await loadLabels()
  }
  const refresh = async () => {
    if (refreshing) { refreshQueued = true; return }
    const task = activeTask.value, ticket = generation, version = selected, request = ++detailRequest
    if (!task) return
    refreshing = true
    try {
      const detail = await api.request(`/insights/tasks/${encodeURIComponent(task.id)}`, { query: { account: account.value } })
      if (!current(ticket) || version !== selected || request !== detailRequest) return
      activeTask.value = detail
      tasks.value = tasks.value.map(t => t.id === detail.id ? detail : t)
      await loadLabels()
    } catch (err) { if (version === selected && request === detailRequest) showError(err, ticket) }
    finally {
      if (request === detailRequest) {
        refreshing = false
        if (refreshQueued && current(ticket) && version === selected) { refreshQueued = false; void refresh() }
      }
    }
  }
  const loadHistory = async () => {
    const ticket = generation, version = selected, request = ++historyRequest
    if (!account.value || !contact.value?.username) return
    const taskId = activeTask.value?.id, selectedScope = query(), selectedModel = engine.value === 'api' ? { ...modelChoice.value } : null
    historyConfirmation.value = ''
    loading.value = true; error.value = ''
    try {
      const data = await api.request('/insights/tasks', { query: { ...selectedScope, include_hidden: includeHidden.value, limit: 50, offset: 0 } })
      if (!current(ticket) || version !== selected || request !== historyRequest) return
      if (!Array.isArray(data)) throw new Error('画像历史返回格式异常')
      // 升级前任务未存 engine；这些任务明确属于 API 模式。
      tasks.value = data.filter(t => (t.engine ?? 'api') === engine.value)
      if (taskId) {
        const currentTask = tasks.value.find(t => t.id === taskId)
        if (currentTask) await adopt(currentTask)
        return
      }
      if (selectedModel && (!selectedModel.profile_id || !selectedModel.model_id)) return
      const saved = await api.request('/insights/tasks', { query: { ...selectedScope, include_hidden: true, limit: 1, offset: 0,
        ...(selectedModel ? { selected_model: JSON.stringify(selectedModel) } : {}) } })
      if (!current(ticket) || version !== selected || request !== historyRequest) return
      if (!Array.isArray(saved)) throw new Error('已保存画像返回格式异常')
      const restored = saved.find(t => (t.engine ?? 'api') === selectedScope.engine && (!selectedModel || modelKey(t.selected_model) === modelKey(selectedModel)))
      if (restored) await adopt(restored)
    } catch (err) { if (version === selected && request === historyRequest) showError(err, ticket) }
    finally { if (current(ticket) && request === historyRequest) loading.value = false }
  }
  const selectTask = async id => {
    invalidateDetail()
    const ticket = generation, version = ++selected
    labelRequest++; labels.value = {}; activeTask.value = null; error.value = ''; historyConfirmation.value = ''
    try {
      const task = await api.request(`/insights/tasks/${encodeURIComponent(id)}`, { query: { account: account.value } })
      if (!current(ticket) || version !== selected) return
      await adopt(task)
    } catch (err) { if (version === selected) showError(err, ticket) }
  }
  const removeHistory = async (all = false) => {
    if (busy.value) return
    if (!all && (!activeTask.value || running.value)) { error.value = '请先完成或取消当前分析，再移除历史记录。'; return }
    const ticket = generation, version = selected, task = activeTask.value, selectedScope = query()
    historyRequest++; invalidateDetail()
    busy.value = true; loading.value = false; error.value = ''; historyNotice.value = ''; historyConfirmation.value = ''
    try {
      const result = await api.request(all ? '/insights/tasks/history' : `/insights/tasks/${encodeURIComponent(task.id)}/history`, {
        method: 'DELETE', query: all ? selectedScope : { account: selectedScope.account },
      })
      if (!current(ticket) || version !== selected) return
      if (!Number.isInteger(result.removed) || result.removed < 0) throw new Error('移除画像历史返回格式异常')
      invalidateDetail()
      if (task && !['queued', 'running'].includes(task.status)) activeTask.value = { ...activeTask.value, history_hidden: true }
      historyNotice.value = `已移除 ${result.removed} 条历史入口，分析结果已保留。`
      await loadHistory()
    } catch (err) { if (version === selected) showError(err, ticket) }
    finally { if (current(ticket)) busy.value = false }
  }
  const create = async (force = false) => {
    if (busy.value || running.value) return
    const ticket = generation, version = ++selected
    invalidateDetail()
    busy.value = true; error.value = ''
    try {
      if (!account.value || !contact.value?.username) throw new Error('请选择账号和聊天')
      if (engine.value === 'api' && (!modelChoice.value.profile_id || !profiles.value.some(p => p.id === modelChoice.value.profile_id))) throw new Error('请先选择可用模型')
      if (engine.value === 'laya' && localModel.value?.state !== 'ready') throw new Error('本地模型尚未就绪，请先下载或导入并完成校验')
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start) throw new Error('结束时间必须晚于开始时间')
      const task = await api.request('/insights/tasks', { method: 'POST', body: { ...query(), start: range.start, end: range.end, selected_model: engine.value === 'api' ? { ...modelChoice.value } : null, reuse_existing: !force } })
      if (!current(ticket) || version !== selected) return
      includeHidden.value = false; historyConfirmation.value = ''; historyNotice.value = ''
      tasks.value = [task, ...tasks.value.filter(item => !item.history_hidden)]; await adopt(task)
    } catch (err) { if (version === selected) showError(err, ticket) }
    finally { if (current(ticket)) busy.value = false }
  }
  const cancel = async () => {
    if (busy.value || !running.value) return
    const ticket = generation, version = ++selected, task = activeTask.value
    invalidateDetail()
    busy.value = true; error.value = ''
    try {
      const result = await api.request(`/insights/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', query: { account: account.value } })
      if (current(ticket) && version === selected) { activeTask.value = result; await loadLabels() }
    } catch (err) { if (version === selected) showError(err, ticket) }
    finally { if (current(ticket)) busy.value = false }
  }
  const loadMembers = async () => {
    const ticket = generation, request = ++memberRequest
    membersLoading.value = true; error.value = ''
    try {
      const data = await api.request('/insights/members', { query: { account: account.value, username: contact.value.username } })
      if (!current(ticket) || request !== memberRequest) return
      if (!Array.isArray(data) || data.some(m => typeof m.username !== 'string' || typeof m.displayName !== 'string')) throw new Error('群成员返回格式异常')
      members.value = data
    } catch (err) { if (request === memberRequest) showError(err, ticket) }
    finally { if (current(ticket) && request === memberRequest) membersLoading.value = false }
  }
  const connect = () => {
    closeEvents?.(); closeEvents = undefined
    if (!open.value || !account.value) return
    const ticket = generation
    closeEvents = api.events(account.value, event => {
      if (current(ticket) && event.kind === 'insight' && event.body.task_id === activeTask.value?.id) void refresh()
    })
  }
  watch([account, () => contact.value?.username], () => { selectedMember.value = ''; members.value = []; membersLoading.value = false; labelsEnabled.value = false }, { flush: 'sync' })
  watch(scope, () => {
    invalidateDetail()
    generation++; selected++; labelRequest++; activeTask.value = null; tasks.value = []; labels.value = {}; busy.value = false; loading.value = false; membersLoading.value = false; error.value = ''
    includeHidden.value = false; historyConfirmation.value = ''; historyNotice.value = ''
    connect(); if (open.value) void loadHistory()
  }, { flush: 'sync' })
  const loadEngine = () => { if (engine.value === 'api') void loadProfiles(); else void loadLocalModel() }
  watch(engine, () => {
    profilesRequest++; profilesLoading.value = false
    if (open.value) loadEngine()
  })
  watch(open, value => { connect(); if (value) { loadEngine(); void loadHistory() } })
  watch(labelsEnabled, value => { labelRequest++; if (value) void loadLabels(); else labels.value = {} })
  onMounted(() => {
    if (open.value) { connect(); loadEngine(); void loadHistory() }
    timer = setInterval(() => {
      if (open.value && running.value) void refresh()
      if (open.value && engine.value === 'laya' && ['downloading', 'verifying'].includes(localModel.value?.state)) void loadLocalModel()
    }, 3000)
  })
  onUnmounted(() => { disposed = true; generation++; closeEvents?.(); clearInterval(timer) })
  return { range, engine, localModel, localLoading, localBusy, localError, localModelPath, loadLocalModel, downloadLocalModel, pauseLocalModel, importLocalModel,
    member, members, membersLoading, tasks, activeTask, labels, labelsEnabled, loading, busy, error, running,
    includeHidden, historyConfirmation, historyNotice, removeHistory,
    profiles, profilesLoading, profilesError, modelSelection, modelChoice, loadProfiles, loadHistory, loadMembers, selectTask, create, cancel, refresh }
}
