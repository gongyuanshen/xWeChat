const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pickerModule = require('../src/chat-image-picker.cjs');

function fixture(t, { canceled = false, invalid = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-image-picker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writeFile = (name, contents = 'selected image bytes') => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return file;
  };
  const file = writeFile('照片.png');
  const calls = [];
  const parentWindow = { webContents: {} };
  const event = { sender: parentWindow.webContents };
  const dialog = { async showOpenDialog(parent, options) {
    calls.push({ parent, options });
    return { canceled, filePaths: canceled ? [] : [file] };
  } };
  // Electron's native dialog and decoder require an Electron process.
  // Filesystem access and attachment construction remain real in these tests.
  const nativeImage = { createFromBuffer(bytes) {
    return {
      isEmpty: () => invalid || bytes.toString() === 'corrupt image',
      getSize: () => ({ width: 1200, height: 600 }),
      resize(options) {
        assert.equal(options.width, 320);
        assert.equal(options.height, 160);
        return { toDataURL: () => 'data:image/png;base64,dGh1bWJuYWls' };
      },
      toDataURL: () => 'data:image/png;base64,b3JpZ2luYWw='
    };
  } };
  return { file, dir, writeFile, calls, parentWindow, event, dialog, nativeImage };
}

test('图片单选也返回包含类型、大小和缩略图的 attachments 数组，启用 PNG/JPEG 多选', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await pickerModule.chooseChatImage(f), {
    canceled: false,
    attachments: [{ path: f.file, name: '照片.png', kind: 'image', sizeBytes: 20,
      previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls' }]
  });
  assert.equal(f.calls[0].parent, f.parentWindow);
  assert.deepEqual(f.calls[0].options.properties, ['openFile', 'multiSelections']);
  assert.deepEqual(f.calls[0].options.filters, [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }]);
});

test('图片多选按原生选择顺序返回所有 PNG/JPG/JPEG 图片', async (t) => {
  const f = fixture(t);
  const jpg = f.writeFile('第二张.JPG');
  const jpeg = f.writeFile('第三张.jpeg');
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [jpg, f.file, jpeg] });
  assert.deepEqual(await pickerModule.chooseChatImage(f), {
    canceled: false,
    attachments: [
      { path: jpg, name: '第二张.JPG', kind: 'image', sizeBytes: 20, previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls' },
      { path: f.file, name: '照片.png', kind: 'image', sizeBytes: 20, previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls' },
      { path: jpeg, name: '第三张.jpeg', kind: 'image', sizeBytes: 20, previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls' },
    ]
  });
});

for (const [name, choose] of [['图片', pickerModule.chooseChatImage], ['文件', pickerModule.chooseChatFile]]) {
  test(`${name}明确取消不会访问已消失文件或生成成功路径`, async (t) => {
    const f = fixture(t, { canceled: true });
    fs.unlinkSync(f.file);
    f.nativeImage.createFromBuffer = () => { throw new Error('取消后不应解码'); };
    assert.deepEqual(await choose(f), { canceled: true });
  });

  test(`${name}原生对话框异常直接传播`, async (t) => {
    const f = fixture(t);
    f.dialog.showOpenDialog = async () => { throw new Error('native dialog failed'); };
    await assert.rejects(choose(f), /native dialog failed/);
  });

  test(`${name}拒绝非主窗口和缺失主窗口，不弹出对话框`, async (t) => {
    const f = fixture(t);
    await assert.rejects(choose({ ...f, event: { sender: {} } }), /来源|主窗口/);
    await assert.rejects(choose({ ...f, parentWindow: null }), /来源|主窗口/);
    assert.equal(f.calls.length, 0);
  });

  test(`${name}读取失败保留真实错误，不伪装成取消`, async (t) => {
    const f = fixture(t);
    fs.unlinkSync(f.file);
    await assert.rejects(choose(f), { code: 'ENOENT' });
  });

  test(`${name}拒绝非取消的空选择、相对路径和目录`, async (t) => {
    const f = fixture(t);
    const directory = path.join(f.dir, 'directory.png');
    fs.mkdirSync(directory);
    for (const [filePaths, expected] of [
      [[], /至少|不能为空/],
      [['relative.png'], /绝对路径|本地/],
      [[directory], /普通文件|目录/],
    ]) {
      f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
      await assert.rejects(choose(f), expected);
    }
  });

  test(`${name}批次中第二项丢失时整批抛出读取错误`, async (t) => {
    const f = fixture(t);
    const second = path.join(f.dir, 'missing.png');
    f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f.file, second] });
    await assert.rejects(choose(f), { code: 'ENOENT' });
  });

  test(`${name}批次中第二张图片损坏时整批拒绝且顺序处理`, async (t) => {
    const f = fixture(t);
    const corrupt = f.writeFile('损坏.png', 'corrupt image');
    const third = f.writeFile('第三张.png');
    f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f.file, corrupt, third] });
    const decode = f.nativeImage.createFromBuffer;
    f.nativeImage.createFromBuffer = (bytes) => {
      if (bytes.toString() === 'corrupt image') fs.unlinkSync(third);
      return decode(bytes);
    };
    await assert.rejects(choose(f), /图片.*(解码|损坏|无效)/);
  });
}

