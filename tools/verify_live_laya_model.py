"""Exercise real CPU Laya auto-labels on fixed artificial chats and saved portraits.

All stores/reports stay under the supplied checkout tmp directory. Models must
already be installed there; no downloads, private chats, API settings, or calls.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import sys
import time
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from verify_chat_insights_model import ACCOUNT, PEER, GROUP, SELF, artificial_reader, sample_messages
from verify_laya_insights_model import NoApi
from wechat_decrypt_tool.ai import insights, insight_live
from wechat_decrypt_tool.ai.insight_local_models import LocalInsightModels
from wechat_decrypt_tool.ai.insight_local_fine import predict_message
from wechat_decrypt_tool.ai.laya_runtime import LayaRuntime, LayaContextOverflow, prepare
from wechat_decrypt_tool.ai.service import AIService
from wechat_decrypt_tool.ai.storage import AIStore


def ref(item):
    return dict(identity=item['identity'], time=item['time'],
                fingerprint=hashlib.sha256(item['media']['content'].encode()).hexdigest())


async def run(root):
    output = root / ('live-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    store = AIStore(output / 'ai')
    previous = AIStore(root / 'ai')
    selected = set()
    for task in previous.list('insight_task', ACCOUNT):
        subject = (task['username'], task['member_username'])
        if (task['engine'] == 'laya' and task['status'] == 'completed' and task['portrait']
                and subject not in selected):
            store.put('insight_task', task, account=ACCOUNT)
            selected.add(subject)
    if (PEER, '') not in selected or not any(chat == GROUP and member for chat, member in selected):
        raise ValueError('Run verify_laya_insights_model.py first; real synthetic sender portraits are required')
    service = insights.InsightService(AIService(store, NoApi()), reader=artificial_reader)
    service.local_models = LocalInsightModels(root / 'models', previous)
    model_dir = service.local_models.require_ready()
    report = dict(synthetic_only=True, engine='laya', device='cpu', remote_calls=0,
        quality_claim=False, cases=[], calls=[])
    original_predict = LayaRuntime.predict

    def measured_predict(runtime, state, questions):
        record = dict(state=state, question_ids=list(questions))
        report['calls'].append(record)
        try:
            answers = original_predict(runtime, state, questions)
            items, _ = prepare(runtime._tokenizer, runtime._special, runtime._config, state, questions)
            record['input_tokens'] = {key: len(item['ids']) for key, item in zip(questions, items)}
            return answers
        except Exception as exc:
            record['error'] = dict(type=type(exc).__name__, message=str(exc))
            raise

    began = time.monotonic()
    with patch.object(insight_live, 'self_username', lambda account: SELF), \
         patch.object(LayaRuntime, 'predict', measured_predict), \
         patch('httpx.AsyncClient.request', side_effect=AssertionError('Network forbidden')), \
         patch('httpx.Client.request', side_effect=AssertionError('Network forbidden')):
        try:
            for name, username in [('single', PEER), ('group', GROUP)]:
                scope = dict(account=ACCOUNT, username=username, engine='laya')
                rows = [row for row in sample_messages(username) if row['sender_id'] != SELF]
                scope_value, _ = service.live.scope(scope)
                priors = service.live.portraits(scope_value, rows)
                case = dict(case=name, portraits=priors, stages=[])
                report['cases'].append(case)
                await service.live.settings(scope | dict(enabled=True))
                stages = [('visible', rows[:2], []), ('new', rows[3:], rows[:2]),
                          ('history', rows[2:3], rows[:2])]
                for stage, targets, context in stages:
                    started = time.monotonic()
                    batch = service.live.create_batch(scope | dict(messages=list(map(ref, targets)),
                                                                   context=list(map(ref, context))))
                    await service.live.jobs[batch['id']]
                    result = service.live.get_batch(batch['id'], ACCOUNT)
                    checks = dict(completed=result['status'] == 'completed',
                        exact_sources={item['source'] for item in result['items']} == {item['source'] for item in targets},
                        prior_used=bool(result['context_task_ids']),
                        four_chars=all(item['label'][key] is None or len(item['label'][key]) <= 4
                            for item in result['items'] for key in ('emotion', 'intent')))
                    case['stages'].append(dict(stage=stage, checks=checks, passed=all(checks.values()),
                        elapsed_seconds=round(time.monotonic() - started, 3), result=result))
                    print(json.dumps(dict(case=name, stage=stage, status=result['status'],
                        analyzed=result['progress']['analyzed'], error=result['error']), ensure_ascii=False), flush=True)
                    if result['status'] != 'completed':
                        break
                restored = service.live.state(scope | dict(messages=list(map(ref, rows))))
                call_count = len(report['calls'])
                await service.live.settings(scope | dict(enabled=False))
                await service.live.settings(scope | dict(enabled=True))
                toggled = service.live.state(scope | dict(messages=list(map(ref, rows))))
                case['restore_checks'] = dict(all_labels=len(restored['items']) == len(rows),
                    latest_mood_time=restored['mood'] is not None and restored['mood']['time'] == rows[-1]['time'],
                    toggle_reuses_labels=len(toggled['items']) == len(restored['items']),
                    toggle_does_not_infer=len(report['calls']) == call_count)
                case['passed'] = all(s['passed'] for s in case['stages']) and all(case['restore_checks'].values())
                (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
            # Explicit preflight boundary: the full artificial prior must be rejected, not omitted.
            runtime = LayaRuntime(model_dir)
            item = sample_messages(PEER)[1] | dict(target=True, quote_context='')
            try:
                predict_message(runtime, item, [], '人工长期画像：' + '背景材料。' * 2000, private_chat=True)
            except LayaContextOverflow as exc:
                report['overflow'] = dict(passed=True, type=type(exc).__name__, message=str(exc),
                    tokens=exc.tokens, limit=exc.limit)
            else:
                report['overflow'] = dict(passed=False, error='Oversize prior was not rejected')
            finally:
                runtime.close()
        finally:
            await service.stop()
    report.update(passed=all(case['passed'] for case in report['cases']) and report['overflow']['passed'],
                  elapsed_seconds=round(time.monotonic() - began, 3))
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(str(output / 'report.json'), flush=True)
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_relative_to((ROOT / 'tmp').resolve()):
        parser.error('Verification root must be inside this checkout tmp directory')
    raise SystemExit(0 if asyncio.run(run(root)) else 1)
