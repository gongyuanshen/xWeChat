"""Download and verify pinned Laya assets in an explicit isolated workspace directory."""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import time

from wechat_decrypt_tool.ai.insight_local_models import LocalInsightModels, SPEC
from wechat_decrypt_tool.ai.storage import AIStore
from wechat_decrypt_tool.local_search.catalog import file_hash


async def verify(root):
    started = time.monotonic()
    manager = LocalInsightModels(root / 'models', AIStore(root / 'ai'))
    report = {'started': datetime.now(timezone.utc).isoformat(), 'source': SPEC['source'],
              'model_id': SPEC['id'], 'revision': SPEC['revision'], 'isolated_root': str(root),
              'expected_bytes': sum(item['size'] for item in SPEC['files']), 'files': []}
    try:
        await manager.download()
        while manager.job and not manager.job.done():
            state = manager.status()
            print(json.dumps({key: state[key] for key in ('state', 'downloaded_bytes', 'total_bytes', 'error')},
                             ensure_ascii=False), flush=True)
            try:
                await asyncio.wait_for(asyncio.shield(manager.job), timeout=10)
            except asyncio.TimeoutError:
                continue
        if manager.job:
            await manager.job
        report['status'] = manager.status()
        if report['status']['state'] == 'ready':
            for item in SPEC['files']:
                path = manager.require_ready() / item['path']
                digest = await asyncio.to_thread(file_hash, path)
                report['files'].append(dict(path=item['path'], bytes=path.stat().st_size,
                    sha256=digest, passed=path.stat().st_size == item['size'] and digest == item['sha256']))
        report['passed'] = report['status']['state'] == 'ready' and all(item['passed'] for item in report['files'])
    finally:
        await manager.stop()
        report['duration_seconds'] = round(time.monotonic() - started, 3)
        report['finished'] = datetime.now(timezone.utc).isoformat()
        (root / 'download-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'state': report['status']['state'],
                      'model_path': str(manager.path), 'report': str(root / 'download-report.json')},
                     ensure_ascii=False), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Isolated directory under this repository tmp/')
    args = parser.parse_args()
    root = args.root.resolve()
    isolated_parent = Path(__file__).resolve().parents[1] / 'tmp'
    if root == isolated_parent or not root.is_relative_to(isolated_parent):
        parser.error('--root must be a child of this repository tmp/ directory')
    root.mkdir(parents=True, exist_ok=True)
    raise SystemExit(asyncio.run(verify(root)))
