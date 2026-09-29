"""只读工具适配器：所有数据均通过已有聊天服务获取。"""
from .diagnostics import observed, executor_call
from .agent_budget import MAX_READ_MESSAGES, size, message_payload
from .messages import message_identity
import asyncio
import hashlib
import threading
from functools import wraps
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from collections import OrderedDict
from starlette.requests import Request


def foreground_read(function):
    """前台读取与结果整理期间让索引让步；不为单独工具调用创建后台服务。"""
    @wraps(function)
    async def wrapped(*args, **kwargs):
        from ..local_search.service import prioritize_foreground
        with prioritize_foreground():
            return await function(*args, **kwargs)
    return wrapped


def local_request():
    return Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': [],
                    'scheme': 'http', 'server': ('127.0.0.1', 10392), 'client': ('127.0.0.1', 0), 'query_string': b''})


def normalize(account, username, raw, name=''):
    # 全局命中必须使用消息本身的会话身份，不能把空筛选条件写入来源。
    username = raw.get('username') or raw.get('conversationUsername') or username
    if not username:
        return None
    anchor = str(raw.get('id') or raw.get('anchorId') or '')
    if not anchor:
        return None
    timestamp = int(raw.get('createTime') or raw.get('create_time') or 0)
    identity = message_identity(raw.get('serverIdStr') or raw.get('serverId') or raw.get('server_id'), anchor, timestamp)
    return {'source': hashlib.sha256(f'{account}:{username}:{identity}'.encode()).hexdigest()[:24], 'identity': identity,
            'anchor': anchor, 'username': username, 'name': name or raw.get('conversationName') or username,
            'time': timestamp,
            'sender': raw.get('senderDisplayName') or raw.get('senderName') or raw.get('senderUsername') or '',
            'sender_id': raw.get('senderUsername') or '',
            'kind': raw.get('renderType', 'text'),
            'text': raw['aiText'] if isinstance(raw.get('aiText'), str) else
                    '\n'.join(str(raw.get(k) or '') for k in ('content', 'title', 'quoteTitle', 'quoteContent', 'voiceTranscript') if raw.get(k)),
            'match_methods': [m for m in raw.get('matchMethods', []) if m in ('keyword', 'semantic')],
            'media': raw}


def group_people_directory(account, usernames, people):
    """群名片只属于对应群；以完整联系人目录核对 ID，不从单个发言样本推断唯一性。"""
    from ..chat_helpers import _resolve_account_dir, _load_group_nickname_map_from_contact_db
    path = _resolve_account_dir(account) / 'contact.db'
    by_id = {p['username']: p for p in people if not p.get('conversation')}
    result = []
    for group in sorted(set(u for u in usernames if u.endswith('@chatroom'))):
        cards = _load_group_nickname_map_from_contact_db(path, group, list(by_id))
        for username, name in cards.items():
            person = by_id[username]
            result.append({**person, 'name': name, 'conversation': group,
                           'aliases': list(dict.fromkeys([name, person['name'], *person.get('aliases', [])]))})
    return result


