"""独立批次事实的无损汇集；模型不再反复改写已提交的历史笔记。"""
import json
import re
from datetime import datetime, timezone, timedelta


def compact_batch_payload(payload):
    """短编号仅用于一次模型请求；原文、时间、人物身份及来源映射不丢失。"""
    sources, people, identities, messages = {}, {}, {}, []
    for index, original in enumerate(payload['evidence'], 1):
        alias = f'm{index}'
        sources[alias] = original['source']
        identity = (original.get('username'), original.get('sender_id') or original.get('sender'))
        if identity not in identities:
            person = f'p{len(identities) + 1}'
            identities[identity] = person
            people[person] = {k: original[k] for k in ('username', 'name', 'sender', 'sender_id', 'sender_aliases') if k in original}
        message = {'source': alias, 'sent_at': original.get('sent_at'),
                   'sender': original.get('sender'), 'person': identities[identity], 'text': original['text']}
        for field in ('text_offset', 'next_text_offset', 'fragment_complete', 'context_only'):
            if field in original:
                message[field] = original[field]
        messages.append(message)
    return {**{k: v for k, v in payload.items() if k not in ('evidence', 'references')},
            'people': people, 'evidence': messages}, sources


def check_inferred_weekdays(text, originals, source_ids, offset=0):
    """拦截模型自行补出的错误星期/日期组合，原文自身的说法不擅自改写。"""
    from .agent_model import ActionFormatError
    rows = [originals[s] for s in source_ids if s in originals]
    years = {datetime.fromtimestamp(row['time'], timezone(timedelta(seconds=offset))).year for row in rows}
    if len(years) != 1:
        return
    pattern = r'(?:周|星期)([一二三四五六日天])[（(](\d{1,2})月(\d{1,2})日[）)]'
    for match in re.finditer(pattern, text):
        if any(match.group() in row.get('text', '') for row in rows):
            continue
        weekday, month, day = match.groups()
        try:
            actual = datetime(next(iter(years)), int(month), int(day)).weekday()
        except ValueError:
            actual = -1
        if actual != '一二三四五六日'.find('日' if weekday == '天' else weekday):
            raise ActionFormatError('inferred_calendar_mismatch', correction=
                '你自行补全的星期与日期不一致。请删除推算的日历日期，保留来源中的原话星期和时刻；不要猜测日期。')


def remove_wrong_date_expansions(text, originals, source_ids, offset=0):
    """仅撤回与日历冲突且原文未写的日期补全，原话星期必须有对应证据。"""
    rows = [originals[s] for s in source_ids if s in originals]
    changes = []
    def replace(match):
        expression, weekday = match.group(), match[1]
        words = ('周' + weekday, '星期' + weekday)
        word = next((word for row in rows for word in words if word in row.get('text', '')), None)
        if not word or any(expression in row.get('text', '') for row in rows):
            return expression
        from .agent_model import ActionFormatError
        try:
            check_inferred_weekdays(expression, originals, source_ids, offset)
        except ActionFormatError:
            changes.append({'removed': expression, 'retained': word})
            return word
        return expression
    result = re.sub(r'(?:周|星期)([一二三四五六日天])[（(](\d{1,2})月(\d{1,2})日[）)]', replace, text)
    return result, changes


def combine_notes(notes):
    items, seen, uncertainties = [], set(), []
    for note in notes:
        for item in note.get('items', []):
            fingerprint = json.dumps(item, ensure_ascii=False, sort_keys=True)
            if fingerprint not in seen:
                seen.add(fingerprint)
                items.append(item)
        uncertainties.extend(note.get('uncertainties', []))
    return {'overview': '以下为各批次保存的事实；按来源核对事件先后并合并同一活动的变化。',
            'items': items, 'uncertainties': list(dict.fromkeys(uncertainties))}


