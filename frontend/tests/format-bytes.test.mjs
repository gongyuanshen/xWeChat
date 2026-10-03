import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBytes } from '../lib/format-bytes.js'

test('export byte counts retain existing invalid-input, unit and precision boundaries', () => {
  for (const [value, expected] of [
    [undefined, '0 B'], [null, '0 B'], [NaN, '0 B'], [Infinity, '0 B'],
    ['invalid', '0 B'], [-1, '0 B'], [0, '0 B'], [1, '1 B'],
    [1023, '1023 B'], ['1024', '1.00 KB'], [10240, '10.0 KB'],
    [102400, '100 KB'], [1024 ** 2, '1.00 MB'], [1024 ** 3, '1.00 GB'],
    [1024 ** 4, '1.00 TB'], [1024 ** 5, '1024 TB'],
  ]) assert.equal(formatBytes(value), expected, String(value))
})
