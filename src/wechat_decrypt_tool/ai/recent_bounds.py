"""批量查询原消息表的时间上界，供全账号最近 N 条安全剪枝。"""
import hashlib
import sqlite3


def query_bounds(paths, execute, usernames, start, end, checkpoint):
    """任一数据库或结果不完整便放弃剪枝；空值仅表示完整查询后范围为空。"""
    from ..chat_realtime_reader import _quote_ident
    expected = {'msg_' + hashlib.md5(u.encode()).hexdigest(): u for u in usernames}
    bounds = dict.fromkeys(usernames)
    if not paths:
        return None
    for path in paths:
        checkpoint()
        tables = execute(path, "SELECT name FROM sqlite_master WHERE type='table'")
        names = [str(row['name']) for row in tables]
        targets = [(name, expected[name.lower()]) for name in names if name.lower() in expected]
        # 小批查询避开 SQLite 复合 SELECT 数量限制，也给停止操作让出检查点。
        for offset in range(0, len(targets), 64):
            checkpoint()
            batch = targets[offset:offset + 64]
            statements = [f'SELECT {index} AS slot, MAX(create_time) AS latest FROM {_quote_ident(name)} '
                          f'WHERE create_time >= {int(start)} AND create_time < {int(end)}'
                          for index, (name, _) in enumerate(batch)]
            rows = execute(path, ' UNION ALL '.join(statements))
            if len(rows) != len(batch) or {int(row['slot']) for row in rows} != set(range(len(batch))):
                raise ValueError('原消息时间上界查询结果不完整')
            for row in rows:
                value = row['latest']
                if value is not None:
                    value = int(value)
                    if not start <= value < end:
                        raise ValueError('原消息时间上界超出固定读取区间')
                    username = batch[int(row['slot'])][1]
                    bounds[username] = max(bounds[username] if bounds[username] is not None else value, value)
    return bounds


def recent_bounds(account, usernames, start, end, checkpoint):
    """读取与消息流相同的真实渠道；不使用索引覆盖或会话预览时间判定无消息。"""
    from ..chat_helpers import _resolve_account_dir
    from ..account_source_policy import account_prefers_decrypted_snapshot
    from ..chat_export_service import _iter_message_db_paths, _resolve_account_db_storage_dir, _wcdb_exec_query
    from ..chat_realtime_reader import _message_db_paths, _locked_call
    from ..wcdb_realtime import WCDB_REALTIME
    # 停止检查不放进降级捕获中，避免吞掉用户取消。
    checkpoint()
    try:
        directory = _resolve_account_dir(account)
        if account_prefers_decrypted_snapshot(directory):
            paths = list(_iter_message_db_paths(directory))
            def execute(path, sql):
                with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
                    db.row_factory = sqlite3.Row
                    return [dict(row) for row in db.execute(sql)]
        else:
            connection = WCDB_REALTIME.ensure_connected(directory)
            paths = _message_db_paths(_resolve_account_db_storage_dir(directory), '')
            def execute(path, sql):
                return _locked_call(connection, _wcdb_exec_query, connection.handle,
                                    kind='message', path=str(path), sql=sql)
    except Exception:
        return None
    # 检查点异常必须原样传播，数据源不可用才退回逐会话读取。
    interrupted = False
    def check():
        nonlocal interrupted
        try:
            checkpoint()
        except BaseException:
            interrupted = True
            raise
    try:
        return query_bounds(paths, execute, usernames, start, end, check)
    except Exception:
        if interrupted:
            raise
        return None
