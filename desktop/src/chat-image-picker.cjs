const fs = require('node:fs/promises');
const path = require('node:path');

async function chooseChatImage({ event, parentWindow, dialog, nativeImage }) {
  if (!parentWindow || event.sender !== parentWindow.webContents) {
    throw new Error('图片选择请求来源不是主窗口');
  }
  const result = await dialog.showOpenDialog(parentWindow, {
    title: '选择要发送的图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (result.canceled) return { canceled: true };
  if (result.filePaths.length !== 1) throw new Error('必须选择一张图片');

  const imagePath = result.filePaths[0];
  if (!path.isAbsolute(imagePath) || !['.png', '.jpg', '.jpeg'].includes(path.extname(imagePath).toLowerCase())) {
    throw new Error('请选择本地 PNG 或 JPEG 图片');
  }
  const bytes = await fs.readFile(imagePath);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('图片解码失败，文件可能损坏或不是有效图片');
  const { width, height } = image.getSize();
  const scale = Math.min(1, 320 / Math.max(width, height));
  const preview = scale < 1 ? image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  }) : image;
  return {
    canceled: false,
    path: imagePath,
    name: path.basename(imagePath),
    previewDataUrl: preview.toDataURL(),
  };
}

module.exports = { chooseChatImage };
