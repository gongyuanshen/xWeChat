<template>
  <dialog ref="dialog" class="echo-detail" aria-labelledby="echo-detail-title" @cancel.prevent="emit('close')" @keydown.stop @keydown.esc.prevent="emit('close')" @click="onBackdropClick">
    <div class="echo-detail-shell">
      <header class="echo-detail-header">
        <div><h2 id="echo-detail-title">{{ title }}</h2><p>{{ scopeText }}</p></div>
        <button type="button" class="echo-detail-close" aria-label="关闭来源详情" autofocus @click="emit('close')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </header>
      <div ref="body" class="echo-detail-body" :aria-busy="detail.status === 'loading'">
        <div v-if="detail.status === 'loading'" class="echo-detail-notice" role="status">{{ hasSummary ? '正在载入更多消息，已载入内容保留。' : '正在查询所选年度的真实记录…' }}</div>
        <div v-if="detail.status === 'error'" class="echo-detail-error" role="alert"><p>{{ privacy ? '来源查询失败，请关闭匿名后查看详细原因。' : detail.error }}</p><button type="button" data-retry @click="emit('retry')">重试查询</button></div>
        <div v-if="detail.status === 'building'" class="echo-detail-building" role="status">
          <h3>年度消息索引正在构建</h3><p>完整索引就绪后才能读取来源详情。可手动刷新查看进度。</p>
          <template v-if="build">
            <dl class="echo-detail-stats"><div><dt>已索引消息</dt><dd>{{ number(build.indexedMessages) }}</dd></div><div><dt>已读取消息</dt><dd>{{ number(build.fetchedMessages) }}</dd></div><div><dt>已完成会话</dt><dd>{{ number(build.completedConversations) }} / {{ number(build.totalConversations) }}</dd></div></dl>
            <progress v-if="build.totalConversations > 0" :value="build.completedConversations" :max="build.totalConversations" aria-label="索引会话进度" />
          </template>
          <button type="button" data-retry @click="emit('retry')">刷新索引进度</button>
        </div>
        <template v-if="hasSummary">
          <p v-if="privacy" class="echo-detail-privacy">匿名模式已隐藏人物与正文。来源定位将在关闭匿名后可用。</p>
          <p v-if="detail.query.kind === 'phrase' && !privacy" class="echo-detail-phrase">完整短句：<q>{{ detail.query.value }}</q></p>
          <dl class="echo-detail-stats">
            <div data-stat="messageCount"><dt>{{ detail.query.kind === 'emoji' ? '含此表情的消息' : outgoingOnly ? '本人发送消息' : '双方消息' }}</dt><dd>{{ number(data.summary.messageCount) }}<small>条</small></dd></div>
            <div v-if="!outgoingOnly" data-stat="sent"><dt>本人发送</dt><dd>{{ number(data.summary.sent) }}<small>条</small></dd></div>
            <div v-if="!outgoingOnly" data-stat="received"><dt>收到消息</dt><dd>{{ number(data.summary.received) }}<small>条</small></dd></div>
            <div v-if="detail.query.kind === 'emoji'" data-stat="occurrenceCount"><dt>表情出现次数</dt><dd>{{ number(data.summary.occurrenceCount) }}<small>次</small></dd></div>
            <div v-if="detail.query.kind !== 'contact'"><dt>涉及会话</dt><dd>{{ number(data.summary.conversationCount) }}<small>个</small></dd></div>
          </dl>
          <p v-if="detail.query.kind === 'emoji'" class="echo-detail-note">一条消息可包含多次文字表情或 Emoji；图片表情每条记一次。</p>

          <section v-if="detail.query.kind === 'day'" class="echo-detail-section">
            <h3>这一天的会话</h3>
            <p v-if="data.summary.conversations.length === 0" class="echo-detail-note">没有符合所选日期口径的会话。</p>
            <ul v-else class="echo-conversations"><li v-for="(conversation, index) in data.summary.conversations" :key="index" data-conversation><strong>{{ privacy ? `会话 ${index + 1} · 人物已隐藏` : conversation.displayName }}</strong><span>本人发送 {{ number(conversation.sent) }} · 收到 {{ number(conversation.received) }} · 共 {{ number(conversation.messageCount) }} 条</span></li></ul>
          </section>

          <section v-if="detail.query.kind === 'contact'" class="echo-detail-section">
            <div class="echo-section-heading"><h3>双向回复</h3><div class="echo-reply-direction" aria-label="回复方向"><button type="button" data-direction="me" :aria-pressed="direction === 'me'" @click="direction = 'me'">我回复对方</button><button type="button" data-direction="them" :aria-pressed="direction === 'them'" @click="direction = 'them'">对方回复我</button></div></div>
            <p class="echo-detail-note">{{ data.summary.replyRule }}。P50 / P90 表示此方向 50% / 90% 的回复间隔不超过该值。</p>
            <dl class="echo-reply-stats"><div><dt>{{ detail.query.month ? '所选月份此方向样本' : '全年此方向样本' }}</dt><dd>{{ number(reply.count) }} 次</dd></div><div data-reply-percentile="p50"><dt>P50 · 中位数</dt><dd>{{ duration(reply.p50Seconds) }}</dd></div><div data-reply-percentile="p90"><dt>P90</dt><dd>{{ duration(reply.p90Seconds) }}</dd></div></dl>
            <ul class="echo-reply-buckets"><li v-for="bucket in reply.buckets" :key="bucket.key" data-reply-bucket><span>{{ bucket.label }}</span><strong>{{ number(bucket.count) }} 次</strong><div class="echo-bucket-track" aria-hidden="true"><span :style="{ width: `${reply.count ? bucket.count / reply.count * 100 : 0}%` }" /></div></li></ul>
            <h4>已载入的真实回复对 <small>{{ pairs.length }} / {{ number(reply.count) }} 对</small></h4>
            <p class="echo-detail-note">回复对随消息分页载入：包含其回复消息位于已载入页面的记录。下方“载入更多消息”会继续补充。</p>
            <p v-if="pairs.length === 0" class="echo-detail-note">{{ reply.count === 0 ? '此方向没有符合规则的回复样本。' : '已载入消息页中尚无此方向回复对。' }}</p>
            <ol v-else class="echo-reply-pairs"><li v-for="(pair, pairIndex) in pairs" :key="pairIndex" data-reply-pair>
              <div class="echo-pair-heading"><strong>{{ direction === 'me' ? '我回复对方' : '对方回复我' }}</strong><span>间隔 {{ duration(pair.seconds) }}</span></div>
              <div v-for="(message, messageIndex) in [pair.from, pair.to]" :key="messageIndex" class="echo-pair-message">
                <div class="echo-message-meta"><span>{{ messageIndex === 0 ? '来信' : '回复' }} · {{ message.isSent ? '本人发出' : '对方发出' }}</span><time :datetime="isoTime(message.timestamp)">{{ time(message.timestamp) }}</time></div>
                <p class="echo-message-text">{{ privacy ? '正文已隐藏' : message.text }}</p>
                <button type="button" data-source :disabled="privacy" @click="openSource(message)">定位这条原消息</button>
              </div>
            </li></ol>
          </section>

          <section class="echo-detail-section">
            <div class="echo-section-heading"><h3>消息记录</h3><span class="echo-count">已载入 {{ number(data.items.length) }} / {{ number(data.total) }} 条</span></div>
            <p v-if="data.total === 0" class="echo-detail-empty" data-empty>查询完成：此范围内有 0 条符合条件的消息。</p>
            <ol v-else class="echo-message-list"><li v-for="(item, index) in data.items" :key="index" data-message>
              <div class="echo-message-meta"><span><b>{{ item.isSent ? '本人发送' : '收到' }}</b><template v-if="!privacy"> · {{ item.displayName }}</template><template v-else> · 人物已隐藏</template></span><time :datetime="isoTime(item.timestamp)">{{ time(item.timestamp) }}</time></div>
              <p class="echo-message-text">{{ privacy ? '正文已隐藏' : item.text }}</p>
              <button type="button" data-source :disabled="privacy" @click="openSource(item)">定位原消息</button>
            </li></ol>
            <button v-if="data.hasMore" type="button" class="echo-more" data-more :disabled="detail.status !== 'ok'" @click="emit('more')">{{ detail.status === 'loading' ? '正在载入更多…' : '载入更多消息与来源' }}</button>
          </section>
        </template>
      </div>
      <footer class="echo-detail-footer">显示本地记录及其统计口径。回复间隔不代表在线状态、真实阅读时间或亲密程度。</footer>
    </div>
  </dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { echoDuration as duration, echoNumber as number } from '~/lib/wrapped-echo-model.js'

