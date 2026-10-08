const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const mainPath = path.join(__dirname, '../src/main.cjs');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const startupSource = mainSource.slice(0, mainSource.indexOf('if (!gotSingleInstanceLock)'));
const parsePortSource = mainSource.slice(mainSource.indexOf('function parsePort('), mainSource.indexOf('function formatHostForUrl('));
const mainRequire = createRequire(mainPath);
const legacyName = 'wechat-data-analysis-desktop';

function fixture(t, isPackaged) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'xwechat-identity-'));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const paths = {};
  const calls = [];
  const app = {
    isPackaged,
    name: legacyName,
    commandLine: { appendSwitch() {} },
    disableHardwareAcceleration() {},
    getPath(name) {
      if (name === 'appData') return appData;
      return paths[name] || path.join(appData, this.name);
    },
    setPath(name, value) { paths[name] = value; calls.push(name); },
    setName(name) { this.name = name; calls.push('name'); },
    requestSingleInstanceLock() { calls.push('lock'); return true; },
  };
  function state(profile, marker = 'desktop-settings.json', bytes = 'existing user state') {
    const directory = path.join(appData, profile);
    fs.mkdirSync(directory, { recursive: true });
    if (marker === 'Local Storage' || marker === 'output') {
      fs.mkdirSync(path.join(directory, marker));
      fs.writeFileSync(path.join(directory, marker, 'retained.bin'), bytes);
    } else fs.writeFileSync(path.join(directory, marker), bytes);
    return directory;
  }
  function start() {
    vm.runInNewContext(parsePortSource + startupSource, {
      require: name => name === 'electron' ? { app } : mainRequire(name),
      process, __dirname: path.dirname(mainPath),
    });
  }
  function selected(expected) {
    assert.equal(app.getPath('userData'), path.join(appData, expected));
    assert.equal(app.getPath('sessionData'), path.join(appData, expected));
    assert.equal(app.name, 'xwechat');
    assert.deepEqual(calls, ['userData', 'sessionData', 'name', 'lock']);
    assert.ok(fs.statSync(app.getPath('userData')).isDirectory());
  }
  return { appData, app, calls, state, start, selected };
}

test('development retains its original profile even when a packaged profile exists', t => {
  const f = fixture(t, false);
  const legacy = f.state(legacyName);
  const current = f.state('xwechat', 'desktop-settings.json', 'packaged state');
  f.start();
  f.selected(legacyName);
  assert.equal(fs.readFileSync(path.join(legacy, 'desktop-settings.json'), 'utf8'), 'existing user state');
  assert.equal(fs.readFileSync(path.join(current, 'desktop-settings.json'), 'utf8'), 'packaged state');
});

test('development creates only the original profile on a fresh machine', t => {
  const f = fixture(t, false);
  f.start();
  f.selected(legacyName);
  assert.equal(fs.existsSync(path.join(f.appData, 'xwechat')), false);
});

for (const marker of ['desktop-settings.json', 'Local Storage', 'output', 'ai-notifications.json']) {
  test(`packaged builds prefer existing xwechat state (${marker}) over legacy state`, t => {
    const f = fixture(t, true);
    f.state(legacyName);
    const current = f.state('xwechat', marker);
    f.start();
    f.selected('xwechat');
    const retained = path.join(current, marker, ...(['Local Storage', 'output'].includes(marker) ? ['retained.bin'] : []));
    assert.equal(fs.readFileSync(retained, 'utf8'), 'existing user state');
  });
  test(`packaged builds retain legacy-only state (${marker}) without creating a new profile`, t => {
    const f = fixture(t, true);
    const legacy = f.state(legacyName, marker);
    f.start();
    f.selected(legacyName);
    const retained = path.join(legacy, marker, ...(['Local Storage', 'output'].includes(marker) ? ['retained.bin'] : []));
    assert.equal(fs.readFileSync(retained, 'utf8'), 'existing user state');
    assert.equal(fs.existsSync(path.join(f.appData, 'xwechat')), false);
  });
}

