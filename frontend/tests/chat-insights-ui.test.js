import { flushPromises, mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { createHash, webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatInsightsPanel from '../components/chat/ChatInsightsPanel.vue'
import InsightRadar from '../components/chat/InsightRadar.vue'
import MessageInsightLabel from '../components/chat/MessageInsightLabel.vue'
import MessageItem from '../components/chat/MessageItem.vue'

const score = value => ({ score: value, reason: '原文体现', sources: ['a'] })
const portrait = () => ({ summary: { text: '人物摘要', sources: ['a'] }, topics: [{ text: '日常话题', sources: ['a'] }], communication: [{ text: '直接表达', sources: ['a'] }], mood: { text: '轻松', sources: ['a'] }, traits: { energy: score(75), humor: score(null), calm: score(65), initiative: score(60), care: score(80), closeness: score(70) }, affinity: score(70), mbti: { EI: score(60), SN: score(50), TF: score(30), JP: score(null) }, uncertain: ['样本有限'] })
function state() {
  return { includeHidden: ref(false), historyConfirmation: ref(''), historyNotice: ref(''), removeHistory: vi.fn(), range: reactive({ start: 100, end: 200 }), engine: ref('api'), localModel: ref(null), localLoading: ref(false), localBusy: ref(false), localError: ref(''), localModelPath: ref(''), loadLocalModel: vi.fn(), downloadLocalModel: vi.fn(), pauseLocalModel: vi.fn(), importLocalModel: vi.fn(), member: ref(''), members: ref([]), membersLoading: ref(false), tasks: ref([]), activeTask: ref({ id: 't', created: 100, start: 100, end: 200, data_source: 'snapshot', model: { model: 'm' }, status: 'completed', stage: '完成', progress: { read: 10, analyzed: 10, batches: 1 }, coverage: { total: 15, text: 10, skipped: 5, target_text: 10, participants: 2 }, portrait: portrait(), error: null, references: [{ source: 'a', username: 'friend', anchor: 'db:table:1' }] }), labelsEnabled: ref(false), loading: ref(false), busy: ref(false), error: ref(''), running: ref(false), profiles: ref([]), profilesLoading: ref(false), profilesError: ref(''), modelChoice: ref({}), modelSelection: { state: {} }, create: vi.fn(), cancel: vi.fn(), selectTask: vi.fn(), loadProfiles: vi.fn(), loadHistory: vi.fn(), loadMembers: vi.fn() }
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
describe('画像展示与原文标签', () => {
  it.each([
    ['INSIGHT_MODEL_REFUSED', 683],
    ['INSIGHT_INVALID_OUTPUT', 683],
    ['INSIGHT_MODEL_REFUSED', 200],
  ])('画像阶段失败保留已保存标签数和原始诊断，不自动重试（%s，%s条）', async (code, analyzed) => {
    const s = state()
    s.activeTask.value = { ...s.activeTask.value, engine: 'api', analysis_scope: 'peer', read_scope: 'peer', status: 'failed', stage: '分析失败', portrait: null,
      progress: { read: 690, analyzed, reused: 0, batches: 1 }, coverage: { total: 690, text: 683, skipped: 7, target_text: 683, participants: 1 },
      error: { phase: 'portrait', code, message: '原始模型错误', diagnostic_id: 'portrait-diag' } }
    s.tasks.value = [s.activeTask.value]
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend' } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.insight-overview').text()).toContain(`消息标签：${analyzed} / 683`)
    expect(wrapper.find('.insight-overview').text()).toContain('状态：画像生成失败')
    expect(wrapper.find('.task-detail h3').text()).toBe('画像生成失败')
    expect(wrapper.find('[aria-label="画像分析历史"]').text()).toContain('画像生成失败')
    const notice = wrapper.find('.portrait-failure')
    expect(notice.text()).toContain(`已保存消息标签 ${analyzed} / 683 条`)
    expect(notice.text()).not.toContain('消息标签已完成')
    expect(notice.text()).toContain(code === 'INSIGHT_MODEL_REFUSED' ? '画像生成被模型服务拒绝' : '画像生成失败')
    expect(notice.text()).toContain('已保存的标签仍可查看')
    expect(notice.text()).toContain('相同模型和分析范围')
    expect(notice.element.closest('.analysis-settings')).toBe(null)
    expect(wrapper.find('.task-detail').text()).toContain(`${code}：原始模型错误`)
    expect(wrapper.find('.task-detail').text()).toContain('portrait-diag')
    expect(s.activeTask.value.status).toBe('failed')
    expect(s.create).not.toHaveBeenCalled()
    await wrapper.find('.start-analysis').trigger('click')
    expect(s.create.mock.calls).toEqual([[]])
    wrapper.unmount()
  })
  it.each([
    ['labels', 683, '消息标签识别失败'],
    ['labels', 680, '消息标签识别失败'],
    [undefined, 683, '分析失败'],
    ['reading', 0, '消息读取失败'],
    ['local', 683, '本地分析失败'],
  ])('失败阶段 %s 按原始阶段显示，%s 条计数不能推断画像失败', (phase, analyzed, status) => {
    const s = state()
    s.activeTask.value = { ...s.activeTask.value, status: 'failed', portrait: null, progress: { read: 683, analyzed, batches: 1 },
      coverage: { total: 683, text: 683, skipped: 0, target_text: 683, participants: 1 },
      error: { ...(phase ? { phase } : {}), code: 'INSIGHT_INVALID_OUTPUT', message: '输出错误', diagnostic_id: 'stage-diag' } }
    if (phase === 'local') { s.engine.value = 'laya'; s.activeTask.value.engine = 'laya' }
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend' } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.insight-overview').text()).toContain(`${phase === 'local' ? '已分析' : '消息标签'}：${analyzed} / 683`)
    expect(wrapper.find('.insight-overview').text()).toContain(`状态：${status}`)
    expect(wrapper.find('.task-detail h3').text()).toBe(status)
    expect(wrapper.find('.portrait-failure').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('消息标签已完成')
    expect(s.create).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it.each([0, 180])('复用%s条按保存进度显示，最终画像仍使用全部范围且旧任务不推算复用数', async reused => {
    const s = state()
    s.activeTask.value = { ...s.activeTask.value, analysis_scope: 'conversation', status: 'running', stage: '整理最终画像', portrait: null,
      progress: { read: 700, analyzed: 200, reused, batches: 1 }, coverage: { total: 700, text: 665, skipped: 35, target_text: 665, participants: 5 } }
    s.running.value = true
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'g@chatroom', isGroup: true } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.insight-overview').text()).toContain('消息标签：200 / 665')
    for (const section of ['.insight-overview', '.task-detail']) {
      expect(wrapper.find(section).text()).toContain(`其中复用 ${reused} 条，新识别 ${200 - reused} 条`)
    }
    expect(wrapper.find('.analysis-launch').text()).toContain('最终画像仍根据所选范围内的全部材料重新整理')
    s.activeTask.value.progress.analyzed = 665; await flushPromises()
    expect(wrapper.find('.insight-overview').text()).toContain('消息标签：665 / 665')
    expect(wrapper.find('.insight-overview').text()).toContain('状态：分析中')
    expect(wrapper.find('.task-detail').text()).toContain('整理最终画像')
    s.activeTask.value.progress.reused = 665; await flushPromises()
    expect(wrapper.find('.insight-overview').text()).toContain('其中复用 665 条，新识别 0 条')
    delete s.activeTask.value.progress.reused
    s.activeTask.value.status = 'failed'; s.running.value = false; await flushPromises()
    expect(wrapper.findAll('.label-reuse')).toHaveLength(0)
    expect(wrapper.find('.task-detail').text()).toContain('已保存的标签')
    expect(wrapper.find('.task-detail').text()).not.toContain('已完成批次的标签')
    wrapper.unmount()
  })
  it('私聊新任务只展示对方的读取与分析范围', () => {
    const s = state()
    s.activeTask.value = { ...s.activeTask.value, analysis_scope: 'peer', read_scope: 'peer',
      progress: { read: 90, analyzed: 82, batches: 4 }, coverage: { total: 90, text: 82, skipped: 8, target_text: 82, participants: 1 } }
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend', name: '好友' } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.analysis-launch').text()).toContain('只读取并分析对方')
    expect(wrapper.find('.insight-overview').text()).toContain('已读取对方消息：90')
    expect(wrapper.find('.insight-overview').text()).toContain('对方文本：82')
    expect(wrapper.find('.insight-overview').text()).toContain('消息标签：82 / 82')
    expect(wrapper.find('.analysis-scope').text()).toContain('本人消息不进入本任务')
    expect(wrapper.find('.task-detail').text()).toContain('已读取对方消息 90')
    expect(wrapper.find('.task-detail').text()).toContain('对方消息 90 · 对方文本 82 · 跳过 8')
    expect(wrapper.find('.task-detail').text()).not.toContain('会话发言人数')
    wrapper.unmount()
  })
  it.each([undefined, 'conversation'])('旧私聊任务保留实际全会话分析计数并提示重新分析（scope=%s）', analysisScope => {
    const s = state()
    s.activeTask.value = { ...s.activeTask.value, ...(analysisScope ? { analysis_scope: analysisScope, read_scope: 'conversation' } : {}),
      progress: { read: 209, analyzed: 187, batches: 9 }, coverage: { total: 209, text: 187, skipped: 22, target_text: 82, participants: 2 } }
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend', name: '好友' } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.insight-overview').text()).toContain('已扫描会话消息：209')
    expect(wrapper.find('.insight-overview').text()).toContain('对方文本：82')
    expect(wrapper.find('.insight-overview').text()).toContain('消息标签：187 / 187')
    expect(wrapper.find('.task-detail').text()).toContain('会话文本 187')
    expect(wrapper.find('.analysis-scope').text()).toContain('此历史任务分析了双方文本')
    expect(wrapper.find('.analysis-scope').text()).toContain('重新分析将只读取并分析对方消息')
    wrapper.unmount()
  })
  it('选择成员与开始按钮在同一区域，成员读取及分析进度不展示全群统计', async () => {
    const s = state(); s.member.value = 'member-a'; s.members.value = [{ username: 'member-a', displayName: 'STU' }]
    s.activeTask.value = { ...s.activeTask.value, member_username: 'member-a', analysis_scope: 'member', read_scope: 'member',
      progress: { read: 114, analyzed: 38, batches: 38 }, coverage: { total: 114, text: 113, skipped: 1, target_text: 113, participants: 1 } }
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'g@chatroom', isGroup: true } }, global: { stubs: { AgentModelPicker: true } } })
    const launch = wrapper.find('[aria-label="分析对象与启动"]')
    expect(launch.find('[aria-label="选择分析对象"]').text()).toContain('STU')
    expect(launch.find('.start-analysis').text()).toContain('STU')
    expect(launch.element.closest('.analysis-settings')).toBe(null)
    await launch.find('[aria-label="选择分析对象"]').trigger('click')
    expect(launch.find('[aria-label="画像分析对象"]').element.value).toBe('member-a')
    expect(wrapper.find('.insight-overview').text()).toContain('已读取成员消息：114')
    expect(wrapper.find('.insight-overview').text()).toContain('消息标签：38 / 113')
    expect(wrapper.find('.task-detail').text()).toContain('STU')
    expect(wrapper.find('.task-detail').text()).toContain('消息标签 38 / 113')
    expect(wrapper.find('.portrait-hero').text()).not.toContain('发言人数')
    s.running.value = true; s.activeTask.value.status = 'running'; await flushPromises()
    for (const selector of ['[aria-label="选择分析对象"]', '[aria-label="画像分析对象"]', '[aria-label="画像分析方式"]', '[aria-label="画像分析历史"]']) expect(wrapper.find(selector).attributes('disabled')).toBeDefined()
    expect(launch.text()).toContain('取消当前分析后再切换对象')
    expect(launch.findAll('button').some(b => b.text() === '取消分析')).toBe(true)
    wrapper.unmount()
  })
  it('成员任务按保存的分析范围显示进度，扫描总数不混作模型工作量，旧历史保持全会话范围', async () => {
    const s = state(); s.engine.value = 'laya'; s.member.value = 'member-a'
    s.activeTask.value = { ...s.activeTask.value, engine: 'laya', member_username: 'member-a', analysis_scope: 'member', status: 'cancelled', portrait: null,
      progress: { read: 705, analyzed: 18, batches: 18 }, coverage: { total: 705, text: 583, skipped: 122, target_text: 113, participants: 8 } }
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'g@chatroom', isGroup: true } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.insight-overview').text()).toContain('已分析：18 / 113')
    expect(wrapper.find('.insight-overview').text()).toContain('已扫描会话消息：705')
    expect(wrapper.find('.insight-overview').text()).toContain('目标成员文本：113')
    expect(wrapper.find('.task-detail').text()).toContain('已扫描 705')
    expect(wrapper.find('.task-detail').text()).toContain('会话文本 583')
    expect(wrapper.find('.analysis-scope').text()).toContain('仅分析所选成员')
    delete s.activeTask.value.analysis_scope; await flushPromises()
    expect(wrapper.find('.insight-overview').text()).toContain('已分析：18 / 583')
    expect(wrapper.find('.analysis-scope').text()).toContain('历史任务的分析范围为全会话文本')
    s.activeTask.value.progress.analyzed = 583; await flushPromises()
    expect(wrapper.find('.insight-overview').text()).toContain('已分析：583 / 583')
    s.activeTask.value = { ...s.activeTask.value, analysis_scope: 'conversation', member_username: '' }; s.member.value = ''; await flushPromises()
    expect(wrapper.find('.insight-overview').text()).toContain('已分析：583 / 583')
    expect(wrapper.find('.analysis-scope').exists()).toBe(false)
    wrapper.unmount()
  })
  it('切换本地展示模型下载管理和统计画像说明，不显示API选择及上下文预算', async () => {
    const s = state()
    const wrapper = mount(ChatInsightsPanel, { props: { state: s }, global: { stubs: { AgentModelPicker: true } } })
    await wrapper.find('[aria-label="画像分析方式"]').setValue('laya')
    s.activeTask.value = null; s.localModel.value = { name: 'Laya', state: 'missing', total_bytes: 681000000, downloaded_bytes: 0, device: 'cpu', error: null }
    await flushPromises()
    expect(wrapper.findComponent({ name: 'AgentModelPicker' }).exists()).toBe(false)
    expect(wrapper.text()).toContain('统计规则整理画像')
    expect(wrapper.text()).toContain('CPU')
    expect(wrapper.find('.start-analysis').attributes('disabled')).toBeDefined()
    await wrapper.find('[aria-label="下载本地画像模型"]').trigger('click')
    expect(s.downloadLocalModel).toHaveBeenCalledOnce(); expect(s.create).not.toHaveBeenCalled()
    s.localModel.value = { ...s.localModel.value, state: 'downloading', downloaded_bytes: 340500000 }; await flushPromises()
    expect(wrapper.find('progress').attributes('value')).toBe('340500000')
    await wrapper.find('[aria-label="暂停本地模型下载"]').trigger('click'); expect(s.pauseLocalModel).toHaveBeenCalledOnce()
    s.localModel.value.state = 'paused'; await flushPromises()
    expect(wrapper.find('[aria-label="下载本地画像模型"]').text()).toContain('继续下载')
    s.localModel.value.state = 'ready'; await flushPromises()
    expect(wrapper.find('.start-analysis').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).not.toContain('258,000')
    wrapper.unmount()
  })
  it('导入已有模型复用桌面目录选择并需明确导入，失败展示原始诊断', async () => {
    const s = state(); s.engine.value = 'laya'; s.localModel.value = { state: 'failed', total_bytes: 681000000, downloaded_bytes: 50, error: { code: 'HASH', message: '哈希校验失败', diagnostic_id: 'local-diag' } }
    window.wechatDesktop = { chooseDirectory: vi.fn(async () => ({ canceled: false, filePaths: ['G:\\models\\laya'] })) }
    const wrapper = mount(ChatInsightsPanel, { props: { state: s }, global: { stubs: { AgentModelPicker: true } } })
    await wrapper.find('[aria-label="选择已有模型目录"]').trigger('click'); await flushPromises()
    expect(s.localModelPath.value).toBe('G:\\models\\laya')
    expect(s.importLocalModel).not.toHaveBeenCalled()
    await wrapper.find('[aria-label="导入已有画像模型"]').trigger('click')
    expect(s.importLocalModel).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('HASH：哈希校验失败')
    expect(wrapper.text()).toContain('local-diag')
    wrapper.unmount(); delete window.wechatDesktop
  })
  it('真实模型选择器的手动submit不启动分析；两个启动按钮显式选择是否重算', async () => {
    vi.stubGlobal('useAiApi', () => ({ request: async () => ({ metadata: {} }) }))
    const s = state(); s.profiles.value = [{ id: 'p', model: 'm', name: '测试服务' }]; s.modelChoice.value = { profile_id: 'p', model_id: 'm' }
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend' } } })
    await wrapper.find('[aria-label="切换模型"]').trigger('click')
    await wrapper.find('.manual-toggle').trigger('click')
    await wrapper.find('[aria-label="手动模型 ID"]').setValue('manual')
    expect(s.create).not.toHaveBeenCalled()
    await wrapper.find('.model-list form').trigger('submit'); await flushPromises()
    expect(s.modelChoice.value.model_id).toBe('manual')
    expect(s.create).not.toHaveBeenCalled()
    await wrapper.find('.start-analysis').trigger('click')
    expect(s.create.mock.calls).toEqual([[]])
    await wrapper.find('[aria-label="从头重算全部消息"]').trigger('click')
    expect(s.create.mock.calls).toEqual([[], [true]])
    wrapper.unmount()
  })
  it('隐私模式模糊当前成员与成员候选身份', async () => {
    const s = state(); s.members.value = [{ username: 'secret', displayName: '隐私姓名' }]; s.member.value = 'secret'
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'g@chatroom', isGroup: true }, privacyMode: true }, global: { stubs: { AgentModelPicker: true } } })
    const trigger = wrapper.find('[aria-label="选择分析对象"]')
    expect(trigger.element.closest('.privacy-blur')).not.toBe(null)
    await trigger.trigger('click')
    expect(wrapper.find('option[value="secret"]').element.closest('.privacy-blur')).not.toBe(null)
    wrapper.unmount()
  })
  it('消息标签位于消息正文列中，不挤占头像容器', () => {
    const labels = ref({ 's:1': { emotion: '开心' } })
    const wrapper = mount(MessageItem, { props: { message: { id: 'a', sender: '好友', renderType: 'text', content: 'hello' }, state: { insightLabels: labels, privacyMode: false, onMessageAvatarMouseEnter: vi.fn(), onMessageAvatarMouseLeave: vi.fn(), openMediaContextMenu: vi.fn(), contactProfileCardOpen: false, contactProfileCardMessageId: '', highlightServerIdStr: '', highlightMessageId: '', isMentionContactProfileCardForMessage: () => false } }, global: { directives: { chatLazySrc: () => {}, chatMediaPerf: () => {} }, stubs: { MessageContent: true, ContactProfileCard: true, MessageInsightLabel: { name: 'MessageInsightLabel', props: ['labels'], template: '<div class="test-insight-label" />' } } } })
    expect(wrapper.find('.test-insight-label').element.parentElement.classList.contains('group')).toBe(true)
    expect(wrapper.findComponent({ name: 'MessageInsightLabel' }).props('labels')).toEqual(labels.value)
    wrapper.unmount()
  })
  it('私聊和群聊本人气泡均隐藏旧手动与自动标签，其他人标签照常显示', async () => {
    const label = { identity: 's:1', text: 'hello', fingerprint: createHash('sha256').update('hello').digest('hex'), emotion: '期待', intent: '邀约', reason: '旧保存结果' }
    const labels = ref({ 's:1': { ...label, task_id: 'old-manual' } }), selectedContact = ref({ username: 'friend' })
    const message = { id: 'db:t:1', serverIdStr: '1', sender: '本人', renderType: 'text', content: 'hello', isSent: true, isGroup: false }
    const wrapper = mount(MessageItem, { props: { message, state: { selectedContact, insightLabels: labels, privacyMode: false, onMessageAvatarMouseEnter: vi.fn(), onMessageAvatarMouseLeave: vi.fn(), openMediaContextMenu: vi.fn(), contactProfileCardOpen: false, contactProfileCardMessageId: '', highlightServerIdStr: '', highlightMessageId: '', isMentionContactProfileCardForMessage: () => false } }, global: { directives: { chatLazySrc: () => {}, chatMediaPerf: () => {} }, stubs: { MessageContent: true, ContactProfileCard: true } } })
    await flushPromises(); await new Promise(resolve => setTimeout(resolve, 10)); await flushPromises()
    expect(wrapper.find('.message-insight-label').exists()).toBe(false)
    labels.value = { 's:1': { ...label, batch_id: 'old-live' } }; await flushPromises()
    expect(wrapper.find('.message-insight-label').exists()).toBe(false)
    await wrapper.setProps({ message: { ...message, isSent: false } })
    await flushPromises(); await new Promise(resolve => setTimeout(resolve, 10)); await flushPromises()
    expect(wrapper.find('.message-insight-label').text()).toContain('期待')
    await wrapper.setProps({ message })
    expect(wrapper.find('.message-insight-label').exists()).toBe(false)
    selectedContact.value = { username: 'group@chatroom' }
    await flushPromises(); await new Promise(resolve => setTimeout(resolve, 10)); await flushPromises()
    expect(wrapper.find('.message-insight-label').exists()).toBe(false)
    labels.value = { 's:1': { ...label, task_id: 'old-manual' } }; await flushPromises()
    expect(wrapper.find('.message-insight-label').exists()).toBe(false)
    selectedContact.value = { username: 'group', isGroup: true }
    await flushPromises()
    expect(wrapper.find('.message-insight-label').exists()).toBe(false)
    selectedContact.value = { username: 'friend' }; await wrapper.setProps({ message: { ...message, isGroup: true } })
    expect(wrapper.find('.message-insight-label').exists()).toBe(false)
    await wrapper.setProps({ message: { ...message, isGroup: true, isSent: false } })
    await flushPromises(); await new Promise(resolve => setTimeout(resolve, 10)); await flushPromises()
    expect(wrapper.find('.message-insight-label').text()).toContain('邀约')
    wrapper.unmount()
  })
  it('未知雷达轴不补零、不画完整闭合多边形，完整六轴才画面积', async () => {
    const traits = portrait().traits
    const wrapper = mount(InsightRadar, { props: { traits } })
    expect(wrapper.text()).toContain('幽默：证据不足')
    expect(wrapper.find('[data-radar-area]').exists()).toBe(false)
    await wrapper.setProps({ traits: { ...traits, humor: score(55) } })
    expect(wrapper.find('[data-radar-area]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('画像显示真实覆盖、快照、MBTI四轴，证据不足不编完整类型；原文可定位', async () => {
    const s = state(), locate = vi.fn(async () => true)
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend', name: '好友' }, locateSource: locate }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.text()).toContain('snapshot')
    expect(wrapper.text()).toContain('跳过 5')
    expect(wrapper.text()).toContain('人物摘要')
    expect(wrapper.text()).toContain('完整类型：证据不足')
    await wrapper.find('[data-source="a"]').trigger('click'); await flushPromises()
    expect(locate).toHaveBeenCalledWith({ source: 'a', username: 'friend', anchor: 'db:table:1' })
    expect(wrapper.text()).toContain('样本有限')
    s.activeTask.value.context_budget = { window: 258000, compression_at: 232200, source: 'user_assumed', compressions: 2, measurement: 'utf8_upper_bound' }
    await flushPromises()
    expect(wrapper.text()).toContain('258,000')
    expect(wrapper.text()).toContain('用户指定，未经服务商确认')
    expect(wrapper.text()).toContain('已压缩 2 次')
    await wrapper.find('[aria-label="显示消息情绪与意图标签"]').setValue(true)
    expect(s.labelsEnabled.value).toBe(true); expect(s.create).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('仪表盘设置可展开并返回聊天，读取成员只在选择面板展开时发起', async () => {
    const s = state()
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'g@chatroom', isGroup: true } }, global: { stubs: { AgentModelPicker: true } } })
    expect(s.loadMembers).not.toHaveBeenCalled()
    await wrapper.find('[aria-label="选择分析对象"]').trigger('click')
    expect(s.loadMembers).toHaveBeenCalledOnce()
    await wrapper.find('[aria-label="画像分析设置"]').trigger('click')
    expect(wrapper.find('.analysis-settings').element.open).toBe(true)
    await wrapper.find('[aria-label="返回聊天"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
  it('人物仪表盘按原始四轴展示互补比例，未知轴不填默认值；定位成功返回聊天', async () => {
    const s = state(), locate = vi.fn(async () => true)
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend', name: '好友' }, locateSource: locate }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.insight-overview').text()).toContain('会话消息：15')
    expect(wrapper.find('.mbti-card').text()).toContain('E 60% · I 40%')
    expect(wrapper.find('[data-mbti-axis="JP"]').text()).toContain('证据不足')
    expect(wrapper.find('[data-mbti-axis="JP"] meter').exists()).toBe(false)
    expect(wrapper.find('.affinity-score').text()).toContain('70')
    expect(wrapper.find('.topics-card').text()).toContain('日常话题')
    expect(wrapper.find('.analysis-settings').element.open).toBe(false)
    await wrapper.find('.summary-card [data-source="a"]').trigger('click'); await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
  it('群整体展示交流氛围与实际发言人数，不展示人物MBTI或亲近分', () => {
    const s = state(); s.activeTask.value.portrait.mbti = null; s.activeTask.value.portrait.affinity = null
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'g@chatroom', name: '群聊', isGroup: true } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.group-atmosphere').text()).toContain('轻松')
    expect(wrapper.find('.portrait-hero').text()).toContain('发言人数')
    expect(wrapper.find('.mbti-card').exists()).toBe(false)
    expect(wrapper.find('.affinity-score').exists()).toBe(false)
    expect(wrapper.find('.radar-card').exists()).toBe(true)
    expect(wrapper.find('.summary-card').text()).toContain('群整体摘要')
    wrapper.unmount()
  })
  it('从模型配置入口打开时直接展示分析设置；来源定位失败保留原始错误', async () => {
    const s = state()
    const wrapper = mount(ChatInsightsPanel, { props: { state: s, showSettings: true, contact: { username: 'friend' }, locateSource: async () => { throw new Error('消息读取失败') } }, global: { stubs: { AgentModelPicker: true } } })
    expect(wrapper.find('.analysis-settings').element.open).toBe(true)
    await wrapper.find('.summary-card [data-source="a"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[role=alert]').text()).toContain('消息读取失败')
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })
  it('定位期间切换任务后，旧来源的成功或失败不关闭新画像或写入过期错误', async () => {
    for (const fails of [false, true]) {
      const s = state(); let finish
      const pending = new Promise((resolve, reject) => { finish = () => fails ? reject(new Error('旧会话定位失败')) : resolve(true) })
      const wrapper = mount(ChatInsightsPanel, { props: { state: s, contact: { username: 'friend' }, locateSource: () => pending }, global: { stubs: { AgentModelPicker: true } } })
      await wrapper.find('.summary-card [data-source="a"]').trigger('click')
      s.activeTask.value = { ...s.activeTask.value, id: 'new-chat-task' }
      finish(); await flushPromises()
      expect(s.error.value).toBe('')
      expect(wrapper.emitted('close')).toBeUndefined()
      wrapper.unmount()
    }
  })
  it('SHA256以实际content为依据；同一消息改文本立即隐藏旧标签，媒体不显示', async () => {
    const text = '  hello\n', bytes = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
    const labels = { 's:9007199254740993': { text, fingerprint, emotion: '开心', intent: '问候', reason: '语气温暖', sources: ['a'] } }
    const message = { serverIdStr: '9007199254740993', id: 'db:table:1', createTime: 10, renderType: 'text', content: text }
    const wrapper = mount(MessageInsightLabel, { props: { message, labels } })
    await flushPromises(); await new Promise(resolve => setTimeout(resolve, 10)); await flushPromises()
    expect(wrapper.text()).toContain('开心')
    await wrapper.setProps({ message: { ...message, content: 'changed' } })
    expect(wrapper.text()).not.toContain('开心')
    await wrapper.setProps({ message: { ...message, renderType: 'image' } }); await flushPromises()
    expect(wrapper.text()).toBe('')
    await wrapper.setProps({ message: { ...message, renderType: 'quote' } }); await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 10)); await flushPromises()
    expect(wrapper.text()).toContain('开心')
    wrapper.unmount()
  })
})
