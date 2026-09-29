// 使用合成内容验证 Windows / macOS 原生通知，既不读取聊天数据，也不调用模型。
const { app, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createAiNotifications } = require('../src/ai-notifications.cjs');

app.whenReady().then(() => {
  const output = path.resolve(__dirname, '../../logs/ai-notification-smoke.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  let finished = false;
  const finish = result => {
    if (finished) return;
    finished = true;
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    app.exit(result.shown ? 0 : 1);
  };
  if (!Notification.isSupported()) return finish({ supported: false, shown: false });
  class ObservedNotification extends Notification {
    constructor(options) {
      super(options);
      this.on('show', () => setTimeout(() => { this.close(); finish({ supported: true, shown: true }); }, 1500));
      this.on('failed', (_event, error) => finish({ supported: true, shown: false, error }));
    }
  }
  const service = createAiNotifications({ Notification: ObservedNotification, getPort: () => 1,
    dataDir: path.resolve(__dirname, '../../logs/ai-notification-smoke'), navigate: () => {} });
  service.dispatch({ id: Date.now(), kind: 'notification', unique_key: `smoke:${Date.now()}`, body: {
    title: 'AI 通知测试', body: '桌面通知验证：这是一条合成测试消息。',
    target: { account: 'smoke', task_id: 'a'.repeat(32), username: '', anchor: '' },
  } });
  setTimeout(() => finish({ supported: true, shown: false, error: '未收到系统 show 事件' }), 15000);
});
