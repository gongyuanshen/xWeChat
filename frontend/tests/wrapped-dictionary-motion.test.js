import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { gsap } from 'gsap'
import KeywordDictionarySpread from '../components/wrapped/visualizations/KeywordDictionarySpread.vue'

describe('annual dictionary animation ownership', () => {
  let wrapper
  let lensTo
  let entranceFromTo
  let pageTimeline

  const create = (props = {}, exportMode = ref(false)) => {
    wrapper = mount(KeywordDictionarySpread, {
      props: {
        year: 2025,
        keywords: [
          { word: '认真生活', count: 12 },
          { word: '明天见', count: 9 },
          { word: '一起出发', count: 7 },
        ],
        ...props,
      },
      global: { provide: { wrappedExportMode: exportMode } },
    })
    return wrapper
  }
  const lens = () => wrapper.find('.kd-lens')
  const latestLensTween = () => lensTo.mock.results.at(-1).value
  const down = () => lens().trigger('keydown', { key: 'ArrowDown' })

  beforeEach(() => {
    lensTo = vi.spyOn(gsap, 'to')
    entranceFromTo = vi.spyOn(gsap, 'fromTo')
    pageTimeline = vi.spyOn(gsap, 'timeline')
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.restoreAllMocks()
    gsap.globalTimeline.clear()
    gsap.ticker.sleep()
  })

  it('kills an earlier lens tween when keyboard selection changes again', async () => {
    create()
    await down()
    const first = latestLensTween()
    const firstTarget = first.targets()[0]
    first.progress(0.35)
    await down()
    const second = latestLensTween()
    expect(second).not.toBe(first)
    expect(gsap.getTweensOf(firstTarget)).toHaveLength(0)
    expect(wrapper.find('.kd-hw-word').text()).toBe('一起出发')
    second.progress(1)
    await nextTick()
    expect(lens().attributes('aria-valuetext')).toBe('一起出发')
  })

  it('keeps the lens positioned when GSAP clears its entrance transform', async () => {
    create()
    const position = wrapper.find('.kd-lens-position')
    const initial = position.element.style.transform
    expect(initial).toMatch(/^translate3d\(.+px, .+px, 0\)$/)
    for (const tween of entranceFromTo.mock.results.map(result => result.value)) tween.progress(1)
    await nextTick()
    expect(position.element.style.transform).toBe(initial)
    expect(lens().element.style.transform).toBe('')
  })

  it('cancels lens snapping as soon as dragging begins', async () => {
    create()
    await down()
    const snap = latestLensTween()
    snap.progress(0.3)
    await nextTick()
    const target = snap.targets()[0]

    await lens().trigger('pointerdown', { pointerId: 3, clientX: 980, clientY: 460 })
    expect(gsap.getTweensOf(target)).toHaveLength(0)
    expect(lens().classes()).toContain('kd-lens--drag')
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3 }))
    await nextTick()
    expect(lens().classes()).not.toContain('kd-lens--drag')
  })

  it('pauses and resumes owned entrance, page and lens animations', async () => {
    create()
    // Client setup must run: this fails if the harness skips import.meta.client.
    const entrance = entranceFromTo.mock.results.map((result) => result.value)
    expect(entrance).toHaveLength(3)
    await down()
    const snap = latestLensTween()
    const flip = pageTimeline.mock.results.at(-1).value

    await wrapper.setProps({ paused: true })
    for (const tween of [...entrance, snap, flip]) expect(tween.paused()).toBe(true)
    await wrapper.setProps({ paused: false })
    for (const tween of [...entrance, snap, flip]) expect(tween.paused()).toBe(false)
  })

  it('starts newly selected animations paused when the card is inactive', async () => {
    create({ paused: true })
    const entrance = entranceFromTo.mock.results.map((result) => result.value)
    expect(entrance).toHaveLength(3)
    await down()
    const snap = latestLensTween()
    const flip = pageTimeline.mock.results.at(-1).value
    for (const tween of [...entrance, snap, flip]) expect(tween.paused()).toBe(true)
    await wrapper.setProps({ paused: false })
    expect(snap.paused()).toBe(false)
    expect(flip.paused()).toBe(false)
  })

  it('kills outstanding owned tweens when the dictionary closes', async () => {
    create()
    const entrance = entranceFromTo.mock.results.map((result) => result.value)
    await down()
    const snap = latestLensTween()
    const flip = pageTimeline.mock.results.at(-1).value
    const targets = [...entrance, snap].flatMap((tween) => tween.targets())
    wrapper.unmount()
    wrapper = null
    for (const target of targets) expect(gsap.getTweensOf(target)).toHaveLength(0)
    expect(flip.parent).toBeNull()
  })

  it('finishes the selected word for export and cancels an in-flight lens snap', async () => {
    const exportMode = ref(false)
    create({}, exportMode)
    await down()
    const snap = latestLensTween()
    const expectedX = snap.vars.x
    const expectedY = snap.vars.y
    const target = snap.targets()[0]
    snap.progress(0.2)
    exportMode.value = true
    await nextTick()
    expect(gsap.getTweensOf(target)).toHaveLength(0)
    expect(wrapper.find('.kd-hw-word').text()).toBe('明天见')
    // Wide layout lens radius is 84; export must place its centre at the selected row.
    expect(wrapper.find('.kd-lens-position').element.style.transform).toBe(`translate3d(${expectedX - 84}px, ${expectedY - 84}px, 0)`)
  })
})
