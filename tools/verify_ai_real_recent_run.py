"""只读比较真实最近 N 条运行与独立固定时间基线；不调用模型，不替代原生界面验收。"""
import argparse
import json
from pathlib import Path
import re
import sqlite3


def inspect(database, run_id, reference):
    if reference.get('data') != 'existing_real_account' or not reference.get('passed'):
        raise ValueError('需要已经通过的独立真实读取基线')
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        found = db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (run_id,)).fetchone()
        if not found:
            raise ValueError('运行不存在')
        run = json.loads(found[0])
        if run['account'] != reference['account']:
            raise ValueError('账号与基线不一致')
        materials = [json.loads(body) for body, in db.execute('SELECT body FROM agent_material WHERE run_id=?', (run_id,))]
        usage = [json.loads(body) for body, in db.execute(
            "SELECT body FROM records WHERE kind='usage' AND account=? AND json_extract(body,'$.task_id')=?",
            (run['account'], run_id))]
    fields = ('source', 'anchor', 'username', 'time', 'sender_id')
    ordered = sorted(materials, key=lambda m: (m['time'], m['source']))
    actual = [{k: m.get(k) for k in fields} for m in ordered]
    expected = reference.get('expected', reference.get('actual'))
    answer = run.get('answer', '')
    groups = {m['username']: m.get('name') for m in materials if m['username'].endswith('@chatroom')}
    coverage = run.get('analysis', {}).get('coverage', [])
    checks = {
        'completed': run['status'] == 'completed',
        'same_cutoff': run['time_range']['end'] == reference['cutoff'],
        'same_conversation_count': len(run['query_filters']['conversations']) == reference['conversations'],
        'same_selected_messages': actual == expected,
        'requested_total': run['intent'].get('message_count') == reference.get('requested_count', len(expected)),
        'read_count': run['read_count'] == len(actual),
        'coverage_totals': sum(c['read'] for c in coverage) == len(actual) == sum(c['analyzed'] for c in coverage),
        'newest_first_citations': re.findall(r'\[\[([a-f0-9]{24})\]\]', answer) == [m['source'] for m in reversed(ordered)],
        'group_display_names': all(name and name != username and name in answer and username not in answer for username, name in groups.items()),
        'call_audit': len(usage) == run['used']['models'],
        'no_vision_calls': run['used']['media'] == 0,
    }
    selection = next((t for t in run.get('timeline', []) if t['id'].startswith('selection:')), {})
    return {'run_id':run_id, 'thread_id':run['thread_id'], 'checks':checks, 'passed':all(checks.values()),
            'actual':actual, 'expected':expected, 'used':run['used'], 'selection':run.get('analysis', {}).get('selection'),
            'selection_seconds':selection.get('finished_at', 0) - selection.get('started_at', 0),
            'selection_revision':selection.get('revision'), 'elapsed_seconds':run.get('elapsed_seconds'),
            'native_ui_verified_by_script':False, 'answer':answer}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('证据文件已存在，请使用新文件')
    result = inspect(args.database, args.run_id, json.loads(args.reference.read_text(encoding='utf-8')))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k:result[k] for k in ('passed','checks','used','selection','selection_seconds')}, ensure_ascii=False))
    if not result['passed']:
        raise SystemExit(1)
