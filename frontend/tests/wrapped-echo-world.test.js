import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import * as THREE from 'three'
import { createEchoWorld, prepareEchoData } from '../lib/wrapped-echo-world.js'
import EchoWorld from '../components/wrapped/echo/EchoWorld.vue'

// WebGL is unavailable in happy-dom. Keep real Three geometry/materials and
// replace only the GPU boundary; browser acceptance checks the rendered pixels.
const gpu = vi.hoisted(() => ({ scene: null, images: [], fail: null, renders: 0, renderFailure: null }))
vi.mock('three', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, WebGLRenderer: class {
    constructor() { if (gpu.fail) throw gpu.fail; this.debug = {}; this.info = { autoReset: false, reset() {}, render: { calls: 1, triangles: 1 } } }
    setPixelRatio() {} setSize() {} dispose() {} getContext() { return { finish() {} } }
  }, TextureLoader: class {
    load(url, success, progress, failure) { const texture = new actual.Texture(); gpu.images.push({ url, success, failure, texture }); return texture }
  } }
})
vi.mock('three/addons/postprocessing/EffectComposer.js', () => ({ EffectComposer: class {
  addPass(pass) { if (pass.scene) gpu.scene = pass.scene } setSize() {} dispose() {}
  render() { if (gpu.renderFailure) throw gpu.renderFailure; gpu.renders++ }
} }))
vi.mock('three/addons/postprocessing/UnrealBloomPass.js', () => ({ UnrealBloomPass: class { dispose() {} } }))
vi.mock('three/addons/postprocessing/OutputPass.js', () => ({ OutputPass: class { dispose() {} } }))

const empty = () => ({ months: [], hours: [], contacts: [], phrases: [], emojis: [] })
const data = () => ({
  ...empty(), months: [{ month: 2, days: 29, counts: Array.from({ length: 29 }, (_, i) => i === 28 ? 9 : 0) }],
  contacts: [{ username: 'private-account', displayName: '真实昵称' }],
  phrases: [{ word: '真实短句', count: 3 }],
  emojis: [{ key: 'private-emoji', label: '私人表情', url: '/api/local.png', count: 2 }],
})

describe('echo world data boundary', () => {
  it('validates actual calendar days and keeps empty collections empty', () => {
    expect(prepareEchoData(2024, data(), false).months[0].counts[28]).toBe(9)
    expect(() => prepareEchoData(2023, data(), false)).toThrow(/日|日期/)
    expect(prepareEchoData(2024, empty(), false)).toEqual(empty())
    expect(() => prepareEchoData(2024, { ...empty(), hours: [1] }, false)).toThrow(/24/)
    expect(() => prepareEchoData(2024, { ...empty(), phrases: [{ word: 'x', count: -1 }] }, false)).toThrow()
  })

  it('removes private content before any canvas label or image request is built', () => {
    const privateView = JSON.stringify(prepareEchoData(2024, data(), true))
    for (const secret of ['真实昵称', '真实短句', 'private-account', 'private-emoji', '/api/local.png', '私人表情']) expect(privateView).not.toContain(secret)
    expect(prepareEchoData(2024, data(), false).contacts[0]).toEqual({ displayName: '真实昵称' })
  })
})

