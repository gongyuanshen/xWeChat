<template>
  <header class="progress-preview-controls"><strong>阶段性回复 · 示例预览</strong><button @click="showSubtasks = !showSubtasks">{{ showSubtasks ? '主任务示例' : '子任务示例' }}</button><button @click="complete = !complete">{{ complete ? '查看执行中' : '查看已完成' }}</button><button @click="dark = !dark">{{ dark ? '浅色模式' : '深色模式' }}</button><small>使用示例数据，不调用模型</small></header>
  <main class="progress-preview-layout">
    <section v-for="mode in ['大视图', '窄侧栏']" :key="mode" class="progress-preview-surface agent-panel" :class="{'is-expanded':false}">
      <header class="agent-header"><strong>AI 助手</strong><span>{{ mode }}</span></header>
      <div class="progress-preview-content"><div class="agent-user"><p>最近讨论了哪些重要的事？</p></div><AgentRun :run="run" :now="now" :view-state="views[mode]" :latest="true" :name-for="()=> '文海健9.8'" /></div>
    </section>
  </main>
</template>
<script setup>
import { computed, reactive, ref, watchEffect } from 'vue'
import AgentRun from '../../components/chat/AgentRun.vue'
const showSubtasks = ref(new URLSearchParams(location.search).has('subtasks'))
const metadataPreview = new URLSearchParams(location.search).has('metadata')
const nodesPreview = new URLSearchParams(location.search).has('nodes')
const now = Date.now(), start = now / 1000 - (showSubtasks.value ? 570 : 42)
const complete = ref(!showSubtasks.value && !metadataPreview), dark = ref(false), views = reactive({'大视图':{},'窄侧栏':{}})
watchEffect(() => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'; globalThis.progressPreviewCompleted = complete.value })
const run = computed(() => ({
  id:'progress-preview',version:1,status:complete.value?'completed':'running',segment_started:start,
  stage_started_at:start+35,stage:showSubtasks.value?'执行独立子任务':'正在整理回答',elapsed_seconds:complete.value?42:0,read_count:309,
  subtasks:showSubtasks.value?{total:1,completed:complete.value?1:0,running:complete.value?0:1}:undefined,
  coverage_state:'complete',can_resume:false,timeline:showSubtasks.value?[
    {id:'t1',seq:1,kind:'tool',status:'completed',text:'读取聊天记录',action:'read_messages',started_at:start+2,finished_at:start+15,result:{returned:309}},
    {id:'p1',seq:2,kind:'progress',status:'completed',text:'已读取这段聊天，讨论主要集中在工作安排、电脑配件和约饭。部分安排后面还有变化。',started_at:start+16},
    {id:'task1',seq:3,kind:'tool',status:complete.value?'completed':'running',text:'执行独立子任务',action:'task',started_at:start+60},
  ]:[
    {id:'t1',seq:2,kind:'tool',status:'completed',text:'读取聊天记录',action:'read_messages',started_at:start+2,finished_at:start+15,result:{returned:309}},
    {id:'p2',seq:3,kind:'progress',status:'completed',text:'已经找到 **工作安排、电脑配件和约饭** 三个主要话题。约饭时间有过调整，目前还不能确定哪次安排最终生效。',started_at:start+16},
    {id:'t2',seq:4,kind:'tool',status:'completed',text:'查看约饭的前后文',action:'read_context',started_at:start+18,finished_at:start+35,result:{returned:12}},
    {id:'p3',seq:5,kind:'progress',status:'completed',text:'后续消息确认了调整后的约饭时间，费用也已有处理方式。工作方面提到的打算，目前还没有落实的记录。',started_at:start+36},
  ],
  answer:complete.value?'主要讨论了三件事：\n\n- **工作安排**：聊到了接下来的打算，以及还有哪些事项待确认。\n- **电脑配件**：比较了升级成本，也讨论了继续使用现有配置。\n- **约饭与费用**：更新了碰面安排和费用处理方式。':'',
  citations:[],usage:{calls:4,input_tokens:2400,output_tokens:620},
  // 节点详情使用合成分页数据，核对长列表与窄侧栏中的展开效果。
  ...(nodesPreview ? {
    read_count:1554,elapsed_seconds:212,answer:'最近主要讨论了工作安排、电脑配件和约饭。',
    timeline:[{id:'scope',seq:1,kind:'tool',action:'select_chat_scope',text:'确定查询范围',status:'completed',started_at:start,finished_at:start+7},
      ...[176,174,168,172,174,136,176,174,174,30].map((returned,index)=>({
        id:`read-${index}`,seq:index+2,kind:'tool',action:'read_messages',text:'读取聊天记录',username:'sample',
        status:complete.value || index!==1?'completed':'running',started_at:start+7+index*5,
        ...(complete.value || index!==1?{finished_at:start+12+index*5}:{}),
        start:1789142400,end:1789401600,offset:index*200,result:{returned,has_more:index<9},
      }))],
  } : {}),
  // 复现长状态区的示例，验证折叠后在大视图与窄侧栏中的信息密度。
  ...(metadataPreview ? {
    read_count:1000,source_count:1000,used:{models:8,media:0},
    query_filters:{conversations:['sample']},time_range:{start:0,end:1789352309},
    index_status:{enabled:true,message:'语义索引在后台渐进补齐，基础搜索可立即使用。'},
    analysis:{known:true,analyzed:complete.value?1000:0,complete:complete.value,segments:0,findings:0,coverage:[{username:'sample',read:1000,analyzed:complete.value?1000:0,complete:complete.value}]},
  } : {}),
}))
</script>
<style>
body { margin:0; background:var(--app-surface-soft,#f5f5f5); color:var(--app-text-primary,#191919); font-family:system-ui,sans-serif; }
.progress-preview-controls { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:16px 24px; }
.progress-preview-controls button { border:1px solid var(--app-border,#ddd); border-radius:6px; padding:6px 12px; background:var(--app-surface-bg,#fff); }
.progress-preview-controls small { color:var(--app-text-secondary,#666); }
.progress-preview-layout { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:24px; max-width:1280px; margin:0 auto; padding:0 24px 24px; }
.progress-preview-layout .progress-preview-surface { position:relative; inset:auto; width:100%; height:auto; min-width:0; max-width:none; border:1px solid var(--ag-border); border-radius:8px; overflow:hidden; box-shadow:none; }
.progress-preview-surface > .agent-header { border-bottom:1px solid var(--ag-border); padding:14px 20px; }
.progress-preview-surface .agent-header span { margin-left:auto; color:var(--ag-muted); font-size:12px; }
.progress-preview-content { padding:20px 24px; }
@media(max-width:760px) { .progress-preview-layout { grid-template-columns:1fr; padding:0 12px 12px; } .progress-preview-content { padding:16px; } }
</style>
