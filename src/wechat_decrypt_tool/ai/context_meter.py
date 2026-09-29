"""用供应商真实输入用量校准相同请求前缀；新增后缀仍按字节保守计入。"""
import hashlib
import json
import math
from contextvars import ContextVar

active_meter = ContextVar('agent_context_meter', default=None)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def request_sample(profile, messages, extra=None):
    # 多模态的供应商计量差异很大，没有可靠图片计量时不外推文本锚点。
    chunks = []
    for message in messages:
        content = getattr(message, 'content', message)
        if isinstance(content, list) and all(isinstance(part, dict) and part.get('type') == 'text' for part in content):
            content = json.dumps(content, ensure_ascii=False, sort_keys=True)
        if not isinstance(content, str):
            return None
        parts = [getattr(message, 'type', 'unknown'), content]
        if getattr(message, 'additional_kwargs', {}).get('reasoning_content'):
            parts.append(message.additional_kwargs['reasoning_content'])
        if getattr(message, 'tool_calls', None):
            parts.append(message.tool_calls)
        if getattr(message, 'tool_call_id', None):
            parts.append(message.tool_call_id)
        text = json.dumps(parts, ensure_ascii=False)
        for start in range(0, len(text), 256):
            part = text[start:start + 256]
            chunks.append([hashlib.sha256(part.encode()).hexdigest(), len(part.encode())])
    route = {k: profile.get(k) for k in ('id', 'revision', 'base_url', 'protocol', 'provider', 'model',
                                        'reasoning_effort', 'thinking_mode', 'thinking_budget', 'context_window', 'model_metadata', 'context_purpose')}
    from .model_execution import call_policy
    route['auxiliary'] = call_policy.get().auxiliary
    return {'route': digest([route, extra]), 'chunks': chunks}


class ContextMeter:
    def __init__(self, samples=None, save=None):
        self.samples = list(samples or [])[-6:]
        self.save = save
        self.last = {}

    def measure(self, profile, messages, extra=None):
        from .agent_budget import request_size
        from .compaction_policy import policy_for
        conservative = request_size(messages, extra)
        sample = request_sample(profile, messages, extra) if policy_for(profile).usage_calibration else None
        estimate, matched = conservative, False
        if sample:
            for anchor in reversed(self.samples):
                if anchor.get('route') != sample['route']:
                    continue
                common = 0
                for old, new in zip(anchor['chunks'], sample['chunks']):
                    if old != new:
                        break
                    common += 1
                # 只有完整旧请求前缀仍一致才外推；仅共享系统提示不能校准新的历史。
                if common < 2 or common != len(anchor['chunks']):
                    continue
                suffix = sum(row[1] for row in sample['chunks'][common:])
                # 不扣除旧请求被删除的部分，避免错误推断其 Token 密度。
                calibrated = math.ceil(anchor['input_tokens'] * 1.05) + suffix + 256
                exact = anchor['chunks'] == sample['chunks']
                if calibrated < estimate or (exact and anchor['input_tokens'] > conservative):
                    estimate, matched = calibrated, True
        self.last = {'measurement': 'usage_anchored_estimate' if matched else 'conservative_estimate',
                     'conservative_units': conservative, 'used': estimate}
        return estimate

    def observe(self, profile, messages, extra, usage):
        from .compaction_policy import policy_for
        tokens = (usage or {}).get('input_tokens')
        if not policy_for(profile).usage_calibration or type(tokens) is not int or tokens <= 0:
            return
        sample = request_sample(profile, messages, extra)
        if not sample:
            return
        sample['input_tokens'] = tokens
        self.samples = [row for row in self.samples if row['route'] != sample['route']]
        self.samples = [*self.samples[-5:], sample]
        if self.save:
            try:
                self.save(self.samples)
            except Exception:
                # 用量优化是辅助信息；落盘失败不能丢掉已经成功生成的回答。
                from .diagnostics import event
                event('agent.context.calibration_save_failed')

    def invalidate(self):
        self.samples = []
        if self.save:
            try:
                self.save([])
            except Exception:
                from .diagnostics import event
                event('agent.context.calibration_save_failed')
