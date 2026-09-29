"""在隔离任务库中复用已配置模型实测；密钥仅在内存中，不复制到结果。"""
import argparse
import asyncio
import json
import os
import sqlite3
import time
from pathlib import Path


async def main(args):
    data = args.data.resolve()
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(data)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(data / 'output')
    if args.native_core_dir:
        os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
        from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
        configure_native_core_entrypoint()
    from wechat_decrypt_tool.ai.storage import AIStore
    from wechat_decrypt_tool.ai.service import AIService
    from wechat_decrypt_tool.ai.providers import ModelService, public_profile
    from wechat_decrypt_tool.ai.agent_service import AgentService
    with sqlite3.connect((data / 'output/ai/ai.sqlite3').as_uri() + '?mode=ro', uri=True) as db:
        defaults = json.loads(db.execute("SELECT body FROM records WHERE kind='defaults' AND id='global'").fetchone()[0])
        profile = json.loads(db.execute("SELECT body FROM records WHERE kind='profile' AND id=?", (args.profile or defaults['text'],)).fetchone()[0])
        accounts = [r[0] for r in db.execute("SELECT DISTINCT account FROM records WHERE kind='agent_thread' AND account<>''")]
    if getattr(args, 'api_key_env', ''):
        key = os.environ.get(args.api_key_env, '').strip()
        if not key:
            raise ValueError('指定的测试密钥环境变量为空')
        profile['api_key'] = key
    account = args.account or accounts[0]
    args.output.mkdir(parents=True, exist_ok=True)
    store = AIStore(args.output / 'state')
    store.put('profile', public_profile(profile), id=profile['id'])
    store.put('defaults', {'text': profile['id']}, id='global')
    models = ModelService(store)
    resolve = models.resolve
    def configured(*values, **kwargs):
        result = resolve(*values, **kwargs)
        if result['id'] == profile['id']:
            result['api_key'] = profile.get('api_key', '')
        if args.compatible:
            result['model_metadata'] = {**result.get('model_metadata', {}), 'tool_call': False}
        return result
    models.resolve = configured
    service = AgentService(AIService(store, models))
    previous_results = args.output / 'results.json'
    results = json.loads(previous_results.read_text(encoding='utf-8')) if (args.resume_run or args.followup_run) and previous_results.exists() else []
    print(json.dumps({'model': profile['model'], 'protocol': profile['protocol'], 'samples': args.samples}, ensure_ascii=False), flush=True)
    for index in range(args.samples):
        started = time.monotonic()
        if args.direct_control:
            from langchain_core.messages import HumanMessage
            from wechat_decrypt_tool.ai.agent_budget import output_limit
            from wechat_decrypt_tool.ai.model_execution import model_policy
            from langsmith import tracing_context
            response, first = None, None
            async with models.semaphore:
                with model_policy(auxiliary=False), tracing_context(enabled=False):
                    client = models.client(configured(profile['id']))
                    options = {'max_tokens': min(output_limit(configured(profile['id'])), 8192)}
                    if profile['protocol'] == 'openai':
                        options['stream_usage'] = True
                    async for chunk in client.astream([HumanMessage(content=args.question)], config={'callbacks': []}, **options):
                        if first is None and chunk.content:
                            first = time.monotonic() - started
                        response = chunk if response is None else response + chunk
            results.append({'kind': 'direct_control', 'seconds': time.monotonic() - started, 'first_text_seconds': first,
                'usage': response.usage_metadata, 'answer': str(response.content), 'model': profile['model']})
            previous_results.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({k: v for k, v in results[-1].items() if k != 'answer'}, ensure_ascii=False), flush=True)
            continue
        if args.resume_run:
            if args.revalidate:
                service.update(args.resume_run, status='interrupted', error='新增验收校验重新验证已保存正文', finished_at=None)
            run = await service.resume(args.resume_run, account)
        else:
            thread = service.thread(service.run(args.followup_run, account)['thread_id'], account) if args.followup_run else await service.create_thread(account, args.conversation, 'DeepAgents 隔离验收')
            run = await service.submit(thread['id'], account, {'text': args.question, 'request_id': f'real:{time.time_ns()}:{index}'})
        worker = service.workers[run['id']]
        supplemented = False
        while not worker.done():
            await asyncio.wait([worker], timeout=min(10, args.supplement_after) if args.supplement and not supplemented else 10)
            current = service.run(run['id'])
            if args.supplement and not supplemented and not worker.done() and current['used']['models'] and time.monotonic() - started >= args.supplement_after:
                previous_version = current['version']
                updated = await service.submit(current['thread_id'], account, {'text': args.supplement, 'request_id': f'supplement:{time.time_ns()}'})
                assert updated['id'] == run['id'] and updated['version'] == previous_version + 1
                worker = service.workers[run['id']]
                supplemented = True
                print(json.dumps({'supplemented': True, 'previous_version': previous_version, 'version': updated['version']}), flush=True)
            print(json.dumps({'sample': index, 'status': current['status'], 'stage': current.get('stage'),
                'read': current.get('read_count'), 'calls': current['used']['models']}, ensure_ascii=False), flush=True)
            if (args.output / 'STOP').exists() or time.monotonic() - started > args.timeout:
                await service.stop_run(run['id'], account)
        await worker
        result = service.public_run(run['id'], account)
        audits = [u for u in store.list('usage', account) if u.get('task_id') == run['id']]
        results.append({'run_id': run['id'], 'status': result['status'], 'version': result['version'], 'supplemented': supplemented, 'seconds': time.monotonic() - started,
            'usage': result['usage'], 'tools': result['used']['tools'], 'sources': result['source_count'],
            'error': result['error'], 'answer': result['answer'],
            'timing': [{k: u.get(k) for k in ('id', 'dispatch_ms', 'queue_ms', 'request_ms', 'first_token_ms', 'duration_ms', 'status', 'error_code')} for u in audits]})
        (args.output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({k: v for k, v in results[-1].items() if k != 'answer'}, ensure_ascii=False), flush=True)
        if result['status'] != 'completed':
            break
    await service.stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=Path(os.environ['APPDATA']) / 'wechat-data-analysis-desktop')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profile', default='')
    parser.add_argument('--api-key-env', default='', help='仅从进程环境读取临时测试密钥，不写入配置或结果')
    parser.add_argument('--account', default='')
    parser.add_argument('--conversation', default='')
    parser.add_argument('--native-core-dir', type=Path)
    parser.add_argument('--resume-run', default='')
    parser.add_argument('--followup-run', default='', help='在既有真实验收任务的 AI 对话中追问，保留之前的结果记录')
    parser.add_argument('--revalidate', action='store_true', help='在隔离库中重新验证既有图的最终正文，保留历史验收结果')
    parser.add_argument('--compatible', action='store_true', help='用真实模型验证 JSON 兼容协议')
    parser.add_argument('--direct-control', action='store_true', help='同配置直接调用供应商的性能对照，不启动 Agent')
    parser.add_argument('--question', default='你好')
    parser.add_argument('--samples', type=int, default=1)
    parser.add_argument('--timeout', type=float, default=600)
    parser.add_argument('--supplement', default='', help='运行中提交补充要求，验证取消旧输入版本')
    parser.add_argument('--supplement-after', type=float, default=2)
    asyncio.run(main(parser.parse_args()))
