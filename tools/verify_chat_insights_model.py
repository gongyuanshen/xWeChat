"""Run real insights acceptance using fixed, artificial conversations only.

python tools/verify_chat_insights_model.py --check-inputs
python tools/verify_chat_insights_model.py --preflight
python tools/verify_chat_insights_model.py

Reads only selected model settings from the application SQLite database. Provider
secrets remain in memory; all task, material, usage and report writes are isolated.
This tests execution and evidence contracts, not psychological accuracy.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
from unittest.mock import patch
import uuid


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
ACCOUNT = 'synthetic-insight-acceptance'
START = 1760000000
END = START + 3600
PEER = 'sample_partner'
GROUP = 'sample_team@chatroom'
SELF = 'sample_self'
ALEX = 'sample_alex'
BAO = 'sample_bao'
SAMPLES = {
    PEER: [
        (SELF, '本人', '最近项目赶进度，有点累，今晚想早点休息。'),
        (PEER, '测试伙伴', '辛苦啦，先吃点东西再休息。任务可以明早再看。'),
        (SELF, '本人', '谢谢。周末要不要一起散步？'),
        (PEER, '测试伙伴', '想去！不过周六上午要陪家人，下午三点我有空。'),
        (SELF, '本人', '好，下午三点在公园门口见。'),
        (PEER, '测试伙伴', '可以，我带两瓶水。这次别再把散步走成半程马拉松了哈哈。'),
        (SELF, '本人', '收到，我这次负责慢慢走。'),
        (PEER, '测试伙伴', '那就约好啦。今晚别熬夜，有需要可以叫我。'),
    ],
    GROUP: [
        (SELF, '本人', '周五的社区活动需要分工，谁方便准备海报和饮水？'),
        (ALEX, '小林', '海报我可以负责，今晚先给大家一个草稿。'),
        (BAO, '小林', '我这周工作比较忙，只能周五到现场帮一个小时。'),
        (SELF, '本人', '可以，时间有限就做力所能及的部分，不用勉强。'),
        (ALEX, '小林', '好呀，海报先别选十种颜色，不然会像水果摊哈哈。'),
        (BAO, '小林', '我觉得文字要清楚，装饰可以少一点。现场饮水我来带。'),
        (ALEX, '小林', '同意，我改成简单版。看到大家愿意一起做还是挺开心的。'),
        (SELF, '本人', '先确定海报由 sample_alex 负责，饮水由 sample_bao 负责。'),
        (BAO, '小林', '收到。如果下雨，我们改到室内，明天再确认天气。'),
    ],
}


class AcceptanceSetupError(ValueError):
    """Explicit safe configuration errors; never contains provider credentials."""
    def __init__(self, message, details=None):
        super().__init__(message)
        self.details = details or {}


def sample_messages(username):
    output = []
    for index, (sender, name, text) in enumerate(SAMPLES[username]):
        identity = f's:{1001 + index}'
        source = hashlib.sha256(f'{ACCOUNT}:{username}:{identity}'.encode()).hexdigest()[:24]
        output.append(dict(source=source, identity=identity, anchor=f'synthetic:messages:{index + 1}',
            username=username, time=START + index * 60, sender_id=sender, sender=name,
            kind='text', text=text, media={'content': text, 'senderUsername': sender, 'isSent': sender == SELF}))
    return output


def artificial_reader(account, username, start, end, *, checkpoint=None, page_size=100, sender_id=None, **kwargs):
    if account != ACCOUNT or username not in SAMPLES or kwargs.get('require_realtime'):
        raise ValueError('Acceptance reader only permits the fixed synthetic snapshot')
    rows = [m for m in sample_messages(username) if start <= m['time'] <= end
            and (sender_id is None or m['sender_id'] == sender_id)]
    for offset in range(0, len(rows), page_size):
        if checkpoint:
            checkpoint()
        yield dict(source='decrypted', warning='', username=username, name=username,
            messages=rows[offset:offset + page_size])


class ReadOnlyModelSettings:
    """Allowlisted settings reads; all writes go to the isolated AIStore."""
    def __init__(self, path, isolated):
        self.path, self.isolated = path.resolve(), isolated
        self.root, self.lock = isolated.root, threading.RLock()
        self.profile_id = ''

    def get(self, kind, id):
        if kind not in {'selected_model', 'profile', 'defaults', 'model_capabilities'}:
            raise ValueError('Only model settings may be read from the application database')
        if kind == 'profile' and id != self.profile_id:
            raise ValueError('Only the globally selected provider may be read')
        if kind == 'model_capabilities':
            discovered = self.isolated.get(kind, id)
            if discovered is not None:
                return discovered
        wal = Path(str(self.path) + '-wal')
        if wal.is_file() and wal.stat().st_size:
            raise AcceptanceSetupError('Settings have a nonempty WAL; immutable settings read is refused')
        before = self.path.stat()
        # Immutable avoids creating a shared-memory file in the real settings directory.
        with sqlite3.connect(self.path.as_uri() + '?mode=ro&immutable=1', uri=True) as db:
            row = db.execute('SELECT body FROM records WHERE kind=? AND id=?', (kind, id)).fetchone()
        after = self.path.stat()
        if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size) or (wal.is_file() and wal.stat().st_size):
            raise AcceptanceSetupError('Model settings changed during the read; acceptance must be restarted explicitly')
        return json.loads(row[0]) if row else None

    def list(self, kind, **kwargs):
        if kind != 'profile':
            raise ValueError('Only the selected model profile is available')
        value = self.get(kind, self.profile_id)
        return [value] if value else []

    def put(self, kind, body, **kwargs):
        if kind == 'profile' or 'api_key' in body:
            raise ValueError('Provider secrets must never be persisted in acceptance storage')
        return self.isolated.put(kind, body, **kwargs)


def checks_for(task, labels, username, member):
    from wechat_decrypt_tool.ai.insight_schemas import Portrait
    from wechat_decrypt_tool.ai.insights import referenced_sources
    material = sample_messages(username)
    target = member or ('' if username == GROUP else PEER)
    if target:
        material = [m for m in material if m['sender_id'] == target]
    allowed = {m['source'] for m in material}
    targets = {m['source'] for m in material if not target or m['sender_id'] == target}
    scope = 'member' if member else ('conversation' if username == GROUP else 'peer')
    portrait = task['portrait']
    checks = dict(completed=task['status'] == 'completed',
        exact_label_coverage=len(labels) == len(allowed) and {m['source'] for m in labels} == allowed,
        exact_analysis_count=task['progress']['analyzed'] == len(allowed),
        analysis_scope_matches_object=task['analysis_scope'] == scope,
        read_scope_matches_object=task['read_scope'] == scope,
        exact_read_count=task['progress']['read'] == task['coverage']['total'] == len(material),
        label_sources_in_scope=referenced_sources(labels) <= allowed if labels else None,
        portrait_present=portrait is not None,
        mbti_below_100_is_null=portrait['mbti'] is None if portrait is not None else None,
        affinity_matches_object=(username != GROUP or portrait['affinity'] is None) if portrait is not None else None)
    if portrait is not None:
        Portrait.model_validate(portrait, strict=True)
        checks['portrait_sources_in_scope'] = referenced_sources(portrait) <= allowed
        points = [portrait['summary'], *portrait['topics'], *portrait['communication'], *portrait['traits'].values()]
        if portrait['mood'] is not None:
            points.append(portrait['mood'])
        if portrait['affinity'] is not None:
            points.append(portrait['affinity'])
        checks['portrait_points_have_target_sources'] = all(not p['sources'] or set(p['sources']) & targets for p in points)
    return checks


async def run(settings_path, output, preflight=False, case_name=None):
    from wechat_decrypt_tool.ai import insights
    from wechat_decrypt_tool.ai.model_selection import SelectedModel
    from wechat_decrypt_tool.ai.providers import ModelService
    from wechat_decrypt_tool.ai.providers import ProviderFailure, audit_task_id
    from wechat_decrypt_tool.ai.service import AIService
    from wechat_decrypt_tool.ai.storage import AIStore

    store = AIStore(output / 'ai')
    settings = ReadOnlyModelSettings(settings_path, store)
    choice = settings.get('selected_model', 'global')
    if not choice or choice.get('unavailable'):
        raise AcceptanceSetupError('Global selected model is missing or unavailable; no fallback model will be used')
    choice = SelectedModel.model_validate({k: v for k, v in choice.items() if k != 'id'}).model_dump()
    settings.profile_id = choice['profile_id']
    models = ModelService(settings)
    catalogue = settings_path.parent / 'models-dev.json'
    if catalogue.is_file():
        cached = json.loads(catalogue.read_text(encoding='utf-8'))
        models.metadata.data = cached['data']
        models.metadata.updated_at = float(cached['updated_at'])
    profile = models.resolve_turn(choice['profile_id'], choice['model_id'], choice['reasoning_effort'],
        choice['thinking_mode'], choice['thinking_budget'])
    metadata_status = dict(catalog_cache_loaded=catalogue.is_file(),
        context_window=profile.get('context_window'),
        context_source=profile.get('model_metadata', {}).get('field_sources', {}).get('limit.context'))
    # User explicitly chose this insights-only budget; it is not a provider capability.
    profile = insights.insight_profile(profile)
    runtime_budget = insights.context_budget(profile)
    report = dict(synthetic_only=True, model_inference_enabled=not preflight,
        settings_read='read-only immutable; nonempty WAL rejected',
        model=profile['model'], provider=profile.get('provider'), cases=[],
        metadata=metadata_status,
        context_budget=runtime_budget, compaction_trigger=insights.COMPACTION_RATIO,
        limits='Execution/structure/source contracts only; no accuracy or psychometric validity claim')
    if preflight:
        report['preflight'] = 'ready'
        print(json.dumps(dict(preflight='ready', model=profile['model'], provider=profile.get('provider'),
            context_budget=runtime_budget, compaction_trigger=insights.COMPACTION_RATIO), ensure_ascii=False), flush=True)
        return report
    service = insights.InsightService(AIService(store=store, models=models), reader=artificial_reader)
    model_outputs = {}
    actual_invoke = models.invoke
    async def observe_invoke(profile, prompt, schema=None, **kwargs):
        records = model_outputs.setdefault(audit_task_id.get(), [])
        record = dict(schema=schema.__name__ if schema else None, prompt=prompt)
        try:
            result = await actual_invoke(profile, prompt, schema, **kwargs)
        except ProviderFailure as error:
            record['failure_reason'] = error.reason
            records.append(record)
            raise
        record['result'] = result
        if schema and schema.__name__ == 'LabelsOutput':
            data = json.loads(prompt.split('\nDATA\n', 1)[1])
            expected = [item['source'] for item in data['messages']]
            actual = [item['source'] for item in result['labels']]
            record['source_coverage'] = dict(expected=expected, actual=actual,
                missing=sorted(set(expected) - set(actual)), unexpected=sorted(set(actual) - set(expected)),
                duplicates=sorted(source for source in set(actual) if actual.count(source) > 1))
        records.append(record)
        # Record genuine SDK results without repairing or altering the service input.
        return result
    models.invoke = observe_invoke
    cases = [('single', PEER, ''), ('group', GROUP, ''), ('group_member', GROUP, ALEX)]
    if case_name:
        cases = [case for case in cases if case[0] == case_name]
    with patch.object(insights, 'source_for_account', lambda account: 'snapshot'):
        for name, username, member in cases:
            began = time.monotonic()
            print(json.dumps(dict(case=name, status='starting', model=profile['model']), ensure_ascii=False), flush=True)
            task = service.create_task(dict(account=ACCOUNT, username=username, member_username=member,
                start=START, end=END, selected_model=choice))
            job = service.jobs[task['id']]
            await job
            task = service.get_task(task['id'], ACCOUNT)
            labels = service.messages(task['id'], ACCOUNT, limit=100)['items']
            calls = [r for r in store.list('usage', ACCOUNT) if r['task_id'] == task['id']]
            allowed_usage = {'id', 'status', 'attempt', 'model', 'provider', 'usage', 'usage_known',
                'duration_ms', 'finish_reason', 'error_code', 'error_type', 'http_status', 'validation_errors'}
            checks = checks_for(task, labels, username, member)
            case = dict(case=name, task_id=task['id'], status=task['status'], elapsed_seconds=round(time.monotonic() - began, 3),
                coverage=task['coverage'], checks=checks, passed=all(checks.values()), error=task['error'],
                context_budget=task['context_budget'],
                usage=[{k: v for k, v in call.items() if k in allowed_usage} for call in calls],
                model_outputs=model_outputs.get(task['id'], []),
                portrait=task['portrait'], labels=labels)
            report['cases'].append(case)
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(dict(case=name, status=task['status'], passed=case['passed'],
                calls=len(calls), elapsed_seconds=case['elapsed_seconds'], error=task['error']), ensure_ascii=False), flush=True)
    await service.stop()
    report['passed'] = all(case['passed'] for case in report['cases'])
    return report


def main():
    from wechat_decrypt_tool.app_paths import get_output_dir
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings-db', type=Path, default=get_output_dir() / 'ai' / 'ai.sqlite3')
    parser.add_argument('--preflight', action='store_true', help='Read selected configuration only; no model request')
    parser.add_argument('--check-inputs', action='store_true', help='Validate fixed fixtures only; no settings/database/network')
    parser.add_argument('--case', choices=['single', 'group', 'group_member'], help='Explicit new diagnostic task for one fixed synthetic case')
    args = parser.parse_args()
    if args.check_inputs:
        for username in SAMPLES:
            rows = list(artificial_reader(ACCOUNT, username, START, END - 1))[0]['messages']
            assert len(rows) == len(SAMPLES[username]) and len({m['source'] for m in rows}) == len(rows)
            assert all(m['text'] and START <= m['time'] < END for m in rows)
        print('Fixed synthetic inputs verified; no model call or private data read.')
        return 0
    output = ROOT / 'tmp' / 'chat-insights-model-1002' / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    output.mkdir(parents=True)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(output)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(output / 'output')
    os.environ['WECHAT_TOOL_ENABLE_CONSOLE_LOG'] = '0'
    logging.basicConfig(level=logging.WARNING, handlers=[logging.FileHandler(output / 'diagnostics.log', encoding='utf-8')])
    logging.getLogger('httpx').setLevel(logging.CRITICAL)
    logging.getLogger('httpcore').setLevel(logging.CRITICAL)
    began = time.monotonic()
    try:
        if not args.settings_db.is_file():
            raise AcceptanceSetupError('AI settings database is missing; configure and select a model before acceptance')
        report = asyncio.run(run(args.settings_db, output, args.preflight, args.case))
    except Exception as error:
        # Never print arbitrary SDK/settings errors, which can contain URLs or secrets.
        report_path = output / 'report.json'
        report = json.loads(report_path.read_text(encoding='utf-8')) if report_path.is_file() else {}
        report.update(passed=False, error_type=type(error).__name__,
            reason=str(error) if isinstance(error, AcceptanceSetupError) else
                'Acceptance could not start or finish; inspect isolated diagnostics safely')
        if isinstance(error, AcceptanceSetupError):
            report.update(error.details)
        print(json.dumps(report), flush=True)
    report['elapsed_seconds'] = round(time.monotonic() - began, 3)
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Report: ' + str(output / 'report.json'), flush=True)
    return 0 if report.get('passed') or report.get('preflight') == 'ready' else 1


if __name__ == '__main__':
    raise SystemExit(main())
