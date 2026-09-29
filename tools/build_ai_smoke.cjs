// 冻结 AI 运行检查器，验证动态库、清单和多进程，不依赖发布签名或真实账号。
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { aiPackagingArgs } = require('../desktop/scripts/ai-packaging.cjs');
const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const directory = path.join(root, 'tmp/ai-frozen-check');
fs.mkdirSync(directory, { recursive: true });
const result = spawnSync(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile',
  '--name', 'ai-runtime-check', '--distpath', path.join(directory, 'dist'),
  '--workpath', path.join(directory, 'build'), '--specpath', directory, '--paths', path.join(root, 'src'),
  ...aiPackagingArgs(root), path.join(__dirname, 'verify_ai_runtime.py')], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const executable = path.join(directory, 'dist', `ai-runtime-check${process.platform === 'win32' ? '.exe' : ''}`);
const env = { ...process.env, PYTHONPATH: '' }; delete env.PYTHONHOME;
const smoke = spawnSync(executable, process.argv.slice(2), { cwd: directory, env, stdio: 'inherit', timeout: 180000 });
process.exit(smoke.status || (smoke.error ? 1 : 0));
