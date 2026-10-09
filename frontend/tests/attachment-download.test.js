import { expect, it } from 'vitest';
import { readAttachmentDownload } from '../utils/attachmentDownload';

it('keeps the authoritative extension and unicode filename from the response', async () => {
  const name = '会议 图片.png';
  const result = await readAttachmentDownload(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } }));
  expect(result.filename).toBe(name);
  expect(result.blob.size).toBe(3);
});
it('exposes JSON download errors and rejects responses missing the filename', async () => {
  await expect(readAttachmentDownload(new Response(JSON.stringify({ detail: { message: '原附件已丢失' } }), { status: 404 }))).rejects.toThrow('原附件已丢失');
  await expect(readAttachmentDownload(new Response('bytes'))).rejects.toThrow('附件响应缺少文件名');
});