class ChatTools:
    supports_time_prefetch = True

    def __init__(self):
        self._time_pages = OrderedDict()
        self._time_pages_lock = threading.Lock()

    def release_read_session(self, session):
        with self._time_pages_lock:
            for key in list(self._time_pages):
                if key[0].split(':')[0] == session.split(':')[0]:
                    self._time_pages.pop(key)

    async def group_people(self, account, usernames, people):
        return await asyncio.to_thread(group_people_directory, account, usernames, people)

    async def live_search_segments(self, account, usernames, start, end):
        """固定本次查询的会话顺序，先查最近活跃会话；仅连接只读实时源。"""
        def inspect():
            import sqlite3
            from ..chat_helpers import _resolve_account_dir
            from ..chat_search_index import get_chat_search_index_db_path
            from ..account_source_policy import account_prefers_decrypted_snapshot
            from ..wcdb_realtime import WCDB_REALTIME, get_sessions
            from ..chat_export_service import _normalize_realtime_session_rows
            directory = _resolve_account_dir(account)
            if account_prefers_decrypted_snapshot(directory):
                return {'segments': []}
            try:
                connection = WCDB_REALTIME.ensure_connected(directory)
                with connection.lock:
                    sessions = _normalize_realtime_session_rows(get_sessions(connection.handle))
            except Exception as error:
                from .diagnostics import failures
                failures.report('agent.live_search.prepare', error)
                return {'segments': [], 'warning': '实时数据暂不可用，搜索仍基于现有索引，最新消息可能未覆盖。'}
            recent = {row['username']: int(row.get('sort_timestamp') or 0) for row in sessions}
            path = get_chat_search_index_db_path(directory)
            latest = {}
            try:
                with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
                    for username in usernames:
                        row = db.execute('SELECT create_time FROM message_meta WHERE username=? ORDER BY create_time DESC LIMIT 1', (username,)).fetchone()
                        if row:
                            latest[username] = int(row[0])
            except sqlite3.Error:
                pass
            segments = []
            for username in sorted(set(usernames), key=lambda u: (-recent.get(u, 0), u)):
                low = max(start, latest.get(username, start))
                # 会话元数据仅用于排序；不能因缺少时间或最后可见消息较旧跳过可读历史。
                if low < end:
                    segments.append({'username': username, 'start': low, 'end': end})
            return {'segments': segments}
        return await asyncio.to_thread(inspect)

    async def live_search_page(self, account, segment, cursor, query, sender, checkpoint):
        def read():
            from .messages import iter_message_pages
            from ..chat_helpers import _make_search_tokens, _match_tokens
            stream = iter_message_pages(account, segment['username'], segment['start'], segment['end'] - 1,
                require_realtime=True, checkpoint=checkpoint, page_offset=0, page_size=200,
                cursor=cursor, emit_cursor=True, max_batch_bytes=1048576, message_weight=lambda m: size(message_payload(m)))
            try:
                page = next(stream)
            finally:
                stream.close()
            tokens = _make_search_tokens(query)
            matches = []
            for message in page['messages']:
                identity = message.get('sender_id') or (message.get('media') or {}).get('senderUsername') or message['sender']
                if (not sender or identity == sender) and _match_tokens(message['text'], tokens):
                    matches.append({**message, 'sender_id': identity, 'name': page.get('name') or segment['username'],
                                    'match_methods': ['keyword']})
            return {'messages': matches, 'scanned': len(page['messages']), 'has_more': page.get('has_more', False),
                    'cursor': page.get('cursor')}
        return await asyncio.to_thread(read)

    async def search_freshness(self, account, username, start, end):
        """索引中的最新消息只用于提示回查，不能视为完整覆盖截止时间。"""
        def inspect():
            import sqlite3
            from ..chat_helpers import _resolve_account_dir
            from ..chat_search_index import get_chat_search_index_db_path
            from ..account_source_policy import account_prefers_decrypted_snapshot
            directory = _resolve_account_dir(account)
            result = {'kind': 'snapshot', 'latest_realtime_included': False}
            if not username or account_prefers_decrypted_snapshot(directory):
                return result
            path = get_chat_search_index_db_path(directory)
            try:
                with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
                    row = db.execute('SELECT create_time FROM message_meta WHERE username=? ORDER BY create_time DESC LIMIT 1',
                                     (username,)).fetchone()
            except sqlite3.Error:
                return result
            if row:
                latest = int(row[0])
                result['latest_indexed_message_time'] = latest
                if latest < end:
                    # 重叠读取最后一秒，避免同秒新增消息被跳过；稳定身份负责去重。
                    result['realtime_read_hint'] = {'username': username, 'start': max(start, latest), 'end': end}
            return result
        return await asyncio.to_thread(inspect)

    @foreground_read
    async def recent_set(self, account, usernames, start, end, count, checkpoint, sender=None, on_progress=None):
        """程序精确选择跨会话合计最近 N 条，堆内存最多保留 N 条。"""
        import heapq
        from .messages import iter_message_pages
        def collect():
            heap, warnings = [], []
            from .recent_bounds import recent_bounds
            bounds = recent_bounds(account, usernames, start, end, checkpoint)
            ordered = sorted(usernames, key=lambda u: -(bounds[u] if bounds[u] is not None else -1)) if bounds is not None else usernames
            pruned = 0
            for index, username in enumerate(ordered):
                checkpoint()
                # 已有 N 条后，更早消息不可能入选；边界秒仍完整保留参与比较。
                lower = max(start, heap[0][0]) if len(heap) == count else start
                if bounds is not None and (bounds[username] is None or bounds[username] < lower):
                    pruned += 1
                    if on_progress:
                        on_progress({'completed_conversations': index + 1, 'total_conversations': len(usernames),
                                     'selected': len(heap), 'boundary': heap[0][0] if heap else None})
                    continue
                def selection_key(row):
                    identity = message_identity(row.server_id, f'{row.db_stem}:{row.table_name}:{row.local_id}', row.create_time)
                    source = hashlib.sha256(f'{account}:{username}:{identity}'.encode()).hexdigest()[:24]
                    return row.create_time, source
                # 指定发言人时必须先筛人再取 N；不能在各群前 N 条上事后过滤。
                stream = iter_message_pages(account, username, lower, end - 1, count=None if sender else count,
                                             page_offset=0, checkpoint=checkpoint, count_key=selection_key)
                try:
                    for page in stream:
                        if page.get('warning'):
                            warnings.append(page['warning'])
                        for m in page['messages']:
                            m['name'] = page.get('name', username)
                            if sender and (m.get('sender_id') or m.get('media', {}).get('senderUsername') or m.get('sender')) != sender:
                                continue
                            entry = (m['time'], m['source'], m)
                            if len(heap) < count:
                                heapq.heappush(heap, entry)
                            elif entry[:2] > heap[0][:2]:
                                heapq.heapreplace(heap, entry)
                finally:
                    stream.close()
                if on_progress:
                    on_progress({'completed_conversations': index + 1, 'total_conversations': len(usernames),
                                 'selected': len(heap), 'boundary': heap[0][0] if heap else None})
            return {'messages': [x[2] for x in sorted(heap)], 'warning': '；'.join(dict.fromkeys(warnings)),
                    'selection': {'bounds_available': bounds is not None, 'pruned_conversations': pruned,
                                  'read_conversations': len(usernames) - pruned}}
        return await asyncio.to_thread(collect)

    async def time_window(self, account, username, start, end, capacity, state=None, checkpoint=None, *, session=None, probe_budget=None):
        from .agent_reading import read_window
        from .messages import iter_message_pages, filter_after
        key = (session, account, username, start, end)
        def page(lo, hi, budget, cursor):
            if checkpoint:
                checkpoint()
            # 缓存仅属于当前任务版本，查询范围和账号也进入键；其他任务和
            # 用户发起的新查询必须重新读取。数据库页与模型页分别控制大小。
            if session:
                with self._time_pages_lock:
                    cached = self._time_pages.get(key)
                    if cached:
                        self._time_pages.move_to_end(key)
                if cached and cached['lo'] <= lo and cached['hi'] == hi:
                    floor = cached['cursor'] or {'time': cached['lo'], 'ids': []}
                    current = cursor or {'time': lo, 'ids': []}
                    forward = current['time'] > floor['time'] or (
                        current['time'] == floor['time'] and set(floor['ids']) <= set(current['ids']))
                    if forward:
                        rows = cached['page']['messages']
                        rows = filter_after(rows, current)
                        if rows or not cached['page'].get('has_more'):
                            return {**cached['page'], 'messages': rows}
            fetch_budget = min(512 * 1024, max(128 * 1024, budget * 8)) if session else budget
            stream = iter_message_pages(account, username, lo, hi - 1, page_offset=0,
                page_size=MAX_READ_MESSAGES, cursor=cursor, emit_cursor=True,
                max_batch_bytes=fetch_budget, message_weight=lambda m: size(message_payload(m)), checkpoint=checkpoint)
            try:
                page = next(stream)
                # 已按正文预算、稳定游标取到的有序前缀，可直接消费，无需反复二分重查。
                page['budgeted_page'] = True
                for message in page.get('messages', []):
                    message.setdefault('name', page.get('name') or username)
                if session and not page.get('warning'):
                    weight = size(page)
                    # 连同本地媒体结构计算实际内存边界，不能只限制正文后
                    # 无限缓存附件。淘汰后依靠持久化身份游标继续，正确性不依赖缓存。
                    if weight <= 8 * 1024 * 1024:
                        with self._time_pages_lock:
                            self._time_pages[key] = {'lo': lo, 'hi': hi, 'cursor': cursor, 'page': page, 'weight': weight}
                            self._time_pages.move_to_end(key)
                            while len(self._time_pages) > 8 or sum(v['weight'] for v in self._time_pages.values()) > 8 * 1024 * 1024:
                                self._time_pages.popitem(last=False)
                return page
            finally:
                stream.close()
        async def read_page(lo, hi, budget, cursor):
            return await asyncio.to_thread(page, lo, hi, budget, cursor)
        return await read_window(read_page, start, end, capacity, state, probe_budget=probe_budget)

    @asynccontextmanager
    async def open_pages(self, account, username, start, end, offset, checkpoint, count=None, *, max_batch_bytes=None):
        """整次运行复用同一消息流；SQLite 游标在专用线程推进和关闭。"""
        from .messages import iter_message_pages
        closing = threading.Event()
        def check():
            if closing.is_set(): raise RuntimeError('读取已停止')
            checkpoint()
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='agent-reader')
        stream = iter_message_pages(account,username,start,end,count=count,page_offset=offset,
            page_size=MAX_READ_MESSAGES if max_batch_bytes is not None else 50,
            max_batch_chars=float('inf') if max_batch_bytes is not None else 12000,checkpoint=check,
            max_batch_bytes=max_batch_bytes, message_weight=lambda m: size(message_payload(m)))
        try:
            yield lambda: executor_call(executor,next,stream,None)
        finally:
            closing.set()
            try:
                await asyncio.shield(executor_call(executor,stream.close))
            finally:
                executor.shutdown(wait=False)

    @observed('agent.read.conversations')
    async def conversations(self, account):
        from ..chat_export_service import get_chat_export_targets_preview
        result = await asyncio.to_thread(get_chat_export_targets_preview, account=account, include_hidden=True, include_official=False)
        targets = {x['username']: x for x in result['targets']}
        if result.get('source') == 'realtime':
            # 实时会话列表可能已移除聊天，但消息库仍可读取；不能因此丢掉已保存历史。
            snapshot = await asyncio.to_thread(get_chat_export_targets_preview, account=account, source='decrypted',
                                                include_hidden=True, include_official=False)
            for item in snapshot['targets']:
                targets.setdefault(item['username'], item)
        return [{'username': x['username'], 'name': x.get('name') or x.get('displayName') or x['username'],
                 'isGroup': x.get('isGroup', x['username'].endswith('@chatroom'))} for x in targets.values()]

    async def people(self, account):
        return await asyncio.to_thread(self.people_directory, account)

    def people_directory(self, account):
        """人物目录独立于会话列表；备注和昵称均保留，仅以只读连接访问原联系人库。"""
        def load():
            import sqlite3
            from ..chat_helpers import _resolve_account_dir, _normalize_contact_text
            path = _resolve_account_dir(account) / 'contact.db'
            if not path.is_file():
                return []
            result = {}
            with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
                db.text_factory = bytes
                for table in ('contact', 'stranger'):
                    columns = {_normalize_contact_text(row[1]) for row in db.execute(f'PRAGMA table_info({table})')}
                    if 'username' not in columns:
                        continue
                    fields = [name for name in ('username', 'remark', 'nick_name', 'alias') if name in columns]
                    for row in db.execute(f"SELECT {','.join(fields)} FROM {table}"):
                        values = dict(zip(fields, map(_normalize_contact_text, row)))
                        username = values['username']
                        if not username or username.endswith('@chatroom') or username.startswith('gh_') or username in result:
                            continue
                        aliases = list(dict.fromkeys(values[k] for k in ('remark', 'nick_name', 'alias') if values.get(k)))
                        result[username] = {'username': username, 'name': aliases[0] if aliases else username,
                                            'aliases': aliases, 'isGroup': False}
            return list(result.values())
        return load()

    @observed('agent.read.search')
    async def search(self, account, username, query, start, end, offset, sender=None):
        from ..routers.chat import search_chat_messages
        result = await search_chat_messages(local_request(), q=query, account=account, username=username or None, sender=sender,
                                           start_time=start, end_time=max(start, end - 1), offset=offset, limit=50, source='auto', include_hidden=True,
                                           allow_native_enrichment=False, retrieval_mode='hybrid')
        messages = [normalize(account, username, x) for x in result.get('hits', [])]
        freshness = await self.search_freshness(account, username, start, end)
        device_note = result.get('device',{}).get('reason','')
        return {'messages': [x for x in messages if x], 'has_more': result.get('hasMore', False),
                'next_offset': offset + len(result.get('hits', [])) if result.get('hasMore') else None,
                'retrieval_mode':result.get('retrievalMode','keyword'),'device':result.get('device'),
                'match_counts': {method: sum(method in x.get('match_methods', []) for x in messages if x)
                                 for method in ('keyword', 'semantic')},
                'warning': '；'.join(filter(None,[result.get('coverage', {}).get('message') or '搜索索引来自本地快照；尚未解析的图片内容不在文字搜索范围内。',device_note])),
                'data_source': 'snapshot_index', 'freshness': freshness, 'start': start, 'end': end}

    @observed('agent.read.read')
    async def read(self, account, username, start, end, offset, count=None, *, max_batch_bytes=None):
        # 直接复用范围读取器，固定截止时间。分页按稳定来源排序，避免同秒消息遗漏。
        from .messages import read_messages
        result = await asyncio.to_thread(read_messages, account, username, start, end, count, page_offset=offset,
            page_size=MAX_READ_MESSAGES if max_batch_bytes is not None else 50, max_batch_bytes=max_batch_bytes,
            message_weight=lambda m: size(message_payload(m)))
        # 数据渠道与单条消息编号分开命名，避免模型把 realtime 当作消息引用。
        result['data_source'] = result.pop('source', 'auto')
        values = result['messages']
        for item in values:
            item['name'] = result['name']
        return {**result, 'messages': values, 'start': start, 'end': end}

    @observed('agent.read.context')
    async def context(self, account, evidence):
        from ..routers.chat import get_chat_messages_around
        result = await get_chat_messages_around(local_request(), username=evidence['username'], anchor_id=evidence['anchor'],
                                               account=account, before=10, after=10, source='auto')
        values = [normalize(account, evidence['username'], x, evidence.get('name', '')) for x in result.get('messages', [])]
        return {'messages': [x for x in values if x], 'warning': result.get('warning', ''), 'data_source': result.get('source', 'auto')}
