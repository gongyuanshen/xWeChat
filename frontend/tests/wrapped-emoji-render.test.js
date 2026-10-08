import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { gsap } from 'gsap'
import EmojiPack3D from '../components/wrapped/visualizations/EmojiPack3D.vue'

const engine = vi.hoisted(() => ({ render: vi.fn(), create: vi.fn(), dispose: vi.fn(), importWait: null, observers: [] }))
vi.mock('three', async (importOriginal) => {
  await engine.importWait
  const actual = await importOriginal()
  return {
    ...actual,
    default: undefined,
    WebGLRenderer: class {
      constructor() { engine.create(); this.capabilities = { getMaxAnisotropy: () => 16 } }
      setPixelRatio() {}
      setClearAlpha() {}
      setSize() {}
      dispose() { engine.dispose() }
      render(scene, camera) { engine.render(scene, camera) }
    },
    // PMREM needs a GPU context; geometry, textures, materials and transforms
    // remain actual Three objects. These tests measure scheduling, not pixels.
    PMREMGenerator: class {
      compileEquirectangularShader() {}
      fromEquirectangular() { return { texture: new actual.Texture(), dispose() {} } }
      dispose() {}
    }
  }
})

describe('annual emoji pack render lifecycle', () => {
  let wrapper, pending, hidden, stage, addListener, removeListener
  let nextId = 10000
  beforeEach(() => {
    pending = new Map()
    hidden = false
    engine.importWait = null
    engine.observers = []
    engine.render.mockClear()
    engine.create.mockClear()
    engine.dispose.mockClear()
    // Own the test clock: GSAP tweens remain real, but their shared ticker
    // must not appear as a second component RAF in these scheduling counts.
    vi.spyOn(gsap.ticker, 'wake').mockImplementation(() => gsap.ticker.sleep())
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    vi.stubGlobal('requestAnimationFrame', cb => { pending.set(++nextId, cb); return nextId })
    vi.stubGlobal('cancelAnimationFrame', id => pending.delete(id))
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb) { engine.observers.push(cb) }
      observe() {}
      disconnect() {}
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1200, height: 700 })
    const gradient = { addColorStop() {} }
    const ctx = new Proxy({
      measureText: text => ({ width: String(text).length * 12 }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createPattern: () => ({})
    }, { get: (target, key) => key in target ? target[key] : () => {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    stage = { scale: ref(1), pixelRatio: () => 2 }
    addListener = vi.spyOn(window, 'addEventListener')
    removeListener = vi.spyOn(window, 'removeEventListener')
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    gsap.globalTimeline.clear()
    gsap.ticker.sleep()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const create = (props = {}) => {
    wrapper = mount(EmojiPack3D, {
      props: { year: 2025, sentCount: 120, typeCount: 13, ...props },
      global: { provide: { [Symbol.for('wrapped.stage')]: stage } }
    })
  }
  const ready = async () => {
    await flushPromises()
    await vi.waitFor(() => expect(engine.create).toHaveBeenCalledTimes(1))
    gsap.ticker.sleep()
  }
  const frame = async () => {
    const callbacks = [...pending.values()]
    pending.clear()
    callbacks.forEach(cb => cb())
    await nextTick()
  }
  const frames = async (n) => { for (let i = 0; i < n; i++) await frame() }
  const pointerListening = () => addListener.mock.calls.filter(([type]) => type === 'pointermove').length - removeListener.mock.calls.filter(([type]) => type === 'pointermove').length
  const ownedAnimations = () => gsap.globalTimeline.getChildren(false, true, true)

  it('does not finish an asynchronous build after the card leaves, then builds on return', async () => {
    let release
    engine.importWait = new Promise(resolve => { release = resolve })
    create()
    wrapper.vm.setRip(0.35)
    wrapper.vm.autoOpen(0.5)
    await wrapper.setProps({ active: false })
    release()
    await import('three')
    await import('three/examples/jsm/geometries/RoundedBoxGeometry.js')
    await flushPromises()
    expect(engine.create).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
    expect(pointerListening()).toBe(0)
    expect(wrapper.emitted('opened')).toBeUndefined()
    await wrapper.setProps({ active: true })
    await ready()
    expect(pending.size).toBe(1)
    expect(wrapper.vm.rip).toBe(0.35)
    expect(ownedAnimations().find(tween => tween.vars.onUpdate).vars.delay).toBe(0.5)
  })

  it('defers inactive construction and retains rip state while pausing all offscreen work', async () => {
    create({ active: false })
    await flushPromises()
    expect(engine.create).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
    await wrapper.setProps({ active: true })
    await ready()
    await frame()
    const camera = engine.render.mock.calls.at(-1)[1]
    const fitZ = (1.46 * 1.725) / (2 * Math.tan(Math.PI / 12))
    expect(camera.position.z).toBeCloseTo(fitZ * 1.19)
    const entrance = ownedAnimations()[0]
    entrance.progress(0.35)
    const retainedZ = camera.position.z
    await frames(60)
    expect(pending.size).toBe(1)
    wrapper.vm.setRip(0.4)
    const animations = ownedAnimations()
    expect(animations).toHaveLength(2)
    await wrapper.setProps({ active: false })
    expect(pending.size).toBe(0)
    expect(pointerListening()).toBe(0)
    animations.forEach(tween => expect(tween.paused()).toBe(true))
    const count = engine.render.mock.calls.length
    await frames(60)
    expect(engine.render).toHaveBeenCalledTimes(count)
    await wrapper.setProps({ active: true })
    expect(camera.position.z).toBe(retainedZ)
    expect(entrance.progress()).toBeCloseTo(0.35)
    expect(wrapper.vm.rip).toBe(0.4)
    expect(engine.create).toHaveBeenCalledTimes(1)
    expect(pointerListening()).toBe(1)
    animations.forEach(tween => expect(tween.paused()).toBe(false))
    await frame()
    expect(engine.render).toHaveBeenCalledTimes(count + 1)
  })

  it('stops on window hiding and resumes the retained scene without duplicate listeners', async () => {
    create()
    await ready()
    const animations = ownedAnimations()
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pending.size).toBe(0)
    expect(pointerListening()).toBe(0)
    animations.forEach(tween => expect(tween.paused()).toBe(true))
    const count = engine.render.mock.calls.length
    await frames(60)
    expect(engine.render).toHaveBeenCalledTimes(count)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pending.size).toBe(1)
    expect(pointerListening()).toBe(1)
    expect(engine.create).toHaveBeenCalledTimes(1)
  })

  it('uses one frame for reduced motion and redraws rip, resize and open state', async () => {
    create({ reducedMotion: true })
    await ready()
    await frame()
    expect(pending.size).toBe(0)
    const count = engine.render.mock.calls.length
    await frames(60)
    expect(engine.render).toHaveBeenCalledTimes(count)
    wrapper.vm.setRip(0.65)
    await frame()
    expect(engine.render).toHaveBeenCalledTimes(count + 1)
    expect(wrapper.vm.rip).toBe(0.65)
    engine.observers[0]()
    await frame()
    expect(engine.render).toHaveBeenCalledTimes(count + 2)
    stage.scale.value = 1.2
    await nextTick()
    await frame()
    expect(engine.render).toHaveBeenCalledTimes(count + 3)
    wrapper.vm.autoOpen()
    await frame()
    expect(wrapper.emitted('opened')).toHaveLength(1)
    expect(wrapper.vm.getMouth().left.x).toEqual(expect.any(Number))
    expect(pending.size).toBe(0)
  })

  it('settles existing animations when reduced motion changes and resumes ambient movement when restored', async () => {
    create()
    await ready()
    const animations = ownedAnimations()
    await wrapper.setProps({ reducedMotion: true })
    animations.forEach(tween => expect(tween.parent).toBeNull())
    await frame()
    expect(pending.size).toBe(0)
    await wrapper.setProps({ reducedMotion: false })
    expect(pending.size).toBe(1)
    await frame()
    expect(pending.size).toBe(1)
  })

  it('pauses and destroys intro, automatic tear and opening burst animations with their scene', async () => {
    create()
    await ready()
    wrapper.vm.autoOpen()
    wrapper.vm.openBurst()
    const animations = ownedAnimations()
    expect(animations.length).toBeGreaterThanOrEqual(4)
    await wrapper.setProps({ active: false })
    animations.forEach(tween => expect(tween.paused()).toBe(true))
    wrapper.unmount()
    wrapper = null
    animations.forEach(tween => expect(tween.parent).toBeNull())
    expect(engine.dispose).toHaveBeenCalledTimes(1)
    expect(pending.size).toBe(0)
    const count = engine.render.mock.calls.length
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100 }))
    await frames(60)
    expect(engine.render).toHaveBeenCalledTimes(count)
  })

  it('does not create a renderer after unmount during asynchronous imports', async () => {
    create()
    wrapper.vm.setRip(0.65)
    wrapper.vm.autoOpen()
    wrapper.vm.openBurst()
    const pack = wrapper
    wrapper.unmount()
    wrapper = null
    await flushPromises()
    expect(engine.create).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
    expect(pack.emitted('opened')).toBeUndefined()
    expect(ownedAnimations()).toHaveLength(0)
  })

  it.each([false, true])('retains a tear/open request made before scene readiness (reduced=%s)', async reducedMotion => {
    create({ reducedMotion })
    wrapper.vm.setRip(0.65)
    wrapper.vm.autoOpen()
    expect(wrapper.emitted('opened')).toBeUndefined()
    expect(ownedAnimations()).toHaveLength(0)
    await ready()
    expect(wrapper.vm.rip).toBe(reducedMotion ? 1 : 0.65)
    if (!reducedMotion) {
      const automaticTear = ownedAnimations().find(tween => tween.vars.onUpdate)
      automaticTear.progress(1)
      const opening = ownedAnimations().find(tween => tween.vars.onComplete && tween.getChildren)
      opening.progress(1)
    }
    expect(wrapper.emitted('opened')).toHaveLength(1)
    expect(wrapper.vm.getMouth().right.x).toEqual(expect.any(Number))
  })

  it('keeps an explicit opening burst pending until geometry is ready', async () => {
    create()
    expect(() => wrapper.vm.openBurst()).not.toThrow()
    expect(wrapper.emitted('opened')).toBeUndefined()
    await ready()
    const opening = ownedAnimations().find(tween => tween.getChildren)
    opening.progress(1)
    expect(wrapper.emitted('opened')).toHaveLength(1)
    expect(wrapper.vm.getMouth().left.x).toEqual(expect.any(Number))
  })

  it('renders ambient motion while active with zero offscreen, hidden or reduced-motion idle frames', async () => {
    create()
    await ready()
    const sample = async () => {
      const count = engine.render.mock.calls.length
      await frames(60)
      return engine.render.mock.calls.length - count
    }
    const active = await sample()
    await wrapper.setProps({ active: false })
    const inactive = await sample()
    await wrapper.setProps({ active: true })
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    const background = await sample()
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await wrapper.setProps({ reducedMotion: true })
    await frame()
    const reducedIdle = await sample()
    console.info('Emoji pack: render calls per 60 frames', { active, inactive, background, reducedIdle })
    expect([active, inactive, background, reducedIdle]).toEqual([60, 0, 0, 0])
  })
})
