import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import EchoDetailPanel from '../components/wrapped/echo/EchoDetailPanel.vue'

const message = (id, isSent, text) => ({ source: { dbStem: 'msg_0', table: 'Chat_secret', localId: id }, dbStem: 'msg_0', table: 'Chat_secret', localId: id, username: 'wxid-secret', timestamp: 1735689600 + id, displayName: '私密联系人甲', isSent, text, renderType: 'text' })
const itemA = message(1, false, '私密来信乙 <img src=x onerror=alert(1)>')
const itemB = message(2, true, '私密回复丙')
const distribution = (count, p50Seconds, p90Seconds, buckets) => ({ count, p50Seconds, p90Seconds, buckets: ['1 分钟内', '1–10 分钟', '10–60 分钟', '1 小时及以上'].map((label, i) => ({ key: String(i), label, count: buckets[i] })) })
const detail = (kind = 'contact') => ({
  query: { kind, value: kind === 'phrase' ? '私密短句丁' : '2025-01-01', period: 'all' }, status: 'ok', error: '',
  data: { summary: { sent: 2, received: 3, messageCount: 5, conversationCount: 1, occurrenceCount: 8, conversations: [{ username: 'wxid-secret', displayName: '私密联系人甲', sent: 2, received: 3, messageCount: 5 }], reply: { me: distribution(2, 0, 90, [1, 1, 0, 0]), them: distribution(1, 3600, 3600, [0, 0, 0, 1]) }, replyRule: '连续同向消息的最后一条 → 反向首条' },
    items: [itemA, itemB], total: 5, hasMore: true, pairsTotal: 3,
    replyPairs: [{ direction: 'me', seconds: 0, from: itemA, to: itemB }, { direction: 'them', seconds: 3600, from: itemB, to: itemA }],
  },
})

