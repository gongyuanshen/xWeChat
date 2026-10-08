<template>
  <section ref="root" class="echo-experience" :class="{ 'echo-capture': exportMode, 'echo-still': !motion }" :data-scene="scene" aria-label="回声异境年度总结，左右方向键切换空间" tabindex="0" @keydown="navigateKey">
    <EchoWorld :key="worldKey" ref="world" :scene="scene" :year="year" :data="worldData" :selection="worldSelection" :privacy="privacy" :motion="motion" :export-mode="exportMode" @pick="pick" @error="worldFailed" />
    <div class="echo-shade" aria-hidden="true" />
    <div class="echo-ui">
    <header class="echo-brand"><span class="echo-glyph">◌</span><div>回声异境<small>ECHOES / {{ year }}</small></div></header>
    <div class="echo-stamp" aria-hidden="true">ROOM <b>{{ String(scene).padStart(2, '0') }}</b>{{ info.kicker }}</div>

    <main :key="scene" class="echo-copy" data-world-block>
      <p class="echo-eyebrow">{{ String(scene).padStart(2,'0') }} / {{ info.kicker }}</p>
      <template v-if="!ready">
        <h1>{{ info.title }}</h1>
        <div class="echo-state" role="status"><p>{{ pendingMessage }}</p><p v-if="failedCard?.error" class="echo-error" role="alert">{{ privacy ? '统计读取失败。关闭匿名可查看具体原因。' : failedCard.error }}</p><button v-if="canRetry" class="echo-primary" @click="$emit('retry')">重新读取本章</button></div>
      </template>
      <template v-else-if="scene === 0">
        <h1>你曾经，<br>来过这里。</h1>
        <p class="echo-lead">有些日子已经模糊，<br>有些回声，还留在 {{ year }}。</p>
        <p class="echo-caption">十个空间，一段属于你的聊天记忆。</p>
        <div class="echo-actions"><button class="echo-primary" @click="$emit('scene', 1)">推开这扇门 <span>↗</span></button><button class="echo-secondary" @click="openLocal('map')">查看空间地图</button></div>
      </template>
      <template v-else-if="scene === 1">
        <h1>这一天，<br>回声特别响。</h1>
        <template v-if="overview.peakDay"><p class="echo-lead">{{ overview.peakDay.date }} · 全年的收发峰值</p><p class="echo-number">{{ num(overview.peakDay.count) }}<small>条消息</small></p></template>
        <p v-else class="echo-lead">这一年，还没有留下可统计的消息。</p>
        <p class="echo-caption">{{ overview.activeDays }} 个日子里，你与世界交换过消息。</p>
        <div class="echo-actions"><button v-if="overview.peakDay" class="echo-primary" @click="detail('day',overview.peakDay.date)">回到这一天 ↗</button><button class="echo-secondary" @click="openLocal('calendar')">展开全年日历</button></div>
      </template>
      <template v-else-if="scene === 2">
        <h1>那一端，<br>有人接起回声。</h1>
        <p class="echo-lead">每一段往来，都有自己的节奏。</p>
        <label v-if="contacts.length" class="echo-select">接通一位联系人<select v-model.number="selection.contact"><option v-if="selection.contact===-1" :value="-1" disabled>此前选择已不在当前记录，请重新选择</option><option v-for="(person,i) in contacts" :key="person.username" :value="i">{{ personName(person,i) }}</option></select></label>
        <div v-if="contact" class="echo-facts"><div v-if="contact.totalMessages != null"><b>{{ num(contact.totalMessages) }}</b><span>条双方消息</span></div><div v-if="contact.replyCount != null"><b>{{ num(contact.replyCount) }}</b><span>次本人回复样本</span></div></div>
        <p v-else class="echo-caption">{{ contacts.length ? '此前选中的联系人已不在当前记录，请重新选择。' : '没有可展示的单聊往来。' }}</p>
        <p class="echo-caption">分别查看你和对方的回复分布，以及对应的真实消息。</p>
        <button v-if="contact" class="echo-primary" @click="detail('contact',contact.username)">展开双向往来 ↗</button>
      </template>
      <template v-else-if="scene === 3">
        <h1>十二站之后，<br>谁还在身旁。</h1>
        <label class="echo-range">当前站台 <output>{{ String(selection.month).padStart(2,'0') }} / 12</output><input v-model.number="selection.month" type="range" min="1" max="12" aria-label="选择月份"><span>JAN<span>DEC</span></span></label>
        <template v-if="month.winner"><p class="echo-person">{{ personName(month.winner,selection.month-1) }}</p><p class="echo-caption">{{ selection.month }} 月的月度伙伴 · {{ num(month.raw.totalMessages) }} 条双方消息</p><button class="echo-primary" @click="openLocal('month')">展开同行刻度 ↗</button></template>
        <p v-else class="echo-lead">这一站没有满足评选门槛的记录。<br><small>试着前往另一个月份。</small></p>
        <p class="echo-caption">互动量 40% · 回复速度 30% · 活跃天 20% · 时段覆盖 10%</p>
      </template>
      <template v-else-if="scene === 4">
        <h1>水面之下，<br>是未眠的时刻。</h1>
        <div class="echo-tabs" aria-label="发送日期范围"><button v-for="p in periods" :key="p.id" :aria-pressed="selection.period===p.id" @click="selection.period=p.id">{{ p.label }}</button></div>
        <label class="echo-range">发送时段 <output>{{ String(selection.hour).padStart(2,'0') }}:00—{{ String(selection.hour).padStart(2,'0') }}:59</output><input v-model.number="selection.hour" type="range" min="0" max="23" aria-label="选择小时"><span>00:00<span>23:00</span></span></label>
        <p class="echo-number">{{ num(hourValue) }}<small>{{ selection.average ? '条 / 日' : '条本人发送' }}</small></p>
        <label class="echo-check"><input v-model="selection.average" type="checkbox">按对应日历天数显示日均</label>
        <div class="echo-actions"><button class="echo-primary" @click="detail('hour',selection.hour,selection.period)">查看这个时段 ↗</button><button v-if="schedule.nightCompanion?.partner" class="echo-secondary" @click="detail('night',schedule.nightCompanion.partner.username)">深夜往来</button></div>
      </template>
      <template v-else-if="scene === 5">
        <h1>你说过的话，<br>还在空中盘旋。</h1>
        <div class="echo-phrase-filters"><label class="echo-select">月份<select v-model.number="selection.phraseMonth" aria-label="短句月份" @change="selection.phrase=0"><option :value="0">全年</option><option v-for="n in 12" :key="n" :value="n">{{ n }} 月</option></select></label><label class="echo-select">排列<select v-model="selection.phraseOrder" aria-label="短句排序" @change="selection.phrase=0"><option value="frequency">出现次数</option><option value="text">文字顺序</option></select></label></div><label v-if="phrases.length" class="echo-select">选择一句回声<select v-model.number="selection.phrase"><option v-if="selection.phrase===-1" :value="-1" disabled>此前选择已不在当前范围，请重新选择</option><option v-for="(phrase,i) in phrases" :key="phrase.word" :value="i">{{ privacy ? `短句 ${i+1}` : phrase.word }}</option></select></label>
        <p v-if="phrase" class="echo-person echo-quote">{{ privacy ? `短句 ${selection.phrase+1}` : `「${phrase.word}」` }}</p>
        <p class="echo-caption">{{ phrase ? `本人完整发送过 ${num(phrase.count)} 次。` : phrases.length ? '此前选中的短句已不在当前范围，请重新选择。' : '没有找到反复发送的完整短句。' }}<br>仅统计本人 2–20 字的普通短消息。</p>
        <button v-if="phrase" class="echo-primary" @click="detail('phrase',phrase.word,'all',selection.phraseMonth||null)">找回它的上下文 ↗</button>
      </template>
      <template v-else-if="scene === 6">
        <h1>有些心情，<br>会失去重力。</h1>
        <div class="echo-tabs" aria-label="表情类别"><button v-for="kind in emojiKinds" :key="kind.id" :aria-pressed="selection.emojiKind===kind.id" @click="selection.emojiKind=kind.id;selection.emoji=0">{{ kind.label }}</button></div>
        <label v-if="emojis.length" class="echo-select">选择一枚表情<select v-model.number="selection.emoji"><option v-if="selection.emoji===-1" :value="-1" disabled>此前选择已不在当前类别，请重新选择</option><option v-for="(item,i) in emojis" :key="item.key" :value="i">{{ privacy ? `表情 ${i+1}` : item.label }} · {{ num(item.count) }}</option></select></label>
        <div v-if="emoji" class="echo-emoji-fact"><img v-if="!privacy && emoji.url" :src="emoji.url" :alt="emoji.label" @error="mediaFailed"><span v-else class="echo-emoji-symbol">{{ privacy ? '◌' : emoji.emoji || '◈' }}</span><div><b>{{ num(emoji.count) }}</b><span>{{ emoji.unit }}</span></div></div>
        <p v-else class="echo-caption">{{ emojis.length ? '此前选中的表情已不在当前类别，请重新选择。' : '这个类别暂时没有可展示的表情。' }}</p>
        <p class="echo-caption">图片按消息条数，文字表情按出现次数。每一枚都有出处。</p>
        <div class="echo-actions"><button v-if="emoji" class="echo-primary" @click="detail('emoji',emoji.key)">查看这枚表情 ↗</button><button class="echo-secondary" :aria-pressed="selection.gather" @click="selection.gather=!selection.gather">{{ selection.gather ? '释放重力' : '聚拢星群' }}</button></div>
      </template>
      <template v-else-if="scene === 7">
        <h1>安静下来，<br>听见这一年。</h1>
        <div class="echo-tabs" aria-label="表达方式"><button v-for="m in metrics" :key="m.id" :aria-pressed="selection.metric===m.id" @click="selection.metric=m.id">{{ m.label }}</button></div>
        <template v-if="selection.metric==='text'"><p class="echo-number">{{ num(voice.sentChars) }}<small>个发出字符</small></p><p class="echo-caption">还收到 {{ num(voice.receivedChars) }} 个字符。空白符除外，标点也算。</p></template>
        <template v-else-if="selection.metric==='voice'"><p class="echo-number echo-time">{{ duration(voice.voice.sentSeconds) }}</p><p class="echo-caption">{{ num(voice.voice.sentCount) }} 条语音发出 · 收到 {{ duration(voice.voice.receivedSeconds) }}</p></template>
        <template v-else><p class="echo-number echo-time">{{ duration(voice.calls.totalSeconds) }}</p><p class="echo-caption">记录中的通话时长 · {{ num(voice.calls.voiceCount) }} 次语音 / {{ num(voice.calls.videoCount) }} 次视频</p></template>
        <button class="echo-primary" @click="openLocal('voice')">展开声音与文字 ↗</button>
        <p class="echo-caption">场景以数据生成，不会自动播放聊天录音。</p>
      </template>
      <template v-else-if="scene === 8">
        <h1>原来，<br>这就是你的形状。</h1>
        <p class="echo-lead">那些日子、声音和相遇，<br>在这里汇成一颗记忆天体。</p>
        <div class="echo-facts"><div><b>{{ num(overview.totalMessages) }}</b><span>条本人发送</span></div><div><b>{{ overview.activeDays }}</b><span>个收发活跃日</span></div></div>
        <div class="echo-facts"><div><b>{{ num(overview.sentMediaCount) }}</b><span>条图片与视频</span></div><div><b>{{ num(overview.messagesPerDay) }}</b><span>条 / 发送活跃天</span></div></div>
        <div class="echo-actions"><button class="echo-primary" @click="$emit('scene',9)">带走这一年的回声 ↗</button><button class="echo-secondary" @click="openLocal('map')">重访一个空间</button></div>
      </template>
      <template v-else>
        <h1>出口已亮起。<br>回声，归你保管。</h1>
        <p class="echo-lead">留一张可以分享的海报，<br>也为自己保存一份可以慢慢翻阅的档案。</p>
        <div class="echo-actions"><button class="echo-primary" @click="$emit('share')">制作海报与档案 ↗</button><button class="echo-secondary" @click="$emit('scene',0)">再走一遍</button></div>
        <p class="echo-caption">海报可独立分享。离线档案保留章节、搜索与展开阅读。<br>姓名、正文和私人图片由你决定是否带入。</p>
      </template>
      <p v-if="renderError" class="echo-error" role="alert">{{ privacy ? '场景读取失败，请重新加载。关闭匿名可查看具体原因。' : renderError }} <button @click="retryWorld">重新加载场景</button></p>
    </main>

    <aside v-if="ready" class="echo-readout" data-world-block><p class="echo-eyebrow">{{ readout.kicker }}</p><h2>{{ readout.title }}</h2><p>{{ readout.text }}</p><span>{{ privacy ? '匿名浏览已开启' : '仅在本机回看' }}</span></aside>
    <p v-if="!exportMode" class="echo-hint">{{ hint }}</p>
    <nav v-if="!exportMode" class="echo-journey" data-world-block aria-label="年度空间导航"><div class="echo-nav-tools"><button class="echo-map" @click="openLocal('map')">空间地图 ↗</button><button class="echo-reset" @click="world.resetView()">复位视角</button></div><div class="echo-dots"><button v-for="s in scenes" :key="s.id" :aria-label="`${s.id+1} / 10 ${s.title}`" :aria-current="scene===s.id?'page':undefined" @click="$emit('scene',s.id)">{{ String(s.id).padStart(2,'0') }}</button></div><div class="echo-arrows"><button :disabled="scene===0" aria-label="上一个空间" @click="$emit('scene',scene-1)">←</button><span>{{ scene+1 }} / 10</span><button :disabled="scene===9" aria-label="下一个空间" @click="$emit('scene',scene+1)">→</button></div></nav>
    </div>

    <Teleport to="body"><dialog v-if="localPanel" ref="dialog" class="echo-local-dialog" :aria-label="localTitle" @cancel.prevent="closeOverlays"><div class="echo-dialog-top"><p>回声异境 / {{ year }}</p><button aria-label="关闭" @click="closeOverlays">×</button></div><h2>{{ localTitle }}</h2>
      <div v-if="localPanel==='map'" class="echo-map-grid"><button v-for="s in scenes" :key="s.id" @click="closeOverlays();$emit('scene',s.id)"><small>{{ String(s.id).padStart(2,'0') }} / {{ s.kicker }}</small><strong>{{ s.title }}</strong><span>{{ s.id===scene ? '你在这里' : '前往这个空间 ↗' }}</span></button></div>
      <template v-else-if="localPanel==='calendar'"><p>每格为当天收发消息数，点击可查看具体记录。</p><label>月份 <select v-model.number="selection.calendarMonth"><option v-for="n in 12" :key="n" :value="n">{{ n }} 月</option></select></label><div class="echo-calendar-grid"><span v-for="d in ['一','二','三','四','五','六','日']" :key="d">{{ d }}</span><span v-for="n in calendarOffset" :key="`blank-${n}`"/><button v-for="(n,i) in calendar.counts" :key="i" :class="{ 'echo-calendar-peak':dateString(calendar.month,i+1)===overview.peakDay?.date }" :aria-label="`${dateString(calendar.month,i+1)}，${n}条收发消息`" @click="closeOverlays();detail('day',dateString(calendar.month,i+1))"><span>{{ i+1 }}</span><b>{{ num(n) }}</b></button></div><p class="echo-dialog-note">全年 {{ num(totalReceivedAndSent) }} 条收发 · {{ overview.activeDays }} 个活跃日</p></template>
      <template v-else-if="localPanel==='month' && month.winner"><p>{{ privacy ? '本月伙伴' : month.winner.displayName }} · {{ selection.month }} 月</p><dl><div><dt>互动量 · 40%</dt><dd>{{ num(month.raw.totalMessages) }} 条双方消息</dd></div><div><dt>回复速度 · 30%</dt><dd>{{ duration(month.raw.avgReplySeconds) }}</dd></div><div><dt>活跃天 · 20%</dt><dd>{{ month.raw.activeDays }} 天</dd></div><div><dt>时段覆盖 · 10%</dt><dd>{{ month.raw.timeBucketsCount }} 个时段</dd></div><div><dt>综合分数</dt><dd>{{ num(month.winner.score100) }} / 100</dd></div></dl><p class="echo-dialog-note">评选需要至少 8 条双方消息、双方各 3 条、1 次回复样本和 2 个活跃日。分数用来比较该月的记录，不代表关系的价值。</p><button class="echo-dialog-action" @click="closeOverlays();detail('contact',month.winner.username,'all',selection.month)">查看这位伙伴的本月往来 ↗</button></template>
      <template v-else-if="localPanel==='voice'"><dl><div><dt>发出 / 收到字符</dt><dd>{{ num(voice.sentChars) }} / {{ num(voice.receivedChars) }}</dd></div><div><dt>发出语音</dt><dd>{{ voice.voice.sentCount }} 条 · {{ duration(voice.voice.sentSeconds) }}</dd></div><div><dt>收到语音</dt><dd>{{ voice.voice.receivedCount }} 条 · {{ duration(voice.voice.receivedSeconds) }}</dd></div><div><dt>语音 / 视频通话</dt><dd>{{ voice.calls.voiceCount }} / {{ voice.calls.videoCount }} 次</dd></div><div><dt>通话记录总时长</dt><dd>{{ duration(voice.calls.totalSeconds) }}</dd></div><div><dt>接通 / 未接通或取消</dt><dd>{{ voice.calls.connectedCount }} / {{ voice.calls.missedOrCanceledCount }} 次</dd></div></dl><p class="echo-dialog-note">字符来自渲染后的消息文本，去除空白符，包含标点。语音和通话依据单聊记录计算，各自独立；记录时长不等于实际收听时长。</p><template v-if="voice.typedPhrases?.length"><h3>输入短句摘录</h3><p class="echo-dialog-note">从本人发送的中文短句中选取，摘录去除了空格；不代表年度高频排行。</p><div class="echo-typed-phrases"><span v-for="(p,i) in voice.typedPhrases" :key="i">{{ privacy ? `短句 ${i+1} · 内容已隐藏` : p.text }}</span></div><button class="echo-dialog-action" @click="closeOverlays();$emit('scene',5)">去广播厅查看完整短句与来源 ↗</button></template></template>
    </dialog></Teleport>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import EchoWorld from './EchoWorld.vue'
