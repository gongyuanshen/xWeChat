"""索引之后的实时关键词回查；无关原文只在本机过滤，不送入模型。"""
import hashlib
import json


def search_identity(query, usernames, start, end, sender):
    return hashlib.sha256(json.dumps([query, sorted(usernames), start, end, sender],
                                    ensure_ascii=False).encode()).hexdigest()


class LiveSearch:
    @staticmethod
    def live_cursor_piece(state):
        token = hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()[:32]
        return 'live:' + token, ('live-search:' + token, 'live_search', state)

    async def prepare_live_search(self, id, query, usernames, start, end, known_keyword_matches=0):
        run = self.guard(id)
        sender = run.get('intent', {}).get('sender')
        identity = search_identity(query, usernames, start, end, sender)
        if known_keyword_matches:
            self.workspace.put(id, run['version'], 'live-keyword-known:' + identity,
                               'live_search_known_matches', {'count': known_keyword_matches})
        marker = self.workspace.get(id, run['version'], 'live-search-start:' + identity)
        if marker:
            return None if marker['complete'] else {'next_live_cursor': marker['next_live_cursor']}
        # 在第一批执行前重启，也沿用原计划，不能用更新后的索引时间跳过待查范围。
        plan = self.workspace.get(id, run['version'], 'live-search-plan:' + identity)
        if plan:
            state = {'identity': identity, 'query': query, 'position': 0,
                     'cursor': None, 'scanned': 0, 'matched': 0, 'sender': sender}
            cursor, piece = self.live_cursor_piece(state)
            self.workspace.put_pieces(id, run['version'], [piece])
            return {'next_live_cursor': cursor, 'segments': len(plan['segments'])}
        prepared = await self.tools.live_search_segments(run['account'], usernames, start, end)
        current = self.guard(id)
        if current['version'] != run['version']:
            from .agent_service import Revised
            raise Revised()
        if prepared.get('warning') or not prepared['segments']:
            return {'warning': prepared.get('warning', ''), 'segments': 0}
        state = {'identity': identity, 'query': query, 'position': 0,
                 'cursor': None, 'scanned': 0, 'matched': 0, 'sender': sender}
        cursor, piece = self.live_cursor_piece(state)
        self.workspace.put_pieces(id, run['version'], [
            ('live-search-plan:' + identity, 'live_search_plan', {'segments': prepared['segments']}), piece])
        return {'next_live_cursor': cursor, 'segments': len(prepared['segments'])}

    async def search_live(self, id, action, usernames, start, end):
        run = self.guard(id)
        token = action.cursor.removeprefix('live:')
        state = self.workspace.get(id, run['version'], 'live-search:' + token)
        identity = search_identity(action.query, usernames, start, end, run.get('intent', {}).get('sender'))
        if not state or state['identity'] != identity:
            raise ValueError('实时搜索续读位置不属于当前问题、账号或筛选条件')
        # 读取已提交、但运行队列尚未推进时重启，复用同一页的匹配原文。
        saved = self.workspace.get(id, run['version'], 'live-search-result:' + token)
        if saved is not None:
            return saved
        plan = self.workspace.get(id, run['version'], 'live-search-plan:' + identity)
        if not plan:
            raise ValueError('实时搜索读取计划缺失或已完成')
        # 每个会话轮流读取一页，避免活跃大群阻塞后面所有会话。
        # 旧检查点按已完成位置转换，保留正在读取的原消息游标。
        pending = list(state.get('pending', range(state['position'], len(plan['segments']))))
        cursors = dict(state.get('cursors', {}))
        if 'pending' not in state and state.get('cursor') is not None:
            cursors[str(state['position'])] = state['cursor']
        if not pending:
            raise ValueError('实时搜索读取计划缺失或已完成')
        position = pending.pop(0)
        segment = plan['segments'][position]
        current_cursor = cursors.get(str(position))
        page = await self.tools.live_search_page(run['account'], segment, current_cursor, action.query,
                                                state['sender'], lambda: self.guard(id))
        current = self.guard(id)
        if current['version'] != run['version']:
            from .agent_service import Revised
            raise Revised()
        updated = {**state, 'scanned': state['scanned'] + page['scanned'],
                   'matched': state['matched'] + len(page['messages'])}
        if page['has_more']:
            if not page.get('cursor') or page['cursor'] == current_cursor:
                raise ValueError('实时数据源没有推进续读位置，已保留上一批进度')
            cursors[str(position)] = page['cursor']
            pending.append(position)
        else:
            cursors.pop(str(position), None)
        completed = len(plan['segments']) - len(pending)
        updated.update(pending=pending, cursors=cursors, cursor=None,
                       position=pending[0] if pending else len(plan['segments']))
        more = bool(pending)
        cursor, piece = self.live_cursor_piece(updated) if more else (None, None)
        result = {'messages': page['messages'], 'data_source': 'realtime_keyword',
                  'prior_keyword_matches': (self.workspace.get(id, run['version'], 'live-keyword-known:' + identity) or {}).get('count', 0),
                  'has_more': more, 'next_live_cursor': cursor, 'next_offset': None,
                  'match_counts': {'keyword': len(page['messages']), 'semantic': 0},
                  'realtime_coverage': {'scanned': updated['scanned'], 'matched': updated['matched'],
                      'conversations_completed': completed, 'conversations': len(plan['segments']),
                      'recent_gap_complete': not more, 'history_complete': False},
                  'warning': '实时回查只覆盖索引内最新消息之后的范围，不代表全部历史完整覆盖。'}
        pieces = [
            ('live-search-result:' + token, 'live_search_result', result),
            ('live-search-start:' + identity, 'live_search_status', {'next_live_cursor': cursor, 'complete': not more})]
        if piece:
            pieces.append(piece)
        self.workspace.put_pieces(id, run['version'], pieces)
        return result


def live_search_continuation(action, result):
    """无匹配时继续本机扫描；有匹配后交回模型，用户仍可按游标继续。"""
    cursor = result.get('next_live_cursor')
    matched = result.get('prior_keyword_matches', 0) > 0 or result.get('match_counts', {}).get('keyword', 0) > 0 or (
        result.get('data_source') == 'realtime_keyword' and bool(result.get('messages')))
    if cursor and not matched:
        return action.model_copy(update={'cursor': cursor, 'progress': ''}).model_dump()
    return None
