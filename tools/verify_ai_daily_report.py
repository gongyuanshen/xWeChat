"""独立核查真实复测中的逐日原文覆盖和引用；不把结构检查当作语义质量保证。"""
import argparse
import json
from pathlib import Path
import re
from datetime import datetime, timezone, timedelta


def verify(folder):
    run = json.loads((folder / 'run.json').read_text(encoding='utf-8'))
    material = json.loads((folder / 'material.json').read_text(encoding='utf-8'))
    pieces = json.loads((folder / 'pieces.json').read_text(encoding='utf-8'))
    committed = set((run.get('answer_context') or {}).get('review_keys', []))
    daily = [body for key, kind, body in pieces if kind == 'report_day' and (not committed or key in committed)]
    zone = timezone(timedelta(seconds=run['timezone_offset']))
    reviewed, issues, proof_count, item_count = set(), [], 0, 0
    duplicate_coverage = set()
    for day in daily:
        for source in day['reviewed_sources']:
            if source in reviewed:
                duplicate_coverage.add(source)
            if source not in material or datetime.fromtimestamp(material[source]['time'], zone).date().isoformat() != day['day']:
                issues.append({'day': day['day'], 'source': source, 'error': '错误的逐日覆盖'})
            reviewed.add(source)
        for item in day['report']['items']:
            item_count += 1
            if not any(p['source'] in day['reviewed_sources'] for p in item['evidence']):
                issues.append({'day': day['day'], 'error': '事项只有其他批次的来源'})
            proof_count += len(item['evidence'])
            for proof in item['evidence']:
                row = material.get(proof['source'])
                exact = row and re.sub(r'\s+', '', proof['quote']) in re.sub(r'\s+', '', row['text'])
                if not exact:
                    issues.append({'day': day['day'], 'source': proof['source'], 'error': '原句不匹配'})
    answer = (folder / 'answer.md').read_text(encoding='utf-8')
    source_ids = set(re.findall(r'\[\[([a-f0-9]{24})\]\]', answer))
    headers = re.findall(r'^### (\d{4}-\d{2}-\d{2})（星期([一二三四五六日])）', answer, re.M)
    expected_headers = (run.get('answer_context') or {}).get('reviewed_days', [])
    checks = {'completed': run['status'] == 'completed', 'daily_policy': run.get('report_policy') == 'daily_evidence_v1',
        'all_originals_reviewed': reviewed == set(material), 'coverage_not_duplicated': not duplicate_coverage,
        'all_quotes_exact': not issues,
        'all_citations_known': bool(source_ids) and source_ids <= material.keys(),
        'ordered_calendar_headers': [day for day, _ in headers] == expected_headers and bool(headers),
        'weekdays_correct': bool(headers) and all(datetime.strptime(day, '%Y-%m-%d').weekday() == '一二三四五六日'.index(weekday) for day, weekday in headers),
        'no_media_calls': run.get('used', {}).get('media', 0) == 0}
    return {'run_id': run['id'], 'checks': checks, 'passed': all(checks.values()), 'read_count': len(material),
        'reviewed_originals': len(reviewed), 'days': len({p['day'] for p in daily}), 'batches': len(daily), 'items': item_count, 'exact_quotes': proof_count,
        'citations': len(source_ids), 'issues': issues, 'remote_calls': 0,
        'semantic_quality': '还需人工按活动状态、人物指代、含糊信息及遗漏进行原文抽查'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    args = parser.parse_args()
    result = verify(args.folder)
    output = args.folder / 'daily-verification.json'
    if output.exists():
        parser.error('已有核验记录不覆盖')
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['passed'] else 1)
