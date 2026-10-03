"""共享模型响应文本、用量采集和协议异常，不包含旧执行器。"""
from .providers import ProviderFailure


class ActionFormatError(ValueError):
    def __init__(self, code, fields=None, *, correction=None):
        super().__init__(code)
        self.code, self.fields = code, fields or []
        self.correction = correction


class AgentFailure(ProviderFailure):
    def __init__(self, message, *, category='protocol', phase='decision', retryable=True, diagnostic_id='', fields=None):
        super().__init__(message, authentication=category == 'authentication')
        self.detail = dict(category=category, phase=phase, retryable=retryable,
                           action='retry' if retryable else 'settings', diagnostic_id=diagnostic_id, fields=fields or [])


class AgentModel:
    @staticmethod
    def text(content):
        return content if isinstance(content, str) else ''.join(x.get('text', '') for x in content or [] if isinstance(x, dict) and x.get('type') == 'text')

    @staticmethod
    def capture(audit, response, check_finish=True):
        if response is None:
            return
        usage = getattr(response, 'usage_metadata', None) or {}
        if usage:
            audit.update(usage=usage, usage_known=True)
        meta = getattr(response, 'response_metadata', {}) or {}
        reason = meta.get('finish_reason') or meta.get('stop_reason')
        audit.update(response_received=True, finish_reason=reason,
                     tool_count=len(getattr(response, 'tool_calls', []) or []),
                     invalid_tool_count=len(getattr(response, 'invalid_tool_calls', []) or []))
        if check_finish and reason in ('length', 'max_tokens'):
            raise ActionFormatError('output_truncated')
