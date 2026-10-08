import { FRAME_PRESETS } from './wrapped-stage.js'

export const ECHO_EXPORT_FRAMES = FRAME_PRESETS.filter(frame => ['3:4', '9:16', '1:1', '16:9'].includes(frame.id))
const PRIVATE_KINDS = new Set([undefined, false, true, 'person', 'message', 'image'])
const escapeMarkup = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Fetch only user-selected local material. Re-encoding retains pixels without source metadata. */
export async function prepareEchoImages(candidates, { signal } = {}) {
  const sources = candidates.map(candidate => {
    if (typeof candidate.key !== 'string' || !candidate.key || typeof candidate.label !== 'string' || typeof candidate.url !== 'string' || candidate.sceneId === undefined) throw new TypeError('图片候选项缺少标签、章节或有效地址')
    const url = new URL(candidate.url, window.location.href)
    const localHttp = ['http:', 'https:'].includes(url.protocol) && (url.origin === window.location.origin || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    const localBlob = url.protocol === 'blob:' && url.origin === window.location.origin
    const rasterData = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(candidate.url)
    if (url.username || url.password || (!localHttp && !localBlob && !rasterData)) throw new TypeError('分享图片只允许本地媒体或当前应用提供的图片地址')
    return { candidate, url: url.href }
  })
  const prepared = []
  for (const { candidate, url } of sources) {
    signal?.throwIfAborted()
    const response = await fetch(url, { signal, redirect: 'error', credentials: 'same-origin' })
    if (!response.ok) throw new Error(`所选图片读取失败（HTTP ${response.status}），请检查本地素材后重试`)
    const blob = await response.blob()
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type.toLowerCase())) throw new TypeError('所选素材不是支持的 PNG、JPEG、WebP 或 GIF 图片')
    signal?.throwIfAborted()
    const image = new Image(), objectUrl = URL.createObjectURL(blob)
    try {
      image.src = objectUrl
      try { await image.decode() }
      catch (cause) { signal?.throwIfAborted(); throw new Error('所选图片解码失败，请检查本地素材后重试', { cause }) }
      signal?.throwIfAborted()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建私人图片画布，请检查浏览器图形能力后重试')
      context.drawImage(image, 0, 0)
      prepared.push({ key: candidate.key, label: candidate.label, sceneId: candidate.sceneId, imageDataUrl: canvas.toDataURL('image/png') })
    } finally { URL.revokeObjectURL(objectUrl) }
  }
  return prepared
}

function scalar(value, context) {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value
  throw new TypeError(`导出数据中的${context}必须是文本或有限数值`)
}

/** The only raw-data boundary. Never serialize a source card or spread a source row. */
export function createEchoExportDocument(document, options = {}) {
  if (!document || !Number.isInteger(document.year) || !Array.isArray(document.scenes) || !document.scenes.length) throw new TypeError('年度导出数据尚未就绪')
  if (typeof document.generatedAt !== 'string' || !Number.isFinite(Date.parse(document.generatedAt))) throw new TypeError('年度导出数据缺少有效生成时间')
  const { privacy = true, includeMessages = false, privateImages = false } = options
  if ([privacy, includeMessages, privateImages].some(value => typeof value !== 'boolean')) throw new TypeError('导出隐私选项必须是布尔值')
  if (privacy && (includeMessages || privateImages)) throw new TypeError('匿名模式不能包含聊天正文或私人图片，请先关闭匿名模式')
  const selectedIds = options.sceneIds === undefined ? document.scenes.map(s => String(s.id)) : options.sceneIds.map(String)
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !document.scenes.some(scene => String(scene.id) === id))) throw new TypeError('请至少选择一个有效章节，且不要重复选择')
  if (new Set(document.scenes.map(s => String(s.id))).size !== document.scenes.length) throw new TypeError('年度数据包含重复章节')

  function allowed(item) {
    if (!PRIVATE_KINDS.has(item.private)) throw new TypeError('导出数据包含无效私密标记')
    if (item.private && privacy) return false
    if (item.private === 'message' && !includeMessages) return false
    if ((item.private === 'image' || item.imageDataUrl !== undefined) && !privateImages) return false
    return true
  }
  function rows(items, metric = false) {
    if (!Array.isArray(items)) throw new TypeError('章节读数与明细必须是数组')
    return items.filter(allowed).map(item => {
      const row = { label: String(scalar(item.label, '标签')), value: scalar(item.value, '读数') }
      if (metric && item.unit !== undefined) row.unit = String(scalar(item.unit, '单位'))
      if (item.imageDataUrl !== undefined) {
        if (typeof item.imageDataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.imageDataUrl)) throw new TypeError('私人图片必须为内嵌 PNG、JPEG、WebP 或 GIF，不能包含远程地址或 SVG')
        row.imageDataUrl = item.imageDataUrl
      }
      return row
    })
  }
  const scenes = document.scenes.flatMap((scene, index) => {
    if (!selectedIds.includes(String(scene.id))) return []
    if (!Array.isArray(scene.details)) throw new TypeError('章节详情必须是数组')
    return [{
      id: `chapter-${index + 1}`,
      title: String(scalar(scene.title, '标题')),
      kicker: scene.kicker === undefined ? '' : String(scalar(scene.kicker, '说明')),
      summary: String(scalar(scene.summary, '摘要')),
      metrics: rows(scene.metrics, true), rows: rows(scene.rows),
      details: scene.details.filter(allowed).map(detail => ({ title: String(scalar(detail.title, '详情标题')), rows: rows(detail.rows) })),
    }]
  })
  return { version: 1, year: document.year, generatedAt: new Date(document.generatedAt).toISOString(), scope: { privacy, includeMessages, privateImages }, scenes }
}

