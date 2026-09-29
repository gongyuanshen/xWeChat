// 真实 Electron 与真实供应商；通过设置页配置，不直接调用供应商绕过应用。
const { parseArgs } = require('node:util')
const fs = require('node:fs/promises')
const { readSync } = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { values } = parseArgs({ options: { output: { type: 'string' }, data: { type: 'string' },
  playwright: { type: 'string' }, port: { type: 'string', default: '10498' }, 'existing-run': { type: 'string' }, continuous: { type: 'boolean', default: false }, followup: { type: 'boolean', default: false }, images: { type: 'boolean', default: false }, 'manual-ime': { type: 'boolean', default: false }, 'max-output': { type: 'string' }, resume: { type: 'boolean', default: false }, 'scroll-only': { type: 'boolean', default: false } } })
const maxOutput = values['max-output'] ? Number(values['max-output']) : null
if (maxOutput !== null && (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > 10000000)) throw new Error('最大输出必须为有效整数')
if (values.resume && (!values['existing-run'] || !values.continuous || values.followup)) throw new Error('继续验收需要既有长报告运行')
if (values.followup && !values['existing-run']) throw new Error('追问验收需要已完成的真实回答')
if (values.images && (values.continuous || values.followup)) throw new Error('图片问答使用独立样例和验收流程')
if (!values.output || !values.data) throw new Error('需要独立样例数据与新的输出目录')
const root = path.resolve(__dirname, '..'), data = path.resolve(values.data), output = path.resolve(values.output)
const port = Number(values.port), base = `http://127.0.0.1:${port}`, account = 'wxid_ai_acceptance'
const { _electron } = require(values.playwright || 'playwright')
const question = values.images
  ? '请查看当前账号聊天里的海桥新版报价图和聚餐确认单图片，告诉我图中的新版金额、交付日期、包含内容，以及聚餐星期、时间、人数和地点。请引用这两张图片，不要用旧文字报价代替图片内容。'
  : values.continuous
  ? '完整阅读当前账号全部聊天合计最近240条消息，给出海桥、青禾项目和聚餐安排变更的简明报告。保留消息先后顺序、日期、周几和时间、报价版本及出处，不要把重复的日常检查逐条列出。'
  : '海桥和青禾两个项目的最终报价分别是多少？海桥是否包含数据导出、什么时候交付？请引用原消息。'
const result = { platform: process.platform, mode: values['existing-run'] ? 'native_electron_saved_real_answer_replay' : 'native_electron_real_model_synthetic_data',
  started: new Date().toISOString(), checks: [], errors: [], turn_inputs: [], real_ime: 'not_verified' }
