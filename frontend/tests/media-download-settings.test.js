import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MediaDownloadSettings from '../components/MediaDownloadSettings.vue'

const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const snapshot = (remainingBytes = 1048576) => ({ connected: true, account: {}, quota: { remainingBytes, limitBytes: 2097152, resetsAt: 2000000000 } })
let api, wrapper
beforeEach(() => {
  setActivePinia(createPinia())
  api = { getCdnPlan: vi.fn(async () => snapshot()), connectCdn: vi.fn(async () => snapshot()), redeemCdnCode: vi.fn() }
  vi.stubGlobal('useApi', () => api)
})
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
const mountSettings = async (account = 'a') => { wrapper = mount(MediaDownloadSettings, { props: { account } }); await flushPromises(); return wrapper }
const button = label => wrapper.findAll('button').find(item => item.text() === label)

it('无账号不请求服务并禁用操作', async () => {
  await mountSettings('')
  expect(wrapper.text()).toContain('请先选择账号')
  expect(api.getCdnPlan).not.toHaveBeenCalled()
  expect(wrapper.findAll('button').every(item => item.element.disabled)).toBe(true)
})

it('展示真实额度，HTTP 200 业务错误可见且未知额度不显示为零', async () => {
  api.getCdnPlan.mockResolvedValue({ ...snapshot(null), error: { code: 'network_error', message: '媒体服务离线' } })
  await mountSettings()
  expect(wrapper.find('[role="alert"]').text()).toContain('媒体服务离线')
  expect(wrapper.text()).toContain('未知')
  expect(wrapper.text()).not.toContain('0 B')
  expect(wrapper.text()).not.toMatch(/QQ|高级版|套餐|升级/)
})

it('连接与刷新复用现有接口，不发送兑换', async () => {
  await mountSettings()
  await button('重新连接').trigger('click'); await flushPromises()
  await button('刷新状态').trigger('click'); await flushPromises()
  expect(api.connectCdn).toHaveBeenCalledWith('a')
  expect(api.getCdnPlan).toHaveBeenLastCalledWith('a', { refresh: true })
  expect(api.redeemCdnCode).not.toHaveBeenCalled()
})

it('校验并规范化兑换码，提交中禁止重复；成功后清空输入并更新额度', async () => {
  const task = deferred()
  api.redeemCdnCode.mockReturnValue(task.promise)
  await mountSettings()
  const input = wrapper.find('input')
  await input.setValue('1234')
  expect(button('兑换').element.disabled).toBe(true)
  await input.setValue('wx-7k9m-p4rx-2v8d-q6yt-h3nc')
  await wrapper.find('form').trigger('submit')
  await wrapper.find('form').trigger('submit')
  expect(api.redeemCdnCode).toHaveBeenCalledTimes(1)
  expect(api.redeemCdnCode).toHaveBeenCalledWith('a', '7K9MP4RX2V8DQ6YTH3NC')
  task.resolve({ snapshot: snapshot(5242880) }); await flushPromises()
  expect(input.element.value).toBe('')
  expect(wrapper.text()).toContain('5.0 MiB')
  expect(wrapper.text()).toContain('兑换成功')
})

it('切换账号清除输入和旧消息，迟到的兑换成功不污染当前页面', async () => {
  const task = deferred()
  api.redeemCdnCode.mockReturnValue(task.promise)
  await mountSettings()
  await wrapper.find('input').setValue('7K9MP4RX2V8DQ6YTH3NC')
  await wrapper.find('form').trigger('submit')
  await wrapper.setProps({ account: 'b' }); await flushPromises()
  expect(wrapper.find('input').element.value).toBe('')
  task.resolve({ snapshot: snapshot(999999999) }); await flushPromises()
  expect(wrapper.text()).not.toContain('兑换成功')
  expect(wrapper.text()).toContain('1.0 MiB')
})

it('兑换失败展示原因且不重试、不清空兑换码', async () => {
  api.redeemCdnCode.mockRejectedValue(Object.assign(new Error('兑换码已被使用'), { code: 'redeem_code_used' }))
  await mountSettings()
  await wrapper.find('input').setValue('7K9MP4RX2V8DQ6YTH3NC')
  await wrapper.find('form').trigger('submit'); await flushPromises()
  expect(wrapper.find('[role="alert"]').text()).toContain('兑换码已被使用')
  expect(wrapper.find('input').element.value).toBe('7K9MP4RX2V8DQ6YTH3NC')
  expect(api.redeemCdnCode).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).not.toContain('兑换成功')
})