const props = defineProps({ detail: { type: Object, required: true }, title: { type: String, required: true }, privacy: { type: Boolean, default: true } })
const emit = defineEmits(['close', 'retry', 'more', 'source'])
const dialog = ref(null), body = ref(null), direction = ref('me')
const data = computed(() => props.detail.data)
const hasSummary = computed(() => props.detail.status !== 'building' && !!data.value?.summary)
const build = computed(() => data.value?.index?.build)
const outgoingOnly = computed(() => ['hour', 'phrase', 'emoji'].includes(props.detail.query.kind))
const reply = computed(() => data.value.summary.reply[direction.value])
const pairs = computed(() => data.value.replyPairs.filter(pair => pair.direction === direction.value))
const scopeText = computed(() => {
  const kind = props.detail.query.kind
  const month = props.detail.query.month ? `${props.detail.query.month} 月 · ` : ''
  if (kind === 'day') return '所选日期 · 按会话核对本人发送与收到的消息'
  if (kind === 'contact') return `${month}普通单聊 · 双方消息与双向回复间隔`
  if (kind === 'night') return '普通微信单聊 · 00:00–05:59 的双方消息'
  if (kind === 'phrase') return `${month}仅统计本人发送的 2–20 字完整短消息，按整条文本匹配。`
  if (kind === 'emoji') return '仅统计本人发送 · 区分出现次数与消息条数'
  const period = props.detail.query.period
  return `仅统计本人发送 · ${period === 'weekday' ? '工作日' : period === 'weekend' ? '周末' : '全年'}所选小时内的消息`
})
const formatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const time = timestamp => formatter.format(new Date(timestamp * 1000))
const isoTime = timestamp => new Date(timestamp * 1000).toISOString()
function openSource(item) { if (!props.privacy) emit('source', item) }
function onBackdropClick(event) {
  if (event.target !== dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) emit('close')
}
watch(() => `${props.detail.query.kind}|${props.detail.query.value}|${props.detail.query.period}|${props.detail.query.month}`, () => { direction.value = 'me'; if (body.value) body.value.scrollTop = 0 })
let opener
onMounted(() => { opener = document.activeElement; dialog.value.showModal() })
onBeforeUnmount(() => { dialog.value.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }) })
</script>

