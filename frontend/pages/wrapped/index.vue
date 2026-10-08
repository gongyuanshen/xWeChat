<template>
  <WrappedStage shell-bg="#080e10">
    <main ref="deckEl" class="echo-page-stage" aria-label="回声异境年度总结">
      <EchoExperience
        v-if="currentReport"
        :key="experienceRevision"
        ref="experienceEl"
        :scene="activeIndex"
        :year="report.state.meta.year"
        :cards="report.state.cards"
        :privacy="privacyMode"
        :motion="motion && !report.state.detail && !shareDocument && !exporting"
        :export-mode="exportMode"
        :resolve-media="resolveMedia"
        @scene="goTo"
        @retry="retryScene"
        @detail="openDetail"
        @share="openShare"
        @error="showFailure"
      />
      <div v-else class="echo-page-empty" role="status">
        <h1>回声异境</h1>
        <p>{{ !accountSyncReady || accountsLoading || loading ? '正在读取这一年的目录…' : accounts.length ? '选择一个年份，重新走过留下的回声。' : '尚无可用账号，请先导入或解密聊天记录。' }}</p>
        <button v-if="noticeMessage && accounts.length" type="button" @click="reload(false, true)">重新读取年度目录</button>
      </div>
    </main>
    <template #chrome>
      <header v-show="!exporting" class="echo-page-toolbar" data-world-block @keydown.stop>
        <div class="echo-page-toolbar-group">
          <button type="button" class="echo-page-icon" aria-label="返回上一级" title="返回" @click="goBack"><ArrowLeft :size="17" /></button>
          <button type="button" class="echo-page-icon" aria-label="刷新年度统计" title="刷新年度统计" :disabled="loading || accountsLoading || !accounts.length" @click="reload(true, true)"><RefreshCw :size="16" :class="{ 'echo-page-spin': loading }" /></button>
          <label v-if="accounts.length" class="echo-page-account"><span class="sr-only">年度总结账号</span><select :value="accounts.indexOf(account)" aria-label="年度总结账号" :disabled="accountsLoading || loading" @change="selectPageAccount(Number($event.target.value))"><option v-for="(item, index) in accounts" :key="index" :value="index">{{ privacyMode ? `账号 ${index + 1}` : item }}</option></select></label>
        </div>
        <div class="echo-page-toolbar-group">
          <button type="button" class="echo-page-icon" :aria-label="privacyMode ? '关闭匿名模式' : '开启匿名模式'" :title="privacyMode ? '匿名模式已开启' : '开启匿名模式'" :aria-pressed="privacyMode" @click="privacyStore.toggle"><EyeOff v-if="privacyMode" :size="17" /><Eye v-else :size="17" /></button>
          <button type="button" class="echo-page-icon" :aria-label="motion ? '暂停动效' : '启用动效'" :title="motion ? '暂停动效' : '启用动效'" :aria-pressed="motion" @click="motion = !motion"><Pause v-if="motion" :size="16" /><Play v-else :size="16" /></button>
          <WrappedFrameMenu ref="frameMenuEl" v-model="frameId" :frames="stage.frames" :dark="true" :exporting="exporting" :status-text="visibleExportStatus" :status-tone="exportTone" :can-export="canExportImage" :page-count="ECHO_SCENES.length" @export="exportCurrentFrame" @export-all="exportAllPages" />
          <WrappedYearSelector v-if="yearOptions.length > 1" v-model="year" :years="yearOptions" :dark="true" />
          <span v-else class="echo-page-year">{{ year }} 年</span>
          <button type="button" class="echo-page-share" :disabled="!allReady" @click="openShare"><Share2 :size="15" /><span>{{ allReady ? '分享' : '准备分享' }}</span></button>
        </div>
      </header>
      <div v-if="noticeMessage && !exporting" class="echo-page-notice" role="alert" data-world-block>
        <p>{{ noticeMessage }}</p><button v-if="actionError" type="button" aria-label="关闭提示" @click="actionError = ''">关闭</button>
      </div>
      <p v-if="exportStatus && !exporting" class="echo-page-export-status" :class="{ 'is-error': exportTone === 'error' }" :role="exportTone === 'error' ? 'alert' : 'status'" data-world-block>{{ visibleExportStatus }}</p>
      <div v-if="exporting && !captureUiHidden" class="echo-page-export-progress" :style="exportBadgeStyle" role="status" aria-live="polite" data-world-block><span>{{ exportProgress }}</span><button type="button" @click="cancelExport('已取消本次导出')">取消</button></div>
    </template>
  </WrappedStage>
  <Teleport to="body">
    <EchoDetailPanel v-if="report.state.detail" :detail="report.state.detail" :title="detailTitle" :privacy="privacyMode" data-world-block @close="report.closeDetail()" @retry="retryDetail" @more="moreDetail" @source="openSource" />
    <div v-if="shareDocument" data-world-block>
      <EchoSharePanel :document="shareDocument" :image-candidates="imageCandidates" @close="shareDocument = null" @error="showFailure" />
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { isNavigationFailure } from 'vue-router'
import { storeToRefs } from 'pinia'
import { ArrowLeft, Eye, EyeOff, Pause, Play, RefreshCw, Share2 } from '@lucide/vue'
import { useApi } from '~/composables/useApi'
import { useApiBase } from '~/composables/useApiBase'
import { useChatAccountsStore } from '~/stores/chatAccounts'
import { usePrivacyStore } from '~/stores/privacy'
import { createEchoReport } from '~/composables/useEchoReport'
import { createWrappedStage } from '~/composables/useWrappedStage'
import { exportScale } from '~/lib/wrapped-stage'
import { createEchoDocument, ECHO_SCENES, echoEmojis } from '~/lib/wrapped-echo-model'
import EchoExperience from '~/components/wrapped/echo/EchoExperience.vue'
import EchoDetailPanel from '~/components/wrapped/echo/EchoDetailPanel.vue'
import EchoSharePanel from '~/components/wrapped/echo/EchoSharePanel.vue'
import WrappedStage from '~/components/wrapped/shared/WrappedStage.vue'
import WrappedFrameMenu from '~/components/wrapped/shared/WrappedFrameMenu.vue'
import WrappedYearSelector from '~/components/wrapped/shared/WrappedYearSelector.vue'

