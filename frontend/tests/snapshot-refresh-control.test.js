import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import SnapshotRefreshControl from '~/components/chat/SnapshotRefreshControl.vue'

const setup = (overrides = {}) => {
  const state = {
    status: ref({ phase: 'waiting', running: false, interval_seconds: 30, probe_interval_seconds: 0.5, refresh_available: true, unavailable_reason: '' }),
    enabled: ref(true), loading: ref(false), error: ref(''), paused: ref(false), syncing: ref(false),
    retry: vi.fn(), ...overrides
  }
  return { state, wrapper: mount(SnapshotRefreshControl, { props: { state }, global: { stubs: { ErrorNotice: { props: ['message'], template: '<div role="alert">{{ message }}</div>' } } } }) }
}
describe('会话栏自动同步状态', () => {
  it.each([
    ['连接', { status: ref(null), loading: ref(true) }],
    ['准备', { enabled: ref(false) }],
    ['等待变化', {}],
    ['核对', { syncing: ref(true), status: ref({ phase: 'checking', refresh_available: true }) }],
    ['构建', { syncing: ref(true), status: ref({ phase: 'building', refresh_available: true }) }],
    ['首次归档', { syncing: ref(true), status: ref({ phase: 'archiving', refresh_available: true,
      archive_progress: { initial: true, messages_processed: 1234, databases_done: 1, databases_total: 3 } }) }],
    ['增量归档', { syncing: ref(true), status: ref({ phase: 'archiving', refresh_available: true,
      archive_progress: { initial: false, messages_processed: 12, databases_done: 1, databases_total: 1 } }) }],
    ['停止中', { syncing: ref(true), status: ref({ phase: 'stopping', refresh_available: true }) }],
    ['无错误暂停', { paused: ref(true) }],
    ['导入历史归档', { enabled: ref(false), status: ref({ refresh_available: false, unavailable_reason: '历史导入归档不与本机微信同步' }) }],
  ])('%s状态保持后台静默，不渲染占位或控件', (_label, overrides) => {
    const { wrapper, state } = setup(overrides)
    expect(wrapper.findAll('*')).toHaveLength(0)
    expect(wrapper.text()).toBe('')
    expect(state.retry).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('失败保留原始错误，只由明确的重试操作恢复', async () => {
    const error = 'publish · OSError · disk full'
    const { wrapper, state } = setup({ error: ref(error), paused: ref(true) })
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toBe(error)
    expect(state.retry).not.toHaveBeenCalled()
    const retry = wrapper.get('button')
    expect(retry.text()).toBe('重试同步')
    await retry.trigger('click')
    expect(state.retry).toHaveBeenCalledOnce()
    state.loading.value = true
    await wrapper.vm.$nextTick()
    expect(retry.attributes('disabled')).toBeDefined()
    await retry.trigger('click')
    expect(state.retry).toHaveBeenCalledOnce()
    state.loading.value = false
    state.syncing.value = true
    await wrapper.vm.$nextTick()
    expect(retry.attributes('disabled')).toBeDefined()
    state.error.value = ''
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('*')).toHaveLength(0)
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })
})
