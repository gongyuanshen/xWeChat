import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { scanExports } from 'unimport'
import { resolve } from 'node:path'
import AgentRun from '../components/chat/AgentRun.vue'
import { mergeTimeline, groupTimelineTools, mergeRunEvent } from '../utils/agentTimeline'

it('Nuxt 扫描时间线工具时不把函数参数注册成全局导出', async () => {
  const scanned = await scanExports(resolve('utils/agentTimeline.js'), false)
  expect(scanned.map(item => item.name).sort()).toEqual([
    'groupTimelineTools', 'mergeReferenceData', 'mergeRunEvent', 'mergeTimeline',
  ])
})

it('SSE 重放按任务版本和时间合并预算、覆盖和状态', () => {
  const original = {id:'r',version:1,updated_at:10,status:'running',answer:'已显示内容',timeline:[]}
  const next = mergeRunEvent(original, {run_id:'r',version:2,updated_at:20,status:'running',
    context_budget:{run_id:'r',version:2,used:60},coverage:{run_id:'r',version:2,complete:false,conversations:[{username:'new'}]}})
  expect(next.version).toBe(2)
  expect(next.answer).toBe('已显示内容')
  expect(mergeRunEvent(next, {run_id:'r',version:1,updated_at:30,status:'completed'})).toBe(next)
  const replay = mergeRunEvent(next, {run_id:'r',version:2,updated_at:15,status:'completed',context_budget:{used:99},coverage:{complete:true,conversations:[]}})
  expect(replay).toEqual(next)
  const foreign = mergeRunEvent(next, {run_id:'r',version:2,updated_at:21,context_budget:{run_id:'other',version:2,used:5},coverage:{run_id:'r',version:1,complete:true}})
  expect(foreign.context_budget.used).toBe(60)
  expect(foreign.analysis.coverage).toEqual([{username:'new'}])
  expect(mergeRunEvent(next, {run_id:'other',version:9})).toBe(next)
})

it('重复的同版步骤不覆盖已显示的来源身份', () => {
  const item = {id:'answer:r',kind:'answer',revision:2,text:'已显示正文'}
  const current = {id:'r',version:1,timeline:[item],references:[{id:'p',name:'乙'}]}
  const next = mergeRunEvent(current, {run_id:'r',version:1,timeline_item:{...item},references:[{id:'p',name:'错误姓名'}]})
  expect(next.references[0].name).toBe('乙')
})

it('终态 SSE 快照补齐回答、用量、覆盖和全部引用', () => {
  const current = {id:'r',version:1,updated_at:10,status:'running',answer:'流式草稿',timeline:[],citations:[],references:[]}
  const event = {type:'run_snapshot',run_id:'r',version:1,updated_at:20,status:'completed',
    patch:{answer:'最终回答',finished_at:20,usage:{calls:2,input_tokens:10,output_tokens:5},source_count:3,
      analysis:{known:true,complete:true,coverage:[],segments:1,findings:2,analyzed:3}},
    citations:[{source:'a'}],references:[{id:'p',kind:'person'}]}
  const next = mergeRunEvent(current,event)
  expect(next).toMatchObject({status:'completed',answer:'最终回答',finished_at:20,source_count:3,usage:{calls:2},analysis:{complete:true}})
  expect(next.citations).toEqual([{source:'a'}])
  expect(next.references).toEqual([{id:'p',kind:'person'}])
})

const base = () => ({id:'run1',status:'running',stage:'搜索聊天记录',segment_started:100,stage_started_at:101,elapsed_seconds:0,read_count:50,timeline:[
  {id:'tool1',seq:1,revision:2,kind:'tool',text:'搜索报价',status:'completed',started_at:100,finished_at:102,result:{returned:8}},
  {id:'note',seq:2,revision:1,kind:'progress',text:'找到两次报价，继续核对修改。',status:'completed',started_at:103},
  {id:'tool2',seq:3,revision:1,kind:'tool',text:'读取后续消息',status:'running',started_at:103},
],answer:'',citations:[]})
const setup = (extra={}) => mount(AgentRun,{attachTo:document.body,props:{run:base(),now:105000,nearBottom:true,latest:true,viewState:reactive({}),...extra}})