useHead({ title: '回声异境 · 年度总结 · xwechat', bodyAttrs: { style: 'overflow: hidden; overscroll-behavior: none;' } })
const api = useApi(), apiBase = useApiBase(), route = useRoute(), router = useRouter()
const chatAccountsStore = useChatAccountsStore()
const { selectedAccount, accounts, loading: accountsLoading } = storeToRefs(chatAccountsStore)
const privacyStore = usePrivacyStore()
const { privacyMode } = storeToRefs(privacyStore)
const navigation = useState('ai-navigation-target', () => null)
const stage = createWrappedStage()
const frameId = computed({ get: () => stage.frameId.value, set: value => stage.setFrame(value) })
const queryYear = route.query?.year == null ? null : Number(route.query.year)
const defaultYear = new Date().getFullYear() - 1
const year = ref(queryYear === null ? defaultYear : queryYear)
const queryAccount = typeof route.query?.account === 'string' ? route.query.account.trim() : ''
const accountPinnedByQuery = !!queryAccount
const account = ref(queryAccount)
const report = createEchoReport(api)
const loading = computed(() => report.state.loading)
const currentReport = computed(() => report.state.meta?.account === account.value && report.state.meta?.year === year.value)
const yearOptions = computed(() => report.state.meta ? [...report.state.meta.availableYears].sort((a, b) => b - a) : [year.value])
const allReady = computed(() => currentReport.value && ECHO_SCENES[8].cards.every(id => report.state.cards[id]?.status === 'ok'))
const activeIndex = ref(0), motion = ref(true), experienceRevision = ref(0)
const experienceEl = ref(null), deckEl = ref(null), frameMenuEl = ref(null)
const actionError = ref(''), shareDocument = shallowRef(null)
const privateErrorMessage = '本章或操作失败，请关闭匿名后查看详细原因。'
const noticeMessage = computed(() => {
  const message = actionError.value || report.state.error || chatAccountsStore.error
  return message && privacyMode.value ? privateErrorMessage : message
})
const accountSyncReady = ref(false)
let suppressYearWatch = false, loadRevision = 0, disposed = false
let previousBackgrounds = null
const readingPoints = new Map()
const readingKey = (account, year) => JSON.stringify([account, year])
function rememberReadingPoint() {
  const meta = report.state.meta
  if (meta && experienceEl.value && !exporting.value) readingPoints.set(readingKey(meta.account, meta.year), { scene: activeIndex.value, selection: experienceEl.value.getSelection() })
}

