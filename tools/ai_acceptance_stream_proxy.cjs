// 仅供桌面验收：真实关闭 SSE 传输连接，应用后端和模型任务继续运行。
const http = require('node:http')

async function createStreamProxy(backend, { passthrough = false, port = 0 } = {}) {
  const target = new URL(backend)
  if (target.hostname !== '127.0.0.1') throw new Error('验收代理只允许本机后端')
  const active = new Set(), requests = [], images = []
  const missingImages = new Set()
  let blocked = false
  const server = http.createServer((request, response) => {
    const mediaUrl = new URL(request.url, target)
    // 只对明确指定的验收图片模拟缺失，不改原图或其他接口。
    if (mediaUrl.pathname === '/api/chat/media/image' || mediaUrl.pathname === '/chat/media/image') {
      const md5 = mediaUrl.searchParams.get('md5') || ''
      const missing = missingImages.has(md5)
      images.push({ md5, missing, at: Date.now() })
      if (missing) { response.writeHead(404, { 'cache-control': 'no-store' }).end(); return }
    }
    const isStream = request.url.startsWith('/api/ai/agent/events?')
    if (!isStream && !passthrough) { response.writeHead(404).end(); return }
    const entry = isStream ? { last_event_id: request.headers['last-event-id'] || '', at: Date.now() } : null
    if (entry) requests.push(entry)
    if (isStream && blocked) { response.destroy(); return }
    if (isStream) active.add(response)
    // 保留浏览器入口 Host，使后端的补斜杠重定向仍经过同源代理。
    const upstream = http.request(new URL(request.url, target), { method: request.method, headers: { ...request.headers } }, incoming => {
      if (entry) {
        entry.status = incoming.statusCode
        let tail = ''
        // 仅记录事件编号，不保存聊天正文或设置请求。
        incoming.on('data', chunk => {
          const lines = (tail + chunk.toString()).split('\n')
          tail = lines.pop().slice(-64)
          for (const line of lines) {
            const match = /^id:\s*(\d+)\s*$/.exec(line)
            if (match) entry.last_seen_event_id = Number(match[1])
          }
        })
      }
      response.writeHead(incoming.statusCode, incoming.headers)
      incoming.pipe(response)
    })
    request.pipe(upstream)
    upstream.on('error', () => response.destroy())
    response.on('close', () => { active.delete(response); upstream.destroy() })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    images,
    setMissingImage(md5, missing) {
      if (!/^[a-f0-9]{32}$/.test(md5)) throw new Error('需要有效的图片 MD5')
      if (missing) missingImages.add(md5)
      else missingImages.delete(md5)
    },
    drop() { blocked = true; for (const response of active) response.destroy() },
    resume() { blocked = false },
    async close() { for (const response of active) response.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}

module.exports = { createStreamProxy }
