"""在既有真实全范围验收的同一截止时间重测最近 N 条，不调用模型。"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import time


async def main(args):
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool.ai.agent_tools import ChatTools
    reference = json.loads(args.reference.read_text(encoding='utf-8'))
    if not reference.get('passed') or reference.get('data') != 'existing_real_account':
        raise ValueError('仅接受已有通过的真实全范围核对作为对照')
    tools = ChatTools()
    started = time.monotonic()
    conversations = await tools.conversations(args.account)
    usernames = list(dict.fromkeys(c['username'] for c in conversations))
    prepared = time.monotonic()
    def checkpoint():
        if args.output.with_suffix('.STOP').exists():
            raise RuntimeError('用户停止真实读取性能核对')
    last = 0
    def progress(value):
        nonlocal last
        now = time.monotonic()
        if now - last >= 5 or value['completed_conversations'] == len(usernames):
            print(json.dumps(value), flush=True)
            last = now
    result = await tools.recent_set(args.account, usernames, 0, reference['cutoff'],
        reference['requested_count'], checkpoint, on_progress=progress)
    actual = [{k: m[k] for k in ('source', 'anchor', 'username', 'time', 'sender_id')} for m in result['messages']]
    output = {'data': 'existing_real_account', 'account': args.account, 'native_ui': False, 'remote_model_calls': 0,
              'cutoff': reference['cutoff'], 'reference': str(args.reference.resolve()),
              'conversations': len(usernames), 'actual': actual, 'expected': reference['expected'],
              'warning': result['warning'], 'selection': result.get('selection'),
              'catalog_seconds': prepared - started, 'selection_seconds': time.monotonic() - prepared,
              'elapsed_seconds': time.monotonic() - started,
              'passed': actual == reference['expected'] and not result['warning']
                        and len(usernames) == reference['conversations']}
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: output[k] for k in ('passed', 'selection', 'elapsed_seconds', 'selection_seconds')}, ensure_ascii=False))
    if not output['passed']:
        raise AssertionError('固定截止时间的真实最近 N 条与既有全范围核对不一致')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.resolve().is_relative_to(args.data_dir.resolve()):
        parser.error('结果须为应用数据目录外的新文件')
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data_dir.resolve() / 'output')
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    asyncio.run(main(args))
