import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import AgentAnswer from '../components/chat/AgentAnswer.vue'
import { renderAgentMarkdown, copyAgentText } from '../utils/agentMarkdown'
import { scanExports } from 'unimport'
import { resolve } from 'node:path'

const source = { source: 'a'.repeat(24), username: 'group', name: '项目群', sender: '甲', time: 1, text: '甲说乙更新了图片' }
const person = { id: 'b'.repeat(24), kind: 'person', username: 'b', name: '乙', sources: [source.source], avatar_path: 'https://invalid.example/avatar' }
const picture = { id: 'c'.repeat(24), kind: 'image', source: source.source, label: '新版排期', path: '/chat/media/image?account=test&md5=1' }
const unused = { ...picture, id: 'd'.repeat(24), label: '未引用图片' }

describe('独立且经过校验的引用', () => {
  it('胶囊后重复姓名只在显示和复制时合并，不截断较长编号或代码示例', () => {
    const named = { ...person, name: '330' }
    const marker = `[[person:${named.id}]]`
    const text = `回复的是 ${marker} 330。`
    expect(renderAgentMarkdown(text, [], false, [named])).not.toContain('</button> 330')
    expect(copyAgentText(text, [], [named])).toBe('回复的是 330。')
    expect(copyAgentText(`${marker} 3300`, [], [named])).toBe('330 3300')
    expect(renderAgentMarkdown('`' + marker + ' 330`', [], false, [named])).toContain(marker + ' 330</code>')
  })
  it('头像读取失败后仍保留人物和来源编号，不显示破图', async () => {
    const withAvatar = { ...source, sender_avatar_path: '/chat/avatar?account=test&username=a' }
    const w = mount(AgentAnswer, { props: { text: `[[${source.source}]]`, citations: [withAvatar] } })
    await w.find('.agent-ref img').trigger('error')
    expect(w.find('.agent-ref img').element.style.display).toBe('none')
    expect(w.find('.agent-ref').text()).toBe('1')
    w.unmount()
  })
  it('已引用消息的发送者姓名自动显示头像标签，悬停复用聊天资料卡', async () => {
    const cited = { ...source, sender: '测试成员', sender_id: 'wxid_test_member', sender_avatar_path: '/chat/avatar?account=test&username=wxid_test_member' }
    const open = ref(false), cardId = ref('')
    const profileState = {
      contactProfileCardOpen: open,
      contactProfileCardMessageId: cardId,
      closeContactProfileCard: vi.fn(() => { open.value = false; cardId.value = '' }),
      onMentionMouseEnter: vi.fn((message, user) => { cardId.value = `mention:${message.id}:${user.username}`; open.value = true }),
      onMentionMouseLeave: vi.fn()
    }
    const w = mount(AgentAnswer, { attachTo: document.body, props: { text: `测试成员分享了面试体验。[[${source.source}]]`, citations: [cited] },
      global: { provide: { chatContactProfileState: profileState }, stubs: { Teleport: true, ContactProfileCard: { template: '<div class="profile-card-stub" />' } } } })
    const person = w.find('[data-person]')
    expect(person.text()).toBe('测试成员')
    expect(person.find('img').attributes('src')).toBe('/api/chat/avatar?account=test&username=wxid_test_member')
    await person.trigger('pointerover'); await flushPromises()
    expect(profileState.onMentionMouseEnter).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ username: 'wxid_test_member', displayName: '测试成员' }))
    expect(w.find('.profile-card-stub').exists()).toBe(true)
    await person.trigger('pointerout', { relatedTarget: document.body })
    expect(profileState.onMentionMouseLeave).toHaveBeenCalledTimes(1)
    w.unmount()
  })
  it('Nuxt 自动导入扫描只暴露实际导出，防止聊天页加载失败', async () => {
    const scanned = await scanExports(resolve('utils/agentMarkdown.js'), false)
    expect(scanned.map(item => item.name).sort()).toEqual(['copyAgentText', 'referenceUrl', 'renderAgentMarkdown'])
  })
  it('人物与发言人不同，拒绝错误种类、未知引用和任意头像 URL', () => {
    const html = renderAgentMarkdown(`[[person:${person.id}]] 已更新 [[${source.source}]] [[image:${person.id}]]`, [source], false, [person])
    expect(html).toContain(`data-person="${person.id}"`)
    expect(html).toContain('>乙</span>')
    expect(html).toContain(`data-source="${source.source}"`)
    expect(html).not.toContain('invalid.example')
    expect(html).toContain('来源待核实')
  })

  it('流式半截标记隐藏，复制结果保留可读人名与出处', () => {
    for (const tail of ['[[person:', '[[image:c', '[[source:a', '[[person:bbbb', '[[aaaa']) {
      expect(renderAgentMarkdown('正文' + tail, [source], true, [person, picture])).not.toContain('[[')
    }
    expect(copyAgentText(`[[person:${person.id}]] 更新 [[image:${picture.id}]] [[${source.source}]]`, [source], [person, picture]))
      .toBe('乙 更新 新版排期 〔项目群 · 甲〕')
  })

  it('兼容已保存草稿中的 source 前缀和分组来源，不暴露内部协议文本', () => {
    const text = `结论 [[source:${source.source}]]\n[[source:${source.source}], [source:${source.source}]]`
    const html = renderAgentMarkdown(text, [source])
    expect(html.match(/class="agent-ref"/g)).toHaveLength(3)
    expect(html).not.toContain('[[source:')
    expect(copyAgentText(text, [source])).not.toContain('[[source:')
  })

  it('停止流式回答后不暴露半截引用，继续收到尾部时恢复完整来源', async () => {
    const prefix = `已确认 [[${source.source}]]，另一项 [[35b4f`
    const w = mount(AgentAnswer, { props:{text:prefix,citations:[source],streaming:true} })
    expect(w.text()).not.toContain('[[35b4f')
    await w.setProps({streaming:false})
    expect(w.text()).not.toContain('[[35b4f')
    expect(w.findAll('.agent-ref')).toHaveLength(1)
    expect(copyAgentText(prefix,[source])).toBe('已确认 〔项目群 · 甲〕，另一项 ')
    const next = {...source,source:'35b4f'+'0'.repeat(19)}
    await w.setProps({text:prefix+'0'.repeat(19)+']]',citations:[source,next],streaming:true})
    expect(w.findAll('.agent-ref')).toHaveLength(2)
    expect(copyAgentText('```text\n字面示例 [[35b4f')).toBe('```text\n字面示例 [[35b4f')
    w.unmount()
  })

  it('正文不加载大图，查看器只浏览本回答图片且不调用模型', async () => {
    const request = vi.fn()
    vi.stubGlobal('useAiApi', () => ({ request }))
    const w = mount(AgentAnswer, { attachTo: document.body, props: { text: `排期 [[image:${picture.id}]]`, references: [picture, unused], citations: [source] }, global: { stubs: { Teleport: true } } })
    expect(w.find('.agent-markdown img').exists()).toBe(false)
    await w.find('[data-image]').trigger('click'); await flushPromises()
    const viewer = w.find('.agent-image-viewer')
    expect(viewer.text()).toContain('图片 1 / 1')
    expect(viewer.text()).not.toContain('未引用图片')
    expect(viewer.find('[aria-label="下一张图片"]').attributes('disabled')).toBeDefined()
    await viewer.find('[aria-label="放大图片"]').trigger('click')
    await flushPromises(); expect(w.find('.agent-image-viewer').text()).toContain('125%')
    await w.find('.agent-image-viewer img').trigger('error'); await flushPromises()
    expect(w.find('.agent-image-viewer').text()).toContain('图片暂不可用')
    expect(request).not.toHaveBeenCalled()
    w.unmount(); vi.unstubAllGlobals()
  })

  it('Esc 直接关闭图片查看器并阻止后方聊天接收快捷键', async () => {
    const behind = vi.fn()
    document.addEventListener('keydown', behind)
    const w = mount(AgentAnswer, { attachTo: document.body, props: {
      text: `[[image:${picture.id}]]`, references: [picture], citations: [source],
    }, global: { stubs: { Teleport: true } } })
    try {
      await w.find('[data-image]').trigger('click'); await flushPromises()
      await w.find('.agent-image-viewer [aria-label="旋转图片"]').trigger('keydown', { key: 'Escape' })
      await flushPromises()
      expect(w.find('.agent-image-viewer').exists()).toBe(false)
      expect(behind).not.toHaveBeenCalled()
    } finally {
      w.unmount()
      document.removeEventListener('keydown', behind)
    }
  })
})