import { ECHO_SCENES, cardData, calendarMonths, echoContacts, echoEmojis, echoNumber, echoDuration, periodDayCount, scheduleHours } from '~/lib/wrapped-echo-model'

const props=defineProps({scene:{type:Number,required:true},year:{type:Number,required:true},cards:{type:Object,required:true},privacy:{type:Boolean,default:true},motion:{type:Boolean,default:true},exportMode:{type:Boolean,default:false},resolveMedia:{type:Function,default:url=>url}})
const emit=defineEmits(['scene','retry','detail','share','error'])
const scenes=ECHO_SCENES, num=echoNumber, duration=echoDuration
const root=ref(null),world=ref(null),worldKey=ref(0),renderError=ref(''),localPanel=ref(''),dialog=ref(null)
let previousFocus=null,selectionRestored=false,pendingTargets=null
const selection=reactive({month:1,calendarMonth:1,hour:0,period:'all',average:false,contact:0,phrase:0,phraseMonth:0,phraseOrder:'frequency',emoji:0,emojiKind:'sticker',metric:'text',gather:false})
const periods=[{id:'all',label:'全年'},{id:'weekday',label:'周一至周五'},{id:'weekend',label:'周末'}]
const emojiKinds=[{id:'sticker',label:'图片表情'},{id:'text',label:'文字表情'},{id:'unicode',label:'Emoji'}]
const metrics=[{id:'text',label:'文字'},{id:'voice',label:'语音'},{id:'call',label:'通话'}]
const info=computed(()=>scenes[props.scene])
const failedCard=computed(()=>info.value.cards.map(id=>props.cards[id]).find(c=>c?.status==='error'))
const ready=computed(()=>info.value.cards.every(id=>props.cards[id]?.status==='ok'))
const canRetry=computed(()=>info.value.cards.some(id=>['building','error'].includes(props.cards[id]?.status)))
const pendingMessage=computed(()=>failedCard.value?'本章读取失败。':canRetry.value?'聊天索引正在准备，完成后可重新读取本章。':'正在寻找这一年的回声…')
const overview=computed(()=>cardData(props.cards,0)),schedule=computed(()=>cardData(props.cards,1)),voice=computed(()=>cardData(props.cards,2))
const contacts=computed(()=>echoContacts(cardData(props.cards,3))),contact=computed(()=>contacts.value[selection.contact])
const month=computed(()=>cardData(props.cards,4)?.months[selection.month-1])
const phrases=computed(()=>{const words=cardData(props.cards,6)?.keywords||[];return words.map(p=>({...p,count:selection.phraseMonth?p.monthlyCounts[selection.phraseMonth-1]:p.count})).filter(p=>p.count>0).sort((a,b)=>selection.phraseOrder==='text'?a.word.localeCompare(b.word,'zh-CN'):b.count-a.count||a.word.localeCompare(b.word,'zh-CN'))}),phrase=computed(()=>phrases.value[selection.phrase])
const emojis=computed(()=>echoEmojis(cardData(props.cards,5),props.resolveMedia).filter(e=>e.kind===selection.emojiKind)),emoji=computed(()=>emojis.value[selection.emoji])
const months=computed(()=>overview.value?calendarMonths(props.year,overview.value.annualHeatmap.dailyCounts):[])
const calendar=computed(()=>months.value[selection.calendarMonth-1])
const calendarOffset=computed(()=>(new Date(Date.UTC(props.year,selection.calendarMonth-1,1)).getUTCDay()+6)%7)
const hours=computed(()=>schedule.value?scheduleHours(schedule.value.matrix,selection.period):[])
const hourValue=computed(()=>hours.value[selection.hour]/(selection.average?periodDayCount(props.year,selection.period):1))
const totalReceivedAndSent=computed(()=>months.value.reduce((s,m)=>s+m.counts.reduce((a,b)=>a+b,0),0))
const contactStart=computed(()=>Math.max(0,Math.floor(selection.contact/3)*3)),phraseStart=computed(()=>Math.max(0,Math.floor(selection.phrase/5)*5)),emojiStart=computed(()=>Math.max(0,Math.floor(selection.emoji/5)*5))
const worldData=computed(()=>({months:months.value,hours:hours.value,contacts:contacts.value.slice(contactStart.value,contactStart.value+3),phrases:phrases.value.slice(phraseStart.value,phraseStart.value+5),emojis:emojis.value.slice(emojiStart.value,emojiStart.value+5)}))
const worldSelection=computed(()=>({month:selection.month,hour:selection.hour,contact:selection.contact-contactStart.value,phrase:selection.phrase-phraseStart.value,emoji:selection.emoji-emojiStart.value,metric:selection.metric,gather:selection.gather}))
const localTitle=computed(()=>({map:'选择一扇门',calendar:'这一年的每一天',month:'月度伙伴的四个刻度',voice:'声音与文字的留痕'}[localPanel.value]))
// Reading points carry stable object identities only in memory, never in DOM or exports.
function applyReadingTargets(){
  if(!pendingTargets)return
  for(const [kind,cardId,items,key] of [['contact',3,contacts.value,'username'],['phrase',6,phrases.value,'word'],['emoji',5,emojis.value,'key']]){
    if(props.cards[cardId]?.status!=='ok'||!(kind in pendingTargets))continue
    const target=pendingTargets[kind]
    if(target!==null)selection[kind]=items.findIndex(item=>item[key]===target)
    delete pendingTargets[kind]
  }
  if(!Object.keys(pendingTargets).length)pendingTargets=null
}
function getSelection(){return {...selection,targets:{contact:pendingTargets?.contact??contact.value?.username??null,phrase:pendingTargets?.phrase??phrase.value?.word??null,emoji:pendingTargets?.emoji??emoji.value?.key??null}}}
function setSelection(value){const {targets,...controls}=value;selectionRestored=true;Object.assign(selection,controls);pendingTargets=targets?{...targets}:null;applyReadingTargets()}
watch(()=>[props.cards[3]?.status,props.cards[6]?.status,props.cards[5]?.status,contacts.value,phrases.value,emojis.value],applyReadingTargets)
function personName(person,index){return props.privacy?`联系人 ${index+1}`:person.displayName}
function dateString(month,day){return `${props.year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`}
function detail(kind,value,period='all',month=null){emit('detail',{kind,value,period,...(month?{month}:{})})}
function pick(kind,value){if(props.exportMode)return;if(kind==='entry')emit('scene',1);else if(kind==='chapter')emit('scene',value);else if(kind==='share')emit('share');else if(kind==='month'){selection.month=value;selection.calendarMonth=value;if(props.scene===1)openLocal('calendar')}else if(kind==='contact')selection.contact=contactStart.value+value;else if(kind==='phrase')selection.phrase=phraseStart.value+value;else if(kind==='emoji')selection.emoji=emojiStart.value+value;else if(kind==='hour')selection.hour=value;else if(kind==='metric')selection.metric=value}
async function openLocal(panel){previousFocus=document.activeElement;localPanel.value=panel;await nextTick();dialog.value.showModal()}
function closeOverlays(){dialog.value?.close();localPanel.value='';previousFocus?.focus();previousFocus=null}
function worldFailed(error){renderError.value=error.message;emit('error',error)}
function mediaFailed(){worldFailed(new Error('这枚表情的图片读取失败，请检查本地媒体后重试。'))}
function retryWorld(){renderError.value='';worldKey.value++}
function navigateKey(event){if(props.exportMode||localPanel.value||event.altKey||event.ctrlKey||event.metaKey||/INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName))return;if(event.key==='ArrowRight'&&props.scene<9){event.preventDefault();emit('scene',props.scene+1)}if(event.key==='ArrowLeft'&&props.scene>0){event.preventDefault();emit('scene',props.scene-1)}}
watch(()=>props.scene,()=>{closeOverlays();renderError.value=''})
watch(()=>overview.value?.peakDay?.date,date=>{if(date)selection.calendarMonth=Number(date.slice(5,7))},{immediate:true})
watch(()=>schedule.value, data=>{if(data&&!selectionRestored){const h=scheduleHours(data.matrix);selection.hour=h.indexOf(Math.max(...h))}},{immediate:true})
watch(()=>props.exportMode,active=>{if(active)closeOverlays()})
watch(()=>props.privacy,()=>{renderError.value=''})
onBeforeUnmount(closeOverlays)
const hint=computed(()=>['门后，藏着这一年的十个空间。','点击空间里的月份，也能打开日历。','点击悬浮电话，切换当前这一组联系人。','拖动月份刻度，或点击站台数字。','点击水面上的钟点，查看那个小时。','点击空中的短句，找回重复的回声。','点击表情看读数，拖动轻推，或让它们聚拢。','切换文字、语音与通话，舞台随之变换。','拖动天体旋转；点击轨道上的章节，重访记忆。','回看留在本机，分享由你选择。'][props.scene])
const readout=computed(()=>{
  const defaults={kicker:'ARCHIVE / LOCAL',title:String(props.year),text:'从一段聊天记录出发，在记忆与梦境之间漫游。'}
  if(!ready.value)return defaults
  if(props.scene===1)return {kicker:'CALENDAR / 365+',title:`${num(totalReceivedAndSent.value)} 条收发`,text:'每一个亮点都是一个真实的日子。零消息的日期也会留在日历里。'}
  if(props.scene===2)return {kicker:'TWO-WAY / REPLIES',title:'等待也有刻度',text:'用中位数、90 分位与分布查看回复速度。消息只描述发生过什么。'}
  if(props.scene===3)return {kicker:'TWELVE PLATFORMS',title:`第 ${selection.month} 站`,text:'回看每个月的同行记录。未达到统计门槛的月份，站台留空。'}
  if(props.scene===4)return {kicker:'00:00—05:59',title:schedule.value.nightCompanion?.partner?(props.privacy?'一位深夜伙伴':schedule.value.nightCompanion.partner.displayName):'夜色很安静',text:'深夜伙伴根据普通单聊的双方消息统计；水面时钟只展示本人发送。'}
  if(props.scene===5)return {kicker:'YOUR WORDS',title:'完整的一句话',text:'保留短消息原句的节奏。不是分词词云，也不是对你的性格判断。'}
  if(props.scene===6)return {kicker:'ORIGINAL EXPRESSIONS',title:`${num(cardData(props.cards,5).sentStickerCount)} 条图片表情`,text:'使用记录中真实的表情素材。匿名浏览时以无内容的轮廓代替。'}
  if(props.scene===7)return {kicker:'NO AUTO PLAY',title:'声音的形状',text:'悬浮字符与光线随统计方式变换。这座剧场可以一直保持安静。'}
  if(props.scene===8)return {kicker:'ALL THESE MOMENTS',title:`${num(totalReceivedAndSent.value)} 条来往`,text:'一个总量无法讲完一年。每一条轨道，都通向更具体的片段。'}
  if(props.scene===9)return {kicker:'YOUR CHOICE',title:'一张海报，一份档案',text:'默认隐藏姓名与正文。保存前可选择章节、画幅和要带走的内容。'}
  return defaults
})
defineExpose({closeOverlays,getSelection,setSelection,getWorldState:()=>world.value?.getState(),async prepareCapture(){if(!ready.value)throw new Error('本章统计尚未就绪');if(renderError.value)throw new Error(renderError.value);await document.fonts.ready;await nextTick();await Promise.all([...root.value.querySelectorAll('img')].map(img=>img.decode()));return world.value.prepareCapture()}})
</script>

