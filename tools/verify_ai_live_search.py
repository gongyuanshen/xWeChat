"""使用现有真实账号核对实时关键词回查；不调用远程模型，不修改聊天原始数据。"""
import argparse
import asyncio
import json
import os
import time
from pathlib import Path


async def verify(args):
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool.ai.agent_tools import ChatTools
    from wechat_decrypt_tool.ai.agent_service import AgentService
    from wechat_decrypt_tool.ai.agent_schemas import AgentAction
    from wechat_decrypt_tool.ai.service import AIService
    from wechat_decrypt_tool.ai.storage import AIStore
    tools = ChatTools()
    scope = [c['username'] for c in await tools.conversations(args.account)]
    if args.username:
        if args.username not in scope:
            raise ValueError('指定会话不属于当前账号的可读取目录')
        scope = [args.username]
    output = args.output.resolve()
    if output.is_relative_to(args.data_dir.resolve()):
        raise ValueError('验证输出必须放在原应用数据目录之外')
    output.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output / 'checkpoint.json'
    # 使用生产运行的游标与事务，不另写一套验证专用续读逻辑；不配置或调用模型。
    store = AIStore(output / 'workspace')
    service = AgentService(AIService(store), tools=tools)
    run_id = 'real-live-search-verification'
    requested = {'account': args.account, 'query': args.query, 'username': args.username}
    if args.resume:
        state = json.loads(checkpoint_path.read_text(encoding='utf-8'))
        if state.get('format') != 2:
            raise ValueError('旧验证检查点没有生产任务游标，请使用新的输出目录开始验证')
        if state['requested'] != requested or not set(state['scope']).issubset(scope):
            raise ValueError('检查点与当前账号、问题或会话目录不一致')
        scope = state['scope']
        run = service.guard(run_id)
        if run['account'] != args.account or run['cutoff'] != state['cutoff']:
            raise ValueError('生产任务检查点与验证记录不一致')
    else:
        if checkpoint_path.exists():
            raise ValueError('输出目录已有检查点，请使用 --resume 或新的输出目录')
        cutoff = int(time.time())
        store.put('agent_run', {'id': run_id, 'version': 1, 'status': 'running',
                               'account': args.account, 'cutoff': cutoff, 'intent': {}})
        plan = await service.prepare_live_search(run_id, args.query, scope, 0, cutoff)
        if plan.get('warning'):
            raise RuntimeError(plan['warning'])
        if not plan.get('next_live_cursor'):
            raise ValueError('当前账号没有可验证的实时回查范围')
        state = {'format': 2, 'requested': requested, 'scope': scope, 'cutoff': cutoff,
                 'cursor': plan['next_live_cursor'], 'scanned': 0, 'pages': 0, 'matches': [], 'seconds': 0,
                 'coverage': {}}
    def save_checkpoint():
        temporary = output / 'checkpoint.next.json'
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, checkpoint_path)
    save_checkpoint()
    began = time.monotonic()
    previous_seconds = state['seconds']
    invocation_pages = 0
    replay_verified = 0
    while state['cursor']:
        action = AgentAction(action='search_messages', query=args.query, cursor=state['cursor'])
        page = await service.search_live(run_id, action, scope, 0, state['cutoff'])
        if page['has_more'] and (not page.get('next_live_cursor') or page['next_live_cursor'] == state['cursor']):
            raise RuntimeError('原消息游标未推进，保留检查点并停止')
        if args.verify_replay:
            # 换一个生产服务实例重放同一页，模拟结果提交后、调度进度保存前恢复。
            service = AgentService(AIService(AIStore(output / 'workspace')), tools=tools)
            replay = await service.search_live(run_id, action, scope, 0, state['cutoff'])
            if replay != page:
                raise AssertionError('服务重建后同一页的匹配原文或游标发生变化')
            replay_verified += 1
        state['coverage'] = page['realtime_coverage']
        state['scanned'] = page['realtime_coverage']['scanned']
        state['pages'] += 1
        invocation_pages += 1
        state['matches'].extend({k: m.get(k) for k in ('source', 'username', 'name', 'sender', 'sender_id', 'time', 'text')}
                                for m in page['messages'])
        state['cursor'] = page['next_live_cursor']
        state['seconds'] = previous_seconds + time.monotonic() - began
        # 仅保存匹配消息，未命中聊天正文不会写入验证报告。
        save_checkpoint()
        print(json.dumps({'pages': state['pages'], 'scanned': state['scanned'], 'matches': len(state['matches']),
                          'conversations_completed': state['coverage']['conversations_completed'],
                          'seconds': round(state['seconds'], 2)}), flush=True)
        if page['messages']:
            break
        if args.stop_after_pages and invocation_pages >= args.stop_after_pages:
            break
    report = {'data': 'real_realtime', 'scope': 'selected_conversation' if args.username else 'whole_account',
              'conversations': len(scope), 'remote_model_calls': 0, 'scanned': state['scanned'], 'pages': state['pages'],
              'matches': state['matches'], 'seconds': round(state['seconds'], 2),
              'recent_gap_complete': not state['cursor'], 'full_history_complete': False,
              'resumed': args.resume, 'production_cursor': True, 'replayed_pages_this_process': replay_verified,
              'paused': bool(state['cursor'] and not state['matches'])}
    (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.expected_source and not any(m['source'] == args.expected_source for m in state['matches']):
        raise AssertionError('本次真实数据回查未找到预期原消息，结果已保存')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--query', required=True)
    parser.add_argument('--username', default='')
    parser.add_argument('--expected-source', default='')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--stop-after-pages', type=int, default=0, help='本次最多读取多少页，然后保留检查点退出')
    parser.add_argument('--verify-replay', action='store_true', help='每页提交后重建生产服务并校验重放结果')
    args = parser.parse_args()
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    asyncio.run(verify(args))


if __name__ == '__main__':
    main()
