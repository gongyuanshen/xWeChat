"""按时间和剩余预算读取。游标状态由任务资料库保存，不让模型管理消息 offset。"""
import copy

from .agent_budget import ContextOverflow, message_payload, size
from .messages import advance_cursor


async def read_window(read_page, start, end, capacity, state=None, *, probe_budget=None):
    """返回左闭右开子区间；一秒内仍过大时保留消息身份及字符断点。"""
    state = copy.deepcopy(state or {})
    lo = state.get('next_time', start)
    cursor = state.get('db_cursor')
    if cursor:
        # 区间内已经推进到某条消息后，二分的下界也必须推进。否则预算
        # 缩小时可能得到早于游标的空区间，并在清空游标后重读旧消息。
        # 保留同秒身份集合，仍能读取这一秒尚未处理的消息。
        lo = max(lo, cursor['time'])
    # 延续上次已收敛的窗口，避免每页又从剩余整段历史开始反复二分。
    # 成功读完后逐步扩展；预算变小仍由下方按原规则二分，空区间也连续推进。
    span = state.get('window_seconds')
    hi = min(end, lo + span) if isinstance(span, int) and span > 0 else end
    original_range = {'start': start, 'end': end}
    if lo >= end:
        return {'messages': [], 'originals': [], 'has_more': False, 'complete': True,
                'requested_range': original_range, 'actual_range': {'start': end, 'end': end}, 'next_state': None}
    shrunk = False
    while True:
        page = ({'messages': [state['pending_message']], 'has_more': True,
                 'source': state.get('data_source', 'unknown'), 'warning': state.get('warning', '')}
                if state.get('pending_message') else await read_page(lo, hi, capacity, cursor))
        messages = page.get('messages', [])
        # 数据源已按预算分页。显示名等封装可能略超预算，下方仍按实际体积
        # 取完整前缀或切单条长文；无需为此重新读取更小的时间区间。
        if page.get('budgeted_page') and messages:
            break
        if not messages and not page.get('has_more') and hi < end:
            # 用一次真实查询确认剩余尾部是否全空，避免多年空白产生几十个持久化步骤。
            # 后面仍有消息时保持自适应窗口，不能因短空隙重新对整个剩余历史二分。
            tail = await read_page(hi, end, capacity, None)
            if not tail.get('messages') and not tail.get('has_more') and not tail.get('warning'):
                hi = end
        if (page.get('has_more') or size([message_payload(m) for m in messages]) > capacity) and hi - lo > 1:
            hi = lo + max(1, (hi - lo) // 2)
            shrunk = True
            continue
        if (not shrunk and not state.get('pending_message') and not page.get('has_more')
                and not page.get('warning') and hi < end
                and size([message_payload(m) for m in messages]) < capacity // 2):
            # 预算恢复或消息变稀疏后，在同一步内扩大已验证窗口，避免每几条
            # 就保存一个执行步骤并重新装载全部上下文。溢出仍按原规则二分。
            hi = min(end, lo + max(1, hi - lo) * 2)
            continue
        break
    result, completed, pending = [], [], None
    result_bytes = 2
    for message in messages:
        item = message_payload(message)
        offset = state.get('text_offset', 0) if state.get('partial_source') == message['source'] else 0
        original = message.get('text', '')
        item['text'] = original[offset:]
        item['fragment_complete'] = True
        if offset:
            item['text_offset'] = offset
        # result 为本地完整消息（含 media）；预算只计模型需要的正文封装，
        # 不能把前面消息的附件原始结构反复计入，导致一页被错误截成几十条。
        item_bytes = size(item) + (2 if result else 0)
        if result_bytes + item_bytes <= capacity:
            result.append({**message, **item, 'fragment_complete': True})
            result_bytes += item_bytes
            completed.append(message)
            # 预读只多交付一条完整探测消息；下层数据库批缓存仍由原读取器管理。
            if probe_budget is not None and result_bytes > probe_budget:
                break
            continue
        if result:
            break
        low, high = 0, len(original) - offset
        while low < high:
            mid = (low + high + 1) // 2
            fragment = {**item, 'text': original[offset:offset + mid], 'text_offset': offset,
                        'next_text_offset': offset + mid, 'fragment_complete': False}
            if size([fragment]) <= capacity:
                low = mid
            else:
                high = mid - 1
        if low == 0:
            raise ContextOverflow('来源元数据已超出剩余预算，需要先整理上下文；读取位置已保留。')
        result.append({**message, 'text': original[offset:offset + low], 'text_offset': offset,
                       'next_text_offset': offset + low, 'fragment_complete': False})
        pending = {'partial_source': message['source'], 'text_offset': offset + low}
        break
    exhausted = not page.get('has_more') and len(completed) == len(messages)
    next_state = {'next_time': hi} if exhausted else {'next_time': lo, 'db_cursor': advance_cursor(completed, cursor)}
    next_state['window_seconds'] = max(1, (hi - lo) * (2 if exhausted else 1))
    if pending:
        next_state.update(pending)
        next_state.update(data_source=page.get('data_source', page.get('source', 'unknown')), warning=page.get('warning', ''))
    has_more = not exhausted or hi < end
    selected = {m['source'] for m in result}
    return {'messages': result, 'originals': [m for m in messages if m['source'] in selected], 'has_more': has_more, 'complete': not has_more,
            'requested_range': original_range, 'actual_range': {'start': lo, 'end': hi},
            'interval_complete': exhausted, 'shrink_reason': '剩余上下文预算不足' if shrunk or not exhausted else '',
            'next_state': next_state if has_more else None,
            'warning': page.get('warning', ''), 'data_source': page.get('data_source', page.get('source', 'unknown'))}
