<template>
  <section class="ais-model-metadata" aria-label="模型参数">
    <header><AiProviderIcon :provider="metadata.provider_id || 'custom'" /><span><strong>{{ metadata.name || metadata.id }}</strong><small v-if="metadata.provider_name">{{ metadata.provider_name }}</small></span></header>
    <dl>
      <div><dt>上下文</dt><dd>{{ tokens(metadata.limit?.context) }}</dd></div>
      <div><dt>最大输出</dt><dd>{{ tokens(metadata.limit?.output) }}</dd></div>
      <div v-if="metadata.limit?.input"><dt>最大输入</dt><dd>{{ tokens(metadata.limit.input) }}</dd></div>
      <div><dt>输入类型</dt><dd>{{ modalities(metadata.modalities?.input) }}</dd></div>
      <div><dt>输出类型</dt><dd>{{ modalities(metadata.modalities?.output) }}</dd></div>
      <div v-for="field in capabilities" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ boolean(metadata[field.key]) }}</dd></div>
      <div><dt>输入价格 / 百万 tokens</dt><dd>{{ price(metadata.cost?.input) }}</dd></div>
      <div><dt>输出价格 / 百万 tokens</dt><dd>{{ price(metadata.cost?.output) }}</dd></div>
      <div v-if="metadata.cost?.cache_read != null"><dt>缓存读取 / 百万 tokens</dt><dd>{{ price(metadata.cost.cache_read) }}</dd></div>
      <div v-if="metadata.cost?.cache_write != null"><dt>缓存写入 / 百万 tokens</dt><dd>{{ price(metadata.cost.cache_write) }}</dd></div>
      <div v-if="metadata.knowledge"><dt>知识截止</dt><dd>{{ metadata.knowledge }}</dd></div>
      <div v-if="metadata.release_date"><dt>发布日期</dt><dd>{{ metadata.release_date }}</dd></div>
      <div v-if="metadata.last_updated"><dt>资料更新</dt><dd>{{ metadata.last_updated }}</dd></div>
    </dl>
    <p>以上参数仅供参考，手动设置优先生效。实际能力与费用以所用服务为准。</p>
  </section>
</template>
<script setup>
import AiProviderIcon from './AiProviderIcon.vue'
defineProps({ metadata: { type: Object, required: true } })
const capabilities = [{key:'tool_call',label:'工具调用'},{key:'reasoning',label:'推理'},{key:'structured_output',label:'结构化输出'},{key:'temperature',label:'温度参数'},{key:'attachment',label:'附件'},{key:'open_weights',label:'开放权重'}]
const tokens = value => Number.isFinite(value) && value > 0 ? `${value.toLocaleString('zh-CN')} tokens` : '未知'
const boolean = value => value === true ? '支持' : value === false ? '不支持' : '未知'
const price = value => Number.isFinite(value) ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}` : '未知'
const modalities = values => values?.map(value => ({ text:'文本', image:'图片', audio:'音频', video:'视频', pdf:'PDF' }[value] || value)).join('、') || '未知'
</script>
<style scoped>
.ais-model-metadata { margin-top:14px; padding:12px; border:1px solid var(--ais-border); border-radius:8px; background:var(--ais-soft); }
header { display:flex; align-items:center; gap:8px; }
header span { display:flex; flex-direction:column; min-width:0; }
header strong { overflow-wrap:anywhere; font-size:13px; }
header small, dt, p { color:var(--ais-muted); font-size:11px; }
dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0 8px; }
dd { margin:3px 0 0; font-size:12px; overflow-wrap:anywhere; }
p { margin:8px 0 0; line-height:1.5; }
@media(max-width:420px) { dl { grid-template-columns:1fr; } }
</style>