it('DeepAgents 简单对话隐藏查询元信息和空出处', () => {
  const wrapper = setup({ run: { ...base(), status: 'completed', coverage_state: 'not_applicable', answer: '你好！',
    read_count: 0, source_count: 0, timeline: [], citations: [], analysis: { known: false } } })
  expect(wrapper.text()).not.toContain('范围覆盖情况未知')
  expect(wrapper.text()).not.toContain('查看出处')
  expect(wrapper.text()).not.toContain('语义索引')
  wrapper.unmount()
})

it('旧任务只提供新引擎重新运行入口', async () => {
  const wrapper = setup({ run: { ...base(), status: 'interrupted', engine: 'legacy', restart_required: true, can_resume: false } })
  const restart = wrapper.findAll('button').find(button => button.text() === '使用新引擎重新运行')
  expect(restart).toBeTruthy()
  await restart.trigger('click')
  expect(wrapper.emitted('restart')).toHaveLength(1)
  expect(wrapper.findAll('button').some(button => button.text() === '继续')).toBe(false)
  wrapper.unmount()
})

describe('Agent 执行对话流',()=>{
  it('最终统计仅在回答末尾复制右侧显示，折叠过程不影响统计', async () => {
    const run = {...base(),answer:'回答内容',read_count:354,analysis:{known:true,tracked:false},used:{models:5},usage:{calls:0,input_tokens:0,output_tokens:0}}
    const w = setup({run})
    expect(w.find('.agent-final-summary').exists()).toBe(false)
    await w.setProps({run:{...run,status:'completed',usage:{calls:5,input_tokens:112694,output_tokens:1197}}})
    const footer = w.find('.agent-answer-footer')
    expect(footer.find('[aria-label="复制回答"]').element.nextElementSibling).toBe(footer.find('.agent-final-summary').element)
    expect(footer.text()).toBe('已读取 354 条 · 按需检索 · 输入 11.3w · 输出 1.2k Token')
    expect(footer.find('.agent-final-summary').attributes('title')).toBe('已读取 354 条 · 按需检索 · 输入 112694 · 输出 1197 Token')
    expect(w.find('.agent-process-panel .agent-final-summary').exists()).toBe(false)
    await w.find('.agent-process-toggle').trigger('click')
    expect(footer.isVisible()).toBe(true)
    await w.setProps({run:{...run,status:'completed',coverage_state:'not_applicable',usage:{input_tokens:0,unknown:1}}})
    expect(footer.text()).toBe('输入 0 · 输出 未知 Token')
    expect(footer.find('.agent-final-summary').attributes('title')).toContain('显示已知部分')
    await w.setProps({run:{...run,status:'completed',answer:''}})
    expect(w.find('.agent-answer-footer').exists()).toBe(false)
    w.unmount()
  })
  it.each([
    [0, '0'], [350, '350'], [999, '999'], [1000, '1k'], [1250, '1.3k'],
    [9999, '1w'], [10000, '1w'], [112694, '11.3w'], [999999, '1m'],
    [1000000, '1m'], [1250000, '1.3m'], [undefined, '未知'], [null, '未知'],
  ])('文末 Token 数量 %s 自动显示为 %s', (value, expected) => {
    const w = setup({run:{...base(),status:'completed',answer:'回答',coverage_state:'not_applicable',usage:{input_tokens:value,output_tokens:value}}})
    expect(w.find('.agent-final-summary').text()).toBe(`输入 ${expected} · 输出 ${expected} Token`)
    w.unmount()
  })
  it('旧详情展开状态不会恢复已移除的统计和入口', () => {
    const w = setup({run:{...base(),status:'completed',usage:{calls:6,input_tokens:100,output_tokens:20,unknown:1},
      query_filters:{conversations:['friend']},time_range:{start:100,end:200},
      analysis:{known:true,coverage:[{username:'friend',read:50}],segments:2},
      index_status:{enabled:true,message:'语义索引已暂停'}},viewState:reactive({'run1:details':true,'run1:readingCoverage':true,'run1:materials':true})})
    expect(w.find('.agent-usage').exists()).toBe(false)
    expect(w.find('.agent-run-details').exists()).toBe(false)
    for (const label of ['运行详情','执行统计','聊天范围','查询时间','逐聊天覆盖','语义索引已暂停','查看用量审计']) expect(w.text()).not.toContain(label)
    expect(w.find('.agent-materials-link').exists()).toBe(false)
    w.unmount()
  })
  it('运行中保留阶段与计时，不显示读取统计或等待说明', async () => {
    const r={...base(),stage:'正在分段分析',analysis:{known:true,analyzed:20,complete:false}}
    const w=setup({run:r,now:132000})
    expect(w.find('.agent-live-hint').exists()).toBe(false)
    expect(w.find('.agent-live-step .agent-wait-note').exists()).toBe(false)
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.find('.agent-process').isVisible()).toBe(false)
    expect(w.find('.agent-live-step').isVisible()).toBe(true)
    expect(w.find('.agent-run-metadata').exists()).toBe(false)
    await w.setProps({run:{...r,analysis:{known:true,analyzed:50,complete:true}}})
    expect(w.find('.agent-live-hint').exists()).toBe(false)
    await w.setProps({run:{...r,status:'failed',error:'服务暂时不可用'}})
    expect(w.find('.agent-live-step').exists()).toBe(false)
    expect(w.find('.agent-error').isVisible()).toBe(true)
    w.unmount()
  })
  it('真实分段总结的已完成阶段持续可见，当前同名阶段只在入口展示', async () => {
    const timeline = [
      {id:'s1',seq:1,kind:'status',text:'理解问题与读取范围',status:'completed',started_at:100,finished_at:104},
      {id:'s2',seq:2,kind:'status',text:'正在读取聊天记录',status:'completed',started_at:104,finished_at:106},
      {id:'s3',seq:3,kind:'status',text:'正在分段分析',status:'completed',started_at:106,finished_at:109},
      {id:'s4',seq:4,kind:'status',text:'正在分段分析',status:'running',started_at:109},
    ]
    const r = {...base(),stage:'正在分段分析',timeline,usage:{calls:2}}
    const w = setup({run:r,now:111000})
    expect(w.find('.agent-process-body').isVisible()).toBe(true)
    expect(w.findAll('.agent-stage-row').map(x=>x.text())).toEqual([
      '理解问题与读取范围已完成 · 4秒','读取聊天记录已完成 · 2秒','分段分析已完成 · 3秒',
    ])
    expect(w.find('.agent-stream-status').text()).toBe('思考中')
    await w.setProps({run:{...r,status:'completed',answer:'总结',timeline:timeline.map(x=>x.id==='s4'?{...x,status:'completed',finished_at:113}:x)}})
    expect(w.find('.agent-process-body').isVisible()).toBe(true)
    expect(w.findAll('.agent-stage-row')).toHaveLength(4)
    expect(w.findAll('.agent-stage-row').at(-1).text()).toContain('已完成 · 4秒')
    w.unmount()
  })
  it('等待首个工具与折叠历史时持续显示思考状态和真实计时', async () => {
    const r = {...base(),timeline:[],stage:'理解问题与读取范围',stage_started_at:100,read_count:0,usage:{calls:1}}
    const w = setup({run:r,now:105000})
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('false')
    expect(w.find('.agent-process').isVisible()).toBe(false)
    expect(w.find('.agent-live-step').isVisible()).toBe(true)
    expect(w.find('.agent-live-caption').exists()).toBe(false)
    expect(w.find('.agent-live-step .agent-icon-spin').exists()).toBe(false)
    expect(w.find('.agent-live-step .agent-shimmer').text()).toBe(w.find('.agent-stream-status').text())
    expect(w.find('.agent-stream-status').text()).toBe('思考中')
    expect(w.find('.agent-process-title').text()).toBe('执行中')
    expect(w.find('.agent-process-meta').text()).toBe('0分5秒')
    expect(w.find('.agent-live-step time').text()).toBe('5秒')
    await w.setProps({now:109000})
    expect(w.find('.agent-process-meta').text()).toBe('0分9秒')
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.find('.agent-process-body').isVisible()).toBe(true)
    await w.find('.agent-process-toggle').trigger('click')
    await w.setProps({run:{...r,stage:'搜索聊天记录',stage_started_at:108,timeline:base().timeline,read_count:8}})
    expect(w.find('.agent-stream-status').text()).toBe('思考中')
    expect(w.find('.agent-live-step time').text()).toBe('1秒')
    expect(w.find('.agent-live-hint').exists()).toBe(false)
    expect(w.find('.agent-process').isVisible()).toBe(false)
    await w.setProps({run:{...r,status:'completed',answer:'结果'}})
    expect(w.find('.agent-stream-status').exists()).toBe(false)
    expect(w.find('.agent-live-step').exists()).toBe(false)
    expect(w.find('.agent-final-answer').isVisible()).toBe(true)
    w.unmount()
  })
  it('回答保留复制操作，旧展开状态不会恢复出处或资料说明', async () => {
    const w = setup({run:{...base(),status:'completed',answer:'最终回答内容',coverage_warnings:['图片尚未读取','文件尚未解析']},
      viewState:reactive({'run1:evidence':true,'run1:coverage':true})})
    await w.find('.agent-process-toggle').trigger('click')
    const actions = w.find('.agent-result-actions')
    expect(actions.find('[aria-label="复制回答"]').exists()).toBe(true)
    expect(actions.find('[aria-label="查看出处"]').exists()).toBe(false)
    expect(actions.find('.agent-coverage-action').exists()).toBe(false)
    expect(w.find('.agent-coverage-explanation').exists()).toBe(false)
    expect(w.find('.agent-evidence-panel').exists()).toBe(false)
    expect(w.find('.agent-process').isVisible()).toBe(false)
    await w.setProps({run:{...base(),status:'running',answer:'正在生成',coverage_warnings:['图片尚未读取']}})
    expect(w.find('.agent-result-actions').exists()).toBe(false)
    expect(w.find('.agent-coverage-explanation').exists()).toBe(false)
    w.unmount()
  })
  it('完成后默认展开过程，仍可手动收起', async () => {
    const w = setup({run:{...base(),timeline:base().timeline.filter(item=>item.kind!=='progress'),status:'completed',elapsed_seconds:141,answer:'约饭定在周三',usage:{calls:6,input_tokens:100,output_tokens:20}}})
    expect(w.find('.agent-process-toggle').text()).toContain('执行过程')
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('true')
    expect(w.find('.agent-final-answer').isVisible()).toBe(true)
    expect(w.find('.agent-answer-heading').exists()).toBe(false)
    expect(w.find('.agent-process').isVisible()).toBe(true)
    expect(w.find('.agent-run-metadata').exists()).toBe(false)
    const text = w.text()
    expect(w.find('.agent-process-title').text()).toBe('执行过程')
    expect(w.find('.agent-process-meta').text()).toBe('2分21秒')
    expect(w.find('.agent-process-toggle').text()).not.toMatch(/已完成|项操作|展开|收起/)
    expect(text.indexOf('2分21秒')).toBeLessThan(text.indexOf('搜索报价'))
    expect(text).not.toContain('用量与读取范围')
    expect(w.find('.agent-run-metadata > summary').exists()).toBe(false)
    expect(w.find('.agent-run-details').exists()).toBe(false)
    expect(w.find('.agent-usage').exists()).toBe(false)
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.find('.agent-final-answer').isVisible()).toBe(true)
    expect(w.find('.agent-run-metadata').exists()).toBe(false)
    w.unmount()
  })
  it('过程与回答有独立区域，阶段回复直接呈现为段落，未完成回答不会标为最终回答', async () => {
    const w = setup({run:{...base(),answer:'正在整理的回答'}})
    const process = w.find('.agent-process-panel')
    expect(process.attributes('aria-label')).toBe('执行过程')
    expect(process.find('[aria-label="阶段性回复"]').text()).toContain('找到两次报价')
    expect(process.find('.agent-progress-caption').exists()).toBe(false)
    expect(process.find('.agent-run-metadata').exists()).toBe(false)
    expect(process.find('.agent-final-answer').exists()).toBe(false)
    expect(w.find('.agent-answer-heading').text()).toBe('正在回答')
    await w.setProps({run:{...base(),answer:'尚未完成',status:'failed',error:'请求失败'}})
    expect(w.find('.agent-answer-heading').text()).toBe('未完成的回答')
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.find('.agent-error').isVisible()).toBe(true)
    expect(w.find('.agent-final-answer').isVisible()).toBe(true)
    w.unmount()
  })
  it('重复读取默认只显示摘要，展开保留逐次记录，缓存不重复计数且折叠状态保留', async () => {
    const a = {id:'a',kind:'tool',action:'read_context',username:'friend',status:'completed',result:{returned:21},started_at:100,finished_at:102}
    const b = {...a,id:'b',cached:true}
    const r = {...base(),timeline:[a,b]}
    const w = setup({run:r})
    const group = w.find('.agent-tool')
    expect(group.element.open).toBe(false)
    group.element.open = true
    await group.trigger('toggle')
    expect(group.element.open).toBe(true)
    expect(w.find('.agent-tool > .agent-tool-heading').text()).toContain('21 条消息 · 含 1 次复用')
    expect(w.findAll('.agent-tool-attempt-row').map(x=>x.text())).toEqual(['首次读取21 条 · 2秒','复用已读结果无需重复读取'])
    group.element.open = false
    await group.trigger('toggle')
    await w.setProps({run:{...r,timeline:[a,b,{...b,id:'c'}]}})
    expect(group.element.open).toBe(false)
    expect(w.find('.agent-tool > .agent-tool-heading').text()).toContain('21 条消息 · 含 2 次复用')
    w.unmount()
  })
  it('过程进展共用 Markdown 引用渲染，折叠历史仍显示实时状态', async () => {
    const id = '622367649b6ca270ffad893a', r = base()
    r.timeline[1].text = `约的是 **周三** (source: ${id})`
    r.citations = [{ source: id, username: 'friend', text: '周三晚饭' }]
    const w = setup({ run: r, viewState: reactive({}) })
    expect(w.find('.agent-progress-note strong').text()).toBe('周三')
    expect(w.find('.agent-progress-note .agent-ref').exists()).toBe(true)
    expect(w.find('.agent-progress-note').text()).not.toContain(id)
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('false')
    expect(w.find('.agent-process').element.style.display).toBe('none')
    expect(w.find('.agent-stream-status').isVisible()).toBe(true)
    expect(w.find('.agent-stream-status').text()).toBe('思考中')
    w.unmount()
  })
  it('按顺序显示工具和关键进展，完成后保留可见并支持一键收起',async()=>{
    const w=setup()
    expect(w.text().indexOf('搜索报价')).toBeLessThan(w.text().indexOf('找到两次报价'))
    expect(w.text().indexOf('找到两次报价')).toBeLessThan(w.text().indexOf('读取后续消息'))
    await w.setProps({run:{...base(),status:'completed',answer:'最终报价为100元',elapsed_seconds:5}})
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('true')
    expect(w.find('.agent-progress-note').isVisible()).toBe(true)
    expect(w.find('.agent-final-answer').text()).toContain('最终报价')
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('false')
    expect(w.find('.agent-final-answer').isVisible()).toBe(true)
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('true')
    w.unmount()
  })
  it('用户主动展开后，完成更新不覆盖选择；没有最终回答时不自动隐藏过程', async () => {
    const w = setup()
    await w.find('.agent-process-toggle').trigger('click')
    await w.find('.agent-process-toggle').trigger('click')
    await w.setProps({run:{...base(),status:'completed',answer:'最终回答'}})
    expect(w.find('.agent-process').isVisible()).toBe(true)
    w.unmount()
    const empty = setup({run:{...base(),status:'completed',answer:''}})
    expect(empty.find('.agent-process').isVisible()).toBe(true)
    empty.unmount()
  })
  it('完成与滚动不覆盖用户主动收起的状态',async()=>{
    const w=setup({nearBottom:false})
    await w.find('.agent-process-toggle').trigger('click')
    await w.setProps({run:{...base(),status:'completed'}})
    await w.setProps({nearBottom:true})
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('false')
    w.unmount()
  })
  it('失败保持过程展开，恢复按钮按错误类型变化',async()=>{
    const w=setup({run:{...base(),status:'failed',error:'查询指令仍无法处理',error_info:{action:'retry',diagnostic_id:'diagnostic'}}})
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('true')
    expect(w.text()).toContain('重试这一步')
    await w.setProps({run:{...base(),status:'failed',error_info:{action:'settings'}}})
    expect(w.text()).toContain('检查 AI 服务')
    expect(w.text()).not.toContain('重试这一步')
    w.unmount()
  })
  it('失败和补充记录不会假装成完成',()=>{
    const r=base();r.timeline.push({id:'supp',seq:4,revision:1,kind:'supplement',text:'只看上周',status:'received'})
    r.timeline[2].status='failed'
    const w=setup({run:r})
    expect(w.text()).toContain('已收到补充要求')
    expect(w.find('.agent-tool.is-failed').text()).toContain('这一步未完成')
    w.unmount()
  })
  it('只合并相邻同范围工具，展开保留逐次结果且不隐藏失败', async () => {
    const a = {id:'a',kind:'tool',action:'read_context',username:'friend',text:'读取上下文',status:'completed',result:{returned:21},started_at:100,finished_at:102}
    const b = {...a,id:'b',cached:true,status:'failed'}
    const r = {...base(),timeline:[a,b]}
    const w = setup({run:r})
    expect(w.findAll('.agent-tool')).toHaveLength(1)
    expect(w.find('.agent-tool > .agent-tool-heading').text()).toContain('2 次')
    expect(w.find('.agent-tool > .agent-tool-heading').text()).toContain('部分完成')
    expect(w.find('.agent-tool-detail').text()).toContain('失败')
    expect(w.find('.agent-tool > .agent-tool-heading').text()).not.toContain('21')
    expect(w.findAll('.agent-tool-attempt')).toHaveLength(2)
    expect(w.find('.agent-tool-detail').text()).toContain('复用已读结果')
    const detail=w.find('.agent-tool').element;detail.open=true
    await w.setProps({run:{...r,timeline:[a,{...b,status:'completed',revision:2}]}})
    expect(w.find('.agent-tool').element).toBe(detail)
    expect(detail.open).toBe(true)
    const grouped = groupTimelineTools([a,{id:'p',kind:'progress',text:'核对'},b,{...b,id:'c',username:'other'},{...b,id:'d',start:123}])
    expect(grouped).toHaveLength(5)
    w.unmount()
  })
  it('整理记录保留实际压缩结果，恢复中的新尝试优先显示进行中', async () => {
    const a={id:'compact-a',kind:'tool',action:'compact_context',text:'已整理阶段笔记',status:'completed',result:{saved:true,before:47872,after:24523,covered_fragments:120}}
    const b={...a,id:'compact-b',text:'整理未完成，原文已保留',status:'failed',result:undefined}
    const w=setup({run:{...base(),timeline:[a,b]}})
    expect(w.find('.agent-tool > .agent-tool-heading').text()).toContain('整理上下文')
    expect(w.find('.agent-tool > .agent-tool-heading').text()).toContain('部分完成')
    expect(w.find('.agent-tool-detail').text()).toContain('47872 → 24523 预算单位 · 120 个原文片段')
    expect(w.find('.agent-tool-detail').text()).not.toContain('0 条结果')
    await w.setProps({run:{...base(),timeline:[a,b,{...b,id:'compact-c',status:'running'}]}})
    expect(w.find('.agent-tool').classes()).toContain('is-running')
    expect(w.find('.agent-tool > .agent-tool-heading').text()).toContain('进行中')
    expect(w.find('.agent-tool-detail').text()).toContain('失败')
    w.unmount()
  })
  it('阶段性回复折叠状态在重新挂载后保留，事件重放不重复插入段落', async () => {
    const viewState = reactive({})
    let run = {...base(),status:'completed',answer:'最终回答'}
    let w = setup({run,viewState})
    expect(w.findAll('[aria-label="阶段性回复"]')).toHaveLength(1)
    await w.find('.agent-process-toggle').trigger('click')
    w.unmount()
    run = mergeRunEvent(run, {run_id:run.id,timeline_item:run.timeline[1]})
    w = setup({run,viewState})
    expect(w.find('.agent-process').isVisible()).toBe(false)
    await w.find('.agent-process-toggle').trigger('click')
    expect(w.findAll('[aria-label="阶段性回复"]')).toHaveLength(1)
    expect(w.find('.agent-progress-note').isVisible()).toBe(true)
    w.unmount()
  })
  it('重放与乱序更新按记录修订号去重',()=>{
    const current=[{id:'a',seq:1,revision:3,status:'completed'},{id:'b',seq:2,revision:1}]
    const merged=mergeTimeline(current,[{id:'c',seq:3,revision:1},{id:'a',seq:1,revision:2,status:'running'},{id:'b',seq:2,revision:2}])
    expect(merged.map(x=>x.id)).toEqual(['a','b','c'])
    expect(merged[0].status).toBe('completed')
    expect(merged[1].revision).toBe(2)
  })
  it('历史完成轮次默认展开，兼容旧步骤',async()=>{
    const w=setup({run:{id:'old',status:'completed',activity:[{id:'a',text:'原来的读取步骤',status:'completed',started_at:100,finished_at:103}],answer:'历史回答'}})
    expect(w.find('.agent-process-toggle').attributes('aria-expanded')).toBe('true')
    expect(w.find('.agent-process').isVisible()).toBe(true)
    expect(w.text()).toContain('原来的读取步骤')
    w.unmount()
  })
})
