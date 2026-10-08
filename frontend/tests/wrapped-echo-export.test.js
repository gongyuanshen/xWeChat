import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { Window } from 'happy-dom'
import EchoSharePanel from '../components/wrapped/echo/EchoSharePanel.vue'
import * as exportModule from '../lib/wrapped-echo-export.js'
import {
  createEchoExportDocument,
  createEchoArchiveHtml,
  createEchoArchiveBlob,
  exportEchoPosterPng,
  prepareEchoImages,
  renderEchoPosterSvg,
} from '../lib/wrapped-echo-export.js'

const input = () => ({
  year: 2025,
  generatedAt: '2026-10-08T12:00:00.000Z',
  account: 'wxid-secret-account',
  scenes: Array.from({ length: 10 }, (_, i) => ({
    id: i, title: `章节 ${i + 1}`, kicker: '回声异境', summary: '仅来自所选年度统计',
    username: 'wxid-secret-person', source: { path: 'C:/private/messages.db', anchor: 'db:table:123' },
    metrics: [{ label: '本人发送', value: 0, unit: '条' }],
    rows: [
      { label: '公开数量', value: 12 },
      { label: '深夜伙伴', value: '秘密昵称甲', private: 'person' },
      { label: '短句', value: '秘密聊天正文乙', private: 'message' },
      { label: '通用私密', value: '秘密丙', private: true },
      { label: '私人素材丁', value: 1, private: 'image', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
    details: [{ title: '记录统计', rows: Array.from({ length: 132 }, (_, n) => ({ label: `日期 ${n}`, value: n })) },
      { title: '秘密标题戊', private: 'person', rows: [{ label: '回复', value: 2 }] }],
  })),
})

describe('echo export privacy boundary', () => {
  it('refuses non-local image candidates before requesting them', async () => {
    const network = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(prepareEchoImages([{ key: 'remote', label: '图片', sceneId: 6, url: 'https://untrusted.example/private.png' }])).rejects.toThrow(/本地/)
      expect(network).not.toHaveBeenCalled()
    } finally { network.mockRestore() }
  })
  it('removes private values and non-allowlisted identifiers before any rendering and retains zero', () => {
    const source = input()
    const result = createEchoExportDocument(source)
    const serialized = JSON.stringify(result)
    expect(result.scenes).toHaveLength(10)
    expect(result.scenes[0].metrics[0].value).toBe(0)
    expect(result.scenes[0].details[0].rows).toHaveLength(132)
    for (const secret of ['秘密', 'wxid-', 'messages.db', 'db:table:123', 'imageDataUrl']) expect(serialized).not.toContain(secret)
    expect(source.scenes[0].rows).toHaveLength(5)
  })

  it('requires separate opt-in for message text and raster material when names are included', () => {
    const named = JSON.stringify(createEchoExportDocument(input(), { privacy: false }))
    expect(named).toContain('秘密昵称甲')
    expect(named).not.toContain('秘密聊天正文乙')
    expect(named).not.toContain('私人素材丁')
    const explicit = JSON.stringify(createEchoExportDocument(input(), { privacy: false, includeMessages: true, privateImages: true }))
    expect(explicit).toContain('秘密聊天正文乙')
    expect(explicit).toContain('data:image/png;base64,')
    expect(() => createEchoExportDocument(input(), { includeMessages: true })).toThrow(/匿名/)
    expect(() => createEchoExportDocument(input(), { privateImages: true })).toThrow(/匿名/)
  })

  it('selects requested chapters and rejects missing data, unknown selections and invalid privacy markers', () => {
    expect(createEchoExportDocument(input(), { sceneIds: [2, 8] }).scenes.map(s => s.title)).toEqual(['章节 3', '章节 9'])
    expect(() => createEchoExportDocument(null)).toThrow(/数据/)
    expect(() => createEchoExportDocument(input(), { sceneIds: [] })).toThrow(/章节/)
    expect(() => createEchoExportDocument(input(), { sceneIds: [77] })).toThrow(/章节/)
    const source = input()
    source.scenes[0].rows[0].private = 'unknown'
    expect(() => createEchoExportDocument(source)).toThrow(/私密/)
  })

  it('rejects remote and SVG material at the export boundary', () => {
    for (const imageDataUrl of ['https://private.test/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///private.png']) {
      const source = input()
      source.scenes[0].rows[4].imageDataUrl = imageDataUrl
      expect(() => createEchoExportDocument(source, { privacy: false, privateImages: true })).toThrow(/图片/)
    }
  })
})

describe('echo independent poster and offline archive', () => {
  it('stops both file outputs when an opted-in embedded image cannot decode', async () => {
    const doc = createEchoExportDocument(input(), { privacy: false, privateImages: true })
    vi.stubGlobal('Image', class { decode() { return Promise.reject(new Error('corrupt raster')) } })
    try {
      await expect(createEchoArchiveBlob(doc)).rejects.toThrow(/图片/)
      await expect(exportEchoPosterPng(doc)).rejects.toThrow(/图片/)
    } finally { vi.unstubAllGlobals() }
  })

  it.each([['3:4', 1080, 1440], ['9:16', 1080, 1920], ['1:1', 1080, 1080], ['16:9', 1920, 1080]])('renders the actual output dimensions for %s and never drops zero', (frame, width, height) => {
    const svg = renderEchoPosterSvg(createEchoExportDocument(input()), { frame })
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(parsed.documentElement.getAttribute('width')).toBe(String(width))
    expect(parsed.documentElement.getAttribute('height')).toBe(String(height))
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect([...parsed.querySelectorAll('text')].some(el => el.textContent === '0')).toBe(true)
    expect(svg).not.toContain('秘密')
  })

  it('escapes hostile labels as text and keeps the entire selected detail dataset offline', async () => {
    const source = input()
    source.scenes[0].rows[0].label = '</script><img src="https://evil.test/leak" onerror="window.pwned=1">\u2028\u2029&'
    source.scenes[0].title = '<svg onload="window.pwned=1">'
    const doc = createEchoExportDocument(source)
    const html = createEchoArchiveHtml(doc)
    const sandbox = new Window({ settings: { enableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } })
    sandbox.document.write(html)
    await sandbox.happyDOM.waitUntilComplete()
    expect(sandbox.pwned).toBeUndefined()
    expect(sandbox.document.querySelectorAll('main article')).toHaveLength(10)
    expect(sandbox.document.body.textContent).toContain('日期 131')
    expect(sandbox.document.querySelectorAll('script[src],link[href],iframe,object,embed,img[src^="http"]')).toHaveLength(0)
    expect(html).not.toContain('秘密')
    expect(html).not.toContain('wxid-')
    const navigation = sandbox.document.querySelectorAll('[data-chapter-button]')
    navigation[8].click()
    expect(sandbox.document.querySelector('article:not([hidden]) h2').textContent).toBe('章节 9')
    const search = sandbox.document.querySelector('input[type="search"]')
    search.value = '日期 131'
    search.dispatchEvent(new sandbox.Event('input', { bubbles: true }))
    expect(sandbox.document.querySelectorAll('[data-search-row]:not([hidden])')).toHaveLength(10)
    await sandbox.happyDOM.abort()
  })

  it('limits poster text while the archive retains the unabridged detail', () => {
    const source = input()
    source.scenes[0].summary = '极长正文'.repeat(200)
    const doc = createEchoExportDocument(source)
    expect(renderEchoPosterSvg(doc)).not.toContain(source.scenes[0].summary)
    expect(createEchoArchiveHtml(doc)).toContain(source.scenes[0].summary)
  })
})

describe('echo share panel', () => {
  let wrapper
  afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks() })
  it('does not invent a preview before data is ready and preserves the explicit privacy gates', async () => {
    wrapper = mount(EchoSharePanel, { props: { document: null, busy: true } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.findAll('.echo-export-actions button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
    await wrapper.setProps({ document: input(), busy: false })
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.findAll('fieldset').every(fieldset => !fieldset.element.disabled)).toBe(true)
    expect(wrapper.find('.echo-close').element.disabled).toBe(false)
    expect(wrapper.find('[data-control="privacy"]').element.checked).toBe(true)
    expect(wrapper.find('[data-control="messages"]').element.disabled).toBe(true)
    expect(decodeURIComponent(wrapper.find('img').attributes('src'))).not.toContain('秘密')
    await wrapper.find('[data-control="privacy"]').setValue(false)
    expect(wrapper.find('[data-control="messages"]').element.disabled).toBe(false)
    await wrapper.find('[data-control="messages"]').setValue(true)
    expect(wrapper.find('[data-control="messages"]').element.checked).toBe(true)
    await wrapper.find('[data-control="privacy"]').setValue(true)
    expect(wrapper.find('[data-control="messages"]').element.checked).toBe(false)
    expect(wrapper.find('[data-control="messages"]').element.disabled).toBe(true)
  })

  it('surfaces actual PNG failures and permits the user to retry explicitly', async () => {
    vi.spyOn(exportModule, 'exportEchoPosterPng').mockRejectedValue(new Error('PNG 编码不可用'))
    wrapper = mount(EchoSharePanel, { props: { document: input() } })
    await wrapper.find('.echo-primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('PNG 编码不可用')
    expect(wrapper.emitted('error')[0][0].message).toBe('PNG 编码不可用')
    expect(wrapper.find('.echo-primary').element.disabled).toBe(false)
    expect(wrapper.text()).not.toContain('已生成并交给浏览器')
  })

  it('prepares only explicitly chosen images and invalidates pending material when the source document changes', async () => {
    let finish
    const task = new Promise(resolve => { finish = resolve })
    const prepare = vi.spyOn(exportModule, 'prepareEchoImages').mockReturnValue(task)
    const candidates = [{ key: 'one', label: '候选私密图片甲', url: '/api/local-image', sceneId: 6 }]
    wrapper = mount(EchoSharePanel, { props: { document: input(), imageCandidates: candidates } })
    expect(wrapper.html()).not.toContain('候选私密图片甲')
    expect(prepare).not.toHaveBeenCalled()
    await wrapper.find('[data-control="privacy"]').setValue(false)
    await wrapper.find('[data-control="images"]').setValue(true)
    await wrapper.find('[data-image-candidate]').setValue(true)
    expect(wrapper.find('.echo-primary').element.disabled).toBe(true)
    expect(prepare).not.toHaveBeenCalled()
    await wrapper.find('[data-prepare-images]').trigger('click')
    expect(prepare).toHaveBeenCalledTimes(1)
    const signal = prepare.mock.calls[0][1].signal
    await wrapper.setProps({ document: { ...input(), year: 2024 } })
    expect(signal.aborted).toBe(true)
    finish([{ key: 'one', sceneId: 6, label: '旧私密图片', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }])
    await flushPromises()
    expect(wrapper.html()).not.toContain('旧私密图片')
    expect(wrapper.find('[data-control="privacy"]').element.checked).toBe(true)
    expect(wrapper.find('.echo-primary').element.disabled).toBe(false)
  })
})
