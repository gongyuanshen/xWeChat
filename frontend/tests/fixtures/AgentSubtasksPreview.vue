<template>
  <header class="preview-toolbar"><strong>子任务 · 交互预览</strong><button @click="dark = !dark">{{ dark ? '浅色模式' : '深色模式' }}</button><label>任务状态 <select v-model="status"><option value="running">分析中</option><option value="completed">已完成</option><option value="failed">未完成</option><option value="queued">等待执行</option></select></label><label><input type="checkbox" v-model="multiple">多个子任务</label><small>虚构示例，不连接聊天或模型</small></header>
  <main class="preview-layout">
    <section v-for="size in ['宽面板', '窄侧栏']" :key="size" class="preview-panel">
      <header><strong>聊天分析</strong><span>{{ size }}</span></header>
      <div class="preview-body"><p class="preview-question">帮我整理这段聊天里的费用往来</p><AgentSubtasks :key="status + multiple" :run="run" :now="now * 1000" @locate="located = true"/><p v-if="located" role="status">已定位示例来源：这笔费用周末一起核对。</p></div>
      <footer>可以补充要求，例如：只看上周的记录…</footer>
    </section>
  </main>
</template>
<script setup>
import { computed, ref, watchEffect } from 'vue'
import AgentSubtasks from '../../components/chat/AgentSubtasks.vue'
const dark = ref(false), status = ref('running'), multiple = ref(true), located = ref(false), now = Date.now() / 1000
watchEffect(() => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light' })
const run = computed(() => ({ id:'subtasks-preview', account:'preview', version:2, status:status.value, timezone_offset:28800,
  subtasks:{plan_version:2, phase:status.value === 'completed' ? 'completed' : 'analyzing',
    main_work:'核对当前聊天的最新对账金额，确认借还方向和仍待说明的差额。', parallel_reason:'另外三组证据相互独立，可在主线核对时分别提取事实。',
    scanning:false, total_known:true,
    total:multiple.value ? 3 : 1, running:status.value === 'running' ? (multiple.value ? 3 : 1) : 0, queued:0,
    completed:status.value === 'completed' ? (multiple.value ? 3 : 1) : 0, failed:status.value === 'failed' ? 1 : 0} }))
// 独立验收使用虚构长文本，所有请求都在本地返回，不读取真实账号。
globalThis.useApiBase = () => '/preview-api'
globalThis.$fetch = async path => {
  if (path.endsWith('/materials/sample-source')) return { text:'这笔费用周末一起核对。', source:'sample-source' }
  if (path.endsWith('/subtasks/child-0')) return { items:[{text:'费用的最终分摊方式仍待确认。', sources:['sample-source']}], has_more:false }
  if (!path.endsWith('/subtasks')) throw new Error('此操作没有预览数据')
  return {items:Array.from({length:multiple.value ? 3 : 1}, (_, index) => ({
    id:`child-${index}`, plan_version:2, time_range:{start:now-86400*(index+2), end:now-86400*index},
    name:['旅行讨论群 · 核对垫付款', '活动群 · 核对退款', '购物讨论群 · 提取费用变更'][index], status:status.value,
    started_at:now-39, finished_at:status.value === 'completed' ? now : null,
    current_action:'提取局部事实', action_started_at:now-9,
    coverage:{read:864, analyzed:status.value === 'completed' ? 864 : index === 2 ? 0 : 693, complete:status.value === 'completed'},
    latest_progress:index === 2 && status.value === 'running' ? null : {text:'第一页已读完，这段时间主要是日常聊天，暂未发现费用往来的内容。正在继续核对后续消息，确认是否有转账、垫付或退款。\n后续会结合前后文判断每笔款项的方向，并保留可以核对的消息来源。\n对于无法确定付款方向的记录，会明确标记为待确认，不纳入已确认的金额。'},
    objective:['核对旅行群中垫付与分摊的约定，保留付款方向和未确认事项。', '从活动群已定位资料中提取退款承诺、取消条件及执行证据。', '梳理购物群的费用调整，仅提取有来源支持的变化。'][index],
    expected_output:'局部事实、消息来源及未确认关系', original_goal:'帮我整理这段聊天里的费用往来',
    activity:[{id:'1', kind:'tool', text:'读取这段聊天的前一页消息', status:'completed'}, {id:'2', kind:'progress', text:'已核对前一页内容，继续查看后续的费用讨论。'}, {id:'3', kind:'tool', text:'保存已确认的分析发现', status:'completed'}],
    error:status.value === 'failed' ? '本轮分析中断，已保留当前进展。' : '',
    usage:{calls:4, input_tokens:5200, output_tokens:710}, result_handle:index === 0 ? 'sample-result' : null,
  })), has_more:false }
}
</script>
<style>
body { margin:0; background:var(--app-surface-soft); color:var(--app-text-primary); font-family:system-ui,sans-serif; }
.preview-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:16px; padding:20px 24px; font-size:13px; }
.preview-toolbar button, .preview-toolbar select { border:1px solid var(--app-border); background:var(--app-surface-bg); color:var(--app-text-primary); border-radius:6px; padding:6px 10px; cursor:pointer; }
.preview-toolbar small { color:var(--app-text-secondary); }
.preview-layout { display:grid; grid-template-columns:minmax(0, 1fr) 360px; gap:28px; max-width:1000px; margin:0 auto; padding:8px 24px 32px; }
.preview-panel { min-width:0; background:var(--app-surface-bg); border:1px solid var(--app-border); border-radius:12px; overflow:hidden; align-self:start; }
.preview-panel > header { display:flex; justify-content:space-between; padding:18px 20px; border-bottom:1px solid var(--app-border); font-size:14px; }
.preview-panel > header span { color:var(--app-text-secondary); font-size:12px; }
.preview-body { padding:20px; }
.preview-question { margin:0 0 24px auto; padding:10px 14px; width:fit-content; max-width:100%; background:var(--app-surface-soft); border-radius:12px; font-size:13px; }
.preview-panel > footer { padding:18px 20px; border-top:1px solid var(--app-border); color:var(--app-text-secondary); font-size:12px; }
@media(max-width:760px) { .preview-layout { grid-template-columns:minmax(0,1fr); padding:0 12px 24px; } .preview-body { padding:16px; } }
</style>
