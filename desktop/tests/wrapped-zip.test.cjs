const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { crc32 } = require('node:zlib');

const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const zipSource = source.slice(source.indexOf('// --- 零依赖 ZIP'), source.indexOf('// --- 批次登记簿'));
const { buildStoreZipBuffer } = vm.runInNewContext(`${zipSource}; ({ buildStoreZipBuffer })`, { Buffer, crc32 });

test('年报 ZIP 保留中文文件名、原始内容及本地和中央目录的标准 CRC32', () => {
  const entries = [
    { name: '年度总结.txt', data: Buffer.from('123456789'), crc: 0xcbf43926 },
    { name: 'empty.png', data: Buffer.alloc(0), crc: 0 },
  ];
  const zip = buildStoreZipBuffer(entries, new Date(2026, 9, 2, 12, 34, 56));
  let offset = 0;
  for (const entry of entries) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    assert.equal(zip.readUInt16LE(offset + 6), 0x0800);
    assert.equal(zip.readUInt16LE(offset + 8), 0);
    assert.equal(zip.readUInt32LE(offset + 14), entry.crc);
    const nameLength = zip.readUInt16LE(offset + 26);
    assert.equal(zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), entry.name);
    const dataOffset = offset + 30 + nameLength;
    assert.deepEqual(zip.subarray(dataOffset, dataOffset + entry.data.length), entry.data);
    offset = dataOffset + entry.data.length;
  }
  const directoryOffset = offset;
  for (const entry of entries) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    assert.equal(zip.readUInt32LE(offset + 16), entry.crc);
    offset += 46 + zip.readUInt16LE(offset + 28);
  }
  assert.equal(zip.readUInt32LE(offset), 0x06054b50);
  assert.equal(zip.readUInt16LE(offset + 10), entries.length);
  assert.equal(zip.readUInt32LE(offset + 16), directoryOffset);
});