test('图片批次中混入非 PNG/JPEG 文件时整批拒绝', async (t) => {
  const f = fixture(t);
  const text = f.writeFile('报告.txt', 'file content');
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f.file, text] });
  await assert.rejects(pickerModule.chooseChatImage(f), /PNG|JPEG/);
});

test('文件单选也返回数组，普通文件包含元数据且不调用图片解码', async (t) => {
  const f = fixture(t);
  const file = f.writeFile('报告.any-format', 'file content');
  f.nativeImage.createFromBuffer = () => { throw new Error('普通文件不应解码'); };
  f.dialog.showOpenDialog = async (parent, options) => {
    f.calls.push({ parent, options });
    return { canceled: false, filePaths: [file] };
  };
  assert.deepEqual(await pickerModule.chooseChatFile(f), {
    canceled: false,
    attachments: [{ path: file, name: '报告.any-format', sizeBytes: 12, kind: 'file' }]
  });
  assert.equal(f.calls[0].parent, f.parentWindow);
  assert.deepEqual(f.calls[0].options.properties, ['openFile', 'multiSelections']);
  assert.deepEqual(f.calls[0].options.filters, [{ name: '所有文件', extensions: ['*'] }]);
});

test('文件多选按顺序返回全部普通文件', async (t) => {
  const f = fixture(t);
  const first = f.writeFile('报告.pdf', 'file content');
  const second = f.writeFile('日志.txt', 'log');
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [first, second] });
  assert.deepEqual(await pickerModule.chooseChatFile(f), {
    canceled: false,
    attachments: [
      { path: first, name: '报告.pdf', kind: 'file', sizeBytes: 12 },
      { path: second, name: '日志.txt', kind: 'file', sizeBytes: 3 },
    ]
  });
});

test('文件入口混选图片和普通文件时分类并复用 PNG/JPG/JPEG 缩略图', async (t) => {
  const f = fixture(t);
  const text = f.writeFile('报告.txt', 'file content');
  const jpg = f.writeFile('照片.JPG');
  const jpeg = f.writeFile('照片.jpeg');
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f.file, text, jpg, jpeg] });
  assert.deepEqual(await pickerModule.chooseChatFile(f), {
    canceled: false,
    attachments: [
      { path: f.file, name: '照片.png', kind: 'image', sizeBytes: 20, previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls' },
      { path: text, name: '报告.txt', kind: 'file', sizeBytes: 12 },
      { path: jpg, name: '照片.JPG', kind: 'image', sizeBytes: 20, previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls' },
      { path: jpeg, name: '照片.jpeg', kind: 'image', sizeBytes: 20, previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls' },
    ]
  });
});

test('文件批次中第二项为目录时整批拒绝', async (t) => {
  const f = fixture(t);
  const file = f.writeFile('报告.txt', 'file content');
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file, f.dir] });
  await assert.rejects(pickerModule.chooseChatFile(f), /普通文件|目录/);
});

test('两个入口仅使用原生选择结果，忽略 renderer 提供的路径', async (t) => {
  const f = fixture(t);
  for (const choose of [pickerModule.chooseChatImage, pickerModule.chooseChatFile]) {
    const result = await choose({ ...f, path: path.join(f.dir, 'renderer-only.png') });
    assert.equal(result.attachments[0].path, f.file);
  }
});

