<template>
  <header class="preview-controls"><strong>上下文压缩 · 示例预览</strong><button @click="complete = !complete">{{ complete ? '重新演示压缩' : '完成压缩' }}</button><button @click="failed = !failed">{{ failed ? '恢复示例' : '模拟失败' }}</button><button @click="dark = !dark">{{ dark ? '浅色模式' : '深色模式' }}</button><small>示例数据，不调用模型</small></header>
  <main class="preview-layout">
    <section v-for="width in [440, 320]" :key="width" class="agent-panel preview-panel" :style="{ width: `${width}px` }">
      <header class="agent-header"><strong>AI 助手</strong><span>{{ width }}px</span></header>
      <div class="preview-content"><div class="agent-user"><p>能统计一下他欠了我多少钱吗？</p></div><AgentRun :run="run" :now="now" :view-state="views[width]" /></div>
      <footer class="preview-composer"><p>可以补充要求，例如：只看上周的…</p><div>deepseek-flash <i class="fa-solid fa-circle-stop" aria-hidden="true" /></div></footer>
    </section>
  </main>
</template>
<script setup>
import { computed, reactive, ref, watchEffect } from 'vue'
import AgentRun from '../../components/chat/AgentRun.vue'
const now = Date.now(), complete = ref(false), failed = ref(false), dark = ref(false), views = reactive({ 440: {}, 320: {} })
watchEffect(() => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light' })
const run = computed(() => ({ id: 'compaction-preview', account: 'example', version: 1, status: failed.value ? 'failed' : 'running', stage: complete.value ? '正在继续分析' : '正在整理上下文', segment_started: now / 1000 - 42, stage_started_at: now / 1000, coverage_state: 'not_applicable', can_resume: false, timeline: [
  { id: 'p', seq: 1, kind: 'progress', status: 'completed', text: '我来查借钱和转账相关的记录。' },
  { id: 't', seq: 2, kind: 'tool', status: 'completed', action: 'search_messages', text: '搜索聊天记录', started_at: now / 1000 - 30, finished_at: now / 1000 - 22, query: '借钱、微信转账', result: { returned: 24 } },
  { id: 'p2', seq: 3, kind: 'progress', status: 'completed', text: '已找到借款和部分还款记录，接下来会核对每笔金额及对应日期。' },
  { id: 'context:example', seq: 4, kind: 'notice', input_version: 1, context_job: { id: 'example', before: 832995, after: complete.value ? 273953 : undefined, model_window: 1000000, status: failed.value ? 'failed' : complete.value ? 'completed' : 'running' } },
] }))
</script>
<style>
body { margin:0; background:var(--app-surface-soft,#f5f5f5); color:var(--app-text-primary,#191919); font-family:system-ui,sans-serif; }
.preview-controls { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:20px; font-size:13px; }
.preview-controls button { padding:6px 10px; border:1px solid var(--app-border,#ddd); border-radius:6px; }
.preview-controls small { color:var(--app-text-secondary,#737373); }
.preview-layout { display:flex; align-items:flex-start; gap:32px; padding:8px 24px 32px; }
.preview-layout .preview-panel { position:relative; inset:auto; min-width:0; max-width:100%; height:680px; border:1px solid var(--app-border,#e7e9ed); box-shadow:none; border-radius:8px; overflow:hidden; }
.preview-panel .agent-header { padding:14px 20px; border-bottom:1px solid var(--app-border,#e7e9ed); }
.preview-panel .agent-header span { margin-left:auto; font-size:12px; color:var(--app-text-secondary,#737373); }
.preview-content { padding:20px 24px; flex:1; overflow:auto; }
.preview-composer { margin:12px; padding:12px; border:1px solid var(--app-border,#e7e9ed); border-radius:18px; font-size:12px; color:var(--app-text-secondary,#737373); }
.preview-composer div { display:flex; align-items:center; justify-content:flex-end; gap:12px; margin-top:28px; }
.preview-composer i { font-size:22px; color:var(--app-text-primary,#191919); }
@media(max-width:800px) { .preview-layout { flex-wrap:wrap; padding:12px; } }
</style>
