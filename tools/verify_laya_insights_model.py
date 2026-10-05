"""Verify real local Laya against artificial conversations, with API calls forbidden."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from verify_chat_insights_model import ACCOUNT, START, END, PEER, GROUP, ALEX, artificial_reader, checks_for
from wechat_decrypt_tool.ai import insights
from wechat_decrypt_tool.ai.insight_local_models import LocalInsightModels
from wechat_decrypt_tool.ai.service import AIService
from wechat_decrypt_tool.ai.storage import AIStore


class NoApi:
    def resolve_turn(self, *args, **kwargs):
        raise AssertionError('Offline verification may not resolve API configuration')
    async def invoke(self, *args, **kwargs):
        raise AssertionError('Offline verification may not call an API model')


async def run(root):
    store = AIStore(root / 'ai')
    service = insights.InsightService(AIService(store, NoApi()), reader=artificial_reader)
    service.local_models = LocalInsightModels(root / 'models', store)
    service.local_models.require_ready()
    output = root / ('insights-' + time.strftime('%Y%m%d-%H%M%S') + '.json')
    report = dict(synthetic_only=True, engine='laya', device='cpu', remote_model_calls=0, cases=[])
    began = time.monotonic()
    with patch('httpx.AsyncClient.request', side_effect=AssertionError('Network forbidden during offline inference')), \
         patch('httpx.Client.request', side_effect=AssertionError('Network forbidden during offline inference')):
        try:
            for name, username, member in [('single', PEER, ''), ('group', GROUP, ''), ('group_member', GROUP, ALEX)]:
                started = time.monotonic()
                task = service.create_task(dict(account=ACCOUNT, username=username, member_username=member,
                    start=START, end=END, engine='laya'))
                print(json.dumps(dict(case=name, task_id=task['id'], status='starting')), flush=True)
                await service.jobs[task['id']]
                task = service.get_task(task['id'], ACCOUNT)
                labels = service.messages(task['id'], ACCOUNT, limit=100)['items']
                checks = checks_for(task, labels, username, member)
                case = dict(case=name, status=task['status'], checks=checks, passed=all(checks.values()),
                    elapsed_seconds=round(time.monotonic() - started, 3), error=task['error'],
                    model=task['model'], coverage=task['coverage'], portrait=task['portrait'], labels=labels)
                report['cases'].append(case)
                output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                print(json.dumps({k: case[k] for k in ('case', 'status', 'passed', 'elapsed_seconds', 'error')}, ensure_ascii=False), flush=True)
        finally:
            await service.stop()
    report.update(passed=all(case['passed'] for case in report['cases']), elapsed_seconds=round(time.monotonic()-began, 3))
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(str(output), flush=True)
    return report['passed']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='Isolated root populated by verify_laya_download.py')
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_relative_to((ROOT / 'tmp').resolve()):
        parser.error('Verification root must be inside this checkout tmp directory')
    raise SystemExit(0 if asyncio.run(run(root)) else 1)