describe('annual echo source detail panel', () => {
  let wrapper
  afterEach(() => { wrapper?.unmount(); document.body.innerHTML = '' })
  const create = (value = detail(), privacy = false) => {
    wrapper = mount(EchoDetailPanel, { props: { detail: value, title: '所选记录', privacy }, attachTo: document.body })
    return wrapper
  }

  it('opens a native modal, preserves true zero reply times, and selects the other direction without mixing pairs', async () => {
    create()
    await flushPromises()
    expect(wrapper.find('dialog').element.open).toBe(true)
    expect(wrapper.find('[data-reply-percentile="p50"]').text()).toContain('0秒')
    expect(wrapper.findAll('[data-reply-bucket]')).toHaveLength(4)
    expect(wrapper.findAll('[data-reply-pair]')).toHaveLength(1)
    expect(wrapper.find('[data-reply-pair]').text()).toContain('0秒')
    await wrapper.find('[data-direction="them"]').trigger('click')
    expect(wrapper.find('[data-reply-percentile="p50"]').text()).toContain('1时0分')
    expect(wrapper.findAll('[data-reply-pair]')).toHaveLength(1)
    expect(wrapper.find('[data-reply-pair]').text()).toContain('1时0分')
  })

  it('never renders private names, text, selection phrase or anchors in anonymous DOM and disables source actions', async () => {
    create(detail('phrase'), true)
    expect(wrapper.html()).not.toContain('私密')
    expect(wrapper.html()).not.toContain('wxid-secret')
    expect(wrapper.html()).not.toContain('Chat_secret')
    expect(wrapper.text()).toContain('正文已隐藏')
    expect(wrapper.findAll('[data-source]').every(button => button.element.disabled)).toBe(true)
    await wrapper.find('[data-source]').trigger('click')
    expect(wrapper.emitted('source')).toBeUndefined()
    await wrapper.setProps({ privacy: false })
    expect(wrapper.text()).toContain('私密短句丁')
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.find('[data-source]').trigger('click')
    expect(wrapper.emitted('source')[0][0]).toEqual(itemA)
  })

  it('distinguishes day sent and received counts, emoji occurrences, and outgoing-only hour evidence', async () => {
    create(detail('day'))
    expect(wrapper.find('[data-conversation]').text()).toContain('本人发送 2')
    expect(wrapper.find('[data-conversation]').text()).toContain('收到 3')
    await wrapper.setProps({ detail: detail('emoji') })
    expect(wrapper.find('[data-stat="occurrenceCount"]').text()).toContain('8')
    expect(wrapper.find('[data-stat="messageCount"]').text()).toContain('5')
    expect(wrapper.text()).toContain('出现次数')
    await wrapper.setProps({ detail: detail('hour') })
    expect(wrapper.text()).toContain('仅统计本人发送')
    expect(wrapper.find('[data-stat="received"]').exists()).toBe(false)
  })

  it('labels deep-night partner evidence as both directions between midnight and 05:59', () => {
    create(detail('night'))
    expect(wrapper.find('.echo-detail-header').text()).toContain('00:00–05:59')
    expect(wrapper.find('.echo-detail-header').text()).toContain('双方消息')
    expect(wrapper.find('.echo-detail-header').text()).not.toContain('仅统计本人发送')
    expect(wrapper.find('[data-stat="received"]').exists()).toBe(true)
  })

  it('keeps the selected month visible in phrase and contact scope, without calling monthly replies annual samples', async () => {
    const phrase = detail('phrase')
    phrase.query.month = 7
    create(phrase)
    expect(wrapper.find('.echo-detail-header').text()).toContain('7 月')
    const contact = detail('contact')
    contact.query.month = 7
    contact.data.summary.replyRule = '所选 7 月内连续同向消息的最后一条 → 反向首条'
    await wrapper.setProps({ detail: contact })
    expect(wrapper.find('.echo-detail-header').text()).toContain('7 月')
    expect(wrapper.text()).toContain(contact.data.summary.replyRule)
    expect(wrapper.text()).toContain('所选月份此方向样本')
    expect(wrapper.text()).not.toContain('全年此方向样本')
  })

  it('keeps existing rows during append loading and exposes source failures for explicit retry', async () => {
    const value = detail('day')
    create(value)
    await wrapper.find('[data-more]').trigger('click')
    expect(wrapper.emitted('more')).toHaveLength(1)
    await wrapper.setProps({ detail: { ...value, status: 'loading' } })
    expect(wrapper.findAll('[data-message]')).toHaveLength(2)
    expect(wrapper.find('[data-more]').element.disabled).toBe(true)
    await wrapper.setProps({ detail: { ...value, status: 'error', error: '索引正文损坏：rowid=7' } })
    expect(wrapper.find('[role="alert"]').text()).toContain('索引正文损坏：rowid=7')
    await wrapper.find('[data-retry]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    expect(wrapper.findAll('[data-message]')).toHaveLength(2)
  })

  it('projects private backend errors out of anonymous DOM while retaining full evidence for explicit reveal', async () => {
    const value = { ...detail('hour'), status: 'error', error: 'account=wxid-secret sender=私密联系人甲 database=C:/private/message.db table=Chat_secret' }
    create(value, true)
    for (const secret of ['wxid-secret', '私密联系人甲', 'C:/private/message.db', 'Chat_secret']) expect(wrapper.html()).not.toContain(secret)
    expect(wrapper.find('[role="alert"]').text()).toContain('关闭匿名后查看详细原因')
    expect(value.error).toContain('C:/private/message.db')
    await wrapper.find('[data-retry]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    await wrapper.setProps({ privacy: false })
    expect(wrapper.find('[role="alert"]').text()).toContain(value.error)
  })

  it('shows index progress as building rather than zero and empty evidence as a confirmed zero', async () => {
    create({ query: { kind: 'day', value: '2025-01-01' }, status: 'building', error: '', data: { index: { build: { indexedMessages: 140, fetchedMessages: 160, completedConversations: 2, totalConversations: 4 } } } })
    expect(wrapper.text()).toContain('140')
    expect(wrapper.text()).toContain('2 / 4')
    expect(wrapper.text()).toContain('索引正在构建')
    expect(wrapper.find('[data-empty]').exists()).toBe(false)
    await wrapper.find('[data-retry]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    const empty = detail('hour')
    empty.data = { summary: { sent: 0, received: 0, messageCount: 0, conversationCount: 0 }, items: [], total: 0, hasMore: false }
    await wrapper.setProps({ detail: empty })
    expect(wrapper.find('[data-empty]').text()).toContain('0 条')
    expect(wrapper.findAll('[data-message]')).toHaveLength(0)
    expect(wrapper.find('[data-more]').exists()).toBe(false)
  })

  it('emits close for Escape and restores the opener focus on unmount', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    create()
    await flushPromises()
    await wrapper.find('dialog').trigger('cancel')
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
    wrapper = null
  })
})