function showFailure(error) { if (!disposed) actionError.value = error?.message || String(error) }
function resolveMedia(value) {
  if (typeof value !== 'string') throw new TypeError('年度素材地址无效')
  if (/^https?:\/\//i.test(value)) {
    const host = new URL(value).hostname.toLowerCase()
    if (host.endsWith('.qpic.cn') || host.endsWith('.qlogo.cn')) return `${apiBase}/chat/media/proxy_image?url=${encodeURIComponent(value)}`
    return value
  }
  if (value.startsWith('/api/')) return `${apiBase}${value.slice(4)}`
  return value.startsWith('/') ? value : `/${value}`
}
const imageCandidates = computed(() => echoEmojis(report.state.cards[5]?.status === 'ok' ? report.state.cards[5].data : null, resolveMedia).filter(item => item.url).map(({ key, label, url }) => ({ key, label, url, sceneId: 6 })))

async function reload(forceRefresh = false, preserveIndex = false) {
  rememberReadingPoint()
  const token = ++loadRevision
  cancelExport('账号、年份或统计已改变，本次导出已取消')
  actionError.value = ''; shareDocument.value = null
  experienceEl.value?.closeOverlays()
  experienceRevision.value++
  if (!preserveIndex) activeIndex.value = 0
  try {
    if (!Number.isInteger(year.value) || year.value < 1900 || year.value > 9999) throw new Error('年份必须是 1900–9999 之间的整数')
    const meta = await report.load({ account: account.value, year: year.value, refresh: forceRefresh })
    if (disposed || token !== loadRevision || !meta) return
    if (year.value !== meta.year) { suppressYearWatch = true; year.value = meta.year }
    const readingPoint = readingPoints.get(readingKey(meta.account, meta.year))
    activeIndex.value = readingPoint?.scene ?? 0
    await router.replace({ query: { ...route.query, year: String(meta.year) } })
    if (disposed || token !== loadRevision) return
    await report.loadScene(activeIndex.value)
    if (disposed || token !== loadRevision) return
    await nextTick()
    if (disposed || token !== loadRevision) return
    if (readingPoint?.selection) experienceEl.value.setSelection(readingPoint.selection)
    // Once the current chapter settles, fetch the remaining independent data.
    // The report keeps failed/building cards until an explicit user retry.
    await Promise.all(ECHO_SCENES[8].cards.map(id => report.loadCard(id)))
  } catch (error) { if (!disposed && token === loadRevision) showFailure(error) }
}

async function goTo(index) {
  if (exporting.value) return
  if (!Number.isInteger(index) || !ECHO_SCENES[index]) { showFailure(new Error('未知的年度空间')); return }
  activeIndex.value = index
  report.closeDetail(); shareDocument.value = null
  if (!currentReport.value) return
  try { await report.loadScene(index) } catch (error) { showFailure(error) }
}
async function retryScene() {
  const identity = report.getIdentity()
  actionError.value = ''
  try {
    await report.loadScene(activeIndex.value, { retry: true })
    if (sameIdentity(identity)) experienceRevision.value++
  } catch (error) { if (sameIdentity(identity)) showFailure(error) }
}
async function selectPageAccount(index) {
  if (!Number.isInteger(index) || index < 0 || index >= accounts.value.length) { showFailure(new Error('所选账号已不可用，请重新加载账号列表')); return }
  const next = accounts.value[index]
  if (next === account.value) return
  account.value = next
  chatAccountsStore.setSelectedAccount(next)
  if (accountPinnedByQuery) {
    try { await router.replace({ query: { ...route.query, account: next } }) } catch (error) { showFailure(error); return }
  }
  await reload(false, true)
}
async function goBack() {
  if (router.options.history.state.back) router.back()
  else { try { await router.push('/chat') } catch (error) { showFailure(error) } }
}

