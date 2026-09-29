import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatAgentPanel from '../components/chat/ChatAgentPanel.vue'
import AgentAnswer from '../components/chat/AgentAnswer.vue'

let state, threads, runs, request, seq, eventCallbacks, eventReady, eventDisconnected
beforeEach(() => {
  state = ref({selected:{},drafts:{},pinned:{}}); threads = {}; runs = {}; seq = 0; eventCallbacks = {}; eventReady = {}; eventDisconnected = {}
  request = vi.fn(async (path, options = {}) => {
    if (path === '/settings') return {profiles:[{id:'model',name:'测试服务',model:'fixture'}],selected_model:{profile_id:'model',model_id:'fixture'}}
    if (path === '/conversations') return [{username:'first',name:'会话一'},{username:'second',name:'会话二'}]
    if (path === '/agent/threads') {
      if (options.method === 'POST') { const id = `thread${++seq}`; return threads[id] = {id, ...options.body, scope:['first','second'], messages:[], latest_run:''} }
      return Object.values(threads).filter(t => !options.query?.username || t.username === options.query.username).map(t=>({...t,latest_run_status:runs[t.latest_run]?.status || ''}))
    }
    const [, , , id, action] = path.split('/')
    if (path.startsWith('/agent/threads/')) {
      if (options.method === 'DELETE') { delete threads[id]; return {status:'success'} }
      if (action === 'messages') {
        const t = threads[id]
        const runId = t.latest_run || `run${seq}`
        runs[runId] = {id:runId,thread_id:id,status:'running',stage:'搜索相关消息',created:Date.now()/1000,segment_started:Date.now()/1000,updated_at:Date.now()/1000,activity:[],used:{media:0},answer:'',citations:[]}
        threads[id] = {...t,title:t.title || options.body.text,latest_run:runId,messages:[...t.messages,{id:options.body.request_id,role:'user',text:options.body.text,run_id:runId,supplement:!!t.latest_run}]}
        runs[runId].timeline = threads[id].messages.filter(m=>m.supplement).map((m,i)=>({id:m.id,seq:i+1,revision:1,kind:'supplement',text:m.text,status:'received'}))
        return {...runs[runId]}
      }
      if (options.method === 'PATCH') threads[id] = {...threads[id],...options.body}
      return {...threads[id]}
    }
    if (path.startsWith('/agent/runs/')) {
      if (action === 'stop') runs[id]={...runs[id],status:'cancelled'}
      if (action === 'continue') runs[id]={...runs[id],status:'running'}
      return {...runs[id]}
    }
    return []
  })
  vi.stubGlobal('useAiApi', () => ({request,events:()=>()=>{},agentEvents:(account,callback,ready,disconnected)=>{eventCallbacks[account]=callback;eventReady[account]=ready;eventDisconnected[account]=disconnected;return ()=>{}}}))
  vi.stubGlobal('useSettingsDialog', () => ({openDialog:vi.fn()}))
  vi.stubGlobal('useState', () => state)
})
const mountPanel = () => mount(ChatAgentPanel, {attachTo:document.body,props:{account:'acc',contact:{username:'first',name:'会话一'},contacts:[{username:'first',name:'会话一'},{username:'second',name:'会话二'}]},global:{stubs:{AiSidebar:true,Teleport:true}}})
const send = async (wrapper,text) => { await wrapper.find('textarea').setValue(text); await wrapper.find('textarea').trigger('keydown',{key:'Enter'}); await flushPromises() }

