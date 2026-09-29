"""固定资料、固定发现的离线调用成本对比；不连接真实模型或聊天账号。"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'src'))

from pytest import MonkeyPatch
from langchain_core.messages import AIMessage, message_to_dict
import tiktoken
from test_ai_deepagents import make_service, action, last_result
from test_ai_planned_work import prepare, make_plan
from test_ai_parallel_analysis import Data
from wechat_decrypt_tool.ai.deep_partition import fingerprint


async def sample(revision, directory):
    patch = MonkeyPatch()
    data = Data(2, text='双方约定：只有前置条件确认满足后才执行，目前没有履行记录。')
    service, client = make_service(directory, patch, tools=data)
    profile = service.store.get('profile', 'model')
    profile.update(context_window=131072, model_overrides={'context_window': 131072})
    service.store.put('profile', profile, id='model')
    try:
        gateway, scope, receipt, first, second = await prepare(service)
        planned = make_plan(service, gateway, scope, receipt, first, second)
        parent = gateway.guard()
        plan = service.planned_work.get(parent, planned['plan_handle'])
        calls = []
        def respond(messages):
            calls.append({'messages': [message_to_dict(m) for m in messages], 'tools': client.definitions})
            state = next(json.JSONDecoder().raw_decode(str(m.content).rsplit('当前执行状态（程序元数据）：', 1)[1].lstrip())[0]
                for m in messages if m.type == 'system' and '当前执行状态（程序元数据）：' in str(m.content))
            selected = state['scopes'][0]
            if selected['pending_page']:
                return action('commit_findings', {'scope_handle': selected['scope_handle'], 'page_id': selected['pending_page'],
                    'findings': [{'text': '第二项约定以前置条件为准，尚无履行记录。', 'sources': [second]}]})
            if not selected['read_complete']:
                return action('read_messages', {'scope_handle': selected['scope_handle']})
            return AIMessage(content='第二项约定以前置条件为准，尚无履行记录。[[' + second + ']]')
        client.next = respond
        if revision == 1:
            async def legacy_worker(parent, job, scope):
                await service.work_partition(parent, {**job, 'plan_version': 1}, scope)
            patch.setattr(service.planned_work, 'run_branch', legacy_worker)
        handle = service.planned_work.launch(parent, plan, plan['branches'][0])
        await asyncio.gather(*list(service.planned_work.tasks.values()))
        job = next(j for j in service.subtasks.page(parent['id'], 'account')['items'] if j['id'] == handle['task_handle'])
        assert job['status'] == 'completed', job
        findings = service.workspace.page('deep-child:' + fingerprint(handle['task_handle']), 1, 'finding')
        assert findings['total'] == 1
        encoding = tiktoken.get_encoding('cl100k_base')
        texts = [json.dumps(call, ensure_ascii=False, sort_keys=True) for call in calls]
        evidence = data.rows[1]['text']
        occurrences = sum(text.count(evidence) for text in texts)
        return {'model_calls': len(calls), 'input_tokens_cl100k_estimate': sum(len(encoding.encode(text)) for text in texts),
            'input_utf8_bytes': sum(len(text.encode()) for text in texts), 'evidence_input_occurrences': occurrences,
            'repeated_evidence_tokens_cl100k_estimate': max(0, occurrences - 1) * len(encoding.encode(evidence)),
            'effective_findings': findings['total']}
    finally:
        patch.undo()


async def main():
    with tempfile.TemporaryDirectory(prefix='planned-cost-') as directory:
        result = {'scenario': '同一条构造证据、同一条局部发现、单页分支；含完整工具定义输入',
            'measurement': 'cl100k_base 文本估算，非实际服务商 Token 或账单；未运行真实模型',
            'legacy': await sample(1, Path(directory) / 'legacy'),
            'planned': await sample(2, Path(directory) / 'planned')}
    target = ROOT / 'docs' / 'ai-planned-work-cost-2026-09-14.json'
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    asyncio.run(main())
