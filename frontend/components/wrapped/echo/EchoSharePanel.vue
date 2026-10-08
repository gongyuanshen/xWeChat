<template>
  <div class="echo-share-backdrop" @click.self="close" @keydown.stop>
    <section ref="panel" class="echo-share" role="dialog" aria-modal="true" aria-labelledby="echo-share-title" tabindex="-1" @keydown="onKeydown">
      <header class="echo-share-header">
        <div><h2 id="echo-share-title">带走这一年的回声</h2><p>一张独立海报，或一份可以离线翻阅的档案。</p></div>
        <button type="button" class="echo-close" :disabled="!!exporting" aria-label="关闭分享面板" @click="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
      </header>
      <div v-if="busy || !document" class="echo-share-wait" role="status">{{ busy ? '正在准备年度统计，请稍候…' : '年度统计尚未就绪，请返回后重试。' }}</div>
      <div v-else class="echo-share-body">
        <div class="echo-share-controls">
          <fieldset :disabled="!!exporting">
            <legend>收进档案的章节</legend>
            <div class="echo-chapter-options"><label v-for="scene in document.scenes" :key="scene.id"><input v-model="selectedIds" type="checkbox" :value="String(scene.id)"><span>{{ scene.title }}</span></label></div>
          </fieldset>
          <fieldset :disabled="!!exporting">
            <legend>分享范围</legend>
            <label class="echo-check"><input :checked="privacy" type="checkbox" data-control="privacy" @change="setPrivacy($event.target.checked)"><span>匿名分享<span class="echo-help">开启后移除人物信息、聊天正文及私人图片。</span></span></label>
            <label class="echo-check"><input v-model="includeMessages" type="checkbox" data-control="messages" :disabled="privacy"><span>包含聊天正文与完整短句<span class="echo-help">关闭匿名后可单独选择。</span></span></label>
            <label class="echo-check"><input v-model="privateImages" type="checkbox" data-control="images" :disabled="privacy || !hasImages"><span>包含已选入的私人图片<span class="echo-help">{{ hasImages ? '只内嵌准备好的本地素材。' : '当前年度文档未提供可内嵌图片。' }}</span></span></label>
            <div v-if="!privacy && privateImages && imageCandidates.length" class="echo-material-options">
              <p>选择要带走的素材，再手动准备。动态图片封存为静态 PNG；海报展示当前章节首张图片，HTML 保留全部已选图片。</p>
              <label v-for="candidate in visibleImageCandidates" :key="candidate.key" class="echo-check"><input v-model="selectedImageKeys" type="checkbox" :value="candidate.key" data-image-candidate><span>{{ candidate.label }}</span></label>
              <p v-if="!visibleImageCandidates.length">选中的章节没有可准备的图片。</p>
              <button type="button" data-prepare-images :disabled="!selectedImageKeys.length || imagePreparing" @click="prepareImages">{{ imagePreparing ? '正在准备所选图片…' : '准备已选图片' }}</button>
              <p role="status">{{ imagePreparing ? '读取与解码仅限刚才选中的素材。' : imagePreparationRequired ? '所选图片尚未准备，下载暂不可用。准备完成或取消选择后可继续。' : preparedImages.length ? `已准备 ${preparedImages.length} 张图片，将随文件内嵌保存。` : '尚未选择图片。' }}</p>
            </div>
            <p v-if="!privacy" class="echo-private-note">已允许保留人物信息。正文和图片仍需分别选择；导出前请核对预览与文件范围。</p>
          </fieldset>
          <fieldset :disabled="!!exporting">
            <legend>独立海报</legend>
            <label class="echo-select">海报章节<select v-model="posterId" :disabled="!exportDocument"><option v-for="scene in exportDocument?.scenes || []" :key="scene.id" :value="scene.id">{{ scene.title }}</option></select></label>
            <div class="echo-frames" aria-label="海报画幅"><button v-for="format in frames" :key="format.id" type="button" :aria-pressed="frame === format.id" @click="frame = format.id">{{ format.id }}</button></div>
          </fieldset>
          <div class="echo-file-scope" aria-live="polite">
            <strong>将写入文件的内容</strong>
            <p v-if="exportDocument">{{ exportDocument.scenes.length }} 个章节：标题、统计口径、数字、单位与 {{ detailCount }} 项读数及明细。人物信息{{ privacy ? '移除' : '保留' }}，正文{{ includeMessages ? '保留' : '排除' }}，私人图片{{ privateImages ? '保留' : '排除' }}。</p>
            <p>账号标识、数据库路径、本机来源锚点不写入文件。海报保留当前章节摘要；HTML 保留所选章节全部已准备的明细。</p>
            <p>源消息只包含你已展开并载入的记录；尚未加载的分页消息不在这份档案中。</p>
          </div>
        </div>
        <div class="echo-share-preview">
          <div class="echo-preview-stage"><img v-if="previewUrl" :src="previewUrl" :alt="`${document.year} 年独立分享海报预览`" @error="previewFailed"><p v-else>选择至少一个章节以查看预览。</p></div>
          <p class="echo-preview-caption">{{ frame }} · {{ frameSize }} px · 预览与 PNG 使用同一构图<br>长文本在海报中省略，完整内容保存在 HTML 阅读档案。</p>
        </div>
      </div>
      <footer class="echo-share-footer">
        <p v-if="errorMessage" class="echo-share-error" role="alert">{{ errorMessage }}</p>
        <p v-else class="echo-share-status" role="status">{{ status || '文件在本地生成，下载将交给浏览器处理。' }}</p>
        <div class="echo-export-actions"><button type="button" :disabled="!canExport" @click="download('html')">{{ exporting === 'html' ? '正在封存…' : '下载离线 HTML 档案' }}</button><button type="button" class="echo-primary" :disabled="!canExport" @click="download('png')">{{ exporting === 'png' ? '正在生成…' : '下载当前章 PNG' }}</button></div>
      </footer>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEchoArchiveBlob, createEchoExportDocument, downloadEchoBlob, ECHO_EXPORT_FRAMES, exportEchoPosterPng, prepareEchoImages, renderEchoPosterSvg } from '~/lib/wrapped-echo-export.js'

