// 仅供桌面验收：真实关闭 SSE 传输连接，应用后端和模型任务继续运行。
const http = require('node:http')

// WHATWG Fetch / undici 规范禁止访问的受限端口列表（避免 fetch 抛出 TypeError: fetch failed / Error: bad port）
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080
])

function isBlockedPort(port) {
  return BLOCKED_PORTS.has(Number(port))
}

async function listenSafe(server, port = 0, host = '127.0.0.1') {
  const targetPort = Number(port) || 0
  if (targetPort !== 0) {
    if (isBlockedPort(targetPort)) {
      throw new Error(`指定的代理端口 ${targetPort} 属于受限端口 (WHATWG bad port)，无法用于 HTTP 验收代理`)
    }
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve(server.address().port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(targetPort, host)
    })
  }

  const maxRetries = 50
  const heldServers = []
  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(0, host)
      })

      const allocated = server.address().port
      if (!isBlockedPort(allocated)) {
        return allocated
      }

      await new Promise(resolve => server.close(resolve))

      const dummy = http.createServer()
      await new Promise((resolve) => {
        dummy.once('error', () => resolve())
        dummy.once('listening', () => resolve())
        dummy.listen(allocated, host)
      })
      heldServers.push(dummy)

      if (attempt === maxRetries) {
        throw new Error(`尝试 ${maxRetries} 次仍未分配到安全的临时端口`)
      }
    }
  } finally {
    for (const dummy of heldServers) {
      if (dummy.listening) {
        await new Promise(resolve => dummy.close(resolve))
      }
    }
  }
}

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
  await listenSafe(server, port, '127.0.0.1')
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

module.exports = { createStreamProxy, listenSafe, isBlockedPort, BLOCKED_PORTS }
