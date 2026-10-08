import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, h, nextTick, ref } from 'vue'
import gsap from 'gsap'
import BitsGridMotion from '../components/wrapped/shared/BitsGridMotion.vue'
import WrappedHero from '../components/wrapped/shared/WrappedHero.vue'

const motion = vi.hoisted(() => ({ reduced: null }))
vi.mock('~/composables/useReducedMotion', () => ({ useReducedMotion: () => motion.reduced }))

describe('annual cover preview motion ownership', () => {
  let wrapper, exporting, hidden, now, observers, initialListeners, tickerAdd
  beforeEach(() => {
    exporting = ref(false)
    motion.reduced = ref(false)
    hidden = false
    now = 100
    observers = []
    // Keep real GSAP add/remove hooks, but drive frames only through the test
    // clock: wake() otherwise dispatches a synchronous wall-clock tick on resume.
    gsap.ticker.sleep()
    vi.spyOn(gsap.ticker, 'wake').mockImplementation(() => gsap.ticker.sleep())
    initialListeners = [...gsap.ticker._listeners]
    tickerAdd = vi.spyOn(gsap.ticker, 'add')
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this) }
      observe() {}
    })
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('useState', (_key, init) => ref(init()))
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    for (const listener of [...gsap.ticker._listeners]) {
      if (!initialListeners.includes(listener)) gsap.ticker.remove(listener)
    }
    gsap.ticker.sleep()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const settle = async () => { await nextTick(); gsap.ticker.sleep() }
  const visible = async (value) => {
    for (const observer of observers) observer.callback([{ isIntersecting: value }])
    await settle()
  }
  const create = async (props = {}, slots = {}) => {
    wrapper = mount(BitsGridMotion, {
      props: { items: ['annual overview', 'chat rhythm', 'friends', 'emoji'], rowCount: 7, columnCount: 8, ...props },
      slots,
      global: { provide: { wrappedExportMode: exporting } },
    })
    await visible(true)
    return tickerAdd.mock.calls.at(-1)?.[0]
  }
  const frame = async (callback, elapsed = 16) => {
    now += elapsed
    callback()
    await settle()
  }

  it('removes the real GSAP listener after each cover unmount', async () => {
    for (let i = 0; i < 2; i++) {
      const callback = await create()
      expect(gsap.ticker._listeners).toContain(callback)
      wrapper.unmount()
      wrapper = null
      expect(gsap.ticker._listeners).toEqual(initialListeners)
      expect(observers.at(-1).disconnect).toHaveBeenCalledOnce()
    }
  })

  it('moves rows without rerendering any of the 112 preview slots', async () => {
    const slot = vi.fn(({ item }) => h('span', item))
    const callback = await create({}, { item: slot })
    expect(wrapper.findAll('.bits-grid-motion-cell')).toHaveLength(112)
    for (const label of ['annual overview', 'chat rhythm', 'friends', 'emoji']) expect(wrapper.text()).toContain(label)
    const rendered = slot.mock.calls.length
    const before = wrapper.element.style.getPropertyValue('--bits-marquee-x')
    await frame(callback)
    await frame(callback)
    expect(wrapper.element.style.getPropertyValue('--bits-marquee-x')).not.toBe(before)
    expect(slot).toHaveBeenCalledTimes(rendered)
  })

  it('pauses an inactive cover without DOM writes and resumes its saved phase', async () => {
    const callback = await create()
    await frame(callback)
    await frame(callback)
    const phase = wrapper.element.style.getPropertyValue('--bits-marquee-x')
    await wrapper.setProps({ active: false })
    await settle()
    expect(gsap.ticker._listeners).not.toContain(callback)
    const write = vi.spyOn(wrapper.element.style, 'setProperty')
    await frame(callback, 20000)
    expect(write).not.toHaveBeenCalled()
    expect(wrapper.element.style.getPropertyValue('--bits-marquee-x')).toBe(phase)
    await wrapper.setProps({ active: true })
    await settle()
    expect(gsap.ticker._listeners).toContain(callback)
    await frame(callback)
    expect(wrapper.element.style.getPropertyValue('--bits-marquee-x')).toBe(phase)
    await frame(callback)
    expect(wrapper.element.style.getPropertyValue('--bits-marquee-x')).not.toBe(phase)
  })

  it.each(['hidden', 'intersection', 'reduced', 'export'])('stops motion while %s and resumes without losing content', async (condition) => {
    const callback = await create()
    const content = wrapper.text()
    const set = async (value) => {
      if (condition === 'hidden') { hidden = value; document.dispatchEvent(new Event('visibilitychange')) }
      if (condition === 'intersection') await visible(!value)
      if (condition === 'reduced') motion.reduced.value = value
      if (condition === 'export') exporting.value = value
      await settle()
    }
    await set(true)
    expect(gsap.ticker._listeners).not.toContain(callback)
    const write = vi.spyOn(wrapper.element.style, 'setProperty')
    await frame(callback)
    expect(write).not.toHaveBeenCalled()
    expect(wrapper.text()).toBe(content)
    await set(false)
    expect(gsap.ticker._listeners).toContain(callback)
  })

  it('keeps responsive row and column changes while retaining every source label', async () => {
    const callback = await create()
    await frame(callback)
    await frame(callback)
    await wrapper.setProps({ rowCount: 6, columnCount: 5, itemWidth: 460 })
    await settle()
    expect(wrapper.findAll('.bits-grid-motion-row')).toHaveLength(6)
    expect(wrapper.findAll('.bits-grid-motion-cell')).toHaveLength(60)
    for (const label of ['annual overview', 'chat rhythm', 'friends', 'emoji']) expect(wrapper.text()).toContain(label)
    expect(Math.abs(parseFloat(wrapper.element.style.getPropertyValue('--bits-marquee-x')))).toBeLessThan(5 * 472)
  })

  it('passes the cover active state into its preview without changing the title or items', async () => {
    wrapper = mount(WrappedHero, {
      props: { year: 2025, variant: 'slide', isActive: false },
      global: {
        components: { BitsGridMotion },
        stubs: { WrappedCardShell: { props: ['title'], template: '<div>{{ title }}<slot /></div>' } },
        provide: { wrappedExportMode: exporting },
      },
    })
    await visible(true)
    const preview = wrapper.getComponent(BitsGridMotion)
    expect(preview.props('active')).toBe(false)
    const title = wrapper.get('h1').text()
    const items = preview.props('items')
    await wrapper.setProps({ isActive: true })
    await settle()
    expect(preview.props('active')).toBe(true)
    expect(wrapper.get('h1').text()).toBe(title)
    expect(preview.props('items')).toEqual(items)
  })
})