<style scoped>
.echo-experience{--ink:#f1eedc;--muted:#c5ccbd;--acid:#deecaa;--line:#dbe7c638;--ui:clamp(13px,1.05cqw,18px);container-type:size;position:relative;height:100%;width:100%;overflow:hidden;background:#080e0b;color:var(--ink);font-family:'Microsoft YaHei',sans-serif;font-size:var(--ui)}
.echo-ui{--ui:clamp(13px,1.05cqw,18px);font-size:var(--ui);pointer-events:none}.echo-copy,.echo-readout,.echo-journey{pointer-events:auto}.echo-experience *{box-sizing:border-box}.echo-shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,#071113e8 0%,#0711139c 33%,#07111300 72%),linear-gradient(0deg,#061016d9,transparent 25%,transparent 86%,#06101699)}
.echo-brand{position:absolute;top:9%;left:6.5%;display:flex;gap:14px;align-items:center;letter-spacing:.24em;font-size:1.12em;pointer-events:none}.echo-glyph{font:2.6em Georgia;color:var(--acid)}.echo-brand small{display:block;font:.56em Consolas,monospace;letter-spacing:.25em;margin-top:6px;color:var(--muted)}.echo-stamp{position:absolute;right:6.2%;top:13%;font:.75em Consolas,monospace;letter-spacing:.18em;line-height:1.9;text-align:right;color:var(--muted);pointer-events:none}.echo-stamp b{display:block;font-size:2.8em;font-weight:400}
.echo-copy{position:absolute;left:7%;top:23%;width:44%;max-height:65%;overflow:auto;scrollbar-width:thin;scrollbar-color:#778673 transparent;padding:0 12px 12px 0;touch-action:pan-y;animation:echo-arrive .65s ease-out both}.echo-eyebrow{font:.75em Consolas,monospace;letter-spacing:.2em;color:var(--acid);margin:0 0 1em}.echo-copy h1{font:400 clamp(34px,4.3cqw,78px)/1.19 'STSong','SimSun',serif;letter-spacing:.025em;margin:.3em 0 .42em;text-wrap:balance}.echo-lead{font-size:1em;line-height:1.9;letter-spacing:.06em;margin:1em 0;color:#e2e5d8}.echo-lead small{font-size:.85em}.echo-caption{font-size:.83em;line-height:1.9;color:var(--muted);margin:1em 0}.echo-number{font:300 clamp(42px,5.6cqw,102px)/1.1 'Bahnschrift',Arial,sans-serif;letter-spacing:-.03em;margin:.34em 0 .12em;font-variant-numeric:tabular-nums}.echo-number small{font:normal var(--ui) 'Microsoft YaHei',sans-serif;letter-spacing:0;margin-left:.8em;color:var(--muted)}.echo-time{font-size:clamp(28px,3.6cqw,64px)}.echo-person{font:400 2em/1.5 'STSong','SimSun',serif;color:var(--acid);margin:.6em 0;overflow-wrap:anywhere}.echo-quote{font-size:1.65em}
.echo-experience button,.echo-experience select{font:inherit;cursor:pointer;color:inherit}.echo-experience button{min-height:2.8em;touch-action:manipulation}.echo-experience button:focus-visible,.echo-experience input:focus-visible,.echo-experience select:focus-visible{outline:2px solid var(--acid);outline-offset:4px}.echo-experience button:disabled{opacity:.3;cursor:default}.echo-actions{display:flex;gap:.7em;flex-wrap:wrap;margin-top:1.5em}.echo-primary,.echo-secondary{border:1px solid var(--line);padding:.9em 1.35em;font-size:.87em!important;display:inline-flex;align-items:center;justify-content:center;gap:2em}.echo-primary{background:var(--acid);color:#19261c!important}.echo-secondary{background:#102524aa;backdrop-filter:blur(8px)}.echo-primary:hover{background:#f0ffcc}.echo-secondary:hover{background:#34433d}.echo-tabs{display:flex;gap:.5em;flex-wrap:wrap;margin:1.2em 0}.echo-tabs button{font-size:.83em;padding:.5em .9em;border:1px solid var(--line);background:#102023c9}.echo-tabs [aria-pressed=true]{border-color:var(--acid);color:var(--acid)}
.echo-phrase-filters{display:flex;gap:1em;max-width:28em}.echo-phrase-filters .echo-select{flex:1;margin-bottom:0}.echo-select{display:flex;flex-direction:column;gap:.6em;font-size:.85em;max-width:28em;margin:1.2em 0}.echo-select select{border:1px solid var(--line);background:#13272b;padding:.65em .8em;width:100%;text-overflow:ellipsis}.echo-range{display:block;max-width:28em;font-size:.84em;margin:1.25em 0}.echo-range output{float:right;color:var(--acid);font-family:Consolas,monospace}.echo-range input{width:100%;display:block;margin:.8em 0;accent-color:var(--acid);cursor:pointer;min-height:1.3em}.echo-range>span{display:flex;justify-content:space-between;font:.8em Consolas,monospace;color:var(--muted)}.echo-check{font-size:.81em;color:var(--muted);display:flex;gap:.6em;align-items:center}.echo-check input{accent-color:var(--acid);width:1.1em;height:1.1em}.echo-facts{display:flex;gap:2.1em;margin:1.15em 0}.echo-facts b{font:300 2.25em 'Bahnschrift',Arial,sans-serif;display:block;font-variant-numeric:tabular-nums}.echo-facts span{display:block;color:var(--muted);font-size:.77em;margin-top:.55em}.echo-emoji-fact{display:flex;gap:1.2em;align-items:center;margin:.8em 0}.echo-emoji-fact img{width:4em;height:4em;object-fit:contain}.echo-emoji-fact b{font:2.4em 'Bahnschrift',sans-serif;display:block}.echo-emoji-fact div>span{font-size:.8em;color:var(--muted)}.echo-emoji-symbol{font-size:3.4em;color:var(--acid)}
.echo-readout{position:absolute;right:6.2%;bottom:18%;width:22%;padding:1.5em;background:#102027b8;backdrop-filter:blur(12px);border-top:1px solid #dce6c888}.echo-readout h2{font:400 1.6em/1.5 'STSong','SimSun',serif;margin:.4em 0;overflow-wrap:anywhere}.echo-readout p:not(.echo-eyebrow){font-size:.81em;line-height:1.9;color:var(--muted)}.echo-readout>span{display:block;border-top:1px solid var(--line);padding-top:1em;margin-top:1.2em;color:var(--acid);font-size:.72em}.echo-hint{position:absolute;right:6.2%;bottom:11%;max-width:38%;font-size:.74em;color:var(--muted);pointer-events:none;text-align:right}.echo-journey{position:absolute;bottom:0;left:0;right:0;height:9%;min-height:52px;padding:0 4%;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--line);background:#07121982;backdrop-filter:blur(8px)}.echo-journey button{background:transparent;border:0;font-size:.8em}.echo-nav-tools{display:flex;gap:1em}.echo-reset{color:var(--muted)!important}.echo-map{color:var(--muted)!important}.echo-dots{display:flex;gap:.4em}.echo-dots button{padding:.4em .6em;font:.82em Consolas,monospace;min-width:2.5em;border-bottom:1px solid transparent}.echo-dots button[aria-current=page]{color:var(--acid);border-bottom-color:var(--acid)}.echo-arrows{display:flex;align-items:center;gap:1em}.echo-arrows button{font-size:1.5em;min-height:1.7em}.echo-arrows span{font:.8em Consolas,monospace}.echo-error{padding:.8em;border-left:2px solid #ffb199;background:#322524;color:#ffcebf;font-size:.84em;line-height:1.7}.echo-error button{background:transparent;border:1px solid #ba8e83;padding:.3em .8em;margin-left:.5em}.echo-state{font-size:1em;line-height:1.8;color:var(--muted)}.echo-capture .echo-phrase-filters,.echo-capture .echo-actions,.echo-capture .echo-tabs,.echo-capture .echo-select,.echo-capture .echo-range input,.echo-capture .echo-check,.echo-capture .echo-copy>button{display:none}.echo-still .echo-copy{animation:none}.echo-capture .echo-copy{overflow:visible;animation:none}@keyframes echo-arrive{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.echo-copy{animation:none}}
@container (max-aspect-ratio: 1.15){.echo-ui{--ui:3.4cqw}.echo-shade{background:linear-gradient(180deg,#071113b0,transparent 26%,#07111350 50%,#071113e6 86%)}.echo-brand{top:3.5%;left:7%;font-size:1.05em}.echo-stamp{right:7%;top:4%;font-size:.6em}.echo-stamp b{font-size:2.3em}.echo-copy{top:17%;width:88%;max-height:65%;padding:0 1% 2% 0}.echo-copy h1{font-size:8.5cqw;line-height:1.23;max-width:90%}.echo-lead{max-width:90%;font-size:1em}.echo-readout{display:none}.echo-number{font-size:12cqw}.echo-time{font-size:8cqw}.echo-caption{font-size:.88em;max-width:94%}.echo-primary,.echo-secondary{font-size:.91em!important}.echo-select,.echo-range{max-width:95%;font-size:.92em}.echo-tabs button{font-size:.85em}.echo-hint{display:none}.echo-journey{height:12%;padding:1% 6%;min-height:0;flex-wrap:wrap;align-content:center;gap:.35em}.echo-map{font-size:.9em!important}.echo-arrows{margin-left:auto}.echo-dots{order:3;width:100%;justify-content:space-between;gap:0}.echo-dots button{min-width:0;min-height:2em;font-size:.86em;padding:.3em .4em}.echo-facts{gap:2em}.echo-person{font-size:1.8em}.echo-emoji-fact img{width:3.6em;height:3.6em}}
@container (min-aspect-ratio: 1.15) and (max-height: 700px){.echo-brand{top:9%}.echo-copy{top:23%;max-height:64%}.echo-copy h1{font-size:5.8cqh}.echo-lead{margin:.6em 0}.echo-caption{margin:.7em 0}.echo-actions{margin-top:.9em}.echo-number{font-size:8cqh}.echo-facts{margin:.8em 0}.echo-range,.echo-select,.echo-tabs{margin:.8em 0}.echo-readout{bottom:17%}.echo-time{font-size:5.5cqh}}
</style>

<style>
.echo-local-dialog{box-sizing:border-box;color:#f1eedc;background:#122126;border:1px solid #61736c;padding:28px;width:min(820px,calc(100vw - 32px));max-height:calc(100dvh - 32px);margin:auto;overflow:auto;font:14px/1.8 'Microsoft YaHei',sans-serif;box-shadow:0 30px 120px #000a;touch-action:pan-y}.echo-local-dialog::backdrop{background:#030a0dcc;backdrop-filter:blur(8px)}.echo-local-dialog button,.echo-local-dialog select{font:inherit;cursor:pointer;color:inherit;min-height:44px}.echo-local-dialog button:focus-visible,.echo-local-dialog select:focus-visible{outline:2px solid #deecaa;outline-offset:3px}.echo-dialog-top{display:flex;justify-content:space-between;align-items:center;color:#c5ccbd;font:11px Consolas,monospace;letter-spacing:.12em}.echo-dialog-top button{border:0;background:none;font:28px Arial;min-width:44px}.echo-local-dialog h2{font:400 34px/1.4 'STSong','SimSun',serif;margin:20px 0}.echo-map-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.echo-map-grid button{border:1px solid #65786b;background:linear-gradient(150deg,#243939,#17252b);padding:20px;text-align:left}.echo-map-grid small{font:10px Consolas,monospace;color:#deecaa}.echo-map-grid strong{display:block;font:400 20px 'STSong','SimSun',serif;margin:16px 0 8px}.echo-map-grid span{font-size:11px;color:#c5ccbd}.echo-local-dialog select{background:#203238;border:1px solid #61736c;margin-left:12px;padding:0 16px}.echo-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin:24px 0;text-align:center}.echo-calendar-grid button{border:1px solid #526d65;background:#203b38;padding:7px 3px;font-size:12px}.echo-calendar-grid button span,.echo-calendar-grid button b{display:block}.echo-calendar-grid button b{font:17px 'Bahnschrift',Arial,sans-serif;margin-top:4px}.echo-calendar-grid .echo-calendar-peak{background:#deecaa;color:#19261c}.echo-local-dialog dl>div{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #dbe7c633;padding:16px 0}.echo-local-dialog dd{margin:0;text-align:right;font-size:17px;color:#deecaa}.echo-local-dialog dt{color:#c5ccbd}.echo-dialog-note{padding:14px;border-left:2px solid #a5bd89;background:#203234;font-size:12px;line-height:1.9;color:#cbd4c4;margin-top:24px}.echo-typed-phrases{display:flex;flex-wrap:wrap;gap:10px}.echo-typed-phrases span{border:1px solid #61736c;padding:8px 14px}.echo-dialog-action{border:1px solid #deecaa;background:#deecaa;color:#19261c!important;padding:10px 20px;margin-top:12px}
@media(max-width:500px){.echo-local-dialog{padding:20px;font-size:13px}.echo-local-dialog h2{font-size:28px}.echo-map-grid{gap:8px}.echo-map-grid button{padding:13px}.echo-map-grid strong{font-size:17px}.echo-map-grid small{font-size:9px}.echo-calendar-grid{gap:4px}.echo-calendar-grid button b{font-size:14px}.echo-local-dialog dd{font-size:15px}}
</style>
