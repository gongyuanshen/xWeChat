// Real Chrome + real recognition components; only the fixture HTTP/SSE boundary is synthetic.
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { parseArgs } = require('node:util')
const { values } = parseArgs({ options: { browser: { type: 'string' }, output: { type: 'string' }, fixture: { type: 'string', default: 'http://127.0.0.1:3074/tests/fixtures/live-recognition.html' } } })
if (!values.browser || !values.output) throw new Error('Require --browser and --output')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  const output = path.resolve(values.output)
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'isolated-profile-'))
  const browser = spawn(values.browser, ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=3075', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  const result = { synthetic_only: true, real_components: ['ConversationPane', 'MessageRecognitionControl', 'MessageList', 'MessageItem', 'MessageInsightLabel', 'useMessageRecognition'], real_model_calls: 0, checks: [], errors: [] }
  result.browser_pid = browser.pid
  const browserClosed = new Promise(resolve => browser.once('exit', resolve))
  browser.stderr.on('data', data => { result.browser_stderr = ((result.browser_stderr || '') + data.toString()).slice(-8192) })
  browser.on('exit', (code, signal) => { result.browser_exit = { code, signal } })
  let socket, id = 0
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout ${method}`)) }, 12000); pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params })) })
  let evaluate
  try {
    const port = 3075
    result.cdp_port = port
    let pages
    const deadline = Date.now() + 10000
    for (;;) {
      try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json(); if (pages.some(page => page.type === 'page')) break }
      catch (error) { if (Date.now() >= deadline || result.browser_exit) { result.connection_cause = { code: error.cause?.code, message: error.cause?.message }; throw error } }
      if (Date.now() >= deadline) throw new Error('Chrome startup deadline exceeded')
      await pause(100)
    }
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id) { const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result) }
      if (message.method === 'Runtime.exceptionThrown') result.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
    }
    await send('Page.enable'); await send('Runtime.enable')
    evaluate = async expression => { const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails)); return response.result.value }
    const wait = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(100) } throw new Error(`Condition failed: ${expression}`) }
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const snapshot = () => evaluate('window.liveAcceptance.snapshot()')
    const shot = async name => { const capture = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(capture.data, 'base64')) }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: values.fixture })
    await wait('window.liveAcceptance?.snapshot().ready && document.querySelector("[role=switch]")')
    let state = await snapshot()
    assert.equal(state.enabled, false); assert.equal(state.requests.filter(r => r.path.endsWith('/batches')).length, 0)
    assert.match(await evaluate('document.body.textContent'), /开启后自动调用 API，可能产生费用/)
    result.checks.push('default_off_and_cost_warning')
    await click('[role=switch]'); await wait('window.liveAcceptance.snapshot().batch?.status === "running"')
    await click('[data-test=partial]'); await wait('document.querySelectorAll(".message-insight-label").length === 1')
    assert.equal((await snapshot()).batch.status, 'running')
    result.checks.push('complete_label_visible_before_batch_finished')
    await shot('desktop-light-partial')
    await click('[data-test=finish]'); await wait('window.liveAcceptance.snapshot().batch?.status === "completed"')
    await wait('document.querySelectorAll(".message-insight-label").length === 3')
    const before = (await snapshot()).requests.filter(r => r.path.endsWith('/batches')).length
    await click('[role=switch]'); await wait('!window.liveAcceptance.snapshot().enabled && document.querySelectorAll(".message-insight-label").length === 0')
    await click('[role=switch]'); await wait('window.liveAcceptance.snapshot().enabled && document.querySelectorAll(".message-insight-label").length === 3')
    assert.equal((await snapshot()).requests.filter(r => r.path.endsWith('/batches')).length, before)
    result.checks.push('off_hides_on_restores_without_new_batch')
    await click('[data-test=group]'); await wait('window.liveAcceptance.snapshot().scope.username === "group@chatroom" && window.liveAcceptance.snapshot().ready && !window.liveAcceptance.snapshot().enabled')
    assert.equal(await evaluate('document.querySelector(".recognition-mood") === null'), true)
    await click('[role=switch]'); await wait('window.liveAcceptance.snapshot().batch?.status === "running"')
    await click('[data-test=partial]'); await wait('document.querySelector(".recognition-mood")?.textContent.includes("群聊氛围") && document.querySelectorAll(".message-insight-label").length === 1')
    result.checks.push('group_scope_and_real_header_independent')
    await click('[data-test=fail]'); await wait('document.querySelector(".recognition-error")?.textContent.includes("synthetic-429")')
    const failedCount = (await snapshot()).requests.filter(r => r.path.endsWith('/batches')).length
    await pause(300)
    assert.equal((await snapshot()).requests.filter(r => r.path.endsWith('/batches')).length, failedCount)
    assert.equal(await evaluate('document.querySelectorAll(".message-insight-label").length'), 1)
    await shot('desktop-failure')
    await click('.recognition-error button'); await wait('window.liveAcceptance.snapshot().batch?.status === "running" && !window.liveAcceptance.snapshot().error')
    const retry = (await snapshot()).requests.filter(r => r.path.endsWith('/batches')).at(-1).body
    assert.equal(retry.retry, true); assert.equal(retry.messages.length, 2)
    await click('[data-test=finish]'); await wait('window.liveAcceptance.snapshot().batch?.status === "completed" && document.querySelectorAll(".message-insight-label").length === 3')
    result.checks.push('failed_stream_keeps_partial_explicit_retry_only_missing')
    await click('[data-test=theme]'); await shot('desktop-dark')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await pause(150)
    result.mobile = await evaluate('(()=>{const h=document.querySelector(".chat-header"),r=h.getBoundingClientRect();return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,headerWidth:r.width,headerScrollWidth:h.scrollWidth,headerClientWidth:h.clientWidth,controls:[...h.querySelectorAll("button,select")].map(e=>{const q=e.getBoundingClientRect();return {label:e.ariaLabel||e.title||e.textContent,left:q.left,right:q.right}})}})()')
    await shot('mobile-dark')
    assert.ok(result.mobile.documentWidth <= 390, JSON.stringify(result.mobile))
    assert.ok(result.mobile.headerScrollWidth <= result.mobile.headerClientWidth, JSON.stringify(result.mobile))
    assert.ok(result.mobile.controls.every(control => control.left >= 0 && control.right <= 390), JSON.stringify(result.mobile))
    await click('[data-test=theme]'); await shot('mobile-light')
    result.checks.push('real_header_390px_no_overflow_light_and_dark')
    assert.deepEqual(result.errors, [])
    result.final_state = await snapshot(); result.passed = true
  } catch (error) {
    result.passed = false; result.failure = error.stack; process.exitCode = 1
    if (evaluate) { try { result.debug = await evaluate('({body:document.body.textContent,state:window.liveAcceptance?.snapshot()})'); const capture = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(output, 'failure.png'), Buffer.from(capture.data, 'base64')) } catch (captureError) { result.capture_error = captureError.message } }
  } finally {
    if (socket?.readyState === 1) { try { await send('Browser.close') } catch (error) { result.cleanup_error = error.message }; socket.close() }
    await Promise.race([browserClosed, pause(1000)])
    if (browser.exitCode === null && browser.signalCode === null) { browser.kill(); await Promise.race([browserClosed, pause(1000)]) }
    result.browser_closed = browser.exitCode !== null || browser.signalCode !== null
    for (const waiter of pending.values()) clearTimeout(waiter.timer)
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ passed: result.passed, checks: result.checks, failure: result.failure, errors: result.errors, output }, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
