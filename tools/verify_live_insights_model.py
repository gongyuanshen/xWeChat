"""Verify real live labels on artificial single/group messages, never private chats.

Reads only the currently selected provider through ReadOnlyModelSettings. All
labels, usage, events and reports are written beneath this checkout's tmp folder.
Three explicit requests: one peer message, new peer messages with context,
then other group members' messages. A failure stops the run without retries.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import aclosing
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))

from verify_chat_insights_model import (ACCOUNT, PEER, GROUP, SELF, AcceptanceSetupError,
    ReadOnlyModelSettings, artificial_reader, sample_messages)
from wechat_decrypt_tool.ai import insights, insight_label_stream, insight_live
from wechat_decrypt_tool.ai.model_selection import SelectedModel
from wechat_decrypt_tool.ai.providers import ModelService, audit_task_id
from wechat_decrypt_tool.ai.service import AIService
from wechat_decrypt_tool.ai.storage import AIStore


def ref(item):
    return dict(identity=item['identity'], time=item['time'],
                fingerprint=hashlib.sha256(item['text'].encode()).hexdigest())


async def run(settings_path, output, preflight=False):
    store = AIStore(output / 'ai')
    settings = ReadOnlyModelSettings(settings_path, store)
    choice = settings.get('selected_model', 'global')
    if not choice or choice.get('unavailable'):
        raise AcceptanceSetupError('The globally selected model is missing or unavailable')
    choice = SelectedModel.model_validate({k: v for k, v in choice.items() if k != 'id'}).model_dump()
    settings.profile_id = choice['profile_id']
    models = ModelService(settings)
    catalog_path = settings_path.parent / 'models-dev.json'
    if catalog_path.is_file():
        catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
        models.metadata.data = catalog['data']
        models.metadata.updated_at = float(catalog['updated_at'])
    profile = models.resolve_turn(choice['profile_id'], choice['model_id'], choice['reasoning_effort'],
                                  choice['thinking_mode'], choice['thinking_budget'])
    mode = insight_label_stream.delivery_mode(profile)
    report = dict(synthetic_only=True, model=profile['model'], provider=profile.get('provider'),
                  delivery_mode=mode, settings_read='immutable read-only; credentials in memory only',
                  model_inference_enabled=not preflight, cases=[],
                  limits='Execution and evidence validation; not a measurement of classification accuracy')
    if preflight:
        report['preflight'] = 'ready'
        print(json.dumps(dict(preflight='ready', model=profile['model'], delivery_mode=mode)), flush=True)
        return report
    service = insights.InsightService(AIService(store, models), reader=artificial_reader)
    live = service.live
    chunks = {}
    actual_responses = insight_label_stream._responses

    async def observe_responses(*args, **kwargs):
        async with aclosing(actual_responses(*args, **kwargs)) as responses:
            async for response in responses:
                metadata = response.response_metadata
                content = response.content
                chars = len(content) if isinstance(content, str) else sum(len(block.get('text', ''))
                    for block in content if isinstance(block, dict) and isinstance(block.get('text', ''), str))
                chunks.setdefault(audit_task_id.get(), []).append(dict(at=time.time(), chars=chars,
                    finish_reason=metadata.get('finish_reason') or metadata.get('stop_reason'),
                    status=metadata.get('status'), usage_known=bool(response.usage_metadata)))
                yield response

    async def case(name, username, items, context):
        scope = dict(account=ACCOUNT, username=username, engine='api', selected_model=choice)
        await live.settings(scope | dict(enabled=True))
        started = time.time()
        batch = live.create_batch(scope | dict(messages=[ref(item) for item in items],
                                              context=[ref(item) for item in context]))
        print(json.dumps(dict(case=name, status='starting', messages=len(items), context=len(context))), flush=True)
        await live.jobs[batch['id']]
        batch = live.get_batch(batch['id'], ACCOUNT)
        records = batch['items']
        events = [event for event in store.events(account=ACCOUNT)
                  if event['kind'] == 'insight_live' and event['body']['batch_id'] == batch['id']]
        labels = [dict(source=event['body']['label']['source'], elapsed=round(event['created'] - started, 4))
                  for event in events if 'label' in event['body']]
        finished = next((event['created'] for event in events
                         if event['body']['status'] in {'completed', 'failed', 'cancelled'}), None)
        sdk = chunks.get(batch['id'], [])
        sdk_report = [{**event, 'elapsed': round(event['at'] - started, 4)} for event in sdk]
        for event in sdk_report:
            del event['at']
        allowed = {item['source'] for item in [*context, *items]}
        expected = {item['source'] for item in items}
        usage = [row for row in store.list('usage', ACCOUNT) if row['task_id'] == batch['id']]
        count_before_restore = len(store.list('usage', ACCOUNT))
        restored = live.state(scope | dict(messages=[ref(item) for item in items]))
        checks = dict(completed=batch['status'] == 'completed',
            exact_coverage={item['source'] for item in records} == expected and len(records) == len(expected),
            labels_at_most_four=all(value is None or 1 <= len(value) <= 4
                for item in records for value in (item['label']['emotion'], item['label']['intent'])),
            evidence_in_scope=all(set(item['label']['sources']) <= allowed for item in records),
            current_message_evidence=all(item['source'] in item['label']['sources']
                for item in records if item['label']['emotion'] is not None or item['label']['intent'] is not None),
            events_before_completion=len(labels) == len(items) and finished is not None
                and all(started + event['elapsed'] <= finished + 0.0001 for event in labels),
            single_request=len(usage) == 1 and usage[0]['attempt'] == 1,
            successful_audit=len(usage) == 1 and usage[0]['status'] == 'success',
            restored_same_sources={item['source'] for item in restored['items']} == expected,
            restoration_no_request=len(store.list('usage', ACCOUNT)) == count_before_restore)
        if mode == 'stream':
            terminal = next((event['at'] for event in sdk if event['finish_reason'] in {'stop', 'end_turn'}
                             or event['status'] == 'completed'), None)
            checks['real_stream_terminal'] = terminal is not None
            checks['label_before_sdk_terminal'] = bool(labels) and terminal is not None and started + labels[0]['elapsed'] < terminal
        if checks['completed']:
            cached = live.create_batch(scope | dict(messages=[ref(item) for item in items]))
            await live.jobs[cached['id']]
            cached = live.get_batch(cached['id'], ACCOUNT)
            checks['cache_batch_no_request'] = (cached['status'] == 'completed'
                and cached['progress']['total'] == 0 and len(store.list('usage', ACCOUNT)) == count_before_restore)
        result = dict(case=name, batch_id=batch['id'], status=batch['status'], passed=all(checks.values()),
            checks=checks, error=batch['error'], messages=len(items), context_messages=len(context),
            elapsed_seconds=round(time.time() - started, 3), label_events=labels, sdk_chunks=sdk_report,
            completion_elapsed=round(finished - started, 4) if finished is not None else None,
            labels=[item['label'] for item in records], mood=batch['mood'],
            usage=[{k: v for k, v in row.items() if k in {'id', 'status', 'attempt', 'model', 'provider', 'usage',
                'usage_known', 'duration_ms', 'finish_reason', 'error_code', 'error_type', 'http_status', 'labels_emitted'}}
                for row in usage])
        report['cases'].append(result)
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({k: result[k] for k in ('case', 'status', 'passed', 'elapsed_seconds', 'error')}, ensure_ascii=False), flush=True)
        return result['passed']

    single = [item for item in sample_messages(PEER) if item['sender_id'] == PEER]
    group = [item for item in sample_messages(GROUP) if item['sender_id'] != SELF]
    with patch.object(insights, 'source_for_account', lambda account: 'snapshot'), \
         patch.object(insight_live, 'self_username', lambda account: SELF), \
         patch.object(insight_label_stream, '_responses', observe_responses):
        try:
            for args in [('single_first', PEER, single[:1], []),
                         ('single_new_with_context', PEER, single[1:], single[:1]),
                         ('group_with_context', GROUP, group[3:], group[:3])]:
                if not await case(*args):
                    break
        finally:
            await service.stop()
    report['passed'] = len(report['cases']) == 3 and all(case['passed'] for case in report['cases'])
    report['requests'] = len(store.list('usage', ACCOUNT))
    return report


def main():
    from wechat_decrypt_tool.app_paths import get_output_dir
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings-db', type=Path, default=get_output_dir() / 'ai' / 'ai.sqlite3')
    parser.add_argument('--output', type=Path, required=True, help='New output directory inside this checkout tmp')
    parser.add_argument('--preflight', action='store_true', help='Read model settings only; no model request')
    args = parser.parse_args()
    output = args.output.resolve()
    if not output.is_relative_to((ROOT / 'tmp').resolve()) or output.exists():
        parser.error('Use a new output directory strictly inside this checkout tmp')
    output.mkdir(parents=True)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(output)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(output / 'output')
    os.environ['WECHAT_TOOL_ENABLE_CONSOLE_LOG'] = '0'
    logging.basicConfig(level=logging.WARNING, handlers=[logging.FileHandler(output / 'diagnostics.log', encoding='utf-8')])
    logging.getLogger('httpx').setLevel(logging.CRITICAL)
    logging.getLogger('httpcore').setLevel(logging.CRITICAL)
    started = time.monotonic()
    try:
        if not args.settings_db.is_file():
            raise AcceptanceSetupError('The AI settings database is missing')
        report = asyncio.run(run(args.settings_db, output, args.preflight))
    except Exception as error:
        path = output / 'report.json'
        report = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
        report.update(passed=False, error_type=type(error).__name__,
            reason=str(error) if isinstance(error, AcceptanceSetupError) else 'Acceptance failed; inspect isolated diagnostics safely')
    report['elapsed_seconds'] = round(time.monotonic() - started, 3)
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Report: ' + str(output / 'report.json'), flush=True)
    return 0 if report.get('passed') or report.get('preflight') == 'ready' else 1


if __name__ == '__main__':
    raise SystemExit(main())
