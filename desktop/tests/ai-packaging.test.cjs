const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { aiPackagingArgs } = require('../scripts/ai-packaging.cjs');

test('Windows 的 AI 资源必须以 add-data 参数传递，包含动态编码与检查点模块', () => {
  const args = aiPackagingArgs('/workspace', 'win32');
  for (const name of ['local_search_models.json', 'local_search_gpu.json', 'insight_local_model.json']) {
    const index = args.findIndex(value => value.includes(name));
    assert.equal(args[index - 1], '--add-data');
    assert.ok(args[index].endsWith(';wechat_decrypt_tool/resources'));
  }
  assert.ok(args.includes('langgraph.checkpoint.sqlite.aio'));
  assert.ok(args.includes('tiktoken_ext'));
  assert.ok(args.includes('sqlite_vec'));
  assert.ok(args.includes('pypdfium2_raw'));
});

test('本地画像打包资源源路径存在，并保留模型清单与第三方许可目录层级', () => {
  const root = path.resolve(__dirname, '../..');
  const args = aiPackagingArgs(root, 'win32');
  const resources = path.join(root, 'src/wechat_decrypt_tool/resources');
  for (const [source, destination] of [
    [path.join(resources, 'insight_local_model.json'), 'wechat_decrypt_tool/resources'],
    [path.join(resources, 'licenses'), 'wechat_decrypt_tool/resources/licenses'],
  ]) {
    const index = args.indexOf(`${source};${destination}`);
    assert.ok(index > 0, `缺少打包资源：${source}`);
    assert.equal(args[index - 1], '--add-data');
    assert.ok(fs.existsSync(source), `资源源路径不存在：${source}`);
  }
  for (const name of ['laya-LICENSE.txt', 'laya-NOTICE.txt', 'wechatvibe-LICENSE.txt', 'wechatvibe-NOTICE.txt']) {
    assert.ok(fs.statSync(path.join(resources, 'licenses', name)).size > 0, `许可文件为空：${name}`);
  }
});
