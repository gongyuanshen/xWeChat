"""使用设置页已保存的服务和现有真实账号运行正式 AI 链路；记录为程序验收。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import uuid


async def verify(args):
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool.ai.service import AIService
    from wechat_decrypt_tool.ai.agent_service import AgentService
    ai = AIService()
    profile = ai.models.resolve(args.profile_id)
    if not profile.get('api_key'):
        raise ValueError('请先在应用设置页保存可用服务，不接收命令行密钥')
    active = [r for r in ai.store.list('agent_run', args.account) if r['status'] in ('running', 'queued')]
    if active:
        raise RuntimeError('真实账号仍有 AI 任务运行，请先等待完成')
    agent = AgentService(ai)
    question = args.question.read_text(encoding='utf-8-sig').strip()
    thread = await agent.create_thread(args.account, '', '真实数据验收 · ' + question[:32])
    run = await agent.submit(thread['id'], args.account, {
        'text': question, 'request_id': uuid.uuid4().hex, 'profile_id': profile['id'], 'model_id': profile['model'],
    })
    identity = {'run_id': run['id'], 'thread_id': thread['id'], 'account': args.account,
                'data': 'existing_real_account', 'native_ui': False, 'model': profile['model']}
    (args.output / 'identity.json').write_text(json.dumps(identity, indent=2), encoding='utf-8')
    print(json.dumps(identity), flush=True)
    worker = agent.workers[run['id']]
    try:
        while not worker.done():
            await asyncio.wait([worker], timeout=5)
            # 由拥有工作协程的进程停止，避免让另一个后端进程争写运行状态。
            if (args.output / 'STOP').exists() and not worker.done():
                await agent.stop_run(run['id'], args.account)
            current = agent.run(run['id'])
            print(json.dumps({k: current.get(k) for k in ('status', 'stage', 'read_count', 'used')}, ensure_ascii=False), flush=True)
        await worker
    finally:
        if not worker.done():
            await agent.stop_run(run['id'], args.account)
        result = agent.public_run(run['id'], args.account)
        (args.output / 'run.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        usage = [u for u in ai.store.list('usage', args.account) if u.get('task_id') == run['id']]
        (args.output / 'usage.json').write_text(json.dumps(usage, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({**identity, 'status': result['status'], 'calls': len(usage)}), flush=True)
    if result['status'] != 'completed':
        raise AssertionError('真实运行未完成，详细结果已保存')
    if args.expected_source and args.expected_source not in result['answer']:
        raise AssertionError('最终回答没有引用预期原消息，结果已保存')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--profile-id', default='')
    parser.add_argument('--question', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--expected-source', default='')
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(args.data_dir.resolve()):
        parser.error('验收报告应放在应用数据目录之外')
    if not (args.data_dir / 'output/databases' / args.account).is_dir():
        parser.error('真实账号数据目录不存在')
    args.output.mkdir(parents=True, exist_ok=False)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data_dir.resolve() / 'output')
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    asyncio.run(verify(args))
