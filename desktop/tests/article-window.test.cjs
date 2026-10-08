const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const brandingStart = source.indexOf('function setupChildWindowBranding(');
const start = brandingStart >= 0 ? brandingStart : source.indexOf('function createMainWindow()');
const end = source.indexOf('async function loadWithRetry(', start);
assert.ok(start >= 0 && end > start);

class Window extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.title = options.title;
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = handler => { this.open = handler; };
  }
  setTitle(value) { this.title = value; }
}

function createWindow() {
  const context = {
    BrowserWindow: Window, path, URL,
    __dirname: path.join(__dirname, '../src'),
    app: { isPackaged: false },
    getTitleBarOverlayOptions: () => ({}),
    setupRendererConsoleLogging() {},
    setupRendererLifecycleLogging() {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.createMainWindow();
}

test('公众号文章子窗口使用主窗口图标和空标题，保留原有窗口创建流程', () => {
  const main = createWindow();
  assert.equal(typeof main.open, 'function');
  for (const url of ['https://mp.weixin.qq.com/s/test', 'http://mp.weixin.qq.com/s?__biz=test']) {
    const options = main.open({ url });
    assert.equal(options.action, 'allow');
    assert.equal(options.overrideBrowserWindowOptions.title, '');
    assert.equal(options.overrideBrowserWindowOptions.icon, main.options.icon);
    assert.deepEqual(Object.keys(options.overrideBrowserWindowOptions).sort(), ['icon', 'title']);
  }
});

test('加载文章和修改网页标题后，子窗口顶部仍保持空标题', () => {
  const main = createWindow();
  const child = new Window({ title: 'xwechat' });
  main.webContents.emit('did-create-window', child, { url: 'https://mp.weixin.qq.com/s/test' });
  assert.equal(child.title, '');
  for (const webpageTitle of ['公众号文章标题', '跳转后的文章标题']) {
    let prevented = false;
    child.emit('page-title-updated', { preventDefault() { prevented = true; } }, webpageTitle);
    if (!prevented) child.setTitle(webpageTitle);
    assert.equal(prevented, true);
    assert.equal(child.title, '');
  }
});

test('其它链接使用当前图标和初始品牌，保留网页正常更新标题', () => {
  const main = createWindow();
  assert.equal(main.options.title, 'xwechat');
  assert.equal(typeof main.open, 'function');
  for (const url of ['https://example.com/', 'about:blank', 'https://mp.weixin.qq.com.example.com/']) {
    const options = main.open({ url });
    assert.equal(options.action, 'allow');
    assert.equal(options.overrideBrowserWindowOptions.icon, main.options.icon);
    assert.equal(options.overrideBrowserWindowOptions.title, 'xwechat');
    assert.deepEqual(Object.keys(options.overrideBrowserWindowOptions).sort(), ['icon', 'title']);
    const child = new Window();
    child.setTitle = () => { assert.fail('其它窗口不应清空标题'); };
    main.webContents.emit('did-create-window', child, { url });
    assert.equal(child.listenerCount('page-title-updated'), 0);
    let prevented = false;
    child.emit('page-title-updated', { preventDefault() { prevented = true; } }, '正常网页标题');
    assert.equal(prevented, false);
  }
  assert.equal(main.listenerCount('page-title-updated'), 0);
});

test('子窗口继续打开的后代窗口同样使用项目图标并保留文章空标题规则', () => {
  const main = createWindow();
  const child = new Window();
  main.webContents.emit('did-create-window', child, { url: 'https://example.com/' });
  const articleUrl = 'https://mp.weixin.qq.com/s/article';
  const articleOptions = child.open({ url: articleUrl }).overrideBrowserWindowOptions;
  assert.equal(articleOptions.icon, main.options.icon);
  assert.equal(articleOptions.title, '');
  const article = new Window(articleOptions);
  child.webContents.emit('did-create-window', article, { url: articleUrl });
  assert.equal(article.title, '');
  assert.equal(article.listenerCount('page-title-updated'), 1);
  const next = article.open({ url: 'https://example.com/followup' }).overrideBrowserWindowOptions;
  assert.equal(next.icon, main.options.icon);
  assert.equal(next.title, 'xwechat');
});
