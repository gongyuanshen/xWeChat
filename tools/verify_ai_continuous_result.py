"""只读核对隔离样例的最近 N 条、原文覆盖与真实压缩；不读取或导出模型密钥。"""
import argparse
import collections
import hashlib
import json
import re
import sqlite3
from pathlib import Path


def verify(database, messages, run_id, count, expected_sha):
    source_hash = hashlib.sha256(messages.read_bytes()).hexdigest()
    assert source_hash == expected_sha, '原消息库与验收基线不一致'
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        run = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (run_id,)).fetchone()[0])
        assert run['account'] == 'wxid_ai_acceptance', '此核对器仅用于明确的隔离样例账号'
        assert run['time_range'] == {'start': 0, 'end': run['cutoff']}, '未指定日期的问题不能擅自缩小时间范围'
        assert run['status'] == 'completed', '真实运行尚未完成'
        material = {s: json.loads(b) for s, b in db.execute('SELECT source,body FROM agent_material WHERE run_id=?', (run_id,))}
        notes = [json.loads(b) for b, in db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='stage_note'", (run_id, run['version']))]
        usage = [json.loads(b) for b, in db.execute("SELECT body FROM records WHERE kind='usage' AND json_extract(body,'$.task_id')=?", (run_id,))]
    expected = []
    names = ('acceptance_project@chatroom', 'acceptance_friend', 'acceptance_other@chatroom')
    assert set(run['query_filters']['conversations']) == set(names), '最近 N 条应在全部三个样例会话中选择'
    with sqlite3.connect(messages.resolve().as_uri() + '?mode=ro', uri=True) as raw:
        for name in names:
            table = 'msg_' + hashlib.md5(name.encode()).hexdigest()
            for local, server, stamp, body in raw.execute(f'SELECT local_id,server_id,create_time,message_content FROM "{table}" WHERE create_time>=0 AND create_time<?', (run['cutoff'],)):
                identity = f's:{server}' if server else f'l:message_0:{table}:{local}:{stamp}'
                source = hashlib.sha256(f"{run['account']}:{name}:{identity}".encode()).hexdigest()[:24]
                text = body.split(':\n', 1)[-1] if name.endswith('@chatroom') else body
                expected.append({'source': source, 'time': stamp, 'username': name, 'text': text})
    expected = sorted(expected, key=lambda m: (m['time'], m['source']))[-count:]
    assert len(expected) == count and set(material) == {m['source'] for m in expected}, '最近 N 条的精确来源集合不匹配'
    assert all(material[m['source']]['text'] == m['text'] for m in expected), '原文正文与消息库不匹配'
    intervals = collections.defaultdict(list)
    for note in notes:
        for ref in note['covered']:
            intervals[ref['source']].append((ref['start'], ref['end']))
    for source, item in material.items():
        end = 0
        for start, stop in sorted(intervals[source]):
            assert start <= end, '已保存笔记覆盖的原文中有缺口'
            end = max(end, stop)
        assert end == len(item['text']), '没有完整分析整条原文'
    compaction = [x for x in run['timeline'] if x.get('action') == 'compact_context']
    saved = [x['result'] for x in compaction if x.get('result', {}).get('saved')]
    budget = run['context_budget']['input_capacity']
    assert len(saved) >= 2 and len(notes) >= 2, '没有发生多轮真实压缩'
    assert all(x['after'] < x['before'] and x['after'] <= budget * .60 for x in saved), '压缩未真实降低至目标占用'
    citations = set(re.findall(r'\[\[([a-f0-9]{24})\]\]', run['answer']))
    assert citations and citations <= set(material), '回答引用不可解析'
    return {
        'passed': True, 'run_id': run_id, 'account': run['account'], 'status': run['status'],
        'source_sha256': source_hash, 'exact_selected_count': count,
        'coverage': dict(collections.Counter(m['username'] for m in expected)),
        'whole_character_coverage': True, 'saved_notes': len(notes), 'compression': saved,
        'context_budget': run['context_budget'], 'citations': len(citations),
        'real_model_calls': len(usage), 'usage_statuses': dict(collections.Counter(x['status'] for x in usage)),
        'unknown_usage_calls': sum(not x.get('usage_known') for x in usage),
        'known_input_tokens': sum((x.get('usage') or {}).get('input_tokens', 0) or 0 for x in usage),
        'known_output_tokens': sum((x.get('usage') or {}).get('output_tokens', 0) or 0 for x in usage),
        'semantic_quality': '需要另行人工核对回答与笔记，结构核对不代表语义质量全部通过',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--messages', type=Path, required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--count', type=int, default=240)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('输出已存在，请保留旧验收证据')
    result = verify(args.database, args.messages, args.run, args.count, args.expected_sha256)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
