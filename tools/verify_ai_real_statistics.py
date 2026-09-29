"""把真实 AI 程序统计与独立聊天接口原消息逐条核对，不调用模型。"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
from urllib.parse import urlparse

import httpx


def verify(args):
    original = json.loads(args.chat_snapshot.read_text(encoding='utf-8-sig'))['messages']
    times = [m['createTime'] for m in original]
    # 快照必须跨过区间两端，避免把截断的一页误当作完整对照。
    if not times or min(times) >= args.start or max(times) < args.end:
        raise ValueError('独立聊天快照没有覆盖区间两端，请扩大 around 读取范围')
    selected = [m for m in original if args.start <= m['createTime'] < args.end]
    anchors = {m['id'] for m in selected}
    if len(anchors) != len(selected):
        raise ValueError('独立聊天快照包含重复消息，不能直接计数')
    expected = Counter(m['senderUsername'] for m in selected)
    with httpx.Client(base_url=args.backend, timeout=30) as client:
        def get(path, **params):
            response = client.get(path, params={'account': args.account, **params})
            response.raise_for_status()
            return response.json()

        base = '/api/ai/agent/runs/' + args.run
        run = get(base)
        statistics = get(base + '/materials', kind='statistics', limit=100)
        sources = []
        while True:
            page = get(base + '/materials', kind='sources', offset=len(sources), limit=100)
            sources.extend(page['items'])
            if not page['has_more']:
                break
            if not page['items']:
                raise AssertionError('来源分页未推进')
    actual = {m['sender_id']: m['count'] for m in statistics['sender_ranking']}
    checks = {
        'completed': run['status'] == 'completed',
        'statistics_mode': run['analysis']['mode'] == 'statistics',
        'full_coverage': run['analysis']['complete'],
        'time_range': run['time_range'] == {'start': args.start, 'end': args.end},
        'total': statistics['total_messages'] == len(selected),
        'senders': actual == dict(expected) and not statistics['sender_has_more'],
        'source_anchors': {s['anchor'] for s in sources} == anchors and len(sources) == len(anchors),
        'source_conversations': all(s['username'] == args.username for s in sources),
        'no_media_calls': run.get('used', {}).get('media') == 0,
    }
    if args.require_person_references:
        referenced = {r['username'] for r in run.get('references', []) if r['kind'] == 'person'
                      and '[[person:' + r['id'] + ']]' in run['answer']}
        checks['person_references'] = set(expected).issubset(referenced)
    if args.require_message_citations:
        cited = set(re.findall(r'\[\[([a-f0-9]{24})\]\]', run['answer']))
        checks['message_citations'] = bool(cited) and cited.issubset({row['source'] for row in sources})
    report = {'data': 'existing_real_account', 'native_ui': False, 'remote_calls_by_verifier': 0,
              'run_id': args.run, 'checks': checks, 'passed': all(checks.values()),
              'expected_total': len(selected), 'expected_senders': dict(expected),
              'statistics': statistics, 'answer': run['answer'], 'usage': run['usage']}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'checks': checks}, ensure_ascii=False))
    if not report['passed']:
        raise AssertionError('统计或出处要求未通过核对，差异已保存')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', default='http://127.0.0.1:10392')
    parser.add_argument('--account', required=True)
    parser.add_argument('--username', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--start', type=int, required=True)
    parser.add_argument('--end', type=int, required=True)
    parser.add_argument('--chat-snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--require-person-references', action='store_true')
    parser.add_argument('--require-message-citations', action='store_true')
    args = parser.parse_args()
    if urlparse(args.backend).hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('只允许读取本机接口')
    if not 0 <= args.start < args.end:
        parser.error('必须提供有效的左闭右开区间')
    verify(args)
