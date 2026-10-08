const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PNG } = require('pngjs');

const desktopRoot = path.resolve(__dirname, '..');

test('icon build refreshes every brand asset from one PNG with all Windows icon sizes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xwechat-build-icon-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('xwechat-build-icon-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const source = path.join(root, 'frontend/public/logo.png');
  const script = path.join(root, 'desktop/scripts/build-icon.cjs');
  const pngs = ['desktop/src/icon.png'];
  const icos = ['frontend/public/favicon.ico', 'desktop/src/icon.ico'];
  for (const relative of [...pngs, ...icos]) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'stale brand asset');
  }
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(desktopRoot, 'scripts/build-icon.cjs'), script);

  let previousIco;
  for (const color of [[20, 160, 90, 255], [30, 100, 200, 255]]) {
    const input = new PNG({ width: 32, height: 24 });
    for (let index = 0; index < input.data.length; index += 4) input.data.set(color, index);
    const sourceBytes = PNG.sync.write(input);
    fs.writeFileSync(source, sourceBytes);
    execFileSync(process.execPath, [script], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, NODE_PATH: path.join(desktopRoot, 'node_modules') },
    });
    assert.deepEqual(fs.readFileSync(source), sourceBytes, 'source image must stay unchanged');
    assert.equal(fs.existsSync(path.join(root, 'website')), false, 'icon build must not recreate the removed website');
    assert.equal(fs.existsSync(path.join(root, 'desktop/build')), false, 'source icons must not create a packaging directory');
    assert.equal(fs.existsSync(path.join(root, 'desktop/resources')), false, 'source icons must not create packaged resources');

    const expected = new PNG({ width: 32, height: 32 });
    input.data.copy(expected.data, 4 * 32 * 4);
    const squareBytes = fs.readFileSync(path.join(root, pngs[0]));
    for (const relative of pngs) {
      const actualBytes = fs.readFileSync(path.join(root, relative));
      assert.deepEqual(actualBytes, squareBytes, relative);
      const actual = PNG.sync.read(actualBytes);
      assert.equal(actual.width, 32);
      assert.equal(actual.height, 32);
      assert.deepEqual(actual.data, expected.data, relative);
    }

    const ico = fs.readFileSync(path.join(root, icos[0]));
    for (const relative of icos) assert.deepEqual(fs.readFileSync(path.join(root, relative)), ico, relative);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 4);
    const sizes = [];
    for (let index = 0; index < 4; index += 1) {
      const entry = 6 + index * 16;
      const width = ico[entry] || 256;
      assert.equal(ico[entry + 1] || 256, width);
      assert.equal(ico.readUInt16LE(entry + 6), 32);
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      assert.ok(length > 0 && offset >= 70 && offset + length <= ico.length);
      sizes.push(width);
    }
    assert.deepEqual(sizes.sort((a, b) => a - b), [16, 32, 48, 256]);
    if (previousIco) assert.notDeepEqual(ico, previousIco, 'changed source must refresh ICO pixels');
    previousIco = ico;
  }
});
