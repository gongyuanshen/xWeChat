import assert from 'node:assert/strict'
import test from 'node:test'
import { MiB, GiB, TiB, fmtBytes, fmtB, normalizeRedeemCode } from '../lib/media-service-format.js'

test('字节格式：MiB 一位小数、GiB/TiB 两位、null 为破折号', () => {
  assert.deepEqual(fmtBytes(13212672), { num: '12.6', unit: 'MiB' })
  assert.deepEqual(fmtBytes(10 * GiB - 826781696), { num: '9.23', unit: 'GiB' })
  assert.deepEqual(fmtBytes(1.34 * TiB), { num: '1.34', unit: 'TiB' })
  assert.equal(fmtB(0), '0 B')
  assert.equal(fmtBytes(null).num, '—')
})

test('兑换码规范化：去空白连字符（含全角）、大写、去 wx、O/I/L 纠正、只留 Crockford、截 20 位', () => {
  assert.equal(normalizeRedeemCode(' wx-7k9m p4rx-2v8d-q6yt-h3nc ').code, '7K9MP4RX2V8DQ6YTH3NC')
  const r = normalizeRedeemCode('WX-O1IL-ABCD－EFGH_JKMN—PQRS')
  assert.equal(r.code, '0111ABCDEFGHJKMNPQRS')
  assert.deepEqual(r.fixes, [0, 2, 3])
  assert.equal(normalizeRedeemCode('wx-uuuu-1234').code, '1234')          // U 不在 Crockford 集
  assert.equal(normalizeRedeemCode('0123456789ABCDEFGHJKMNPQ').code.length, 20)
})