test('an empty or cache-only current profile does not hide existing legacy settings', t => {
  const f = fixture(t, true);
  f.state('xwechat', 'Cache');
  const legacy = f.state(legacyName, 'desktop-settings.json', '{corrupt settings');
  f.start();
  f.selected(legacyName);
  assert.equal(fs.readFileSync(path.join(legacy, 'desktop-settings.json'), 'utf8'), '{corrupt settings');
});

for (const marker of ['Local Storage', 'output']) {
  test(`empty current ${marker} does not hide existing legacy settings`, t => {
    const f = fixture(t, true);
    const empty = path.join(f.appData, 'xwechat', marker);
    fs.mkdirSync(empty, { recursive: true });
    const legacy = f.state(legacyName);
    f.start();
    f.selected(legacyName);
    assert.deepEqual(fs.readdirSync(empty), []);
    assert.equal(fs.readFileSync(path.join(legacy, 'desktop-settings.json'), 'utf8'), 'existing user state');
  });

  test(`empty legacy ${marker} is not persistent state for a fresh packaged installation`, t => {
    const f = fixture(t, true);
    const empty = path.join(f.appData, legacyName, marker);
    fs.mkdirSync(empty, { recursive: true });
    f.start();
    f.selected('xwechat');
    assert.deepEqual(fs.readdirSync(empty), []);
  });

  for (const profile of ['xwechat', legacyName]) {
    test(`unreadable ${profile} ${marker} throws without changing profiles`, t => {
      const f = fixture(t, true);
      const directory = f.state(profile, marker);
      const original = fs.readdirSync;
      const denied = Object.assign(new Error('persistent directory access denied'), { code: 'EACCES' });
      t.mock.method(fs, 'readdirSync', function (target, ...args) {
        if (target === path.join(directory, marker)) throw denied;
        return original.call(this, target, ...args);
      });
      assert.throws(f.start, error => error === denied);
      assert.deepEqual(f.calls, []);
    });
  }
}

test('a fresh packaged installation creates xwechat without creating or moving a legacy directory', t => {
  const f = fixture(t, true);
  f.start();
  f.selected('xwechat');
  assert.equal(fs.existsSync(path.join(f.appData, legacyName)), false);
});

test('unreadable profile metadata throws instead of selecting a different profile', t => {
  const f = fixture(t, true);
  f.state(legacyName);
  const original = fs.readdirSync;
  const denied = Object.assign(new Error('profile access denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readdirSync', function (directory, ...args) {
    if (directory === path.join(f.appData, 'xwechat')) throw denied;
    return original.call(this, directory, ...args);
  });
  assert.throws(f.start, error => error === denied);
  assert.deepEqual(f.calls, []);
});

test('a profile path that is a file throws instead of silently using another profile', t => {
  const f = fixture(t, true);
  f.state(legacyName);
  fs.writeFileSync(path.join(f.appData, 'xwechat'), 'invalid profile directory');
  assert.throws(f.start, error => error.code === 'ENOTDIR');
  assert.deepEqual(f.calls, []);
});

test('desktop package and lock metadata use the same current brand', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../package-lock.json'), 'utf8'));
  assert.equal(pkg.name, 'xwechat');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
});

test('the existing desktop IPC bridge stays available with its current brand marker', () => {
  const exposed = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
    process,
    require: () => ({
      contextBridge: { exposeInMainWorld(name, api) { exposed.push({ name, api }); } },
      ipcRenderer: { send() {} }, webUtils: {},
    }),
  });
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, 'wechatDesktop');
  assert.equal(exposed[0].api.__brand, 'xwechat');
  for (const method of ['minimize', 'close', 'getBackendPort', 'setBackendPort']) {
    assert.equal(typeof exposed[0].api[method], 'function');
  }
});
