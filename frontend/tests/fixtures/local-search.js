import { createApp, ref, computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import Preview from './LocalSearchPreview.vue'
import LocalSearchSettings from '../../components/LocalSearchSettings.vue'
import { useChatAccountsStore } from '../../stores/chatAccounts'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../../assets/css/ai-settings.css'
// 独立交互验收页，只使用虚构数据，不连接用户账号或模型服务。
Object.assign(globalThis,{ref,computed,process:{client:false},useApiBase:()=>'/unused',useRoute:()=>({params:{username:'team'}}),useSettingsDialog:()=>({focusTarget:ref(new URLSearchParams(location.search).has('models') ? '' : 'local-search')})})
const modelMetadata = { id:'preview-model', name:'演示模型', source:'models.dev', provider_id:'deepseek', provider_name:'DeepSeek', logo_url:'https://models.dev/logos/deepseek.svg', vision:false, tool_call:true, reasoning:true, temperature:true, structured_output:true, attachment:false, open_weights:true, modalities:{input:['text'],output:['text']}, limit:{context:128000,output:8192}, cost:{input:0.28,output:0.42,cache_read:0.028}, knowledge:'2025-01', release_date:'2025-01-01',last_updated:'2026-09-09' }
const models=[
{id:'bge-small-zh',name:'BGE Small 中文',description:'轻量中文，适合低配置电脑',recommended:true,repo:'Xenova/bge-small-zh-v1.5',revision:'75c43b069aac4d136ba6bc1122f995fedcfd2781',license:'MIT',size:95401750,downloaded:true},
{id:'bge-base-zh',name:'BGE Base 中文',description:'中文进阶，资源占用更高',repo:'Xenova/bge-base-zh-v1.5',revision:'71e50dc531959f9e04ebf190ea25b00261a0a186',license:'MIT',size:407503264,downloaded:false},
{id:'multilingual-e5-small',name:'Multilingual E5 Small',description:'适合中英文及多语言聊天',repo:'intfloat/multilingual-e5-small',revision:'614241f622f53c4eeff9890bdc4f31cfecc418b3',license:'MIT',size:492421556,downloaded:false},
]
let config={enabled:false,model:'bge-small-zh',usernames:[],days:90,start:null,end:null,device:'auto',device_id:0,auto_update:true,revision:1},jobs=[]
// 固定的整理快照用于视觉与交互检查，不会读取真实聊天或启动索引。
const progressPreview=new URLSearchParams(location.search).get('progress')
let indexStats,messageTotal
if(progressPreview){
  config={...config,enabled:true,agent_global:true,days:0,start:0,read_batch_size:0}
  const initial=progressPreview==='initial',done=progressPreview==='done'
  const started=Date.now()/1000-(initial?1:86)
  jobs=[{id:'progress-preview',status:initial?'running':progressPreview,stage:initial?'counting':done?'done':'embedding',mode:'initial',started,updated:Date.now()/1000,
    ...(['paused','error','done'].includes(progressPreview)?{finished:Date.now()/1000}:{}),
    read_count:initial?0:26286,processed:initial?0:25833,embedded:initial?0:4180,embedded_count:initial?0:4260,
    chat_index:initial?0:done?1560:686,segments:Array.from({length:1560},()=>({})),read_batch_size_effective:1000,config:{...config},
    ...(progressPreview==='error'?{error:'模型运行中断，请检查运行设备后重试。'}:{})}]
  indexStats={messages:initial?0:25833,chunks:initial?0:4180}
  messageTotal={job_id:'progress-preview',status:initial?'counting':'ready',value:58735,fixed:true,estimated:false}
  if(done){jobs[0].read_count=58735;jobs[0].processed=58735}
}
// 分类弹窗验收使用与设计稿一致的虚构数据，覆盖长列表与部分选择。
const scopePreview=new URLSearchParams(location.search).has('scope')
const groupNames=['周末羽毛球群','产品讨论群','同学交流群','摄影分享群','城市徒步群','读书交流群']
const personNames=['陈晨','林悦','张明','李然','周宁','王琳']
const scopeChats=[
  ...Array.from({length:128},(_,i)=>({username:`group-${i}@chatroom`,name:groupNames[i] || `群聊示例 ${i+1}`,isGroup:true})),
  ...Array.from({length:636},(_,i)=>({username:`person-${i}`,name:personNames[i] || `个人聊天示例 ${i+1}`,isGroup:false})),
]
if(scopePreview)config.usernames=[...scopeChats.slice(0,128).filter((_,i)=>i!==4 && i!==127).map(c=>c.username),...scopeChats.slice(128).filter((_,i)=>[0,2,5,6,7,8,9,10,11,12,13,14].includes(i)).map(c=>c.username)]
const mac=navigator.userAgent.includes('Mac')
const gpu={supported:!mac,platform:mac?'darwin':'win32',size:1671874915,installed:false,job:null}
let gpuTimer
globalThis.useAiApi=()=>({request:async(path,options={})=>{
  if(path.startsWith('/local-search/status'))return JSON.parse(JSON.stringify({config,models,jobs,index_stats:indexStats,message_total:messageTotal,device:{actual_device:'cpu'},gpu,audit:[]}))
  // 模拟组件状态，供按钮交互验收；不会下载真实文件。
  if(path==='/local-search/gpu/download'){
    if(!['queued','running'].includes(gpu.job?.status)){
      gpu.job={status:'running',stage:'downloading',bytes:gpu.job?.bytes || 0,total:gpu.size}
      clearInterval(gpuTimer)
      gpuTimer=setInterval(()=>{gpu.job.bytes=Math.min(gpu.size,gpu.job.bytes+32*1024**2);if(gpu.job.bytes===gpu.size){gpu.installed=true;gpu.job.status='done';clearInterval(gpuTimer)}},1000)
    }
    return JSON.parse(JSON.stringify(gpu))
  }
  if(path==='/local-search/gpu/pause'){clearInterval(gpuTimer);gpu.job.status='paused';return JSON.parse(JSON.stringify(gpu))}
  if(path.startsWith('/local-search/conversations'))return scopePreview ? scopeChats : [{username:'team',name:'产品项目群',isGroup:true},{username:'design',name:'设计讨论组',isGroup:true},{username:'friend',name:'小林',isGroup:false}]
  if(path.startsWith('/local-search/settings')){config={...options.body,revision:config.revision+1};return config}
  if(path.startsWith('/local-search/index/build')){jobs=[{id:'preview-job',status:'running',stage:'reading',started:Date.now()/1000,processed:0,embedded:0,config:{revision:config.revision}}];setTimeout(()=>{if(jobs[0]?.status==='running')Object.assign(jobs[0],{processed:200,embedded:40,stage:'done',status:'done',finished:Date.now()/1000})},5000);return jobs[0]}
  if(path.startsWith('/local-search/index/pause')){jobs[0].status='paused';jobs[0].updated=Date.now()/1000}
  if(path.startsWith('/local-search/index/resume')){jobs[0].status='done';jobs[0].finished=Date.now()/1000}
  if(path.startsWith('/local-search/models/') && path.includes('/download')){const m=models.find(x=>path.includes(x.id));m.job={status:'running',stage:'downloading',bytes:0,total:m.size};setTimeout(()=>{m.downloaded=true;m.job={status:'done',stage:'done'}},1500)}
  if(path==='/settings')return {profiles:[{id:'preview',name:'日常对话',provider:'deepseek',model:'preview-model',protocol:'openai',base_url:'https://api.deepseek.com/v1',vision:false,context_window:128000,model_metadata:modelMetadata}],presets:[],defaults:{text:'preview'}}
  if(path==='/models')return {models:['preview-model'],model_details:[modelMetadata]}
  return []
}})
const pinia=createPinia();setActivePinia(pinia);useChatAccountsStore().selectedAccount='演示账号'
createApp(Preview).use(pinia).component('LocalSearchSettings',LocalSearchSettings).mount('#app')
