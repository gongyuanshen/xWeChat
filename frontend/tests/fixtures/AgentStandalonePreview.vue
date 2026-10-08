<template>
  <div class="standalone-preview-controls"><span>合成数据 · 无模型调用</span><button v-for="value in ['empty','running','completed','error']" :key="value" :aria-pressed="scenario === value" @click="reset(value)">{{ labels[value] }}</button><button @click="dark = !dark; applyTheme()">{{ dark ? '浅色' : '深色' }}</button><button @click="switchAccount">切换账号</button><span v-if="located" role="status">已定位原文：{{ located.text }}</span></div>
  <main class="standalone-preview-stage"><ChatAgentPanel :key="seed" presentation="page" :account="account" :prepare-source="prepare" :locate-source="locate" /></main>
</template>
<script setup>
import { ref } from 'vue'
import ChatAgentPanel from '../../components/chat/ChatAgentPanel.vue'
const labels = { empty:'空态', running:'执行中', completed:'已完成', error:'错误' }
const params = new URLSearchParams(location.search)
const scenario = ref(params.get('state') || 'empty'), dark = ref(params.get('theme') === 'dark'), account = ref('preview'), seed = ref(0), located = ref(null)
const saved = ref({ selected: {}, drafts: {}, pinned: {} })
const contacts = [{ username: 'wxid_teamlead', name: '周明' }, { username: 'project@chatroom', name: '产品项目群' }, { username: 'design@chatroom', name: '设计讨论组' }, { username: 'wxid_friend', name: '小林' }]
const source = { source:'aaaaaaaaaaaaaaaaaaaaaaaa', username:'project@chatroom', anchor:'message-plan', name:'产品项目群', sender:'周明', time:1791181800, text:'这周先确认排期和验收标准，下周三再一起核对进展。' }
const answer = `最近的项目讨论有两件事需要跟进：\n\n1. **确认排期和验收标准**，目前还没有最终结论。\n2. **下周三核对进展**，群里已经提过这个安排。[[${source.source}]]\n\n可以继续查找具体负责人，或缩小到项目群核对上下文。`
const clone = value => structuredClone(value)
let threads = [], runs = {}, selectedModel = { profile_id:'fixture', model_id:'Qwen3.5', reasoning_effort:'medium' }, callback
const baseRun = (status, id = 'sample-run', threadId = 'sample-thread') => ({ id, thread_id:threadId, account:account.value, version:1, status, stage:'正在查找相关聊天记录', stage_started_at:Date.now()/1000-5, segment_started:Date.now()/1000-8, elapsed_seconds:8, updated_at:Date.now()/1000, timeline:status === 'running' ? [] : [{id:'searched',kind:'tool',seq:1,revision:1,status:'completed',text:'查找项目待办',action:'search_messages',query:'排期 验收',username:'project@chatroom',started_at:1,finished_at:3,result:{returned:12,retrieval_mode:'hybrid'}}], answer:status === 'completed' ? answer : '', citations:[source], references:[], read_count:12, usage:{input_tokens:2400,output_tokens:350}, context_budget:{used:3600,input_capacity:60000,percent:6,description:'合成验收预算'}, ...(status === 'failed' ? {error:'示例错误：本地模型服务连接失败。请检查服务后重试。',can_resume:true} : {}) })
const reset = value => {
  scenario.value = value; callback = null; located.value = null
  saved.value = { selected:{}, drafts:{}, pinned:{} }
  const sample = { id:'sample-thread', account:account.value, username:'', origin:'agent', chat_scope:null, title:'最近有哪些项目待办？', latest_run:'sample-run', messages:[{id:'sample-question',role:'user',run_id:'sample-run',text:'最近有哪些项目待办？'}] }
  threads = [sample,{id:'scoped-thread',account:account.value,username:'',origin:'agent',chat_scope:['project@chatroom'],title:'项目群的排期约定',latest_run:'scoped-run',messages:[{id:'scoped-question',role:'user',run_id:'scoped-run',text:'项目群的排期约定是什么？'}]}]
  runs = { 'sample-run':baseRun(value === 'error' ? 'failed' : value === 'running' ? 'running' : 'completed'), 'scoped-run':baseRun('completed','scoped-run','scoped-thread') }
  if (value !== 'empty') saved.value.selected[`page:${account.value}:agent`] = 'sample-thread'
  seed.value++
}
globalThis.useState = () => saved
globalThis.useSettingsDialog = () => ({ openDialog: () => { located.value = { text:'验收页：此操作在应用内打开现有 AI 服务设置。' } } })
globalThis.useAiApi = () => ({
  agentEvents: (activeAccount, receive, ready) => { callback = receive; queueMicrotask(() => ready?.({reconnected:false})); return () => { if (callback === receive) callback = null } },
  request: async (path, options = {}) => {
    if (path === '/settings') return { selected_model:selectedModel, profiles:[{id:'fixture',name:'合成本地服务',model:'Qwen3.5',model_metadata:{reasoning_controls:{efforts:['low','medium','high']}}}] }
    if (path === '/selected-model') { selectedModel = clone(options.body); return selectedModel }
    if (path.includes('/model-capabilities')) return {metadata:{reasoning_controls:{efforts:['low','medium','high']}}}
    if (path.endsWith('/models')) return {model_details:[{id:'Qwen3.5'},{id:'合成备用模型'}]}
    if (path === '/conversations') return clone(contacts)
    if (path === '/agent/threads') {
      if (options.method === 'POST') { const item = {id:crypto.randomUUID(),...options.body,title:'新的对话',messages:[],latest_run:''}; threads.unshift(item); return clone(item) }
      return clone(threads.filter(t => t.account === options.query.account && t.origin === options.query.origin).map(t => ({...t,latest_run_status:runs[t.latest_run]?.status || ''})))
    }
    const [, , kind, id, action] = path.split('/')
    if (kind === 'threads') {
      const item = threads.find(t => t.id === id)
      if (!item) throw new Error('验收对话不存在')
      if (options.method === 'PATCH') Object.assign(item,options.body)
      if (options.method === 'DELETE') { threads = threads.filter(t => t.id !== id); return {status:'success'} }
      if (action === 'messages') {
        const active = runs[item.latest_run]?.status === 'running', rid = active ? item.latest_run : crypto.randomUUID()
        if (!active) runs[rid] = baseRun('running',rid,item.id)
        item.latest_run = rid; item.title = item.title === '新的对话' ? options.body.text : item.title
        item.messages.push({id:options.body.request_id,request_id:options.body.request_id,role:'user',text:options.body.text,run_id:rid,supplement:active})
        if (active) runs[rid].timeline.push({id:crypto.randomUUID(),kind:'supplement',seq:runs[rid].timeline.length+1,text:options.body.text,status:'applied'})
        return clone(runs[rid])
      }
      return clone(item)
    }
    if (kind === 'runs') {
      if (!runs[id]) throw new Error('验收任务不存在')
      if (action === 'stop') runs[id].status = 'cancelled'
      if (action === 'continue') runs[id].status = 'running'
      if (action === 'restart') { const next = baseRun('running',crypto.randomUUID(),runs[id].thread_id); runs[next.id] = next; return clone(next) }
      return clone(runs[id])
    }
    throw new Error(`验收页未定义的接口：${path}`)
  },
})
const prepare = async () => ({messages:[{id:source.anchor,senderDisplayName:source.sender,createTime:source.time,content:source.text}]})
const locate = async value => { located.value = value; return true }
const applyTheme = () => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light' }
const switchAccount = () => { account.value = account.value === 'preview' ? 'preview-other' : 'preview'; reset('empty') }
applyTheme(); reset(scenario.value)
</script>
<style>
html,body,#app { width:100%; height:100%; margin:0; }
#app { display:flex; flex-direction:column; background:var(--chat-page-bg); color:var(--app-text-primary); font-family:'Microsoft YaHei UI','Microsoft YaHei','PingFang SC',sans-serif; }
.standalone-preview-controls { display:flex; align-items:center; gap:8px; min-height:42px; padding:6px 14px; box-sizing:border-box; flex:none; overflow-x:auto; white-space:nowrap; border-bottom:1px solid var(--chat-input-border); font-size:11px; }
.standalone-preview-controls button { cursor:pointer; background:var(--chat-input-bg); color:inherit; padding:4px 8px; border:1px solid var(--chat-input-border); border-radius:6px; }
.standalone-preview-controls button[aria-pressed=true] { color:var(--chat-accent); border-color:var(--chat-accent); }
.standalone-preview-stage { display:flex; flex:1; min-height:0; }
</style>
