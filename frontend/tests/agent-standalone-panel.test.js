import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatAgentPanel from '../components/chat/ChatAgentPanel.vue'

let state, request, threads, runs, callbacks, sequence
beforeEach(() => {
  state = ref({ selected: {}, drafts: {}, pinned: {} }); threads = {}; runs = {}; callbacks = {}; sequence = 0
  request = vi.fn(async (path, options = {}) => {
    if (path === '/settings') return { profiles: [{ id: 'local', name: '本地服务', model: 'local-model' }], selected_model: { profile_id: 'local', model_id: 'local-model' } }
    if (path.includes('/model-capabilities')) return { metadata: {} }
    if (path === '/conversations') return [{ username: 'wxid_1', name: '项目一' }, { username: 'room@chatroom', name: '项目群' }]
    if (path === '/agent/threads') {
      if (options.method === 'POST') { const id = `t${++sequence}`; return threads[id] = { id, ...options.body, title: '新的对话', messages: [], latest_run: '' } }
      return Object.values(threads).filter(t => t.account === options.query.account && (options.query.origin ? t.origin === options.query.origin : t.username === options.query.username))
    }
    const [, , kind, id, action] = path.split('/')
    if (kind === 'threads') {
      if (options.method === 'DELETE') { delete threads[id]; return { status: 'success' } }
      if (options.method === 'PATCH') threads[id] = { ...threads[id], ...options.body }
      if (action === 'messages') {
        const rid = `r${++sequence}`
        runs[rid] = { id: rid, thread_id: id, account: threads[id].account, status: 'running', stage: '搜索相关消息', timeline: [], citations: [], answer: '' }
        threads[id] = { ...threads[id], title: options.body.text, latest_run: rid, messages: [...threads[id].messages, { id: options.body.request_id, role: 'user', text: options.body.text, run_id: rid }] }
        return { ...runs[rid] }
      }
      return { ...threads[id] }
    }
    if (kind === 'runs') { if (action === 'stop') runs[id] = { ...runs[id], status: 'cancelled' }; return { ...runs[id] } }
    throw new Error(`Unexpected fixture request: ${path}`)
  })
  vi.stubGlobal('useState', () => state)
  vi.stubGlobal('useSettingsDialog', () => ({ openDialog: vi.fn() }))
  vi.stubGlobal('useAiApi', () => ({ request, agentEvents: (account, callback) => { callbacks[account] = callback; return () => {} } }))
})
const page = (props = {}) => mount(ChatAgentPanel, { attachTo: document.body, props: { account: 'a', presentation: 'page', ...props }, global: { stubs: { AiSidebar: true } } })
const send = async (w, text) => { await w.find('textarea').setValue(text); await w.find('textarea').trigger('keydown', { key: 'Enter' }); await flushPromises() }
const scope = async (w, username) => {
  await w.find('[aria-label="选择聊天范围"]').trigger('click'); await flushPromises()
  await w.find('input[aria-label="所有聊天"]').setValue(false)
  await w.find(`input[value="${username}"]`).setValue(true)
  await w.find('[aria-label="应用聊天范围"]').trigger('click'); await flushPromises()
}
describe('独立 Agent 页面共享组件', () => {
  it('无需当前联系人，首问以独立来源及全聊天范围创建，复用已选模型', async () => {
    const w = page()
    try {
      await flushPromises()
      expect(w.classes()).toContain('is-page')
      expect(w.text()).toContain('你的本地聊天记忆，随时可查')
      for (const selector of ['.agent-resizer', '[aria-label="展开大视图"]', '[aria-label="关闭 AI 助手"]']) expect(w.find(selector).exists()).toBe(false)
      await send(w, '项目有哪些待办？')
      expect(request.mock.calls.find(([p, o]) => p === '/agent/threads' && o.method === 'POST')[1].body).toEqual({ account: 'a', username: '', origin: 'agent', chat_scope: null })
      expect(request.mock.calls.find(([p]) => p.endsWith('/messages'))[1].body).toMatchObject({ profile_id: 'local', model_id: 'local-model', text: '项目有哪些待办？' })
      expect(w.find('.agent-page-welcome').exists()).toBe(false)
      expect(w.find('.agent-user').text()).toBe('项目有哪些待办？')
    } finally { w.unmount() }
  })
  it('运行时解释范围锁定，停止后改变真实 ID 新开对话保留草稿，历史恢复原范围', async () => {
    const w = page()
    try {
      await flushPromises(); await send(w, '第一问'); const oldId = w.vm.thread.id
      await w.find('textarea').setValue('未发送的补充')
      expect(w.find('[aria-label="选择聊天范围"]').attributes('disabled')).toBeDefined()
      expect(w.text()).toContain('停止处理后可更改聊天范围')
      await w.find('.agent-send').trigger('click'); await flushPromises(); await scope(w, 'room@chatroom')
      expect(w.vm.thread).toBeNull(); expect(w.find('textarea').element.value).toBe('未发送的补充')
      expect(threads[oldId].chat_scope).toBeNull()
      expect(request.mock.calls.filter(([p, o]) => p === '/agent/threads' && o.method === 'POST')).toHaveLength(1)
      await send(w, '只看项目群'); expect(w.vm.thread.chat_scope).toEqual(['room@chatroom'])
      await w.find('[aria-label="AI 对话历史"]').trigger('click'); await flushPromises()
      expect(request.mock.calls.filter(([p, o]) => p === '/agent/threads' && !o.method).every(([, o]) => o.query.origin === 'agent' && !o.query.username)).toBe(true)
      await w.findAll('.agent-thread-select').find(row => row.text().includes('第一问')).trigger('click'); await flushPromises()
      expect(w.vm.thread.id).toBe(oldId); expect(w.find('[aria-label="选择聊天范围"]').text()).toContain('所有聊天')
      expect(w.find('textarea').element.value).toBe('未发送的补充')
    } finally { w.unmount() }
  })
  it('新对话恢复全聊天并清空新草稿，按账号及入口保存草稿', async () => {
    const w = page()
    try {
      await flushPromises(); await scope(w, 'wxid_1'); await send(w, '账号 A 的问题'); await w.find('textarea').setValue('A 草稿')
      await w.find('[aria-label="新建 AI 对话"]').trigger('click'); await flushPromises()
      expect(w.find('textarea').element.value).toBe(''); expect(w.find('[aria-label="选择聊天范围"]').text()).toContain('所有聊天')
      await w.find('textarea').setValue('A 的新草稿'); await w.setProps({ account: 'b' }); await flushPromises()
      expect(w.find('textarea').element.value).toBe(''); await w.find('textarea').setValue('B 草稿')
      await w.setProps({ account: 'a' }); await flushPromises(); expect(w.find('textarea').element.value).toBe('A 的新草稿')
      await w.setProps({ presentation: 'panel', contact: { username: 'wxid_1', name: '项目一' } }); await flushPromises(); expect(w.find('textarea').element.value).toBe('')
      await w.setProps({ presentation: 'page' }); await flushPromises(); expect(w.find('textarea').element.value).toBe('A 的新草稿')
    } finally { w.unmount() }
  })
  it('旧账号迟到创建不能覆盖当前账号；发送错误保留草稿并展示原因', async () => {
    const original = request.getMockImplementation(); let release
    request.mockImplementation(async (p, o) => { if (p === '/agent/threads' && o.method === 'POST') await new Promise(resolve => { release = resolve }); return original(p, o) })
    const w = page()
    try {
      await flushPromises(); await send(w, 'A 未完成创建'); await w.setProps({ account: 'b' }); await flushPromises(); release(); await flushPromises()
      expect(w.vm.thread).toBeNull(); expect(request.mock.calls.some(([p]) => p.endsWith('/messages'))).toBe(false)
      request.mockImplementation((p, o) => p.endsWith('/messages') ? Promise.reject(new Error('服务无法连接')) : original(p, o))
      await send(w, 'B 保留的问题'); expect(w.find('[role="alert"]').text()).toBe('服务无法连接'); expect(w.find('textarea').element.value).toBe('B 保留的问题')
    } finally { w.unmount() }
  })
  it('范围读取失败展示错误且可重试，中文输入法回车不提交', async () => {
    const original = request.getMockImplementation(); let fail = true
    request.mockImplementation((p, o) => p === '/conversations' && fail ? Promise.reject(new Error('聊天列表读失败')) : original(p, o))
    const w = page()
    try {
      await flushPromises(); await w.find('[aria-label="选择聊天范围"]').trigger('click'); await flushPromises(); expect(w.text()).toContain('聊天列表读失败')
      fail = false; await w.find('[aria-label="重新加载聊天列表"]').trigger('click'); await flushPromises(); expect(w.text()).toContain('项目群')
      await w.find('textarea').setValue('中文问题'); await w.find('textarea').trigger('compositionstart'); await w.find('textarea').trigger('keydown', { key: 'Enter' }); await flushPromises()
      expect(request.mock.calls.some(([p, o]) => p === '/agent/threads' && o.method === 'POST')).toBe(false)
      await w.find('textarea').trigger('compositionend'); await w.find('textarea').trigger('keydown', { key: 'Enter' }); await flushPromises(); expect(w.vm.thread.origin).toBe('agent')
    } finally { w.unmount() }
  })
  it('范围可搜索、多选；取消和重复应用不改变会话，Escape 将焦点还给范围按钮', async () => {
    const w = page()
    try {
      await flushPromises(); await w.find('[aria-label="选择聊天范围"]').trigger('click'); await flushPromises()
      const search = w.find('[aria-label="搜索聊天范围"]')
      expect(document.activeElement).toBe(search.element)
      await search.setValue('项目群'); expect(w.findAll('.agent-chat-scope-options label')).toHaveLength(1)
      await w.find('input[aria-label="所有聊天"]').setValue(false); await w.find('input[value="room@chatroom"]').setValue(true)
      await search.setValue('项目一'); await w.find('input[value="wxid_1"]').setValue(true)
      await w.find('[aria-label="应用聊天范围"]').trigger('click'); await flushPromises()
      await send(w, '多选的问题'); expect(w.vm.thread.chat_scope).toEqual(['room@chatroom','wxid_1'])
      await w.find('.agent-send').trigger('click'); await flushPromises(); const id = w.vm.thread.id
      await w.find('[aria-label="选择聊天范围"]').trigger('click'); await flushPromises()
      await w.find('[aria-label="应用聊天范围"]').trigger('click'); expect(w.vm.thread.id).toBe(id)
      await w.find('[aria-label="选择聊天范围"]').trigger('click'); await flushPromises()
      await w.find('.agent-chat-scope').trigger('keydown',{key:'Escape'}); await flushPromises()
      expect(w.find('.agent-chat-scope-popover').exists()).toBe(false)
      expect(document.activeElement).toBe(w.find('[aria-label="选择聊天范围"]').element)
      expect(w.vm.thread.id).toBe(id)
    } finally { w.unmount() }
  })
  it('消息提交期间新开对话后，迟到运行不会覆盖新草稿；重开页面恢复当前对话及范围', async () => {
    const original = request.getMockImplementation(); let release
    request.mockImplementation(async (p,o) => { if (p.endsWith('/messages')) await new Promise(resolve => { release = resolve }); return original(p,o) })
    let w = page()
    try {
      await flushPromises(); await scope(w,'wxid_1'); await send(w,'旧的提交')
      await w.find('[aria-label="新建 AI 对话"]').trigger('click'); await flushPromises()
      await w.find('textarea').setValue('新的草稿'); release(); await flushPromises()
      expect(w.vm.thread).toBeNull(); expect(w.vm.run).toBeNull(); expect(w.find('textarea').element.value).toBe('新的草稿')
      request.mockImplementation(original)
      await scope(w,'room@chatroom'); await send(w,'新对话的问题'); const id = w.vm.thread.id
      await w.find('textarea').setValue('保存到新对话的草稿')
      w.unmount(); w = page(); await flushPromises()
      expect(w.vm.thread.id).toBe(id); expect(w.vm.thread.chat_scope).toEqual(['room@chatroom'])
      expect(w.find('[aria-label="选择聊天范围"]').text()).toContain('项目群'); expect(w.find('textarea').element.value).toBe('保存到新对话的草稿')
    } finally { w.unmount() }
  })
  it('读取旧账号的范围列表期间切换账号，迟到联系人不会出现在新账号范围里', async () => {
    const original = request.getMockImplementation(); let release
    request.mockImplementation(async (p,o) => {
      if (p === '/conversations' && o.query.account === 'a') { await new Promise(resolve => { release = resolve }); return [{username:'private-a',name:'A 私人联系人'}] }
      if (p === '/conversations' && o.query.account === 'b') return [{username:'private-b',name:'B 联系人'}]
      return original(p,o)
    })
    const w = page()
    try {
      await flushPromises(); await w.find('[aria-label="选择聊天范围"]').trigger('click'); await flushPromises()
      await w.setProps({account:'b'}); await flushPromises(); await w.find('[aria-label="选择聊天范围"]').trigger('click'); await flushPromises()
      release(); await flushPromises(); expect(w.text()).not.toContain('A 私人联系人'); expect(w.text()).toContain('B 联系人')
    } finally { w.unmount() }
  })
  it('页面宽视图直接打开原文栏，定位失败保留原文及草稿，成功后关闭原文栏', async () => {
    const observers = [], original = globalThis.ResizeObserver
    vi.stubGlobal('ResizeObserver',class { constructor(receive){this.receive=receive} observe(element){if(element.classList.contains('agent-panel'))observers.push(this.receive)} disconnect(){} })
    const source = {source:'a'.repeat(24),username:'wxid_1',anchor:'m1',name:'项目一',sender:'甲',time:100,text:'真实形状的验收原文'}
    threads.t={id:'t',account:'a',username:'',origin:'agent',chat_scope:null,title:'引用问题',latest_run:'r',messages:[{id:'q',role:'user',text:'引用问题',run_id:'r'}]}
    runs.r={id:'r',thread_id:'t',account:'a',status:'completed',answer:`答案 [[${source.source}]]`,citations:[source],timeline:[]}
    state.value.selected['page:a:agent']='t'
    const prepareSource=vi.fn(async()=>({messages:[{id:'m1',content:source.text}]})),locateSource=vi.fn().mockRejectedValueOnce(new Error('原文定位失败')).mockResolvedValue(true)
    const w=page({prepareSource,locateSource})
    try {
      await flushPromises();await w.find('textarea').setValue('保留问题草稿');observers[0]([{contentRect:{width:1100}}])
      await w.find('.agent-ref').trigger('click');await flushPromises()
      expect(w.find('.agent-source-inspector').text()).toContain(source.text)
      expect(w.attributes('role')).toBeUndefined();expect(prepareSource).toHaveBeenCalledWith(source)
      await w.find('.agent-source-locate').trigger('click');await flushPromises()
      expect(w.find('.agent-source-inspector [role="alert"]').text()).toBe('原文定位失败')
      expect(w.find('textarea').element.value).toBe('保留问题草稿')
      await w.find('.agent-source-locate').trigger('click');await flushPromises()
      expect(w.find('.agent-source-inspector').exists()).toBe(false)
      expect(locateSource).toHaveBeenCalledTimes(2)
    } finally {w.unmount();vi.stubGlobal('ResizeObserver',original)}
  })
  it('发送期间切换历史释放当前提交状态，旧提交完成不能清除新对话的提交状态', async () => {
    for (const id of ['old','next']) {
      threads[id]={id,account:'a',username:'',origin:'agent',chat_scope:null,title:`${id} 对话`,latest_run:`run-${id}`,messages:[{id:`q-${id}`,role:'user',text:`${id} 问题`,run_id:`run-${id}`}]}
      runs[`run-${id}`]={id:`run-${id}`,account:'a',thread_id:id,status:'completed',answer:`${id} 回答`,timeline:[],citations:[]}
    }
    state.value.selected['page:a:agent']='old'
    const original=request.getMockImplementation(), releases={}
    request.mockImplementation(async(p,o)=>{if(p.endsWith('/messages'))await new Promise(resolve=>{releases[p]=resolve});return original(p,o)})
    const w=page()
    try {
      await flushPromises();await send(w,'旧对话提交');expect(w.vm.sending).toBe(true)
      await w.find('[aria-label="AI 对话历史"]').trigger('click');await flushPromises()
      await w.findAll('.agent-thread-select').find(row=>row.text().includes('next 对话')).trigger('click');await flushPromises()
      expect(w.vm.sending).toBe(false);expect(w.vm.stopping).toBe(false)
      await w.find('textarea').setValue('新对话提交');expect(w.find('.agent-send').attributes('disabled')).toBeUndefined()
      expect(w.find('[aria-label="选择聊天范围"]').attributes('disabled')).toBeUndefined()
      await w.find('.agent-send').trigger('click');await flushPromises();expect(w.vm.sending).toBe(true)
      releases['/agent/threads/old/messages']();await flushPromises()
      expect(w.vm.thread.id).toBe('next');expect(w.vm.sending).toBe(true);expect(w.find('textarea').element.value).toBe('新对话提交')
      releases['/agent/threads/next/messages']();await flushPromises()
      expect(w.vm.sending).toBe(false);expect(w.find('textarea').element.value).toBe('');expect(w.vm.run.thread_id).toBe('next')
    } finally {w.unmount()}
  })
  it('停止期间切换历史释放当前停止状态，旧停止失败不改变新对话操作', async () => {
    for (const id of ['old','next']) {
      threads[id]={id,account:'a',username:'',origin:'agent',chat_scope:null,title:`${id} 对话`,latest_run:`run-${id}`,messages:[{id:`q-${id}`,role:'user',text:`${id} 问题`,run_id:`run-${id}`}]}
      runs[`run-${id}`]={id:`run-${id}`,account:'a',thread_id:id,status:'running',answer:'',stage:'搜索中',timeline:[],citations:[]}
    }
    state.value.selected['page:a:agent']='old'
    const original=request.getMockImplementation(), releases={}
    request.mockImplementation(async(p,o)=>{
      if(p.endsWith('/stop'))await new Promise((resolve,reject)=>{releases[p]={resolve,reject}})
      return original(p,o)
    })
    const w=page()
    try {
      await flushPromises();await w.find('.agent-send').trigger('click');await flushPromises();expect(w.vm.stopping).toBe(true)
      await w.find('[aria-label="AI 对话历史"]').trigger('click');await flushPromises()
      await w.findAll('.agent-thread-select').find(row=>row.text().includes('next 对话')).trigger('click');await flushPromises()
      expect(w.vm.stopping).toBe(false);expect(w.find('.agent-send').attributes('disabled')).toBeUndefined()
      await w.find('.agent-send').trigger('click');await flushPromises();expect(w.vm.stopping).toBe(true)
      releases['/agent/runs/run-old/stop'].reject(new Error('旧任务停止失败'));await flushPromises()
      expect(w.vm.thread.id).toBe('next');expect(w.vm.stopping).toBe(true);expect(w.vm.run.status).toBe('running');expect(w.text()).not.toContain('旧任务停止失败')
      releases['/agent/runs/run-next/stop'].resolve();await flushPromises()
      expect(w.vm.stopping).toBe(false);expect(w.vm.run.status).toBe('cancelled');expect(w.find('[aria-label="选择聊天范围"]').attributes('disabled')).toBeUndefined()
    } finally {w.unmount()}
  })
})
