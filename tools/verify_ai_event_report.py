"""独立核验一次原文提取报告的覆盖、证据和日历；语义质量须另做人工验收。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from collections import Counter
from datetime import datetime, timezone, timedelta


def verify(folder, baseline):
    run = json.loads((folder / 'run.json').read_text(encoding='utf-8'))
    originals = json.loads((folder / 'material.json').read_text(encoding='utf-8'))
    expected = json.loads(baseline.read_text(encoding='utf-8'))
    pieces = {key: (kind, body) for key, kind, body in json.loads((folder / 'pieces.json').read_text(encoding='utf-8'))}
    context = run.get('answer_context') or {}
    covered = Counter()
    for key in context.get('extract_keys', []):
        if key in pieces:
            covered.update(pieces[key][1]['primary'])
    events = [event for key in context.get('review_keys', []) if key in pieces for event in pieces[key][1]['result']['events']]
    bad_proofs = []
    for event in events:
        for proof in event['evidence']:
            row = originals.get(proof['source'])
            if not row or not re.sub(r'\s+', '', proof['quote']) or re.sub(r'\s+', '', proof['quote']) not in re.sub(r'\s+', '', row['text']):
                bad_proofs.append(proof['source'])
    answer = (folder / 'answer.md').read_text(encoding='utf-8')
    citations = set(re.findall(r'\[\[([a-f0-9]{24})\]\]', answer))
    headers = re.findall(r'^### (\d{4}-\d{2}-\d{2})（星期([一二三四五六日])）', answer, re.M)
    zone = timezone(timedelta(seconds=run['timezone_offset']))
    start = datetime.fromtimestamp(run['time_range']['start'], zone).date()
    end = datetime.fromtimestamp(run['time_range']['end'] - 1, zone).date()
    days = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    usage = json.loads((folder / 'usage.json').read_text(encoding='utf-8'))
    checks = {
        'completed':run['status'] == 'completed',
        'exact_original_set':originals.keys() == expected.keys(),
        'exact_original_text_and_metadata':originals.keys() == expected.keys() and all(
            all(row.get(k) == expected[s].get(k) for k in ('text','time','anchor','username','sender')) for s,row in originals.items()),
        'exactly_one_primary_extraction':set(covered) == set(originals) and all(v == 1 for v in covered.values()),
        'exact_proof_quotes':bool(events) and not bad_proofs,
        'citations_known':bool(citations) and citations <= originals.keys(),
        'calendar_headers': [day for day,_ in headers] == days and all('一二三四五六日'[datetime.strptime(day,'%Y-%m-%d').weekday()] == w for day,w in headers),
        'no_media_calls':run['used']['media'] == 0,
        'no_intermediate_model_compaction':not any(t.get('action') == 'compact_context' for t in run.get('timeline',[])),
    }
    return {'run_id':run['id'], 'passed':all(checks.values()), 'checks':checks, 'elapsed_seconds':run.get('elapsed_seconds'),
        'originals':len(originals), 'extract_batches':len(context.get('extract_keys',[])), 'review_groups':len(context.get('review_keys',[])),
        'events':len(events), 'citations':len(citations), 'proofs':sum(len(e['evidence']) for e in events),
        'model_attempts':len(usage), 'failed_attempts':sum(u['status'] == 'failed' for u in usage),
        'answer_chars':len(answer), 'answer_sha256':hashlib.sha256(answer.encode()).hexdigest(),
        'bad_proofs':bad_proofs, 'semantic_quality':'未由本工具判断；必须单独人工核对状态、摘要及遗漏'}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--baseline', required=True, type=Path)
    args = parser.parse_args()
    result = verify(args.folder, args.baseline)
    output = args.folder / 'event-verification.json'
    if output.exists():
        parser.error('已有核验记录不覆盖')
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['passed'] else 1)
