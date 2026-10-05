"""只读分析真实会话时间读取的开销，不记录聊天内容或调用模型。"""
import argparse
import asyncio
import cProfile
import io
import json
import os
from pathlib import Path
import pstats
import time


async def main(args):
    cutoff = args.cutoff or int(time.time())
    records = []
    profiler = cProfile.Profile()
    # 工作线程内启用分析器，不能只测到主线程等待时间。
    from wechat_decrypt_tool.ai.messages import iter_message_pages
    def read():
        profiler.enable()
        try:
            for username in args.username:
                count = 0
                identities = []
                for page in iter_message_pages(args.account, username, cutoff - 3600, cutoff - 1):
                    count += len(page['messages'])
                    identities.extend(m['source'] for m in page['messages'])
                records.append({'username': username, 'sources': identities})
                print(json.dumps({'messages': count}), flush=True)
        finally:
            profiler.disable()
    await asyncio.to_thread(read)
    profiler.dump_stats(str(args.output.with_suffix('.prof')))
    text = io.StringIO()
    pstats.Stats(profiler, stream=text).strip_dirs().sort_stats('cumulative').print_stats(45)
    args.output.write_text(text.getvalue(), encoding='utf-8')
    args.output.with_suffix('.json').write_text(json.dumps({'cutoff': cutoff,
        'records': records}, indent=2), encoding='utf-8')
    print(text.getvalue())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--username', action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cutoff', type=int)
    args = parser.parse_args()
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data_dir.resolve() / 'output')
    asyncio.run(main(args))