def encode_answer_sources(payload, sources):
    """只替换协议中的来源字段，正文和用户原话中的相同字符串不改动。"""
    aliases = {f's{index}': source for index, source in enumerate(sorted(sources), 1)}
    forward = {source: alias for alias, source in aliases.items()}
    def convert(value, field=''):
        if isinstance(value, dict):
            return {key: convert(item, key) for key, item in value.items()}
        if isinstance(value, list):
            return [convert(item, field) for item in value]
        if isinstance(value, str):
            if field in ('source', 'sources', 'mentioned_sources'):
                return forward.get(value, value)
            if field == 'reference':
                return re.sub(r'\[\[([a-f0-9]{24})\]\]', lambda m: '[[' + forward.get(m[1], m[1]) + ']]', value)
        return value
    return convert(payload), aliases


def decode_answer_sources(text, aliases):
    known = set(aliases.values())
    token = r'(?:s\d+|[a-f0-9]{24})'
    def replace(match):
        body = match[1]
        # 部分模型把多个已知出处合写为 [[s1], [s2]]。只接受严格的
        # 编号列表，并逐个核对映射；未知编号或普通文字不能被吞掉。
        if not re.fullmatch(token + r'(?:\]?\s*[,，]\s*\[?' + token + r')*', body):
            return match.group()
        values = re.findall(token, body)
        if not all(value in aliases or value in known for value in values):
            return match.group()
        return ' '.join('[[' + aliases.get(value, value) + ']]' for value in values)
    return re.sub(r'\[\[([^\n]*?)\]\]', replace, text)


def encode_citation_feedback(text, aliases):
    """纠错提示与模型本次看到的编号一致，仅映射 JSON 中的完整来源值。"""
    forward = {source: alias for alias, source in aliases.items()}
    return re.sub(r'"([a-f0-9]{24})"', lambda m: '"' + forward.get(m[1], m[1]) + '"', text)


def normalize_date_headings(text, default_year=None):
    """标题已明确给出年月日时，星期由程序计算；不改正文中的原文引述或活动日期。"""
    def replace(match):
        try:
            year = int(match[2]) if match[2] else default_year
            if year is None:
                return match.group()
            weekday = datetime(year, int(match[3]), int(match[4])).weekday()
        except ValueError:
            return match.group()
        return match[1] + '星期' + '一二三四五六日'[weekday] + match[5]
    return re.sub(r'^(#{1,6}\s+(?:\*\*)?(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*[（(])(?:星期|周)[一二三四五六日天]([）)])',
                  replace, text, flags=re.MULTILINE)


def answer_year(run):
    """查询范围完全落在同一年时，才为省略年份的标题提供确定年份。"""
    interval = run.get('time_range') or {}
    if not interval.get('end') or interval.get('start') is None:
        return None
    zone = timezone(timedelta(seconds=run.get('timezone_offset', 0)))
    first = datetime.fromtimestamp(interval['start'], zone).year
    last = datetime.fromtimestamp(interval['end'] - 1, zone).year
    return first if first == last else None


def saved_notes(workspace, run):
    """只沿已提交根节点取笔记，避免混入未提交结果、旧版本或不兼容的范围。"""
    if not run.get('note_key'):
        return {}
    with workspace.store.connection() as db:
        rows = db.execute("SELECT id,body FROM agent_piece WHERE run_id=? AND version=? AND kind='stage_note'",
                          (run['id'], run['version'])).fetchall()
    by_id = {key: json.loads(body) for key, body in rows}
    chain, visited = [], set()
    key = run.get('note_key')
    while key and key not in visited:
        visited.add(key)
        note = by_id.get(key)
        if note is None:
            raise ValueError('已提交笔记链缺失，不能跳过历史事实。')
        chain.append(note['notes'])
        # 兼容旧累计笔记及跨任务继承的完整摘要，它们自身已经代表此前历史。
        if note.get('note_strategy') != 'incremental':
            break
        key = note.get('parent')
    return combine_notes(reversed(chain))
