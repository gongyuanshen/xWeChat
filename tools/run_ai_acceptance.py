"""双平台本地自动化验收。只执行模拟测试，不自动消费真实 API 或声明桌面通过。"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--node', default='node')
    parser.add_argument('--skip-install', action='store_true', help='已按锁文件安装依赖时使用')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    node = shutil.which(args.node) or args.node
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    # Windows 的 npm.cmd 会优先使用同目录 node.exe；显式绑定指定 Node，避免锁文件在旧版本下安装。
    npm_cli = Path(npm).resolve().parent / 'node_modules/npm/bin/npm-cli.js' if npm else None
    npm_command = [node, str(npm_cli)] if npm_cli and npm_cli.is_file() else ([npm] if npm else [])
    summary = {'started_utc': datetime.now(timezone.utc).isoformat(), 'platform': platform.platform(),
               'python': sys.version, 'node': subprocess.check_output([node, '--version'], text=True).strip(),
               'locks': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ('uv.lock', 'frontend/package-lock.json')},
               'checks': [], 'real_model_calls': 0, 'real_data': 'not_checked', 'real_electron': 'not_checked', 'real_model': 'not_checked'}
    report = output / 'result.json'
    source_manifest = ROOT / 'acceptance-source-manifest.json'
    if source_manifest.is_file():
        manifest = json.loads(source_manifest.read_text(encoding='utf-8'))
        changed = [name for name, digest in manifest['files'].items()
                   if not (ROOT / name).is_file() or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest]
        summary['source_manifest_sha256'] = hashlib.sha256(source_manifest.read_bytes()).hexdigest()
        summary['source_verified'] = not changed
        summary['source_mismatches'] = changed
        if changed:
            report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
            print('验收源码与交付清单不一致，请使用独立且完整的源码目录。')
            return 1
    def check(name, command, cwd=ROOT):
        started = time.time()
        with (output / (name + '.log')).open('w', encoding='utf-8') as log:
            try:
                result = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=1800)
                code = result.returncode
            except (OSError, subprocess.TimeoutExpired) as exc:
                log.write(str(exc)); code = -1
        summary['checks'].append({'name': name, 'command': command, 'exit_code': code, 'seconds': round(time.time() - started, 2)})
        report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
        return code == 0
    if not args.skip_install:
        if not npm_command or not check('frontend-install', [*npm_command, 'ci'], ROOT / 'frontend'): return 1
    check('runtime-synthetic', [sys.executable, 'tools/verify_ai_runtime.py'])
    test_files = sorted(str(p.relative_to(ROOT)) for pattern in ('test_ai*.py', 'test_local_search*.py') for p in (ROOT / 'tests').glob(pattern))
    check('backend-synthetic', [sys.executable, '-m', 'pytest', '-q', *test_files, '--basetemp=' + str(output / 'pytest'), '--tb=short'])
    check('frontend-components', [node, 'node_modules/vitest/vitest.mjs', 'run'], ROOT / 'frontend')
    node_tests = sorted(str(p.relative_to(ROOT / 'frontend')) for p in (ROOT / 'frontend/tests').glob('*.test.mjs'))
    check('frontend-node', [node, '--test', *node_tests], ROOT / 'frontend')
    check('frontend-generate', [node, 'node_modules/@nuxt/cli/bin/nuxi.mjs', 'generate'], ROOT / 'frontend')
    check('desktop-contracts', [node, '--test', 'desktop/tests/ai-notifications.test.cjs', 'desktop/tests/ai-packaging.test.cjs',
                              'desktop/tests/renderer-startup.test.cjs', 'desktop/tests/renderer-cache.test.cjs',
                              'desktop/tests/output-dir-main.test.cjs'])
    summary['finished_utc'] = datetime.now(timezone.utc).isoformat()
    summary['automated_pass'] = all(item['exit_code'] == 0 for item in summary['checks'])
    report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(str(report))
    return 0 if summary['automated_pass'] else 1


if __name__ == '__main__': sys.exit(main())
