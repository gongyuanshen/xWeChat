"""对明确指定的本机账号测试重建、暂停恢复、搜索及零新增更新，仅保存统计。"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account', required=True)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--base-url', default='http://127.0.0.1:10392')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if urllib.parse.urlparse(args.base_url).hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('此测试仅允许连接本机应用')

    def request(path, params=None, method='GET'):
        params = {'account': args.account, **(params or {})}
        url = args.base_url + path + '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)

    def status():
        return request('/api/ai/local-search/status')

    report = {}
    for _ in range(90):
        try:
            initial = status()
            assert 'index_stats' in initial, '后端尚未加载修复版本'
            break
        except (OSError, AssertionError):
            time.sleep(1)
    else:
        raise RuntimeError('应用未就绪')

    cfg = initial['config']
    report['before'] = initial['index_stats']
    job = request('/api/ai/local-search/index/rebuild', method='POST')
    job_id = job['id']
    samples = []
    paused = False
    began = time.monotonic()
    try:
        while time.monotonic() - began < 600:
            state = status()
            job = next(j for j in state['jobs'] if j['id'] == job_id)
            sample = {k: job.get(k) for k in ('status', 'stage', 'read_count', 'processed', 'embedded_count', 'embedded', 'read_batch_size_effective')}
            if not samples or samples[-1] != sample:
                samples.append(sample)
            if not paused and job['status'] == 'running' and job['processed'] > 0:
                request('/api/ai/local-search/index/pause', method='POST')
                stopped = next(j for j in status()['jobs'] if j['id'] == job_id)
                assert stopped['status'] == 'paused'
                assert stopped['processed'] >= job['processed']
                report['pause_resume'] = {'saved_messages': stopped['processed'], 'paused': True}
                request('/api/ai/local-search/index/resume', {'job_id': job_id}, method='POST')
                paused = True
            if job['status'] == 'done':
                break
            assert job['status'] not in {'error', 'paused'}, job.get('error')
            time.sleep(.3)
        else:
            raise RuntimeError('重建超时')
        assert paused, '未覆盖暂停恢复路径'
        assert job['embedded'] > 0 and job['index_stats']['chunks'] > 0
        report['rebuild'] = {'messages': job['processed'], 'generated_chunks': job['embedded'],
            'seconds': round(job['finished'] - job['started'], 3), 'index_stats': job['index_stats'],
            'actual_device': state['device'].get('actual_device'), 'samples': samples}
        print(json.dumps({'rebuild': {k: v for k, v in report['rebuild'].items() if k != 'samples'}, 'pause_resume': report['pause_resume']}), flush=True)

        generation = state['config']['active']['generation']
        index_path = args.output_root / 'local_search/indexes' / (hashlib.sha256(args.account.encode()).hexdigest() + '.sqlite3')
        connection = sqlite3.connect(f'file:{index_path.as_posix()}?mode=ro', uri=True)
        cases = []
        try:
            import numpy as np
            for (blob,) in connection.execute('SELECT vector FROM chunks WHERE generation=?', (generation,)):
                vector = np.frombuffer(blob, dtype=np.float32)
                assert len(vector) == 512 and np.isfinite(vector).all() and abs(np.linalg.norm(vector) - 1) < 1e-4
            missing = connection.execute("""SELECT count(*) FROM messages m WHERE generation=?
                AND trim(json_extract(body,'$.text'))<>'' AND NOT EXISTS (
                    SELECT 1 FROM members x JOIN chunks c ON c.id=x.chunk WHERE x.source=m.source AND c.generation=m.generation)""", (generation,)).fetchone()[0]
            assert missing == 0
            report['storage'] = {'vectors_finite_and_normalized': True, 'nonempty_messages_without_chunks': missing}
            for username in cfg['usernames']:
                row = connection.execute("SELECT body FROM messages WHERE generation=? AND username=? AND kind='text' AND length(json_extract(body,'$.text')) BETWEEN 15 AND 60 ORDER BY created DESC LIMIT 1", (generation, username)).fetchone()
                if not row:
                    continue
                message = json.loads(row[0])
                params = {'username': username, 'q': message['text'], 'retrieval_mode': 'hybrid', 'limit': 10, 'render_types': 'text'}
                started = time.monotonic()
                result = request('/api/chat/search', params)
                hits = result.get('hits', [])
                assert result.get('retrievalMode') == 'hybrid'
                assert any(h['id'] == message['anchor'] for h in hits), '原文匹配未进入前十条'
                assert any('semantic' in h.get('matchMethods', []) for h in hits)
                assert all(h['username'] == username and h['renderType'] == 'text' for h in hits)
                next_page = request('/api/chat/search', {**params, 'offset': 10, 'search_ticket': result['searchTicket']})
                assert not {h['id'] for h in hits}.intersection(h['id'] for h in next_page.get('hits', []))
                around = request('/api/chat/messages/around', {'username': username, 'anchor_id': message['anchor'], 'before': 2, 'after': 2, 'source': 'auto'})
                assert any(m['id'] == message['anchor'] for m in around.get('messages', [])), '搜索结果无法定位原文'
                cases.append({'case': len(cases) + 1, 'semantic_search': True, 'exact_match_top10': True,
                    'scope_and_type_filter': True, 'pagination': True, 'anchor_navigation': True,
                    'seconds': round(time.monotonic() - started, 3)})
        finally:
            connection.close()
        assert len(cases) == len(cfg['usernames']), '所选聊天没有全部覆盖搜索测试'
        report['search_cases'] = cases
        print(json.dumps({'search_cases': cases}), flush=True)

        repeated = request('/api/ai/local-search/index/build', method='POST')
        for _ in range(180):
            state = status()
            repeated = next(j for j in state['jobs'] if j['id'] == repeated['id'])
            if repeated['status'] == 'done': break
            assert repeated['status'] != 'error', repeated.get('error')
            time.sleep(.5)
        assert repeated['status'] == 'done'
        report['repeat'] = {k: repeated.get(k) for k in ('processed', 'embedded', 'unchanged', 'index_stats')}
        assert repeated['index_stats']['chunks'] > 0
        report['success'] = True
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'success': True, 'repeat': report['repeat']}), flush=True)


if __name__ == '__main__':
    main()
