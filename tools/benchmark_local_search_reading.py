"""用合成 SQLite 聊天验证连续读取的扫描量、耗时及内存，不访问真实账号。"""
import argparse
from contextlib import ExitStack, closing
import gc
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


def main():
    import psutil
    from wechat_decrypt_tool import chat_export_service as export, chat_helpers, account_source_policy
    from wechat_decrypt_tool.ai.messages import iter_message_pages, read_messages
    from wechat_decrypt_tool.local_search.index import SemanticIndex

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--messages', type=int, default=300000)
    args = parser.parse_args()
    process = psutil.Process()
    with tempfile.TemporaryDirectory(prefix='wechat-read-benchmark-') as directory, ExitStack() as stack:
        root = Path(directory)
        path = root / 'message_0.db'
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript('''
                CREATE TABLE Name2Id(user_name TEXT);
                INSERT INTO Name2Id VALUES('self');
                CREATE TABLE Msg_test(local_id INTEGER PRIMARY KEY, server_id INTEGER, local_type INTEGER,
                    sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content TEXT, compress_content BLOB);
                CREATE INDEX message_time ON Msg_test(create_time,sort_seq,local_id);
            ''')
            db.executemany('INSERT INTO Msg_test VALUES(?,?,1,?,1,?,?,NULL)',
                ((i, i, i, 100 + i // 5, f'这是第{i}条合成聊天消息，项目进度正常。') for i in range(1, args.messages + 1)))
        stack.enter_context(patch.object(chat_helpers, '_resolve_account_dir', return_value=root))
        stack.enter_context(patch.object(chat_helpers, '_load_contact_rows', return_value={}))
        stack.enter_context(patch.object(account_source_policy, 'account_prefers_decrypted_snapshot', return_value=True))
        stack.enter_context(patch.object(export, '_iter_message_db_paths', return_value=[path]))
        stack.enter_context(patch.object(export, '_resolve_msg_table_name', return_value='Msg_test'))
        stack.enter_context(patch.object(export, 'resolve_account_self_username', return_value='self'))
        stack.enter_context(patch.object(export, 'resolve_account_self_rowid', return_value=(1, 'self')))
        original = export._iter_rows_for_conversation
        stats = {}

        def counted(**kwargs):
            stats['opens'] += 1
            rows = original(**kwargs)
            try:
                for row in rows:
                    stats['scanned'] += 1
                    yield row
            finally:
                rows.close()

        stack.enter_context(patch.object(export, '_iter_rows_for_conversation', counted))

        def benchmark(total, batch, legacy=False, write_index=False):
            gc.collect()
            stats.update(opens=0, scanned=0)
            initial = peak = process.memory_info().rss
            updates, read_count, saved, checksum = 0, 0, 0, 0
            first_progress = None
            began = time.perf_counter()
            index = SemanticIndex(root / f'index-{batch}.sqlite3') if write_index else None

            def progress(count):
                nonlocal peak, updates, first_progress
                updates += 1
                if first_progress is None: first_progress = time.perf_counter() - began
                peak = max(peak, process.memory_info().rss)

            def old_pages():
                offset = 0
                while True:
                    page = read_messages('synthetic', 'test', 0, 100 + (total - 1) // 5,
                        page_offset=offset, page_size=batch)
                    yield page
                    if not page['has_more']: break
                    offset += len(page['messages'])

            # 结束边界按同秒消息整体包含，输出实际条数，校验两种读取结果一致。
            pages = old_pages() if legacy else iter_message_pages('synthetic', 'test', 0, 100 + (total - 1) // 5,
                page_size=batch, on_progress=progress)
            for page in pages:
                messages = page['messages']
                read_count += len(messages)
                for m in messages:
                    checksum ^= int.from_bytes(hashlib.sha256(m['identity'].encode()).digest(), 'big')
                if index:
                    unchanged = index.existing('g', messages)
                    changed = index.affected_messages('g', [m for m in messages if m['source'] not in unchanged])
                    chunks = [{'text': '\n'.join(m['text'] for m in changed[i:i+10]),
                               'sources': [m['source'] for m in changed[i:i+10]], 'username': 'test'}
                              for i in range(0, len(changed), 10)]
                    # 固定向量隔离数据库吞吐；此项不测 GPU 模型推理速度。
                    index.commit('g', changed, chunks, [[1.] + [0.] * 511] * len(chunks),
                        {'id': 'benchmark', 'offset': read_count})
                    saved += len(changed)
                peak = max(peak, process.memory_info().rss)
            result = {'mode': 'offset' if legacy else 'stream', 'batch': batch, 'messages': read_count,
                'seconds': round(time.perf_counter() - began, 3), **stats,
                'peak_rss_mb': round(peak / 1024**2, 1), 'rss_increase_mb': round((peak-initial) / 1024**2, 1),
                'progress_updates': updates, 'first_progress_seconds': round(first_progress, 3) if first_progress is not None else None,
                'indexed_messages': saved, 'checksum': hex(checksum)}
            if index:
                with index.connection() as db:
                    assert db.execute('SELECT count(*) FROM messages').fetchone()[0] == read_count
                assert index.progress('benchmark')['offset'] == read_count
            print(json.dumps(result), flush=True)
            return result

        small = min(3400, args.messages)
        before = benchmark(small, 100, legacy=True)
        after = benchmark(small, 1000)
        assert before['messages'] == after['messages'] and before['checksum'] == after['checksum']
        full = benchmark(args.messages + 1, 1000, write_index=True)
        assert full['messages'] == args.messages
        assert full['scanned'] == args.messages and full['opens'] == 1


if __name__ == '__main__':
    main()