function ellipsis(value, maxWidth) {
  let width = 0
  const result = []
  for (const char of String(value)) {
    width += /[\u0000-\u00ff]/.test(char) ? 0.58 : 1
    if (width > maxWidth) return `${result.join('')}…`
    result.push(char)
  }
  return result.join('')
}

/** Shared by the on-screen preview, PNG rasterization and archive cover. */
export function renderEchoPosterSvg(document, { frame = '3:4', sceneId = document.scenes[0]?.id } = {}) {
  const format = ECHO_EXPORT_FRAMES.find(item => item.id === frame)
  if (!format) throw new TypeError('不支持的分享画幅')
  const scene = document.scenes.find(item => item.id === sceneId)
  if (!scene) throw new TypeError('请选择已导出的章节')
  const [width, height] = format.exportSize
  const wide = width > height
  const scale = width / (wide ? 1600 : 900)
  const w = width / scale, h = height / scale
  const margin = 66
  const cx = wide ? w * .71 : w * .52, cy = wide ? h * .45 : h * .40
  const radius = wide ? 198 : Math.min(188, h * .18)
  const horizon = cy + radius * 1.22
  const startY = wide ? h * .50 : h * .69
  const contentWidth = wide ? w * .45 : w - margin * 2
  const first = scene.metrics[0]
  const extra = scene.metrics.slice(1, wide ? 3 : 4)
  const text = (x, y, value, size, attrs = '') => `<text x="${x}" y="${y}" font-size="${size}" ${attrs}>${escapeMarkup(value)}</text>`
  const metricValue = first ? ellipsis(first.value, 12) : '—'
  const numberSize = Math.min(wide ? 92 : 104, contentWidth / Math.max(4, String(metricValue).length * .62))
  const rowY = startY + numberSize + 56
  const rowCount = Math.max(0, Math.min(3, Math.floor((h - 66 - rowY) / 31)))
  const outputRows = scene.rows.slice(0, rowCount)
  const imageRow = scene.rows.find(row => row.imageDataUrl)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeMarkup(scene.title)}">
<defs>
  <linearGradient id="room" x2="0" y2="1"><stop stop-color="#e9e7d6"/><stop offset=".5" stop-color="#d4e0d5"/><stop offset="1" stop-color="#829f9d"/></linearGradient>
  <radialGradient id="pearl" cx=".3" cy=".24" r=".81"><stop stop-color="#fffaf0"/><stop offset=".3" stop-color="#e8e0e4"/><stop offset=".58" stop-color="#b7d4cc"/><stop offset=".82" stop-color="#759698"/><stop offset="1" stop-color="#34515b"/></radialGradient>
  <linearGradient id="reflection" x2="0" y2="1"><stop stop-color="#dce4d8" stop-opacity=".62"/><stop offset="1" stop-color="#84a6a2" stop-opacity="0"/></linearGradient>
  <linearGradient id="door" x2="0" y2="1"><stop stop-color="#fff9d1"/><stop offset="1" stop-color="#e6d3a4"/></linearGradient>
  <filter id="soft"><feGaussianBlur stdDeviation="12"/></filter>
