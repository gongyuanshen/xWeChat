import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AiSidebar from '../components/chat/AiSidebar.vue'
import AiSettings from '../components/AiSettings.vue'

const request = vi.fn()
beforeEach(() => {
  vi.stubGlobal('useAiApi', () => ({ request, events: () => () => {} }))
  vi.stubGlobal('useSettingsDialog', () => ({ openDialog: vi.fn() }))
  let createdTask = null
  request.mockReset().mockImplementation(async (path, options) => {
    if (path === '/settings') return { profiles: [], presets: [{ provider: 'deepseek', name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1' }], defaults: {} }
    if (path === '/usage') return { calls: 0 }
    if (path === '/tasks' && options?.method === 'POST') {
      createdTask = { ...options.body, id: 'task', range: { ...options.body.range, end: 100 }, results: [], status: 'queued', stage: '等待执行', progress: 0 }
      return createdTask
    }
    if (path === '/tasks/task') return createdTask
    return []
  })
})
describe('聊天 AI 面板', () => {
  it.each([false, true])('关注检测展示真实命中状态和来源，命中=%s', async (matched) => {
    const original = request.getMockImplementation()
    const source = { source: 'source1', anchor: 'message:3', username: 'group' }
    const task = { id: 'alert-result', kind: 'alert', conversations: ['group'], status: 'completed', created: 100, range: { end: 110 }, results: [{ username: 'group', name: '项目群', count: 1, sources: [source], summary: { matches: matched ? [{ reason: '需要确认新的交付日期', sources: ['source1'] }] : [] } }] }
    request.mockImplementation(async (path, options) => path === '/tasks/alert-result' ? task : original(path, options))
    const wrapper = mount(AiSidebar, { props: { account: 'acc', contact: { username: 'group' }, focusTaskId: task.id } })
    try {
      await flushPromises()
      expect(wrapper.find('.ai-task-status').text()).toContain('关注检测已完成')
      expect(wrapper.text()).not.toContain('总结已完成')
      if (matched) {
        expect(wrapper.find('.ai-task-result').text()).toContain('需要确认新的交付日期')
        await wrapper.find('.ai-task-result .ai-source').trigger('click')
        expect(wrapper.emitted('locate')[0]).toEqual([source])
      } else {
        expect(wrapper.find('.ai-task-result').text()).toContain('本次未发现符合关注条件的新消息')
        expect(wrapper.find('.ai-task-result .ai-source').exists()).toBe(false)
      }
    } finally { wrapper.unmount() }
  })
  it('切换工具后清除上一工具的错误提示', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation(async (path, options) => {
      if (path === '/rules' && options?.method === 'POST') throw new Error('当前账号是导入快照，实时关注提醒不可用')
      return original(path, options)
    })
    const wrapper = mount(AiSidebar, { props: { account: 'acc', contact: { username: 'group', name: '项目群' } } })
    try {
      await flushPromises()
      await wrapper.findAll('button').find(b => b.text() === '关注提醒').trigger('click')
      await wrapper.find('.ai-submit').trigger('click'); await flushPromises()
      expect(wrapper.find('[role=alert]').text()).toContain('实时关注提醒不可用')
      await wrapper.findAll('button').find(b => b.text() === '自动任务').trigger('click')
      expect(wrapper.find('[role=alert]').exists()).toBe(false)
    } finally { wrapper.unmount() }
  })
  it('重开面板接回未完成任务，查询暂时失败后自动恢复', async () => {
    vi.useFakeTimers()
    const original = request.getMockImplementation()
    const task = { id: 'pending', conversations: ['group'], status: 'running', stage: '读取消息', created: Date.now() / 1000, range: { mode: 'count', count: 100, end: 100 }, results: [], progress: 2 }
    let fail = false
    request.mockImplementation(async (path, options) => {
      if (path === '/tasks') return [task]
      if (path === '/tasks/pending') { if (fail) throw new Error('断线'); return task }
      return original(path, options)
    })
    const wrapper = mount(AiSidebar, { props: { account: 'acc', contact: { username: 'group' } } })
    try {
      await flushPromises()
      expect(wrapper.find('.ai-task-thread').exists()).toBe(true)
      expect(wrapper.find('.ai-submit').attributes('disabled')).toBeDefined()
      fail = true
      await vi.advanceTimersByTimeAsync(4000); await flushPromises()
      expect(wrapper.text()).toContain('暂时无法获取最新进度')
      fail = false
      await vi.advanceTimersByTimeAsync(4000); await flushPromises()
      expect(wrapper.text()).not.toContain('暂时无法获取最新进度')
      expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    } finally { wrapper.unmount(); vi.useRealTimers() }
  })
  it('无 SSE 时轮询真实进度，显示用时，完成后冻结计时并停止轮询', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T05:00:00Z'))
    const original = request.getMockImplementation()
    const created = Date.now() / 1000
    let task = { id: 'live', kind: 'summary', conversations: ['group'], conversation_names: ['项目群'], created, started_at: created, status: 'running', stage: '生成摘要 1/1 · 项目群', progress: 48, range: { mode: 'count', count: 100, end: created }, results: [], activity: [{ stage: '读取消息', time: created }, { stage: '生成摘要 1/1 · 项目群', time: created + 1 }] }
    request.mockImplementation(async (path, options) => path === '/tasks/live' || (path === '/tasks' && options?.method === 'POST') ? task : original(path, options))
    const wrapper = mount(AiSidebar, { attachTo: document.body, props: { account: 'acc', contact: { username: 'group', name: '项目群' } } })
    try {
      await flushPromises()
      await wrapper.find('.ai-submit').trigger('click'); await flushPromises()
      expect(wrapper.find('.ai-submit').isVisible()).toBe(false)
      expect(wrapper.find('.ai-task-thread').text()).toContain('总结 项目群 的最近 100 条消息')
      expect(wrapper.text()).toContain('正在等待模型返回结果')
      expect(wrapper.findAll('button').some(b => b.text() === '复制结果')).toBe(false)
      await vi.advanceTimersByTimeAsync(65000); await flushPromises()
      expect(wrapper.find('.ai-task-duration').text()).toContain('1分5秒')
      task = { ...task, status: 'completed', progress: 100, finished_at: created + 66, overview: { overview: '完成内容' }, results: [{ username: 'group', name: '项目群', count: 100, summary: { overview: '完成内容' }, coverage: [], sources: [] }] }
      await vi.advanceTimersByTimeAsync(4000); await flushPromises()
      expect(wrapper.find('.ai-task-status').text()).toContain('总结已完成')
      expect(wrapper.find('.ai-task-duration').text()).toContain('1分6秒')
      expect(wrapper.find('progress').exists()).toBe(false)
      expect(wrapper.find('.ai-task-thread').text().match(/完成内容/g)).toHaveLength(1)
      const calls = request.mock.calls.length
      await vi.advanceTimersByTimeAsync(10000)
      expect(request.mock.calls).toHaveLength(calls)
      expect(wrapper.find('.ai-task-duration').text()).toContain('1分6秒')
    } finally { wrapper.unmount(); vi.useRealTimers() }
  })
  it('默认最近 100 条，提交当前账号和所选会话', async () => {
    const wrapper = mount(AiSidebar, { props: { account: 'acc', contact: { username: 'group', name: '项目群' }, contacts: [] } })
    await flushPromises()
    expect(wrapper.find('.ai-targets').exists()).toBe(false)
    expect(request.mock.calls.some(([path]) => path === '/conversations')).toBe(false)
    const start = wrapper.findAll('button').find(b => b.text() === '开始总结')
    await start.trigger('click'); await flushPromises()
    const call = request.mock.calls.find(([path, options]) => path === '/tasks' && options?.method === 'POST')
    expect(call[1].body.account).toBe('acc')
    expect(call[1].body.conversations).toEqual(['group'])
    expect(call[1].body.range.count).toBe(100)
    wrapper.unmount()
  })
  it('提醒频率允许用户自定义', async () => {
    const wrapper = mount(AiSidebar, { props: { account: 'acc', contacts: [] } })
    await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '关注提醒').trigger('click')
    expect(wrapper.text()).toContain('关注条件')
    const select = wrapper.find('[role=combobox][aria-label="检测间隔"]')
    await select.trigger('keydown', { key: 'Enter' })
    await select.trigger('keydown', { key: 'End' })
    await select.trigger('keydown', { key: 'Enter' }); await flushPromises()
    expect(wrapper.text()).toContain('间隔秒数')
    wrapper.unmount()
  })
  it('账号加载和切换聊天后直接使用当前会话，无需重新勾选', async () => {
    const wrapper = mount(AiSidebar, { props: { contact: { username: 'first', name: '会话一' }, contacts: [] } })
    await flushPromises()
    await wrapper.setProps({ account: 'acc' }); await flushPromises()
    await wrapper.setProps({ contact: { username: 'second', name: '会话二' } })
    expect(wrapper.find('.ai-context-card').text()).toContain('会话二')
    await wrapper.find('.ai-submit').trigger('click'); await flushPromises()
    expect(request.mock.calls.find(([path, options]) => path === '/tasks' && options?.method === 'POST')[1].body.conversations).toEqual(['second'])
    wrapper.unmount()
  })
  it('明确进入批量模式才加载列表，返回当前后只处理当前聊天', async () => {
    const wrapper = mount(AiSidebar, { props: { account: 'acc', contact: { username: 'first', name: '会话一' }, contacts: [{ username: 'second', name: '会话二' }] } })
    await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '批量总结').trigger('click'); await flushPromises()
    expect(request.mock.calls.some(([path]) => path === '/conversations')).toBe(true)
    await wrapper.find('.ai-targets input[value="second"]').setValue(true)
    await wrapper.find('.ai-submit').trigger('click'); await flushPromises()
    expect(request.mock.calls.find(([path, options]) => path === '/tasks' && options?.method === 'POST')[1].body.conversations).toEqual(['first', 'second'])
    await wrapper.setProps({ contact: { username: 'third', name: '会话三' } })
    expect(wrapper.find('.ai-context-card').text()).toContain('已选 2 个会话')
    await wrapper.findAll('button').find(b => b.text() === '返回当前').trigger('click')
    expect(wrapper.find('.ai-targets').exists()).toBe(false)
    await wrapper.find('.ai-submit').trigger('click'); await flushPromises()
    expect(wrapper.find('.ai-context-card').text()).toContain('会话三')
    expect(request.mock.calls.filter(([path, options]) => path === '/tasks' && options?.method === 'POST')).toHaveLength(1)
    wrapper.unmount()
  })
  it('完整列表加载失败不会阻止总结当前会话', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation(async (path, options) => { if (path === '/conversations') throw new Error('不可用'); return original(path, options) })
    const wrapper = mount(AiSidebar, { props: { account: 'acc', contact: { username: 'current', name: '当前聊天' }, contacts: [] } })
    await flushPromises()
    await wrapper.findAll('button').find(b => b.text() === '批量总结').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('完整会话列表加载失败')
    await wrapper.findAll('button').find(b => b.text() === '返回当前').trigger('click')
    expect(wrapper.find('.ai-submit').attributes('disabled')).toBeUndefined()
    await wrapper.find('.ai-submit').trigger('click'); await flushPromises()
    expect(request.mock.calls.find(([path, options]) => path === '/tasks' && options?.method === 'POST')[1].body.conversations).toEqual(['current'])
    wrapper.unmount()
  })
})
const mountEditor = async () => {
  const wrapper = mount(AiSettings, { attachTo: document.body, global: { stubs: { teleport: true } } }); await flushPromises()
  const saved = wrapper.find('.ais-service-card')
  if (saved.exists()) await saved.trigger('click')
  else { await wrapper.find('.ais-add').trigger('click'); await wrapper.find('.ais-provider-choice').trigger('click') }
  await flushPromises()
  return wrapper
}
describe('全局 AI 设置', () => {
  it('服务通过二级弹窗配置，取消不保存，审计独立展示', async () => {
    const wrapper = mount(AiSettings, { attachTo: document.body, global: { stubs: { teleport: true } } }); await flushPromises()
    expect(wrapper.find('input[type=password]').exists()).toBe(false)
    expect(wrapper.find('#ais-config').isVisible()).toBe(true)
    expect(wrapper.find('#ais-usage').isVisible()).toBe(false)
    await wrapper.find('.ais-add').trigger('click')
    expect(wrapper.find('[role=dialog]').text()).toContain('选择 AI 服务')
    await wrapper.find('.ais-provider-choice').trigger('click')
    await wrapper.find('input[type=password]').setValue('draft-key')
    await wrapper.find('[role=dialog]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role=dialog]').exists()).toBe(false)
    await wrapper.find('#ais-usage-tab').trigger('click')
    expect(wrapper.find('#ais-usage').isVisible()).toBe(true)
    expect(wrapper.find('#ais-config').isVisible()).toBe(false)
    await wrapper.find('#ais-config-tab').trigger('click')
    expect(request.mock.calls.some(([path, options]) => path === '/profiles' && options?.method === 'POST')).toBe(false)
    wrapper.unmount()
  })
  it('填入密钥后自动获取上游模型并优先选择声明图片能力的模型', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation(async (path, options) => path === '/models' ? { models: ['future-text', 'future-image'], model_details: [{ id: 'future-text', vision: false }, { id: 'future-image', vision: true }] } : original(path, options))
    const wrapper = await mountEditor()
    const key = wrapper.find('input[type=password]')
    await key.setValue('dummy'); await key.trigger('blur'); await flushPromises()
    const call = request.mock.calls.find(([p]) => p === '/models')
    expect(call[1].body).not.toHaveProperty('model')
    expect(call[1].body).not.toHaveProperty('name')
    expect(wrapper.find('[role=combobox][aria-label="选择模型"]').text()).toContain('future-image')
    expect(wrapper.find('input[type=search]').exists()).toBe(false)
    expect(wrapper.findAll('button').find(b => b.text() === '保存配置').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
  it('修改凭据后忽略旧请求，避免旧列表覆盖新结果', async () => {
    const original = request.getMockImplementation(), pending = []
    request.mockImplementation((path, options) => path === '/models' ? new Promise(resolve => pending.push(resolve)) : original(path, options))
    const wrapper = await mountEditor()
    const key = wrapper.find('input[type=password]')
    await key.setValue('first'); await key.trigger('blur')
    await key.setValue('second'); await key.trigger('blur')
    pending[1]({ models: ['new-result'] }); await flushPromises()
    pending[0]({ models: ['old-result'] }); await flushPromises()
    expect(wrapper.text()).toContain('new-result')
    expect(wrapper.text()).not.toContain('old-result')
    wrapper.unmount()
  })
  it('自定义菜单选择模型后更新图片能力，保存并关闭配置弹窗', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation(async (path, options) => path === '/models' ? { models: ['text', 'image'], model_details: [{ id: 'text', vision: false }, { id: 'image', vision: true }] } : original(path, options))
    const wrapper = await mountEditor()
    await wrapper.find('input[type=password]').setValue('dummy')
    await wrapper.find('input[type=password]').trigger('blur'); await flushPromises()
    const select = wrapper.find('[role=combobox][aria-label="选择模型"]')
    await select.trigger('keydown', { key: 'Enter' })
    expect(select.attributes('aria-expanded')).toBe('true')
    await select.trigger('keydown', { key: 'Home' })
    expect(wrapper.find('[role=option].is-active').text()).toContain('text')
    await select.trigger('keydown', { key: 'Enter' }); await flushPromises()
    expect(wrapper.find('[role=combobox][aria-label="选择模型"]').text()).toContain('text')
    expect(wrapper.find('[role=switch]').element.checked).toBe(false)
    await wrapper.find('form').trigger('submit'); await flushPromises()
    const saved = request.mock.calls.find(([path, options]) => path === '/profiles' && options?.method === 'POST')
    expect(saved[1].body.model).toBe('text')
    expect(wrapper.find('[role=dialog]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('获取失败时显示错误并保留手动输入备用入口', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation(async (path, options) => { if (path === '/models') throw new Error('获取失败'); return original(path, options) })
    const wrapper = await mountEditor()
    await wrapper.find('input[type=password]').setValue('dummy')
    await wrapper.find('input[type=password]').trigger('blur'); await flushPromises()
    expect(wrapper.text()).toContain('获取失败')
    const manual = wrapper.findAll('label').find(l => l.text().includes('手动输入（备用）')).find('input')
    await manual.setValue(true)
    expect(wrapper.find('input[placeholder="上游不支持获取列表时手动填写"]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('打开已有配置自动刷新但保留原模型和已确认的图片能力', async () => {
    const original = request.getMockImplementation()
    const profile = { id: 'saved', name: 'saved', provider: 'custom', protocol: 'openai', base_url: 'https://example.com/v1', has_key: true, model: 'saved-image', vision: true }
    request.mockImplementation(async (path, options) => {
      if (path === '/settings') return { profiles: [profile], presets: [], defaults: { text: 'saved', vision: 'saved' } }
      if (path === '/models') return { models: ['other', 'saved-image'] }
      return original(path, options)
    })
    const wrapper = await mountEditor()
    expect(request.mock.calls.find(([p]) => p === '/models')[1].body.api_key).toBeNull()
    expect(wrapper.find('[role=combobox][aria-label="选择模型"]').text()).toContain('saved-image')
    expect(wrapper.findAll('label').find(l => l.text().includes('此模型支持图片理解')).find('input').element.checked).toBe(true)
    wrapper.unmount()
  })
  it('展示失败用量未知的审计记录，允许刷新和导出', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation(async (path, options) => path.startsWith('/usage/records') ? [{ id: 'audit', model: 'test-model', status: 'failed', usage_known: false, usage: {}, http_status: 401 }] : original(path, options))
    const wrapper = mount(AiSettings)
    await flushPromises()
    expect(wrapper.text()).toContain('用量记录')
    expect(wrapper.text()).toContain('输入 未知')
    expect(wrapper.text()).toContain('HTTP 401')
    expect(wrapper.findAll('button').some(b => b.text() === '导出已加载记录')).toBe(true)
    wrapper.unmount()
  })
  it('中断调用不显示成执行中或历史成功，未知用量继续保留', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation(async (path, options) => path.startsWith('/usage/records')
      ? [{ id: 'interrupted', model: 'test-model', status: 'interrupted', usage_known: false, usage: {} }]
      : original(path, options))
    const wrapper = mount(AiSettings)
    try {
      await flushPromises()
      expect(wrapper.find('.ais-status.status-interrupted').text()).toBe('已中断')
      expect(wrapper.text()).toContain('输入 未知')
      expect(wrapper.text()).not.toContain('历史成功调用')
    } finally { wrapper.unmount() }
  })
  it('连接测试展示明确结果，不显示模型对测试图片的原始回答', async () => {
    const original = request.getMockImplementation()
    const profile = { id: 'saved', name: 'saved', provider: 'custom', protocol: 'openai', base_url: 'https://example.com/v1', model: 'image', vision: true }
    request.mockImplementation(async (path, options) => {
      if (path === '/settings') return { profiles: [profile], presets: [], defaults: {} }
      if (path === '/models') return { models: ['image'] }
      if (path === '/profiles/saved/test') return { status: 'success', message: '图片是**深绿色**', test_type: 'image' }
      return original(path, options)
    })
    const wrapper = await mountEditor()
    await wrapper.findAll('button').find(b => b.text() === '测试连接').trigger('click'); await flushPromises()
    expect(wrapper.find('[role=dialog]').text()).toContain('连接成功，模型已正常响应。本次也测试了图片输入。')
    expect(wrapper.text()).not.toContain('深绿色')
    expect(wrapper.text()).toContain('修改后请先保存')
    wrapper.unmount()
  })
  it('密钥只通过保存请求发送，不进入浏览器持久化存储', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem')
    const wrapper = await mountEditor()
    await wrapper.find('input[type=password]').setValue('secret')
    expect(spy).not.toHaveBeenCalled()
    wrapper.unmount(); spy.mockRestore()
  })
})
