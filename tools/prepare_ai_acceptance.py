"""打包当前工作区源码与锁文件，生成双平台可核对的同版本清单，不包含账号或密钥。"""
import argparse
import hashlib
import json
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', '.venv', 'node_modules', '.nuxt', '.output', 'tmp', 'output', 'dist', '__pycache__', '.pytest_cache'}
SOURCE_ROOTS = {'src', 'frontend', 'desktop', 'tools', 'tests', 'docs', '.github'}


def files():
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    added = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    for name in sorted(set(tracked + added)):
        path = Path(name)
        if not name or any(part in EXCLUDED for part in path.parts): continue
        if name in added and (len(path.parts) < 2 or path.parts[0] not in SOURCE_ROOTS): continue
        if path.name.startswith('.env') or path.suffix in {'.sqlite3', '.db', '.pem', '.key'}: continue
        if name.startswith(('desktop/resources/backend/', 'desktop/resources/ui/')): continue
        full = ROOT / path
        if full.is_file() and not full.is_symlink(): yield name, full


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / 'wechat-ai-source.zip'
    if archive.exists(): parser.error('目标包已存在，请使用新目录，保留已有验收证据')
    manifest = {'created_utc': datetime.now(timezone.utc).isoformat(),
                'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
                # 打包本身不读取验收环境，不能把尚未核实的真实调用数写成零。
                'working_tree': True, 'files': {}, 'verification': {'windows': 'pending', 'macos': 'pending', 'real_model_calls': None}}
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, full in files():
            data = full.read_bytes()
            manifest['files'][name] = hashlib.sha256(data).hexdigest()
            bundle.writestr(name, data)
        bundle.writestr('acceptance-source-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    manifest['archive_sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
    (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'archive': str(archive.resolve()), 'files': len(manifest['files']), 'sha256': manifest['archive_sha256']}))


if __name__ == '__main__': main()