test('粘贴混合附件复用磁盘路径和类型，并保留临时截图直到显式退出清理', async (t) => {
  const f = fixture(t);
  const document = f.writeFile('报告.pdf', 'document');
  const tempDirectories = new Set();
  const bytes = Uint8Array.from(Buffer.from('clipboard image bytes')).buffer;
  assert.equal(typeof pickerModule.importChatAttachments, 'function');
  const result = await pickerModule.importChatAttachments({ ...f, tempRoot: f.dir, tempDirectories,
    entries: [{ path: document }, { name: '截图.png', bytes }] });
  assert.equal(result.canceled, false);
  assert.equal(result.attachments[0].path, document);
  assert.equal(result.attachments[0].kind, 'file');
  const screenshot = result.attachments[1];
  assert.equal(screenshot.name, '截图.png');
  assert.equal(screenshot.kind, 'image');
  assert.equal(screenshot.sizeBytes, 21);
  assert.equal(screenshot.previewDataUrl, 'data:image/png;base64,dGh1bWJuYWls');
  assert.equal(fs.readFileSync(screenshot.path, 'utf8'), 'clipboard image bytes');
  assert.equal(tempDirectories.size, 1);
  pickerModule.disposeChatAttachmentTemps(tempDirectories);
  assert.equal(fs.existsSync(screenshot.path), false);
  assert.equal(fs.readFileSync(document, 'utf8'), 'document');
  assert.equal(tempDirectories.size, 0);
});

test('虚拟同名文件保留顺序和原始名字，写入互不覆盖的路径', async (t) => {
  const f = fixture(t);
  const tempDirectories = new Set();
  const entries = ['first', 'second'].map(value => ({ name: '报告.txt', bytes: Uint8Array.from(Buffer.from(value)).buffer }));
  assert.equal(typeof pickerModule.importChatAttachments, 'function');
  const result = await pickerModule.importChatAttachments({ ...f, tempRoot: f.dir, tempDirectories, entries });
  assert.notEqual(result.attachments[0].path, result.attachments[1].path);
  assert.deepEqual(result.attachments.map(item => item.name), ['报告.txt', '报告.txt']);
  assert.deepEqual(result.attachments.map(item => fs.readFileSync(item.path, 'utf8')), ['first', 'second']);
  pickerModule.disposeChatAttachmentTemps(tempDirectories);
});

test('粘贴拒绝错误窗口、空批次、伪造条目和目录穿越，不写入临时目录', async (t) => {
  const f = fixture(t);
  const tempDirectories = new Set();
  const bytes = new ArrayBuffer(1);
  assert.equal(typeof pickerModule.importChatAttachments, 'function');
  for (const entries of [[], [{}], [{ path: f.file, bytes }], [{ name: '../escaped.txt', bytes }],
    [{ name: 'C:\\escaped.txt', bytes }], [{ name: '截图.png', bytes: [1, 2] }]]) {
    await assert.rejects(pickerModule.importChatAttachments({ ...f, tempRoot: f.dir, tempDirectories, entries }), /附件|文件名|格式/);
  }
  await assert.rejects(pickerModule.importChatAttachments({ ...f, event: { sender: {} }, tempRoot: f.dir, tempDirectories,
    entries: [{ path: f.file }] }), /来源|主窗口/);
  assert.equal(tempDirectories.size, 0);
  assert.deepEqual(fs.readdirSync(f.dir), ['照片.png']);
});

test('粘贴批次解码失败时拒绝整批并清理已创建截图，保留真实读取错误', async (t) => {
  const f = fixture(t);
  const tempDirectories = new Set();
  assert.equal(typeof pickerModule.importChatAttachments, 'function');
  await assert.rejects(pickerModule.importChatAttachments({ ...f, tempRoot: f.dir, tempDirectories,
    entries: [{ name: '截图.png', bytes: Uint8Array.from(Buffer.from('corrupt image')).buffer }] }), /解码失败/);
  assert.equal(tempDirectories.size, 0);
  assert.deepEqual(fs.readdirSync(f.dir), ['照片.png']);
  await assert.rejects(pickerModule.importChatAttachments({ ...f, tempRoot: f.dir, tempDirectories,
    entries: [{ name: '截图.png', bytes: new ArrayBuffer(1) }, { path: path.join(f.dir, 'missing.pdf') }] }), { code: 'ENOENT' });
  assert.deepEqual(fs.readdirSync(f.dir), ['照片.png']);
});