let secret = '', app, page, configuredProfile, streamProxy
const sse = { requests: 0, frames: 0, lastId: 0, budgets: [] }
const sanitize = value => secret ? String(value).replaceAll(secret, '[redacted]') : String(value)
const api = async route => {
  const response = await fetch(base + '/api/ai' + route)
  if (!response.ok) throw new Error(`应用接口 ${route} 返回 ${response.status}`)
  return response.json()
}
const capture = async name => {
  await page.screenshot({ path: path.join(output, name + '.png') })
  result.checks.push(name)
}
async function verifyReconnect() {
  const inputBox = page.getByLabel('给 AI 助手的消息')
  const draft = '临时验收草稿，不提交。'
  await inputBox.fill(draft)
  const disclosure = page.locator('.agent-process-toggle').last()
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
  // 使用组件公开的实际滚动区与真实滚轮，避免展开后的布局时序和伪造 scroll 事件。
  const viewport = page.locator('.agent-conversation')
  const readPosition = () => viewport.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight }))
  await viewport.evaluate(el => {
    window.acceptanceScrollEvents=[]
    for (const type of ['wheel','scroll']) el.addEventListener(type,e=>window.acceptanceScrollEvents.push({type,top:el.scrollTop,delta:e.deltaY,trusted:e.isTrusted,at:performance.now()}))
  })
  await new Promise(resolve => setTimeout(resolve, 250))
  await viewport.hover()
  await page.mouse.wheel(0, -10000)
  await new Promise(resolve => setTimeout(resolve, 1000))
  const savedPosition = await readPosition()
  result.reconnection = { savedPosition, scroll_events:await page.evaluate(()=>window.acceptanceScrollEvents) }
  const beforeNetwork = { requests: streamProxy.requests.length, lastId: sse.lastId }
  await page.context().setOffline(true)
  streamProxy.drop()
  await new Promise(resolve => setTimeout(resolve, 3500))
  assert.equal(await inputBox.inputValue(), draft)
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true')
  await capture('continuous-network-offline-draft-preserved')
  await page.context().setOffline(false)
  streamProxy.resume()
  // 原生窗口最小化/恢复，模型仍由应用后台执行。
  result.window_minimized = await app.evaluate(({ BrowserWindow }) => { const w=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().startsWith('devtools:')); w.minimize(); return w.isMinimized() })
  await new Promise(resolve => setTimeout(resolve, 1500))
  result.window_minimized = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().startsWith('devtools:')).isMinimized())
  assert.ok(result.window_minimized)
  await app.evaluate(({ BrowserWindow }) => { const w=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().startsWith('devtools:')); w.restore(); w.show(); w.focus() })
  const reconnectStart=Date.now()
  while (!streamProxy.requests.slice(beforeNetwork.requests).some(r=>r.status===200) && Date.now()-reconnectStart<30000) await new Promise(resolve=>setTimeout(resolve,500))
  assert.ok(streamProxy.requests.slice(beforeNetwork.requests).some(r=>r.status===200 && Number(r.last_event_id)===beforeNetwork.lastId), '必须观察到携带断线前事件编号的新 SSE 连接')
  assert.equal(await inputBox.inputValue(), draft)
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'true')
  const restoredPosition=await readPosition()
  result.reconnection = { ...result.reconnection, before: beforeNetwork, after: { requests:streamProxy.requests.length, lastId:sse.lastId }, draft_preserved: true, disclosure_preserved: true, savedPosition, restoredPosition }
  result.reconnection.scroll_preserved = savedPosition.total > savedPosition.height && savedPosition.top <= 2 && Math.abs(restoredPosition.top-savedPosition.top)<=2
  await capture('continuous-reconnected-window-restored')
  await inputBox.fill('')
}
async function main() {
  await fs.access(path.join(data, 'output/databases', account))
  await fs.mkdir(output, { recursive: false })
  try {
    // 启动器将本次授权的密钥经 FIFO 作为标准输入传入，不使用环境文件。
    // 图形启动会话里的 FIFO 不依赖 Node 标准输入流的 EOF 事件；读取单行即结束。
    if (!values['existing-run']) {
    let input = ''
    const inputBuffer = Buffer.alloc(256)
    while (!input.includes('\n')) {
      const length = readSync(0, inputBuffer, 0, inputBuffer.length, null)
      if (!length) break
      input += inputBuffer.subarray(0, length).toString()
      if (input.length > 8192) throw new Error('配置输入过长')
    }
    secret = input.trim(); input = ''
    if (!secret) throw new Error('未提供本次授权的模型密钥')
    }
    const wrapper = path.join(output, 'launch.cjs'), userData = path.join(output, 'electron-user-data')
    await fs.mkdir(userData)
    await fs.writeFile(wrapper, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});require(${JSON.stringify(path.join(root, 'desktop/src/main.cjs'))});\n`)
    app = await _electron.launch({ executablePath: require(path.join(root, 'desktop/node_modules/electron')),
      args: [wrapper], cwd: path.join(root, 'desktop'), timeout: 120000,
      env: { ...process.env, WECHAT_TOOL_DATA_DIR: data, WECHAT_TOOL_OUTPUT_DIR: path.join(data, 'output'),
        WECHAT_TOOL_PORT: String(port), WECHAT_TOOL_STATIC_UI: '1', PYTHONIOENCODING: 'utf-8' } })
    page = await app.firstWindow({ timeout: 120000 }); page.setDefaultTimeout(30000)
    if (process.platform === 'darwin') result.accessibility_trusted = await app.evaluate(({ systemPreferences }) => systemPreferences.isTrustedAccessibilityClient(false))
    if (values.continuous) {
      streamProxy = await require('./ai_acceptance_stream_proxy.cjs').createStreamProxy(base)
      await page.route('**/api/ai/agent/events?**', route => route.continue({ url: streamProxy.url + new URL(route.request().url()).pathname + new URL(route.request().url()).search }))
      const network = await page.context().newCDPSession(page)
      await network.send('Network.enable')
      network.on('Network.requestWillBeSent', event => { if (event.request.url.includes('/agent/events?')) sse.requests++ })
      network.on('Network.eventSourceMessageReceived', event => {
        sse.frames++; sse.lastId = Math.max(sse.lastId, Number(event.eventId) || 0)
        const body = JSON.parse(event.data)
        if (body.context_budget) sse.budgets.push({ run_id: body.context_budget.run_id, version: body.context_budget.version, used: body.context_budget.used })
      })
    }
    page.on('pageerror', error => result.errors.push(sanitize(error.message)))
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/ai\/agent\/threads\/[^/]+\/messages\?/.test(request.url())) {
        const body = request.postDataJSON()
        result.turn_inputs.push({ model_id: body.model_id, profile_id: body.profile_id,
          reasoning_effort: body.reasoning_effort, text: body.text })
      }
    })
    await page.getByRole('button', { name: '我已阅读全部内容并同意', exact: true }).click({ timeout: 120000 })
    await page.goto(base + '/chat')
    // 图片样例改变最近会话排序，主动选择目标会话，不依赖首个聊天。
    await page.getByRole('heading', { name: '验收 · 海桥项目', exact: true }).first().click()
    await page.getByRole('heading', { name: '验收 · 海桥项目', exact: true, level: 2 }).waitFor()
    let run
    if (!values['existing-run']) {
    await page.getByTitle('设置', { exact: true }).click()
    await page.locator('.settings-dialog-panel aside').getByRole('button', { name: 'AI 服务', exact: true }).click()
    await page.getByRole('button', { name: '新增服务', exact: true }).click()
    await page.locator('.ais-provider-choice').filter({ hasText: 'DeepSeek' }).click()
    const dialog = page.locator('.ais-dialog')
    await dialog.locator('input[maxlength="80"]').fill('DeepSeek 实机验收')
    await dialog.locator('input[type=password]').fill(secret)
    await dialog.locator('input[type=password]').blur()
    await dialog.getByRole('combobox', { name: '选择模型', exact: true }).click()
    // 选项的无障碍名称还可能包含“支持图片理解”，按独立模型标签定位。
    await page.getByRole('option').filter({ has: page.getByText('deepseek-flash', { exact:true }) }).click()
    await dialog.locator('input[type=number]').first().fill(values.continuous ? '65536' : '1000000')
    await dialog.getByRole('switch').check()
    await dialog.locator('summary').filter({ hasText: '其他能力与参数' }).click()
    if (maxOutput !== null) await dialog.getByLabel(/^最大输出/).fill(String(maxOutput))
    await dialog.getByLabel('供应商确认的原生推理等级').fill('low, high, max')
    await dialog.getByLabel('供应商确认的原生推理等级').blur()
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const settings = await api('/settings')
    const profile = settings.profiles.filter(p => p.name === 'DeepSeek 实机验收').at(-1)
    configuredProfile = profile
    assert.equal(profile.model, 'deepseek-flash')
    if (maxOutput !== null) assert.equal(profile.model_metadata.limit.output, maxOutput)
    assert.deepEqual(profile.model_metadata.reasoning_efforts, ['low', 'high', 'max'])
    result.profile = profile
    for (const name of ['默认文本模型', '默认视觉模型']) {
      await page.getByRole('combobox', { name, exact: true }).click()
      await page.getByRole('option').filter({ hasText: 'DeepSeek 实机验收' }).last().click()
      await page.getByText('默认模型已保存', { exact: true }).waitFor()
    }
    await capture('model-settings-saved')
    await page.getByTitle('关闭设置', { exact: true }).click()
    await page.getByLabel('AI 助手', { exact: true }).click()
    if (values.continuous) {
      const connected=Date.now()
      while (!streamProxy.requests.some(r=>r.status===200) && Date.now()-connected<10000) await new Promise(resolve=>setTimeout(resolve,200))
      assert.ok(streamProxy.requests.some(r=>r.status===200), '提交模型问题前先确认 SSE 代理实际可用')
    }
    await page.getByLabel('原生思考等级').selectOption('low')
    await capture('native-effort-low')
    const inputBox = page.getByLabel('给 AI 助手的消息')
    await inputBox.fill(question); await inputBox.press('Enter')
    const start = Date.now()
    let recovered = false
    while (Date.now() - start < 900000) {
      const threads = await api('/agent/threads?account=' + account)
      const candidate = threads.find(t => t.latest_run && t.title.startsWith(question.slice(0, 12)))
      if (candidate) run = await api(`/agent/runs/${candidate.latest_run}?account=${account}`)
      if (values.continuous && !recovered && run?.status === 'running' && run.analysis?.segments >= 1 && !run.analysis.complete) {
        result.before_stop = { run_id: run.id, cutoff: run.cutoff, note_key: run.note_key, budget: run.context_budget, analysis: run.analysis }
        await page.getByRole('button', { name: '停止处理', exact: true }).click()
        await page.getByRole('button', { name: '继续查找', exact: true }).waitFor()
        const stopped = await api(`/agent/runs/${run.id}?account=${account}`)
        assert.equal(stopped.status, 'cancelled')
        await fs.writeFile(path.join(output, 'stopped.json'), JSON.stringify(stopped, null, 2))
        await capture('continuous-stopped-after-saved-note')
        await page.getByLabel('原生思考等级').selectOption('high')
        await page.getByRole('button', { name: '继续查找', exact: true }).click()
        await page.getByRole('button', { name: '停止处理', exact: true }).waitFor()
        const resumed = await api(`/agent/runs/${run.id}?account=${account}`)
        assert.equal(resumed.id, stopped.id); assert.equal(resumed.cutoff, stopped.cutoff)
        assert.equal(resumed.context_budget.reasoning_effort, 'low')
        assert.equal(resumed.context_budget.model_window, 65536)
        result.after_continue = { id: resumed.id, cutoff: resumed.cutoff, budget: resumed.context_budget }
        await verifyReconnect()
        recovered = true
      }
      if (run && !['queued', 'running'].includes(run.status)) break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    if (!run || ['queued', 'running'].includes(run.status)) {
      const stop = page.getByRole('button', { name: '停止处理', exact: true })
      if (await stop.count()) await stop.click()
      throw new Error('本轮界面验收等待超时；不是模型调用次数上限')
    }
    assert.equal(result.turn_inputs.at(-1).reasoning_effort, 'low')
    if (values.continuous) assert.ok(recovered, '本轮必须实际发生保存笔记后的停止与恢复')
    } else {
      // 复核已完成的真实回答，不为界面重试再次请求模型。
      run = await api(`/agent/runs/${values['existing-run']}?account=${account}`)
      const thread = (await api('/agent/threads?account=' + account)).find(t => t.id === run.thread_id)
      assert.ok(thread)
      await page.getByLabel('AI 助手', { exact: true }).click()
      await page.getByRole('button', { name: 'AI 对话历史', exact: true }).click()
      await page.locator('.agent-thread-select').getByText(thread.title, { exact: true }).click()
      assert.equal(run.context_budget.reasoning_effort, 'low')
      result.new_model_calls = 0
      if (values['scroll-only']) {
        const disclosure = page.locator('.agent-process-toggle').last()
        if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
        const viewport = page.locator('.agent-conversation')
        const measure = () => viewport.evaluate(el => {
          const r=el.getBoundingClientRect(), target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
          return { top:el.scrollTop, height:el.clientHeight, total:el.scrollHeight, rect:{x:r.x,y:r.y,width:r.width,height:r.height}, target:target?.className, overflow:getComputedStyle(el).overflow }
        })
        result.scroll_probe = { before:await measure() }
        await viewport.hover()
        await page.mouse.wheel(0,-10000)
        await new Promise(resolve=>setTimeout(resolve,1000))
        result.scroll_probe.after_wheel = await measure()
        await capture('scroll-probe-after-wheel')
        result.passed = result.scroll_probe.after_wheel.top <= 2
        return
      }
      if (values.resume) {
        const prior = run
        const usageBefore = (await api('/usage/records?limit=200')).filter(u => u.task_id === run.id).length
        result.resume_before = { id: prior.id, status: prior.status, cutoff: prior.cutoff, note_key: prior.note_key, analysis: prior.analysis, budget: prior.context_budget }
        assert.ok(!['queued', 'running', 'completed'].includes(prior.status), '只继续已停止或中断的既有任务')
        await page.getByRole('button', { name: prior.status === 'failed' ? '重试这一步' : '继续查找', exact: true }).click()
        await page.getByRole('button', { name: '停止处理', exact: true }).waitFor()
        await verifyReconnect()
        const started = Date.now()
        while (Date.now() - started < 900000) {
          run = await api(`/agent/runs/${prior.id}?account=${account}`)
          if (!['queued', 'running'].includes(run.status)) break
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
        assert.equal(run.id, prior.id); assert.equal(run.cutoff, prior.cutoff)
        assert.equal(run.context_budget.model_window, prior.context_budget.model_window)
        assert.equal(run.context_budget.reasoning_effort, prior.context_budget.reasoning_effort)
        result.new_model_calls = (await api('/usage/records?limit=200')).filter(u => u.task_id === run.id).length - usageBefore
      }
      if (values.followup) {
        result.parent_run_id = run.id
        await page.getByLabel('原生思考等级').selectOption('low')
        const input = page.getByLabel('给 AI 助手的消息')
        await input.fill('基于刚才已读完的资料，简洁重述海桥与青禾的最终报价、海桥交付日期和聚餐最终安排，保留出处。取消最近条数限制，不需要重新遍历聊天。阶段笔记里暂时未找到的信息不是聊天原文的否认，不要把后续补齐写成更正或冲突。')
        await input.press('Enter')
        const started = Date.now(), parent = run
        while (Date.now() - started < 300000) {
          const thread = (await api('/agent/threads?account=' + account)).find(t => t.id === parent.thread_id)
          if (thread.latest_run !== parent.id) run = await api(`/agent/runs/${thread.latest_run}?account=${account}`)
          if (run.id !== parent.id && !['queued', 'running'].includes(run.status)) break
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        assert.notEqual(run.id, parent.id)
        assert.equal(run.status, 'completed')
        assert.ok(run.note_key?.startsWith('inherited:'), '追问应复用已提交的阶段笔记')
        assert.equal(run.intent.message_count, null)
        assert.equal(run.analysis?.analyzed || 0, 0, '追问不得重新遍历全部原文')
        assert.doesNotMatch(run.answer, /更正说明|与本次已读证据冲突/)
        result.new_model_calls = (await api('/usage/records?limit=200')).filter(u => u.task_id === run.id).length
        await capture('followup-reused-saved-material')
      }
    }
    result.usage = (await api('/usage/records?limit=200')).filter(u => u.task_id === run.id)
    result.run_id = run.id; result.model_calls = result.usage.length
    await fs.writeFile(path.join(output, 'run.json'), JSON.stringify(run, null, 2))
    assert.equal(run.status, 'completed', run.error)
    if (values.images) {
      const oracle = JSON.parse(await fs.readFile(path.join(data, 'output/image-acceptance-oracle.json'), 'utf8'))
      assert.match(run.answer, /18[,]?400/)
      assert.match(run.answer, /10\s*月\s*16\s*日|2026-10-16/)
      assert.match(run.answer, /19[:：]30|[七7]点半/)
      assert.match(run.answer, /8\s*(人|位|名)|八[人位名]/)
      const ids = [...new Set([...run.answer.matchAll(/\[\[image:([a-f0-9]{24})\]\]/g)].map(m => m[1]))]
      const images = ids.map(id => run.references.find(r => r.id === id && r.kind === 'image'))
      assert.equal(images.length, 2)
      assert.ok(images.every(Boolean))
      assert.deepEqual(images.map(r => r.source).sort(), oracle.filter(r => r.expected_in_answer).map(r => r.source).sort())
      result.answer_images = images
      const usageBefore = (await api('/usage/records?limit=200')).length
      await capture('image-real-answer')
      await page.locator(`button[data-image="${ids[0]}"]`).last().click()
      const picture = page.locator('.agent-image-stage img')
      await picture.evaluate(img => img.decode())
      assert.ok(await picture.evaluate(img => img.naturalWidth > 0))
      assert.match(await page.locator('.agent-image-viewer').textContent(), /图片 1 \/ 2/)
      await capture('image-viewer-first')
      await page.getByLabel('放大图片').click()
      await page.getByLabel('旋转图片').click()
      assert.match(await picture.getAttribute('style'), /rotate\(90deg\) scale\(1.25\)/)
      await capture('image-viewer-zoom-rotate')
      await page.getByLabel('下一张图片').click()
      await picture.evaluate(img => img.decode())
      assert.match(await page.locator('.agent-image-viewer').textContent(), /图片 2 \/ 2/)
      await capture('image-viewer-second')
      await page.getByLabel('下一张图片').click()
      assert.match(await page.locator('.agent-image-viewer').textContent(), /图片 1 \/ 2/)
      await page.getByLabel('关闭图片查看器').click()
      assert.equal((await api('/usage/records?limit=200')).length, usageBefore, '查看图片不能触发新模型调用')
      result.viewer_new_model_calls = 0
      if (values['manual-ime']) {
        const input = page.getByLabel('给 AI 助手的消息')
        await input.fill('')
        await input.evaluate(el => {
          window.acceptanceImeEvents = []
          for (const name of ['compositionstart', 'compositionupdate', 'compositionend', 'keydown', 'input']) {
            el.addEventListener(name, e => window.acceptanceImeEvents.push({ type: e.type, key: e.key,
              shift: e.shiftKey, composing: e.isComposing, trusted: e.isTrusted, at: performance.now() }))
          }
        })
        await input.focus()
        await app.evaluate(({ BrowserWindow }) => { const w=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().startsWith('devtools:')); w.show(); w.focus() })
        await fs.writeFile(path.join(output, 'ime-ready.json'), JSON.stringify({ ready: true, instructions: '请切换系统拼音，输入 nihao，候选出现时按一次 Enter，再按 Shift+Enter 换行；不要点击发送。' }))
        await page.waitForFunction(() => {
          const events = window.acceptanceImeEvents || []
          return events.some(e=>e.type==='compositionstart' && e.trusted)
            && events.some(e=>e.type==='compositionend' && e.trusted)
            && events.some(e=>e.type==='keydown' && e.key==='Enter' && !e.shift)
            && events.some(e=>e.type==='keydown' && e.key==='Enter' && e.shift)
            && document.querySelector('[aria-label="给 AI 助手的消息"]')?.value.includes('\n')
        }, null, { timeout: 900000 })
        result.ime_events = await page.evaluate(()=>window.acceptanceImeEvents)
        assert.equal(result.turn_inputs.length, 0, '候选 Enter 与换行不得提交问题')
        assert.equal((await api('/usage/records?limit=200')).length, usageBefore)
        result.real_ime = 'manual_system_ime_verified'
        await capture('manual-system-ime-draft')
        await input.fill('')
      }
    } else {
    assert.match(run.answer, /15600/); assert.match(run.answer, /8600/)
    assert.match(run.answer, /9\s*月\s*25\s*日/); assert.match(run.answer, /数据导出/)
    if (values.continuous && !values.followup) {
      assert.equal(run.analysis.analyzed, 240); assert.equal(run.analysis.complete, true)
      assert.ok(run.analysis.segments >= 2)
      assert.match(run.answer, /周六|星期六/); assert.match(run.answer, /七点|7\s*(点|[:：]00)/)
      if (!values['existing-run']) assert.ok(sse.budgets.length > 0 && sse.budgets.every(b => b.run_id === run.id && b.version === run.version))
      result.sse = sse
    }
    const sources = [...new Set([...run.answer.matchAll(/\[\[([a-f0-9]{24})\]\]/g)].map(m => m[1]))]
    const blue = sources.find(id => run.citations.some(c => c.source === id && c.username === 'acceptance_other@chatroom' && c.text.includes('8600')))
    assert.ok(blue, '青禾报价必须使用青禾原消息引用')
    result.citations = sources.map(id => {
      const c = run.citations.find(item => item.source === id)
      assert.ok(c, '所有引用必须可解析')
      return { source: id, username: c.username, anchor: c.anchor, text: c.text }
    })
    await capture('real-answer-completed')
    await page.getByRole('button', { name: `查看来源 ${sources.indexOf(blue) + 1}`, exact: true }).last().click()
    await capture('cross-chat-source-preview')
    await page.getByRole('button', { name: '定位原消息', exact: true }).click()
    await page.getByRole('heading', { name: '验收 · 青禾项目', level: 2, exact: true }).waitFor()
    const citation = result.citations.find(c => c.source === blue)
    // 会话标题先于消息列表渲染；等待首次定位完成，不再次点击定位按钮。
    await page.waitForFunction(anchor => {
      const elements = [...document.querySelectorAll('[data-msg-id]')]
      const element = elements.find(e => e.dataset.msgId === anchor)
      if (!element) return false
      const rect = element.getBoundingClientRect()
      return rect.height > 0 && rect.top < innerHeight && rect.bottom > 0
    }, citation.anchor, { timeout: 5000 })
    await capture('cross-chat-first-location')
    }
    if (result.reconnection) {
      result.reconnection.final_event_id = sse.lastId
      assert.ok(result.reconnection.scroll_preserved, '阅读位置不应被新内容推到底部')
      assert.ok(sse.lastId > result.reconnection.before.lastId, '恢复连接必须最终收到该运行的新事件')
    }
    assert.deepEqual(result.errors, [])
    result.passed = true
  } catch (error) {
    result.passed = false; result.failure = sanitize(error.stack)
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    if (values.continuous && configuredProfile && page && !page.isClosed()) {
      try {
        await page.context().setOffline(false)
        await page.getByTitle('设置', { exact: true }).click()
        await page.locator('.settings-dialog-panel aside').getByRole('button', { name:'AI 服务', exact:true }).click()
        await page.getByRole('button', { name: `编辑 ${configuredProfile.name}`, exact:true }).click()
        const dialog=page.locator('.ais-dialog')
        await dialog.locator('input[type=number]').first().fill('1000000')
        if (maxOutput !== null) {
          await dialog.locator('summary').filter({ hasText:'其他能力与参数' }).click()
          await dialog.getByLabel(/^最大输出/).fill('')
        }
        await dialog.getByRole('button', { name:'保存配置', exact:true }).click()
        await dialog.waitFor({ state:'hidden' })
        result.profile_restored = (await api('/settings')).profiles.find(p=>p.id===configuredProfile.id)?.context_window === 1000000
        assert.ok(result.profile_restored)
        await capture('continuous-profile-restored')
      } catch (error) { result.passed=false; result.restore_failure=sanitize(error.message); process.exitCode=1 }
    }
    if (app) await app.close().catch(() => {})
    if (streamProxy) { result.stream_proxy_requests=streamProxy.requests; await streamProxy.close() }
    if (values.continuous) result.sse=sse
    result.finished = new Date().toISOString()
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify({ passed: result.passed, model_calls: result.model_calls, failure: result.failure }))
  }
}
main().catch(error => { console.error(sanitize(error.message)); process.exitCode = 1 })