const props = defineProps({ document: { type: Object, default: null }, busy: { type: Boolean, default: false }, imageCandidates: { type: Array, default: () => [] } })
const emit = defineEmits(['close', 'error'])
const panel = ref(null)
const selectedIds = ref([])
const privacy = ref(true)
const includeMessages = ref(false)
const privateImages = ref(false)
const posterId = ref('')
const frame = ref('3:4')
const frames = ECHO_EXPORT_FRAMES
const exporting = ref('')
const failure = ref('')
const status = ref('')
const selectedImageKeys = ref([])
const preparedImages = ref([])
const imagePreparing = ref(false)
let imageController = null
let imageGeneration = 0
let previousFocus
let alive = true

function invalidateImages() { imageGeneration++; imageController?.abort(); imageController = null; preparedImages.value = []; imagePreparing.value = false }
watch(() => props.document, value => {
  invalidateImages()
  selectedImageKeys.value = []
  selectedIds.value = value?.scenes.map(scene => String(scene.id)) || []
  privacy.value = true
  includeMessages.value = false
  privateImages.value = false
  failure.value = ''
  status.value = ''
}, { immediate: true })
watch(() => props.imageCandidates, () => { invalidateImages(); selectedImageKeys.value = [] })
watch(selectedImageKeys, invalidateImages, { deep: true, flush: 'sync' })
watch(privateImages, value => { if (!value) { invalidateImages(); selectedImageKeys.value = [] } })
watch(selectedIds, ids => { selectedImageKeys.value = selectedImageKeys.value.filter(key => props.imageCandidates.some(candidate => candidate.key === key && ids.includes(String(candidate.sceneId)))) }, { deep: true })
const visibleImageCandidates = computed(() => props.imageCandidates.filter(candidate => selectedIds.value.includes(String(candidate.sceneId))))
const imagePreparationRequired = computed(() => privateImages.value && selectedImageKeys.value.length > 0 && preparedImages.value.length !== selectedImageKeys.value.length)
const documentWithImages = computed(() => !props.document || !preparedImages.value.length ? props.document : {
  ...props.document,
  scenes: props.document.scenes.map(scene => ({ ...scene, rows: [...scene.rows, ...preparedImages.value.filter(image => String(image.sceneId) === String(scene.id)).map(image => ({ label: image.label, value: '已选私人图片', imageDataUrl: image.imageDataUrl, private: 'image' }))] })),
})