const detailTitle = computed(() => ({ day: '这一天的来源记录', contact: '这位联系人的往来记录', hour: '这个时段的来源记录', night: '深夜往来的来源记录', phrase: '这句短语的来源记录', emoji: '这个表情的来源记录' })[report.state.detail?.query.kind] || '来源记录')
async function openDetail(query) {
  if (exporting.value || !currentReport.value) return
  shareDocument.value = null; actionError.value = ''
  try { await report.loadDetail(query) } catch (error) { showFailure(error) }
}
async function retryDetail() {
  if (!report.state.detail) return
  try { await report.loadDetail(report.state.detail.query, { refresh: true }) } catch (error) { showFailure(error) }
}
async function moreDetail() {
  if (report.state.detail?.status !== 'ok' || !report.state.detail.data.hasMore) return
  try { await report.loadDetail(report.state.detail.query, { append: true }) } catch (error) { showFailure(error) }
}
async function openSource(item) {
  if (privacyMode.value || !currentReport.value) return
  const identity = report.getIdentity()
  let target
  try {
    if (typeof item.username !== 'string' || !item.username || typeof item.dbStem !== 'string' || !item.dbStem || typeof item.table !== 'string' || !item.table || !Number.isInteger(item.localId) || item.localId <= 0) throw new Error('该消息缺少有效的来源锚点')
    target = { kind: 'source', origin: 'wrapped', account: identity.account, username: item.username, anchor: `${item.dbStem}:${item.table}:${item.localId}` }
    navigation.value = target
    target = navigation.value
    const result = await router.push('/chat')
    if (result === false || isNavigationFailure(result)) throw new Error('未能打开聊天页，请重试来源定位')
    if (!disposed && report.getIdentity().generation === identity.generation) report.closeDetail()
  } catch (error) {
    if (navigation.value === target) navigation.value = null
    if (!disposed && report.getIdentity().generation === identity.generation) showFailure(error)
  }
}
function openShare() {
  if (exporting.value) return
  if (!allReady.value) { showFailure(new Error('分享需要全部章节统计就绪；请先在失败或构建中的章节点击重试')); return }
  try {
    report.closeDetail(); experienceEl.value?.closeOverlays()
    shareDocument.value = createEchoDocument({ year: year.value, cards: report.state.cards, loadedDetails: report.state.loadedDetails })
  } catch (error) { showFailure(error) }
}

