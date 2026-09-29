<template>
  <main>
    <section class="fixture-chat">
      <h2>引用交互验证</h2><p>测试数据 · 使用实际回答组件</p>
      <template v-if="pills"><p>头像使用仓库示例图片，编号按实际引用顺序生成。</p><button @click="dark = !dark; applyTheme()">{{ dark ? '浅色' : '深色' }}</button><button @click="narrow = !narrow">{{ narrow ? '440px 侧栏' : '320px 侧栏' }}</button></template>
      <label><input v-model="fail" type="checkbox">模拟定位失败</label>
      <p>预读次数：{{ reads }} · 定位次数：{{ jumps }}</p>
      <article v-if="destination" class="fixture-message"><small>已定位并高亮</small><p>{{ destination.text }}</p></article>
    </section>
    <aside class="agent-panel" :class="{ 'is-expanded': expanded }" :style="pills ? { '--agent-panel-width': narrow ? '320px' : '440px' } : undefined">
      <header class="agent-header"><span class="agent-brand"><i class="fa-solid fa-wand-magic-sparkles"></i></span><strong>AI 助手</strong><button @click="expanded = !expanded" aria-label="切换大视图"><i class="fa-solid fa-expand"></i></button></header>
      <nav class="agent-mode"><button aria-current="page">对话</button><button>工具</button><span>已固定对话</span></nav>
      <div class="agent-context"><div><small>读取范围</small><strong>示例会话</strong></div></div>
      <div class="agent-conversation">
        <div class="agent-user">{{ pills ? '最近讨论了哪些事情？' : '最近提到过几次一起吃饭？' }}</div>
        <AgentAnswer :text="answer" :citations="sources" />
        <div class="agent-coverage-note"><strong>读取范围说明</strong><p>此页面只使用虚构数据验证交互，不读取真实聊天。</p></div>
      </div>
      <footer class="agent-composer"><div class="agent-input-box"><textarea placeholder="问问这段聊天，或描述你想找的内容…" rows="3"></textarea></div><p>回答依据读取到的记录，重要信息可点击出处核对。</p></footer>
    </aside>
  </main>
</template>
<script setup>
import { provide, ref } from 'vue'
import AgentAnswer from '../../components/chat/AgentAnswer.vue'
const expanded = ref(false), fail = ref(false), destination = ref(null), reads = ref(0), jumps = ref(0)
const pills = new URLSearchParams(location.search).has('pills'), dark = ref(false), narrow = ref(false)
const applyTheme = () => { document.documentElement.dataset.theme = dark.value ? 'dark' : 'light' }
const sources = Array.from({length:8}, (_, i) => ({source:(i+1).toString(16).repeat(24),username:'example',name:'示例会话',sender:i%2?'对方':'我',time:1788220800+i*86400,text:i===7?'这周三有空的话，要不要一起去吃火锅？地点稍后确认。\n\n'+Array.from({length:12},()=> '这是一条较长的原文，用来检查滚动时定位按钮是否仍然可见。').join('\n'):'这周找个时间一起吃饭吧，我们周三再确认。',anchor:`message-${i}`}))
if (pills) sources.slice(0, 3).forEach((source, index) => {
  source.sender_avatar_path = '/chat/avatar?acceptance=logo'
  source.text = ['我们最近主要在讨论离职的安排。', '公司方面的意见还需要继续沟通。', '这笔日常费用已经核对过了。'][index]
})
const answer = pills ? '## 总结\n\n最近讨论的核心是离职事宜。[[' + sources[0].source + ']] [[' + sources[1].source + ']]\n\n同时伴有少量的日常财务往来。[[' + sources[2].source + ']]\n\n无头像来源同样可以查看。[[' + sources[3].source + ']]' : '# 一共提到 8 次\n\n下面按话题出现的时间梳理，点击编号就能核对原文。\n\n| 次数 | 时间 | 内容 | 来源 |\n|---|---|---|---|\n'+sources.map((s,i)=>`| ${i+1} | 9 月 ${i+1} 日 | ${i%2?'讨论餐厅与具体时间，暂未最终确认。':'提出一起吃饭，后续继续约时间。'} | [[${s.source}]] |`).join('\n')+'\n\n说明：这里统计的是提到约饭的话题次数，是否成行应结合原消息确认。'
const pending = new Map()
provide('agentSourceNavigation', {
  prepare(source) { if (!pending.has(source.source)) { reads.value++; pending.set(source.source,new Promise(resolve=>setTimeout(resolve,1200))) }; return pending.get(source.source) },
  async locate(source) { jumps.value++; await pending.get(source.source); await new Promise(resolve=>setTimeout(resolve,800)); if(fail.value) throw new Error('连接暂时中断，请重试'); destination.value=source; return true }
})
</script>
<style>
:root { --app-surface-bg:#fff; --app-surface-soft:#f7f7f7; --app-border:#e7e7e7; --app-text-primary:#191919; --app-text-secondary:#5f5f5f; }
html[data-theme=dark] { --app-surface-bg:#242424; --app-surface-soft:#2e2e2e; --app-border:#373737; --app-text-primary:#f5f5f5; --app-text-secondary:#c7c7c7; color-scheme:dark; }
html[data-theme=dark] body { background:#191919; color:#f5f5f5; }
* { box-sizing:border-box; } body { margin:0; font-family:"Microsoft YaHei",sans-serif; color:#25352d; background:#f4f5f7; }
main { display:flex; height:100vh; max-width:1080px; margin:auto; position:relative; }
.fixture-chat { flex:1; padding:32px; min-width:0; } .fixture-chat > p { color:#7b8490; font-size:12px; }
.fixture-message { margin-top:28px; padding:20px; background:#e6f5ed; color:#25352d; border:2px solid #079b57; border-radius:10px; white-space:pre-wrap; max-height:50vh; overflow:auto; }
.agent-panel { height:100%; } .agent-composer textarea { width:100%; padding:12px; border:0; resize:none; font:inherit; } .agent-composer > p { font-size:10px; color:#7b8490; text-align:center; }
@media(max-width:600px) { .fixture-chat { display:none; } main > .agent-panel { width:100%; max-width:none; } }
</style>
