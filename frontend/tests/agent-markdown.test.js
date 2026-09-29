import { describe, expect, it } from 'vitest'
import { renderAgentMarkdown } from '../utils/agentMarkdown'

const id = '622367649b6ca270ffad893a'
const citations = [{ source: id }]
describe('流式来源标记', () => {
  it('标准引用和模型 source 写法都转为已验证的同一编号', () => {
    const html = renderAgentMarkdown(`**周三** (source: ${id})，核对 [[${id}]]，确认（source：${id}）`, citations)
    expect(html.match(/class="agent-ref"/g)).toHaveLength(3)
    expect(html.match(/查看来源 1/g)).toHaveLength(3)
    expect(html).toContain('<strong>周三</strong>')
    expect(html).not.toContain('(source:')
  })
  it('逐字符流入引用时不闪现内部 ID，闭合后才出现按钮', () => {
    for (const marker of [`[[${id}]]`, `(source: ${id})`]) {
      for (let i = 2; i < marker.length; i++) {
        const html = renderAgentMarkdown(`周三 ${marker.slice(0, i)}`, citations, true)
        expect(html).not.toContain(id.slice(0, 4))
        expect(html).not.toContain('source:')
        expect(html).not.toContain('agent-ref"')
      }
      expect(renderAgentMarkdown(`周三 ${marker}`, citations, true)).toContain('查看来源 1')
    }
  })
  it('未验证来源不生成按钮，不执行 HTML，也不把代码示例当引用', () => {
    const html = renderAgentMarkdown(`(source: ${id}) <img src=x onerror=alert(1)>`, [])
    expect(html).toContain('[来源待核实]')
    expect(html).not.toContain(id)
    expect(html).not.toContain('<img')
    const code = renderAgentMarkdown('`[[' + id + ']]`\n\n```\n(source: ' + id + ')\n```', citations)
    expect(code).not.toContain('agent-ref')
    expect(code).toContain('<code>')
  })
})