const exporting = ref(false), exportMode = ref(false), exportStatus = ref(''), exportTone = ref('info'), exportProgress = ref(''), captureUiHidden = ref(false)
const visibleExportStatus = computed(() => privacyMode.value && exportStatus.value && exportTone.value === 'error' ? privateErrorMessage : exportStatus.value)
let exportController = null
const desktopBridge = () => typeof window === 'undefined' ? null : window.wechatDesktop
const canExportImage = computed(() => typeof desktopBridge()?.captureRegion === 'function')
const exportBadgeStyle = computed(() => {
  const { w, h } = stage.design.value, k = stage.scale.value, r = stage.rect.value, host = stage.hostSize.value
  const bottom = host.h - r.top - h * k, top = r.top
  if (bottom >= 38) return { left: '50%', top: `${r.top + h * k + bottom / 2}px`, transform: 'translate(-50%, -50%)' }
  if (top >= 38) return { left: '50%', top: `${top / 2}px`, transform: 'translate(-50%, -50%)' }
  const right = host.w - r.left - w * k
  if (Math.max(right, r.left) < 38) return { left: '50%', top: '12px', transform: 'translateX(-50%)' }
  return { left: `${right >= r.left ? r.left + w * k + right / 2 : r.left / 2}px`, top: `${r.top + h * k / 2}px`, transform: 'translate(-50%, -50%) rotate(90deg)' }
})
function cancelExport(message) { exportController?.abort(new Error(message)) }
function onExportKeyDown(event) {
  if (!exporting.value || event.key !== 'Escape') return
  event.preventDefault()
  cancelExport('已取消本次导出')
}
function setExportStatus(message, tone = 'info') { exportStatus.value = message; exportTone.value = tone }
function sameIdentity(identity) {
  const now = report.getIdentity()
  return !disposed && now.generation === identity.generation && now.account === identity.account && now.year === identity.year && account.value === identity.account && year.value === identity.year
}
function assertCaptureIdentity(identity, signal) {
  if (signal.aborted) throw signal.reason
  if (!sameIdentity(identity) || privacyMode.value !== identity.privacy || frameId.value !== identity.frame) throw new Error('账号、年份、隐私或画幅已改变，本次导出已取消')
}
async function waitForExport(promise, signal) {
  if (signal.aborted) throw signal.reason
  let abort
  const cancelled = new Promise((resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))
function safeFileName(value) { return String(value).replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/^\.+|\.+$/g, '').slice(0, 100) }
function exportGeometry() {
  const element = stage.stageEl.value
  if (!element) throw new Error('年度画幅尚未就绪')
  const rect = element.getBoundingClientRect(), width = Math.round(rect.width), height = Math.round(rect.height)
  if (!(width > 0 && height > 0)) throw new Error('年度画幅尺寸无效')
  const design = stage.design.value, outWidth = Math.round(design.w * exportScale(stage.frame.value, design))
  return { x: rect.left, y: rect.top, width, height, scale: outWidth / width / window.devicePixelRatio, outWidth, outHeight: Math.round(design.h * outWidth / design.w) }
}
async function prepareScene(index, identity, signal) {
  assertCaptureIdentity(identity, signal)
  await waitForExport(report.requireScene(index), signal)
  assertCaptureIdentity(identity, signal)
  activeIndex.value = index
  await nextTick()
  if (!experienceEl.value) throw new Error('三维年度场景尚未就绪')
  await waitForExport(Promise.all([document.fonts?.ready, experienceEl.value.prepareCapture()]), signal)
  assertCaptureIdentity(identity, signal)
  const images = [...deckEl.value.querySelectorAll('img')]
  await waitForExport(Promise.all(images.map(async image => {
    try { await image.decode() } catch (cause) { throw new Error('场景图片解码失败，请修复素材后重新导出', { cause }) }
    if (!image.naturalWidth) throw new Error('场景图片未能加载，导出已停止')
  })), signal)
  await waitForExport(nextFrame(), signal)
  assertCaptureIdentity(identity, signal)
}
async function exportScenes(batch) {
  if (exporting.value) return
  const bridge = desktopBridge()
  const methods = batch ? ['wrappedBatchBegin', 'wrappedBatchCapture', 'wrappedBatchFinish', 'wrappedBatchAbort'] : ['captureRegion']
  if (!bridge || methods.some(name => typeof bridge[name] !== 'function')) { setExportStatus('当前浏览器无法截取三维场景。请使用“分享”中的独立海报或离线阅读档案；场景截图与 ZIP 需在桌面应用导出。', 'error'); return }
  if (!currentReport.value) { setExportStatus('年度目录尚未就绪，请先完成统计', 'error'); return }
  const identity = { ...report.getIdentity(), privacy: privacyMode.value, frame: frameId.value }
  rememberReadingPoint()
  const original = { scene: activeIndex.value, selection: experienceEl.value?.getSelection(), motion: motion.value }
  exportController = new AbortController()
  const signal = exportController.signal
  exporting.value = true; exportMode.value = true; motion.value = false; actionError.value = ''; exportStatus.value = ''
  report.closeDetail(); shareDocument.value = null; frameMenuEl.value?.close(); experienceEl.value?.closeOverlays()
  let batchId = null
  try {
    if (batch) {
      exportProgress.value = '正在准备十个空间'
      await waitForExport(report.requireScene(8), signal)
      assertCaptureIdentity(identity, signal)
      const begun = await bridge.wrappedBatchBegin({ label: `回声异境-${identity.year}-${identity.frame}` })
      if (!begun?.ok || !begun.batchId) throw new Error(begun?.error || '无法开始批量导出')
      batchId = begun.batchId
    }
    const indexes = batch ? ECHO_SCENES.map(scene => scene.id) : [original.scene]
    for (const index of indexes) {
      exportProgress.value = batch ? `正在导出 ${index + 1} / ${indexes.length}` : '正在导出当前空间'
      await prepareScene(index, identity, signal)
      const geometry = exportGeometry()
      let result
      captureUiHidden.value = true
      try {
        await nextTick()
        await waitForExport(nextFrame(), signal)
        assertCaptureIdentity(identity, signal)
        result = batch
          ? await bridge.wrappedBatchCapture({ batchId, index, name: safeFileName(ECHO_SCENES[index].title), ...geometry })
          : await bridge.captureRegion({ ...geometry, name: safeFileName(`回声异境-${identity.year}-${identity.frame}-${ECHO_SCENES[index].title}`) })
      } finally { captureUiHidden.value = false }
      if (!result?.ok) throw new Error(result?.error || '桌面截图失败')
      assertCaptureIdentity(identity, signal)
    }
    if (batch) {
      exportProgress.value = '正在封装十章图片'
      const result = await bridge.wrappedBatchFinish({ batchId, zipName: safeFileName(`xwechat_回声异境_${identity.year}_${identity.frame}`) })
      if (!result?.ok) throw new Error(result?.error || '打包失败')
      if (result.count !== ECHO_SCENES.length) throw new Error(`桌面导出返回图片数量与 ${ECHO_SCENES.length} 个章节不一致，请检查输出目录`)
      batchId = null
      assertCaptureIdentity(identity, signal)
      setExportStatus(`桌面应用已保存 ${result.count} 张图片的 ZIP。请在输出目录核对文件。`)
    } else setExportStatus('桌面应用已保存当前空间图片。请在输出目录核对文件。')
  } catch (error) {
    let message = error?.message || String(error)
    if (batchId) {
      try {
        const result = await bridge.wrappedBatchAbort({ batchId })
        if (!result?.ok) throw new Error(result?.error || '临时图片清理失败')
      } catch (cleanupError) { message += `；导出临时文件清理失败：${cleanupError.message}` }
    }
    if (!disposed) setExportStatus(message, 'error')
  } finally {
    try {
      if (sameIdentity(identity)) {
        activeIndex.value = original.scene
        await nextTick()
        if (sameIdentity(identity) && original.selection) experienceEl.value?.setSelection(original.selection)
      }
    } catch (restoreError) {
      if (!disposed) setExportStatus(`${exportStatus.value}${exportStatus.value ? '；' : ''}恢复阅读位置失败：${restoreError.message}`, 'error')
    } finally {
      motion.value = original.motion
      exportMode.value = false; exporting.value = false; captureUiHidden.value = false; exportProgress.value = ''; exportController = null
    }
  }
}
const exportCurrentFrame = () => exportScenes(false)
const exportAllPages = () => exportScenes(true)

