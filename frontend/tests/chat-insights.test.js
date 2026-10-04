import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, reactive, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatInsights } from '../composables/chat/useChatInsights'
import ChatInsightsPanel from '../components/chat/ChatInsightsPanel.vue'

const choice = { profile_id: 'p', model_id: 'm', reasoning_effort: null }
const localModel = (state = 'ready') => ({ id: 'laya', name: 'Laya', revision: 'revision', license: 'Apache-2.0', total_bytes: 681000000, downloaded_bytes: state === 'ready' ? 681000000 : 100, state, error: null, path: 'G:\\models\\laya', device: 'cpu', context_window: 1024 })
const task = (id = 'one', overrides = {}) => ({ id, account: 'acc', username: 'friend', member_username: '', start: 1, end: 2, selected_model: choice, model: { model: 'm' }, status: 'completed', stage: '完成', progress: { read: 10, analyzed: 10, batches: 1 }, coverage: { total: 10, text: 10, skipped: 0, target_text: 10, participants: 2 }, data_source: 'realtime', portrait: null, error: null, references: [], ...overrides })
const wrappers = []
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.useRealTimers() })
function setup(handler = async () => [], renderPanel = false, keepAlive = false) {
  const account = ref('acc'), contact = ref({ username: 'friend' }), open = ref(false)
  const request = vi.fn(async (path, options) => path === '/settings' ? { profiles: [{ id: 'p' }], selected_model: choice } : handler(path, options))
  let event
  const closeEvents = vi.fn(), visible = ref(true)
  const events = vi.fn((account, callback) => { event = callback; return closeEvents })
  let state
  const component = defineComponent({ setup() {
    state = useChatInsights({ account, contact, open, api: { request, events }, shared: reactive({}) })
    return () => renderPanel ? h(ChatInsightsPanel, { state, contact: contact.value, showSettings: true }) : null
  } })
  const wrapper = mount(keepAlive ? defineComponent({ setup: () => () => h(KeepAlive, null, () => visible.value ? h(component) : null) }) : component, { global: { stubs: { AgentModelPicker: true } } })
  wrappers.push(wrapper)
  return { account, contact, open, request, state, wrapper, visible, closeEvents, event: value => event(value) }
}

