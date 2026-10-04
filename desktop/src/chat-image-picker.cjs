const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');

async function chooseChatImage({ event, parentWindow, dialog, nativeImage }) {
  if (!parentWindow || event.sender !== parentWindow.webContents) {
    throw new Error('图片选择请求来源不是主窗口');
  }
  const result = await dialog.showOpenDialog(parentWindow, {
    title: '选择要发送的图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (result.canceled) return { canceled: true };
  return {
    canceled: false,
    attachments: await selectedAttachments(result.filePaths, nativeImage, true),
  };
}

async function imagePreview(imagePath, nativeImage) {
  const bytes = await fs.readFile(imagePath);
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error(`图片解码失败，文件可能损坏或不是有效图片：${imagePath}`);
  const { width, height } = image.getSize();
  const scale = Math.min(1, 320 / Math.max(width, height));
  const preview = scale < 1 ? image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  }) : image;
  return preview.toDataURL();
}

async function chooseChatFile({ event, parentWindow, dialog, nativeImage }) {
  if (!parentWindow || event.sender !== parentWindow.webContents) {
    throw new Error('文件选择请求来源不是主窗口');
  }
  const result = await dialog.showOpenDialog(parentWindow, {
    title: '选择要发送的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '所有文件', extensions: ['*'] }],
  });
  if (result.canceled) return { canceled: true };
  return {
    canceled: false,
    attachments: await selectedAttachments(result.filePaths, nativeImage, false),
  };
}

async function selectedAttachments(filePaths, nativeImage, imagesOnly) {
  if (filePaths.length === 0) throw new Error('至少选择一个附件');
  const attachments = [];
  for (const filePath of filePaths) {
    if (!path.isAbsolute(filePath)) throw new Error(`请选择本地绝对路径文件：${filePath}`);
    const kind = ['.png', '.jpg', '.jpeg'].includes(path.extname(filePath).toLowerCase()) ? 'image' : 'file';
    if (imagesOnly && kind !== 'image') throw new Error(`请选择本地 PNG 或 JPEG 图片：${filePath}`);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`请选择普通文件，不能发送目录：${filePath}`);
    const file = await fs.open(filePath, 'r');
    await file.close();
    attachments.push({
      path: filePath,
      name: path.basename(filePath),
      sizeBytes: stat.size,
      kind,
      ...(kind === 'image' ? { previewDataUrl: await imagePreview(filePath, nativeImage) } : {}),
    });
  }
  return attachments;
}

async function importChatAttachments({ event, parentWindow, entries, nativeImage, tempRoot, tempDirectories }) {
  if (!parentWindow || event.sender !== parentWindow.webContents) {
    throw new Error('附件粘贴请求来源不是主窗口');
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('粘贴附件列表不能为空');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new TypeError('粘贴附件格式无效');
    if ('path' in entry) {
      if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || 'bytes' in entry) {
        throw new TypeError('磁盘附件必须提供本地绝对路径，不能同时提供字节');
      }
    } else if (typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' ||
      /[\\/:*?"<>|\u0000-\u001f]/.test(entry.name) || /[. ]$/.test(entry.name) || !(entry.bytes instanceof ArrayBuffer)) {
      throw new TypeError('虚拟附件文件名或字节格式无效');
    }
  }

  if (entries.some(entry => !('path' in entry)) &&
      (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot))) {
    throw new TypeError('附件缓存目录必须是本地绝对路径');
  }

  let tempDirectory;
  try {
    const filePaths = [];
    for (const [index, entry] of entries.entries()) {
      if ('path' in entry) {
        filePaths.push(entry.path);
      } else {
        if (!tempDirectory) {
          await fs.mkdir(tempRoot, { recursive: true });
          tempDirectory = await fs.mkdtemp(path.join(tempRoot, 'wechat-chat-paste-'));
        }
        const directory = path.join(tempDirectory, String(index));
        await fs.mkdir(directory);
        const filePath = path.join(directory, entry.name);
        await fs.writeFile(filePath, Buffer.from(entry.bytes), { flag: 'wx' });
        filePaths.push(filePath);
      }
    }
    const attachments = await selectedAttachments(filePaths, nativeImage, false);
    if (tempDirectory) tempDirectories.add(tempDirectory);
    return { canceled: false, attachments };
  } catch (error) {
    if (tempDirectory) {
      try {
        await fs.rm(tempDirectory, { recursive: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `附件粘贴失败且临时目录清理失败：${error.message}；${cleanupError.message}`);
      }
    }
    throw error;
  }
}

function disposeChatAttachmentTemps(tempDirectories) {
  const errors = [];
  for (const directory of tempDirectories) {
    try {
      rmSync(directory, { recursive: true });
      tempDirectories.delete(directory);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, `粘贴附件临时目录清理失败：${errors.map(error => error.message).join('；')}`);
}

module.exports = { chooseChatImage, chooseChatFile, importChatAttachments, disposeChatAttachmentTemps };
