from __future__ import annotations
from .diagnostics import event as diagnostic_event, failures
import logging

import hashlib
import heapq
import sqlite3
import time
from collections import deque


def message_identity(server_id, anchor, timestamp):
    """各读取入口共用消息身份；没有服务端编号时保留数据库定位与时间。"""
    try:
        server_id = int(server_id or 0)
    except (TypeError, ValueError):
        server_id = 0
    if server_id:
        return f's:{server_id}'
    return f'l:{anchor}:{timestamp}' if len(anchor.split(':')) == 3 else anchor


def read_messages(account, username, start, end, count=None, require_realtime=False, checkpoint=None, page_offset=None, page_size=50, max_batch_bytes=None, message_weight=None):
    """在固定时间窗口读取，复用导出分页器，避免聊天 UI 的 offset 在新增消息时漂移。"""
    pages = iter_message_pages(account, username, start, end, count=count,
        require_realtime=require_realtime, checkpoint=checkpoint, page_offset=page_offset, page_size=page_size,
        max_batch_chars=float('inf'), max_batch_bytes=max_batch_bytes, message_weight=message_weight)
    try:
        return next(pages)
    finally:
        pages.close()


def iter_message_pages(account, username, start, end, count=None, require_realtime=False, checkpoint=None, page_offset=0, page_size=100, on_progress=None, max_batch_chars=128000, cursor=None, emit_cursor=False, max_batch_bytes=None, message_weight=None, count_key=None):
    """同一会话只打开一次消息流；新断点从最后提交的时间读取并按身份去重。

    迭代和关闭必须在同一线程进行，以保证 SQLite 连接及底层游标的生命周期。
    page_offset=None 保留原来的整段读取行为，供总结和 Agent 使用。
    """
    batch_size = page_size() if callable(page_size) else page_size
    byte_limit = max_batch_bytes() if callable(max_batch_bytes) else max_batch_bytes
    if byte_limit is not None and byte_limit < 2:
        raise ValueError('每页资料容量必须至少容纳空数组')
    if byte_limit is not None and message_weight is None:
        from .agent_budget import size
        message_weight = lambda m: size({k: v for k, v in m.items() if k != 'media'})
    if cursor is not None:
        start = max(start or 0, cursor['time'])
    cursor_ids = set(cursor.get('ids', [])) if cursor else set()
    saved_cursor = cursor
    track_cursor = emit_cursor or cursor is not None
    if page_offset is not None and batch_size <= 0:
        raise ValueError("每页消息数量必须大于零")
    from ..chat_helpers import (_resolve_account_dir, _resource_lookup_chat_id, _load_contact_rows,
                                _pick_display_name, _load_group_nickname_map_from_contact_db)
    from ..account_source_policy import account_prefers_decrypted_snapshot
    from ..chat_export_service import _iter_rows_for_conversation, _parse_message_for_export
    from ..routers.chat import _extract_at_usernames_from_source
    from ..wcdb_realtime import WCDB_REALTIME
    account_dir = _resolve_account_dir(account)
    names = _load_contact_rows(account_dir / "contact.db", [username])
    name = _pick_display_name(names.get(username), username)
    source, connection, warning = "decrypted", None, ""
    if account_prefers_decrypted_snapshot(account_dir):
        if require_realtime:
            raise ValueError("当前账号是导入快照，实时关注提醒不可用")
    else:
        try:
            connection = WCDB_REALTIME.ensure_connected(account_dir)
            source = "realtime"
        except Exception as error:
            diagnostic_event('messages.source.fallback', level=logging.WARNING, error=error, account=account, username=username, data_source='decrypted')
            if require_realtime:
                raise ValueError("实时消息源不可用，请检查微信、数据库密钥及实时连接") from None
            warning = "实时源不可用，本次读取已解密快照"
    resource = account_dir / "message_resource.db"
    resource_conn = sqlite3.connect(f"file:{resource.as_posix()}?mode=ro", uri=True) if resource.exists() else None
    output = deque(maxlen=count) if count else []
    rows = None
    seen_db = None
    output_chars = 0
    output_bytes = 2
    committed_offset = page_offset or 0
    sender_names = {}

    def resolve_senders(usernames):
        # 与聊天页一致：所属群的名片优先，联系人名作为别名保留；身份始终使用微信 ID。
        missing = list(dict.fromkeys(u for u in usernames if u and u not in sender_names))
        if not missing:
            return
        if len(sender_names) + len(missing) > 1000:
            sender_names.clear()
            missing = list(dict.fromkeys(u for u in usernames if u))
        contacts = _load_contact_rows(account_dir / 'contact.db', missing)
        cards = _load_group_nickname_map_from_contact_db(account_dir / 'contact.db', username, missing)
        for sender in missing:
            contact_name = _pick_display_name(contacts.get(sender), sender)
            display = cards.get(sender) or contact_name
            sender_names[sender] = (display, list(dict.fromkeys(n for n in (display, contact_name) if n and n != sender)))

    def display_sender(message):
        sender = message['sender_id']
        display, aliases = sender_names.get(sender, (sender, []))
        message['sender'] = display
        if len(aliases) > 1:
            message['sender_aliases'] = aliases
    last_progress = time.monotonic()
    page_started = time.monotonic()
    diagnostic_event('messages.page.started', account=account, username=username, offset=page_offset, start=start, end=end, data_source=source)

    def progress(completed, force=False):
        nonlocal last_progress
        now = time.monotonic()
        if on_progress and (force or now - last_progress >= 0.25):
            on_progress(completed)
            last_progress = now
    def row_identity(row):
        return message_identity(row.server_id, f'{row.db_stem}:{row.table_name}:{row.local_id}', row.create_time)

    def result(has_more):
        nonlocal saved_cursor, committed_offset
        messages = sorted(output, key=lambda m: (m["time"], m["identity"]))
        if track_cursor:
            saved_cursor = advance_cursor(messages, saved_cursor)
        if byte_limit is None:
            resolve_senders([m['sender_id'] for m in messages])
            for msg in messages:
                display_sender(msg)
        committed_offset += len(messages)
        diagnostic_event('messages.page.finished', account=account, username=username, count=len(messages), has_more=has_more,
                         data_source=source, duration_ms=(time.monotonic()-page_started)*1000,
                         material_budget=byte_limit, bytes=output_bytes if byte_limit is not None else None,
                         reason_code='oversized_message' if byte_limit is not None and output_bytes > byte_limit else 'page_ready')
        return {"username": username, "name": name, "messages": messages, "source": source, "warning": warning,
                **({'has_more': has_more, 'next_offset': committed_offset if has_more else None} if page_offset is not None else {}),
                **({'cursor': saved_cursor} if track_cursor else {})}

    try:
        chat_id = _resource_lookup_chat_id(resource_conn, username) if resource_conn else None
        def read_rows(window_start, window_end):
            return _iter_rows_for_conversation(account_dir=account_dir, conv_username=username,
                start_time=window_start, end_time=window_end, source=source, rt_conn=connection, checkpoint=checkpoint)

        if count:
            # 从最近一天向前扩展窗口，避免“最近 100 条”遍历多年全部消息。
            selected_rows, window_end, span = [], end, 86400
            window_seen = set()
            last_window_check = 0
            lower_bound = start or 0
            while len(selected_rows) < count and window_end >= lower_bound:
                window_start = max(lower_bound, window_end - span + 1)
                batch = [] if count_key else deque(maxlen=count)
                for row in read_rows(window_start, window_end):
                    if checkpoint and time.monotonic() - last_window_check > 0.1:
                        checkpoint()
                        last_window_check = time.monotonic()
                    identity = row_identity(row)
                    if identity not in window_seen:
                        window_seen.add(identity)
                        if count_key:
                            entry = (count_key(row), row)
                            if len(batch) < count:
                                heapq.heappush(batch, entry)
                            elif entry[0] > batch[0][0]:
                                heapq.heapreplace(batch, entry)
                        else:
                            batch.append(row)
                selected_rows = ([entry[1] for entry in sorted(batch, key=lambda entry: entry[0])]
                                 if count_key else list(batch)) + selected_rows
                window_end = window_start - 1
                span *= 2
            rows = selected_rows[-count:]
        else:
            rows = read_rows(start, end)
        seen = set()
        if page_offset is not None:
            # 空文件名让 SQLite 使用自动清理的磁盘临时库；固定缓存，避免去重集合随历史增长。
            seen_db = sqlite3.connect('')
            seen_db.execute('PRAGMA cache_size=-512')
            seen_db.execute('PRAGMA journal_mode=OFF')
            seen_db.execute('CREATE TABLE seen (identity TEXT PRIMARY KEY) WITHOUT ROWID')
        last_check = 0
        page_seen = (page_offset or 0) if cursor is not None else 0
        for row in rows:
            if checkpoint and time.monotonic() - last_check > 0.1:
                checkpoint()
                last_check = time.monotonic()
            # server ID 优先，跨数据源切换仍保持同一条消息的身份。
            identity = row_identity(row)
            # 同秒仍可能有未提交或新到达的消息，不能简单从下一秒开始。
            if cursor is not None and (row.create_time < cursor['time'] or
                    (row.create_time == cursor['time'] and identity in cursor_ids)):
                continue
            if seen_db is not None:
                if not seen_db.execute('INSERT OR IGNORE INTO seen VALUES(?)', (identity,)).rowcount:
                    continue
            else:
                if identity in seen:
                    continue
                seen.add(identity)
            if page_offset is not None:
                page_seen += 1
                if cursor is None and page_seen <= page_offset:
                    # 兼容旧 offset 断点，首次恢复时同时迁移为时间与身份断点。
                    if track_cursor:
                        if saved_cursor is None or row.create_time > saved_cursor['time']:
                            saved_cursor = {'time': row.create_time, 'ids': []}
                        if row.create_time == saved_cursor['time']:
                            saved_cursor['ids'].append(identity)
                    progress(page_seen)
                    continue
                if len(output) >= batch_size or (output and output_chars >= max_batch_chars):
                    # 下一条唯一消息留在当前迭代器中，续页不重新查询或扫描前缀。
                    progress(page_seen - 1, force=True)
                    yield result(True)
                    page_started = time.monotonic()
                    diagnostic_event('messages.page.started', account=account, username=username, offset=page_seen-1, data_source=source)
                    output = deque(maxlen=count) if count else []
                    output_chars = 0
                    output_bytes = 2
                    batch_size = page_size() if callable(page_size) else page_size
                    byte_limit = max_batch_bytes() if callable(max_batch_bytes) else max_batch_bytes
                    if batch_size <= 0 or (max_batch_bytes is not None and (byte_limit is None or byte_limit < 2)):
                        raise ValueError('动态分页预算无效')
                    if checkpoint:
                        checkpoint()
            msg = _parse_message_for_export(row=row, conv_username=username, is_group=username.endswith("@chatroom"),
                resource_conn=resource_conn, resource_chat_id=chat_id)
            msg['atUsernames'] = _extract_at_usernames_from_source(getattr(row, 'msg_source', None))
            if msg.get("renderType") == "voice" and not msg.get("voiceTranscript"):
                cache = account_dir / "_cache" / "voice_transcripts.sqlite3"
                if cache.exists() and row.server_id:
                    try:
                        with sqlite3.connect(f"file:{cache.as_posix()}?mode=ro", uri=True) as db:
                            transcript = db.execute("SELECT text FROM transcript WHERE server_id=? AND trim(text)<>'' LIMIT 1", (row.server_id,)).fetchone()
                            if transcript:
                                msg["voiceTranscript"] = transcript[0]
                    except sqlite3.Error as error:
                        failures.report('messages.voice_cache', error)
            source_id = hashlib.sha256(f"{account}:{username}:{identity}".encode()).hexdigest()[:24]
            text = "\n".join(str(msg.get(k) or "") for k in ("content", "title", "quoteTitle", "quoteContent", "voiceTranscript") if msg.get(k))
            value = {"source": source_id, "identity": identity, "anchor": msg["id"], "username": username,
                "time": row.create_time, "sender": msg.get("senderUsername") or row.sender_username,
                "text": text, "kind": msg.get("renderType", "text"), "media": msg}
            value['sender_id'] = value['sender']
            if byte_limit is not None:
                # 显示名也是模型输入，必须先解析再计算体积；缓存有界。
                resolve_senders([value['sender_id']])
                display_sender(value)
                weight = message_weight(value)
                if page_offset is not None and output and output_bytes + 2 + weight > byte_limit:
                    # 已解析的下一条留在生成器栈上，提交后继续装入，不能丢掉或重复消费。
                    progress(page_seen - 1, force=True)
                    yield result(True)
                    page_started = time.monotonic()
                    output = deque(maxlen=count) if count else []
                    output_chars, output_bytes = 0, 2
                    batch_size = page_size() if callable(page_size) else page_size
                    byte_limit = max_batch_bytes() if callable(max_batch_bytes) else max_batch_bytes
                    if byte_limit is None or byte_limit < 2 or batch_size <= 0:
                        raise ValueError('动态分页预算无效')
                    if checkpoint:
                        checkpoint()
                output_bytes += weight + (2 if output else 0)
            # 单条超长消息仍完整返回本地；模型侧按来源与字符位置分片。
            output_chars += len(text)
            output.append(value)
            progress(page_seen)
        progress(page_seen, force=True)
        yield result(False)
    except Exception as error:
        diagnostic_event('messages.page.failed', level=logging.ERROR, error=error, account=account, username=username)
        raise
    finally:
        try:
            if hasattr(rows, 'close'):
                rows.close()
        finally:
            if seen_db is not None:
                seen_db.close()
            if resource_conn:
                resource_conn.close()


def filter_after(messages, cursor):
    timestamp = int(cursor.get("time", 0))
    ids = set(cursor.get("ids", []))
    return [m for m in messages if m["time"] > timestamp or (m["time"] == timestamp and m["identity"] not in ids)]


def advance_cursor(messages, previous=None):
    previous = previous or {"time": 0, "ids": []}
    if not messages:
        return previous
    timestamp = max(previous["time"], max(m["time"] for m in messages))
    ids = set(previous["ids"]) if timestamp == previous["time"] else set()
    ids.update(m["identity"] for m in messages if m["time"] == timestamp)
    return {"time": timestamp, "ids": sorted(ids)}
