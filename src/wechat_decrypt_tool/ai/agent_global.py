"""共享会话名称匹配；装饰符号不影响精确查询，重名保持歧义。"""
import unicodedata


def comparable_name(value):
    """只忽略名称的装饰符号；不做模糊纠错，重名仍须用户澄清。"""
    return ''.join(char for char in unicodedata.normalize('NFKC', value)
                   if unicodedata.category(char)[0] in ('L', 'N', 'M')
                   and char not in ('\ufe0e', '\ufe0f'))


def resolve_directory_name(contacts, value):
    exact = [c for c in contacts if c['username'] == value]
    if not exact:
        exact = [c for c in contacts if c['name'] == value]
    if exact:
        return exact
    name = comparable_name(value)
    return [c for c in contacts if name and comparable_name(c['name']) == name]