watch(selectedAccount, async next => {
  if (accountPinnedByQuery) return
  const nextAccount = String(next || '').trim()
  if (nextAccount === account.value) return
  account.value = nextAccount
  if (accountSyncReady.value) await reload(false, true)
}, { flush: 'sync' })
watch(year, async (next, previous) => {
  if (suppressYearWatch) { suppressYearWatch = false; return }
  if (next === previous || !accountSyncReady.value) return
  await reload(false, true)
}, { flush: 'sync' })
watch(() => stage.frameId.value, async value => {
  if (!accountSyncReady.value || disposed) return
  cancelExport('画幅已改变，本次导出已取消')
  const query = { ...route.query }
  if (value === 'fit') delete query.frame
  else query.frame = value
  try { await router.replace({ query }) } catch (error) { showFailure(error) }
})
watch(privacyMode, () => cancelExport('隐私设置已改变，本次导出已取消'), { flush: 'sync' })
onMounted(async () => {
  window.addEventListener('keydown', onExportKeyDown)
  privacyStore.init(); stage.initFrame(route.query?.frame)
  previousBackgrounds = [document.documentElement.style.backgroundColor, document.body.style.backgroundColor]
  document.documentElement.style.backgroundColor = '#080e10'; document.body.style.backgroundColor = '#080e10'
  try {
    await chatAccountsStore.ensureLoaded()
    if (disposed) return
    if (!accountPinnedByQuery) account.value = String(selectedAccount.value || '').trim()
    accountSyncReady.value = true
    if (accounts.value.length) await reload()
  } catch (error) { showFailure(error) }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onExportKeyDown)
  disposed = true; loadRevision++
  cancelExport('已离开年度总结，本次导出已取消'); report.dispose()
  if (previousBackgrounds) { document.documentElement.style.backgroundColor = previousBackgrounds[0]; document.body.style.backgroundColor = previousBackgrounds[1] }
})
</script>

