<script setup>
const props = defineProps({ state: { type: Object, required: true }, engine: { type: String, required: true }, compact: Boolean })
defineEmits(['configure'])
const { enabled, loading, saving, error, pending, validScope, batch, setEnabled, retry } = props.state
</script>
<template>
  <div class="recognition-control" :class="{ compact }">
    <button type="button" role="switch" aria-label="意图识别" :aria-checked="enabled" :disabled="(!enabled && loading) || saving || !validScope" :class="{ enabled }" @click="setEnabled(!enabled)"><span class="recognition-switch-track" aria-hidden="true" /><span>意图识别 · {{ saving ? '保存中' : enabled ? '已开启' : '已关闭' }}</span></button>
    <button v-if="compact" type="button" class="recognition-engine" :class="{ 'recognition-engine-api': engine === 'api' }" aria-label="配置意图识别模型" :title="engine === 'api' ? 'API 分析可能产生费用；点击配置模型' : '本地 Laya 分析；点击准备或切换模型'" @click="$emit('configure')">{{ engine === 'api' ? 'API · 可能产生费用' : '本地' }}</button>
    <small v-else-if="engine === 'api'">开启后自动调用 API，可能产生费用。</small>
    <small v-else>本地分析；请先在画像面板准备 Laya 模型。</small>
    <small v-if="!compact">私聊只识别对方文本，群聊只识别其他成员文本；本人消息不参与识别或上下文。翻页和新消息会加入队列；已有结果不重复分析。关闭会停止分析并隐藏自动标签，手动画像标签单独控制。</small>
    <small v-if="!validScope">{{ compact ? '请选择可用模型' : '请在画像面板选择可用模型。' }}</small>
    <p v-if="enabled && !error" role="status">{{ ['queued','running'].includes(batch?.status) ? `${compact ? '已识别' : '本批已识别'} ${batch.progress.analyzed}/${batch.progress.total}` : '识别已开启' }} · 待处理 {{ pending }} 条<template v-if="!compact"><span v-if="batch?.delivery_mode === 'batch'"> · 当前模型整批返回</span><span v-else-if="batch?.delivery_mode === 'stream'"> · 逐条返回</span></template></p>
    <div v-if="error" role="alert" class="recognition-error"><span :title="error">{{ error }}</span><button v-if="enabled" type="button" :disabled="loading || saving" @click="retry">{{ compact ? '重试' : '重试未完成消息' }}</button></div>
  </div>
</template>
<style scoped>
.recognition-control { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; min-width: 0; max-width: 100%; font-size: 12px; }
button { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; border: 1px solid var(--app-border); background: var(--chat-subtle-bg); color: var(--app-text-primary); border-radius: 9px; font: inherit; padding: 6px 9px; white-space: nowrap; }
button:hover:not(:disabled) { border-color: var(--chat-focus-ring); }
button.enabled { color: var(--chat-accent); }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible { outline: 2px solid var(--chat-focus-ring); outline-offset: 2px; }
.recognition-switch-track { position: relative; flex: 0 0 24px; width: 24px; height: 14px; border-radius: 999px; background: var(--app-text-muted); }
.recognition-switch-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--chat-input-bg); }
.enabled .recognition-switch-track { background: var(--chat-accent); }
.enabled .recognition-switch-track::after { left: 12px; }
small, p { color: var(--app-text-secondary); font-size: 11px; margin: 0; overflow-wrap: anywhere; }
.recognition-error { color: #b42318; overflow-wrap: anywhere; max-width: 100%; }
.recognition-error button { margin: 4px 0; color: inherit; background: transparent; }
.compact { flex-direction: row; align-items: center; gap: 5px; white-space: nowrap; }
.compact button { min-height: 28px; padding: 4px 7px; }
.compact .recognition-engine { color: var(--app-text-secondary); border-color: transparent; background: transparent; font-size: 11px; }
.compact .recognition-engine:hover { background: var(--chat-subtle-bg); }
.compact .recognition-engine-api { color: var(--chat-ai-text); background: var(--chat-ai-bg); }
.compact .recognition-error { display: flex; align-items: center; gap: 6px; }
.compact .recognition-error span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.compact .recognition-error button { margin: 0; }
html[data-theme='dark'] .recognition-error { color: #fda29b; }
</style>
