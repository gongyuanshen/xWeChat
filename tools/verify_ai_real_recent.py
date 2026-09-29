"""真实全账号最近 N 条：再完整读取候选边界之后的消息作独立范围核对。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import time


async def verify(args):
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool.ai.agent_tools import ChatTools
    tools = ChatTools()
    def checkpoint():
        if (args.output / 'STOP').exists():
            raise RuntimeError('用户停止真实最近 N 条核对')
    def progress(value):
        value['elapsed_seconds'] = round(time.monotonic() - started, 2)
        (args.output / 'progress.json').write_text(json.dumps(value), encoding='utf-8')
        print(json.dumps(value), flush=True)
    def metadata(m):
        # 全账号可能命中文件传输助手；报告不写聊天正文、图片和密钥。
        return {k: m[k] for k in ('source', 'anchor', 'username', 'time', 'sender_id')}
    started = time.monotonic()
    cutoff = int(time.time())
    conversations = await tools.conversations(args.account)
    usernames = list(dict.fromkeys(c['username'] for c in conversations))
    selected = await tools.recent_set(args.account, usernames, 0, cutoff, args.count, checkpoint,
        on_progress=lambda value: progress({'phase': 'selection', **value}))
    actual = [metadata(m) for m in selected['messages']]
    (args.output / 'selected.json').write_text(json.dumps({'cutoff': cutoff, 'items': actual,
        'warning': selected['warning'], 'conversations': len(usernames)}, indent=2), encoding='utf-8')
    # 若不足 N 条，必须核对全部历史；否则早于最老候选的消息不可能进入前 N。
    boundary = actual[0]['time'] if len(actual) == args.count else 0
    independent = {}
    warnings = [selected['warning']] if selected['warning'] else []
    for index, username in enumerate(usernames):
        state = None
        while True:
            checkpoint()
            page = await tools.time_window(args.account, username, boundary, cutoff, 65536,
                                           state=state, checkpoint=checkpoint)
            for message in page.get('originals', page['messages']):
                independent[message['source']] = metadata(message)
            if page.get('warning'):
                warnings.append(page['warning'])
            if not page['has_more']:
                break
            state = page['next_state']
        progress({'phase': 'boundary_verification', 'completed_conversations': index + 1,
                  'total_conversations': len(usernames), 'messages': len(independent)})
    expected = sorted(independent.values(), key=lambda m: (m['time'], m['source']))[-args.count:]
    report = {'data': 'existing_real_account', 'native_ui': False, 'remote_model_calls': 0,
              'cutoff': cutoff, 'boundary': boundary, 'conversations': len(usernames),
              'requested_count': args.count, 'actual': actual, 'expected': expected,
              'warnings': list(dict.fromkeys(warnings)), 'elapsed_seconds': time.monotonic() - started,
              'passed': actual == expected and not warnings}
    (args.output / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'count': len(actual), 'conversations': len(usernames)}), flush=True)
    if not report['passed']:
        raise AssertionError('真实全账号最近 N 条与完整边界读取不一致，或存在读取警告')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--count', type=int, default=5)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.count < 1 or args.output.resolve().is_relative_to(args.data_dir.resolve()):
        parser.error('条数须为正数，验收结果须在应用数据目录之外')
    args.output.mkdir(parents=True, exist_ok=False)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data_dir.resolve() / 'output')
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    asyncio.run(verify(args))
