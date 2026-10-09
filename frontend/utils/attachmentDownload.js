export async function readAttachmentDownload(response) {
  if (!response.ok) {
    const body = await response.json();
    const detail = body.detail;
    throw new Error(typeof detail === 'string' ? detail : detail?.message || JSON.stringify(detail));
  }
  const disposition = response.headers.get('Content-Disposition');
  const filename = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (!filename) throw new Error('附件响应缺少文件名，无法保存，请重试。');
  return { blob: await response.blob(), filename: decodeURIComponent(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') };
}

export function saveAttachmentDownload({ blob, filename }) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
