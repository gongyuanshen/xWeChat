<template>
  <div class="preview-toolbar"><strong>AI 助手 · 交互预览</strong><button @click="height = height === 800 ? 560 : 800">{{ height }}px 高度</button><button @click="dark = !dark; applyTheme()">{{ dark ? '浅色' : '深色' }}</button><button @click="reset">恢复示例</button><button @click="streamDemo">流式演示</button><button @click="stepsDemo">分段步骤示例</button><button @click="finishDemo">完成示例</button><span>本页使用示例数据，不调用模型</span></div>
  <main class="preview-stage" :style="{ height: height + 'px', maxHeight: 'calc(100dvh - 112px)' }"><div class="preview-chat"><h2>南京出行</h2><p>在右侧查看 AI 助手，点击引用核对原文。</p><p v-if="located" role="status">已定位：{{ located.text }}</p></div><ChatAgentPanel :key="seed" account="preview" :contact="contact" :contacts="contacts" :prepare-source="prepare" :locate-source="locate" @close="closed = true" v-if="!closed" /><button v-else @click="closed = false">打开 AI 助手</button></main>
  <p class="preview-note">交互：模型选择、全账号查询、历史、工具、输入框、引用、展开 / 收起。示例对话仅用于验证布局。</p>
</template>
<script setup>
import { ref, onUnmounted } from 'vue'
import ChatAgentPanel from '../../components/chat/ChatAgentPanel.vue'
const designPreview = new URLSearchParams(location.search).has('design')
const referencePreview = new URLSearchParams(location.search).has('references')
const budgetPreview = new URLSearchParams(location.search).has('budget')
// 圆环浮层参考图的数值，独立于原有预算预览场景。
const ringPreview = new URLSearchParams(location.search).get('budget') === 'reference'
const height = ref(designPreview ? 800 : 560), dark = ref(false), seed = ref(0), closed = ref(false), located = ref(null)
const contact = { username:'sample', name:'文海健9.8' }, contacts=[contact,{username:'travel',name:'南京出行讨论群'}]
const source = {source:'aaaaaaaaaaaaaaaaaaaaaaaa',username:'sample',anchor:'msg2',name:'文海健9.8',sender:'文海健',time:1788849120,text:'费用先记到 AA 表里，晚点再一起核对。'}
const answer = designPreview ? `约饭定在 **9月9日（周三）晚上**。

从聊天看，这事有过一次明确约定：
- 9月2日提到“那就下周三（旺柴）”，也就是顺延到 **9月9日**。[[aaaaaaaaaaaaaaaaaaaaaaaa]]
- 9月7日再次确认“周三晚上吃饭啊”“先这样哈，周三见”。[[bbbbbbbbbbbbbbbbbbbbbbbb]]` : `## 南京出行梳理
目前聊到了行程、费用和兼职安排，以下是已经确认和仍需核对的内容。
### 已经提到
1. **行程**：讨论过南京出行，但具体出发时间还没敲定。[[aaaaaaaaaaaaaaaaaaaaaaaa]]
2. **费用**：提到了 AA 记账表，金额信息仍需核对。[[bbbbbbbbbbbbbbbbbbbbbbbb]]
3. **安排**：聊到了兼职，需要再确认是否影响行程。[[cccccccccccccccccccccccc]]
### 还没确认
- 出发时间与交通方式
- 是否涉及具体演唱会或场次 [[dddddddddddddddddddddddd]]
### 需要注意
聊天中只提到“追星”“演唱会”，尚不能确定具体活动。`
const citations = designPreview ? [
  {...source, anchor:'dinner1', time:new Date('2026-09-02T18:30:00+08:00').getTime()/1000, text:'那就下周三。'},
  {...source, source:'bbbbbbbbbbbbbbbbbbbbbbbb', anchor:'dinner2', time:new Date('2026-09-07T18:30:00+08:00').getTime()/1000, text:'周三晚上吃饭啊，先这样哈，周三见。'},
] : ['a','b','c','d'].map((id,index)=>({...source,source:id.repeat(24),text:index === 0 ? '出发时间我们还没定，再看一下。' : source.text}))
const baseRun=()=>({id:'run1',status:'completed',elapsed_seconds:18,answer,citations,coverage_warnings:['我未解析图片和《旅行AA记账表.xlsx》文件内容，费用数字来自聊天文本。','部分范围仍有未读取的消息，当前回答仅依据已读取资料。'],usage:{calls:6,input_tokens:1800,output_tokens:420},timeline:[
  {id:'t1',kind:'tool',seq:1,status:'completed',text:'查找南京出行安排',action:'search_messages',query:'南京 出行 费用',username:'sample',started_at:1,finished_at:3,result:{returned:12,retrieval_mode:'hybrid'}},
  {id:'p1',kind:'progress',seq:2,status:'completed',text:'找到 **出行与费用** 的讨论，出发时间还没确定 (source: aaaaaaaaaaaaaaaaaaaaaaaa)。继续核对前后文。'},
  {id:'t2',kind:'tool',seq:3,status:'completed',text:'读取前后文',action:'read_context',username:'sample',started_at:3,finished_at:7,result:{returned:28}},
]})
const makeRun = () => {
  const result = baseRun()
  if (referencePreview) Object.assign(result, {
    answer: `甲提到 [[person:${'e'.repeat(24)}]] 更新了排期。[[${source.source}]]\n\n本回答引用两张图片：[[image:${'f'.repeat(24)}]] 和 [[image:${'1'.repeat(24)}]]。`,
    references: [
      {kind:'person',id:'e'.repeat(24),username:'subject-b',name:'乙',sources:[source.source]},
      {kind:'image',id:'f'.repeat(24),source:source.source,label:'排期示意图',path:'/chat/media/image?account=preview&acceptance=diagram'},
      {kind:'image',id:'1'.repeat(24),source:source.source,label:'缺失图片示例',path:'/chat/media/image?account=preview&acceptance=missing'},
      {kind:'image',id:'2'.repeat(24),source:source.source,label:'未引用图片',path:'/chat/media/image?account=preview&acceptance=unused'},
    ],
  })
  if (designPreview) Object.assign(result, { elapsed_seconds:141, coverage_warnings:['部分图片未读取，回答仅依据已读取的聊天记录。'], timeline:[
    {id:'t1',kind:'tool',seq:1,status:'completed',text:'搜索了聊天记录',action:'search_messages',query:'约饭',username:'sample',started_at:1,finished_at:3,result:{returned:21,retrieval_mode:'hybrid'}},
    {id:'t2',kind:'tool',seq:2,status:'completed',text:'读取了上下文',action:'read_context',username:'sample',started_at:3,finished_at:5,result:{returned:21}},
    {id:'t3',kind:'tool',seq:3,status:'completed',text:'读取了上下文',action:'read_context',username:'sample',started_at:5,finished_at:5,cached:true,result:{returned:21}},
    {id:'p1',kind:'progress',seq:4,status:'completed',text:'已找到周三晚饭的约定，继续核对最近消息。[[aaaaaaaaaaaaaaaaaaaaaaaa]]'},
    {id:'t4',kind:'tool',seq:5,status:'completed',text:'核对了最近消息',action:'read_messages',username:'sample',started_at:5,finished_at:9,result:{returned:8}},
  ] })
  return result
}
const thread={id:'thread1',username:'sample',title:'南京出行梳理',scope:['sample'],latest_run:'run1',messages:[{id:'q1',role:'user',run_id:'run1',text:designPreview ? '我们之前在哪一天约的饭来着？' : '帮我梳理最近的南京出行安排，还有哪些事没定？'}]}
const withContext = () => ({ ...makeRun(), account:'preview', version:1,
  ...(budgetPreview ? {context_budget:{used:30000,input_capacity:60928,model_window:65536,percent:49,output_reserve:4096,safety_reserve:512,description:'使用保守估算；累计模型消耗在用量审计中单独记录。',...(ringPreview ? {used:5400,input_capacity:916992,model_window:1048576,percent:0.6,output_reserve:131072} : {})}} : {}),
  read_count:242, source_count:242, time_range:{start:1788624000,end:1788912000}, intent:{mode:'overview'}, analysis:{known:true,complete:true,analyzed:242,segments:12,findings:24,coverage:[{username:'sample',read:121,analyzed:121,complete:true},{username:'travel',read:121,analyzed:121,complete:true}]},answer_context:{status:'completed',sources:[{source:source.source,text_chars:source.text.length,truncated:false}],summary_sources:citations.map(x=>x.source),summary_segments:12,omitted:241} })
