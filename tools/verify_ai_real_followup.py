"""只读核对同范围追问复用、旧回答保留与调用审计；语义须另行核对原文。"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3


def inspect(database, account, previous_id, run_id, previous_answer):
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('BEGIN')
        def record(kind, identifier):
            row = db.execute('SELECT body FROM records WHERE kind=? AND id=?', (kind, identifier)).fetchone()
            if row is None:
                raise ValueError('指定记录不存在')
            return json.loads(row[0])
        old, current = record('agent_run', previous_id), record('agent_run', run_id)
        if old['account'] != account or current['account'] != account:
            raise ValueError('任务不属于指定账号')
        def materials(identifier):
            return {source: json.loads(body) for source, body in db.execute(
                'SELECT source,body FROM agent_material WHERE run_id=?', (identifier,))}
        before, after = materials(previous_id), materials(run_id)
        def note(run):
            row = db.execute('SELECT body FROM agent_piece WHERE run_id=? AND version=? AND id=?',
                             (run['id'], run.get('applied_version') or run['version'], run.get('note_key', ''))).fetchone()
            return json.loads(row[0]) if row else {}
        prior_note, inherited = note(old), note(current)
        usage = [json.loads(body) for body, in db.execute(
            "SELECT body FROM records WHERE kind='usage' AND account=? AND json_extract(body,'$.task_id')=?",
            (account, run_id))]
        tools = [item for item in current.get('timeline', []) if item.get('kind') == 'tool']
        fields = ('username', 'anchor', 'time', 'text', 'sender_id')
        changed = [source for source, message in before.items() if source not in after or
                   any(message.get(field) != after[source].get(field) for field in fields)]
        checks = {
            'completed': current['status'] == 'completed',
            'same_thread': old['thread_id'] == current['thread_id'],
            'same_filters': bool(old.get('query_filters')) and old.get('query_filters') == current.get('query_filters'),
            'followup_search': current.get('intent', {}).get('followup') is True and current['intent']['mode'] == 'search',
            'original_answer_preserved': old.get('answer', '') == previous_answer.read_text(encoding='utf-8'),
            'original_material_preserved': bool(before) and not changed,
            'stage_note_reused': bool(prior_note) and prior_note.get('notes') == inherited.get('notes')
                and inherited.get('inherited_from', {}).get('run_id') == previous_id,
            'no_full_range_reread': not any(item.get('action') == 'read_messages'
                and item.get('start') == old.get('time_range', {}).get('start')
                and item.get('end') == old.get('time_range', {}).get('end') for item in tools),
            'no_media_calls': current.get('used', {}).get('media') == 0,
            'call_audit_matches': len(usage) == current.get('used', {}).get('models'),
        }
        return {
            'run_id': run_id, 'previous_run_id': previous_id, 'status': current['status'],
            'checks': checks, 'structural_passed': all(checks.values()),
            'semantic_acceptance': 'requires_original_message_review',
            'previous_materials': len(before), 'current_materials': len(after), 'changed_sources': changed,
            'answer_chars': len(current.get('answer', '')),
            'previous_answer_sha256': hashlib.sha256(old.get('answer', '').encode()).hexdigest(),
            'actions': [{key: item.get(key) for key in ('action', 'status', 'source', 'query', 'start', 'end')} for item in tools],
            'model_attempts': [{key: item.get(key) for key in ('id', 'purpose', 'status', 'duration_ms',
                'usage_known', 'usage', 'error_category', 'http_status')} for item in usage],
            'remote_calls_by_verifier': 0,
        }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--previous', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--previous-answer', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = inspect(args.database, args.account, args.previous, args.run, args.previous_answer)
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['structural_passed'] else 1)