<style scoped>
.echo-detail{--detail-ink:#dce9db;--detail-sub:#aec5bc;--detail-line:#385b5b;box-sizing:border-box;width:min(800px,calc(100vw - 40px));max-width:none;max-height:calc(100dvh - 40px);margin:auto;padding:0;border:0;border-radius:12px;background:#193c42;color:var(--detail-ink);box-shadow:0 22px 70px rgba(5,22,26,.38);font:14px/1.65 'Microsoft YaHei','PingFang SC',sans-serif;overflow:hidden}
.echo-detail::backdrop{background:rgba(8,24,30,.74)}.echo-detail *{box-sizing:border-box}.echo-detail-shell{display:flex;flex-direction:column;max-height:calc(100dvh - 40px)}.echo-detail-header{display:flex;align-items:flex-start;justify-content:space-between;gap:22px;padding:25px 28px 20px;border-bottom:1px solid var(--detail-line)}h2{font-size:25px;line-height:1.4;font-weight:600;overflow-wrap:anywhere;margin:0}.echo-detail-header p{color:var(--detail-sub);font-size:12px;line-height:1.65;margin:8px 0 0}.echo-detail-close{display:grid;place-items:center;width:36px;height:36px;flex:none}.echo-detail-close svg{width:20px;height:20px;stroke:currentColor;stroke-width:1.6;fill:none}.echo-detail-body{padding:0 28px 26px;overflow-y:auto;min-height:0;scrollbar-color:#638a80 #193c42}.echo-detail-footer{padding:13px 28px 16px;border-top:1px solid var(--detail-line);font-size:11px;color:var(--detail-sub)}button{font:inherit;cursor:pointer;border:1px solid #668c7e;border-radius:5px;background:transparent;color:var(--detail-ink);padding:7px 11px}button:hover:not(:disabled){background:#31544f}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:3px solid #e8bd84;outline-offset:3px}::selection{background:#638777;color:#fff7df}.echo-detail-close{padding:0;border:0}.echo-detail-close:hover{background:#31544f}
.echo-detail-notice,.echo-detail-privacy{background:#284b4c;border-radius:4px;padding:11px 14px;font-size:12px;color:#c2d6c9;margin:20px 0}.echo-detail-error{background:#5e3932;color:#ffe0cd;border-radius:5px;padding:14px 16px;margin:20px 0}.echo-detail-error p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 12px}.echo-detail-error button{color:#ffe0cd;border-color:#be917e}.echo-detail-building{padding:22px 0}.echo-detail-building p{color:var(--detail-sub);font-size:13px}.echo-detail-building progress{display:block;width:100%;height:7px;margin:20px 0;accent-color:#c7deaa}.echo-detail-phrase{overflow-wrap:anywhere;white-space:pre-wrap;font-size:15px;padding:18px 0;margin:0}.echo-detail-phrase q{color:#efdfb0}
.echo-detail-stats,.echo-reply-stats{display:flex;flex-wrap:wrap;gap:18px 26px;margin:24px 0 18px}.echo-detail-stats>div{flex:1;min-width:115px}.echo-detail-stats dt,.echo-reply-stats dt{font-size:12px;color:var(--detail-sub)}dd{margin:3px 0 0;font-variant-numeric:tabular-nums}.echo-detail-stats dd{font-size:25px;line-height:1.4;color:#f1e9cc}.echo-detail-stats small{font-size:12px;margin-left:5px;color:var(--detail-sub)}.echo-detail-note{font-size:12px;line-height:1.75;color:var(--detail-sub);margin:10px 0 18px}.echo-detail-section{margin:26px 0 0;padding:22px 0 0;border-top:1px solid var(--detail-line)}h3{font-size:17px;font-weight:600;line-height:1.5;margin:0}h4{font-size:14px;font-weight:600;margin:24px 0 8px}h4 small{font-size:12px;font-weight:400;color:var(--detail-sub);margin-left:8px}.echo-section-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}.echo-count{font-size:12px;color:var(--detail-sub)}
ul,ol{padding:0;margin:0;list-style:none}.echo-conversations{margin:10px 0}.echo-conversations li{display:flex;flex-wrap:wrap;gap:7px 20px;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--detail-line);overflow-wrap:anywhere}.echo-conversations strong{font-size:13px;font-weight:500}.echo-conversations span{font-size:12px;color:var(--detail-sub);font-variant-numeric:tabular-nums}.echo-reply-direction{display:flex;gap:6px}.echo-reply-direction button{font-size:12px;white-space:nowrap}.echo-reply-direction button[aria-pressed=true]{background:#d9dfbe;color:#244745;border-color:#d9dfbe}.echo-reply-stats{gap:17px;justify-content:space-between}.echo-reply-stats dd{font-size:17px;color:#e9e4c8}.echo-reply-buckets{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.echo-reply-buckets li{font-size:11px;color:var(--detail-sub)}.echo-reply-buckets strong{display:block;font-size:14px;font-weight:500;color:#e4e7cd;margin:4px 0 8px}.echo-bucket-track{height:4px;background:#345756;overflow:hidden}.echo-bucket-track span{display:block;height:100%;background:#d4dab0}
.echo-reply-pairs{display:grid;gap:18px}.echo-reply-pairs>li{padding:0 0 14px;border-bottom:1px solid var(--detail-line)}.echo-pair-heading{display:flex;justify-content:space-between;gap:15px;margin-bottom:10px;font-size:12px;color:#efe4bf}.echo-pair-heading strong{font-weight:500}.echo-pair-message{padding:10px 0 8px}.echo-pair-message+div{margin-top:8px;padding-top:15px;border-top:1px dashed #3d5f5d}.echo-message-meta{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:6px 14px;font-size:11px;color:var(--detail-sub);overflow-wrap:anywhere}.echo-message-meta b{font-weight:500;color:#d9e3cf}.echo-message-meta time{font-variant-numeric:tabular-nums;white-space:nowrap}.echo-message-text{font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0 12px}.echo-pair-message button,.echo-message-list button{font-size:11px;padding:5px 9px}.echo-message-list>li{padding:17px 0;border-bottom:1px solid var(--detail-line)}.echo-more{display:block;width:100%;margin:20px 0 0;padding:11px;font-size:13px}.echo-detail-empty{font-size:13px;padding:24px 0;color:var(--detail-sub)}
@media(max-width:600px){.echo-detail{width:calc(100vw - 16px);max-height:calc(100dvh - 16px);border-radius:8px}.echo-detail-shell{max-height:calc(100dvh - 16px)}.echo-detail-header{padding:19px 18px 16px;gap:10px}h2{font-size:20px}.echo-detail-body{padding:0 18px 20px}.echo-detail-footer{padding:12px 18px 14px}.echo-detail-stats{gap:16px}.echo-detail-stats>div{min-width:90px}.echo-detail-stats dd{font-size:22px}.echo-reply-buckets{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.echo-reply-stats{gap:15px}.echo-reply-stats>div{min-width:85px}.echo-reply-stats dd{font-size:15px}.echo-section-heading{align-items:flex-start}.echo-message-meta time{font-size:10px}}
</style>
