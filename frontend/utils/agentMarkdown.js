import MarkdownIt from 'markdown-it'

// 在 Markdown 文本节点中解析来源，避免把代码块或代码示例误变成按钮。
const md = new MarkdownIt({ html: false, linkify: false, breaks: true })
md.renderer.rules.image = () => '[图片]'
md.renderer.rules.link_open = () => '<span>'
md.renderer.rules.link_close = () => '</span>'
const citation = /\[\[(?:(person|image|source):)?([a-f0-9]{24})\]\]|\(\s*source\s*:\s*([a-f0-9]{24})\s*\)|（\s*source\s*[:：]\s*([a-f0-9]{24})\s*）|\[source\s*:\s*([a-f0-9]{24})\]/gi
const groupedCitation = /\[\[\s*(?:source\s*:\s*)?[a-f0-9]{24}\s*(?:\]\s*[,，]\s*\[\s*(?:source\s*:\s*)?[a-f0-9]{24}\s*)+\]\]/gi
const unfinished = /(?:\[\[(?:(?:p|pe|per|pers|perso|person|i|im|ima|imag|image|s|so|sou|sour|sourc|source):?)?[a-f0-9]{0,24}\]?|[（(]\s*(?:s|so|sou|sour|sourc|source)(?:\s*[:：]\s*[a-f0-9]{0,24})?)$/i
const normalizeGroupedCitations = (content, citations) => content.replace(groupedCitation, value => {
  const ids = [...value.matchAll(/[a-f0-9]{24}/gi)].map(match => match[0].toLowerCase())
  return ids.every(id => citations.some(item => item.source === id)) ? ids.map(id => `[[${id}]]`).join(' ') : value
})
// 胶囊已显示姓名，紧接着重复的同一姓名仅在显示与复制时合并，不重写历史回答。
function afterRepeatedPersonName(content, offset, reference) {
  if (!reference?.name) return offset
  const spaces = content.slice(offset).match(/^[ \t]*/)[0].length
  const start = offset + spaces
  if (!content.startsWith(reference.name, start)) return offset
  const end = start + reference.name.length
  // 不裁掉较长姓名、编号或词的一部分，例如 3300、乙方。
  return !content[end] || !/[\p{L}\p{N}_]/u.test(content[end]) ? end : offset
}

const personButton = (reference, id, apiBase) => {
  const avatar = referenceUrl(reference.avatar_path, apiBase)
  return `<button type="button" class="agent-person" data-person="${id}" aria-haspopup="dialog" aria-label="查看人物 ${md.utils.escapeHtml(reference.name)}">${avatar ? `<img src="${md.utils.escapeHtml(avatar)}" alt="" loading="lazy" />` : ''}<span>${md.utils.escapeHtml(reference.name)}</span></button>`
}

const personNames = references => {
  const matches = new Map()
  for (const reference of references) {
    if (reference?.kind !== 'person' || !reference.id || !reference.name) continue
    for (const raw of [reference.name, ...(reference.aliases || [])]) {
      const name = String(raw || '').trim()
      if (name.length < 2) continue
      const people = matches.get(name) || new Map()
      people.set(reference.username || reference.id, reference)
      matches.set(name, people)
    }
  }
  return [...matches.entries()]
    .filter(([, people]) => people.size === 1)
    .map(([name, people]) => ({ name, reference: people.values().next().value }))
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name))
}

const hasAsciiBoundary = (content, index, name) => {
  const edge = /[A-Za-z0-9_]/
  const before = content[index - 1], after = content[index + name.length]
  return !(edge.test(name[0]) && before && edge.test(before))
    && !(edge.test(name.at(-1)) && after && edge.test(after))
}

function linkPersonNames(token, state) {
  const names = state.env.personNames || []
  if (!names.length || !token.content) return [token]
  const parts = []
  const text = value => { if (value) { const item = new state.Token('text', '', 0); item.content = value; parts.push(item) } }
  let offset = 0
  while (offset < token.content.length) {
    let found = null
    for (const candidate of names) {
      let index = token.content.indexOf(candidate.name, offset)
      while (index >= 0 && !hasAsciiBoundary(token.content, index, candidate.name)) {
        index = token.content.indexOf(candidate.name, index + candidate.name.length)
      }
      if (index < 0) continue
      if (!found || index < found.index || (index === found.index && candidate.name.length > found.name.length)) {
        found = { ...candidate, index }
      }
    }
    if (!found) break
    text(token.content.slice(offset, found.index))
    const person = new state.Token('html_inline', '', 0)
    person.content = personButton(found.reference, found.reference.id, state.env.apiBase)
    parts.push(person)
    offset = found.index + found.name.length
  }
  if (!parts.length) return [token]
  text(token.content.slice(offset))
  return parts
}

