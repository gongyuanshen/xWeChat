const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modulePath = path.join(__dirname, '../src/chat-image-picker.cjs');
const pickerModule = fs.existsSync(modulePath) ? require(modulePath) : {};

test('原生图片选择入口可调用', () => {
  assert.equal(typeof pickerModule.chooseChatImage, 'function');
});

function fixture(t, { canceled = false, invalid = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-image-picker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '照片.png');
  fs.writeFileSync(file, Buffer.from('selected image bytes'));
  const calls = [];
  const parentWindow = { webContents: {} };
  const event = { sender: parentWindow.webContents };
  const dialog = { async showOpenDialog(parent, options) {
    calls.push({ parent, options });
    return { canceled, filePaths: canceled ? [] : [file] };
  } };
  // Electron's native decoder is only available in an Electron process.
  const nativeImage = { createFromBuffer(bytes) {
    assert.equal(bytes.toString(), 'selected image bytes');
    return {
      isEmpty: () => invalid,
      getSize: () => ({ width: 1200, height: 600 }),
      resize(options) {
        assert.equal(options.width, 320);
        assert.equal(options.height, 160);
        return { toDataURL: () => 'data:image/png;base64,dGh1bWJuYWls' };
      },
      toDataURL: () => 'data:image/png;base64,b3JpZ2luYWw='
    };
  } };
  return { file, dir, calls, parentWindow, event, dialog, nativeImage };
}

test('选择原图返回绝对路径和 data URL 缩略图，固定单选 PNG/JPEG', async (t) => {
  const f = fixture(t);
  const result = await pickerModule.chooseChatImage(f);
  assert.deepEqual(result, {
    canceled: false, path: f.file, name: '照片.png', previewDataUrl: 'data:image/png;base64,dGh1bWJuYWls'
  });
  assert.equal(f.calls[0].parent, f.parentWindow);
  assert.deepEqual(f.calls[0].options.properties, ['openFile']);
  assert.deepEqual(f.calls[0].options.filters, [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }]);
});

test('明确取消不会读取图片或生成成功路径', async (t) => {
  const f = fixture(t, { canceled: true });
  f.nativeImage.createFromBuffer = () => { throw new Error('取消后不应解码'); };
  assert.deepEqual(await pickerModule.chooseChatImage(f), { canceled: true });
});

test('无效图像直接拒绝，不返回空预览', async (t) => {
  const f = fixture(t, { invalid: true });
  await assert.rejects(pickerModule.chooseChatImage(f), /图片.*(解码|损坏|无效)/);
});

test('读取失败保留真实错误，不伪装成取消', async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  await assert.rejects(pickerModule.chooseChatImage(f), { code: 'ENOENT' });
});

test('原生对话框异常直接传播', async (t) => {
  const f = fixture(t);
  f.dialog.showOpenDialog = async () => { throw new Error('native dialog failed'); };
  await assert.rejects(pickerModule.chooseChatImage(f), /native dialog failed/);
});

test('不读取 renderer 提供的路径，拒绝非图片扩展名', async (t) => {
  const f = fixture(t);
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(f.dir, 'secret.txt')] });
  await assert.rejects(pickerModule.chooseChatImage({ ...f, path: f.file }), /PNG|JPEG/);
});

test('拒绝非主窗口调用，在来源拒绝时不弹对话框', async (t) => {
  const f = fixture(t);
  await assert.rejects(pickerModule.chooseChatImage({ ...f, event: { sender: {} } }), /来源|主窗口/);
  assert.equal(f.calls.length, 0);
});
