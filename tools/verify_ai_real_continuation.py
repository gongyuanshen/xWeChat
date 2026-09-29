"""只读核对真实任务的续写、原文、笔记和配置；不把结构校验当作语义验收。"""
import argparse
import json
from pathlib import Path
import re
import sqlite3

from snapshot_ai_real_control import capture


def verify(database, run_id, baseline, prefix):
    current = capture(database, run_id)
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        run = json.loads(db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (run_id,)).fetchone()[0])
    answer, refs = run.get('answer', ''), run.get('references', {})
    markers = list(re.finditer(r'\[\[(?:(person|image):)?([a-f0-9]{24})\]\]', answer, re.I))
    sources = set(current['materials'])
    valid = True
    for marker in markers:
        kind, key = marker.groups()
        key = key.lower()
        if kind is None:
            valid &= key in sources
        else:
            ref = refs.get(key, {})
            kind = kind.lower()
            targets = ref.get('sources', []) if kind == 'person' else [ref.get('source')]
            valid &= ref.get('kind') == kind and any(s in sources for s in targets)
    def saved_pieces(value):
        return {p['id']: p['sha256'] for p in value['pieces'] if p['kind'] != 'timeline'}
    old_ids = {p['id'] for p in baseline['timeline']}
    newly_read = [p for p in current['timeline'] if p['id'] not in old_ids and
                  p['action'] in ('read_messages', 'compact_context')]
    first_line = prefix.split('\n', 1)[0]
    checks = {
        'completed': current['status'] == 'completed',
        'same_run': current['id'] == baseline['id'],
        'same_version': current['version'] == baseline['version'],
        'same_profile': current['profile_fingerprint'] == baseline['profile_fingerprint'],
        'same_originals': current['materials'] == baseline['materials'],
        'same_saved_notes_and_findings': saved_pieces(current) == saved_pieces(baseline),
        'same_note_key': current['note_key'] == baseline['note_key'],
        'no_new_read_or_compaction': not newly_read,
        'prefix_preserved': answer.startswith(prefix),
        'heading_not_repeated': answer.count(first_line) == 1,
        'all_references_resolve': bool(markers) and valid,
        'no_unfinished_reference': '[[' not in re.sub(r'\[\[(?:(?:person|image):)?[a-f0-9]{24}\]\]', '', answer, flags=re.I),
    }
    before_usage = {u['id'] for u in baseline['usage']}
    return {'data': 'existing_real_account', 'structural_passed': all(checks.values()),
            'semantic_acceptance': 'requires_manual_original_review', 'checks': checks,
            'run_id': run_id, 'read_count': current['read_count'], 'answer_chars': len(answer),
            'prefix_chars': len(prefix), 'reference_count': len(markers),
            'new_usage': [u for u in current['usage'] if u['id'] not in before_usage]}, answer


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('database', 'baseline', 'prefix', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('结果文件已存在，请选择新的输出位置')
    result, answer = verify(args.database, args.run_id, json.loads(args.baseline.read_text(encoding='utf8')), args.prefix.read_text(encoding='utf8'))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
    args.output.with_suffix('.answer.txt').write_text(answer, encoding='utf8')
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['structural_passed'] else 1)
