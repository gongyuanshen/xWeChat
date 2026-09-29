import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, computed } from 'vue'
import { useCdnPlanStore } from '../stores/cdnPlan'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const snapshot = (remainingBytes = 100) => ({ connected: true, account: {}, quota: { remainingBytes }, error: null })
let api
beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  api = { getCdnPlan: vi.fn(), connectCdn: vi.fn(), redeemCdnCode: vi.fn() }
  vi.stubGlobal('useApi', () => api)
})
afterEach(() => vi.unstubAllGlobals())

it('旧账号请求晚到不能覆盖新账号，即使切回原账号', async () => {
  const old = deferred(), current = deferred()
  api.getCdnPlan.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const store = useCdnPlanStore()
  const first = store.refresh('a')
  store.selectAccount('b')
  const last = store.refresh('a')
  old.resolve(snapshot(999))
  await first
  expect(store.snapshot).toBeNull()
  expect(store.loading).toBe(true)
  current.resolve(snapshot(10))
  await last
  expect(store.snapshot.quota.remainingBytes).toBe(10)
  expect(store.loading).toBe(false)
})

it('切换账号立即清除额度、错误及加载状态', async () => {
  const store = useCdnPlanStore()
  api.getCdnPlan.mockResolvedValue({ ...snapshot(), error: { code: 'network_error', message: '离线' } })
  await store.refresh('a')
  store.selectAccount('b')
  expect(store.snapshot).toBeNull()
  expect(store.error).toBeNull()
  expect(store.loading).toBe(false)
})

it('HTTP 200 错误快照保留业务错误；未知额度不算耗尽', async () => {
  const store = useCdnPlanStore()
  api.getCdnPlan.mockResolvedValue({ ...snapshot(), quota: { limitBytes: 100, remainingBytes: null }, error: { code: 'network_error', message: '服务离线' } })
  await store.refresh('a')
  expect(store.error.code).toBe('network_error')
  expect(store.exhausted).toBe(false)
})

it('传输失败必须向调用者抛出，同时展示错误', async () => {
  const failure = Object.assign(new Error('连接失败'), { code: 'network_error' })
  api.getCdnPlan.mockRejectedValue(failure)
  const store = useCdnPlanStore()
  await expect(store.refresh('a')).rejects.toBe(failure)
  expect(store.error.message).toBe('连接失败')
  expect(store.loading).toBe(false)
})

it('未产生新请求错误时仍显示服务端记录的媒体错误', async () => {
  api.getCdnPlan.mockResolvedValue({ ...snapshot(), lastError: { code: 'quota_exceeded', message: '额度不足' } })
  const store = useCdnPlanStore()
  await store.refresh('a')
  expect(store.error?.code).toBe('quota_exceeded')
})

it('兑换提交期间拒绝重复请求，成功应用服务端快照', async () => {
  const task = deferred()
  api.redeemCdnCode.mockReturnValue(task.promise)
  const store = useCdnPlanStore()
  const first = store.redeem('a', 'VALID')
  await expect(store.redeem('a', 'VALID')).rejects.toThrow('正在处理')
  expect(api.redeemCdnCode).toHaveBeenCalledTimes(1)
  task.resolve({ snapshot: snapshot(50) })
  await first
  expect(store.snapshot.quota.remainingBytes).toBe(50)
})

it('兑换失败不自动重试且保留锁定时间', async () => {
  const failure = Object.assign(new Error('兑换已锁定'), { code: 'redeem_locked', detail: { lockedUntil: 2000000000 } })
  api.redeemCdnCode.mockRejectedValue(failure)
  const store = useCdnPlanStore()
  await expect(store.redeem('a', 'INVALID')).rejects.toBe(failure)
  expect(store.lockedUntil).toBe(2000000000)
  expect(api.redeemCdnCode).toHaveBeenCalledTimes(1)
})

it('关闭设置或切回账号不能绕过仍在途的兑换保护', async () => {
  const task = deferred()
  api.redeemCdnCode.mockReturnValue(task.promise)
  const store = useCdnPlanStore()
  const first = store.redeem('a', 'VALID')
  store.selectAccount('')
  store.selectAccount('a')
  expect(store.redeeming).toBe(true)
  await expect(store.redeem('a', 'VALID')).rejects.toThrow('正在处理')
  store.selectAccount('b')
  store.selectAccount('a')
  await expect(store.redeem('a', 'VALID')).rejects.toThrow('正在处理')
  expect(api.redeemCdnCode).toHaveBeenCalledTimes(1)
  task.resolve({ snapshot: snapshot() }); await first
  expect(store.redeeming).toBe(false)
})

it('旧账号失败不会污染新账号，连接成功使用真实快照', async () => {
  const task = deferred()
  api.getCdnPlan.mockReturnValue(task.promise)
  api.connectCdn.mockResolvedValue(snapshot(22))
  const store = useCdnPlanStore()
  const first = store.refresh('a')
  store.selectAccount('b')
  await store.connect('b')
  task.reject(new Error('旧账号失败'))
  await expect(first).rejects.toThrow('旧账号失败')
  expect(store.error).toBeNull()
  expect(store.snapshot.quota.remainingBytes).toBe(22)
})