</defs>
<rect width="${w}" height="${h}" fill="url(#room)"/>
<path d="M0 ${horizon} H${w} V${h} H0Z" fill="#81a7a3" opacity=".26"/>
<path d="M0 ${horizon} H${w}" stroke="#517979" opacity=".35"/>
<path d="M0 ${h} L${cx} ${horizon} L${w} ${h}" fill="none" stroke="#e0e9db" opacity=".25"/>
<rect x="${cx + radius * .7}" y="${cy - radius * .2}" width="${radius * .44}" height="${radius * 1.5}" fill="#658889" opacity=".6"/>
<rect x="${cx + radius * .73}" y="${cy - radius * .16}" width="${radius * .36}" height="${radius * 1.46}" fill="url(#door)"/>
<ellipse cx="${cx}" cy="${horizon + 18}" rx="${radius * .88}" ry="${radius * .14}" fill="#355b61" opacity=".22" filter="url(#soft)"/>
<ellipse cx="${cx}" cy="${horizon + radius * .46}" rx="${radius * .95}" ry="${radius * .53}" fill="url(#reflection)"/>
<circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#pearl)"/>
<ellipse cx="${cx}" cy="${cy}" rx="${radius * 1.22}" ry="${radius * .25}" fill="none" stroke="#faf4d6" stroke-width="1.4" opacity=".65" transform="rotate(-23 ${cx} ${cy})"/>
${imageRow ? `<image href="${escapeMarkup(imageRow.imageDataUrl)}" x="${cx - 46}" y="${cy - 46}" width="92" height="92"/>` : ''}
<g fill="#193e46" font-family="'Microsoft YaHei','PingFang SC',sans-serif">
${text(margin, 72, `${document.year}  /  回声异境`, 18, 'letter-spacing="3"')}
${text(margin, 140, ellipsis(scene.title, wide ? 15 : 13), 49, 'font-weight="600"')}
${text(margin, 179, ellipsis(scene.summary, wide ? 28 : 31), 19, 'fill="#385a5e"')}
${first ? text(margin, startY, ellipsis(first.label, 24), 19) : text(margin, startY, '本章未收录公开读数', 19)}
${text(margin - 3, startY + numberSize + 8, metricValue, numberSize, 'font-weight="500"')}
${first?.unit ? text(margin + Math.min(contentWidth - 45, String(metricValue).length * numberSize * .6 + 12), startY + numberSize + 6, ellipsis(first.unit, 7), 20) : ''}
${extra.map((item, i) => text(margin + i * (contentWidth / extra.length), rowY, ellipsis(`${item.label} ${item.value}${item.unit || ''}`, wide ? 18 : 13), 17)).join('')}
${outputRows.map((row, i) => text(margin, rowY + 37 + i * 29, ellipsis(`${row.label}  ${row.value}`, wide ? 35 : 37), 17, 'fill="#31565b"')).join('')}
<path d="M${margin} ${h - 53} H${w - margin}" stroke="#345d61" opacity=".4"/>
${text(margin, h - 28, document.scope.privacy ? '匿名摘要 · 所选年度统计' : '含所选私密内容 · 请自行确认分享范围', 13)}
${text(w - margin, h - 28, 'xwechat / ECHOES', 13, 'text-anchor="end" letter-spacing="1"')}
</g></svg>`
}

export async function exportEchoPosterPng(documentModel, options) {
  await decodeExportImages(documentModel)
  await document.fonts.ready
  const svg = renderEchoPosterSvg(documentModel, options)
  const sourceUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    image.src = sourceUrl
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建海报画布，请检查浏览器图形能力后重试')
    context.drawImage(image, 0, 0)
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败，请重试')), 'image/png'))
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

async function decodeExportImages(document) {
  const images = new Set(document.scenes.flatMap(scene => [...scene.metrics, ...scene.rows, ...scene.details.flatMap(detail => detail.rows)]).filter(row => row.imageDataUrl).map(row => row.imageDataUrl))
  await Promise.all([...images].map(async source => {
    const image = new Image()
    image.src = source
    try { await image.decode() }
    catch (cause) { throw new Error('所选私人图片解码失败，请移除损坏素材或关闭私人图片后重试', { cause }) }
  }))
}

export async function createEchoArchiveBlob(document) {
  await decodeExportImages(document)
  return new Blob([createEchoArchiveHtml(document)], { type: 'text/html;charset=utf-8' })
}

const archiveRow = row => `<div class="reading-row" data-search-row><dt>${escapeMarkup(row.label)}</dt><dd>${escapeMarkup(row.value)}${escapeMarkup(row.unit || '')}${row.imageDataUrl ? `<img src="${escapeMarkup(row.imageDataUrl)}" alt="${escapeMarkup(row.label)}" loading="lazy">` : ''}</dd></div>`

/** Fully local reading artifact. The only script is fixed code; all user text is escaped markup. */
export function createEchoArchiveHtml(document) {
  const scope = document.scope
  const chapters = document.scenes.map((scene, index) => `<article id="${scene.id}" ${index ? 'hidden' : ''}>
    <div class="chapter-cover">${renderEchoPosterSvg(document, { frame: '16:9', sceneId: scene.id })}</div>
    <h2>${escapeMarkup(scene.title)}</h2><p class="summary">${escapeMarkup(scene.summary)}</p>
    ${scene.kicker ? `<p class="explanation">${escapeMarkup(scene.kicker)}</p>` : ''}
    <dl class="metrics">${scene.metrics.map(archiveRow).join('')}</dl>
    <dl>${scene.rows.map(archiveRow).join('')}</dl>
    ${scene.details.map(detail => `<details><summary>${escapeMarkup(detail.title)} · ${detail.rows.length} 项</summary><dl>${detail.rows.map(archiveRow).join('')}</dl></details>`).join('')}
  </article>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'">
