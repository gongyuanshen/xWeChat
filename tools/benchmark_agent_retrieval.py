"""在隔离副本比较旧/新检索；只输出数量和耗时，绝不修改源账号索引。

--manifest 接受本地私有 JSON: source_index, model_root, config (已有本地检索设置)。
不传 manifest 时使用合成消息和固定向量，不代表真实模型性能。
冷启动指新服务和新推理进程，未清空操作系统文件缓存。
"""
import argparse
import asyncio
from contextlib import closing
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))


def load_baseline(module, revision, folder):
    relative = f'src/wechat_decrypt_tool/local_search/{module}.py'
    source = subprocess.run(['git', 'show', f'{revision}:{relative}'], cwd=ROOT,
                            check=True, capture_output=True).stdout
    path = folder / f'{module}_before.py'
    path.write_bytes(source)
    name = f'wechat_decrypt_tool.local_search._benchmark_{module}'
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


def distribution(values):
    ordered = sorted(values)
    return {'samples': len(values), 'p50_ms': round(ordered[math.ceil(len(values) * .5) - 1], 3),
            'p95_ms': round(ordered[math.ceil(len(values) * .95) - 1], 3)}


def backup(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True)) as src:
        with closing(sqlite3.connect(destination)) as target:
            src.backup(target)


def vector_digest(index):
    digest = hashlib.sha256()
    with index.connection() as db:
        for row in db.execute('SELECT id, vector FROM chunks ORDER BY id'):
            digest.update(row[0].encode())
            digest.update(row[1])
    return digest.hexdigest()


class SyntheticEngine:
    """只用于隔离数据库开销；报告显式标记不含模型推理。"""
    def __init__(self):
        self.status = {'actual_device': 'synthetic'}
        self.gpu_root = None
        self.gpu_failed = False
        self.calls = 0

    def encode(self, *args, **kwargs):
        self.calls += 1
        return [[1., 0.]] * len(args[2])

    def close(self):
        return None


