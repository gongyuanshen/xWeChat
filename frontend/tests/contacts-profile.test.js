import { mount, flushPromises } from '@vue/test-utils'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContactsPage from '~/pages/contacts.vue'
import ErrorNotice from '~/components/ErrorNotice.vue'

let account, api, wrapper, navigate, privacyMode
vi.mock('pinia', () => ({ storeToRefs: store => store }))
vi.mock('~/stores/chatAccounts', () => ({
  useChatAccountsStore: () => ({ selectedAccount: account, ensureLoaded: vi.fn(async () => {}) }),
}))
vi.mock('~/stores/privacy', () => ({
  usePrivacyStore: () => ({ privacyMode, init: vi.fn() }),
}))

const alice = {
  username: 'wxid_alice', displayName: '列表中的 Alice', nickname: 'Alice', remark: '', alias: '',
  type: 'friend', gender: 0, signature: '', avatar: '/alice.jpg', avatarLink: '',
  country: '', province: '', city: '', region: '', source: '', sourceScene: null,
  addTime: null, addTimeText: '', commonChatroomCount: null, pinyinKey: 'alice', pinyinInitial: 'A',
}
const bob = { ...alice, username: 'wxid_bob', displayName: '列表中的 Bob', avatar: '/bob.jpg', pinyinKey: 'bob', pinyinInitial: 'B' }
const profile = (username = 'wxid_alice', changes = {}) => ({
  status: 'success', account: 'account-a', source: 'decrypted', found: true,
  contact: {
    ...alice, username, displayName: '资料中的 Alice', nickname: '真实昵称', remark: '项目联系人', alias: 'alice_public',
    gender: 2, signature: '数据库中的真实签名', region: '中国 浙江 杭州', country: '中国', province: '浙江', city: '杭州',
    source: '通过搜索微信号添加', sourceScene: 3, addTime: 1700000000, addTimeText: '2023-11-14',
    commonChatroomCount: 0, commonChatrooms: [], friendVerifications: [], ...changes,
  },
})
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  process.client = true
  account = ref('account-a')
  privacyMode = ref(false)
  navigate = vi.fn()
  api = {
    listChatContacts: vi.fn(async () => ({ status: 'success', account: account.value, source: 'decrypted',
      contacts: [alice, bob], counts: { friends: 2, total: 2 } })),
    listFriendVerifications: vi.fn(async () => ({ status: 'success', items: [{ userName: 'wxid_alice',
      timestamp: 1700000000, type: 1, scene: 3, isSender: false, content: '请通过我的好友申请',
      remark: '', timeText: '2023-11-14', contact: alice }], total: 1, hasMore: false })),
    getChatContactProfile: vi.fn(async () => profile()),
  }
  for (const [name, value] of Object.entries({ ref, reactive, computed, watch, nextTick, onMounted, onUnmounted,
    useHead: vi.fn(), useApi: () => api, useApiBase: () => '/api', navigateTo: navigate,
    useSettingsDialog: () => ({ openDialog: vi.fn() }),
  })) vi.stubGlobal(name, value)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete window.wechatDesktop
  delete process.client
})

const open = async () => {
  wrapper = mount(ContactsPage, { global: {
    components: { ErrorNotice }, stubs: {
      RecordExportDialog: { name: 'RecordExportDialog', props: ['open', 'dataset', 'title', 'account', 'query', 'typeOptions'], template: '<div />' },
    },
  } })
  await flushPromises()
}
const row = username => {
  const item = wrapper.findAll('button.contact-list-item').find(item => item.text().includes(username))
  expect(item, `联系人 ${username} 应有可选择的原生按钮`).toBeDefined()
  return item
}
const button = text => wrapper.findAll('button').find(item => item.text() === text)
const detail = () => wrapper.find('[data-testid="contact-profile"]')

