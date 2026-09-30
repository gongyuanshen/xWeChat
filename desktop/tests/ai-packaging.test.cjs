const test = require('node:test');
const assert = require('node:assert/strict');
const { aiPackagingArgs } = require('../scripts/ai-packaging.cjs');

test('Windows 的 AI 资源必须以 add-data 参数传递，包含动态编码与检查点模块', () => {
  const args = aiPackagingArgs('/workspace', 'win32');
  for (const name of ['local_search_models.json', 'local_search_gpu.json']) {
    const index = args.findIndex(value => value.includes(name));
    assert.equal(args[index - 1], '--add-data');
    assert.ok(args[index].endsWith(';wechat_decrypt_tool/resources'));
  }
  assert.ok(args.includes('langgraph.checkpoint.sqlite.aio'));
  assert.ok(args.includes('tiktoken_ext'));
  assert.ok(args.includes('sqlite_vec'));
  assert.ok(args.includes('pypdfium2_raw'));
});
