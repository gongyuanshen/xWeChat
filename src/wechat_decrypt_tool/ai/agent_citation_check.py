"""检查可确定的引文错配；不把字面匹配冒充完整语义验证。"""
import json
import re

from .agent_model import ActionFormatError


def compact(text):
    return re.sub(r'\s+', '', text)


def mask_code(answer):
    """屏蔽代码而保留字符位置与换行，避免影响段落和续写边界。"""
    lines, fence = [], None
    for line in answer.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        masked = fence is not None
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
        elif marker:
            fence, masked = marker[1], True
        lines.append(re.sub(r'[^\r\n]', ' ', line) if masked else line)
    return re.sub(r'(`+)([^\n]*?)\1', lambda m: ' ' * len(m[0]), ''.join(lines))


def check_quoted_sources(answer, originals, references, protected_chars=0, source_ids=None, candidate_lookup=None):
    # 代码示例不解释为引文。保留长度，使续写的旧正文边界仍能正确定位。
    clean = mask_code(answer)
    boundaries = list(re.finditer(r'\n[ \t\r]*\n|\n(?=[ \t]*(?:[-*+]\s|\d+[.)]\s|\|))', clean))
    starts = [0, *(m.end() for m in boundaries)]
    ends = [*(m.start() for m in boundaries), len(clean)]
    texts = {key.lower(): compact(value.get('text') or '') for key, value in originals.items()}
    issues = []
    for start, end in zip(starts, ends):
        if end <= protected_chars:
            continue
        block = clean[start:end]
        cited = set(source_ids) if source_ids is not None else set(re.findall(r'\[\[([a-f0-9]{24})\]\]', block, re.I))
        if not cited:
            continue
        seen = set()
        for match in re.finditer(r'“([^”\n]{6,})”|"([^"\n]{6,})"', block):
            # 已显示的前缀不可改写；跨停止点的旧引文也不要求模型重写。
            if start + match.start() < protected_chars:
                continue
            quote = re.sub(r'\[\[person:([a-f0-9]{24})\]\]',
                           lambda m: references.get(m[1].lower(), {}).get('name', ''),
                           match[1] or match[2], flags=re.I)
            phrase = compact(quote)
            if len(phrase) < 6 or phrase in seen:
                continue
            seen.add(phrase)
            if any(phrase in texts.get(key.lower(), '') for key in cited):
                continue
            matches = [key for key, text in texts.items() if phrase in text]
            if not matches and candidate_lookup:
                matches = list(candidate_lookup(phrase))[:8]
            # 仅拦截原文中确实存在、却没有引用对应消息的直接引文。
            # 未找到的改写或短语不靠猜测选来源，也不据此声称事实已验证。
            if matches:
                issues.append({'quote': quote, 'candidate_sources': matches[:8]})
            if len(issues) >= 6:
                break
        if len(issues) >= 6:
            break
    if issues:
        raise ActionFormatError('citation_mismatch', ['quoted_sources'], correction=(
            '以下直接引文在其所在段落引用的消息中找不到，但已读原文有对应消息。'
            '请根据发送者、时间与正文核对并在该结论后引用正确消息；不能用相邻段落的来源代替，也不要为了通过校验改写或删掉事实。'
            + json.dumps(issues, ensure_ascii=False)))
