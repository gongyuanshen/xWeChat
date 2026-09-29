<template>
  <div class="qa-toolbar">交互验收 · 虚构数据<button @click="dark=!dark">切换深浅色</button><button @click="narrow=!narrow">切换窄窗口</button><select v-if="progressPreview" aria-label="整理状态" :value="progressPreview" @change="changeProgress"><option value="running">整理中</option><option value="initial">首次整理</option><option value="paused">已暂停</option><option value="error">失败</option><option value="done">已完成</option></select></div>
  <main :class="{dark,narrow,'progress-preview':progressPreview}">
    <aside v-if="!progressPreview"><strong><i class="fa-solid fa-gear"></i> 设置</strong><span>桌面行为</span><span class="selected">AI 服务</span><span>语音转文字</span><span>MCP 接入</span><span>数据库与密钥</span><span>启动偏好</span><span>聊天与媒体</span></aside>
    <div class="qa-content"><header>AI 服务</header><div class="qa-scroll"><LocalSearchSettings v-if="progressPreview" account-wide /><AiSettings v-else /></div></div>
  </main>
</template>
<script setup>
import { ref, watch } from 'vue'
import AiSettings from '../../components/AiSettings.vue'
const dark=ref(false),narrow=ref(false)
const progressPreview=new URLSearchParams(location.search).get('progress')
function changeProgress(event){location.search=`?progress=${event.target.value}`}
watch(dark,value=>{document.documentElement.dataset.theme=value?'dark':'light'})
</script>
<style>
*{box-sizing:border-box}body{margin:0;font-family:"Microsoft YaHei",sans-serif;background:#8d9190;font-size:12px}
.qa-toolbar{height:32px;display:flex;align-items:center;justify-content:center;gap:14px;color:white;font-size:11px}
.qa-toolbar button{font:inherit;padding:2px 7px}
main{--app-surface-bg:#fff;--app-surface-soft:#f7f7f7;--app-text-primary:#191919;--app-text-secondary:#5f5f5f;--app-text-muted:#909090;--app-border:#e7e7e7;--app-accent:#079b57;display:flex;width:min(1100px,94vw);height:90vh;margin:0 auto;border-radius:12px;overflow:hidden;background:var(--app-surface-bg);color:var(--app-text-primary);box-shadow:0 20px 55px #0003}
body:has(main.dark),main.dark{--app-surface-bg:#242424;--app-surface-soft:#2b2b2b;--app-text-primary:#f5f5f5;--app-text-secondary:#b8b8b8;--app-text-muted:#a0a0a0;--app-border:#3e3e3e;--app-accent-soft:#193c2c}
main.narrow{width:700px;max-width:94vw}
main.progress-preview{width:min(1000px,94vw)}main.progress-preview.narrow{width:480px}.progress-preview .qa-scroll{container-type:inline-size}
aside{width:160px;flex-shrink:0;border-right:1px solid var(--app-border);padding:20px 12px;background:var(--app-surface-soft)}
aside strong{display:block;margin:0 8px 24px;font-size:16px}aside strong i{color:#079b57;margin-right:8px}
aside span{display:block;padding:9px 12px;margin-bottom:4px;color:var(--app-text-secondary)}
aside span.selected{background:var(--app-surface-bg);border:1px solid var(--app-border);border-radius:7px;color:var(--app-text-primary)}
.qa-content{flex:1;min-width:0;display:flex;flex-direction:column}.qa-content>header{height:48px;padding:15px 24px;font-weight:600;flex-shrink:0}
.qa-scroll{overflow:auto;padding:12px 24px 24px;scrollbar-gutter:stable}
.ui-select{display:inline-flex;min-width:0;width:100%}.ui-select-trigger{width:100%;justify-content:space-between!important;text-align:left;gap:12px}
.ui-select-trigger>span{overflow:hidden;text-overflow:ellipsis}
.ui-select-menu{position:fixed;z-index:30000;overflow:auto;background:var(--app-surface-bg,#fff);color:var(--app-text-primary,#191919);border:1px solid #ddd;border-radius:8px;padding:5px;box-shadow:0 6px 25px #0002;font-size:12px}
.ui-select-option{display:flex;justify-content:space-between;padding:8px;border-radius:5px;cursor:pointer}.ui-select-option.is-active,.ui-select-option.is-selected{background:#edf8f1;color:#079b57}
.ui-select-option-copy{display:flex;flex-direction:column}.ui-select-option small{font-size:10px}
</style>
