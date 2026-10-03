// 原生 CDP 隔离验收；无需 Playwright，不连接真实后端或微信。
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { parseArgs } = require('node:util')
const { values } = parseArgs({ options: { browser: { type: 'string' }, output: { type: 'string' }, fixture: { type: 'string', default: 'http://127.0.0.1:3060/tests/fixtures/chat-insights.html' } } })
if (!values.browser || !values.output) throw new Error('需要 --browser 与 --output 参数')
const output = path.resolve(values.output)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  await fs.mkdir(output, { recursive: true })
  const profile = await fs.mkdtemp(path.join(output, 'isolated-profile-'))
  const child = spawn(values.browser, ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=3061', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let socket, sequence = 0, loadListener
  const pending = new Map(), result = { mode: 'headless_synthetic_real_components', remote_model_calls: 0, checks: [], errors: [] }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  try {
    let pages
    for (let i = 0; i < 60; i++) {
      try { pages = await (await fetch('http://127.0.0.1:3061/json/list')).json(); if (pages.some(p => p.type === 'page')) break } catch (err) { if (i === 59) throw err }
      await pause(100)
    }
    const page = pages.find(p => p.type === 'page')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    socket.onmessage = event => {
      const data = JSON.parse(event.data)
      if (data.id) { const waiter = pending.get(data.id); pending.delete(data.id); if (data.error) waiter.reject(new Error(JSON.stringify(data.error))); else waiter.resolve(data.result) }
      if (data.method === 'Runtime.exceptionThrown') result.errors.push(data.params.exceptionDetails.text)
      if (data.method === 'Page.loadEventFired') loadListener?.()
    }
    await send('Page.enable'); await send('Runtime.enable')
    const evaluate = async expression => {
      const data = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (data.exceptionDetails) throw new Error(JSON.stringify(data.exceptionDetails))
      return data.result.value
    }
    const wait = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(100) } throw new Error(`页面条件未满足：${expression}`) }
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const capture = async (name, selector) => {
      const clip = selector ? await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,320),scale:1}})()`) : undefined
      const image = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); await fs.writeFile(path.join(output, `${name}.png`), Buffer.from(image.data, 'base64')); result.checks.push(name)
    }
    const checkLabels = async mode => {
      await wait("document.querySelectorAll('.message-insight-label').length===2")
      const labels = await evaluate("[...document.querySelectorAll('.message-insight-label')].map(t=>{const s=t.querySelector('summary'),r=t.getBoundingClientRect(),b=t.parentElement.querySelector('.msg-bubble').getBoundingClientRect();return {tag:t.tagName,summary:s.textContent,background:getComputedStyle(s).backgroundColor,tagBackground:getComputedStyle(t).backgroundColor,key:getComputedStyle(t.querySelector('.insight-key')).color,value:getComputedStyle(t.querySelector('.insight-value')).color,title:t.title,below:r.top>=b.bottom,overflow:t.scrollWidth-t.clientWidth,left:r.left,right:r.right}})")
      for (const label of labels) {
        assert.equal(label.tag, 'DETAILS'); assert.equal(label.background, 'rgba(0, 0, 0, 0)'); assert.equal(label.tagBackground, 'rgba(0, 0, 0, 0)')
        assert.notEqual(label.key, label.value); assert.ok(label.title); assert.ok(label.below); assert.equal(label.overflow, 0)
        assert.equal(/[：:]/.test(label.summary), false); assert.equal(label.summary.includes('依据'), false)
        assert.ok(label.left >= 0); assert.ok(label.right <= (await evaluate('innerWidth')))
      }
      result[`${mode}_labels`] = labels
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: values.fixture })
    await wait("document.querySelector('.task-detail') && document.body.textContent.includes('人物摘要')")
    await click('[aria-label="显示消息情绪与意图标签"]')
    await wait("document.querySelector('.message-insight-label')")
    result.message_layout = await evaluate("(() => { const tag=document.querySelector('.message-insight-label'), avatar=document.querySelector('.message-avatar').getBoundingClientRect(),bubble=document.querySelector('.msg-bubble').getBoundingClientRect(),rect=tag.getBoundingClientRect();return {in_message_column:tag.parentElement.classList.contains('group'),tag_x:rect.x,avatar_right:avatar.right,tag_top:rect.top,bubble_bottom:bubble.bottom} })()")
    assert.equal(result.message_layout.in_message_column, true)
    assert.ok(result.message_layout.tag_x >= result.message_layout.avatar_right)
    assert.ok(result.message_layout.tag_top >= result.message_layout.bubble_bottom)
    await capture('desktop')
    await checkLabels('api_light')
    await capture('message-labels-light', '.fake-conversation')
    await click('.message-insight-label summary')
    await wait("document.querySelector('.message-insight-label').open")
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.message-insight-label p')).display==='none'"), false)
    await capture('message-labels-evidence', '.fake-conversation')
    await evaluate("document.querySelector('.message-insight-label summary').focus()")
    assert.equal(await evaluate("document.activeElement === document.querySelector('.message-insight-label summary')"), true)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await wait("!document.querySelector('.message-insight-label').open")
    result.checks.push('summary_click_and_keyboard_toggle_evidence')
    await evaluate('document.activeElement.blur()')
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='深色模式').click()")
    await pause(400)
    await checkLabels('api_dark'); await capture('message-labels-dark', '.fake-conversation')
    await click('[aria-label="关闭画像面板"]')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await checkLabels('api_mobile_dark'); await capture('message-labels-mobile-dark')
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='切换长标签样例').click()")
    await checkLabels('api_mobile_long'); await capture('message-labels-mobile-long')
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='切换长标签样例').click()")
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='浅色模式').click()")
    await pause(400)
    await checkLabels('api_mobile_light'); await capture('message-labels-mobile-light')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='重新打开画像').click()")
    await wait("document.querySelector('.task-detail')")
    await click('[data-source="a"]')
    await wait("document.body.textContent.includes('已定位：synthetic:message:1')")
    await evaluate("document.querySelector('.insights-scroll').scrollTop=document.querySelector('.task-detail').offsetTop - 140")
    await capture('desktop-portrait')
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='编辑示例消息').click()")
    await wait("!document.querySelector('.message-insight-label')")
    result.checks.push('changed_text_hides_old_tag')
    await click('[aria-label="展开画像面板"]')
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='深色模式').click()")
    await capture('desktop-expanded-dark')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    result.mobile_layout = await evaluate("(() => {const p=document.querySelector('.chat-insights-panel'),s=document.querySelector('.insights-scroll'),r=p.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,overflow:s.scrollWidth-s.clientWidth}})()")
    assert.ok(result.mobile_layout.width <= 390); assert.equal(result.mobile_layout.overflow, 0)
    await capture('mobile-dark')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    const reloaded = new Promise(resolve => { loadListener = resolve })
    await send('Page.reload'); await reloaded; loadListener = null
    await wait("document.querySelector('.task-detail') && document.body.textContent.includes('人物摘要')")
    await click('.agent-model-menu>summary'); await click('[aria-label="切换模型"]'); await click('.manual-toggle')
    await evaluate("(() => {const i=document.querySelector('[aria-label=\"手动模型 ID\"]');i.value='manual-enter';i.dispatchEvent(new Event('input',{bubbles:true}));i.focus()})()")
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await wait("document.querySelector('.agent-model-menu>summary').textContent.includes('manual-enter')")
    assert.match(await evaluate('document.querySelector(".preview-toolbar output").textContent'), /新建合成任务 0/)
    await click('[aria-label="切换模型"]')
    await evaluate("(() => {const i=document.querySelector('[aria-label=\"手动模型 ID\"]');i.value='manual-click';i.dispatchEvent(new Event('input',{bubbles:true}))})()")
    await click('.model-list form button[type="submit"]')
    await wait("document.querySelector('.agent-model-menu>summary').textContent.includes('manual-click')")
    assert.match(await evaluate('document.querySelector(".preview-toolbar output").textContent'), /新建合成任务 0/)
    result.checks.push('manual_enter_and_use_do_not_start_analysis')
    await click('.start-analysis'); await wait("document.querySelector('.task-detail').textContent.includes('分析合成批次')")
    assert.match(await evaluate('document.querySelector(".preview-toolbar output").textContent'), /新建合成任务 1/)
    await evaluate("[...document.querySelectorAll('.task-detail button')].find(b=>b.textContent==='取消分析').click()")
    await wait("document.querySelector('.task-detail').textContent.includes('已取消')")
    result.checks.push('only_start_button_creates_and_cancel_returns_real_state')
    const settingsBefore = await evaluate('document.querySelector(".preview-toolbar output").textContent.match(/API 配置读取 (\\d+)/)[1]')
    await evaluate("(() => {const s=document.querySelector('[aria-label=\"画像分析方式\"]');s.value='laya';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
    await wait("document.body.textContent.includes('尚未下载')")
    assert.equal(await evaluate('document.querySelector(".agent-model-menu") === null'), true)
    assert.equal(await evaluate('document.querySelector(".task-detail") === null'), true)
    assert.equal(await evaluate('document.querySelector(".start-analysis").disabled'), true)
    await evaluate("document.querySelector('.insights-scroll').scrollTop=0")
    await capture('laya-missing-desktop')
    await click('[aria-label="下载本地画像模型"]'); await wait("document.body.textContent.includes('下载中')")
    await click('[aria-label="暂停本地模型下载"]'); await wait("document.body.textContent.includes('已暂停')")
    await capture('laya-paused-desktop')
    await click('[aria-label="下载本地画像模型"]'); await wait("document.body.textContent.includes('已就绪')")
    assert.equal(await evaluate('document.querySelector(".preview-toolbar output").textContent.match(/API 配置读取 (\\d+)/)[1]'), settingsBefore)
    assert.match(await evaluate('document.querySelector(".preview-toolbar output").textContent'), /新建合成任务 1/)
    await click('.start-analysis'); await wait("document.querySelector('.task-detail')?.textContent.includes('laya-multilingual')")
    await click('[aria-label="显示消息情绪与意图标签"]')
    await checkLabels('laya_light'); await capture('message-labels-laya', '.fake-conversation')
    assert.equal(await evaluate('document.querySelector(".task-detail").textContent.includes("258,000")'), false)
    assert.match(await evaluate('document.querySelector(".preview-toolbar output").textContent'), /新建合成任务 2/)
    await capture('laya-ready-desktop')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    assert.equal(await evaluate("document.querySelector('.insights-scroll').scrollWidth-document.querySelector('.insights-scroll').clientWidth"), 0)
    await capture('laya-mobile')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await evaluate("(() => {const s=document.querySelector('[aria-label=\"画像分析方式\"]');s.value='api';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
    await wait("document.querySelector('.history').textContent.includes('API')")
    assert.equal(await evaluate("[...document.querySelector('[aria-label=\"画像分析历史\"]').options].some(o=>o.textContent.includes('laya-multilingual'))"), false)
    result.checks.push('laya_download_pause_resume_no_api_settings_and_isolated_history')
    await evaluate("[...document.querySelectorAll('.preview-toolbar button')].find(b=>b.textContent==='切换单聊/群聊').click()")
    assert.match(await evaluate('document.querySelector(".preview-toolbar output").textContent'), /成员读取 0/)
    await click('[aria-label="选择分析对象"]'); await wait("document.querySelector('[aria-label=\"画像分析对象\"]').options.length===3")
    assert.match(await evaluate('document.querySelector(".preview-toolbar output").textContent'), /成员读取 1/)
    result.checks.push('group_member_reads_only_on_explicit_selection')
    assert.deepEqual(result.errors, [])
    result.passed = true
  } catch (err) {
    result.passed = false; result.failure = err.stack; process.exitCode = 1
    if (socket?.readyState === 1) {
      const debug = await send('Runtime.evaluate', { expression: '({model:document.querySelector(".agent-model-menu>summary")?.textContent,input:document.querySelector(".model-list input")?.value,menu:document.querySelector(".agent-model-menu")?.open,form:document.querySelector(".model-list form")?.outerHTML,body:document.body.textContent})', returnByValue: true })
      result.debug = debug.result.value
    }
  }
  finally {
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    if (socket?.readyState === 1) { await send('Browser.close').catch(err => { result.cleanup_error = err.message }); socket.close() }
    child.kill(); console.log(JSON.stringify(result, null, 2))
  }
}
main().catch(err => { console.error(err); process.exitCode = 1 })
