import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'


test('朋友圈导出联系人规范化函数在即时 watch 求值前可用', async () => {
  const source = await readFile(new URL('../pages/sns.vue', import.meta.url), 'utf8')

  const declarationIndex = source.indexOf('function normalizeExportSelectedUsernames(list)')

  assert.notEqual(declarationIndex, -1)
  assert.equal(
    source.includes('const normalizeExportSelectedUsernames ='),
    false,
    '该函数必须保持为可提升的函数声明，避免朋友圈页面初始化时触发 TDZ',
  )

  const selfInfoIndex = source.indexOf("const selfInfo = ref({ wxid: '', nickname: '' })")
  const folderNameWatchIndex = source.indexOf('watch(exportFolderNamePreview')
  assert.notEqual(selfInfoIndex, -1)
  assert.notEqual(folderNameWatchIndex, -1)
  assert.ok(
    selfInfoIndex < folderNameWatchIndex,
    '目录名预览监听必须在所有依赖状态声明完成后创建',
  )
})


test('朋友圈输出方式与文件格式使用同级四列选项卡', async () => {
  const source = await readFile(new URL('../pages/sns.vue', import.meta.url), 'utf8')

  assert.match(source, /<fieldset class="app-export-option-group min-w-\[280px\]">[\s\S]*?<legend class="sr-only">文件格式<\/legend>/)
  assert.match(source, /<fieldset class="app-export-option-group">[\s\S]*?<legend class="sr-only">输出方式<\/legend>/)
  assert.match(source, /class="app-export-format-grid app-export-output-mode-grid"/)
  assert.match(source, /app-export-format-option__code--split[\s\S]*?文件夹[\s\S]*?自动增量[\s\S]*?app-export-radio-check/)
})


test('朋友圈导出联系人列表只渲染视口附近节点', async () => {
  const source = await readFile(new URL('../pages/sns.vue', import.meta.url), 'utf8')

  assert.match(source, /ref="exportContactListEl"[\s\S]*?@scroll="onExportContactListScroll"/)
  assert.match(source, /v-for="\(u, virtualIndex\) in exportRenderedSnsUsers"/)
  assert.match(source, /const SNS_EXPORT_CONTACT_ROW_HEIGHT = 53/)
  assert.match(source, /const SNS_EXPORT_CONTACT_OVERSCAN = 6/)
  assert.match(source, /exportFilteredSnsUsers\.value\.slice\([\s\S]*?exportContactVirtualStartIndex\.value,[\s\S]*?exportContactVirtualEndIndex\.value/)
  assert.match(source, /exportFilteredSnsUsers\.value\.length \* SNS_EXPORT_CONTACT_ROW_HEIGHT/)
  assert.doesNotMatch(source, /v-for="u in exportFilteredSnsUsers"/)
})


test('朋友圈在焦点恢复时核对快照并保留视口位置', async () => {
  const source = await readFile(new URL('../pages/sns.vue', import.meta.url), 'utf8')

  assert.match(source, /const SNS_VISIBLE_RECONCILE_BUFFER_MIN = 20/)
  assert.match(source, /const SNS_VISIBLE_RECONCILE_WINDOW_MAX = 200/)
  assert.match(source, /mergeVisiblePostsWindow\(getSnsVisibleReconcileWindow\(\)\)/)
  assert.match(source, /scheduleSnsVisibleWindowUpdate\(\)/)
  assert.match(source, /restoreSnsScrollAnchor\(anchor\)/)
  assert.match(source, /await snsSync\.refreshView\(\)/)
  assert.doesNotMatch(source, /SNS_VISIBLE_RECONCILE_INTERVAL_MS|\/sns\/realtime\//)
})


test('朋友圈手动刷新通过独立快照服务触发采集', async () => {
  const source = await readFile(new URL('../pages/sns.vue', import.meta.url), 'utf8')
  const apiSource = await readFile(new URL('../composables/useApi.js', import.meta.url), 'utf8')
  const refresh = source.split('const refreshSnsData = async () => {', 2)[1]
    .split(/\r?\n\r?\nlet postsRequestGeneration/, 1)[0]

  assert.match(refresh, /await snsSync\.refreshOnce\(\)/)
  assert.match(apiSource, /const getSnsSnapshotStatus = async/)
  assert.doesNotMatch(apiSource, /syncSnsRealtimeLatest|startSnsFullSync|getSnsFullSyncStatus|cancelSnsFullSync/)
})


test('朋友圈导出按钮在客户端挂载后再解除禁用，避免水合残留', async () => {
  const source = await readFile(new URL('../pages/sns.vue', import.meta.url), 'utf8')

  assert.match(source, /:disabled="!isSnsPageMounted \|\| !selectedAccount"/)
  assert.match(source, /const isSnsPageMounted = ref\(false\)/)
  assert.match(source, /onMounted\(async \(\) => \{\s*isSnsPageMounted\.value = true/)
})


test('朋友圈文件夹增量导出会批量核对并补回缺失媒体', async () => {
  const source = await readFile(new URL('../pages/sns.vue', import.meta.url), 'utf8')
  const apiSource = await readFile(new URL('../composables/useApi.js', import.meta.url), 'utf8')

  assert.match(source, /const findMissingBrowserSnsManagedFiles = async \(root, baseline\)/)
  assert.match(source, /new Map\(\[\['', Promise\.resolve\(root\)\]\]\)/)
  assert.match(source, /Math\.min\(16, entries\.length\)/)
  assert.match(source, /missingFiles = await findMissingBrowserSnsManagedFiles\(root, baseline\)/)
  assert.match(source, /missing_files: missingFiles/)
  assert.match(source, /const direct = await readBrowserSnsBaselineFromRoot\(selected\)/)
  assert.match(apiSource, /missing_files: Array\.isArray\(data\.missing_files\)/)
})
