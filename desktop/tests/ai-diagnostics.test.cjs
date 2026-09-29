const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAiDiagnostics, writeFallback } = require('../src/ai-diagnostics.cjs');
const { createAiNotifications } = require('../src/ai-notifications.cjs');

test('桌面队列批量、有界、离线有限重试且写现有日志兜底', async () => {
  const logs = []; let calls = 0;
  const queue = createAiDiagnostics({ log: line => logs.push(line), send: async () => { calls++; throw new Error('SECRET'); } });
  queue.record('notification.failed', { event_id: 1, body: 'SECRET' });
  for (let i = 0; i < 5; i++) await queue.flush();
  assert.equal(calls,4); assert.equal(queue.size(),0);
  assert.equal(logs.length,1); assert.ok(!logs.join('').includes('SECRET'));
  for (let i = 0; i < 600; i++) queue.record('notification.failed', { event_id:i });
  assert.equal(queue.size(),500); queue.stop();
  assert.equal(writeFallback(Array(51).fill({}),line => logs.push(line)),false);
});

test('通知显示、点击、显示失败与 ACK 失败分别记录且不含正文', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'wda-ai-diag-'));
  const diagnostics = [], shown = [];
  class Notification extends EventEmitter { static isSupported() { return true; } show() { shown.push(this); } }
  const server = http.createServer((req,res) => { res.writeHead(503); res.end(); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const service = createAiNotifications({ Notification, getPort: () => server.address().port, dataDir:root, navigate() {}, diagnostics:{ record:(event,metadata) => diagnostics.push({event,metadata}) } });
  try {
    service.dispatch({ id:1, kind:'notification', body:{ title:'SECRET_TITLE', body:'SECRET_BODY', target:{ account:'a', task_id:'a'.repeat(32) } } });
    assert.equal(diagnostics[0].event,'notification.requested');
    assert.ok(!diagnostics.some(x => x.event==='notification.shown'));
    shown[0].emit('show'); shown[0].emit('failed','SECRET_ERROR'); shown[0].emit('click');
    for (let i=0;i<50 && !diagnostics.some(x=>x.event==='notification.ack_failed');i++) await new Promise(resolve=>setTimeout(resolve,10));
    for (const event of ['notification.shown','notification.failed','notification.clicked','notification.ack_failed']) assert.ok(diagnostics.some(x=>x.event===event),event);
    assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
  } finally { service.stop(); await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true}); }
});