describe('聊天 Agent', () => {
  it.each(['friend', 'group@chatroom'])('顶部和左侧显示对应会话头像，支持单聊和群聊：%s', async username => {
    const w = mountPanel(); await flushPromises()
    await w.setProps({contact:{username,name:'测试会话'}}); await flushPromises()
    expect(w.find('.agent-header > button[aria-label="AI 对话历史"] svg.lucide').exists()).toBe(true)
    expect(w.find('.agent-header > button[aria-label="旧版全局历史"]').exists()).toBe(false)
    const expected = `/api/chat/avatar?${new URLSearchParams({account:'acc',username})}`
    expect(w.find('.agent-owner-avatar img').attributes('src')).toBe(expected)
    await send(w, '总结一下')
    await w.find('[aria-label="展开大视图"]').trigger('click'); await flushPromises()
    expect(w.find('.agent-thread-avatar img').attributes('src')).toBe(expected)
    expect(w.find('.agent-thread-avatar').attributes('aria-label')).toBe('测试会话的头像')
    await w.find('.agent-owner-avatar img').trigger('error')
    expect(w.find('.agent-owner-avatar img').exists()).toBe(false)
    expect(w.find('.agent-owner-avatar').text()).toBe('测')
    await w.setProps({account:'another & account'}); await flushPromises()
    expect(w.find('.agent-owner-avatar img').attributes('src')).toBe(`/api/chat/avatar?${new URLSearchParams({account:'another & account',username})}`)
    w.unmount()
  })

  it('点击推荐问题直接发送，提交期间重复点击不会重复请求', async () => {
    const original = request.getMockImplementation()
    let release
    request.mockImplementation(async (path, options) => {
      if (path.endsWith('/messages')) await new Promise(resolve => { release = resolve })
      return original(path, options)
    })
    const w = mountPanel(); await flushPromises()
    const suggestion = w.find('.agent-welcome > button')
    const question = suggestion.text()
    await suggestion.trigger('click'); await flushPromises()
    expect(suggestion.attributes('disabled')).toBeDefined()
    await suggestion.trigger('click'); await flushPromises()
    const sends = request.mock.calls.filter(([path]) => path.endsWith('/messages'))
    expect(sends).toHaveLength(1)
    expect(sends[0][1].body.text).toBe(question)
    release(); await flushPromises()
    expect(w.find('.agent-user').text()).toBe(question)
    expect(w.find('textarea').element.value).toBe('')
    expect(w.find('.agent-live-step .agent-shimmer').exists()).toBe(true)
    w.unmount()
  })
  it('推荐问题发送失败后保留问题供重试', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation((path, options) => {
      if (path.endsWith('/messages')) return Promise.reject(new Error('发送失败，请重试'))
      return original(path, options)
    })
    const w = mountPanel(); await flushPromises()
    const suggestion = w.find('.agent-welcome > button'), question = suggestion.text()
    await suggestion.trigger('click'); await flushPromises()
    expect(w.find('textarea').element.value).toBe(question)
    expect(w.find('[role="alert"]').text()).toBe('发送失败，请重试')
    expect(w.find('.agent-send').attributes('disabled')).toBeUndefined()
    w.unmount()
  })
  it('未发送时切换即保存，跨账号、新对话和重新挂载沿用最后模型', async () => {
    const original = request.getMockImplementation()
    let choice = { profile_id: 'model', model_id: 'fixture' }
    request.mockImplementation((path, options) => {
      if (path === '/settings') return Promise.resolve({ profiles: [{ id:'model', name:'服务一', model:'fixture' }, { id:'other', name:'服务二', model:'second' }], selected_model: choice })
      if (path === '/selected-model') { choice = options.body; return Promise.resolve(choice) }
      return original(path, options)
    })
    let w = mountPanel(); await flushPromises()
    expect(w.text()).not.toContain('使用全局默认模型')
    await w.find('[aria-label="切换模型"]').trigger('click')
    await w.findAll('.agent-selection-popover section')[1].find('button[aria-pressed]').trigger('click'); await flushPromises()
    expect(choice).toEqual({profile_id:'other',model_id:'second',reasoning_effort:null})
    expect(request.mock.calls.some(([path]) => path.endsWith('/messages'))).toBe(false)
    await w.setProps({account:'another',contact:{username:'third',name:'其他聊天'}}); await flushPromises()
    await w.find('[aria-label="新建 AI 对话"]').trigger('click'); await flushPromises()
    expect(w.find('.agent-model-menu summary').text()).toBe('second · 默认')
    w.unmount()
    state = ref({selected:{},drafts:{},pinned:{}})
    w = mountPanel(); await flushPromises()
    expect(w.find('.agent-model-menu summary').text()).toBe('second · 默认')
    await send(w, '你好')
    expect(request.mock.calls.find(([path]) => path.endsWith('/messages'))[1].body).toMatchObject(choice)
    w.unmount()
  })

  it('无服务时保留草稿并提示配置，不发送空模型请求', async () => {
    const original = request.getMockImplementation()
    request.mockImplementation((path, options) => path === '/settings' ? Promise.resolve({profiles:[],selected_model:{}}) : original(path, options))
    const w = mountPanel(); await flushPromises()
    await send(w, '保留这个问题')
    expect(w.find('textarea').element.value).toBe('保留这个问题')
    expect(w.text()).toContain('请先在输入框下方选择模型')
    expect(request.mock.calls.some(([path]) => path.endsWith('/messages'))).toBe(false)
    w.unmount()
  })

  it('新消息刷新联系人资料和 AI 流式回复时保持大视图、当前任务与草稿', async () => {
    const w = mountPanel()
    try {
      await flushPromises(); await send(w, '总结最近的消息')
      await w.find('[aria-label="展开大视图"]').trigger('click'); await flushPromises()
      await w.find('textarea').setValue('未发送的补充')
      const thread = w.vm.thread, run = w.vm.run, onEvent = eventCallbacks.acc
      request.mockClear()

      // 实时会话列表刷新会替换联系人对象，但当前聊天的 username 不变。
      for (let unreadCount = 1; unreadCount <= 2; unreadCount++) {
        await w.setProps({ contact: { username: 'first', name: '更新后的会话名', unreadCount, lastMessage: `新消息 ${unreadCount}` } })
        await flushPromises()
        expect(w.classes()).toContain('is-expanded')
        expect(w.find('.agent-owner').text()).toBe('更新后的会话名')
        expect(w.vm.thread).toBe(thread)
        expect(w.vm.run).toBe(run)
        expect(w.find('textarea').element.value).toBe('未发送的补充')
        expect(eventCallbacks.acc).toBe(onEvent)
      }
      expect(request).not.toHaveBeenCalled()

      onEvent({ thread_id: thread.id, run_id: run.id, status: 'running', patch: { stage: '正在读取新消息', read_count: 12 } })
      await flushPromises()
      expect(w.vm.run).toMatchObject({ stage: '正在读取新消息', read_count: 12 })
      expect(w.classes()).toContain('is-expanded')
      expect(w.find('textarea').element.value).toBe('未发送的补充')
      expect(w.emitted('expanded')).toEqual([[true]])
    } finally { w.unmount() }
  })

  it.each([
    ['联系人', { contact: { username: 'second', name: '会话二' } }],
    ['账号', { account: 'next' }],
  ])('真正切换%s时仍收起大视图并清除上一会话', async (_, props) => {
    const original = request.getMockImplementation()
    request.mockImplementation((path, options) => {
      // 新账号尚无 AI 对话，列表不能返回旧账号的数据。
      if (path === '/agent/threads' && options?.query?.account === 'next') return Promise.resolve([])
      return original(path, options)
    })
    const w = mountPanel()
    try {
      await flushPromises(); await send(w, '查询当前会话')
      await w.find('[aria-label="展开大视图"]').trigger('click'); await flushPromises()
      await w.setProps(props); await flushPromises()
      expect(w.classes()).not.toContain('is-expanded')
      expect(w.vm.thread).toBe(null)
      expect(w.vm.run).toBe(null)
    } finally { w.unmount() }
  })

  it('区分实时连接中断和快照同步超时，终态任务也会自动重试并清除提示', async () => {
    vi.useFakeTimers()
    threads.old={id:'old',username:'first',title:'已完成任务',scope:['first'],latest_run:'done',messages:[]}
    runs.done={id:'done',thread_id:'old',status:'completed',timeline:[],updated_at:1}
    const w = mountPanel()
    try {
      await flushPromises()
      eventDisconnected.acc(); await flushPromises()
      expect(w.text()).toContain('实时进度连接已中断')
      eventReady.acc(); await flushPromises()
      expect(w.text()).not.toContain('实时进度连接已中断')

      const original = request.getMockImplementation()
      let failed = false
      request.mockImplementation((path, options) => {
        if (!failed && path === '/agent/threads/old') { failed = true; return Promise.reject(new Error('timeout')) }
        return original(path, options)
      })
      eventReady.acc(); await flushPromises()
      expect(w.text()).toContain('状态同步较慢')
      expect(w.text()).not.toContain('进度连接暂时中断')
      await vi.advanceTimersByTimeAsync(800); await flushPromises()
      expect(w.text()).not.toContain('状态同步较慢')
      expect(request.mock.calls.filter(([path]) => path === '/agent/threads/old').length).toBeGreaterThanOrEqual(3)
    } finally { w.unmount(); vi.useRealTimers() }
  })

  it('重连但没有新事件时恢复已完成任务并保留未发送草稿', async () => {
    const w = mountPanel()
    try {
      await flushPromises(); await send(w, '检查报告')
      const id = w.vm.run.id
      await w.find('textarea').setValue('未发送的补充')
      runs[id] = {...runs[id],status:'completed',answer:'连接期间完成的报告',updated_at:Date.now()/1000 + 1}
      eventReady.acc(); await flushPromises()
      expect(w.vm.run.status).toBe('completed')
      expect(w.text()).toContain('连接期间完成的报告')
      expect(w.find('textarea').element.value).toBe('未发送的补充')
      expect(request.mock.calls.filter(([path, options]) => path.endsWith('/messages') && options.method === 'POST')).toHaveLength(1)
    } finally { w.unmount() }
  })
  it('流式正文和引用同时显示，较旧快照不丢失已显示的人物和出处', async () => {
    vi.useFakeTimers()
    const w = mountPanel()
    try {
      await flushPromises(); await send(w, '查约球')
      const id = w.vm.run.id, source = 'a'.repeat(24), person = 'b'.repeat(24)
      await w.find('textarea').setValue('未发送的补充')
      const event = {run_id:id, timeline_item:{id:`answer:${id}`,seq:1,revision:2,kind:'answer',status:'running',
        text:`[[person:${person}]]负责约球 [[${source}]]`},
        citations:[{source,username:'first',sender:'甲',sender_avatar_path:'/chat/avatar?username=a',time:100,text:'甲说乙负责约球'}],
        references:[{id:person,kind:'person',username:'b',name:'乙',sources:[source],mentioned_sources:[source]}]}
      eventCallbacks.acc(event); await flushPromises()
      expect(w.find('[data-person]').text()).toBe('乙')
      expect(w.find('[data-source]').attributes('data-source')).toBe(source)
      expect(w.find('.agent-ref-unresolved').exists()).toBe(false)
      // 模拟延迟快照仍未包含新正文；合并后沿用较新事件和配套身份。
      await vi.advanceTimersByTimeAsync(200); await flushPromises()
      expect(w.find('[data-person]').text()).toBe('乙')
      expect(w.find('[data-source]').exists()).toBe(true)
      expect(w.find('textarea').element.value).toBe('未发送的补充')
      eventCallbacks.acc({...event,timeline_item:{...event.timeline_item,revision:1,text:'旧回答'},references:[{...event.references[0],name:'错误旧姓名'}]})
      await flushPromises()
      expect(w.find('[data-person]').text()).toBe('乙')
    } finally { w.unmount(); vi.useRealTimers() }
  })

  it('SSE 正常时只合并事件不轮询快照，断线后才启用保底同步', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']})
    threads.live={id:'live',username:'first',title:'实时任务',scope:['first'],latest_run:'r',messages:[{id:'q',role:'user',text:'问题',run_id:'r'}]}
    runs.r={id:'r',thread_id:'live',version:1,status:'running',stage:'准备中',segment_started:Date.now()/1000,stage_started_at:Date.now()/1000,timeline:[],updated_at:1}
    const w = mountPanel()
    try {
      await flushPromises()
      eventReady.acc({reconnected:false})
      request.mockClear()
      eventCallbacks.acc({run_id:'r',thread_id:'live',version:1,updated_at:2,status:'running',patch:{stage:'正在读取',read_count:12}})
      await vi.advanceTimersByTimeAsync(1000); await flushPromises()
      expect(w.find('.agent-live-step time').text()).toBe('1秒')
      await vi.advanceTimersByTimeAsync(4500); await flushPromises()
      expect(w.vm.run).toMatchObject({stage:'正在读取',read_count:12})
      expect(request.mock.calls.filter(([path]) => path === '/agent/threads/live' || path === '/agent/runs/r')).toHaveLength(0)

      eventDisconnected.acc(); request.mockClear()
      await vi.advanceTimersByTimeAsync(1600); await flushPromises()
      expect(request.mock.calls.some(([path]) => path === '/agent/threads/live')).toBe(true)
      expect(request.mock.calls.some(([path]) => path === '/agent/runs/r')).toBe(true)
    } finally { w.unmount(); vi.useRealTimers() }
  })

  it('历史过程加载失败时仍能复制回答，并可重试加载过程', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('暂时不可用')).mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    threads.old={id:'old',username:'first',title:'旧报告',scope:['first'],latest_run:'',messages:[
      {id:'q',role:'user',text:'请总结',run_id:'past'},
      {id:'a',role:'assistant',text:'已确认的结论。',run_id:'past',citations:[],references:[]},
    ]}
    const w=mountPanel();await flushPromises()
    await w.find('[aria-label="AI 对话历史"]').trigger('click');await flushPromises()
    await w.find('.agent-thread-select').trigger('click');await flushPromises()
    await w.find('[aria-label="复制回答"]').trigger('click');await flushPromises()
    expect(w.text()).toContain('复制失败，请重试')
    await w.find('[aria-label="复制回答"]').trigger('click');await flushPromises()
    expect(writeText).toHaveBeenLastCalledWith('已确认的结论。')
    expect(w.find('[aria-label="已复制回答"]').exists()).toBe(true)
    expect(w.text()).not.toContain('复制失败，请重试')
    expect(request.mock.calls.filter(([path])=>path==='/agent/runs/past')).toHaveLength(1)
    expect(w.text()).toContain('处理过程加载失败，点击重试')
    runs.past={id:'past',thread_id:'old',status:'completed',answer:'已确认的结论。',timeline:[{id:'p',kind:'progress',text:'已核对历史消息',seq:1}]}
    await w.find('.agent-process-toggle').trigger('click');await flushPromises()
    expect(w.find('.agent-process').isVisible()).toBe(true)
    expect(w.text()).toContain('已核对历史消息')
    expect(w.text()).not.toContain('处理过程加载失败')
    w.unmount()
  })
  it('打开多轮对话自动展开历史过程，下一轮开始后保留上一轮过程', async () => {
    runs.past={id:'past',thread_id:'old',status:'completed',answer:'历史结论',timeline:[{id:'p',kind:'progress',text:'已核对历史消息',seq:1}]}
    runs.latest={id:'latest',thread_id:'old',status:'completed',answer:'当前结论',timeline:[]}
    threads.old={id:'old',username:'first',title:'多轮对话',scope:['first'],latest_run:'latest',messages:[
      {id:'q1',role:'user',text:'第一问',run_id:'past'},
      {id:'q2',role:'user',text:'第二问',run_id:'latest'},
    ]}
    const w=mountPanel()
    try {
      await flushPromises()
      expect(w.findAll('.agent-run')).toHaveLength(2)
      expect(w.findAll('.agent-process').every(item=>item.isVisible())).toBe(true)
      expect(w.text()).not.toContain('查看这轮处理过程')
      expect(request.mock.calls.filter(([path])=>path==='/agent/runs/past')).toHaveLength(1)
      runs.next={id:'next',thread_id:'old',status:'running',timeline:[]}
      threads.old={...threads.old,latest_run:'next',messages:[...threads.old.messages,{id:'q3',role:'user',text:'第三问',run_id:'next'}]}
      eventCallbacks.acc({thread_id:'old',run_id:'next',status:'running'})
      await flushPromises()
      expect(w.findAll('.agent-run')).toHaveLength(3)
      expect(w.text()).toContain('当前结论')
      expect(w.findAll('.agent-process')[1].isVisible()).toBe(true)
    } finally { w.unmount() }
  })
  it('切换会话后保留后台转圈，事件结束只更新对应任务，旧任务不覆盖新任务', async () => {
    threads.a={id:'a',title:'会话 A',username:'first',scope:['first'],messages:[],latest_run:'ra'}
    threads.b={id:'b',title:'会话 B',username:'first',scope:['first'],messages:[],latest_run:'rb'}
    runs.ra={id:'ra',thread_id:'a',status:'running',timeline:[]}
    runs.rb={id:'rb',thread_id:'b',status:'queued',timeline:[]}
    const w=mountPanel();await flushPromises()
    await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    const a=w.findAll('.agent-thread-item')[0],b=w.findAll('.agent-thread-item')[1]
    expect(a.find('.agent-thread-running').exists()).toBe(true)
    expect(b.find('.agent-thread-running').exists()).toBe(true)
    const spinner=a.find('.agent-thread-running').element
    await b.find('.agent-thread-select').trigger('click');await flushPromises()
    expect(a.find('.agent-thread-running').element).toBe(spinner)
    expect(w.find('.agent-thread-title').text()).toBe('会话 B')
    eventCallbacks.acc({run_id:'ra',status:'completed'});await flushPromises()
    expect(a.find('.agent-thread-running').exists()).toBe(false)
    expect(b.find('.agent-thread-running').exists()).toBe(true)
    runs.ra2={id:'ra2',thread_id:'a',status:'running',timeline:[]};threads.a.latest_run='ra2'
    await w.find('[aria-label="刷新会话列表"]').trigger('click');await flushPromises()
    eventCallbacks.acc({run_id:'ra',status:'failed'});await flushPromises()
    expect(a.find('.agent-thread-running').exists()).toBe(true)
    const original=request.getMockImplementation();let resolveList
    request.mockImplementation((path,options)=>path==='/agent/threads'&&options.method!=='POST'?new Promise(resolve=>{resolveList=resolve}):original(path,options))
    await w.find('[aria-label="刷新会话列表"]').trigger('click')
    eventCallbacks.acc({run_id:'ra2',status:'completed'});await flushPromises()
    resolveList([{...threads.a,latest_run_status:'running'},{...threads.b,latest_run_status:'queued'}]);await flushPromises()
    expect(a.find('.agent-thread-running').exists()).toBe(false)
    w.unmount()
  })
  it('未收到事件时静默轮询后台完成状态，失败不清除正在运行的指示', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']})
    const original=request.getMockImplementation()
    let w
    try {
      threads.a={id:'a',title:'后台任务',username:'first',scope:['first'],messages:[],latest_run:'ra'}
      threads.b={id:'b',title:'浏览其他会话',username:'first',scope:['first'],messages:[]}
      runs.ra={id:'ra',thread_id:'a',status:'running',timeline:[]}
      w=mountPanel();await flushPromises()
      await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
      await w.findAll('.agent-thread-select')[1].trigger('click');await flushPromises()
      request.mockImplementation((path,options)=>path==='/agent/threads'&&options.method!=='POST'?Promise.reject(new Error('暂时离线')):original(path,options))
      await vi.advanceTimersByTimeAsync(6000);await flushPromises()
      expect(w.find('.agent-thread-running').exists()).toBe(true)
      expect(w.find('.agent-thread-error').exists()).toBe(false)
      request.mockImplementation(async (path,options)=>{const result=await original(path,options);return path==='/agent/threads'&&options.method!=='POST'?result.reverse():result});runs.ra.status='completed'
      await vi.advanceTimersByTimeAsync(6000);await flushPromises()
      expect(w.find('.agent-thread-running').exists()).toBe(false)
      expect(w.find('.agent-thread-title').text()).toBe('浏览其他会话')
      expect(w.findAll('.agent-thread-select').map(item=>item.find('span').text())).toEqual(['后台任务','浏览其他会话'])
    } finally { w?.unmount();vi.useRealTimers() }
  })
  it('展开即展示会话列表，可搜索、切换当前联系人的 AI 对话，并保留各自草稿', async () => {
    threads.a={id:'a',title:'报价确认',username:'first',scope:['first'],messages:[]}
    threads.b={id:'b',title:'南京出行',username:'first',scope:['first'],messages:[]}
    const w=mountPanel();await flushPromises()
    await w.find('textarea').setValue('报价草稿')
    await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    expect(w.find('nav[aria-label="AI 会话列表"]').exists()).toBe(true)
    expect(w.findAll('.agent-thread-item')).toHaveLength(2)
    await w.find('[aria-label="搜索 AI 会话"]').setValue('南京')
    expect(w.findAll('.agent-thread-item')).toHaveLength(1)
    await w.find('.agent-thread-select').trigger('click');await flushPromises()
    expect(w.find('.agent-thread-title').text()).toBe('南京出行')
    expect(w.find('.agent-scope').exists()).toBe(false)
    expect(w.find('textarea').element.value).toBe('')
    await w.find('textarea').setValue('出行草稿')
    await w.find('[aria-label="搜索 AI 会话"]').setValue('')
    await w.findAll('.agent-thread-select')[0].trigger('click');await flushPromises()
    expect(w.find('textarea').element.value).toBe('报价草稿')
    expect(w.find('.agent-thread-select[aria-current="page"]').text()).toContain('报价确认')
    await w.find('[aria-label="收起大视图"]').trigger('click')
    expect(w.find('.agent-thread-list').exists()).toBe(false)
    await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    expect(w.find('.agent-thread-list').exists()).toBe(true)
    w.unmount()
  })
  it('新对话发送后进入左侧列表，重命名同步标题，删除当前对话回到空态', async () => {
    const w=mountPanel();await flushPromises()
    await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    expect(w.find('.agent-thread-empty').text()).toContain('还没有对话')
    await w.find('.agent-thread-new').trigger('click');await send(w,'查找旅行费用')
    expect(w.find('.agent-thread-select').text()).toContain('查找旅行费用')
    await w.find('.agent-thread-more').trigger('click')
    await w.findAll('.agent-thread-management button')[0].trigger('click')
    await w.find('[aria-label="对话新名称"]').setValue('旅行预算')
    await w.find('.agent-thread-management form').trigger('submit');await flushPromises()
    expect(w.find('.agent-thread-title').text()).toBe('旅行预算')
    expect(w.find('.agent-thread-select').text()).toContain('旅行预算')
    await w.find('.agent-thread-more').trigger('click')
    await w.findAll('.agent-thread-management button')[1].trigger('click')
    expect(request.mock.calls.some(([,o])=>o?.method==='DELETE')).toBe(false)
    await w.findAll('.agent-thread-management button')[0].trigger('click');await flushPromises()
    expect(w.find('.agent-thread-item').exists()).toBe(false)
    expect(w.find('.agent-welcome').exists()).toBe(true)
    expect(w.find('.agent-thread-title').text()).toBe('新对话')
    w.unmount()
  })
  it('会话列表请求失败可重试，旧账号迟到的列表不会污染新账号', async () => {
    const original=request.getMockImplementation();let resolveOld, fail=true
    request.mockImplementation((path,options)=>{
      if(path==='/agent/threads' && options.method!=='POST'){
        if(fail)return Promise.reject(new Error('连接中断'))
        if(options.query.account==='acc')return new Promise(resolve=>{resolveOld=resolve})
        return Promise.resolve([{id:'new',title:'新账号会话',username:'first'}])
      }
      return original(path,options)
    })
    const w=mountPanel();await flushPromises();await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    expect(w.find('.agent-thread-error').text()).toContain('连接中断')
    fail=false;await w.find('[aria-label="刷新会话列表"]').trigger('click')
    await w.setProps({account:'next'});await flushPromises()
    resolveOld([{id:'old',title:'旧账号会话',username:'first'}]);await flushPromises()
    await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    expect(w.find('.agent-thread-list').text()).toContain('新账号会话')
    expect(w.find('.agent-thread-list').text()).not.toContain('旧账号会话')
    w.unmount()
  })
  it('快速切换时采用最后一次选择，失败不修改当前联系人的选择记录', async () => {
    threads.a={id:'a',title:'会话 A',username:'first',scope:['first'],messages:[]}
    threads.b={id:'b',title:'会话 B',username:'first',scope:['first'],messages:[]}
    const w=mountPanel();await flushPromises();await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    const original=request.getMockImplementation();let resolveB
    request.mockImplementation((path,options)=>path==='/agent/threads/b'?new Promise(resolve=>{resolveB=resolve}):original(path,options))
    await w.findAll('.agent-thread-select')[1].trigger('click')
    expect(w.find('.agent-loading').exists()).toBe(true)
    await w.findAll('.agent-thread-select')[0].trigger('click');await flushPromises()
    resolveB(threads.b);await flushPromises()
    expect(w.find('.agent-thread-title').text()).toBe('会话 A')
    expect(state.value.selected['acc:first']).toBe('a')
    request.mockImplementation((path,options)=>path==='/agent/threads/b'?Promise.reject(new Error('会话不可用')):original(path,options))
    await w.findAll('.agent-thread-select')[1].trigger('click');await flushPromises()
    expect(w.find('.agent-error').text()).toContain('会话不可用')
    expect(state.value.selected['acc:first']).toBe('a')
    w.unmount()
  })
  it('停止后可继续，切换到历史再回来能恢复进行中的任务', async () => {
    const w=mountPanel();await flushPromises();await send(w,'找报价')
    const id=w.vm.thread.id
    await w.find('[aria-label="停止处理"]').trigger('click');await flushPromises()
    expect(w.find('[aria-label="停止处理"]').exists()).toBe(false)
    const resume=w.findAll('.agent-result-actions button').find(x=>x.text().includes('继续查找'))
    await resume.trigger('click');await flushPromises()
    expect(w.find('[aria-label="停止处理"]').exists()).toBe(true)
    await w.find('[aria-label="新建 AI 对话"]').trigger('click');await flushPromises()
    await w.find('[aria-label="AI 对话历史"]').trigger('click');await flushPromises()
    await w.find('.agent-thread-select').trigger('click');await flushPromises()
    expect(w.vm.thread.id).toBe(id)
    expect(w.find('[aria-label="停止处理"]').exists()).toBe(true)
    w.unmount()
  })
  it('重命名或删除失败时保留原会话和草稿，错误出现在列表内', async () => {
    threads.a={id:'a',title:'原会话',username:'first',scope:['first'],messages:[]}
    const w=mountPanel();await flushPromises();await w.find('[aria-label="展开大视图"]').trigger('click');await flushPromises()
    await w.find('textarea').setValue('尚未发送')
    const original=request.getMockImplementation()
    request.mockImplementation((path,options)=>['PATCH','DELETE'].includes(options?.method)?Promise.reject(new Error('服务暂时不可用')):original(path,options))
    await w.vm.renameHistory(threads.a,'新名称');await flushPromises()
    expect(w.find('.agent-thread-error').text()).toContain('服务暂时不可用')
    expect(w.find('.agent-thread-title').text()).toBe('原会话')
    await w.vm.deleteHistory(threads.a);await flushPromises()
    expect(w.find('.agent-thread-select').text()).toContain('原会话')
    expect(w.find('textarea').element.value).toBe('尚未发送')
    w.unmount()
  })
  it('中文输入法确认不会误提交，普通 Enter 提交一次', async () => {
    const w=mountPanel();await flushPromises()
    const input=w.find('textarea');await input.setValue('确认出行日期')
    await input.trigger('compositionstart');await input.trigger('keydown',{key:'Enter',isComposing:true});await flushPromises()
    expect(request.mock.calls.some(([path])=>path.endsWith('/messages'))).toBe(false)
    await input.trigger('compositionend');await input.trigger('keydown',{key:'Enter'});await flushPromises()
    expect(request.mock.calls.filter(([path])=>path.endsWith('/messages'))).toHaveLength(1)
    w.unmount()
  })
  it('模型菜单等待配置返回并显示按服务分组的模型', async () => {
    let resolveSettings
    const original=request.getMockImplementation()
    request.mockImplementation((path,options)=>path==='/settings'?new Promise(resolve=>{resolveSettings=resolve}):original(path,options))
    const w=mountPanel();await flushPromises()
    w.find('.agent-model-menu').element.open=true
    expect(w.find('.agent-selection-popover').attributes('aria-busy')).toBe('true')
    resolveSettings({profiles:[{id:'one',name:'服务一',model:'model-a'},{id:'two',name:'服务二',model:'model-b'}]});await flushPromises()
    expect(w.findAll('.agent-selection-popover section').map(s=>s.text())).toEqual(['服务一获取模型model-a','服务二获取模型model-b'])
    expect(w.find('.agent-model-menu').element.open).toBe(true)
    w.unmount()
  })
  it('首次配置加载失败可在模型菜单重试，草稿不受影响', async () => {
    const original=request.getMockImplementation();let attempts=0
    request.mockImplementation((path,options)=>path==='/settings'?(++attempts===1?Promise.reject(Error('离线')):Promise.resolve({profiles:[{id:'ready',name:'恢复服务',model:'ready'}]})):original(path,options))
    const w=mountPanel();await flushPromises();await w.find('textarea').setValue('草稿')
    expect(w.find('.agent-selection-popover').text()).toContain('模型列表加载失败')
    await w.find('.agent-selection-popover [role="alert"] button').trigger('click');await flushPromises()
    expect(w.find('.agent-selection-popover').text()).toContain('恢复服务')
    expect(w.find('.agent-selection-popover [role="alert"]').exists()).toBe(false)
    expect(w.find('textarea').element.value).toBe('草稿')
    w.unmount()
  })
  it('关闭服务设置后刷新模型，不必关闭并重开助手', async () => {
    const settingsOpen=ref(false)
    vi.stubGlobal('useSettingsDialog',()=>({open:settingsOpen,openDialog:vi.fn()}))
    const original=request.getMockImplementation()
    let profiles=[]
    request.mockImplementation((path,options)=>path==='/settings'?Promise.resolve({profiles}):original(path,options))
    const wrapper=mountPanel();await flushPromises()
    settingsOpen.value=true;await flushPromises()
    profiles=[{id:'new',name:'刚添加的模型'}]
    settingsOpen.value=false;await flushPromises()
    expect(wrapper.find('.agent-selection-popover').text()).toContain('刚添加的模型')
    wrapper.unmount()
  })
  it('从更多菜单切换工具再返回时保留草稿和模型菜单', async () => {
    const wrapper = mountPanel(); await flushPromises()
    await wrapper.find('textarea').setValue('保留这份草稿')
    await wrapper.find('[aria-label="更多 AI 功能"]').trigger('click')
    await wrapper.findAll('.agent-menu button').find(button => button.text() === '工具与任务').trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(false)
    await wrapper.find('.agent-tools-heading button').trigger('click')
    expect(wrapper.find('textarea').element.value).toBe('保留这份草稿')
    expect(wrapper.find('.agent-model-menu').exists()).toBe(true)
    wrapper.unmount()
  })
  it('宽视图点击引用显示原文栏，缩窄后关闭原文栏并恢复浮层', async () => {
    const callbacks=[]
    const original=globalThis.ResizeObserver
    vi.stubGlobal('ResizeObserver',class { constructor(callback){ this.callback=callback } observe(element){ if(element.classList.contains('agent-panel')) callbacks.push(this.callback) } disconnect(){} })
    const source={source:'a'.repeat(24),username:'first',anchor:'m1',name:'会话一',sender:'甲',time:100,text:'引用原文'}
    threads.t={id:'t',username:'first',scope:['first'],latest_run:'r',messages:[{id:'q',role:'user',text:'问题',run_id:'r'}]}
    runs.r={id:'r',status:'completed',answer:`答案 [[${source.source}]]`,citations:[source]}
    const wrapper=mountPanel();await flushPromises()
    await wrapper.find('[aria-label="展开大视图"]').trigger('click')
    callbacks[0]([{contentRect:{width:1060}}])
    await wrapper.find('.agent-ref').trigger('click');await flushPromises()
    expect(wrapper.find('.agent-source-inspector').text()).toContain('引用原文')
    expect(wrapper.find('.agent-citation-preview').exists()).toBe(false)
    callbacks[0]([{contentRect:{width:700}}]);await flushPromises()
    expect(wrapper.find('.agent-source-inspector').exists()).toBe(false)
    expect(wrapper.find('.agent-ref').attributes('aria-expanded')).toBe('false')
    wrapper.find('.agent-ref').element.getBoundingClientRect=()=>({top:100,bottom:120,left:100,right:120})
    wrapper.find('.agent-conversation').element.getBoundingClientRect=()=>({top:80,bottom:600,left:0,right:700})
    await wrapper.find('.agent-ref').trigger('click');await flushPromises()
    expect(wrapper.find('.agent-citation-preview').exists()).toBe(true)
    wrapper.unmount();vi.stubGlobal('ResizeObserver',original)
  })
  it('首次提交超时仍保留草稿，重试使用相同幂等 ID', async () => {
    const original = request.getMockImplementation()
    let fail = true
    request.mockImplementation(async (path, options) => { if (path.endsWith('/messages') && fail) throw new Error('暂时断线'); return original(path, options) })
    const wrapper = mountPanel(); await flushPromises()
    await send(wrapper,'找一下报价')
    expect(wrapper.find('textarea').element.value).toBe('找一下报价')
    fail = false
    await wrapper.find('[aria-label="发送问题"]').trigger('click'); await flushPromises()
    const posts = request.mock.calls.filter(([p]) => p.endsWith('/messages'))
    expect(posts[0][1].body.request_id).toBe(posts[1][1].body.request_id)
    wrapper.unmount()
  })
  it('对话归属当前联系人，运行中 Enter 补充沿用同一任务', async () => {
    const wrapper = mountPanel(); await flushPromises()
    expect(wrapper.text()).toContain('想从聊天里了解什么')
    await send(wrapper,'找一下报价')
    expect(request.mock.calls.find(([p,o])=>p==='/agent/threads'&&o.method==='POST')[1].body).toEqual({account:'acc',username:'first'})
    expect(wrapper.text()).toContain('思考中')
    await send(wrapper,'只看上周')
    const posts = request.mock.calls.filter(([p])=>p.endsWith('/messages'))
    expect(posts).toHaveLength(2)
    expect(posts[0][0]).toBe(posts[1][0])
    expect(wrapper.text()).toContain('已收到补充要求')
    wrapper.unmount()
  })
  it('切换联系人分别恢复对话和草稿，后台结果不串入新窗口', async () => {
    const w=mountPanel();await flushPromises();await send(w,'找报价')
    const first=w.vm.thread.id
    await w.find('textarea').setValue('甲的草稿')
    await w.setProps({contact:{username:'second',name:'会话二'}});await flushPromises()
    expect(w.vm.thread).toBe(null)
    expect(w.find('textarea').element.value).toBe('')
    await w.find('textarea').setValue('乙的新对话草稿')
    await w.setProps({contact:{username:'first',name:'会话一'}});await flushPromises()
    expect(w.vm.thread.id).toBe(first)
    expect(w.find('textarea').element.value).toBe('甲的草稿')
    await w.setProps({contact:{username:'second',name:'会话二'}});await flushPromises()
    expect(w.find('textarea').element.value).toBe('乙的新对话草稿')
    await send(w,'查询乙的消息')
    const second=w.vm.thread.id
    expect(second).not.toBe(first)
    eventCallbacks.acc({thread_id:first,run_id:threads[first].latest_run,status:'completed'})
    await flushPromises()
    expect(w.vm.thread.id).toBe(second)
    expect(threads[second].username).toBe('second')
    w.unmount()
  })

  it('草稿在关闭、重开及展开大视图后保留', async () => {
    let wrapper = mountPanel(); await flushPromises()
    await wrapper.find('textarea').setValue('尚未发送的草稿')
    await wrapper.find('[aria-label="展开大视图"]').trigger('click')
    expect(wrapper.classes()).toContain('is-expanded')
    expect(wrapper.find('textarea').element.value).toBe('尚未发送的草稿')
    wrapper.unmount(); wrapper = mountPanel(); await flushPromises()
    expect(wrapper.find('textarea').element.value).toBe('尚未发送的草稿')
    wrapper.unmount()
  })
  it('明确筛选通过问题提交，不修改账号读取权限', async () => {
    const w=mountPanel();await flushPromises();await send(w,'只查会话二上周的报价')
    expect(request.mock.calls.find(([p])=>p.endsWith('/messages'))[1].body.text).toBe('只查会话二上周的报价')
    expect(request.mock.calls.some(([,o])=>o?.method==='PATCH')).toBe(false)
    expect(w.find('.agent-scope').exists()).toBe(false)
    w.unmount()
  })
  it('回答引用可预览定位，外部图片和原始 HTML 不执行', async () => {
    const source = 'a'.repeat(24)
    const wrapper = mount(AgentAnswer,{attachTo:document.body,props:{text:`**报价** [[${source}]]\n<img src=x onerror=alert(1)>\n![bad](https://example.com/tracker)`,citations:[{source,username:'first',name:'会话一',sender:'甲',time:100,text:'报价100元'}]}})
    wrapper.find('.agent-ref').element.getBoundingClientRect = () => ({ top:100, bottom:124, left:100, right:124 })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('strong').text()).toBe('报价')
    await wrapper.find('.agent-ref').trigger('click')
    expect(wrapper.find('.agent-citation-preview').text()).toContain('报价100元')
    await wrapper.find('.agent-citation-preview > button').trigger('click')
    expect(wrapper.emitted('locate')[0][0].source).toBe(source)
    wrapper.unmount()
  })
})
