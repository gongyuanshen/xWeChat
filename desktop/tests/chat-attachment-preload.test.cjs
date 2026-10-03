const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preloadApi() {
  let api;
  const calls = [];
  const diskFile = new File(['disk'], '报告.pdf');
  const context = {
    process: { platform: 'win32' },
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, exposed) { api = exposed; } },
      ipcRenderer: { send() {}, async invoke(channel, entries) {
        calls.push({ channel, entries });
        return { canceled: false, attachments: [] };
      } },
      webUtils: { getPathForFile(file) {
        if (!(file instanceof File)) throw new TypeError('Expected a File');
        return file === diskFile ? 'C:\\报告.pdf' : '';
      } },
    }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), context);
  return { api, calls, diskFile };
}

test('preload 接受 File 数组，磁盘文件传原生路径，虚拟截图传真实字节而非 DOM File', async () => {
  const { api, calls, diskFile } = preloadApi();
  assert.equal(typeof api.importChatAttachments, 'function');
  const screenshot = new File(['screenshot'], '截图.png', { type: 'image/png' });
  await api.importChatAttachments([diskFile, screenshot]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'chat:importAttachments');
  assert.equal(calls[0].entries[0].path, 'C:\\报告.pdf');
  assert.equal(calls[0].entries[1].name, '截图.png');
  assert.equal(Buffer.from(calls[0].entries[1].bytes).toString(), 'screenshot');
  assert.equal(calls[0].entries[1] instanceof File, false);
});

test('preload 拒绝伪造 File，不调用 IPC 或将异常伪装为空附件', async () => {
  const { api, calls } = preloadApi();
  assert.equal(typeof api.importChatAttachments, 'function');
  await assert.rejects(api.importChatAttachments([{ name: 'fake.png', path: 'C:\\secret.png' }]), /Expected a File/);
  assert.equal(calls.length, 0);
});