<style scoped>
.echo-page-stage{height:100%;min-height:0;position:relative;overflow:hidden;background:#080e10;color:#e9ecda}
.echo-page-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;gap:16px}.echo-page-empty h1{font-size:clamp(32px,5vw,64px);font-weight:500;margin:0;letter-spacing:.06em}.echo-page-empty p{font-size:14px;line-height:1.8;color:#b8cbbf;margin:0}.echo-page-empty button{border:1px solid #728b7b;background:transparent;color:#dae5d3;border-radius:5px;padding:10px 17px;font-size:13px;cursor:pointer}
.echo-page-toolbar{position:absolute;z-index:30;top:15px;left:19px;right:19px;display:flex;align-items:center;justify-content:space-between;gap:12px;pointer-events:none;color:#c8d8c7;font-family:'Microsoft YaHei','PingFang SC',sans-serif}.echo-page-toolbar-group{display:flex;align-items:center;gap:9px;min-width:0;pointer-events:auto}.echo-page-icon{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;flex:none}.echo-page-icon:hover{background:#ffffff12}.echo-page-icon:disabled{opacity:.4;cursor:default}.echo-page-icon:focus-visible,.echo-page-account select:focus-visible,.echo-page-share:focus-visible{outline:2px solid #dfc28c;outline-offset:3px}.echo-page-account{min-width:0}.echo-page-account select{width:144px;max-width:100%;border:0;border-radius:4px;background:#102019;color:#c8d8c7;padding:5px 20px 5px 7px;font-size:11px;cursor:pointer;text-overflow:ellipsis}.echo-page-year{font-size:11px;white-space:nowrap;color:#bed1be;font-variant-numeric:tabular-nums}.echo-page-share{display:flex;align-items:center;gap:6px;border:1px solid #7f997f;background:#17271e;color:#dfe5c9;border-radius:5px;padding:7px 11px;font-size:11px;white-space:nowrap;cursor:pointer}.echo-page-share:disabled{opacity:.5;cursor:default}
.echo-page-notice{position:absolute;z-index:35;top:61px;left:20px;max-width:min(600px,calc(100% - 40px));display:flex;align-items:flex-start;gap:18px;padding:12px 15px;border:1px solid #97685c;border-radius:6px;background:#402e2b;color:#ffe4d3;font-size:12px;line-height:1.7;overflow-wrap:anywhere}.echo-page-notice p{margin:0}.echo-page-notice button{border:0;background:transparent;color:inherit;white-space:nowrap;cursor:pointer;font:inherit}.echo-page-export-status{position:absolute;z-index:31;right:20px;bottom:14px;max-width:min(640px,calc(100% - 40px));padding:9px 12px;border-radius:5px;background:#182c26;color:#d3e1ce;font-size:12px;line-height:1.6;margin:0}.echo-page-export-status.is-error{background:#422c27;color:#ffe2cf}.echo-page-export-progress{position:absolute;z-index:32;display:flex;align-items:center;gap:12px;white-space:nowrap;font-size:11px;color:#d7e4d4;padding:4px 7px;background:#17251e;border-radius:5px}.echo-page-export-progress button{border:1px solid #7a9279;background:transparent;border-radius:3px;color:inherit;font:inherit;cursor:pointer;padding:2px 5px}
.echo-page-spin{animation:echo-page-spin 1.2s linear infinite}@keyframes echo-page-spin{to{transform:rotate(360deg)}}
@media(max-width:780px){.echo-page-toolbar{left:9px;right:9px;top:10px;gap:4px}.echo-page-toolbar-group{gap:3px}.echo-page-account select{width:95px;font-size:10px}.echo-page-icon{width:28px;height:30px}.echo-page-share{padding:6px 7px}.echo-page-year{font-size:10px}.echo-page-notice{left:10px;max-width:calc(100% - 20px);top:52px}}
@media(max-width:490px){.echo-page-account select{width:70px}.echo-page-share span{display:none}.echo-page-toolbar-group{gap:0}.echo-page-year{padding-inline:3px}.echo-page-share{border:0;background:transparent;padding:7px;color:#d9e4cd}.echo-page-notice{top:49px}}
@media(prefers-reduced-motion:reduce){.echo-page-spin{animation:none}}
</style>
