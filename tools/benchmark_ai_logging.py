"""沿用十万条合成 SQLite 消息，比较关闭日志与当前文件 handler 的耗时和体积。"""
import argparse
from contextlib import redirect_stdout
import io
import json
import logging
import os
from datetime import datetime
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--messages', type=int, default=100000)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    import benchmark_local_search_reading as benchmark
    from wechat_decrypt_tool.ai import diagnostics
    from wechat_decrypt_tool.logging_config import RecreatingFileHandler
    from wechat_decrypt_tool.logging_config import WeChatLogger
    WeChatLogger._initialized = True
    # 先导入现有数据访问模块，初始化开销不混入读写比较。
    from wechat_decrypt_tool import chat_export_service, chat_helpers, account_source_policy
    logger = logging.Logger(diagnostics.logger.name, logging.INFO)
    results = []
    with tempfile.TemporaryDirectory(prefix='wda-ai-log-benchmark-') as folder:
        path = Path(folder)/'logs'/datetime.now().strftime('%Y/%m/%d/%d_wechat_tool.log')
        handler = RecreatingFileHandler(path, encoding='utf-8', daily=True)
        handler.setFormatter(logging.Formatter('%(asctime)s | %(levelname)s | %(name)s | %(message)s'))
        logger.addHandler(handler)
        try:
            for enabled in (False, True):
                logger.disabled = not enabled
                captured = io.StringIO()
                with patch.dict(os.environ,{'WECHAT_TOOL_OUTPUT_DIR':folder}), patch.object(diagnostics,'logger',logger), patch.object(sys,'argv',['benchmark','--messages',str(args.messages)]), redirect_stdout(captured):
                    benchmark.main()
                rows = [json.loads(line) for line in captured.getvalue().splitlines() if line.startswith('{')]
                results.append({'logging':enabled,'runs':rows})
            handler.flush()
            log_bytes = path.stat().st_size
            events = sum(1 for _ in path.open(encoding='utf-8'))
        finally:
            handler.close()
    before, after = [result['runs'][-1]['seconds'] for result in results]
    report = {'messages':args.messages,'results':results,'log_bytes':log_bytes,'events':events,
              'duration_change_percent':round((after-before)/before*100,2),
              'scope':'合成 SQLite 读取、分片与固定向量事务提交；不包含网络模型及 GPU 推理'}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))


if __name__ == '__main__':
    main()
