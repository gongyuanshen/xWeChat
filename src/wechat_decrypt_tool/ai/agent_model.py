"""Agent 模型协议：分类诊断、有限纠错及独立于解析结果的用量审计。"""
from .diagnostics import observed, event as diagnostic_event, context as diagnostic_context
import logging
import asyncio
import json
import hashlib
import time
import uuid
import httpx
import httpcore
from contextvars import ContextVar

from langchain_core.messages import SystemMessage
from langsmith import tracing_context
from pydantic import ValidationError

from .agent_schemas import AgentAction, TOOL_DESCRIPTION, AgentControl
from .providers import ProviderFailure, audit_task_id, model_attempt_hook, capture_sdk_truncation
from .agent_budget import active_budget, check_request, output_limit, ContextOverflow, is_context_error
from .model_execution import ANSWER_SECONDS, DECISION_SECONDS
from .model_scheduler import scheduler, subtask_id

agent_feedback = ContextVar('agent_feedback', default=None)


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
    def __init__(self, models):
        self.models = models
        self.no_tools, self.no_stream, self.no_force, self.no_json = set(), set(), set(), set()

    def compatibility_state(self, key, *, save=False):
        """短期保存服务明确拒绝的参数；配置版本变化后使用不同记录。"""
        identifier = hashlib.sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()
        flags = ('no_tools', 'no_stream', 'no_force', 'no_json')
        try:
            if save:
                self.models.store.put('agent_model_compatibility', {
                    'expires_at': time.time() + 86400,
                    'disabled': [flag for flag in flags if key in getattr(self, flag)],
                }, id=identifier)
                return
            state = self.models.store.get('agent_model_compatibility', identifier) or {}
            if not state:
                return
            disabled = state.get('disabled', []) if state.get('expires_at', 0) > time.time() else []
            for flag in flags:
                getattr(self, flag).discard(key)
                if flag in disabled:
                    getattr(self, flag).add(key)
        except Exception:
            # 派生缓存不可用时保留进程内结果，不影响任务和原文检查点。
            diagnostic_event('model.compatibility.cache_unavailable', level=logging.WARNING)

    @staticmethod
    def text(content):
        return content if isinstance(content, str) else ''.join(x.get('text', '') for x in content or [] if isinstance(x, dict) and x.get('type') == 'text')

    @staticmethod
    def validate_actions(values):
        if not isinstance(values, list):
            values = [values]
        if not values or len(values) > 36:
            raise ActionFormatError('action_count')
        try:
            actions = [AgentAction.model_validate(v) for v in values]
        except ValidationError as exc:
            # 不保存 input/msg/context，里面可能包含聊天原文或模型任意输出。
            fields = [{'path': [p if p in AgentAction.model_fields else '<field>' for p in e['loc']], 'type': e['type']}
                      for e in exc.errors(include_input=False)][:12]
            raise ActionFormatError('invalid_arguments', fields) from None
        if len(actions) > 1 and any(a.action in ('answer', 'clarify') for a in actions):
            raise ActionFormatError('mixed_terminal_actions')
        return actions[0] if len(actions) == 1 else actions

    @classmethod
    def parse(cls, content):
        raw = cls.text(content).strip()
        if not raw:
            raise ActionFormatError('empty_response')
        if raw.startswith('```'):
            raw = raw.split('\n', 1)[-1].rsplit('```', 1)[0]
        try:
            value = json.loads(raw)
        except (ValueError, TypeError):
            raise ActionFormatError('invalid_json') from None
        return cls.validate_actions(value)

    @classmethod
    def decision(cls, response):
        if getattr(response, 'invalid_tool_calls', None):
            raise ActionFormatError('invalid_tool_json')
        calls = getattr(response, 'tool_calls', None) or []
        if not calls:
            return cls.parse(response.content)
        if any(c.get('name') != 'chat_action' for c in calls):
            raise ActionFormatError('unknown_tool')
        values = []
        for call in calls:
            value = call.get('args')
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError:
                    raise ActionFormatError('invalid_tool_json') from None
            values.append(value)
        return cls.validate_actions(values)

    @observed('agent.model.call')
    async def call(self, profile, messages, account, *, decision=False, on_delta=None, validate=None, continuation=False):
        key = (profile.get('base_url'), profile.get('protocol'), profile['model'], profile['id'], profile.get('revision'))
        self.compatibility_state(key)
        phase = 'decision' if decision else 'answer'
        capabilities = profile.get('model_metadata', {})
        if capabilities.get('tool_call') is False:
            self.no_tools.add(key)
        if capabilities.get('structured_output') is False:
            self.no_json.add(key)
        corrections, token_limit = [], None
        deadline = time.monotonic() + (DECISION_SECONDS if decision else ANSWER_SECONDS)
        for attempt in range(3):
            request = [*messages, *corrections]
            fallback = decision and key in self.no_tools
            if fallback:
                request.append(SystemMessage(content=TOOL_DESCRIPTION+'\n只返回符合以下 Schema 的 JSON 动作，禁止附加散文：' + json.dumps(AgentAction.model_json_schema(), ensure_ascii=False)))
            extra={'description':TOOL_DESCRIPTION,'parameters':AgentAction.model_json_schema()} if decision and not fallback else None
            if active_budget.get():
                # 本地预算检查未向上游发出请求，不建立虚假的未知用量记录。
                check_request(profile,request,extra)
            hook = model_attempt_hook.get()
            if hook:
                hook()
            audit = dict(id=uuid.uuid4().hex, account=account, task_id=audit_task_id.get(), subtask_id=subtask_id.get(),
                         profile_id=profile['id'], profile_name=profile.get('name'), model=profile['model'],
                         provider=profile.get('provider'), profile_revision=profile.get('revision'),
                         attempt=attempt + 1, started_at=time.time(), status='running', usage={}, usage_known=False,
                         purpose='agent_' + phase, image_count=0, response_received=False)
            audit.update({k:v for k,v in diagnostic_context.get().items() if k in {'trace_id','operation_id','execution_id','run_id','thread_id'}})
            self.models.store.put('usage', audit, account=account)
            queued, requested = time.monotonic(), None
            request_finished = None
            diagnostic_event('model.call.started', call_id=audit['id'], phase=phase, attempt=attempt+1, using_fallback=fallback)
            emitted, response = False, None
            call_timeout = asyncio.timeout(max(.001, deadline - time.monotonic()))
            try:
                async with call_timeout, self.models.semaphore:
                    requested = time.monotonic()
                    diagnostic_event('model.call.acquired', call_id=audit['id'], queue_ms=(requested-queued)*1000)
                    with tracing_context(enabled=False):
                        client = self.models.client(profile)
                        kwargs = {'max_tokens': min(token_limit or output_limit(profile), output_limit(profile))} if active_budget.get() else ({'max_tokens': token_limit} if token_limit else {})
                        if decision and not token_limit:
                            kwargs['max_tokens'] = min(output_limit(profile), 4096)
                        if decision:
                            if key not in self.no_tools:
                                client = client.bind_tools([{'name': 'chat_action', 'description': TOOL_DESCRIPTION,
                                                            'parameters': AgentAction.model_json_schema()}],
                                                           tool_choice='auto' if key in self.no_force else 'chat_action')
                            else:
                                if profile.get('protocol') == 'openai' and key not in self.no_json:
                                    kwargs['response_format'] = {'type':'json_object'}
                            response = await client.ainvoke(request, config={'callbacks': []}, **kwargs)
                            self.capture(audit, response)
                            value = self.decision(response)
                        else:
                            if key in self.no_stream:
                                response = await client.ainvoke(request, config={'callbacks': []}, **kwargs)
                                self.capture(audit, response)
                                value = self.text(response.content)
                                if on_delta:
                                    on_delta(value)
                            else:
                                value = ''
                                if profile.get('protocol') == 'openai':
                                    kwargs['stream_usage'] = True
                                async for chunk in client.astream(request, config={'callbacks': []}, **kwargs):
                                    # 已缓冲的流式片段可能连续同步返回，期间没有
                                    # 事件循环调度点；不能只依赖 timeout 的取消回调。
                                    if time.monotonic() >= deadline:
                                        raise TimeoutError('回答超过本步骤截止时间')
                                    response = chunk if response is None else response + chunk
                                    self.capture(audit, response, check_finish=False)
                                    delta = self.text(chunk.content)
                                    if delta:
                                        if not emitted:
                                            diagnostic_event('model.call.first_token', call_id=audit['id'], first_token_ms=(time.monotonic()-requested)*1000)
                                        emitted = True
                                        value += delta
                                        if on_delta:
                                            on_delta(delta)
                                self.capture(audit, response)
                            if not value.strip():
                                raise ActionFormatError('empty_response')
                        # 动作也必须通过业务引用校验，失败时沿用有限纠错与用量审计。
                        if validate:
                            validate(value)
                request_finished = time.monotonic()
                audit.update(status='success', validation_status='success')
                from .context_meter import active_meter
                meter = active_meter.get()
                if meter:
                    meter.observe(profile, request, extra, audit.get('usage'))
                    audit['context_measurement'] = dict(meter.last)
                return value
            except asyncio.CancelledError:
                audit['status'] = 'cancelled'
                raise
            except AgentControl:
                audit['status'] = 'interrupted'
                raise
            except Exception as exc:
                request_finished = time.monotonic()
                if capture_sdk_truncation(audit, exc):
                    exc = ActionFormatError('output_truncated')
                diagnostic_event('model.call.attempt_failed', level=logging.WARNING, error=exc, call_id=audit['id'], diagnostic_id=audit['id'])
                code = getattr(exc, 'status_code', None)
                if code == 429:
                    scheduler().throttled()
                category, retryable = 'protocol', True
                fields, reason_code = getattr(exc, 'fields', []), getattr(exc, 'code', '')
                audit.update(status='failed', http_status=code, error_type=type(exc).__name__,
                             validation_status='failed' if isinstance(exc, ActionFormatError) else 'unknown', fields=fields)
                reason = str(exc).lower()
                if isinstance(exc,ContextOverflow) or (active_budget.get() and is_context_error(exc)):
                    audit.update(error_category='context',error_code='context_overflow')
                    raise ContextOverflow('模型上下文不足，正在缩小资料分段。') from None
                unsupported = isinstance(exc, NotImplementedError) or (code in (400, 422) and any(x in reason for x in ('not support', 'unsupported', 'unknown parameter')))
                compatibility = False
                if code in (401, 403):
                    category, retryable = 'authentication', False
                elif unsupported and decision:
                    if key not in self.no_json and any(x in reason for x in ('response_format', 'json_object')):
                        self.no_json.add(key); compatibility = True
                    elif key not in self.no_force and any(x in reason for x in ('tool_choice', 'tool choice', 'forced')):
                        self.no_force.add(key); compatibility = True
                    elif key not in self.no_tools and (isinstance(exc, NotImplementedError) or any(x in reason for x in ('tool', 'function'))):
                        self.no_tools.add(key); compatibility = True
                    else:
                        category, retryable = 'capability', False
                elif unsupported and not decision and not emitted and key not in self.no_stream and (isinstance(exc, NotImplementedError) or 'stream' in reason):
                    self.no_stream.add(key); compatibility = True
                elif isinstance(exc, ActionFormatError):
                    category = 'truncated' if reason_code == 'output_truncated' else 'protocol'
                    if category == 'truncated':
                        token_limit = min(16384, max(8192, (token_limit or 4096) * 2))
                    if decision:
                        correction = '上一动作未执行。请修正：' + json.dumps({'error':reason_code, 'fields':fields}, ensure_ascii=False) + '。仅输出符合 Schema 的动作；search_messages 需要非空 query，read_context/analyze_media 的 source 必须原样复制 evidence 中的消息 source，不能使用 data_source、realtime、decrypted、snapshot_index 或自行编造编号；没有已读消息时先搜索或读取消息；answer/clarify 必须单独调用。不要重读已完成页面。'
                    elif continuation:
                        correction = '上一段续写未通过校验，新增内容已撤回，原回答前缀保持不变。只能输出该前缀最后一个字符之后的剩余内容，先按最后一条用户指令接完半截引用；禁止重新输出已有标题、开头或整份回答。仅使用输入证据中的合法引用。'
                    else:
                        correction = '上一回答未通过完整性或引用校验。请按本轮要求重新输出完整回答，保留用户要求的范围、事实与详细程度；仅使用输入证据内的 [[source_id]] 引用，不添加未知来源。'
                    if getattr(exc, 'correction', None):
                        correction += '\n' + exc.correction
                    # 最新纠错已包含完整约束，不反复累积相同提示占用小窗口。
                    corrections = [SystemMessage(content=correction)]
                elif code == 429:
                    category = 'rate_limit'
                elif code in (408, 409) or isinstance(exc, (TimeoutError, asyncio.TimeoutError)) or 'timeout' in type(exc).__name__.lower():
                    category = 'timeout'
                elif code and code >= 500:
                    category = 'service'
                elif code:
                    category, retryable = 'configuration', False
                else:
                    # 流式 SDK 也可能直接抛出底层 httpcore 异常，二者不是继承关系。
                    category = 'connection' if isinstance(exc, (httpx.TransportError, httpcore.NetworkError, httpcore.ProtocolError)) or any(x in type(exc).__name__.lower() for x in ('connection', 'network', 'connect')) else 'internal'
                    retryable = category == 'connection'
                audit.update(error_category=category, error_code=reason_code, diagnostic_id=audit['id'])
                if compatibility:
                    self.compatibility_state(key, save=True)
                diagnostic_event('model.call.validation', level=logging.WARNING, call_id=audit['id'], diagnostic_id=audit['id'],
                                 error_category=category, reason_code=reason_code, using_fallback=compatibility)
                if attempt == 2 or call_timeout.expired() or time.monotonic() >= deadline or not retryable or (emitted and not isinstance(exc, ActionFormatError)):
                    labels = {'authentication':'模型鉴权失败，请检查 AI 服务配置。', 'configuration':'模型请求配置有误，请检查 AI 服务。',
                              'capability':'该服务不支持所需调用方式，请检查模型能力。', 'protocol':'模型返回的查询指令仍无法处理。' if decision else '回答校验未通过，请重试这一步。',
                              'truncated':'模型输出被截断，当前步骤未完成。', 'rate_limit':'服务请求过于频繁，请稍后重试。',
                              'timeout':'模型响应超时，请重试这一步。', 'service':'模型服务暂时不可用，请稍后重试。',
                              'connection':'无法连接模型服务，请检查网络后重试。', 'internal':'模型接入处理异常，请查看诊断信息。'}
                    message = '模型引用的消息编号无效，自动纠正未成功，请重试这一步。' if reason_code == 'unknown_source' else labels[category]
                    raise AgentFailure(message, category=category, phase=phase, retryable=retryable, diagnostic_id=audit['id'], fields=fields) from None
                feedback = agent_feedback.get()
                diagnostic_event('model.call.compatibility' if compatibility else 'model.call.retry', level=logging.WARNING,
                                 call_id=audit['id'], attempt=attempt+2, reason_code=category,
                                 wait_seconds=0 if compatibility or isinstance(exc, ActionFormatError) else 2**attempt)
                if feedback:
                    feedback({'phase': phase, 'attempt': attempt + 2, 'category': category,
                              'text': '正在适配服务的调用方式' if compatibility else '正在修正模型返回的查询指令，已读取资料会保留' if decision and isinstance(exc, ActionFormatError) else
                                      '正在重新整理完整回答' if not decision and isinstance(exc, ActionFormatError) else '服务暂时没有响应，正在重试'})
                if not decision and on_delta:
                    on_delta(None)
                if not compatibility and not isinstance(exc, ActionFormatError):
                    await asyncio.sleep(min(2 ** attempt, max(0, deadline - time.monotonic())))
            finally:
                audit.update(finished_at=time.time(), duration_ms=round((time.time() - audit['started_at']) * 1000))
                self.models.store.put('usage', audit, account=account)
                diagnostic_event('model.call.finished', call_id=audit['id'], status=audit['status'], duration_ms=audit['duration_ms'],
                    usage_known=audit['usage_known'], input_tokens=audit['usage'].get('input_tokens'), output_tokens=audit['usage'].get('output_tokens'),
                    queue_ms=(requested-queued)*1000 if requested is not None else None,
                    request_ms=((request_finished or time.monotonic())-requested)*1000 if requested is not None else None,
                    response_received=audit['response_received'], validation_status=audit.get('validation_status'),
                    finish_reason=audit.get('finish_reason'), http_status=audit.get('http_status'),
                    diagnostic_id=audit.get('diagnostic_id'), tool_count=audit.get('tool_count'))

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
