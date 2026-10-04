import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import MonthlyCompanionPosters from '../components/wrapped/visualizations/MonthlyCompanionPosters.vue'
import { usePrivacyStore } from '~/stores/privacy'

const engine = vi.hoisted(() => ({ render: vi.fn(), create: vi.fn(), preload: vi.fn(), reduced: null, observers: [] }))
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    WebGLRenderer: class {
      constructor() { engine.create(); this.capabilities = { getMaxAnisotropy: () => 16 } }
      setPixelRatio() {}
      setClearAlpha() {}
      setSize() {}
      dispose() {}
      render(scene, camera) { engine.render(scene, camera) }
    }
  }
})
vi.mock('~/composables/useReducedMotion', () => ({ useReducedMotion: () => engine.reduced }))
vi.mock('~/composables/useMonthlyCompanions', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useMonthlyCompanions: props => ({ ...actual.useMonthlyCompanions(props), preloadAvatars: engine.preload }) }
})

describe('月度海报按需渲染', () => {
  let wrapper, pending, nextId, now, hidden, exporting, stage
  beforeEach(() => {
    pending = new Map()
    nextId = 0
    now = 0
    hidden = false
    exporting = ref(false)
    engine.reduced = ref(false)
    engine.observers = []
    engine.render.mockClear()
    engine.create.mockClear()
    engine.preload.mockReset().mockResolvedValue()
    setActivePinia(createPinia())
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('useApiBase', () => '/api')
    vi.spyOn(performance, 'now').mockImplementation(() => now)
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
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(25)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 1200, height: 700, right: 1200, bottom: 700 })
    const gradient = { addColorStop() {} }
    const ctx = new Proxy({
      measureText: text => ({ width: String(text).length * 12 }),
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createPattern: () => ({})
    }, { get: (target, key) => key in target ? target[key] : () => {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    stage = { scale: ref(1), tier: ref('wide'), pixelRatio: () => 2 }
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })
  const mountPosters = async (active = true) => {
    wrapper = mount(MonthlyCompanionPosters, {
      props: { active, year: 2025, months: [{ month: 1, winner: { username: 'friend', displayName: '朋友', score100: 93 }, raw: { totalMessages: 120 } }] },
      global: { provide: { wrappedExportMode: exporting, [Symbol.for('wrapped.stage')]: stage } }
    })
    if (active) await vi.waitFor(() => expect(engine.preload).toHaveBeenCalled())
    await flushPromises()
  }
  const frame = async () => {
    now += 1000 / 60
    const callbacks = [...pending.values()]
    pending.clear()
    callbacks.forEach(cb => cb(now))
    await nextTick()
  }
  const settle = async () => {
    for (let i = 0; i < 300 && pending.size; i++) await frame()
    expect(pending.size, '动画收敛后必须停止 RAF').toBe(0)
  }
  const assertWakeAndSettle = async (action) => {
    const before = engine.render.mock.calls.length
    await action()
    await nextTick()
    expect(pending.size, '状态或交互变化必须唤醒画布').toBe(1)
    await settle()
    expect(engine.render.mock.calls.length).toBeGreaterThan(before)
  }

  it('保留入场动画，停稳后不再重复渲染；点击月份会重新动画到正确月份', async () => {
    await mountPosters()
    await settle()
    expect(engine.render.mock.calls.length).toBeGreaterThan(1)
    const idleCount = engine.render.mock.calls.length
    for (let i = 0; i < 60; i++) await frame()
    expect(engine.render).toHaveBeenCalledTimes(idleCount)
    await assertWakeAndSettle(() => wrapper.findAll('.mph-frame')[5].trigger('click'))
    expect(wrapper.get('.mph-frame--on').text()).toBe('6')
  })

  it('视差、拖动、尺寸变化、隐私和画幅缩放都能唤醒已停稳的画布', async () => {
    await mountPosters()
    await settle()
    const surface = wrapper.get('.mph-stage')
    await assertWakeAndSettle(() => surface.trigger('pointermove', { clientX: 1100, clientY: 100 }))
    await assertWakeAndSettle(() => surface.trigger('pointerleave'))
    await surface.trigger('pointerdown', { pointerId: 1, clientX: 600, button: 0 })
    await assertWakeAndSettle(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 380 }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 380 }))
    })
    await assertWakeAndSettle(() => engine.observers[0]())
    await assertWakeAndSettle(() => { stage.scale.value = 1.2 })
    await assertWakeAndSettle(() => usePrivacyStore().set(true))
  })

  it('退出当前页和隐藏窗口取消 RAF，回来继续；卸载移除可见性监听', async () => {
    await mountPosters()
    await frame()
    await wrapper.setProps({ active: false })
    expect(pending.size).toBe(0)
    await wrapper.setProps({ active: true })
    expect(pending.size).toBe(1)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pending.size).toBe(0)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    wrapper.unmount()
    wrapper = null
    document.dispatchEvent(new Event('visibilitychange'))
    expect(pending.size).toBe(0)
  })

  it('头像加载期间翻走不会在异步完成后启动后台渲染，重新进入正常初始化', async () => {
    let resolve
    engine.preload.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await mountPosters()
    await wrapper.setProps({ active: false })
    resolve()
    await flushPromises()
    expect(engine.create).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
    await wrapper.setProps({ active: true })
    await flushPromises()
    await settle()
    expect(engine.create).toHaveBeenCalledTimes(1)
  })

  it('动态切换减少动态效果会立即落定；再次选月只需一帧', async () => {
    await mountPosters()
    await frame()
    engine.reduced.value = true
    await nextTick()
    const count = engine.render.mock.calls.length
    await frame()
    expect(pending.size).toBe(0)
    expect(engine.render).toHaveBeenCalledTimes(count + 1)
    await wrapper.findAll('.mph-frame')[8].trigger('click')
    await frame()
    expect(wrapper.get('.mph-frame--on').text()).toBe('9')
    expect(pending.size).toBe(0)
  })

  it('导出立即渲染终态并停止，退出导出恢复未完成入场', async () => {
    await mountPosters()
    await frame()
    exporting.value = true
    await nextTick()
    await frame()
    expect(pending.size).toBe(0)
    expect(wrapper.get('.mph-frame--on').text()).toBe('1')
    exporting.value = false
    await nextTick()
    expect(pending.size).toBe(1)
    await frame()
    expect(pending.size).toBe(1)
    await settle()
    expect(wrapper.get('.mph-frame--on').text()).toBe('1')
  })
})
