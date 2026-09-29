<script setup>
import { onMounted, reactive, ref, watchEffect } from 'vue'
import AgentModelPicker from '../../components/chat/AgentModelPicker.vue'
import AgentContextRing from '../../components/chat/AgentContextRing.vue'
const dark = ref(false)
const profiles = [
  { id: 'openai', name: 'OpenAI', model: 'gpt-6-astra', model_metadata: { name: 'GPT-6 Astra', reasoning_controls: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } } },
  { id: 'claude', name: 'Anthropic', model: 'claude-opus-4-6', model_metadata: { name: 'Claude Opus 4.6' } },
  { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-flash', model_metadata: { name: 'DeepSeek V4.1 Flash' } },
]
const choices = reactive({ 440: { profile_id: 'openai', model_id: 'gpt-6-astra', reasoning_effort: 'high' }, 320: { profile_id: 'openai', model_id: 'gpt-6-astra', reasoning_effort: 'high' } })
watchEffect(() => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light' })
onMounted(() => { document.querySelectorAll('.agent-model-menu').forEach(menu => { menu.open = true }) })
</script>
<template>
  <header class="preview-controls"><strong>模型与思考强度 · 示例预览</strong><button @click="dark = !dark">{{ dark ? '浅色模式' : '深色模式' }}</button><small>示例数据，不调用模型</small></header>
  <main class="preview-layout">
    <section v-for="width in [440, 320]" :key="width" class="agent-panel preview-panel" :style="{ width: `${width}px` }">
      <header class="agent-header"><strong>AI 助手</strong><span>{{ width }}px</span></header>
      <div class="preview-conversation"><p>模型和思考强度，放在同一个入口。</p><p>点击浮层中间选择模型，选好后回到滑杆。</p></div>
      <footer class="agent-composer"><div class="agent-input-box"><textarea aria-label="示例问题" placeholder="向当前聊天提问…" rows="1" /><div class="agent-input-actions"><AgentContextRing /><AgentModelPicker v-model="choices[width]" :profiles="profiles" /><button type="button" class="agent-send" aria-label="发送示例问题" disabled><i class="fa-solid fa-arrow-up" /></button></div></div></footer>
    </section>
  </main>
  <output class="preview-state">{{ choices }}</output>
</template>
<style>
body { margin: 0; font-family: system-ui, sans-serif; background: var(--app-surface-soft); color: var(--app-text-primary); }
.preview-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; padding: 20px 24px; font-size: 13px; }
.preview-controls button { border: 1px solid var(--app-border); padding: 6px 10px; border-radius: 6px; }
.preview-controls small { color: var(--app-text-muted); }
.preview-layout { display: flex; gap: 32px; padding: 8px 24px 24px; align-items: flex-start; }
.preview-layout .preview-panel { position: relative; inset: auto; max-width: 100%; height: 620px; min-width: 0; border: 1px solid var(--app-border); border-radius: 10px; }
.preview-panel>.agent-header { padding: 16px 20px; border-bottom: 1px solid var(--app-border); }
.preview-panel>.agent-header span { margin-left: auto; color: var(--app-text-muted); font-size: 12px; }
.preview-conversation { flex: 1; padding: 20px; font-size: 13px; }
.preview-conversation p { margin-bottom: 16px; }
.preview-state { display: block; margin: 0 24px 20px; font-size: 11px; color: var(--app-text-muted); white-space: pre-wrap; }
@media(max-width: 800px) { .preview-layout { flex-wrap: wrap; padding: 12px; gap: 24px; } }
</style>
