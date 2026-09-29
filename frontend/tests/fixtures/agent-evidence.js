import { createApp, h } from 'vue'
import AgentRun from '../../components/chat/AgentRun.vue'
import '../../assets/css/agent.css'
import '@fortawesome/fontawesome-free/css/all.min.css'

// 仅使用虚构资料验收真实组件，不调用用户账号或模型。
const a='a'.repeat(24), b='b'.repeat(24), c='c'.repeat(24)
const run={id:'preview',status:'completed',elapsed_seconds:8,answer:`聚餐改到周六晚上七点。[[${a}]]`,citations:[
  {source:a,name:'周末活动群',sender:'小林',time:1788840000,text:'周五大家没空，聚餐改到周六晚上七点吧。',match_methods:['keyword','semantic']},
  {source:b,name:'周末活动群',sender:'小陈',time:1788840010,text:'好的，餐厅还是之前那家。',match_methods:['semantic']},
  {source:c,name:'周末活动群',sender:'小林',time:1788840020,text:'这是更早的聊天资料。'},
],answer_context:{status:'completed',sources:[{source:a,text_chars:24},{source:b,text_chars:16}],omitted:1},timeline:[
  {id:'search',seq:1,kind:'tool',text:'搜索聊天记录',action:'search_messages',query:'周末聚餐改到什么时候',status:'completed',started_at:100,finished_at:102,result:{retrieval_mode:'hybrid',returned:2,match_counts:{keyword:1,semantic:2}}},
  {id:'fallback',seq:2,kind:'tool',text:'搜索聊天记录',action:'search_messages',query:'更早的聚餐',status:'partial',started_at:102,finished_at:103,result:{retrieval_mode:'keyword',returned:1,warning:'本地语义索引尚未覆盖所选范围，当前展示关键词结果'}},
]}
document.body.style.cssText='margin:0;background:#f5f7f6;font-family:system-ui;color:#25352d'
createApp({render:()=>h('main',{class:'agent-panel',style:'position:relative;width:min(520px,100%);height:auto;margin:24px auto;padding:20px;box-sizing:border-box;'},[
  h('p',{style:'font-size:12px;color:#68776e'},'交互验收 · 虚构数据'),
  h(AgentRun,{run,now:110000,viewState:{preview:true},onLocate:()=>alert('验收页：正式应用将定位此原消息')})
])}).mount('#app')
