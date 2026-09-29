const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createStreamProxy } = require('../../tools/ai_acceptance_stream_proxy.cjs')

test('图片故障仅影响指定 MD5 的图片接口，恢复后继续读取原内容', async () => {
  let upstream = 0
  const backend = http.createServer((req, res) => { upstream++; res.end('原内容') })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  const proxy = await createStreamProxy(`http://127.0.0.1:${backend.address().port}`, { passthrough: true })
  const md5 = 'a'.repeat(32)
  const path = '/api/chat/media/image?md5=' + md5
  try {
    assert.throws(() => proxy.setMissingImage('*', true))
    proxy.setMissingImage(md5, true)
    const missing = await fetch(proxy.url + path)
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('cache-control'), 'no-store')
    assert.equal(upstream, 0)
    for (const url of ['/api/other?md5=' + md5, '/api/chat/media/image?md5=' + 'b'.repeat(32)]) {
      assert.equal(await (await fetch(proxy.url + url)).text(), '原内容')
    }
    proxy.setMissingImage(md5, false)
    assert.equal(await (await fetch(proxy.url + path)).text(), '原内容')
    assert.equal(upstream, 3)
    assert.deepEqual(proxy.images.map(x => x.missing), [true, false, false])
  } finally {
    await proxy.close()
    backend.closeAllConnections()
    await new Promise(resolve => backend.close(resolve))
  }
})

test('验收代理切断真实流连接，重连保留 Last-Event-ID，后端保持可用', async () => {
  const received = []
  const backend = http.createServer((req, res) => {
    received.push(req.headers['last-event-id'] || '')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('id: 7\ndata: {"version":1}\n\n')
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  const proxy = await createStreamProxy(`http://127.0.0.1:${backend.address().port}`)
  try {
    const response = await fetch(proxy.url + '/api/ai/agent/events?account=test')
    const reader = response.body.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value), /id: 7/)
    proxy.drop()
    await assert.rejects(reader.read())
    proxy.resume()
    const again = await fetch(proxy.url + '/api/ai/agent/events?account=test', { headers: { 'Last-Event-ID': '7' } })
    await again.body.cancel()
    assert.deepEqual(received, ['', '7'])
    assert.equal(proxy.requests[1].last_event_id, '7')
  } finally {
    await proxy.close()
    backend.closeAllConnections()
    await new Promise(resolve => backend.close(resolve))
  }
})

test('同源转发保留普通请求方法和正文，断流不影响其他 API', async () => {
  const backend = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.writeHead(200, { 'content-type':'application/json' })
    res.end(JSON.stringify({ method:req.method, body, host:req.headers.host }))
  })
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))
  const proxy = await createStreamProxy(`http://127.0.0.1:${backend.address().port}`, { passthrough:true })
  try {
    proxy.drop()
    const response=await fetch(proxy.url+'/api/test', { method:'POST',body:'消息正文' })
    assert.deepEqual(await response.json(), { method:'POST',body:'消息正文',host:new URL(proxy.url).host })
    assert.equal(proxy.requests.length,0)
  } finally {
    await proxy.close()
    backend.closeAllConnections()
    await new Promise(resolve=>backend.close(resolve))
  }
})
