const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

test('UI packaging includes offline export icons and preserves generated assets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-copy-ui-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('wda-copy-ui-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const sourceIcons = path.join(root, 'frontend', 'assets', 'images', 'wechat');
  const generated = path.join(root, 'frontend', '.output', 'public');
  const generatedIcons = path.join(generated, 'assets', 'images', 'wechat');
  const destination = path.join(root, 'desktop', 'resources', 'ui');
  const script = path.join(root, 'desktop', 'scripts', 'copy-ui.cjs');
  fs.cpSync(path.join(repoRoot, 'frontend', 'assets', 'images', 'wechat'), sourceIcons, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'frontend', 'public', 'assets', 'images', 'wechat'), generatedIcons, { recursive: true });
  fs.writeFileSync(path.join(generated, 'index.html'), '<main>generated UI</main>');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, '.gitkeep'), '');
  fs.writeFileSync(path.join(destination, 'obsolete.html'), 'stale build');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'desktop', 'scripts', 'copy-ui.cjs'), script);

  execFileSync(process.execPath, [script], { cwd: root });

  const packagedIcons = path.join(destination, 'assets', 'images', 'wechat');
  for (const name of ['pdf.png', 'zip.png', 'word.png', 'excel.png', 'WeChat-Icon-Logo.wine.svg',
    'wechat-returned.png', 'wechat-trans-icon1.png', 'wechat-trans-icon2.png', 'wechat-trans-icon3.png',
    'wechat-trans-icon4.png', 'overdue.png', 'wechat-audio-call.svg', 'wechat-video-call.svg']) {
    assert.ok(fs.existsSync(path.join(packagedIcons, name)), `packaged HTML export icon is missing: ${name}`);
  }
  for (const name of fs.readdirSync(sourceIcons)) {
    const expected = fs.existsSync(path.join(generatedIcons, name)) ? generatedIcons : sourceIcons;
    assert.deepEqual(fs.readFileSync(path.join(packagedIcons, name)), fs.readFileSync(path.join(expected, name)), name);
  }
  assert.equal(fs.readFileSync(path.join(destination, 'index.html'), 'utf8'), '<main>generated UI</main>');
  assert.equal(fs.existsSync(path.join(destination, 'obsolete.html')), false);
  assert.equal(fs.existsSync(path.join(destination, '.gitkeep')), true);
});
