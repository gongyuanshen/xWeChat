"""隔离回放指定任务的上下文构建，不调用模型、不改变用户任务。"""
import argparse
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import SystemMessage, ToolMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from wechat_decrypt_tool.ai.storage import AIStore
from wechat_decrypt_tool.ai.service import AIService
from wechat_decrypt_tool.ai.providers import ModelService
from wechat_decrypt_tool.ai.agent_service import AgentService
from wechat_decrypt_tool.ai.deep_runtime import RuntimeEvents, SYSTEM
from wechat_decrypt_tool.ai.deep_context import DurableSummarization, context_tokens
from wechat_decrypt_tool.ai.deep_backend import TaskBackend
from wechat_decrypt_tool.ai.deep_model import DeepChatModel
from wechat_decrypt_tool.ai.agent_budget import input_limit


async def verify(source, run_id, output):
    output.mkdir(parents=True, exist_ok=False)
    original = sqlite3.connect((source / 'ai.sqlite3').as_uri() + '?mode=ro', uri=True)
    run = json.loads(original.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (run_id,)).fetchone()[0])
    thread = json.loads(original.execute("SELECT body FROM records WHERE kind='agent_thread' AND id=?", (run['thread_id'],)).fetchone()[0])
    store = AIStore(output)
    store.put('agent_run', {**run, 'status': 'running'})
    store.put('agent_thread', thread)
    models = ModelService(store)
    def forbidden(*args, **kwargs):
        raise AssertionError('隔离回放禁止访问模型服务')
    models.client = forbidden
    service = AgentService(AIService(store, models))
    service.profile = lambda current, vision=False: current.get('vision' if vision else 'profile', {})
    with store.connection() as target:
        for table in ('agent_material', 'agent_piece'):
            rows = original.execute(f'SELECT * FROM {table} WHERE run_id=?', (run_id,)).fetchall()
            if rows:
                target.executemany(f'INSERT INTO {table} VALUES({",".join("?" for _ in rows[0])})', rows)
    original.close()
    checkpoint_id = service.checkpoint_id(run, run['version'])
    checkpoint_path = output / 'deepagents_checkpoints.sqlite3'
    with sqlite3.connect((source / 'deepagents_checkpoints.sqlite3').as_uri() + '?mode=ro', uri=True) as origin, sqlite3.connect(checkpoint_path) as target:
        for table in ('checkpoints', 'writes'):
            target.execute(origin.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0])
            rows = origin.execute(f'SELECT * FROM {table} WHERE thread_id=?', (checkpoint_id,)).fetchall()
            if rows:
                target.executemany(f'INSERT INTO {table} VALUES({",".join("?" for _ in rows[0])})', rows)
    async with AsyncSqliteSaver.from_conn_string(str(checkpoint_path)) as saver:
        graph, gateway = service.graph(service.run(run_id), saver)
        snapshot = await graph.aget_state({'configurable': {'thread_id': checkpoint_id}})
    backend = TaskBackend(service, run_id, run['version'])
    model = DeepChatModel(service=service, run_id=run_id, input_version=run['version'])
    middleware = DurableSummarization(backend=backend, model=model, token_counter=context_tokens,
        trigger=('tokens', int(input_limit(run['profile']) * .8)), keep=('tokens', 1000))
    request = ModelRequest(model=model, messages=snapshot.values['messages'], state=snapshot.values,
        system_message=SystemMessage(content=SYSTEM), tools=gateway.tools())
    request = RuntimeEvents(service, gateway).prepare_model_request(request)
    before = super(DurableSummarization, middleware)._get_effective_messages(request)
    after = middleware._get_effective_messages(request)
    restored = 0
    for old, new in zip(before, after):
        if old == new:
            continue
        assert isinstance(old, ToolMessage) and old.tool_call_id == new.tool_call_id
        index = json.loads(backend.data(json.loads(new.content)['stored_tool_result'])['content'])
        full = ''.join(backend.data(chunk['path'])['content'] for chunk in index['chunks'])
        expected = old.content if isinstance(old.content, str) else json.dumps(old.content, ensure_ascii=False)
        assert full == expected
        restored += 1
    report = {'run_id': run_id, 'network_calls': 0, 'original_messages': len(snapshot.values['messages']),
        'effective_messages': len(before), 'externalized_tool_results_verified': restored,
        'before_conservative_units': context_tokens([request.system_message, *before], tools=request.tools),
        'after_conservative_units': context_tokens([request.system_message, *after], tools=request.tools),
        'input_capacity': input_limit(run['profile']), 'saved_original_count': len(service.run(run_id)['evidence']),
        'graph_pending_nodes': list(snapshot.next)}
    assert report['after_conservative_units'] < report['before_conservative_units']
    assert report['after_conservative_units'] < report['input_capacity'] * .8
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(verify(args.source_dir.resolve(), args.run_id, args.output_dir.resolve())), ensure_ascii=True))
