import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DecryptPage from '../pages/decrypt.vue'

const api = vi.hoisted(() => ({ getPlatformCapabilities: vi.fn(), getKeys: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ useApi: () => api }))

let wrapper
const originalClient = process.client
beforeEach(() => {
  process.client = true
  sessionStorage.clear()
  localStorage.clear()
  vi.resetAllMocks()
  api.getPlatformCapabilities.mockResolvedValue({ platform: 'windows' })
})
afterEach(() => {
  wrapper?.unmount()
  process.client = originalClient
  vi.restoreAllMocks()
})

const mountPage = async () => {
  wrapper = mount(DecryptPage, { global: { stubs: {
    Stepper: true,
    ErrorNotice: { props: ['message'], template: '<p role="alert">{{ message }}</p>' },
    GuideDialog: {
      props: ['open', 'title', 'description', 'note'], emits: ['primary'],
      template: '<div v-if="open" role="dialog">{{ title }} {{ description }} {{ note }}<button @click="$emit(\'primary\')">开始扫描</button></div>'
    },
  } } })
  await flushPromises()
  return wrapper.findAll('button').find(button => button.text() === '一键获取数据库密钥')
}

test('offline page hides Hook guidance and shows an inline missing-path error', async () => {
  const acquire = await mountPage()
  expect(wrapper.text()).toContain('离线模式')
  expect(wrapper.text()).not.toContain('Hook')
  await acquire.trigger('click')
  expect(wrapper.get('[role="alert"]').text()).toContain('db_storage')
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
})

test('offline page submits the specified database path and displays a verified pure-scan result', async () => {
  api.getKeys.mockResolvedValue({ status: 0, data: { method: 'pure_memory', db_key: 'a'.repeat(64) } })
  const acquire = await mountPage()
  await wrapper.get('#dbPath').setValue('D:\\xwechat_files\\wxid_test\\db_storage')
  await acquire.trigger('click')
  expect(wrapper.get('[role="dialog"]').text()).not.toMatch(/Hook|重启/)
  await wrapper.get('[role="dialog"] button').trigger('click')
  await flushPromises()
  expect(wrapper.get('#key').element.value).toBe('a'.repeat(64))
  expect(wrapper.text()).toContain('通过纯源码内存扫描获取，并通过数据库验证')
  expect(api.getKeys).toHaveBeenCalledWith(expect.objectContaining({ key_mode: 'pure_memory', db_storage_path: 'D:\\xwechat_files\\wxid_test\\db_storage' }))
})

test('platform detection failure stays visible and acquisition explicitly retries before scanning', async () => {
  api.getPlatformCapabilities.mockRejectedValueOnce(new Error('capabilities unavailable'))
  const acquire = await mountPage()
  expect(wrapper.get('[role="alert"]').text()).toContain('capabilities unavailable')
  expect(acquire.element.disabled).toBe(false)
  expect(wrapper.text()).not.toContain('正在检测系统')
  expect(api.getKeys).not.toHaveBeenCalled()
  await wrapper.get('#dbPath').setValue('D:\\xwechat_files\\wxid_test\\db_storage')
  await acquire.trigger('click')
  await flushPromises()
  expect(api.getPlatformCapabilities).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.get('[role="dialog"]').text()).toContain('获取前请确认微信已登录')
  expect(api.getKeys).not.toHaveBeenCalled()
})

test('repeated platform detection failure never starts a key request', async () => {
  api.getPlatformCapabilities.mockRejectedValue(new Error('capabilities still unavailable'))
  const acquire = await mountPage()
  await wrapper.get('#dbPath').setValue('D:\\xwechat_files\\wxid_test\\db_storage')
  await acquire.trigger('click')
  await flushPromises()
  expect(api.getPlatformCapabilities).toHaveBeenCalledTimes(2)
  expect(wrapper.get('[role="alert"]').text()).toContain('capabilities still unavailable')
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(api.getKeys).not.toHaveBeenCalled()
  expect(acquire.element.disabled).toBe(false)
})

test('image step exposes a retry after capability failure and enables only an affirmative capability', async () => {
  api.getPlatformCapabilities.mockRejectedValueOnce(new Error('scan resources unavailable'))
    .mockResolvedValue({ platform: 'windows', image_key_memory_scan: true })
  await mountPage()
  wrapper.vm.$.setupState.currentStep = 1
  await nextTick()
  const unavailable = wrapper.get('[data-testid="image-key-memory-scan-unavailable"]')
  expect(unavailable.text()).toContain('scan resources unavailable')
  expect(wrapper.findAll('button').find(button => button.text() === '扫描资源不可用').element.disabled).toBe(true)
  await unavailable.get('button').trigger('click')
  await flushPromises()
  expect(api.getPlatformCapabilities).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[data-testid="image-key-memory-scan-unavailable"]').exists()).toBe(false)
  expect(wrapper.findAll('button').find(button => button.text() === '扫描微信内存').element.disabled).toBe(false)
})

test('a Windows response without the scan capability does not implicitly enable image scanning', async () => {
  await mountPage()
  wrapper.vm.$.setupState.currentStep = 1
  await nextTick()
  expect(wrapper.findAll('button').find(button => button.text() === '扫描资源不可用').element.disabled).toBe(true)
  expect(wrapper.get('[data-testid="image-key-memory-scan-unavailable"]').text()).toContain('后端未提供图片密钥扫描能力，请检查后端能力检测结果。')
})