const prepared = computed(() => {
  if (!props.document || props.busy) return { document: null, error: '' }
  try {
    return { document: createEchoExportDocument(documentWithImages.value, { sceneIds: selectedIds.value, privacy: privacy.value, includeMessages: includeMessages.value, privateImages: privateImages.value }), error: '' }
  } catch (error) { return { document: null, error: error.message } }
})
const exportDocument = computed(() => prepared.value.document)
watch(exportDocument, value => {
  if (!value?.scenes.some(scene => scene.id === posterId.value)) posterId.value = value?.scenes[0]?.id || ''
  failure.value = ''
  status.value = ''
}, { immediate: true })
const preview = computed(() => {
  if (!exportDocument.value) return { svg: '', error: '' }
  try { return { svg: renderEchoPosterSvg(exportDocument.value, { frame: frame.value, sceneId: posterId.value }), error: '' } }
  catch (error) { return { svg: '', error: error.message } }
})
const previewUrl = computed(() => preview.value.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.value.svg)}` : '')
const frameSize = computed(() => frames.find(item => item.id === frame.value).exportSize.join(' × '))
const errorMessage = computed(() => failure.value || prepared.value.error || preview.value.error)
const canExport = computed(() => !props.busy && !exporting.value && !imagePreparing.value && !imagePreparationRequired.value && !!exportDocument.value && !!preview.value.svg && !prepared.value.error && !preview.value.error)
const detailCount = computed(() => exportDocument.value?.scenes.reduce((total, scene) => total + scene.metrics.length + scene.rows.length + scene.details.reduce((sum, detail) => sum + detail.rows.length, 0), 0) || 0)
const hasImages = computed(() => props.imageCandidates.length > 0 || props.document?.scenes.some(scene => [...scene.rows, ...scene.details.flatMap(detail => detail.rows)].some(row => row.imageDataUrl !== undefined)) || false)

async function prepareImages() {
  if (privacy.value || !privateImages.value || !selectedImageKeys.value.length || imagePreparing.value) return
  invalidateImages()
  const token = imageGeneration
  imageController = new AbortController()
  imagePreparing.value = true
  failure.value = ''
  try {
    const candidates = selectedImageKeys.value.map(key => visibleImageCandidates.value.find(candidate => candidate.key === key))
    if (candidates.some(candidate => !candidate)) throw new Error('所选图片或章节已变化，请重新选择')
    const images = await prepareEchoImages(candidates, { signal: imageController.signal })
    if (!alive || token !== imageGeneration) return
    preparedImages.value = images
  } catch (error) { if (alive && token === imageGeneration) reportFailure(error) }
  finally { if (token === imageGeneration) { imagePreparing.value = false; imageController = null } }
}

function setPrivacy(value) {
  privacy.value = value
  if (value) { includeMessages.value = false; privateImages.value = false }
}
function close() { if (!exporting.value) emit('close') }
function reportFailure(error) { failure.value = error.message; emit('error', error) }
function previewFailed() { reportFailure(new Error('海报预览加载失败，请重新打开分享面板后重试')) }
async function download(kind) {
  if (!canExport.value) return
  const source = props.document
  const snapshot = exportDocument.value
  const format = frame.value
  const chapter = posterId.value
  exporting.value = kind
  failure.value = ''
  status.value = ''
  try {
    const blob = kind === 'png'
      ? await exportEchoPosterPng(snapshot, { frame: format, sceneId: chapter })
      : await createEchoArchiveBlob(snapshot)
    if (!alive) return
    if (props.document !== source || props.busy) throw new Error('年度数据已改变，本次导出已取消，请确认年份后重试')
    downloadEchoBlob(blob, `回声异境_${snapshot.year}_${snapshot.scope.privacy ? '匿名' : '含私密内容'}${kind === 'png' ? `_${chapter}_${format.replace(':', 'x')}` : ''}.${kind}`)
    status.value = `${kind === 'png' ? 'PNG 海报' : 'HTML 阅读档案'}已生成并交给浏览器下载，请在下载记录中确认文件。`
  } catch (error) { if (alive) reportFailure(error) }
  finally { exporting.value = '' }
}
function onKeydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); close(); return }
  if (event.key !== 'Tab') return
  const focusable = [...panel.value.querySelectorAll('button,input,select,[tabindex="0"]')].filter(element => !element.matches(':disabled'))
  const first = focusable[0], last = focusable.at(-1)
  if (event.shiftKey && (window.document.activeElement === first || window.document.activeElement === panel.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => { previousFocus = window.document.activeElement; await nextTick(); panel.value?.focus() })
onBeforeUnmount(() => { alive = false; invalidateImages(); if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<style scoped>
.echo-share-backdrop{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:24px;background:rgba(13,36,43,.72);color:#274b4e;font-family:'Microsoft YaHei','PingFang SC',sans-serif}
.echo-share{width:min(1060px,100%);max-height:calc(100dvh - 48px);display:flex;flex-direction:column;background:#f4f3e7;border-radius:12px;overflow:hidden;box-shadow:0 22px 70px rgba(5,26,29,.28);outline:none}
.echo-share-header{display:flex;gap:24px;align-items:flex-start;justify-content:space-between;padding:25px 30px 20px;border-bottom:1px solid #c9d3c7}
h2{font-size:25px;line-height:1.35;font-weight:600;margin:0}.echo-share-header p{font-size:13px;color:#536d65;margin:8px 0 0}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #9c4b3e;outline-offset:3px}::selection{background:#c1d9c9}
.echo-close{display:grid;place-items:center;flex:none;width:36px;height:36px;border:0;background:transparent;border-radius:6px}.echo-close:hover{background:#e0e8dc}.echo-close svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6}
.echo-share-body{display:grid;grid-template-columns:minmax(300px,1fr) minmax(0,1fr);min-height:0;overflow:auto;scrollbar-color:#90aba0 transparent}
.echo-share-controls{padding:22px 30px 26px}.echo-share-controls fieldset{border:0;border-bottom:1px solid #c9d3c7;margin:0 0 19px;padding:0 0 20px;min-width:0}.echo-share-controls legend{font-size:14px;font-weight:600;margin-bottom:12px;padding:0}
.echo-chapter-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px 12px}.echo-chapter-options label{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.5}.echo-chapter-options span{overflow-wrap:anywhere}input[type=checkbox]{accent-color:#396d60;width:16px;height:16px;flex:none;margin:1px 0 0}
.echo-check{display:flex;align-items:flex-start;gap:10px;margin-bottom:13px;font-size:13px}.echo-check:last-of-type{margin:0}.echo-help{display:block;color:#536d65;font-size:11px;line-height:1.6;margin-top:3px}.echo-private-note{background:#ede1c9;color:#6e4830;padding:10px 12px;font-size:12px;line-height:1.7;margin:12px 0 0;border-radius:4px}
.echo-material-options{margin-top:14px;padding-top:12px;border-top:1px solid #c9d3c7;font-size:11px;line-height:1.7}.echo-material-options p{margin:8px 0}.echo-material-options button{border:1px solid #789889;background:transparent;border-radius:4px;padding:8px 11px;font-size:12px}.echo-material-options .echo-check{font-size:12px;margin:9px 0}.echo-material-options .echo-check span{overflow-wrap:anywhere}
.echo-select{display:grid;grid-template-columns:80px minmax(0,1fr);align-items:center;gap:12px;font-size:12px}.echo-select select{border:1px solid #93ada1;border-radius:4px;background:#fbfaf0;min-width:0;width:100%;padding:9px 10px}.echo-frames{display:flex;gap:8px;margin-top:12px}.echo-frames button{flex:1;border:1px solid #a9bdb0;border-radius:4px;background:transparent;padding:8px;font-size:12px;white-space:nowrap}.echo-frames button[aria-pressed=true]{background:#315e56;color:#f9f7e7;border-color:#315e56}.echo-frames button:hover:not([aria-pressed=true]){background:#e2eadd}
.echo-file-scope{font-size:11px;line-height:1.7;color:#4e6962}.echo-file-scope strong{font-weight:600;color:#294e48}.echo-file-scope p{margin:7px 0 0}
.echo-share-preview{display:flex;flex-direction:column;justify-content:flex-start;padding:25px 25px 20px;background:#dfe7da;border-left:1px solid #c9d3c7}.echo-preview-stage{min-height:260px;display:flex;align-items:flex-start;justify-content:center}.echo-preview-stage img{display:block;max-width:100%;max-height:535px;object-fit:contain;box-shadow:0 12px 27px rgba(41,72,65,.18)}.echo-preview-stage p{font-size:13px;padding:50px 16px}.echo-preview-caption{font-size:11px;line-height:1.75;color:#45635c;text-align:center;margin:17px 0 0}
.echo-share-footer{padding:16px 30px 21px;border-top:1px solid #c9d3c7}.echo-share-status,.echo-share-error{font-size:12px;line-height:1.6;min-height:20px;margin:0 0 12px;overflow-wrap:anywhere}.echo-share-status{color:#4e6962}.echo-share-error{color:#98432f}.echo-export-actions{display:flex;gap:12px;justify-content:flex-end}.echo-export-actions button{border:1px solid #789889;background:transparent;border-radius:5px;padding:11px 17px;font-size:13px;white-space:nowrap}.echo-export-actions button:hover:not(:disabled){background:#e2eadc}.echo-export-actions .echo-primary{background:#315e56;color:#fffbe9;border-color:#315e56}.echo-export-actions .echo-primary:hover:not(:disabled){background:#254d45}.echo-share-wait{padding:60px 30px;text-align:center;font-size:14px}
@media(max-width:700px){.echo-share-backdrop{padding:8px}.echo-share{max-height:calc(100dvh - 16px);border-radius:8px}.echo-share-header{padding:19px 20px 16px;gap:12px}h2{font-size:20px}.echo-share-header p{font-size:12px}.echo-share-body{display:block}.echo-share-controls{padding:20px}.echo-share-preview{border-left:0;border-top:1px solid #c9d3c7;padding:23px 20px}.echo-preview-stage img{max-height:420px}.echo-share-footer{padding:13px 20px 17px}.echo-export-actions{flex-wrap:wrap;gap:8px}.echo-export-actions button{flex:1;font-size:12px;padding:10px 12px}}
</style>
