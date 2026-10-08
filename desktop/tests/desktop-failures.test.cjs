const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseDesktopSettingsText } = require('../src/desktop-settings.cjs');
const { normalizeDirectoryPath } = require('../src/output-dir.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function settingsContext(overrides = {}) {
  const context = {
    desktopSettings: null,
    DEFAULT_BACKEND_PORT: 10392,
    getDesktopSettingsPath: () => '/isolated/settings.json',
    fs: { existsSync: () => true, readFileSync: () => '{}' },
    parseDesktopSettingsText, normalizeDirectoryPath,
    normalizePendingOutputDirValue: value => value == null ? null : normalizeDirectoryPath(value),
    parsePort: value => Number.isInteger(value) && value > 0 && value < 65536 ? value : null,
    logMain() {},
    writeDesktopSettingsFileAtomic() {},
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(section('function loadDesktopSettings()', 'async function applyOutputDirChange('), context);
  return context;
}

test('invalid settings and read failures stay errors instead of being cached as defaults', () => {
  for (const readFileSync of [() => '{broken', () => { throw new Error('read denied'); }]) {
    const context = settingsContext({ fs: { existsSync: () => true, readFileSync } });
    assert.throws(() => context.loadDesktopSettings());
    assert.equal(context.desktopSettings, null);
    assert.throws(() => context.loadDesktopSettings());
  }
});

test('failed setting writes do not change the in-memory state', () => {
  const failure = new Error('disk full');
  const context = settingsContext({ writeDesktopSettingsFileAtomic() { throw failure; } });
  assert.equal(context.getCloseBehavior(), 'tray');
  assert.throws(() => context.setCloseBehavior('exit'), error => error === failure);
  assert.equal(context.getCloseBehavior(), 'tray');
  assert.throws(() => context.setPendingOutputDirSetting(path.resolve('pending-output')), error => error === failure);
  assert.equal(context.desktopSettings.pendingOutputDir, null);
});

function captureContext(debuggerApi) {
  const context = { Buffer, nativeImage: {}, logMain() {} };
  vm.createContext(context);
  vm.runInContext(section('async function captureRegionToPngBuffer(', '// --- 零依赖 ZIP'), context);
  return () => context.captureRegionToPngBuffer({
    debugger: debuggerApi,
    capturePage() { assert.fail('Screenshot failure must not switch capture methods'); },
  }, { width: 100, height: 200, scale: 2 });
}

test('screenshot errors propagate and release the debugger session', async () => {
  let detached = 0;
  const failure = new Error('capture failed');
  const capture = captureContext({
    isAttached: () => false, attach() {}, detach() { detached++; },
    async sendCommand() { throw failure; },
  });
  await assert.rejects(capture(), error => error === failure);
  assert.equal(detached, 1);
});

test('successful capture preserves requested scale and an existing debugger session', async () => {
  const capture = captureContext({
    isAttached: () => true, detach() { assert.fail('Must not detach another session'); },
    async sendCommand(method, params) {
      assert.equal(method, 'Page.captureScreenshot');
      assert.equal(params.clip.scale, 2);
      return { data: Buffer.from('controlled image payload').toString('base64') };
    },
  });
  const result = await capture();
  assert.equal(result.buffer.toString(), 'controlled image payload');
  assert.equal(result.width, 200);
  assert.equal(result.height, 400);
});

test('startup failures remain visible when settings or the log directory cannot be read', () => {
  for (const cause of [new SyntaxError('settings JSON is corrupt'), new Error('userData access denied')]) {
    const reported = [];
    const errors = [];
    let quit = 0;
    const context = {
      console: { error: (...args) => errors.push(args) },
      getMainLogPath() { throw new Error('log directory access denied'); },
      getUserDataDir() { assert.fail('Error reporting must not retry failed directory setup'); },
      resolveOutputDir() { assert.fail('Error reporting must not reload failed settings'); },
      dialog: { showErrorBox: (...args) => reported.push(args) },
      app: { quit() { quit++; } },
    };
    vm.createContext(context);
    vm.runInContext(section('function logMain(', 'function getDesktopSettingsPath('), context);
    vm.runInContext(section('function handleStartupFailure(', 'if (gotSingleInstanceLock)'), context);
    context.handleStartupFailure(cause);
    assert.equal(reported.length, 1);
    assert.ok(reported[0][1].includes(cause.message));
    assert.equal(errors[0][0], cause);
    assert.equal(errors[1][1].message, 'log directory access denied');
    assert.equal(quit, 1);
  }
});

test('failure to display the startup error still initiates application shutdown', () => {
  let quit = 0;
  const context = {
    console: { error() {} }, logMain() {},
    dialog: { showErrorBox() { throw new Error('dialog unavailable'); } },
    app: { quit() { quit++; } },
  };
  vm.createContext(context);
  vm.runInContext(section('function handleStartupFailure(', 'if (gotSingleInstanceLock)'), context);
  assert.throws(() => context.handleStartupFailure(new Error('startup failed')), /dialog unavailable/);
  assert.equal(quit, 1);
});