<title>${document.year} · 回声异境阅读档案</title>
<style>
:root{color-scheme:light;--ink:#24484d;--paper:#f5f4e9;--line:#c2cec5;--sub:#4c6967}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.7 'Microsoft YaHei','PingFang SC',sans-serif}button,input{font:inherit;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #a34b3e;outline-offset:4px}::selection{background:#cbdfd3}header{max-width:1180px;margin:auto;padding:38px 32px 24px}h1{margin:0;font-size:clamp(26px,5vw,44px);font-weight:600}header p{max-width:72ch;margin:10px 0;color:var(--sub)}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:36px;max-width:1180px;padding:12px 32px 60px;margin:auto}aside{align-self:start;position:sticky;top:24px}nav{display:grid;gap:2px}nav button{background:transparent;border:0;text-align:left;padding:10px 12px;border-radius:4px;font-size:14px}nav button[aria-current="true"]{background:#dce8dd;color:#163f44}nav button:hover{background:#e2e9e0}input{width:100%;background:#fffef7;border:1px solid #8aaba1;border-radius:4px;padding:10px 12px;margin:7px 0}.search-label{font-size:13px}.scope{border-top:1px solid var(--line);font-size:12px;margin-top:20px;padding-top:14px;color:var(--sub)}.scope p{margin:6px 0}.chapter-cover svg{width:100%;height:auto;display:block}.chapter-cover{overflow:hidden;border-radius:4px}h2{margin:26px 0 8px;font-size:28px}p{overflow-wrap:anywhere}.summary{margin:0 0 10px}.explanation{color:var(--sub);font-size:14px}dl{margin:12px 0 26px}.reading-row{display:grid;grid-template-columns:minmax(90px,1fr) minmax(0,2fr);gap:20px;border-bottom:1px solid var(--line);padding:11px 0;overflow-wrap:anywhere}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;white-space:pre-wrap}dt{color:var(--sub);white-space:pre-wrap}.metrics{background:#e6ede2;padding:0 16px}.metrics .reading-row:last-child{border:0}dd img{display:block;max-width:180px;max-height:180px;margin:10px 0 0 auto}details{border-top:1px solid var(--line);padding:16px 0}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}#search-status{font-size:13px;min-height:22px}.page-actions{display:flex;justify-content:space-between;border-top:1px solid var(--line);margin-top:32px;padding-top:20px}.page-actions button{border:1px solid #78958d;background:transparent;border-radius:4px;padding:8px 16px}.page-actions button:disabled{opacity:.45;cursor:default}[hidden]{display:none!important}article+article{margin-top:38px}footer{max-width:1180px;margin:auto;padding:0 32px 30px;font-size:12px;color:var(--sub)}@media(max-width:700px){header{padding:22px 20px 12px}.layout{display:block;padding:8px 20px 36px}aside{position:static}nav{display:flex;overflow:auto;gap:5px;margin:14px 0 20px}nav button{flex-shrink:0}.scope{margin-top:8px}.chapter-cover{margin-top:24px}.reading-row{gap:12px;grid-template-columns:1fr 1.6fr}h2{font-size:25px}footer{padding:0 20px 24px}}@media print{aside,.page-actions{display:none}.layout{display:block}article[hidden]{display:block!important}details>dl{display:block!important}article{break-before:page}}
</style></head><body>
<header><h1>${document.year}，回声仍在这里。</h1><p>这是一份可离线阅读的年度档案。静态场景与读数保留所选章节；展开明细、切换章节或搜索其中保存的数据。</p></header>
<div class="layout"><aside><label class="search-label" for="archive-search">搜索已保存的读数与明细</label><input id="archive-search" type="search" placeholder="日期、标签、已选入的文字" autocomplete="off"><p id="search-status" role="status"></p>
<nav aria-label="章节目录">${document.scenes.map((scene, i) => `<button type="button" data-chapter-button="${i}" aria-controls="${scene.id}" aria-current="${i === 0}">${escapeMarkup(scene.title)}</button>`).join('')}</nav>
<div class="scope"><strong>此文件包含</strong><p>${document.scenes.length} 章 · 标题、统计口径、读数与所选明细</p><p>人物信息：${scope.privacy ? '已移除' : '已按选择保留'}<br>聊天正文：${scope.includeMessages ? '已按选择保留' : '未包含'}<br>私人图片：${scope.privateImages ? '已内嵌所选图片' : '未包含'}</p><p>不包含账号标识、数据库路径或本机消息定位信息。仅能浏览此文件已保存的数据。</p></div></aside>
<main>${chapters}<div class="page-actions"><button id="previous" type="button">上一章</button><button id="next" type="button">下一章</button></div></main></div>
<footer>封存于 ${escapeMarkup(document.generatedAt)} · xwechat 回声异境 · 本地阅读档案</footer>
<script>
(()=>{'use strict';const articles=[...document.querySelectorAll('main article')],buttons=[...document.querySelectorAll('[data-chapter-button]')],search=document.querySelector('#archive-search'),status=document.querySelector('#search-status'),previous=document.querySelector('#previous'),next=document.querySelector('#next');let active=0;
function choose(index){active=index;search.value='';status.textContent='';articles.forEach((article,i)=>{article.hidden=i!==active;article.querySelectorAll('[data-search-row]').forEach(row=>row.hidden=false);article.querySelectorAll('details').forEach(detail=>detail.hidden=false)});buttons.forEach((button,i)=>button.setAttribute('aria-current',String(i===active)));previous.disabled=active===0;next.disabled=active===articles.length-1}
buttons.forEach((button,i)=>button.addEventListener('click',()=>choose(i)));previous.addEventListener('click',()=>choose(active-1));next.addEventListener('click',()=>choose(active+1));
search.addEventListener('input',()=>{const query=search.value.trim().toLocaleLowerCase();if(!query){choose(active);return}let total=0;articles.forEach(article=>{let count=0;article.querySelectorAll('[data-search-row]').forEach(row=>{row.hidden=![...row.children].map(cell=>cell.textContent).join(' ').toLocaleLowerCase().includes(query);if(!row.hidden)count++});article.querySelectorAll('details').forEach(detail=>{detail.hidden=!detail.querySelector('[data-search-row]:not([hidden])');detail.open=true});article.hidden=count===0;total+=count});buttons.forEach(button=>button.setAttribute('aria-current','false'));status.textContent=total?'找到 '+total+' 项，已显示所有匹配章节':'此档案中没有匹配的读数或明细';previous.disabled=true;next.disabled=true});choose(0)})();
</script></body></html>`
}

export function downloadEchoBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  try { link.click() } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000) }
}
