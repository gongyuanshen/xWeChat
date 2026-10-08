"""用现有选定模型和隔离的虚构聊天验证独立 Agent，不写入用户配置或聊天。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time

from verify_deepagents_matrix import MatrixTools


class ObservedClient:
    """只记录实际模型输入是否包含越界样本文字，不保存请求或凭据。"""
    def __init__(self, client, forbidden, observations):
        self.client, self.forbidden, self.observations = client, forbidden, observations

    def bind_tools(self, *args, **kwargs):
        return ObservedClient(self.client.bind_tools(*args, **kwargs), self.forbidden, self.observations)

    def observe(self, messages):
        content = '\n'.join(str(message.content) for message in messages)
        self.observations.append({'out_of_scope_text': any(text in content for text in self.forbidden)})

    async def astream(self, messages, **kwargs):
        self.observe(messages)
        async for chunk in self.client.astream(messages, **kwargs):
            yield chunk

    async def ainvoke(self, messages, **kwargs):
        self.observe(messages)
        return await self.client.ainvoke(messages, **kwargs)


async def main(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(output)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(output / 'output')
    from wechat_decrypt_tool.ai.storage import AIStore
    from wechat_decrypt_tool.ai.service import AIService
    from wechat_decrypt_tool.ai.providers import ModelService, public_profile
    from wechat_decrypt_tool.ai.agent_service import AgentService
    from wechat_decrypt_tool.ai.agent_references import valid_answer_references
    from wechat_decrypt_tool.ai.model_catalog import ModelCatalog

    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        row = db.execute("SELECT body FROM records WHERE kind='selected_model' AND id='global'").fetchone()
        if row is None:
            raise ValueError('尚未选择 Agent 模型，请先在现有 AI 服务中选择模型')
        choice = json.loads(row[0])
        if not choice.get('profile_id'):
            raise ValueError('现有模型选择无效，验收不会自动改用其他服务')
        row = db.execute("SELECT body FROM records WHERE kind='profile' AND id=?", (choice['profile_id'],)).fetchone()
        if row is None:
            raise ValueError('所选 AI 服务已不存在')
        profile = json.loads(row[0])
        capabilities = []
        for model in {profile['model'], choice['model_id']}:
            key = ModelCatalog.upstream_key(profile, model)
            row = db.execute("SELECT body FROM records WHERE kind='model_capabilities' AND id=?", (key,)).fetchone()
            if row is not None:
                capabilities.append(json.loads(row[0]))

    store = AIStore(output / 'state')
    store.put('profile', public_profile(profile), id=profile['id'])
    store.put('selected_model', choice, id='global')
    for capability in capabilities:
        store.put('model_capabilities', capability, id=capability['id'])
    catalog = args.database.resolve().parent / 'models-dev.json'
    if catalog.exists():
        shutil.copy2(catalog, store.root / catalog.name)
    models = ModelService(store)
    original_resolve, original_client = models.resolve, models.client
    observations, forbidden = [], []

    def resolve(*values, **kwargs):
        resolved = original_resolve(*values, **kwargs)
        if resolved['id'] == profile['id']:
            resolved['api_key'] = profile.get('api_key', '')
        return resolved

    models.resolve = resolve
    models.client = lambda config: ObservedClient(original_client(config), forbidden, observations)
    tools = MatrixTools()
    service = AgentService(AIService(store, models), tools)
    (output / 'fixture.json').write_text(json.dumps(tools.rows, ensure_ascii=False, indent=2), encoding='utf-8')
    results, selected_thread = [], None
    cases = [
        ('account_search', None, '请查找当前账号2026年9月1日至9日的聊天：项目发布和周末活动各有哪些改期，最后确认的安排是什么？分别说明并引用原文。'),
        ('selected_timeline', ['trip'], '根据2026年9月1日至9日的记录，梳理两个人的周末活动计划如何变化，区分提议、确认、取消和完成，引用原文。'),
        ('selected_followup', ['trip'], '最终聚餐费用结清了吗？请给出聊天依据。'),
    ]
    print(json.dumps({'model': choice.get('model_id'), 'provider': profile.get('name'),
        'data': 'controlled fictional chats', 'output': str(output)}, ensure_ascii=False), flush=True)
    try:
        for name, scope, question in cases:
            observations.clear()
            forbidden[:] = [m['text'] for m in tools.rows if scope and m['username'] not in scope]
            if name == 'selected_followup':
                thread = selected_thread
            else:
                thread = await service.create_thread('standalone-acceptance', '', '新的对话', origin='agent', chat_scope=scope)
                if scope:
                    selected_thread = thread
            started = time.monotonic()
            run = await service.submit(thread['id'], 'standalone-acceptance',
                {'text': question, 'request_id': 'acceptance:' + str(time.time_ns()), **choice})
            worker = service.workers[run['id']]
            while not worker.done():
                await asyncio.wait([worker], timeout=10)
                current = service.run(run['id'])
                print(json.dumps({'case': name, 'status': current['status'], 'calls': current['used']['models'],
                    'seconds': round(time.monotonic() - started)}, ensure_ascii=False), flush=True)
                if time.monotonic() - started > args.timeout or (output / 'STOP').exists():
                    await service.stop_run(run['id'], 'standalone-acceptance')
            await worker
            public = service.public_run(run['id'], 'standalone-acceptance')
            internal = service.run(run['id'])
            evidence = internal.get('evidence', {})
            observed_chats = {message['username'] for message in evidence.values()}
            checks = {
                'completed': public['status'] == 'completed',
                'selected_model_used': internal['profile']['model'] == choice['model_id'],
                'scope_snapshot': internal.get('chat_scope') == scope,
                'real_requests_observed': bool(observations),
                'no_other_chat_in_model_input': not any(item['out_of_scope_text'] for item in observations),
                'message_citations_present': bool(re.search(r'\[\[[a-f0-9]{24}\]\]', public['answer'])),
                'references_exist': valid_answer_references(public['answer'], evidence, internal.get('references', {})),
                'expected_chat_evidence': observed_chats == (set(scope) if scope else {'trip', 'project'}),
            }
            if name == 'selected_followup':
                checks['followup_same_thread'] = internal['thread_id'] == selected_thread['id'] and bool(internal.get('previous_run_id'))
                checks['settlement_supported'] = '120' in public['answer'] and ('结清' in public['answer'] or '结算完成' in public['answer'])
            entry = {'case': name, 'model': internal['profile']['model'], 'thread_id': thread['id'],
                'run_id': run['id'], 'status': public['status'], 'chat_scope': scope, 'checks': checks,
                'passed': all(checks.values()), 'seconds': round(time.monotonic() - started, 2),
                'usage': public['usage'], 'sources': len(evidence), 'answer': public['answer'], 'error': public['error']}
            results.append(entry)
            (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({key: value for key, value in entry.items() if key != 'answer'}, ensure_ascii=False), flush=True)
            if not entry['passed']:
                raise AssertionError('真实模型验收未通过：' + ', '.join(key for key, value in checks.items() if not value))
    finally:
        await service.stop()
    if profile.get('api_key'):
        secret = profile['api_key'].encode()
        assert all(secret not in file.read_bytes() for file in output.rglob('*') if file.is_file()), '验收文件意外包含凭据'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True, help='现有 AI 配置数据库，仅只读访问')
    parser.add_argument('--output', type=Path, required=True, help='隔离验收输出目录')
    parser.add_argument('--timeout', type=float, default=300, help='每个受控用例的等待秒数')
    asyncio.run(main(parser.parse_args()))