describe('echo world lifecycle', () => {
  let world, frames, hidden, reduced, context, nextId
  beforeEach(() => {
    gpu.scene = null; gpu.images = []; gpu.fail = null; gpu.renders = 0; gpu.renderFailure = null
    frames = new Map(); hidden = false; reduced = false; nextId = 0
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    Object.defineProperty(document, 'fonts', { configurable: true, get: () => ({ ready: Promise.resolve() }) })
    vi.stubGlobal('requestAnimationFrame', cb => { frames.set(++nextId, cb); return nextId })
    vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id))
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ get matches() { return reduced }, addEventListener() {}, removeEventListener() {} }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600 })
    context = new Proxy({ fillText: vi.fn(), measureText: text => ({ width: String(text).length * 60 }) }, { get: (target, key) => key in target ? target[key] : () => {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
  })
  afterEach(() => { world?.dispose(); world = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.fonts })
  const create = (overrides = {}) => { world = createEchoWorld(document.createElement('canvas'), { year: 2024, data: data(), motion: true, ...overrides }); return world }
  const objects = test => { const list = []; gpu.scene.traverse(object => { if (test(object)) list.push(object) }); return list }
  const pointerEvent = (type, x, y, target = window) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }))

  it('rotates only the memory body on deliberate drag while paused, with no inertia and a reset', () => {
    const onPick = vi.fn(); create({ motion: false, onPick }); world.setScene(8)
    const chapter = objects(o => o.userData.pick?.kind === 'chapter')[0]
    const orbit = chapter.parent
    const rotation = orbit.rotation.clone(); const roomRotation = gpu.scene.children[0].rotation.clone()
    vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects').mockReturnValue([{ object: chapter }])
    pointerEvent('pointerdown', 400, 300); pointerEvent('pointermove', 402, 301)
    expect(orbit.rotation.equals(rotation)).toBe(true)
    pointerEvent('pointermove', 460, 320); pointerEvent('pointerup', 460, 320)
    expect(orbit.rotation.equals(rotation)).toBe(false)
    expect(gpu.scene.children[0].rotation.equals(roomRotation)).toBe(true)
    expect(frames.size).toBe(0); expect(onPick).not.toHaveBeenCalled()
    world.resetView(); expect(orbit.rotation.equals(rotation)).toBe(true)
  })

  it('nudges only the hit emoji under reduced motion, blocks UI drags, and keeps capture framing deterministic', async () => {
    reduced = true
    const input = data(); input.emojis = [{ key: 'one', label: 'one', emoji: 'a', count: 1 }, { key: 'two', label: 'two', emoji: 'b', count: 1 }]
    const onPick = vi.fn(); create({ data: input, onPick }); world.setScene(6)
    const [first, second] = objects(o => o.userData.pick?.kind === 'emoji')
    const firstHome = first.position.clone(), secondHome = second.position.clone()
    vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects').mockReturnValue([{ object: first }])
    const blocked = document.createElement('div'); blocked.dataset.worldBlock = ''; document.body.append(blocked)
    try {
      pointerEvent('pointerdown', 400, 300, blocked); pointerEvent('pointermove', 460, 320); pointerEvent('pointerup', 460, 320)
      expect(first.position.equals(firstHome)).toBe(true)
      pointerEvent('pointerdown', 400, 300); pointerEvent('pointermove', 460, 320); pointerEvent('pointerup', 460, 320)
      expect(first.position.equals(firstHome)).toBe(false); expect(second.position.equals(secondHome)).toBe(true)
      expect(onPick).not.toHaveBeenCalled(); expect(frames.size).toBe(0)
      const moved = first.position.clone(); world.setExportMode(true); await world.prepareCapture()
      expect(first.position.equals(moved)).toBe(true)
      pointerEvent('pointerdown', 400, 300); pointerEvent('pointermove', 500, 400); pointerEvent('pointerup', 500, 400)
      expect(first.position.equals(moved)).toBe(true)
      world.setExportMode(false); world.resetView(); expect(first.position.equals(firstHome)).toBe(true)
      pointerEvent('pointerdown', 400, 300); pointerEvent('pointerup', 402, 301)
      expect(onPick).toHaveBeenCalledWith('emoji', 0)
    } finally { blocked.remove() }
  })

  it('renders real contacts and phrases, zero fabricated objects for empty data, and leap-day tiles', () => {
    create()
    world.setScene(2)
    expect(objects(o => o.userData.pick?.kind === 'contact')).toHaveLength(1)
    expect(context.fillText.mock.calls.some(([text]) => text === '真实昵称')).toBe(true)
    world.setScene(1)
    expect(objects(o => o.isInstancedMesh).map(o => o.count)).toEqual([29])
    world.setData({ year: 2024, data: empty(), privacy: false })
    world.setScene(5)
    expect(objects(o => o.userData.pick?.kind === 'phrase')).toHaveLength(0)
    expect(world.getState().rendered).toBe(true)
  })

  it('owns one animation loop and cancels it for pause, hiding, export, and disposal', () => {
    create(); world.setScene(2); world.setScene(3)
    expect(frames.size).toBe(1)
    world.setMotion(false); expect(frames.size).toBe(0)
    world.setMotion(true); expect(frames.size).toBe(1)
    hidden = true; document.dispatchEvent(new Event('visibilitychange')); expect(frames.size).toBe(0)
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); expect(frames.size).toBe(1)
    world.setExportMode(true); expect(frames.size).toBe(0)
    world.dispose(); expect(frames.size).toBe(0)
    expect(() => world.setScene(1)).toThrow(/销毁/)
  })

  it('does not render private labels or request private textures with privacy enabled', () => {
    create({ privacy: true }); world.setScene(2); world.setScene(5); world.setScene(6)
    expect(context.fillText.mock.calls.flat().join(' ')).not.toMatch(/真实昵称|真实短句|私人表情/)
    expect(gpu.images).toHaveLength(0)
  })

  it('keeps all ten scene selections tied to their real data values', async () => {
    const input = data(); input.hours = Array.from({ length: 24 }, (_, i) => i === 23 ? 6 : 0)
    create({ data: input, privacy: true, motion: false })
    const targets = [
      [['entry', 1]], [['month', 2]], [['contact', 0]], [['month', 2]],
      Array.from({ length: 24 }, (_, i) => ['hour', i]), [['phrase', 0]], [['emoji', 0]],
      [['metric', 'text'], ['metric', 'voice'], ['metric', 'call']],
      Array.from({ length: 7 }, (_, i) => ['chapter', i + 1]), [['share', 0]],
    ]
    for (let scene = 0; scene < 10; scene++) {
      world.setScene(scene)
      world.setSelection({ month: 2, contact: 0, hour: 23, phrase: 0, emoji: 0, metric: 'voice', gather: true })
      expect(objects(o => o.userData.pick).map(o => [o.userData.pick.kind, o.userData.pick.value])).toEqual(targets[scene])
      await world.prepareCapture()
    }
  })

  it('waits for a real emoji texture; capture fails visibly on load failure', async () => {
    const onError = vi.fn(); create({ onError }); world.setScene(6)
    let captured = false
    const capture = world.prepareCapture().then(() => { captured = true })
    await Promise.resolve(); expect(captured).toBe(false)
    gpu.images[0].failure(new Error('unavailable'))
    await expect(capture).rejects.toThrow(/表情/)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(context.fillText.mock.calls.some(([text]) => text.includes('加载失败'))).toBe(true)
  })

  it('rejects capture immediately if one texture fails while another is still loading', async () => {
    const input = data(); input.emojis.push({ key: 'second', label: '另一张表情', url: '/api/second.png', count: 1 })
    create({ data: input }); world.setScene(6)
    const capture = world.prepareCapture()
    gpu.images[0].failure(new Error('unavailable'))
    await expect(capture).rejects.toThrow(/表情/)
    await expect(world.prepareCapture()).rejects.toThrow(/表情/)
  })

  it('disposes late textures without writing into a replacement scene or reporting its old failure', async () => {
    const onError = vi.fn(); create({ onError }); world.setScene(6)
    const old = gpu.images[0]; const dispose = vi.spyOn(old.texture, 'dispose')
    const capture = world.prepareCapture(); world.setScene(1)
    old.success(old.texture)
    await expect(capture).rejects.toThrow(/切换/)
    expect(dispose).toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(world.getState().scene).toBe(1)
    await expect(world.prepareCapture()).resolves.toBeInstanceOf(HTMLCanvasElement)
  })

  it('exposes WebGL creation failure instead of reporting a ready scene', () => {
    gpu.fail = new Error('GPU unavailable')
    expect(() => create()).toThrow(/WebGL/)
    expect(gpu.renders).toBe(0)
  })

  it('stops the loop and exposes a render failure at the capture boundary', async () => {
    const onError = vi.fn(); create({ onError })
    gpu.renderFailure = new Error('GPU draw failed')
    await expect(world.prepareCapture()).rejects.toThrow('GPU draw failed')
    expect(world.getState().error).toBe('GPU draw failed')
    expect(frames.size).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('waits for fonts and a successful image load, then releases the image when leaving', async () => {
    let loadedFonts
    vi.spyOn(document, 'fonts', 'get').mockReturnValue({ ready: new Promise(resolve => { loadedFonts = resolve }) })
    create(); world.setScene(6)
    let completed = false
    const capture = world.prepareCapture().then(() => { completed = true })
    const image = gpu.images[0]
    const dispose = vi.spyOn(image.texture, 'dispose')
    image.success(image.texture)
    await Promise.resolve(); expect(completed).toBe(false)
    loadedFonts(); await capture
    expect(completed).toBe(true)
    world.setScene(0); expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('announces ready only after current props have rendered and suppresses stale scene completion', async () => {
    const wrapper = mount(EchoWorld, { props: { year: 2024, data: data(), scene: 6 } })
    try {
      await flushPromises(); expect(wrapper.emitted('ready')).toBeUndefined()
      await wrapper.setProps({ scene: 2, privacy: true })
      await flushPromises()
      expect(wrapper.emitted('ready')).toHaveLength(1)
      expect(wrapper.vm.getState().scene).toBe(2)
      gpu.images[0].success(gpu.images[0].texture)
      await flushPromises()
      expect(wrapper.emitted('ready')).toHaveLength(1)
      expect(wrapper.emitted('error')).toBeUndefined()
    } finally { wrapper.unmount() }
  })

  it('shows a WebGL failure without a ready event and rejects capture', async () => {
    gpu.fail = new Error('unavailable')
    const wrapper = mount(EchoWorld, { props: { year: 2024, data: empty(), scene: 0 } })
    try {
      await flushPromises()
      expect(wrapper.get('[role="alert"]').text()).toContain('WebGL')
      expect(wrapper.emitted('ready')).toBeUndefined()
      expect(wrapper.emitted('error')).toHaveLength(1)
      await expect(wrapper.vm.prepareCapture()).rejects.toThrow(/WebGL/)
    } finally { wrapper.unmount() }
  })
})