async def benchmark(args):
    from wechat_decrypt_tool.local_search.index import SemanticIndex
    from wechat_decrypt_tool.local_search.service import LocalSearch
    from wechat_decrypt_tool.local_search.inference import LocalInference

    destination = args.output.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    # 所有任务、诊断和账号工作预留均属于隔离目录。
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(destination)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(destination / 'output')
    old_index = load_baseline('index', args.baseline, destination).SemanticIndex
    old_service = load_baseline('service', args.baseline, destination)
    old_service.SemanticIndex = old_index
    if args.manifest:
        manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
        cfg = manifest['config']
        source = Path(manifest['source_index'])
        model_root = Path(manifest['model_root'])
    else:
        cfg = {'account': 'benchmark', 'enabled': True, 'model': 'bge-small-zh',
               'usernames': [f'chat{i}' for i in range(20)], 'days': 0, 'start': 0,
               'end': 2**53, 'device': 'cpu', 'device_id': 0, 'revision': 1,
               'active': {'generation': 'g', 'model': 'bge-small-zh', 'start': 0,
                          'end': 2**53, 'updated': 1, 'usernames': [f'chat{i}' for i in range(20)]}}
        model_root = destination / 'models'
        source = destination / 'synthetic.sqlite3'
        fixture = old_index(source)
        for offset in range(0, args.messages, 1000):
            messages = [dict(source=f'm{i:08}', anchor=f'm{i:08}', username=f'chat{i % 20}',
                             sender='alice' if i % 5 else 'bob', sender_id='alice' if i % 5 else 'bob',
                             time=1000 + i, kind='text', text=f'项目记录 {i}，合同金额 35000，订单 AB-{i:08}，emoji 🧪。')
                        for i in range(offset, min(offset + 1000, args.messages))]
            chunks = [dict(text=m['text'], sources=[m['source']], username=m['username']) for m in messages]
            fixture.commit('g', messages, chunks, [[1., 0.]] * len(chunks), {'id': 'fixture', 'offset': offset})

    account = cfg['account']
    generation = cfg['active']['generation']
    index_name = hashlib.sha256(account.encode()).hexdigest() + '.sqlite3'
    before_path = destination / 'before' / 'indexes' / index_name
    after_path = destination / 'after' / 'indexes' / index_name
    backup(source, before_path)
    backup(source, after_path)
    before_bytes = before_path.stat().st_size
    old = old_index(before_path)
    initial_vectors = vector_digest(old)
    began = time.perf_counter()
    new = SemanticIndex(after_path)
    batches = 0
    while not new.fts_status()['complete']:
        new.backfill_fts(generation, batch_size=args.batch_size)
        batches += 1
    migration_seconds = time.perf_counter() - began
    assert vector_digest(new) == initial_vectors, '迁移改变了原有向量'
    with new.connection() as db:
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        messages = db.execute('SELECT count(*) FROM messages').fetchone()[0]
        chunks = db.execute('SELECT count(*) FROM chunks').fetchone()[0]
    report = {'dataset': 'real_account_readonly_copy' if args.manifest else 'synthetic',
              'model': cfg['model'] if args.manifest else 'fixed_vectors_no_model',
              'messages': messages, 'chunks': chunks, 'iterations': args.iterations,
              'cold_definition': ('new service and inference process' if args.manifest else
                                  'new service and synthetic engine instance') + '; OS file cache not cleared',
              'entrypoint': 'LocalSearch.hybrid with empty base keyword candidates; excludes base FTS, router and Agent tool chain',
              'migration': {'seconds': round(migration_seconds, 3), 'batches': batches,
                            'before_bytes': before_bytes, 'after_bytes': after_path.stat().st_size,
                            'extra_bytes': after_path.stat().st_size - before_bytes, 'vectors_unchanged': True}}

    queries = ['项目', '合同', '35000', 'AB-', '好', '😀', 'meeting', '!!!']
    timings = {'before': [], 'after': []}
    for index in (old, new):
        index.keyword(generation, queries[0], cfg['active']['usernames'], limit=200)
    # 同一组词、范围、发送人、类型逐项核对；不把词/正文/账号写入报告。
    for i in range(args.iterations):
        query = queries[i % len(queries)]
        outputs = []
        for label, index in [('before', old), ('after', new)]:
            began = time.perf_counter()
            found = index.keyword(generation, query, cfg['active']['usernames'], limit=200)
            timings[label].append((time.perf_counter() - began) * 1000)
            outputs.append([m['source'] for m in found])
        assert outputs[0] == outputs[1], f'literal mismatch case {i}'
    report['literal'] = {key: distribution(value) for key, value in timings.items()}
    report['literal']['same_results'] = True

    reference_results = []
    for label, cls in [('before', old_service.LocalSearch), ('after', LocalSearch)]:
        engine = LocalInference() if args.manifest else SyntheticEngine()
        encode = engine.encode
        encode_calls = 0
        def counted_encode(*positional, **keyword):
            nonlocal encode_calls
            encode_calls += 1
            return encode(*positional, **keyword)
        engine.encode = counted_encode
        service = cls(destination / label, model_root, engine=engine)
        service.store.put('config', cfg, id=account, account=account)
        timings = []
        pages = []
        cold = []
        try:
            for i in range(args.iterations + 1):
                began = time.perf_counter()
                extra = {'strict_paging': True} if label == 'after' else {}
                result = await service.hybrid(account, {'hits': [], 'hasMore': False, 'total': 0},
                    queries[i % len(queries)], cfg['active']['usernames'], cfg['active']['start'],
                    cfg['active']['end'], limit=10, **extra)
                duration = (time.perf_counter() - began) * 1000
                assert result['retrievalMode'] == 'hybrid', f'{label} did not execute hybrid'
                assert result.get('hasMore'), '数据量不足以测量真实续页'
                identities = [(m['username'], m['id']) for m in result['hits']]
                if label == 'before':
                    reference_results.append(identities)
                else:
                    assert identities == reference_results[i], f'hybrid ranking mismatch case {i}'
                if i == 0:
                    report[label] = {'cold_first_query_ms': round(duration, 3)}
                    cold.append(duration)
                else:
                    timings.append(duration)
                calls = encode_calls
                began = time.perf_counter()
                # 旧 Agent 丢弃 ticket；新 Agent 复用首个请求返回的票据。
                page = await service.hybrid(account, {'hits': [], 'hasMore': False, 'total': 0},
                    queries[i % len(queries)], cfg['active']['usernames'], cfg['active']['start'],
                    cfg['active']['end'], offset=10, limit=10,
                    ticket=result['searchTicket'] if label == 'after' else None, **extra)
                pages.append((time.perf_counter() - began) * 1000)
                assert not page.get('resetSearch')
                assert not {(m['username'], m['id']) for m in result['hits']} & {(m['username'], m['id']) for m in page['hits']}
                assert encode_calls == calls, '续页重复编码'
            report[label].update(warm_hybrid=distribution(timings), continuation=distribution(pages),
                                 actual_device=engine.status.get('actual_device'), encode_calls=encode_calls,
                                 continuation_encode_calls=0)
        finally:
            engine.close()
        for _ in range(args.cold_samples - 1):
            fresh_engine = LocalInference() if args.manifest else SyntheticEngine()
            fresh_service = cls(destination / label, model_root, engine=fresh_engine)
            try:
                began = time.perf_counter()
                result = await fresh_service.hybrid(account, {'hits': [], 'hasMore': False, 'total': 0},
                    queries[0], cfg['active']['usernames'], cfg['active']['start'],
                    cfg['active']['end'], limit=10, **({'strict_paging': True} if label == 'after' else {}))
                cold.append((time.perf_counter() - began) * 1000)
                assert result['retrievalMode'] == 'hybrid'
                assert [(m['username'], m['id']) for m in result['hits']] == reference_results[0]
            finally:
                fresh_engine.close()
        report[label]['cold_start'] = distribution(cold)
    report['hybrid_same_results'] = True
    (destination / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='全新隔离目录')
    parser.add_argument('--baseline', default='HEAD')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--messages', type=int, default=30000)
    parser.add_argument('--iterations', type=int, default=24)
    parser.add_argument('--cold-samples', type=int, default=5)
    parser.add_argument('--batch-size', type=int, default=500)
    args = parser.parse_args()
    if args.iterations < 2 or args.messages < 20 or args.batch_size < 1 or args.cold_samples < 1:
        parser.error('iterations>=2, messages>=20, batch-size>=1, cold-samples>=1 required')
    asyncio.run(benchmark(args))
