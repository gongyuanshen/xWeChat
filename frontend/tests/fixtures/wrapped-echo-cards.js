// Deterministic UI/export fixtures only. Never imported by production code.
import { ECHO_KINDS } from '../../lib/wrapped-echo-model.js'

export const FIXTURE_PRIVATE = {
  account: 'fixture-private-account', username: 'fixture-private-contact',
  names: ['林间回声', '北岸来信', '远山灯火', '午后留声'],
  phrases: ['好的收到', '明天见面', '路上小心'],
  message: '仅用于测试的私密消息正文',
  anchor: 'fixture-private-table',
  path: 'C:/fixture-private/messages.db',
}
const raster = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYeeHgfwAHWgMqNltWEgAAAABJRU5ErkJggg=='

export function createEchoCardFixture() {
  const year = 2025
  const dailyCounts = Array.from({ length: 365 }, (_, i) => i % 11 === 0 ? 0 : (i * 37) % 105 + 3)
  const matrix = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (h > 6 && h < 23) ? (d + 1) * ((h * 7) % 20 + 4) : (d + h) % 3))
  const totalMessages = matrix.flat().reduce((sum, n) => sum + n, 0)
  const contacts = FIXTURE_PRIVATE.names.map((displayName, i) => ({ username: `${FIXTURE_PRIVATE.username}-${i}`, displayName, avatarUrl: '', maskedName: '已隐藏', totalMessages: 4200 - i * 670, outgoingMessages: 2010 - i * 300, incomingMessages: 2190 - i * 370, replyCount: 130 - i * 14, avgReplySeconds: 36 + i * 21, score: .84 - i * .08 }))
  const months = Array.from({ length: 12 }, (_, i) => i === 5 ? { month: i + 1, winner: null, metrics: null, raw: null, isFallback: false, reason: 'insufficient_data' } : {
    month: i + 1, winner: { ...contacts[i % contacts.length], score100: 72.4 + i },
    metrics: { interactionScore: .83, speedScore: .76, continuityScore: .8, coverageScore: .625 },
    raw: { incomingMessages: 280 + i * 15, outgoingMessages: 250 + i * 10, totalMessages: 530 + i * 25, interaction: 250 + i * 10, replyCount: 50 + i, avgReplySeconds: 80 + i, avgReplySecondsCapped: 80 + i, activeDays: 18 + i % 5, timeBucketsCount: 5 }, isFallback: false,
  })
  const datasets = [
    { year, totalMessages, activeDays: dailyCounts.filter(n => n > 0).length, messagesPerDay: totalMessages / 300, sentMediaCount: 620, sentStickerCount: 317, addedFriends: 4, peakDay: { date: '2025-07-22', count: 107 }, annualHeatmap: { year, dailyCounts } },
    { year, totalMessages, matrix, peakHour: 21, peakHourCount: 436, peakHourLabel: '21:00', nightCompanion: { partner: contacts[1], totalMessages: 528, sentCount: 249, receivedCount: 279 } },
    { year, sentChars: 141592, receivedChars: 112358, typedPhrases: FIXTURE_PRIVATE.phrases.map(text=>({text,pinyin:'fixture pinyin'})), voice: { sentCount: 10, sentSeconds: 930, receivedCount: 8, receivedSeconds: 1210 }, calls: { totalCount: 8, totalSeconds: 3500, voiceCount: 5, videoCount: 3, connectedCount: 6, missedOrCanceledCount: 2 } },
    { year, sentToContacts: 4, replyEvents: 436, replyStats: { p50Seconds: 55, p90Seconds: 1200 }, fastestReplySeconds: 0, longestReplySeconds: 86400, bestBuddy: contacts[0], fastest: { ...contacts[1], seconds: 0 }, slowest: { ...contacts[2], seconds: 86400 }, topBuddies: contacts.slice(0, 3), topTotals: contacts.slice(0, 3), allContacts: contacts.map(({ username, displayName, avatarUrl }) => ({ username, displayName, avatarUrl })), initiative: { conversationCount: 223, initiatedByMe: 100, initiatedByOthers: 123, initiationRatePct: 44.8, topInitiatedByMe: [], topInitiatedToMe: [], mutualFriend: null }, race: null },
    { year, months, summary: { monthsWithWinner: 11, topChampion: { ...contacts[0], monthsWon: 3 }, filledMonths: months.filter(m => m.winner).map(m => m.month) }, settings: { weights: { interaction: .4, speed: .3, continuity: .2, coverage: .1 }, eligibility: { minTotalMessages: 8, minOutgoingMessages: 3, minIncomingMessages: 3, minReplyCount: 1, minActiveDays: 2 } } },
    { year, sentStickerCount: 317, uniqueStickerTypeCount: 27, revivedStickerCount: 3, topStickers: [{ md5: '00112233445566778899aabbccddeeff', emojiLabel: '私密图片表情标记', emojiUrl: raster, count: 117 }], topWechatEmojis: [], topTextEmojis: [{ key: '[微笑]', count: 71, assetPath: '' }], topUnicodeEmojis: [{ emoji: '🌙', count: 63 }, { emoji: '✨', count: 24 }] },
    { year, keywords: FIXTURE_PRIVATE.phrases.map((word, i) => ({ word, count: 127 - i * 29, monthlyCounts: Array.from({length:12},(_,m)=>m===11?(127-i*29)%12+Math.floor((127-i*29)/12):Math.floor((127-i*29)/12)) })) },
    { year },
  ]
  return Object.fromEntries(datasets.map((data, id) => [id, { account: FIXTURE_PRIVATE.account, year, id, kind: ECHO_KINDS[id], title: `受控统计卡 ${id}`, contractVersion: 1, status: 'ok', error: '', data }]))
}

export function createEchoDetailFixture() {
  const item = (id, isSent, text) => ({ username: `${FIXTURE_PRIVATE.username}-0`, displayName: FIXTURE_PRIVATE.names[0], timestamp: 1735689600 + id * 10, isSent, text, source: { dbStem: 'fixture-private-db', table: FIXTURE_PRIVATE.anchor, localId: id }, filePath: FIXTURE_PRIVATE.path })
  const from = item(1, false, `${FIXTURE_PRIVATE.message} A`), to = item(2, true, `${FIXTURE_PRIVATE.message} B`)
  const stats = { count: 1, p50Seconds: 10, p90Seconds: 10, buckets: [{ key: 'underMinute', label: '1 分钟内', count: 1 }, { key: 'oneToTenMinutes', label: '1–10 分钟', count: 0 }, { key: 'tenToSixtyMinutes', label: '10–60 分钟', count: 0 }, { key: 'overHour', label: '1 小时及以上', count: 0 }] }
  return { account: FIXTURE_PRIVATE.account, year: 2025, contractVersion: 1, kind: 'contact', value: `${FIXTURE_PRIVATE.username}-0`, period: 'all', status: 'ok', offset: 0, limit: 40, total: 5, hasMore: true, summary: { sent: 2, received: 3, messageCount: 5, conversationCount: 1, reply: { me: stats, them: { ...stats, count: 0, p50Seconds: null, p90Seconds: null, buckets: stats.buckets.map(b => ({ ...b, count: 0 })) } }, replyRule: '连续同向最后一条到反向首条' }, items: [from, to], replyPairs: [{ direction: 'me', seconds: 10, from, to }], pairsTotal: 1, pairsScope: 'repliesWhoseResponseIsOnMessagePage' }
}