let run=withContext()
const historySample={id:'thread2',username:'travel',title:'上周还有哪些待办？',scope:['travel'],latest_run:'past1',messages:[{id:'q2',role:'user',run_id:'past1',text:'上周还有哪些待办？'}]}
let previewThreads=[structuredClone(thread),structuredClone(historySample)], previewRuns={run1:run,past1:{...withContext(),id:'past1',answer:'上周还有两件事需要核对：出发时间、交通方式。',timeline:[]}}
const clone=value=>structuredClone(value)
const state = ref({selected:{},drafts:{},pinned:{}})
window.useState=()=>state
window.useSettingsDialog=()=>({openDialog:()=>{window.alert('这里会打开现有 AI 服务设置。')}})
let onAgentEvent, demoTimer
// 验收页独立保存虚构模型选择，不连接真实服务或账号。
let selectedModel = JSON.parse(localStorage.getItem('qa-agent-selected-model') || 'null') || {profile_id:'local',model_id:ringPreview ? 'mimo-v2.5' : 'text-model',reasoning_effort:null}
window.useAiApi=()=>({agentEvents:(_account,callback)=>{onAgentEvent=callback;return()=>{if(onAgentEvent===callback)onAgentEvent=null}},events:()=>()=>{},request:async(path,options={})=>{
  // ?cold=1 用于浏览器验证首次无缓存、模型配置延迟返回的场景。
  if(path==='/settings' && new URLSearchParams(location.search).has('cold')) await new Promise(resolve=>setTimeout(resolve,6000))
  if(path==='/settings')return {selected_model:selectedModel,defaults:{text:'local'},profiles:[{id:'local',name:'我的文本模型',model:ringPreview ? 'mimo-v2.5' : 'text-model',...(budgetPreview && !ringPreview ? {model_metadata:{reasoning_efforts:['low','medium','high']}} : {})},{id:'vision',name:'视觉模型',vision:true,model:'vision-model'}]}
  if(path==='/selected-model'){selectedModel=clone(options.body);localStorage.setItem('qa-agent-selected-model',JSON.stringify(selectedModel));return selectedModel}
  if(path==='/agent/threads') {
    if(options.method==='POST'){const created={id:crypto.randomUUID(),username:options.body.username,title:'新的对话',scope:[options.body.username],messages:[],latest_run:''};previewThreads.unshift(created);return clone(created)}
    return clone(previewThreads.filter(item=>!options.query?.username||item.username===options.query.username).map(item=>({...item,latest_run_status:previewRuns[item.latest_run]?.status || ''})))
  }
  if(path==='/agent/runs/run1/materials') {
    const {kind,offset=0}=options.query
    if(kind==='statistics')return {total_messages:242,items:[{day:'2026-09-08',username:'sample',sender:'文海健',count:121},{day:'2026-09-08',username:'travel',sender:'我',count:121}],has_more:false}
    if(kind==='sources')return {items:citations,total:242,has_more:offset===0}
    return {items:Array.from({length:offset ? 4 : 20},(_,i)=>({id:String(offset+i),text:`待确认事项 ${offset+i+1}：出发时间和费用需要再次核对。`,sources:[source.source],citations:[source]})),total:24,has_more:offset===0}
  }
  if(path==='/conversations')return contacts
  const [, ,kind,id,action]=path.split('/')
  if(kind==='threads'){
    const item=previewThreads.find(item=>item.id===id)
    if(!item)throw new Error('会话不存在')
    if(options.method==='DELETE'){previewThreads=previewThreads.filter(t=>t.id!==id);if(item.latest_run===run.id)clearInterval(demoTimer);return {status:'success'}}
    if(action==='messages'){
      const active=previewRuns[item.latest_run]?.status==='running'
      if(!active){item.latest_run=crypto.randomUUID();previewRuns[item.latest_run]={...withContext(),id:item.latest_run,answer:'',timeline:[]}}
      if(item.title==='新的对话')item.title=options.body.text.slice(0,30)
      item.messages.push({id:options.body.request_id,role:'user',text:options.body.text,run_id:item.latest_run,supplement:active})
      if(active){const current=previewRuns[item.latest_run];current.timeline.push({id:crypto.randomUUID(),kind:'supplement',seq:current.timeline.length+1,status:'applied',text:options.body.text})}
      else startStream(item.latest_run)
      return clone(previewRuns[item.latest_run])
    }
    if(options.method==='PATCH')Object.assign(item,options.body)
    return clone(item)
  }
  if(kind==='runs'){
    if(!previewRuns[id])throw new Error('任务不存在')
    if(action==='stop'){if(run.id===id)clearInterval(demoTimer);previewRuns[id]={...previewRuns[id],status:'cancelled',timeline:previewRuns[id].timeline.map(item=>item.status==='running'?{...item,status:'paused',revision:(item.revision||0)+1,finished_at:Date.now()/1000}:item),updated_at:Date.now()/1000};return clone(previewRuns[id])}
    if(action==='continue')startStream(id,true)
    return clone(previewRuns[id])
  }
  return []
}})
const prepare = async () => ({messages:designPreview ? citations.map(item=>({id:item.anchor,senderDisplayName:item.sender,createTime:item.time,content:item.text})) : [{id:'msg1',senderDisplayName:'我',createTime:1788848880,content:'大概每人预算多少？'},{id:'msg2',senderDisplayName:'文海健',createTime:1788849120,content:source.text},{id:'msg3',senderDisplayName:'我',createTime:1788849300,content:'好的，我看看其他人的时间再定。'}]})
const locate = async value => {located.value=value;return true}
const applyTheme=()=>document.documentElement.dataset.theme=dark.value?'dark':'light'
const reset=()=>{clearInterval(demoTimer);run=withContext();previewThreads=[clone(thread),clone(historySample)];previewRuns={run1:run,past1:{...withContext(),id:'past1',answer:'上周还有两件事需要核对：出发时间、交通方式。',timeline:[]}};state.value={selected:{},drafts:{},pinned:{}};closed.value=false;seed.value++}
const streamDemo=()=>{
  state.value.pinned.preview='thread1';seed.value++;startStream('run1')
}
const stepsDemo=()=>{
  reset()
  const now=Date.now()/1000
  const stages=['理解问题与读取范围','正在读取聊天记录','正在分段分析','正在分段分析']
  run={...withContext(),status:'running',answer:'',elapsed_seconds:0,segment_started:now-26,stage_started_at:now-2,
    stage:stages[3],read_count:100,analysis:{known:true,analyzed:50,complete:false,coverage:[]},coverage_warnings:[],usage:{calls:3,input_tokens:100,output_tokens:20},
    timeline:stages.map((text,i)=>({id:`stage${i}`,seq:i+1,revision:1,kind:'status',text,status:i===3?'running':'completed',started_at:now-26+i*8,...(i<3?{finished_at:now-18+i*8}:{})}))}
  previewRuns.run1=run
  previewThreads[0].title='请总结一下最近100条消息再说什么'
  previewThreads[0].messages=[{id:'steps-question',role:'user',run_id:'run1',text:previewThreads[0].title}]
  state.value.pinned.preview='thread1';seed.value++
}
const finishDemo=()=>{
  clearInterval(demoTimer)
  const now=Date.now()/1000
  run={...run,status:'completed',elapsed_seconds:Math.round(now-run.segment_started),
    answer:'这是用于检查完成态的示例回答。真实回答仍由模型生成。',
    timeline:run.timeline.map(x=>x.status==='running'?{...x,status:'completed',revision:(x.revision||0)+1,finished_at:now}:x)}
  previewRuns[run.id]=run
  onAgentEvent?.({run_id:run.id,status:run.status})
}
const startStream=(id,resume=false)=>{
  clearInterval(demoTimer)
  const started=Date.now()/1000
  run={...withContext(),id,status:'running',elapsed_seconds:0,answer:resume?previewRuns[id].answer:'',segment_started:started,stage_started_at:started,stage:'正在核对出行安排',updated_at:started}
  run.timeline=run.timeline.map(item=>item.id==='t2'?{...item,revision:2,status:'running',started_at:started,finished_at:null}:item)
  previewRuns[id]=run;onAgentEvent?.({run_id:id,status:run.status})
  let count=run.answer.length, ticks=0
  const completedTimeline=withContext().timeline
  if(!resume) run={...run,timeline:[],stage:'理解问题与读取范围',read_count:0,usage:{calls:1,input_tokens:0,output_tokens:0},analysis:null,coverage_warnings:[]}
  previewRuns[id]=run;onAgentEvent?.({run_id:id,status:run.status})
  demoTimer=setInterval(()=>{
    ticks++
    if(!resume && ticks<20){
      if(ticks===10) run={...run,stage:'搜索相关聊天记录',stage_started_at:Date.now()/1000,timeline:[{...completedTimeline[0],status:'running',started_at:Date.now()/1000,finished_at:null}]}
      previewRuns[id]=run;onAgentEvent?.({run_id:id,status:run.status});return
    }
    if(!resume && ticks===20) run={...run,timeline:completedTimeline.map(item=>({...item,revision:2,
      ...(item.started_at == null ? {} : {started_at:started+item.started_at}),
      ...(item.finished_at == null ? {} : {finished_at:started+item.finished_at})})),stage:'整理已找到的记录，生成回答',stage_started_at:Date.now()/1000,read_count:29}

    count+=24
    const done=count>=answer.length
    const item={id:`answer:${id}`,kind:'answer',seq:100,revision:count,text:answer.slice(0,count),status:done?'completed':'running'}
    run={...run,answer:item.text,timeline:[...run.timeline.filter(x=>x.id!==item.id),item],updated_at:Date.now()/1000}
    if(done){run.status='completed';run.elapsed_seconds=Math.round(Date.now()/1000-started);run.timeline=run.timeline.map(x=>x.id==='t2'?{...x,revision:3,status:'completed',finished_at:Date.now()/1000}:x);clearInterval(demoTimer)}
    previewRuns[id]=run
    if(done){const t=previewThreads.find(t=>t.latest_run===id);if(t&&!t.messages.some(m=>m.role==='assistant'&&m.run_id===id))t.messages.push({id:crypto.randomUUID(),role:'assistant',run_id:id,text:run.answer,citations})}
    onAgentEvent?.({run_id:id,status:run.status,timeline_item:item})
  },450)
}
onUnmounted(()=>clearInterval(demoTimer))
</script>
<style>
/* 预览复用应用的明暗主题变量，避免脱离主应用时丢失文字与表单颜色。 */
:root{--app-surface-bg:#fff;--app-surface-soft:#f7f7f7;--app-border:#e7e7e7;--app-text-primary:#191919;--app-text-secondary:#5f5f5f}
html[data-theme=dark]{--app-surface-bg:#242424;--app-surface-soft:#2e2e2e;--app-border:#373737;--app-text-primary:#f5f5f5;--app-text-secondary:#c7c7c7;color-scheme:dark}

*{box-sizing:border-box}body{margin:0;background:#f3f6f8;font-family:'Microsoft YaHei','PingFang SC',sans-serif;color:#20272f}button{font:inherit;cursor:pointer}h1,h2,h3,h4,p,ol,ul{margin:0}button{border:0}ol{list-style:decimal}ul{list-style:disc}.preview-toolbar{height:56px;display:flex;align-items:center;gap:12px;padding:0 24px;font-size:13px}.preview-toolbar button{color:#25352d;padding:6px 12px;background:white;border:1px solid #ddd;border-radius:6px}.preview-toolbar span{color:#7b8490;font-size:12px;margin-left:auto}.preview-stage{position:relative;display:flex;width:min(1060px,calc(100vw - 48px));margin:0 auto;background:#fff;border:1px solid #e7e9ed;overflow:hidden}.preview-chat{flex:1;padding:32px;background:#f7f8fa;color:#7b8490}.preview-chat h2{font-size:18px;color:#25352d;margin-bottom:16px}.preview-chat p{margin:14px 0}.preview-note{text-align:center;font-size:12px;margin:16px;color:#7b8490}html[data-theme=dark] body{background:#191d20;color:#e0e6e8}html[data-theme=dark] .preview-stage{background:#222629;color:#e0e6e8}html[data-theme=dark] .preview-chat{background:#202426}
</style>