md.core.ruler.after('inline', 'agent_citation', state => {
  for (const block of state.tokens) {
    if (block.type !== 'inline') continue
    const resolved = block.children.flatMap(token => {
      if (token.type !== 'text') return [token]
      // 停止或断线后仍隐藏半截协议标记；完整原始正文留在检查点供继续接写。
      const content = normalizeGroupedCitations(token.content, state.env.citations).replace(unfinished, '')
      const parts = [], text = value => { if (value) { const t = new state.Token('text', '', 0); t.content = value; parts.push(t) } }
      let offset = 0
      for (const match of content.matchAll(citation)) {
        text(content.slice(offset, match.index))
        const kind = (match[1] || 'source').toLowerCase()
        const id = match.slice(2).find(Boolean).toLowerCase()
        const ref = new state.Token('html_inline', '', 0)
        const reference = state.env.references.find(item => item.id === id && item.kind === kind)
        if (kind === 'person' && reference) {
          ref.content = personButton(reference, id, state.env.apiBase)
        } else if (kind === 'image' && reference) {
          ref.content = `<button type="button" class="agent-image-ref" data-image="${id}" aria-haspopup="dialog"><span aria-hidden="true">▧</span> ${md.utils.escapeHtml(reference.label || '图片')}</button>`
        } else if (kind === 'source' && state.env.citations.some(item => item.source === id)) {
          if (!state.env.ids.includes(id)) state.env.ids.push(id)
          const number = state.env.ids.indexOf(id) + 1
          const source = state.env.citations.find(item => item.source === id)
          const avatar = referenceUrl(source.sender_avatar_path, state.env.apiBase)
          ref.content = `<button type="button" class="agent-ref" data-source="${id}" aria-haspopup="dialog" aria-expanded="false" aria-label="查看来源 ${number}">${avatar ? `<img src="${md.utils.escapeHtml(avatar)}" alt="" loading="lazy" />` : ''}<span>${number}</span></button>`
        } else ref.content = '<span class="agent-ref-unresolved">[来源待核实]</span>'
        parts.push(ref)
        offset = match.index + match[0].length
        if (kind === 'person') offset = afterRepeatedPersonName(content, offset, reference)
      }
      text(content.slice(offset))
      return parts
    })
    block.children = resolved.flatMap(token => token.type === 'text' ? linkPersonNames(token, state) : [token])
  }
})

// 仅接受后端生成的媒体路由，不把模型输出的 URL 变为网络请求。
export function referenceUrl(path, apiBase = '/api') {
  return typeof path === 'string' && /^\/chat\/(?:avatar|media\/image)\?/.test(path) ? `${apiBase}${path}` : ''
}
export function renderAgentMarkdown(text, citations = [], streaming = false, references = [], apiBase = '/api') {
  return md.render(text || '', { citations, streaming, references, apiBase, ids: [], personNames: personNames(references) })
}
export function copyAgentText(text, citations = [], references = []) {
  let content = normalizeGroupedCitations(text || '', citations)
  // 仅清理普通 Markdown 正文末尾，代码块里的字面协议示例保持原样。
  const last = md.parse(content, { citations: [], references: [], ids: [] }).filter(token => token.nesting !== -1).at(-1)
  if (last?.type === 'inline') content = content.replace(unfinished, '')
  const parts = []
  let offset = 0
  for (const match of content.matchAll(/\[\[(?:(person|image|source):)?([a-f0-9]{24})\]\]/gi)) {
    const [, kind, id] = match
    parts.push(content.slice(offset, match.index))
    offset = match.index + match[0].length
    if (kind && kind.toLowerCase() !== 'source') {
      const ref = references.find(r => r.id === id.toLowerCase() && r.kind === kind.toLowerCase())
      parts.push(ref?.name || ref?.label || '[引用待核实]')
      if (kind.toLowerCase() === 'person') offset = afterRepeatedPersonName(content, offset, ref)
    } else {
      const source = citations.find(c => c.source === id.toLowerCase())
      parts.push(source ? `〔${source.name || source.username} · ${source.sender || ''}〕` : '[来源待核实]')
    }
  }
  parts.push(content.slice(offset))
  return parts.join('')
}