describe('缓存聊天页的画像生命周期', () => {
  it('离开时关闭订阅与轮询，返回恢复当前任务结果而不创建或取消分析', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let saved = task('saved', { engine: 'api', status: 'running' })
    const c = setup(async path => path === '/insights/tasks' ? [saved] : saved, false, true)
    c.state.engine.value = 'api'; c.open.value = true; await flushPromises()
    expect(c.state.activeTask.value.id).toBe('saved')
    const selectedModel = c.state.modelChoice.value, previousTask = c.state.activeTask.value
    c.closeEvents.mockClear(); c.visible.value = false; await flushPromises()
    expect(c.closeEvents).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    saved = { ...saved, status: 'completed', portrait: { summary: { text: '后台已完成', sources: [] } } }
    const requests = c.request.mock.calls.length
    c.event({ kind: 'insight', body: { task_id: 'saved' } })
    await vi.advanceTimersByTimeAsync(9000); await flushPromises()
    expect(c.request).toHaveBeenCalledTimes(requests)
    expect(c.state.activeTask.value).toBe(previousTask)
    expect(c.state.engine.value).toBe('api')
    expect(c.state.modelChoice.value).toBe(selectedModel)
    c.visible.value = true; await flushPromises()
    expect(c.state.activeTask.value).toMatchObject({ id: 'saved', status: 'completed', portrait: saved.portrait })
    expect(c.request.mock.calls.some(([, options]) => ['POST', 'DELETE'].includes(options?.method))).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('暂停本地模型下载状态轮询，后台下载不被取消，回来继续读取状态', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let status = localModel('downloading')
    const c = setup(async path => path === '/insights/local-model' ? status : [], false, true)
    c.open.value = true; await flushPromises()
    c.visible.value = false; await flushPromises()
    const requests = c.request.mock.calls.length
    status = localModel('ready')
    await vi.advanceTimersByTimeAsync(9000); await flushPromises()
    expect(c.request).toHaveBeenCalledTimes(requests)
    expect(c.state.localModel.value.state).toBe('downloading')
    c.visible.value = true; await flushPromises()
    expect(c.state.localModel.value.state).toBe('ready')
    expect(c.request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })
})

describe('聊天画像状态', () => {
  it('移除历史入口保留当前画像标签和依据，保留结果可查看且重新挂载仍恢复，新任务回普通列表', async () => {
    const portrait = { summary: { text: '已保存画像', sources: ['source-a'] }, topics: [], communication: [], mood: null,
      traits: Object.fromEntries(['energy', 'humor', 'calm', 'initiative', 'care', 'closeness'].map(key => [key, { score: null, reason: '证据不足', sources: [] }])), affinity: null, mbti: null, uncertain: [] }
    const references = [{ source: 'source-a', username: 'friend', anchor: 'db:table:1' }]
    let saved = task('saved', { engine: 'laya', selected_model: null, portrait, references, history_hidden: false })
    const label = { identity: 's:1', text: '原文', fingerprint: 'saved-fingerprint', reason: '原文依据' }
    const handler = async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (path === '/insights/tasks/saved/history') { saved = { ...saved, history_hidden: true }; return { removed: 1 } }
      if (path === '/insights/tasks' && options?.method === 'POST') return task('new', { ...options.body, status: 'running', history_hidden: false })
      if (path === '/insights/tasks') return saved.history_hidden && !options.query.include_hidden ? [] : [saved]
      if (path.endsWith('/messages')) return { items: [label], total: 1 }
      return saved
    }
    const ctx = setup(handler, true); ctx.open.value = true; await flushPromises()
    await ctx.wrapper.find('[aria-label="显示消息情绪与意图标签"]').setValue(true); await flushPromises()
    await ctx.wrapper.find('[aria-label="移除当前分析记录"]').trigger('click')
    expect(ctx.wrapper.find('.history-confirmation').text()).toContain('仅移除历史入口，消息标签、画像与原文依据仍保留')
    await ctx.wrapper.find('[aria-label="取消移除分析历史"]').trigger('click')
    expect(ctx.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
    await ctx.wrapper.find('[aria-label="移除当前分析记录"]').trigger('click')
    await ctx.wrapper.find('button[aria-label="确认移除分析历史"]').trigger('click'); await flushPromises()
    expect(ctx.request.mock.calls.find(([, options]) => options?.method === 'DELETE')).toEqual(['/insights/tasks/saved/history', { method: 'DELETE', query: { account: 'acc' } }])
    expect(ctx.state.tasks.value).toEqual([])
    expect(ctx.state.activeTask.value).toMatchObject({ id: 'saved', portrait, references, history_hidden: true })
    expect(ctx.state.labels.value['s:1']).toEqual(label)
    expect(ctx.wrapper.text()).toContain('已保存画像')
    await ctx.wrapper.find('[aria-label="查看保留画像结果"]').setValue(true); await flushPromises()
    expect(ctx.wrapper.find('[aria-label="画像分析历史"]').text()).toContain('已移除')
    ctx.wrapper.unmount()
    const reopened = setup(handler); reopened.open.value = true; await flushPromises()
    expect(reopened.state.tasks.value).toEqual([])
    expect(reopened.state.activeTask.value).toMatchObject({ id: 'saved', portrait, references, history_hidden: true })
    reopened.state.labelsEnabled.value = true; await flushPromises()
    expect(reopened.state.labels.value['s:1']).toEqual(label)
    reopened.state.includeHidden.value = true; await flushPromises(); await reopened.state.create(); await flushPromises()
    expect(reopened.state.includeHidden.value).toBe(false)
    expect(reopened.state.tasks.value.map(item => item.id)).toEqual(['new'])
    expect(reopened.state.activeTask.value.id).toBe('new')
  })
  it('保留结果恢复按完整API模型选择过滤，普通历史展示同范围全部模型', async () => {
    const hidden = task('hidden', { engine: 'api', history_hidden: true })
    const other = task('other-model', { engine: 'api', selected_model: { ...choice, model_id: 'other' } })
    const ctx = setup(async (path, options) => {
      if (path === '/insights/tasks') return options.query.include_hidden ? JSON.parse(options.query.selected_model).model_id === 'm' ? [hidden] : [] : [other]
      return []
    })
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    expect(ctx.state.tasks.value.map(item => item.id)).toEqual(['other-model'])
    expect(ctx.state.activeTask.value?.id).toBe('hidden')
    const restore = ctx.request.mock.calls.find(([path, options]) => path === '/insights/tasks' && options.query.include_hidden)
    expect(restore[1].query).toMatchObject({ account: 'acc', username: 'friend', member_username: '', engine: 'api', limit: 1, include_hidden: true })
    expect(JSON.parse(restore[1].query.selected_model)).toEqual(choice)
    expect(ctx.request.mock.calls.filter(([path, options]) => path === '/insights/tasks' && !options.query.include_hidden).every(([, options]) => !('selected_model' in options.query))).toBe(true)
    await ctx.state.modelSelection.choose({ ...choice, model_id: 'unknown' }); await flushPromises()
    expect(ctx.state.activeTask.value).toBe(null)
    expect(ctx.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
  })
  it('批量清理发送当前成员范围并保留运行项，切成员清除确认；运行任务禁止单条移除', async () => {
    let hidden = false
    const completed = task('saved-member', { username: 'g@chatroom', member_username: 'member-a', engine: 'laya', selected_model: null })
    const live = task('running-member', { ...completed, id: 'running-member', status: 'running' })
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (path === '/insights/tasks/history') { hidden = true; return { removed: 1 } }
      if (path === '/insights/tasks/running-member') return live
      if (path === '/insights/tasks') {
        if (options.query.member_username !== 'member-a') return []
        return options.query.limit === 1 ? [{ ...completed, history_hidden: hidden }] : hidden ? [live] : [completed, live]
      }
      return []
    }, true)
    ctx.contact.value = { username: 'g@chatroom', isGroup: true }; ctx.open.value = true; await flushPromises()
    ctx.state.member.value = 'member-a'; await flushPromises()
    await ctx.wrapper.find('[aria-label="清空画像分析历史"]').trigger('click')
    expect(ctx.wrapper.find('.history-confirmation').exists()).toBe(true)
    ctx.state.member.value = 'member-b'; await flushPromises()
    expect(ctx.wrapper.find('.history-confirmation').exists()).toBe(false)
    ctx.state.member.value = 'member-a'; await flushPromises()
    await ctx.wrapper.find('[aria-label="清空画像分析历史"]').trigger('click')
    await ctx.wrapper.find('button[aria-label="确认移除分析历史"]').trigger('click'); await flushPromises()
    expect(ctx.request.mock.calls.find(([, options]) => options?.method === 'DELETE')).toEqual(['/insights/tasks/history', { method: 'DELETE', query: { account: 'acc', username: 'g@chatroom', member_username: 'member-a', engine: 'laya' } }])
    expect(ctx.state.tasks.value.map(item => item.id)).toEqual(['running-member'])
    expect(ctx.state.activeTask.value).toMatchObject({ id: 'saved-member', history_hidden: true })
    await ctx.state.selectTask('running-member')
    await ctx.state.removeHistory()
    expect(ctx.state.activeTask.value.id).toBe('running-member')
    expect(ctx.state.error.value).toContain('请先完成或取消')
    expect(ctx.request.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1)
  })
  it('清理失败保留历史和结果，陈旧历史响应不能复活已移除条目', async () => {
    let failed = true, hidden = false, delay = false, finishHistory
    const saved = task('saved', { engine: 'laya', selected_model: null })
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (options?.method === 'DELETE') { if (failed) throw new Error('历史清理失败'); hidden = true; return { removed: 1 } }
      if (path === '/insights/tasks') {
        if (delay) { delay = false; return new Promise(resolve => { finishHistory = resolve }) }
        return hidden && !options.query.include_hidden ? [] : [{ ...saved, history_hidden: hidden }]
      }
      return []
    })
    ctx.open.value = true; await flushPromises(); await ctx.state.removeHistory()
    expect(ctx.state.error.value).toContain('历史清理失败')
    expect(ctx.state.tasks.value.map(item => item.id)).toEqual(['saved'])
    expect(ctx.state.activeTask.value.history_hidden).toBe(false)
    failed = false; delay = true
    const stale = ctx.state.loadHistory(); await flushPromises(); await ctx.state.removeHistory()
    finishHistory([saved]); await stale
    expect(ctx.state.tasks.value).toEqual([])
    expect(ctx.state.activeTask.value).toMatchObject({ id: 'saved', history_hidden: true })
    expect(ctx.state.error.value).toBe('')
  })
  it('迟到清理响应不修改新账号结果，确认及保留视图随作用域重置', async () => {
    let finishRemoval
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (options?.method === 'DELETE') return new Promise(resolve => { finishRemoval = resolve })
      if (path === '/insights/tasks') return [task(options.query.account, { account: options.query.account, engine: 'laya', selected_model: null })]
      return []
    })
    ctx.open.value = true; await flushPromises()
    ctx.state.includeHidden.value = true; ctx.state.historyConfirmation.value = 'single'
    const removing = ctx.state.removeHistory(); await flushPromises()
    ctx.account.value = 'other-account'; await flushPromises()
    finishRemoval({ removed: 1 }); await removing
    expect(ctx.state.activeTask.value.id).toBe('other-account')
    expect(ctx.state.activeTask.value.history_hidden).toBeUndefined()
    expect(ctx.state.includeHidden.value).toBe(false)
    expect(ctx.state.historyConfirmation.value).toBe('')
    expect(ctx.state.historyNotice.value).toBe('')
    expect(ctx.state.busy.value).toBe(false)
    expect(ctx.request.mock.calls.find(([, options]) => options?.method === 'DELETE')[1].query.account).toBe('acc')
  })
  it('手动选择另一条历史后，先前保留结果恢复的迟到失败不覆盖当前错误状态', async () => {
    let failRestore
    const manual = task('manual', { engine: 'laya', selected_model: null })
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (path === '/insights/tasks') return options.query.include_hidden ? new Promise((_, reject) => { failRestore = reject }) : [manual]
      if (path === '/insights/tasks/manual') return manual
      return []
    })
    ctx.open.value = true; await flushPromises()
    await ctx.state.selectTask('manual')
    failRestore(new Error('过期恢复查询失败')); await flushPromises()
    expect(ctx.state.activeTask.value.id).toBe('manual')
    expect(ctx.state.error.value).toBe('')
  })
  it.each([false, true])('清理历史失败=%s时保留同一结果仍在途的标签读取', async failed => {
    let hidden = false, finishLabels
    const saved = task('saved', { engine: 'laya', selected_model: null })
    const label = { identity: 's:1', text: '仍保留的原文', fingerprint: 'saved-fingerprint', reason: '原文依据' }
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (options?.method === 'DELETE') { if (failed) throw new Error('清理失败'); hidden = true; return { removed: 1 } }
      if (path === '/insights/tasks') return hidden && !options.query.include_hidden ? [] : [{ ...saved, history_hidden: hidden }]
      if (path.endsWith('/messages')) return new Promise(resolve => { finishLabels = resolve })
      return []
    })
    ctx.open.value = true; await flushPromises()
    ctx.state.labelsEnabled.value = true; await flushPromises()
    await ctx.state.removeHistory()
    finishLabels({ items: [label], total: 1 }); await flushPromises()
    expect(ctx.state.activeTask.value).toMatchObject({ id: 'saved', history_hidden: !failed })
    expect(ctx.state.labelsEnabled.value).toBe(true)
    expect(ctx.state.labels.value['s:1']).toEqual(label)
    expect(ctx.state.error.value).toBe(failed ? '清理失败' : '')
  })
  it('默认本地模式不读取API设置且无需profile即可启动，明确传engine和空模型选择', async () => {
    const ctx = setup(async (path, options) => path === '/insights/local-model' ? localModel() : options?.method === 'POST' ? task('local', { engine: 'laya', selected_model: null, context_budget: null }) : [])
    expect(ctx.state.engine.value).toBe('laya')
    ctx.open.value = true; await flushPromises()
    expect(ctx.request.mock.calls.some(([path]) => path === '/settings')).toBe(false)
    expect(ctx.state.localModel.value.state).toBe('ready')
    await ctx.state.create()
    expect(ctx.request.mock.calls.find(([p, o]) => p === '/insights/tasks' && o?.method === 'POST')[1].body).toMatchObject({ engine: 'laya', selected_model: null })
    expect(ctx.state.activeTask.value.id).toBe('local')
  })
  it('真实面板选成员再开始保留成员ID，提交和运行期间不能失联，取消后才能切群整体', async () => {
    let finishCreate, saved
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (path === '/insights/members') return [{ username: 'member-a', displayName: '同名成员' }, { username: 'member-b', displayName: '同名成员' }]
      if (path === '/insights/tasks' && options?.method === 'POST') {
        saved = task(options.body.member_username ? 'member-local' : 'group-local', { ...options.body, analysis_scope: options.body.member_username ? 'member' : 'conversation', status: 'running' })
        return options.body.member_username ? new Promise(resolve => { finishCreate = () => resolve(saved) }) : saved
      }
      if (path.endsWith('/cancel')) { saved = { ...saved, status: 'cancelled' }; return saved }
      return []
    }, true)
    ctx.contact.value = { username: 'g@chatroom', isGroup: true }; ctx.open.value = true; await flushPromises()
    await ctx.wrapper.find('[aria-label="选择分析对象"]').trigger('click'); await flushPromises()
    await ctx.wrapper.find('[aria-label="画像分析对象"]').setValue('member-a'); await flushPromises()
    expect(ctx.request.mock.calls.filter(([path, options]) => path === '/insights/tasks' && options?.method === 'POST')).toHaveLength(0)
    expect(ctx.request.mock.calls.filter(([path, options]) => path === '/insights/tasks' && options?.query).at(-1)[1].query).toMatchObject({ username: 'g@chatroom', member_username: 'member-a', engine: 'laya' })
    ctx.state.range.start = 100; ctx.state.range.end = 200
    await ctx.wrapper.find('.start-analysis').trigger('click'); await flushPromises()
    expect(ctx.request.mock.calls.find(([path, options]) => path === '/insights/tasks' && options?.method === 'POST')[1].body).toEqual({ account: 'acc', username: 'g@chatroom', member_username: 'member-a', engine: 'laya', start: 100, end: 200, selected_model: null, reuse_existing: true })
    ctx.state.member.value = ''; await flushPromises()
    expect(ctx.state.member.value).toBe('member-a')
    expect(ctx.state.busy.value).toBe(true)
    expect(ctx.wrapper.find('[aria-label="从头重算全部消息"]').attributes('disabled')).toBeDefined()
    expect(ctx.wrapper.find('[role="alert"]').text()).toContain('当前分析尚未结束')
    finishCreate(); await flushPromises()
    expect(ctx.state.activeTask.value.id).toBe('member-local')
    expect(ctx.state.activeTask.value.member_username).toBe('member-a')
    ctx.state.member.value = 'member-b'; await flushPromises()
    expect(ctx.state.member.value).toBe('member-a')
    expect(ctx.state.activeTask.value.id).toBe('member-local')
    expect(ctx.state.running.value).toBe(true)
    expect(ctx.wrapper.find('[aria-label="从头重算全部消息"]').attributes('disabled')).toBeDefined()
    expect(ctx.wrapper.find('[aria-label="画像分析对象"]').attributes('disabled')).toBeDefined()
    await ctx.wrapper.find('.insight-overview button').trigger('click'); await flushPromises()
    expect(ctx.request.mock.calls.some(([path, options]) => path === '/insights/tasks/member-local/cancel' && options.method === 'POST')).toBe(true)
    expect(ctx.state.activeTask.value.status).toBe('cancelled')
    expect(ctx.wrapper.find('[aria-label="画像分析对象"]').attributes('disabled')).toBeUndefined()
    await ctx.wrapper.find('[aria-label="画像分析对象"]').setValue(''); await flushPromises()
    await ctx.wrapper.find('.start-analysis').trigger('click'); await flushPromises()
    expect(ctx.request.mock.calls.filter(([path, options]) => path === '/insights/tasks' && options?.method === 'POST').map(([, options]) => [options.body.member_username, options.body.engine])).toEqual([['member-a', 'laya'], ['', 'laya']])
    expect(ctx.state.activeTask.value.id).toBe('group-local')
  })
  it.each(['account', 'contact'])('运行中的成员任务切换%s时仍清理旧成员和任务作用域', async changed => {
    const ctx = setup(async (path, options) => path === '/insights/local-model' ? localModel() : path === '/insights/tasks' && options?.method === 'POST' ? task('member-local', { ...options.body, status: 'running' }) : [])
    ctx.contact.value = { username: 'g@chatroom', isGroup: true }; ctx.open.value = true; await flushPromises()
    ctx.state.member.value = 'member-a'; await flushPromises(); await ctx.state.create()
    expect(ctx.state.running.value).toBe(true)
    if (changed === 'account') ctx.account.value = 'other-account'
    else ctx.contact.value = { username: 'next@chatroom', isGroup: true }
    await flushPromises()
    expect(ctx.state.member.value).toBe('')
    expect(ctx.state.activeTask.value).toBe(null)
    expect(ctx.state.error.value).toBe('')
    expect(ctx.request.mock.calls.filter(([path, options]) => path === '/insights/tasks' && options?.query).at(-1)[1].query.member_username).toBe('')
  })
  it('API与本地历史和标签隔离，切换只读不创建任务，迟到结果不能覆盖', async () => {
    let finishLabels
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (path === '/insights/tasks') return options.query.engine === 'laya' ? [task('local', { engine: 'laya', selected_model: null })] : [task('old-api')]
      if (path.endsWith('/messages')) return new Promise(resolve => { finishLabels = resolve })
      return []
    })
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises(); ctx.state.labelsEnabled.value = true; await flushPromises()
    const oldLabels = finishLabels
    ctx.state.engine.value = 'laya'; await flushPromises()
    expect(ctx.state.activeTask.value.id).toBe('local')
    oldLabels({ items: [{ identity: 's:private-api-label' }], total: 1 }); await flushPromises()
    expect(ctx.state.labels.value).toEqual({})
    finishLabels({ items: [{ identity: 's:local-label' }], total: 1 }); await flushPromises()
    expect(Object.keys(ctx.state.labels.value)).toEqual(['s:local-label'])
    await ctx.state.modelSelection.choose({ ...choice, model_id: 'another' }); await flushPromises()
    expect(ctx.state.activeTask.value.id).toBe('local')
    ctx.state.engine.value = 'api'; await flushPromises()
    expect(ctx.state.tasks.value.map(t => t.id)).toEqual(['old-api'])
    expect(ctx.state.labels.value).toEqual({})
    expect(ctx.request.mock.calls.some(([p, o]) => p === '/insights/tasks' && o?.method === 'POST')).toBe(false)
  })
  it('本地模型下载按明确操作发起，只有打开的本地面板轮询进行中状态；暂停导入错误不伪造就绪', async () => {
    vi.useFakeTimers()
    let status = localModel('missing')
    const ctx = setup(async (path, options) => {
      if (path === '/insights/tasks') return []
      if (path.endsWith('/download')) status = localModel('downloading')
      if (path.endsWith('/pause')) status = localModel('paused')
      if (path.endsWith('/import')) { expect(options.body.path).toBe('G:\\model-copy'); throw new Error('模型文件校验失败') }
      return status
    })
    ctx.state.engine.value = 'laya'; ctx.open.value = true; await flushPromises()
    await ctx.state.create(); expect(ctx.state.error.value).toContain('本地模型尚未就绪')
    await ctx.state.downloadLocalModel(); expect(ctx.state.localModel.value.state).toBe('downloading')
    const reads = () => ctx.request.mock.calls.filter(([p]) => p === '/insights/local-model').length
    const before = reads(); await vi.advanceTimersByTimeAsync(3000); expect(reads()).toBe(before + 1)
    await ctx.state.pauseLocalModel(); expect(ctx.state.localModel.value.state).toBe('paused')
    const paused = reads(); await vi.advanceTimersByTimeAsync(3000); expect(reads()).toBe(paused)
    await ctx.state.downloadLocalModel(); ctx.open.value = false; await vi.advanceTimersByTimeAsync(3000); expect(reads()).toBe(paused)
    ctx.open.value = true; await flushPromises(); ctx.state.engine.value = 'api'; await flushPromises()
    const apiReads = reads(); await vi.advanceTimersByTimeAsync(3000); expect(reads()).toBe(apiReads)
    ctx.state.localModelPath.value = 'G:\\model-copy'; await ctx.state.importLocalModel()
    expect(ctx.state.localError.value).toContain('模型文件校验失败')
    expect(ctx.state.localModel.value.state).not.toBe('ready')
  })
  it('切到本地后迟到API配置不会改变全局选择；慢状态轮询不饿死且暂停结果优先', async () => {
    vi.useFakeTimers()
    let resolveSettings, resolveStatus, reads = 0
    const ctx = setup(async path => {
      if (path === '/insights/tasks') return []
      if (path.endsWith('/pause')) return localModel('paused')
      if (path === '/insights/local-model') { reads++; return reads === 1 ? localModel('downloading') : new Promise(resolve => { resolveStatus = resolve }) }
      return []
    })
    ctx.state.engine.value = 'api'; await flushPromises()
    ctx.request.mockImplementationOnce(() => new Promise(resolve => { resolveSettings = resolve }))
    ctx.open.value = true; await flushPromises()
    ctx.state.engine.value = 'laya'; await flushPromises()
    resolveSettings({ profiles: [{ id: 'late' }], selected_model: { profile_id: 'late', model_id: 'late' } }); await flushPromises()
    expect(ctx.state.modelChoice.value).toEqual({})
    await vi.advanceTimersByTimeAsync(6000); expect(reads).toBe(2)
    await ctx.state.pauseLocalModel()
    resolveStatus(localModel('downloading')); await flushPromises()
    expect(ctx.state.localModel.value.state).toBe('paused')
    expect(ctx.state.localLoading.value).toBe(false)
  })
  it('打开只恢复历史，默认七天；模型与标签切换均不创建任务', async () => {
    const ctx = setup(async path => path === '/insights/tasks' ? [task()] : { items: [], total: 0 })
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    expect(ctx.state.activeTask.value.id).toBe('one')
    expect(ctx.state.range.end - ctx.state.range.start).toBe(7 * 86400)
    ctx.state.labelsEnabled.value = true; await flushPromises()
    await ctx.state.modelSelection.choose({ ...choice, model_id: 'other' }); await flushPromises()
    expect(ctx.state.activeTask.value).toBe(null)
    expect(ctx.request.mock.calls.some(([path, options]) => path === '/insights/tasks' && options?.method === 'POST')).toBe(false)
  })
  it('手动创建传固定范围及全局选择，取消和重新分析使用真实接口', async () => {
    const ctx = setup(async (path, options) => path === '/insights/tasks' && options?.method === 'POST' ? task('new', { status: 'running' }) : path.endsWith('/cancel') ? task('new', { status: 'cancelled' }) : [])
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    ctx.state.range.start = 100; ctx.state.range.end = 200
    await ctx.state.create(); await flushPromises()
    const created = ctx.request.mock.calls.find(([, o]) => o?.method === 'POST')
    expect(created[1].body).toEqual({ account: 'acc', username: 'friend', member_username: '', engine: 'api', start: 100, end: 200, selected_model: choice, reuse_existing: true })
    await ctx.state.cancel(); expect(ctx.state.activeTask.value.status).toBe('cancelled')
    await ctx.state.create()
    expect(ctx.request.mock.calls.filter(([p,o]) => p === '/insights/tasks' && o?.method === 'POST')).toHaveLength(2)
  })
  it.each(['api', 'laya'])('%s真实按钮默认复用，显式从头重算只影响本次请求', async engine => {
    const ctx = setup(async (path, options) => {
      if (path === '/insights/local-model') return localModel()
      if (path === '/insights/tasks' && options?.method === 'POST') return task('new', { ...options.body })
      return []
    }, true)
    ctx.state.engine.value = engine; ctx.open.value = true; await flushPromises()
    ctx.state.activeTask.value = task('other-model-history', { selected_model: { ...choice, model_id: 'other' }, history_hidden: true })
    ctx.state.range.start = 300; ctx.state.range.end = 400
    expect(ctx.state.labelsEnabled.value).toBe(false)
    await ctx.wrapper.find('.start-analysis').trigger('click'); await flushPromises()
    let submitted = ctx.request.mock.calls.filter(([path, options]) => path === '/insights/tasks' && options?.method === 'POST')
    expect(submitted[0][1].body.reuse_existing).toBe(true)
    await ctx.wrapper.find('[aria-label="从头重算全部消息"]').trigger('click'); await flushPromises()
    await ctx.wrapper.find('.start-analysis').trigger('click'); await flushPromises()
    submitted = ctx.request.mock.calls.filter(([path, options]) => path === '/insights/tasks' && options?.method === 'POST')
    expect(submitted.map(([, options]) => options.body.reuse_existing)).toEqual([true, false, true])
    expect(submitted.every(([, options]) => options.body.start === 300 && options.body.end === 400)).toBe(true)
    expect(submitted.every(([, options]) => options.body.engine === engine && options.body.account === 'acc' && options.body.username === 'friend')).toBe(true)
    expect(submitted.map(([, options]) => options.body.selected_model)).toEqual(Array(3).fill(engine === 'api' ? choice : null))
  })
  it('迟到的会话、成员、模型请求不能覆盖当前状态', async () => {
    const pending = []
    const ctx = setup((path, options) => path === '/insights/tasks' ? new Promise(resolve => pending.push({ resolve, username: options.query.username, hidden: options.query.include_hidden })) : [])
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    ctx.contact.value = { username: 'new' }; await flushPromises()
    pending.at(-1).resolve([task('new', { username: 'new' })]); await flushPromises()
    pending.find(p => p.username === 'new' && p.hidden).resolve([task('new', { username: 'new' })]); await flushPromises()
    pending[0].resolve([task('old')]); await flushPromises()
    expect(ctx.state.activeTask.value.id).toBe('new')
  })
  it('SSE insight采用kind/body且只刷新当前任务；分页标签保留失败批次', async () => {
    const label = { source: 'a', identity: 's:1', text: 'hello', fingerprint: 'hash' }
    const ctx = setup(async (path, options) => path === '/insights/tasks' ? [task()] : path.endsWith('/messages') ? { items: options.query.offset === 0 ? [label] : [{ ...label, identity: 's:2' }], total: 2 } : task('one', { status: 'failed', error: { code: 'BAD', message: '输出错误', diagnostic_id: 'd' } }))
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    ctx.state.labelsEnabled.value = true; await flushPromises()
    expect(Object.keys(ctx.state.labels.value)).toHaveLength(2)
    const before = ctx.request.mock.calls.length
    ctx.event({ kind: 'insight', body: { task_id: 'another' } }); await flushPromises()
    expect(ctx.request.mock.calls).toHaveLength(before)
    ctx.event({ kind: 'insight', body: { task_id: 'one' } }); await flushPromises()
    expect(ctx.state.activeTask.value.error.diagnostic_id).toBe('d')
    expect(Object.keys(ctx.state.labels.value)).toHaveLength(2)
  })
  it('成员按需严格读取，保留同名不同ID，读取失败向用户暴露', async () => {
    const ctx = setup(async path => { if (path === '/insights/members') return [{ username: 'a', displayName: '同名' }, { username: 'b', displayName: '同名' }]; return [] })
    ctx.state.engine.value = 'api'; ctx.contact.value = { username: 'g@chatroom', isGroup: true }; ctx.open.value = true; await flushPromises()
    expect(ctx.request.mock.calls.some(([p]) => p === '/insights/members')).toBe(false)
    await ctx.state.loadMembers(); expect(ctx.state.members.value.map(m => m.username)).toEqual(['a','b'])
    ctx.request.mockRejectedValueOnce(new Error('实时消息读取失败'))
    await ctx.state.loadMembers(); expect(ctx.state.error.value).toContain('实时消息读取失败')
  })
  it('范围入口拒绝空范围；网络异常不伪造成功状态', async () => {
    const ctx = setup(); ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    ctx.state.range.start = 200; ctx.state.range.end = 100
    await ctx.state.create(); expect(ctx.state.error.value).toContain('结束时间')
    ctx.state.range.end = 300; ctx.request.mockRejectedValueOnce(new Error('连接失败'))
    await ctx.state.create(); expect(ctx.state.error.value).toContain('连接失败'); expect(ctx.state.activeTask.value).toBe(null)
  })
  it('模型快照字段顺序与显式null不影响恢复，迟到重算POST不覆盖手动选中的历史', async () => {
    let resolveCreate
    const old = task('old', { selected_model: { model_id: 'm', profile_id: 'p', thinking_mode: null, reasoning_effort: null, thinking_budget: null } })
    const ctx = setup((path, options) => {
      if (path === '/insights/tasks' && options?.method === 'POST') return new Promise(resolve => { resolveCreate = resolve })
      if (path === '/insights/tasks') return Promise.resolve([old])
      return Promise.resolve(old)
    })
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    expect(ctx.state.activeTask.value?.id).toBe('old')
    const creating = ctx.state.create(true); await flushPromises()
    expect(ctx.request.mock.calls.find(([, options]) => options?.method === 'POST')[1].body.reuse_existing).toBe(false)
    await ctx.state.selectTask('old')
    resolveCreate(task('new')); await creating
    expect(ctx.state.activeTask.value.id).toBe('old')
  })
  it('成员读取或标签读取迟到及历史刷新乱序均不泄漏旧账号数据', async () => {
    const pending = []
    let latestSaved = task('group', { username: 'g@chatroom' })
    const ctx = setup((path, options) => {
      if (path === '/insights/tasks' && options.query.include_hidden) return Promise.resolve([latestSaved])
      if (path === '/insights/tasks') return new Promise(resolve => pending.push({ kind: 'history', resolve }))
      if (path === '/insights/members') return new Promise(resolve => pending.push({ kind: 'members', resolve }))
      if (path.endsWith('/messages')) return new Promise(resolve => pending.push({ kind: 'labels', resolve }))
      return Promise.resolve([])
    })
    ctx.state.engine.value = 'api'; ctx.contact.value = { username: 'g@chatroom', isGroup: true }; ctx.open.value = true; await flushPromises()
    pending.at(-1).resolve([task('group', { username: 'g@chatroom' })]); await flushPromises()
    ctx.state.labelsEnabled.value = true; await flushPromises()
    const reading = ctx.state.loadMembers(); await flushPromises()
    ctx.account.value = 'new'; await flushPromises()
    pending.find(p => p.kind === 'members').resolve([{ username: 'secret', displayName: '私密' }]); await reading
    pending.find(p => p.kind === 'labels').resolve({ items: [{ identity: 's:1', text: '私密' }], total: 1 }); await flushPromises()
    expect(ctx.state.members.value).toEqual([]); expect(ctx.state.labels.value).toEqual({}); expect(ctx.state.membersLoading.value).toBe(false)
    latestSaved = task('latest')
    const first = ctx.state.loadHistory(), second = ctx.state.loadHistory(); await flushPromises()
    const histories = pending.filter(p => p.kind === 'history')
    histories.at(-1).resolve([task('latest')]); await second
    histories.at(-2).resolve([task('stale')]); await first
    expect(ctx.state.activeTask.value.id).toBe('latest')
  })
  it('取消使先前在途进度失效，慢进度请求不会被每次轮询永久淘汰', async () => {
    vi.useFakeTimers()
    const detail = []
    const ctx = setup((path) => {
      if (path === '/insights/tasks') return Promise.resolve([task('live', { status: 'running' })])
      if (path.endsWith('/cancel')) return Promise.resolve(task('live', { status: 'cancelled' }))
      return new Promise(resolve => detail.push(resolve))
    })
    ctx.state.engine.value = 'api'; ctx.open.value = true; await flushPromises()
    await vi.advanceTimersByTimeAsync(3000); await flushPromises()
    await vi.advanceTimersByTimeAsync(3000); await flushPromises()
    expect(detail).toHaveLength(1)
    detail[0](task('live', { status: 'running', progress: { read: 22, analyzed: 10, batches: 1 } })); await flushPromises()
    expect(ctx.state.activeTask.value.progress.read).toBe(22)
    const polling = ctx.state.refresh(); await flushPromises()
    await ctx.state.cancel()
    detail.at(-1)(task('live', { status: 'running' })); await polling
    expect(ctx.state.activeTask.value.status).toBe('cancelled')
  })
})
