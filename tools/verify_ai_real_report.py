"""只读核对真实报告的原消息集合、完整字符覆盖与阶段笔记；不调用模型。"""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import sqlite3


def readonly(path):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)


def inspect(args):
    with readonly(args.database) as db:
        # 同一个只读事务取一致快照，运行中也不会把两个时刻的进度混在一起。
        db.execute('BEGIN')
        row = db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (args.run,)).fetchone()
        if not row:
            raise ValueError('运行不存在')
        run = json.loads(row[0])
        if run['account'] != args.account or args.account == 'wxid_ai_acceptance':
            raise ValueError('账号不匹配或使用了隔离样例账号')
        material = {source: json.loads(body) for source, body in db.execute(
            'SELECT source,body FROM agent_material WHERE run_id=?', (args.run,))}
        notes = {key: json.loads(body) for key, body in db.execute(
            "SELECT id,body FROM agent_piece WHERE run_id=? AND version=? AND kind='stage_note'",
            (args.run, run['version']))}
        usage = [json.loads(body) for body, in db.execute(
            "SELECT body FROM records WHERE kind='usage' AND account=? AND json_extract(body,'$.task_id')=?",
            (args.account, args.run))]
    expected = set()
    table = 'Msg_' + hashlib.md5(args.username.encode()).hexdigest()
    source_files = []
    for path in sorted(args.messages.glob('message_*.db')):
        with readonly(path) as raw:
            actual = raw.execute('SELECT name FROM sqlite_master WHERE lower(name)=lower(?)', (table,)).fetchone()
            if not actual:
                continue
            # 表名仅来自数据库目录，仍按 SQLite 标识符规则转义。
            quoted = '"' + actual[0].replace('"', '""') + '"'
            ids = raw.execute(f'SELECT local_id FROM {quoted} WHERE create_time>=? AND create_time<?',
                              (args.start, args.end)).fetchall()
            expected.update(f'{path.stem}:{actual[0]}:{local}' for local, in ids)
            source_files.append({'database': path.name, 'count': len(ids)})
    expected_source = 'decrypted_snapshot'
    original_metadata = None
    snapshot_count = len(expected)
    if args.originals:
        original = json.loads(args.originals.read_text(encoding='utf-8'))
        if (original.get('source') != 'realtime_original_metadata' or not original.get('passed') or
                any(original.get(k) != getattr(args, k) for k in ('account', 'username', 'start', 'end'))):
            raise ValueError('实时原库基线的账号、会话或时间范围不匹配')
        original_metadata = {row['anchor']: row for row in original['records']}
        if len(original_metadata) != original['count'] or len(original_metadata) != len(original['records']):
            raise ValueError('实时原库基线条数或唯一定位不一致')
        if any(not args.start <= row['time'] < args.end for row in original_metadata.values()):
            raise ValueError('实时原库基线包含范围外消息')
        expected = set(original_metadata)
        source_files = original['sources']
        expected_source = 'realtime_original_metadata'
    if not expected:
        raise ValueError('独立原数据库范围为空，不能用于完整报告验收')

    intervals = defaultdict(list)
    unknown_note_sources = set()
    for note in notes.values():
        for ref in note.get('covered', []):
            intervals[ref['source']].append((ref['start'], ref['end']))
        for finding in note.get('notes', {}).get('items', []):
            unknown_note_sources.update(set(finding.get('sources', [])) - material.keys())
    incomplete = []
    for source, message in material.items():
        end = 0
        valid = True
        for start, stop in sorted(intervals[source]):
            if start < 0 or stop < start or start > end:
                valid = False
                break
            end = max(end, stop)
        if not valid or source not in intervals or end != len(message.get('text', '')):
            incomplete.append(source)
    actual_anchors = {m['anchor'] for m in material.values()}
    compactions = [item['result'] for item in run.get('timeline', [])
                  if item.get('action') == 'compact_context' and item.get('result', {}).get('saved')]
    capacity = (run.get('context_budget') or {}).get('input_capacity', run.get('input_budget', 0))
    answer = run.get('answer', '')
    citations = set(re.findall(r'\[\[([a-f0-9]{24})\]\]', answer))
    typed_markers = set(re.findall(r'\[\[(person|image):([a-f0-9]{24})\]\]', answer))
    markers = set(re.findall(r'\[\[([^\]]+)\]\]', answer))
    references = run.get('references') or {}
    reference_ids = {key for kind, key in typed_markers}
    def valid_reference(key):
        ref = references.get(key, {})
        if ref.get('id') != key:
            return False
        if ref.get('kind') == 'person':
            return bool(ref.get('username')) and bool(ref.get('sources')) and set(ref['sources']) <= material.keys()
        return ref.get('kind') == 'image' and ref.get('source') in material
    analysis = run.get('analysis') or {}
    checks = {
        'completed': run['status'] == 'completed',
        'exact_time_range': run.get('time_range') == {'start': args.start, 'end': args.end},
        'exact_original_anchors': actual_anchors == expected and len(actual_anchors) == len(material),
        'actual_conversation': bool(material) and all(m['username'] == args.username for m in material.values()),
        'full_analysis': bool(analysis.get('complete')) and bool(analysis.get('coverage'))
                         and all(c.get('complete') for c in analysis['coverage']),
        'whole_character_coverage': bool(material) and not incomplete,
        'multiple_saved_notes': len(notes) >= 2 and len(compactions) >= 2,
        'compaction_reduced_requests': bool(compactions) and capacity > 0
            and all(c['after'] < c['before'] and c['after'] <= capacity * .60 for c in compactions),
        'note_sources_valid': not unknown_note_sources,
        'answer_sources_valid': bool(citations) and citations <= material.keys(),
        'answer_references_valid': all(valid_reference(key) and references[key]['kind'] == kind for kind, key in typed_markers)
            and markers <= citations | {f'{kind}:{key}' for kind, key in typed_markers},
        'no_media_calls': run.get('used', {}).get('media', 0) == 0,
    }
    if original_metadata is not None:
        checks['original_metadata_match'] = bool(material) and all(
            m['anchor'] in original_metadata and m['time'] == original_metadata[m['anchor']]['time']
            for m in material.values())
    return {
        'data': 'existing_real_account', 'run_id': args.run, 'account': args.account,
        'status': run['status'], 'stage': run.get('stage'), 'version': run['version'],
        'remote_calls_by_verifier': 0, 'native_ui_verified_by_this_tool': False,
        'checks': checks, 'passed': all(checks.values()), 'expected_count': len(expected),
        'material_count': len(material), 'source_files': source_files,
        'expected_source': expected_source, 'decrypted_snapshot_count': snapshot_count,
        'missing_anchors': sorted(expected - actual_anchors), 'extra_anchors': sorted(actual_anchors - expected),
        'incomplete_sources': incomplete, 'saved_notes': len(notes), 'note_keys': sorted(notes),
        'note_parents': {key: note.get('parent') for key, note in notes.items()},
        'compression': compactions, 'context_budget': run.get('context_budget'),
        'analysis': analysis, 'real_model_calls': len(usage),
        'checkpoint': {'cutoff': run.get('cutoff'), 'timezone_offset': run.get('timezone_offset'),
            'profile_sha256': hashlib.sha256(json.dumps(run.get('profile'), sort_keys=True).encode()).hexdigest(),
            'active_material': run.get('active_material', []), 'pending_material': run.get('pending_material', []),
            'material_sha256': hashlib.sha256(json.dumps(material, sort_keys=True, ensure_ascii=False).encode()).hexdigest()},
        'known_input_tokens': sum((u.get('usage') or {}).get('input_tokens', 0) or 0 for u in usage),
        'known_output_tokens': sum((u.get('usage') or {}).get('output_tokens', 0) or 0 for u in usage),
        'unknown_usage_calls': sum(not u.get('usage_known') for u in usage),
        'answer_message_references': len(citations),
        'answer_person_references': sum(references.get(key, {}).get('kind') == 'person' for key in reference_ids),
        'answer_image_references': sum(references.get(key, {}).get('kind') == 'image' for key in reference_ids),
        'semantic_quality': '结构核对不代替笔记和最终回答的原文语义复核',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--messages', type=Path, required=True)
    parser.add_argument('--originals', type=Path, help='独立读取的实时原库定位元数据，避免把旧快照当作实时完整基线')
    parser.add_argument('--account', required=True)
    parser.add_argument('--username', required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--start', type=int, required=True)
    parser.add_argument('--end', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--require-complete', action='store_true')
    args = parser.parse_args()
    if not 0 <= args.start < args.end:
        parser.error('必须提供有效左闭右开区间')
    if args.output.exists():
        parser.error('输出已存在，保留原验收证据')
    result = inspect(args)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: result[key] for key in ('status', 'stage', 'material_count', 'expected_count',
          'saved_notes', 'real_model_calls', 'checks', 'passed')}, ensure_ascii=False))
    if args.require_complete and not result['passed']:
        raise SystemExit(1)
