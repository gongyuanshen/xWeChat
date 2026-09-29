const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// AI 的动态导入和清单统一收集，源码与冻结程序使用同一组资源。
function aiPackagingArgs(root, platform = process.platform) {
  const packages = ['deepagents', 'langchain', 'langchain_core', 'langchain_openai', 'langchain_anthropic', 'langchain_google_genai', 'langgraph', 'langsmith', 'wcmatch', 'bracex',
    'pypdf', 'pypdfium2', 'pypdfium2_raw', 'tiktoken', 'docx', 'pptx', 'openpyxl',
    'onnxruntime', 'tokenizers', 'sqlite_vec', 'huggingface_hub'];
  const args = packages.flatMap(name => ['--collect-all', name]);
  for (const name of ['local_search_models.json', 'local_search_gpu.json']) {
    args.push('--add-data', `${path.join(root, 'src/wechat_decrypt_tool/resources', name)}${platform === 'win32' ? ';' : ':'}wechat_decrypt_tool/resources`);
  }
  args.push('--collect-submodules', 'tiktoken_ext', '--hidden-import', 'langgraph.checkpoint.sqlite.aio');
  return args;
}

function runPackagedAiSmoke(backend, env = process.env) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-ai-smoke-'));
  try {
    const childEnv = { ...env, PYTHONPATH: '' };
    delete childEnv.PYTHONHOME;
    const result = spawnSync(backend, ['--smoke-ai'], { cwd: directory, env: childEnv, encoding: 'utf8', timeout: 120000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'AI 打包运行检查失败');
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    if (!report.ok || !report.frozen) throw new Error('AI 打包运行检查未通过');
    console.log(`AI 打包运行检查通过：${report.platform} / ${report.arch}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { aiPackagingArgs, runPackagedAiSmoke };
