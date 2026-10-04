const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { importChatAttachments } = require('../src/chat-image-picker.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const importStart = source.indexOf("ipcMain.handle('chat:importAttachments'");
const importEnd = source.indexOf('ipcMain.handle("dialog:chooseArchive"', importStart);
const changeStart = source.indexOf('async function applyOutputDirChange(');
const changeEnd = source.indexOf('async function applyPendingOutputDirOnStartup(', changeStart);
assert.ok(importStart >= 0 && importEnd > importStart, 'attachment IPC handler exists');
assert.ok(changeStart >= 0 && changeEnd > changeStart, 'output migration function exists');

function fixture(t, { missingOutput = false, migrating = false, pending = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-attachment-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'configured-output');
  const defaultPath = path.join(dir, 'default-output');
  const mainWindow = { webContents: {} };
  const calls = [];
  let handler;
  const context = {
    fs, path,
    app: {
      isPackaged: false,
      getPath(name) { throw new Error(`unexpected Electron path lookup: ${name}`); },
    },
    mainWindow,
    nativeImage: {
      createFromBuffer() { throw new Error('text attachment must not need image decoding'); },
    },
    chatAttachmentImportsInProgress: 0,
    chatAttachmentTempDirectories: new Set(),
    outputDirChangeInProgress: migrating,
    loadDesktopSettings: () => ({ pendingOutputDir: pending }),
    resolveOutputDir(options) {
      assert.equal(options.ensureExists, false);
      return missingOutput ? null : output;
    },
    importChatAttachments,
    ipcMain: { handle(name, callback) {
      assert.equal(name, 'chat:importAttachments');
      handler = callback;
    } },
    logMain(message) { calls.push(['log', message]); },
    getDefaultOutputDir: () => defaultPath,
    normalizeDirectoryPath: (value) => path.resolve(value),
    pathsReferToSameLocation: (left, right) => path.resolve(left) === path.resolve(right),
    commitOutputDirSettings(value) { calls.push(['commit', value]); },
    ensureOutputLink() { calls.push(['link']); },
    getOutputDirInfo: () => ({ path: output, defaultPath, isDefault: false, pendingPath: null }),
    setPendingOutputDirSetting(value) { calls.push(['pending', value]); },
    setOutputDirChangeProgressState(value) { calls.push(['progress', value]); },
    backendProc: null,
    async runOutputDirWorker() {
      calls.push(['worker']);
      throw new Error('migration worker must not run while attachment paths are in use');
    },
    syncOutputDirEnv(value) { calls.push(['env', value]); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(importStart, importEnd), context);
  vm.runInContext(source.slice(changeStart, changeEnd), context);
  const bytes = Uint8Array.from(Buffer.from('clipboard attachment payload')).buffer;
  return {
    dir, output, calls, context,
    entries: [{ name: '剪贴板说明.txt', bytes }],
    import(entries) { return handler({ sender: mainWindow.webContents }, entries); },
    change(next) { return context.applyOutputDirChange(next); },
  };
}

test('IPC stores virtual clipboard bytes under the configured output cache on first use', async (t) => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.output), false);
  const result = await f.import(f.entries);
  assert.equal(result.canceled, false);
  assert.equal(result.attachments.length, 1);
  const attachment = result.attachments[0];
  const cache = path.join(f.output, 'cache', 'chat-attachments');
  const relative = path.relative(cache, attachment.path);
  assert.match(relative, /^wechat-chat-paste-[^\\/]+[\\/]0[\\/]剪贴板说明\.txt$/);
  assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'clipboard attachment payload');
  assert.equal(attachment.kind, 'file');
  assert.equal(f.context.chatAttachmentImportsInProgress, 0);
  assert.equal(f.context.chatAttachmentTempDirectories.size, 1);
  assert.deepEqual(fs.readdirSync(f.dir), ['configured-output']);
});

test('missing output resolution rejects without falling back or writing files', async (t) => {
  const f = fixture(t, { missingOutput: true });
  await assert.rejects(f.import(f.entries), /无法定位 output 目录/);
  assert.equal(f.context.chatAttachmentImportsInProgress, 0);
  assert.equal(f.context.chatAttachmentTempDirectories.size, 0);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('active migration and pending recovery reject imports before filesystem writes', async (t) => {
  for (const options of [{ migrating: true }, { pending: 'another-output' }, { pending: '' }]) {
    const f = fixture(t, options);
    await assert.rejects(f.import(f.entries), /output 目录正在迁移或等待恢复/);
    assert.equal(f.context.chatAttachmentImportsInProgress, 0);
    assert.equal(f.context.chatAttachmentTempDirectories.size, 0);
    assert.deepEqual(fs.readdirSync(f.dir), []);
  }
});

test('import failure resets the in-flight count and leaves no owned temporary directory', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.import([...f.entries, { path: path.join(f.dir, 'missing.txt') }]),
    { code: 'ENOENT' },
  );
  assert.equal(f.context.chatAttachmentImportsInProgress, 0);
  assert.equal(f.context.chatAttachmentTempDirectories.size, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.output, 'cache', 'chat-attachments')), []);
});

test('output migration cannot start during an actual clipboard import', async (t) => {
  const f = fixture(t);
  const importing = f.import(f.entries);
  try {
    assert.equal(f.context.chatAttachmentImportsInProgress, 1);
    await assert.rejects(f.change(path.join(f.dir, 'new-output')), /本次运行仍有粘贴附件缓存/);
    assert.equal(f.calls.some(([name]) => ['pending', 'worker', 'commit'].includes(name)), false);
    assert.equal(fs.existsSync(path.join(f.dir, 'new-output')), false);
  } finally {
    await importing;
  }
  assert.equal(f.context.chatAttachmentImportsInProgress, 0);
});

test('output migration rejects owned clipboard files and preserves their absolute paths', async (t) => {
  const f = fixture(t);
  const result = await f.import(f.entries);
  const attachment = result.attachments[0];
  await assert.rejects(f.change(path.join(f.dir, 'new-output')), /本次运行仍有粘贴附件缓存/);
  assert.equal(f.calls.some(([name]) => ['pending', 'worker', 'commit'].includes(name)), false);
  assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'clipboard attachment payload');
  assert.equal(f.context.chatAttachmentTempDirectories.size, 1);
});

test('keeping the same output remains a no-op even with in-flight and owned attachments', async (t) => {
  const f = fixture(t);
  const result = await f.import(f.entries);
  f.context.chatAttachmentImportsInProgress = 1;
  const unchanged = await f.change(f.output);
  assert.equal(unchanged.success, true);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.path, f.output);
  assert.equal(f.calls.some(([name]) => ['pending', 'worker'].includes(name)), false);
  assert.equal(fs.readFileSync(result.attachments[0].path, 'utf8'), 'clipboard attachment payload');
});
