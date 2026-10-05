import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../pages/contacts.vue', import.meta.url), 'utf8')
const start = source.indexOf('const writeWebExportFile =')
const end = source.indexOf('\nconst exportContactsInWeb =', start)
const handler = source.slice(start, end)

async function writeWithSeal(sealed) {
  const written = new Map()
  let calls = 0
  const context = {
    exportFolderHandle: { value: { async getFileHandle(name) {
      assert.equal(typeof name, 'string', 'export attempted an absent signature filename')
      return { async createWritable() { return {
        async write(content) { written.set(name, content) }, async close() {},
      } } }
    } } },
    $fetch: async () => { calls += 1; return sealed }, apiBase: '',
    exportContentBase64: async content => Buffer.from(content).toString('base64'),
    exportContentFromBase64: content => Buffer.from(content, 'base64').toString(),
  }
  vm.createContext(context)
  await vm.runInContext(`${handler}\nwriteWebExportFile({fileName: 'contacts.json', content: 'payload'})`, context)
  return { written, calls }
}

test('browser independent export writes payload and checksum without signature files', async () => {
  const result = await writeWithSeal({ integrityFormat: 'xwechat-sha256',
    checksumsFileName: 'contacts.json.checksums.json', checksums: '{"format":"xwechat-sha256"}' })
  assert.deepEqual([...result.written.keys()], ['contacts.json', 'contacts.json.checksums.json'])
  assert.equal(result.written.get('contacts.json'), 'payload')
  assert.equal(result.calls, 1)
})
