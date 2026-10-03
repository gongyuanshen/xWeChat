"""明确日期和时间区间的共享解析，不包含旧 Agent 执行器。"""
import re
from datetime import datetime, timedelta, timezone


def explicit_clock_range(phrase, timezone_offset):
    """明确的年月日和钟点由程序换算；相对日期仍交由语义解析。"""
    def clock(prefix):
        return rf'(?P<{prefix}h>\d{{1,2}})[:：](?P<{prefix}m>\d{{2}})(?:[:：](?P<{prefix}s>\d{{2}}))?'
    date = r'(?P<y>\d{4})(?:年|-|/)(?P<month>\d{1,2})(?:月|-|/)(?P<day>\d{1,2})日?'
    # 结束日期可以省略年份或年月，但不根据结束钟点擅自推断次日、次年。
    last = (r'(?:(?:(?P<ey>\d{4})(?:年|-|/))?'
            r'(?P<emonth>\d{1,2})(?:月|-|/)(?P<eday>\d{1,2})日?'
            r'|(?P<eday_only>\d{1,2})日)')
    match = re.fullmatch(r'(?:从\s*)?(?P<zone>北京时间|中国标准时间)?\s*' + date + r'[\sT]*' + clock('a')
                         + r'\s*(?:到|至|[-~～–—])\s*(?:' + last + r'[\sT]*)?' + clock('b')
                         + r'\s*(?:之前|以前|前)?(?:的(?:聊天记录|聊天|消息|记录))?', phrase.strip())
    if not match:
        return None
    parts = match.groupdict()
    zone = timezone(timedelta(seconds=28800 if parts['zone'] else timezone_offset))
    first_date = [int(parts[key]) for key in ('y', 'month', 'day')]
    last_date = [int(parts['ey'] or parts['y']), int(parts['emonth'] or parts['month']),
                 int(parts['eday'] or parts['eday_only'] or parts['day'])]
    start = datetime(*first_date, *[int(parts['a' + key] or 0) for key in ('h', 'm', 's')], tzinfo=zone)
    end = datetime(*last_date, *[int(parts['b' + key] or 0) for key in ('h', 'm', 's')], tzinfo=zone)
    if end < start:
        # 未写次日时不擅自跨日，要求明确结束日期。
        raise ValueError('结束时间早于开始时间，请明确跨日区间的结束日期。')
    return {'start': int(start.timestamp()), 'end': int(end.timestamp())}