describe('联系人页真实资料交互', () => {
  it('空联系人列表可以挂载，不自动发起资料读取', async () => {
    api.listChatContacts.mockResolvedValue({ status: 'success', contacts: [], counts: { total: 0 } })
    await open()
    expect(wrapper.text()).toContain('暂无联系人')
    expect(api.getChatContactProfile).not.toHaveBeenCalled()
  })
  it('挂载真实页面并通过头像和整行选择，展示 API 资料及聊天入口', async () => {
    const pending = deferred()
    api.getChatContactProfile.mockReturnValueOnce(pending.promise)
    await open()
    expect(wrapper.text()).toContain('列表中的 Alice')
    expect(row('wxid_alice')).toBeDefined()
    expect(row('wxid_alice').attributes('aria-pressed')).toBe('false')
    await row('wxid_alice').find('img').trigger('click')
    expect(row('wxid_alice').attributes('aria-pressed')).toBe('true')
    expect(detail().text()).toContain('加载')
    expect(detail().text()).not.toContain('数据库中的真实签名')
    const request = api.getChatContactProfile.mock.calls[0][0]
    expect(request).toEqual({ account: 'account-a', username: 'wxid_alice', source: 'auto', signal: expect.any(AbortSignal) })
    pending.resolve(profile())
    await flushPromises()
    for (const value of ['资料中的 Alice', '真实昵称', '项目联系人', 'alice_public', '数据库中的真实签名', '中国 浙江 杭州', '通过搜索微信号添加', '2023-11-14']) {
      expect(detail().text()).toContain(value)
    }
    await button('查看聊天记录').trigger('click')
    expect(navigate).toHaveBeenCalledWith('/chat/wxid_alice')
    api.getChatContactProfile.mockResolvedValueOnce(profile('wxid_bob', { displayName: '资料中的 Bob' }))
    await row('wxid_bob').trigger('click')
    await flushPromises()
    expect(detail().text()).toContain('资料中的 Bob')
    expect(row('wxid_alice').attributes('aria-pressed')).toBe('false')
  })

  it('后一次点击获胜，即使前一次请求忽略取消并晚到', async () => {
    const old = deferred(), current = deferred()
    api.getChatContactProfile.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await open()
    await row('wxid_alice').trigger('click')
    const oldSignal = api.getChatContactProfile.mock.calls[0][0].signal
    await row('wxid_bob').trigger('click')
    expect(oldSignal.aborted).toBe(true)
    current.resolve(profile('wxid_bob', { displayName: '当前 Bob 资料' }))
    await flushPromises()
    old.resolve(profile('wxid_alice', { displayName: '过期 Alice 资料' }))
    await flushPromises()
    expect(detail().text()).toContain('当前 Bob 资料')
    expect(detail().text()).not.toContain('过期 Alice 资料')
    expect(row('wxid_bob').attributes('aria-pressed')).toBe('true')
  })

  it('切换账号立即清除选择并忽略旧账号的晚到资料', async () => {
    const old = deferred(), nextList = deferred()
    api.getChatContactProfile.mockReturnValueOnce(old.promise)
    await open()
    await row('wxid_alice').trigger('click')
    const oldSignal = api.getChatContactProfile.mock.calls[0][0].signal
    api.listChatContacts.mockReturnValueOnce(nextList.promise)
    account.value = 'account-b'
    await nextTick()
    expect(oldSignal.aborted).toBe(true)
    expect(wrapper.find('button.contact-list-item[aria-pressed="true"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="contact-profile"]').text()).not.toContain('wxid_alice')
    old.resolve(profile('wxid_alice', { displayName: '旧账号私密资料' }))
    await flushPromises()
    expect(wrapper.text()).not.toContain('旧账号私密资料')
    nextList.resolve({ status: 'success', contacts: [], counts: { total: 0 } })
    await flushPromises()
  })

  it('资料读取失败持续显示错误，只有用户重新加载才发起重试', async () => {
    api.getChatContactProfile.mockRejectedValueOnce(new Error('联系人数据库读取失败'))
    await open()
    await row('wxid_alice').trigger('click')
    await flushPromises()
    expect(detail().find('[role="alert"]').text()).toContain('联系人数据库读取失败')
    expect(detail().text()).not.toContain('数据库中的真实签名')
    await button('好友验证').trigger('click')
    await button('好友资料').trigger('click')
    await flushPromises()
    expect(detail().text()).toContain('联系人数据库读取失败')
    expect(api.getChatContactProfile).toHaveBeenCalledTimes(1)
    await button('重新加载').trigger('click')
    await flushPromises()
    expect(api.getChatContactProfile).toHaveBeenCalledTimes(2)
    expect(detail().text()).toContain('数据库中的真实签名')
    expect(detail().text()).not.toContain('联系人数据库读取失败')
  })

  it('found:false 明确显示本地未找到，响应中的占位资料不伪装为成功', async () => {
    api.getChatContactProfile.mockResolvedValue({ ...profile(), found: false,
      contact: { ...profile().contact, signature: '不应显示的占位签名' } })
    await open()
    await row('wxid_alice').trigger('click')
    await flushPromises()
    expect(detail().text()).toContain('本地未找到')
    expect(detail().text()).not.toContain('不应显示的占位签名')
    expect(detail().text()).not.toContain('alice_public')
  })

  it.each([
    [{ ...alice, type: 'former_friend' }, { type: 'friend' }, '曾经的好友'],
    [{ ...alice, type: 'official', officialAccountKind: 'service' }, { type: 'official', officialAccountKind: '' }, '服务号'],
  ])('资料接口不覆盖列表提供的联系人分类 %#', async (listContact, changes, label) => {
    api.listChatContacts.mockResolvedValue({ status: 'success', contacts: [listContact], counts: { total: 1 } })
    api.getChatContactProfile.mockResolvedValue(profile('wxid_alice', changes))
    await open()
    await row('wxid_alice').trigger('click')
    await flushPromises()
    expect(detail().text()).toContain(label)
    expect(row('wxid_alice').text()).toContain(label)
  })

  it('切换右侧视图仍可读取好友验证、设置导出，并保留联系人和导出格式选择', async () => {
    await open()
    await row('wxid_alice').trigger('click')
    await flushPromises()
    await button('导出联系人').trigger('click')
    const formats = wrapper.findAll('input[type="radio"]').map(input => input.attributes('value'))
    expect(formats).toEqual(['html', 'json', 'txt', 'excel'])
    await wrapper.find('input[type="radio"][value="excel"]').setValue()
    expect(button('选择目录')).toBeDefined()
    expect(button('开始导出').attributes('disabled')).toBeDefined()
    await button('好友验证').trigger('click')
    expect(wrapper.text()).toContain('请通过我的好友申请')
    expect(wrapper.find('button[aria-label="导出好友验证"]').exists()).toBe(true)
    await button('好友资料').trigger('click')
    expect(detail().text()).toContain('数据库中的真实签名')
    expect(row('wxid_alice').attributes('aria-pressed')).toBe('true')
    expect(api.getChatContactProfile).toHaveBeenCalledTimes(1)
    await button('导出联系人').trigger('click')
    expect(wrapper.find('input[type="radio"][value="excel"]').element.checked).toBe(true)
  })

  it.each(['account', 'username'])('拒绝响应中不匹配的 %s，不显示另一身份的资料', async mismatch => {
    const response = profile('wxid_alice', { displayName: '错误身份资料', signature: '不属于当前联系人的签名' })
    if (mismatch === 'account') response.account = 'account-other'
    else response.contact.username = 'wxid_other'
    api.getChatContactProfile.mockResolvedValueOnce(response)
    await open()
    await row('wxid_alice').trigger('click')
    await flushPromises()
    expect(detail().find('[role="alert"]').text()).toContain('不匹配')
    expect(detail().text()).not.toContain('错误身份资料')
    expect(detail().text()).not.toContain('不属于当前联系人的签名')
    expect(detail().find('dl').exists()).toBe(false)
  })

  it('离开页面取消正在读取的资料，晚到的结果不导航或重新请求', async () => {
    const pending = deferred()
    api.getChatContactProfile.mockReturnValueOnce(pending.promise)
    await open()
    await row('wxid_alice').trigger('click')
    const signal = api.getChatContactProfile.mock.calls[0][0].signal
    expect(signal.aborted).toBe(false)
    wrapper.unmount()
    wrapper = null
    expect(signal.aborted).toBe(true)
    pending.resolve(profile())
    await flushPromises()
    expect(api.getChatContactProfile).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('分类筛选移除当前联系人时清除资料，不能保留已移出列表的选择', async () => {
    await open()
    await row('wxid_alice').trigger('click')
    await flushPromises()
    expect(detail().text()).toContain('数据库中的真实签名')
    api.listChatContacts.mockResolvedValueOnce({ status: 'success', contacts: [], counts: { total: 0 } })
    const friends = wrapper.findAll('label.contact-type-filter-card').find(label => label.text().startsWith('好友'))
    await friends.find('input[type="checkbox"]').setValue(false)
    await flushPromises()
    expect(api.listChatContacts.mock.lastCall[0].include_friends).toBe(false)
    expect(wrapper.text()).toContain('暂无联系人')
    expect(wrapper.find('button.contact-list-item[aria-pressed="true"]').exists()).toBe(false)
    expect(detail().text()).not.toContain('数据库中的真实签名')
    expect(detail().text()).not.toContain('wxid_alice')
    expect(detail().find('dl').exists()).toBe(false)
  })

  it('隐私模式切换同时遮蔽新资料头像、身份和详情字段', async () => {
    await open()
    await row('wxid_alice').trigger('click')
    await flushPromises()
    for (const selector of ['.contact-profile-avatar', '.contact-profile-identity', 'dl']) {
      expect(detail().find(selector).classes()).not.toContain('privacy-blur')
    }
    privacyMode.value = true
    await nextTick()
    for (const selector of ['.contact-profile-avatar', '.contact-profile-identity', 'dl']) {
      expect(detail().find(selector).classes()).toContain('privacy-blur')
    }
    privacyMode.value = false
    await nextTick()
    expect(detail().find('dl').classes()).not.toContain('privacy-blur')
  })

  it('桌面导出沿用所选目录、格式和分类，验证导出交给当前账号及搜索条件', async () => {
    window.wechatDesktop = {
      chooseDirectory: vi.fn(async () => ({ canceled: false, filePaths: ['G:\\controlled-export'] })),
    }
    api.exportChatContacts = vi.fn(async () => ({ status: 'success', count: 2, outputPath: 'G:\\controlled-export\\contacts.txt' }))
    await open()
    await wrapper.find('input[placeholder="搜索联系人"]').setValue('Alice')
    const groups = wrapper.findAll('label.contact-type-filter-card').find(label => label.text().startsWith('群聊'))
    await groups.find('input[type="checkbox"]').setValue(true)
    await button('导出联系人').trigger('click')
    await wrapper.find('input[type="radio"][value="txt"]').setValue()
    await button('选择目录').trigger('click')
    await flushPromises()
    expect(window.wechatDesktop.chooseDirectory).toHaveBeenCalledWith({ title: '选择导出目录' })
    expect(button('开始导出').attributes('disabled')).toBeUndefined()
    await button('开始导出').trigger('click')
    await flushPromises()
    expect(api.exportChatContacts).toHaveBeenCalledWith({
      account: 'account-a', source: 'auto', output_dir: 'G:\\controlled-export', format: 'txt',
      include_avatar_link: true, keyword: 'Alice', contact_types: {
        friends: true, groups: true, enterprise_friends: false, enterprise_groups: false,
        officials: false, official_subscriptions: false, official_services: false, former_friends: false, blocked: false,
      },
    })
    expect(wrapper.text()).toContain('导出成功')
    account.value = 'account-b'
    await flushPromises()
    await button('好友验证').trigger('click')
    await wrapper.find('input[placeholder="搜索验证内容、用户名、备注"]').setValue('受控验证查询')
    await wrapper.find('button[aria-label="导出好友验证"]').trigger('click')
    const dialog = wrapper.findComponent({ name: 'RecordExportDialog' })
    expect(dialog.props()).toMatchObject({ open: true, dataset: 'friend-verifications', account: 'account-b', query: '受控验证查询' })
  })
})
