const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const scriptPath = path.resolve(__dirname, '../scripts/build-backend.cjs');
const { parseVersionTuple, buildVersionInfoText } = vm.runInNewContext(
  `${fs.readFileSync(scriptPath, 'utf8')}\n({ parseVersionTuple, buildVersionInfoText })`,
  { require: createRequire(scriptPath), module: { exports: {} }, __dirname: path.dirname(scriptPath) }
);

test('project version produces matching numeric and string Windows resource versions', () => {
  const tuple = parseVersionTuple('1.0.0');
  assert.deepEqual(Array.from(tuple), [1, 0, 0, 0]);
  const resource = buildVersionInfoText(tuple, tuple.join('.'));
  assert.match(resource, /filevers=\(1, 0, 0, 0\)/);
  assert.match(resource, /prodvers=\(1, 0, 0, 0\)/);
  assert.match(resource, /StringStruct\('FileVersion', '1\.0\.0\.0'\)/);
  assert.match(resource, /StringStruct\('ProductVersion', '1\.0\.0\.0'\)/);
});

test('missing, malformed and out-of-range project versions fail instead of being repaired', () => {
  for (const value of [undefined, null, {}, '', 'invalid', '1', '1.0', '1.0.0.0', '1.0.0-beta.1', '01.0.0', '65536.0.0']) {
    assert.throws(() => parseVersionTuple(value), /desktop\/package\.json.*version/, String(value));
  }
});
