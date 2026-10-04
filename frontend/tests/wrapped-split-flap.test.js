import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SplitFlapRow from '../components/wrapped/visualizations/SplitFlapRow.vue'

describe('annual-summary split flap lifecycle', () => {
  let wrapper

  const create = (props = {}) => {
    wrapper = mount(SplitFlapRow, {
      props: { text: 'AAA', cellCount: 3, flipMs: 300, spinMs: 150, staggerMs: 55, ...props },
    })
    return wrapper
  }
  const shown = () => wrapper.findAll('.sf-half--bot .sf-glyph').map((cell) => cell.text()).join('')
  const advance = async (ms) => {
    await vi.advanceTimersByTimeAsync(ms)
    await nextTick()
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
  })

  it('cancels cell and stagger timers when paused and resumes one settlement', async () => {
    create()
    const initialTimers = vi.getTimerCount()
    await wrapper.setProps({ text: 'BBB' })
    await advance(60)
    expect(wrapper.findAll('.sf-flap').length).toBeGreaterThan(0)

    await wrapper.setProps({ paused: true })
    expect(vi.getTimerCount()).toBe(initialTimers)
    expect(shown()).toBe('BBB')
    await advance(2000)
    expect(wrapper.emitted('settled')).toBeUndefined()

    await wrapper.setProps({ paused: false })
    await advance(500)
    expect(shown()).toBe('BBB')
    expect(wrapper.emitted('settled')).toHaveLength(1)
    await advance(2000)
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('replaces queued spinning glyphs with the latest paused target', async () => {
    create({ spinning: true })
    await wrapper.setProps({ text: 'BBB' })
    await advance(40)
    await wrapper.setProps({ text: 'CCC' })
    await wrapper.setProps({ paused: true })
    await wrapper.setProps({ text: 'DDD', spinning: false })
    expect(vi.getTimerCount()).toBe(0)
    await advance(2000)
    expect(shown()).toBe('DDD')
    expect(wrapper.emitted('settled')).toBeUndefined()

    await wrapper.setProps({ paused: false })
    await advance(500)
    expect(shown()).toBe('DDD')
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('updates reduced-motion output while paused without emitting until resumed', async () => {
    create({ paused: true, reduced: true })
    await wrapper.setProps({ text: 'BBB', spinning: false })
    expect(shown()).toBe('BBB')
    expect(vi.getTimerCount()).toBe(0)
    expect(wrapper.emitted('settled')).toBeUndefined()

    await wrapper.setProps({ paused: false })
    expect(wrapper.emitted('settled')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies reduced motion immediately when the preference changes mid-flip', async () => {
    create()
    await wrapper.setProps({ text: 'BBB' })
    await advance(60)
    await wrapper.setProps({ reduced: true })
    expect(shown()).toBe('BBB')
    expect(wrapper.findAll('.sf-flap')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('does not replay completed settlement merely on leaving and returning', async () => {
    create()
    await wrapper.setProps({ text: 'BBB' })
    await advance(500)
    await wrapper.setProps({ paused: true })
    await wrapper.setProps({ paused: false })
    await advance(500)
    expect(wrapper.emitted('settled')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves a fresh replay after completed settlement', async () => {
    create()
    await wrapper.setProps({ text: 'BBB' })
    await advance(500)
    await wrapper.setProps({ spinning: true, text: 'CCC' })
    await advance(170)
    await wrapper.setProps({ spinning: false, text: 'BBB' })
    await advance(500)
    expect(shown()).toBe('BBB')
    expect(wrapper.emitted('settled')).toHaveLength(2)
  })

  it('does not complete a stale reveal when a new roll starts before settlement', async () => {
    create()
    await wrapper.setProps({ text: 'BBB' })
    await advance(60)
    await wrapper.setProps({ spinning: true, text: 'CCC' })
    await advance(500)
    expect(wrapper.emitted('settled')).toBeUndefined()
    await wrapper.setProps({ spinning: false, text: 'DDD' })
    await advance(500)
    expect(shown()).toBe('DDD')
    expect(wrapper.emitted('settled')).toHaveLength(1)
  })

  it('clears pending work on unmount', async () => {
    create()
    await wrapper.setProps({ text: 'BBB' })
    await advance(60)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(2000)
    expect(wrapper.emitted('settled')).toBeUndefined()
    wrapper = null
  })
})
