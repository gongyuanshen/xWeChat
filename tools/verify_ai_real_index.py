"""只读真实快照、独立派生索引：验证部分发布、查询延迟和暂停恢复，不宣称全量性能通过。"""
import argparse
import asyncio
import json
import os
import sqlite3
import time
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlsplit


async def verify(root, output, model_root):
    from wechat_decrypt_tool.local_search.service import LocalSearch
    from wechat_decrypt_tool.local_search.catalog import model_dir, model_spec, verify_model
    account = root.name
    connect = sqlite3.connect
    before = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in root.glob('*.db*')}
    report = {'data': 'real_snapshot_readonly', 'remote_api_calls': 0, 'device': 'cpu',
              'local_encode_batches': 0, 'source_bytes': sum(v[0] for v in before.values()),
              'full_history_indexed': False, 'queries': [], 'passed': False}

    def readonly(database, *args, **kwargs):
        if isinstance(database, (str, Path)):
            value = str(database)
            candidate = unquote(urlsplit(value).path) if value.startswith('file:') else value
            if os.name == 'nt' and candidate.startswith('/') and len(candidate) > 2 and candidate[2] == ':':
                candidate = candidate[1:]
            path = Path(candidate).resolve()
            if path.is_relative_to(root):
                database = path.as_uri() + '?mode=ro&immutable=1'
                kwargs['uri'] = True
        return connect(database, *args, **kwargs)

    def resolve(selected):
        if selected != account:
            raise ValueError('只允许指定账号快照')
        return root

    def service():
        local = LocalSearch(output / 'index', model_root=model_root)
        encode = local.engine.encode

        def counted(*args, **kwargs):
            report['local_encode_batches'] += 1
            return encode(*args, **kwargs)

        local.engine.encode = counted
        return local

    async def wait_committed(local, job, minimum):
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            stats = local.index(account).stats(job['generation'])
            if stats['messages'] >= minimum and stats['chunks']:
                return stats
            if local.jobs[job['id']].done():
                raise RuntimeError('索引在达到验证批次之前结束：' + local.store.get('index_job', job['id'])['status'])
            await asyncio.sleep(.1)
        raise TimeoutError('首批或恢复批次等待超过 300 秒')

    local = service()
    with patch('sqlite3.connect', readonly), patch('wechat_decrypt_tool.chat_helpers._resolve_account_dir', resolve), \
            patch('wechat_decrypt_tool.account_source_policy.account_prefers_decrypted_snapshot', return_value=True):
        try:
            spec = model_spec('bge-small-zh')
            verify_model(model_dir(model_root, spec['id']), spec)
            local.store.put('model', {'id': spec['id'], 'revision': spec['revision']}, id=spec['id'])
            await local.configure(account, {'enabled': True, 'model': spec['id'], 'device': 'cpu', 'read_batch_size': 16})
            started = time.monotonic()
            job = await local.ensure_global(account)
            assert job is not None
            report['account_conversations'] = len(job['config']['usernames'])
            await wait_committed(local, job, 64)
            report['first_committed_seconds'] = round(time.monotonic() - started, 3)
            assert local.config(account)['active']['partial'] is True
            for query in ['项目', '报价', '安排']:
                began = time.monotonic()
                found = await local.hybrid(account, {'hits': []}, query, job['config']['usernames'])
                assert found['retrievalMode'] == 'hybrid'
                assert found['coverage']['partial'] and found['hits']
                assert all(h['username'] in job['config']['usernames'] for h in found['hits'])
                report['queries'].append({'seconds': round(time.monotonic() - began, 3), 'hits': len(found['hits'])})
            await local.pause_account(account)
            assert local.store.get('index_job', job['id'])['status'] == 'paused'
            with local.index(account).connection() as db:
                sources = {r[0] for r in db.execute('SELECT source FROM messages WHERE generation=?', (job['generation'],))}
            report['committed_at_pause'] = len(sources)
            report['checkpoint_processed'] = local.index(account).progress(job['id'])['processed']
            await local.stop()
            local = service()
            resumed = await local.resume(account, job['id'])
            assert resumed['processed'] == report['checkpoint_processed']
            await wait_committed(local, resumed, len(sources) + 32)
            await local.pause_account(account)
            with local.index(account).connection() as db:
                restored = {r[0] for r in db.execute('SELECT source FROM messages WHERE generation=?', (job['generation'],))}
            assert sources <= restored
            assert local.config(account)['active']['partial'] is True
            isolated = await local.hybrid('other-acceptance-account', {'hits': []}, '项目', job['config']['usernames'])
            assert isolated['retrievalMode'] == 'keyword' and not isolated['hits']
            report.update(committed_after_resume=len(restored), prior_sources_preserved=True,
                          resumed_from_checkpoint=True, account_isolation=True, passed=True)
        finally:
            await local.stop()
            after = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in root.glob('*.db*')}
            report['source_metadata_unchanged'] = before == after
            report['passed'] = report['passed'] and report['source_metadata_unchanged']
            (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    assert report['passed']
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model-root', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    root = args.account_dir.resolve()
    if output.is_relative_to(root) or root.is_relative_to(output):
        parser.error('派生目录必须与原始快照目录分离')
    output.mkdir(parents=True, exist_ok=False)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(output)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(output / 'output')
    asyncio.run(verify(root, output, args.model_root.resolve()))
