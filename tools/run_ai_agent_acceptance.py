"""用设置页已保存的配置执行正式 Agent 链路；只用于隔离样例，不启动桌面或修改模型设置。"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import uuid


async def main(args):
    from wechat_decrypt_tool.ai.service import AIService
    from wechat_decrypt_tool.ai.agent_service import AgentService

    source = args.runtime / 'output/databases/wxid_ai_acceptance/message_0.db'
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if original_hash != args.expected_sha256:
        raise ValueError('隔离样例原库与指定基线不一致')
    ai = AIService()
    with ai.store.connection() as db:
        active = db.execute("SELECT count(*) FROM records WHERE kind='agent_run' AND json_extract(body,'$.status') IN ('queued','running')").fetchone()[0]
    if active:
        raise RuntimeError('该验收目录仍有运行任务，请先等待完成')
    # 正常解析 UI 保存的服务，不接受或写入 API 密钥参数。
    profile = ai.models.resolve(args.profile_id)
    if 'deepseek' not in profile.get('base_url', '').lower():
        raise ValueError('本次要求使用已配置的 DeepSeek 服务')
    agent = AgentService(ai)
    thread = await agent.create_thread('wxid_ai_acceptance', '', '新的对话')
    run = await agent.submit(thread['id'], 'wxid_ai_acceptance', {
        'text': args.question.read_text(encoding='utf-8-sig'), 'request_id': uuid.uuid4().hex,
        'profile_id': args.profile_id, 'model_id': args.model_id, 'reasoning_effort': args.reasoning_effort,
    })
    identity = {'run_id': run['id'], 'thread_id': thread['id'], 'mode': 'production_agent_cli_real_model', 'native_ui': False}
    (args.output / 'identity.json').write_text(json.dumps(identity, indent=2), encoding='utf-8')
    print(json.dumps(identity), flush=True)
    worker = agent.workers[run['id']]
    previous = None
    while not worker.done():
        done, _ = await asyncio.wait([worker], timeout=15)
        current = agent.run(run['id'])
        progress = {k: current.get(k) for k in ('status', 'stage', 'used')}
        progress['analyzed'] = current.get('analysis', {}).get('analyzed', sum(c.get('analyzed', 0) for c in current.get('analysis', {}).get('coverage', [])))
        if progress != previous:
            print(json.dumps(progress, ensure_ascii=False), flush=True)
            previous = progress
    await worker
    result = agent.public_run(run['id'], 'wxid_ai_acceptance')
    (args.output / 'run.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    usage = [u for u in ai.store.list('usage', 'wxid_ai_acceptance') if u.get('task_id') == run['id']]
    (args.output / 'usage.json').write_text(json.dumps(usage, ensure_ascii=False, indent=2), encoding='utf-8')
    final_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    (args.output / 'source-check.json').write_text(json.dumps({'before': original_hash, 'after': final_hash, 'unchanged': final_hash == original_hash}), encoding='utf-8')
    assert final_hash == original_hash, '原库发生变化'
    print(json.dumps({**identity, 'status': result['status'], 'calls': len(usage)}), flush=True)
    assert result['status'] == 'completed', result.get('error')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--question', type=Path, required=True)
    parser.add_argument('--profile-id', required=True)
    parser.add_argument('--model-id', required=True)
    parser.add_argument('--reasoning-effort', default='low')
    parser.add_argument('--expected-sha256', required=True)
    args = parser.parse_args()
    args.runtime = args.runtime.resolve()
    if not (args.runtime / 'output/ai/ai.sqlite3').is_file():
        parser.error('需要已通过设置页配置的独立验收目录')
    args.output.mkdir(parents=True, exist_ok=False)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.runtime)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.runtime / 'output')
    asyncio.run(main(args))
