"""AI 运行诊断：只记录白名单元数据，不序列化业务对象或异常正文。"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from functools import wraps
import inspect
import json
import logging
import re
import threading
import time
import uuid
import httpx
import httpcore


context = ContextVar('ai_diagnostic_context', default={})
logger = logging.getLogger('wechat_decrypt_tool.ai.diagnostics')
HEADER = 'X-WCDA-AI-Trace'
_TOKEN = re.compile(r'[^A-Za-z0-9_.:@/+\-]')
_IDS = {'trace_id', 'operation_id', 'parent_operation_id', 'execution_id', 'call_id',
        'diagnostic_id', 'task_id', 'run_id', 'thread_id', 'rule_id', 'profile_id',
        'account', 'username', 'source_id', 'generation', 'ticket_id', 'session_id'}
_LABELS = {'phase', 'status', 'reason_code', 'error_type', 'error_module', 'error_category', 'provider',
           'protocol', 'model', 'purpose', 'mode', 'action', 'data_source', 'actual_device',
           'strategy', 'runtime', 'platform', 'arch', 'suffix', 'file', 'finish_reason',
           'validation_status', 'kind', 'component', 'method', 'route', 'origin', 'stage_code'}
_COUNTS = {'duration_ms', 'queue_ms', 'request_ms', 'first_token_ms', 'attempt', 'http_status',
           'errno', 'winerror', 'pid', 'exit_code', 'revision', 'profile_revision', 'version',
           'scope_revision', 'offset', 'next_offset', 'chat_index', 'start', 'end', 'count',
           'message_count', 'source_count', 'read_count', 'analyzed', 'segments', 'chunks',
           'processed', 'embedded', 'unchanged', 'returned', 'image_count', 'input_tokens',
           'output_tokens', 'tool_count', 'invalid_tool_count', 'bytes', 'total', 'wait_seconds',
           'device_id', 'batch_size', 'input_budget', 'material_budget', 'previous_budget', 'index', 'level',
           'cached_count', 'failed_count', 'matches', 'omitted', 'event_id', 'after',
           'elapsed_ms', 'suppressed_count', 'dropped_count', 'queued', 'text_chars',
           'models', 'tools', 'media', 'seconds', 'keyword_count', 'semantic_count', 'merge_level', 'sqlite_errorcode'}
_FLAGS = {'cached', 'usage_known', 'response_received', 'has_more', 'using_fallback',
          'enabled', 'incremental', 'rebuild', 'resume', 'complete', 'changed', 'notify',
          'hide_content', 'vision', 'supported', 'frozen', 'truncated', 'committed'}
_AREAS = {'model':'模型调用', 'profile':'模型配置', 'summary':'总结与提醒', 'agent':'Agent 处理',
          'media':'附件解析', 'messages':'消息读取', 'search':'本地检索', 'index':'索引处理',
          'download':'模型下载', 'gpu':'GPU 组件', 'inference':'本地推理', 'client':'客户端',
          'http':'接口请求', 'storage':'业务存储', 'background':'后台调度', 'lifecycle':'服务启停', 'runtime':'运行环境'}
_STEPS = {'started':'开始', 'finished':'步骤结束', 'failed':'失败', 'interrupted':'中断',
          'cache':'复用缓存', 'retry':'准备重试', 'fallback':'降级', 'committed':'检查点已提交',
          'skipped':'跳过', 'recovered':'已恢复', 'terminal':'运行结束', 'state':'状态变化',
          'acquired':'取得执行额度', 'compatibility':'兼容切换', 'progress':'进度汇总'}

# 只调整 AI 事件的详细程度，不修改根 logger、handler 或其他模块的级别。
# 正常分页、分段、批次及重复包装步骤仅在 DEBUG 下记录，失败始终保留。
_DETAIL_PREFIXES = (
    'messages.page.', 'media.', 'index.page.', 'index.batch.', 'index.commit.',
    'index.search.', 'inference.encode.', 'inference.batch.', 'model.file.verify.',
    'model.invoke.', 'model.catalog.page.', 'agent.model.call.', 'agent.context.',
    'agent.analysis.', 'agent.merge.segment.', 'agent.read.', 'agent.step.',
    'agent.execute_tool.', 'summary.conversation.read.', 'summary.segment.',
    'summary.merge.', 'summary.read_conversations.', 'summary.graph_read.',
    'summary.graph_analyze.', 'summary.graph_overview.', 'summary.summarize_parts.',
    'summary.merge_summaries.', 'summary.run_rule.',
)
_DETAIL_EVENTS = frozenset({
    'summary.rule.skipped', 'summary.read.cache', 'agent.budget.consumed',
    'agent.tool.cache', 'model.call.acquired', 'model.call.first_token',
    'search.ticket.hit', 'search.ticket.expired', 'search.recall.finished',
    'search.hybrid.started', 'client.sse.open', 'client.response.stale',
    'client.source.ready', 'client.navigation.started', 'client.navigation.finished',
    'client.notification.duplicate',
})
_PROGRESS_EVENTS = frozenset({'index.checkpoint.committed', 'download.progress', 'gpu.file.progress'})
_progress_times = OrderedDict()
_progress_lock = threading.Lock()


def _event_level(name, level, error, fields):
    # 显式告警、失败元数据和正常中断不能被详细事件规则降级。
    if (level != logging.INFO or error is not None or fields.get('error_type')
            or fields.get('status') in {'failed', 'error', 'partial'}
            or fields.get('validation_status') == 'failed'
            or name.endswith(('.failed', '.interrupted', '.fallback', '.retry'))):
        return level
    if name in _PROGRESS_EVENTS:
        values = {**context.get(), **fields}
        key = (name, values.get('task_id') or values.get('run_id') or values.get('trace_id'),
               values.get('execution_id'))
        with _progress_lock:
            now = time.monotonic()
            previous = _progress_times.get(key)
            if previous is not None and now - previous < 60:
                return logging.DEBUG
            _progress_times[key] = now
            _progress_times.move_to_end(key)
            # 已完成任务不需要永久占用节流状态。
            if len(_progress_times) > 512:
                _progress_times.popitem(last=False)
        return logging.INFO
    return logging.DEBUG if name in _DETAIL_EVENTS or name.startswith(_DETAIL_PREFIXES) else level


def new_id():
    return uuid.uuid4().hex


def trace_id(value=None):
    value = str(value or '').replace('-', '').lower()
    return value if re.fullmatch(r'[a-f0-9]{32}', value) else new_id()


def safe_fields(values):
    result = {}
    for key, value in values.items():
        if value is None:
            continue
        if key in _COUNTS and isinstance(value, (int, float)) and not isinstance(value, bool):
            if float('-inf') < value < float('inf'):
                result[key] = round(value, 3) if isinstance(value, float) else value
        elif key in _FLAGS and isinstance(value, bool):
            result[key] = value
        elif key in _IDS | _LABELS and isinstance(value, (str, int)):
            result[key] = _TOKEN.sub('_', str(value))[:200]
        elif key == 'changed_fields' and isinstance(value, (list, tuple)):
            # 只接受代码定义的字段名，不输出配置值。
            result[key] = [str(v) for v in value[:40] if re.fullmatch(r'[a-z_]{1,40}', str(v))]
        elif key == 'frames' and isinstance(value, list):
            result[key] = [{'file': _TOKEN.sub('_', str(f.get('file', '')))[:100],
                            'function': _TOKEN.sub('_', str(f.get('function', '')))[:100], 'line': f['line']}
                           for f in value[-20:] if isinstance(f, dict) and type(f.get('line')) is int]
    return result


def exception_fields(error):
    """保留栈位置与错误分类，禁止异常消息、局部变量和源码行进入日志。"""
    fields = {'error_type': type(error).__name__, 'error_module': type(error).__module__}
    for source, target in [('status_code', 'http_status'), ('errno', 'errno'), ('winerror', 'winerror'), ('sqlite_errorcode','sqlite_errorcode')]:
        value = getattr(error, source, None)
        if isinstance(value, int):
            fields[target] = value
    response_status = getattr(getattr(error, 'response', None), 'status_code', None)
    if isinstance(response_status, int): fields['http_status'] = response_status
    detail = getattr(error, 'detail', None)
    category = getattr(error, 'category', None) or (detail.get('category') if isinstance(detail, dict) else None)
    if category in {'runtime', 'gpu', 'model', 'input', 'process', 'timeout', 'cancelled',
                    'authentication', 'configuration', 'connection', 'protocol', 'service', 'rate_limit', 'internal'}:
        fields['error_category'] = category
    else:
        status = fields.get('http_status')
        name = type(error).__name__.lower()
        fields['error_category'] = ('authentication' if status in (401,403) else 'rate_limit' if status==429
            else 'timeout' if 'timeout' in name else 'context' if name=='contextoverflow'
            else 'validation' if isinstance(error, ValueError) else 'service' if status and status>=500
            else 'configuration' if status else 'connection' if isinstance(error, (httpx.TransportError, httpcore.NetworkError, httpcore.ProtocolError)) or any(x in name for x in ('network','connection','connect')) else 'internal')
    frames = []
    tb = error.__traceback__
    while tb:
        code = tb.tb_frame.f_code
        filename = code.co_filename.replace('\\', '/').rsplit('/', 1)[-1]
        frames.append({'file': _TOKEN.sub('_', filename)[:100],
                       'function': _TOKEN.sub('_', code.co_name)[:100], 'line': tb.tb_lineno})
        tb = tb.tb_next
    fields['frames'] = frames[-20:]
    return fields


def event(name, *, level=logging.INFO, error=None, **fields):
    """日志失败不得覆盖业务结果；调用方只能传入明确挑选的元数据。"""
    try:
        if not logger.isEnabledFor(level):
            return
        level = _event_level(name, level, error, fields)
        if not logger.isEnabledFor(level):
            return
        data = safe_fields({**context.get(), **fields})
        if error is not None:
            data.update(exception_fields(error))
        description = _AREAS.get(name.split('.')[0], 'AI') + '：' + _STEPS.get(name.rsplit('.',1)[-1], '处理记录')
        logger.log(level, '[ai.%s] %s；运行诊断 %s', name, description,
                   json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False))
    except Exception:
        pass


@contextmanager
def bind(**fields):
    values = {**context.get(), **safe_fields(fields)}
    # 状态属于当前事件，不将任务刚入队时的状态误传给后续步骤。
    values.pop('status', None)
    token = context.set(values)
    try:
        yield
    finally:
        context.reset(token)


def executor_call(executor, function, *args):
    """run_in_executor 不自动传递 ContextVar，每次提交独立复制。"""
    return asyncio.get_running_loop().run_in_executor(executor, copy_context().run, function, *args)


def _metadata(arguments, result=None, id_field=None):
    fields = safe_fields(arguments)
    state = arguments.get('state')
    if isinstance(state, dict):
        fields.update(safe_fields({k: state[k] for k in ('task_id','run_id','version','index') if k in state}))
    for key in ('task', 'run', 'job', 'options', 'profile', 'spec', 'rule'):
        value = arguments.get(key)
        if not isinstance(value, dict):
            continue
        fields.update(safe_fields({k: value[k] for k in ('account', 'version', 'revision', 'profile_revision',
            'model', 'provider', 'protocol', 'status', 'generation', 'processed', 'embedded', 'offset',
            'notify', 'hide_content', 'vision') if k in value}))
        if key == 'profile':
            fields['profile_id'] = value.get('id', '')
        elif key == 'spec':
            fields['model'] = value.get('id', '')
            fields['runtime'] = value.get('revision', '')
        elif key == 'rule':
            fields['rule_id'] = value.get('id', '')
        elif key in ('task', 'run', 'job'):
            fields['run_id' if key == 'run' else 'task_id'] = value.get('id', '')
            if value.get('trace_id'):
                fields['trace_id'] = value['trace_id']
    action = arguments.get('action')
    if hasattr(action, 'action'):
        fields['action'] = action.action
    message = arguments.get('message')
    if isinstance(message, dict):
        fields.update(safe_fields({'source_id': message.get('source'), 'kind': message.get('kind')}))
    if id_field and isinstance(arguments.get('id'), str):
        fields[id_field] = arguments['id']
    if isinstance(arguments.get('texts'), list):
        fields['count'] = len(arguments['texts'])
    if isinstance(result, dict):
        fields.update(safe_fields({k: result[k] for k in ('status', 'version', 'revision', 'offset',
            'processed', 'embedded', 'has_more', 'cached', 'complete', 'actual_device', 'using_fallback') if k in result}))
        if id_field and result.get('id'):
            fields[id_field] = result.get('thread_id', result['id']) if id_field=='thread_id' else result['id']
        if isinstance(result.get('messages'), list):
            fields['returned'] = len(result['messages'])
        if isinstance(result.get('items'), list):
            fields['count'] = len(result['items'])
    return fields


def observed(name, *, id_field=None, execution=False):
    """为完整业务步骤生成成对事件；不包裹高频状态刷新与逐字回调。"""
    def decorate(function):
        signature = inspect.signature(function)
        def begin(args, kwargs):
            values = signature.bind_partial(*args, **kwargs).arguments
            fields = _metadata(values, id_field=id_field)
            parent = context.get()
            fields.update(trace_id=fields.get('trace_id') or parent.get('trace_id') or new_id(), operation_id=new_id(),
                          parent_operation_id=parent.get('operation_id', ''))
            if execution:
                fields['execution_id'] = new_id()
                owner = values.get('self')
                record_id = fields.get(id_field) if id_field else None
                if owner and record_id and hasattr(owner, 'store'):
                    kind = 'agent_run' if id_field == 'run_id' else 'task'
                    try:
                        record = owner.store.get(kind, record_id) or {}
                    except Exception as error:
                        event('execution.lookup_failed', level=logging.ERROR, error=error, **fields)
                        record = {}
                    fields['trace_id'] = record.get('trace_id') or fields['trace_id']
                    fields.update(safe_fields({k:record[k] for k in ('account','thread_id','rule_id','version') if k in record}))
            elif id_field == 'run_id' and fields.get('run_id') and hasattr(values.get('self'), 'store'):
                try:
                    record = values['self'].store.get('agent_run', fields['run_id']) or {}
                    fields.update(safe_fields({k:record[k] for k in ('account','thread_id','version','scope_revision') if k in record}))
                except Exception:
                    pass  # 业务步骤会沿原路径抛出存储异常。
            return values, fields
        def failed(error):
            control = isinstance(error, asyncio.CancelledError) or type(error).__name__ in {
                'TaskCancelled', 'Revised', 'AgentControl'} or getattr(error, 'category', '') == 'cancelled'
            event(name + ('.interrupted' if control else '.failed'),
                  level=logging.INFO if control else logging.WARNING if type(error).__name__=='ContextOverflow' else logging.ERROR, error=error)
        if inspect.iscoroutinefunction(function):
            @wraps(function)
            async def wrapped(*args, **kwargs):
                values, fields = begin(args, kwargs)
                with bind(**fields):
                    started = time.monotonic()
                    event(name + '.started')
                    try:
                        result = await function(*args, **kwargs)
                    except BaseException as error:
                        failed(error)
                        raise
                    event(name + '.finished', duration_ms=(time.monotonic()-started)*1000,
                          **_metadata(values, result, id_field))
                    return result
        else:
            @wraps(function)
            def wrapped(*args, **kwargs):
                values, fields = begin(args, kwargs)
                with bind(**fields):
                    started = time.monotonic()
                    event(name + '.started')
                    try:
                        result = function(*args, **kwargs)
                    except BaseException as error:
                        failed(error)
                        raise
                    event(name + '.finished', duration_ms=(time.monotonic()-started)*1000,
                          **_metadata(values, result, id_field))
                    return result
        return wrapped
    return decorate


class RepeatedFailures:
    """重复故障首次立即记录，后续每分钟汇总；恢复时补齐被合并次数。"""
    def __init__(self):
        self.items = {}
        self.lock = threading.Lock()

    def report(self, key, error):
        with self.lock:
            now = time.monotonic()
            if key not in self.items and len(self.items) >= 512:
                self.items.pop(next(iter(self.items)))
            state = self.items.setdefault(key, {'first': now, 'last': None, 'count': 0})
            state['count'] += 1
            if state['last'] is None or now-state['last'] >= 60:
                event('background.failure', level=logging.ERROR, error=error, phase=key,
                      count=state['count'], elapsed_ms=(now-state['first'])*1000)
                state['last'], state['count'] = now, 0

    def recovered(self, key):
        with self.lock:
            state = self.items.pop(key, None)
            if state:
                event('background.recovered', phase=key, suppressed_count=state['count'],
                      elapsed_ms=(time.monotonic()-state['first'])*1000)


failures = RepeatedFailures()
