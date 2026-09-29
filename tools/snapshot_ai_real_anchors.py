"""从实时原消息库独立固定范围取定位元数据，不读取正文、不调用模型。"""
import argparse
import json
import os
from pathlib import Path
import time


def main(args):
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool.chat_helpers import _resolve_account_dir
    from wechat_decrypt_tool.chat_export_service import _resolve_account_db_storage_dir, _wcdb_exec_query
    from wechat_decrypt_tool.chat_realtime_reader import _resolve_tables, _locked_call, _quote_ident
    from wechat_decrypt_tool.wcdb_realtime import WCDB_REALTIME
    directory = _resolve_account_dir(args.account)
    connection = WCDB_REALTIME.ensure_connected(directory)
    tables, candidates, probed, errors = _resolve_tables(rt_conn=connection,
        db_storage_dir=_resolve_account_db_storage_dir(directory), username=args.username, exec_query=_wcdb_exec_query)
    if errors or not tables or not candidates or candidates != probed:
        raise ValueError('原库目录未完整探查，不能作为验收基线')
    sources, records = [], []
    def execute(path, sql):
        return _locked_call(connection, _wcdb_exec_query, connection.handle, kind='message', path=str(path), sql=sql)
    for path, table in tables:
        quoted = _quote_ident(table)
        where = f'create_time >= {args.start} AND create_time < {args.end}'
        before = int(execute(path, f'SELECT count(*) AS n FROM {quoted} WHERE {where}')[0]['n'])
        rows, cursor = [], 0
        while True:
            page = execute(path, f'SELECT local_id,server_id,create_time FROM {quoted} '
                                 f'WHERE {where} AND local_id > {cursor} ORDER BY local_id LIMIT 1000')
            if not page:
                break
            ids = [int(row['local_id']) for row in page]
            if ids != sorted(set(ids)) or ids[0] <= cursor:
                raise ValueError('原消息定位元数据分页未推进')
            rows.extend(page)
            cursor = ids[-1]
        after = int(execute(path, f'SELECT count(*) AS n FROM {quoted} WHERE {where}')[0]['n'])
        if before != len(rows) or after != len(rows):
            raise ValueError('固定区间在核对时发生变化或分页未完整返回，需要重新核对')
        records.extend({'anchor': f'{path.stem}:{table}:{int(row["local_id"])}',
                        'time': int(row['create_time']), 'server_id': str(row['server_id'])} for row in rows)
        sources.append({'database': path.name, 'table': table, 'count': len(rows)})
    result = {'data': 'existing_real_account', 'source': 'realtime_original_metadata', 'account': args.account,
              'username': args.username, 'start': args.start, 'end': args.end, 'captured_at': time.time(),
              'databases_probed': probed, 'remote_model_calls': 0, 'sources': sources, 'records': records,
              'count': len(records), 'passed': True}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'count': len(records), 'sources': sources, 'passed': True}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--username', required=True)
    parser.add_argument('--start', type=int, required=True)
    parser.add_argument('--end', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.output.resolve().is_relative_to(args.data_dir.resolve()) or not 0 <= args.start < args.end:
        parser.error('区间必须有效，输出须为应用数据目录外的新文件')
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(args.data_dir.resolve() / 'output')
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    main(args)
