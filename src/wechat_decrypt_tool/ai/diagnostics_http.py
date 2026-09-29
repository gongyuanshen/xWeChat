"""本机诊断入口：限制体积、事件与字段，绝不接收自由日志文本。"""
import json
import logging
import re
import time

from fastapi import HTTPException
from starlette.responses import JSONResponse

from .diagnostics import HEADER, bind, event, new_id, safe_fields, trace_id

CLIENT_EVENTS = frozenset('request.failed sse.open sse.disconnected sse.recovered sse.invalid response.stale source.ready source.failed navigation.started navigation.finished navigation.failed notification.requested notification.shown notification.failed notification.clicked notification.ack notification.ack_failed notification.duplicate notification.unsupported transport.dropped transport.offline'.split())
CLIENT_IDS = frozenset('trace_id operation_id diagnostic_id task_id run_id thread_id'.split())
CLIENT_COUNTS = frozenset('http_status duration_ms count dropped_count queued event_id version after attempt'.split())
CLIENT_LABELS = {
    'origin': {'frontend', 'desktop'},
    'phase': {'request', 'stream', 'source', 'navigation', 'notification', 'transport'},
    'status': {'success', 'failed', 'pending', 'closed', 'missing', 'stale', 'ready'},
    'reason_code': {'network', 'http', 'parse', 'timeout', 'unsupported', 'overflow', 'offline', 'missing', 'stale', 'rejected'},
    'method': {'GET', 'POST', 'PUT', 'DELETE', 'PATCH'},
    'component': {'ai', 'agent', 'search', 'notification', 'source'},
}


def client_fields(value):
    if not isinstance(value, dict):
        raise ValueError('metadata')
    result = {}
    for key, item in value.items():
        if key == 'source_id' and isinstance(item, str) and re.fullmatch(r'[a-fA-F0-9]{24,32}', item):
            result[key] = item
        elif key in CLIENT_IDS and isinstance(item, str) and re.fullmatch(r'[a-fA-F0-9-]{32,36}', item):
            result[key] = item
        elif key in CLIENT_COUNTS and type(item) in (int, float) and 0 <= item <= 10**12:
            result[key] = item
        elif key in CLIENT_LABELS and isinstance(item, str) and item in CLIENT_LABELS[key]:
            result[key] = item
        else:
            raise ValueError('field')
    return safe_fields(result)


async def ingest(request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 65536:
            raise HTTPException(413, '诊断批次超过 64 KiB')
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict) or set(payload) != {'events'}:
            raise ValueError('batch')
        entries = payload['events']
        if not isinstance(entries, list) or not 1 <= len(entries) <= 50:
            raise ValueError('count')
        validated = []
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {'event', 'metadata'} or entry['event'] not in CLIENT_EVENTS:
                raise ValueError('event')
            validated.append((entry['event'], client_fields(entry['metadata'])))
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise HTTPException(422, '诊断事件或字段无效') from None
    for name, fields in validated:
        event('client.' + name, level=logging.WARNING if name.endswith(('failed', 'invalid', 'dropped', 'offline')) else logging.INFO, **fields)
    return {'accepted': len(validated)}


async def diagnostic_request(request, call_next):
    trace = trace_id(request.headers.get(HEADER) or (request.query_params.get('ai_trace') if request.url.path.endswith('/events') else None))
    started = time.monotonic()
    with bind(trace_id=trace, operation_id=new_id()):
        try:
            response = await call_next(request)
        except Exception as error:
            diagnostic = new_id()
            event('http.failed', level=logging.ERROR, error=error, diagnostic_id=diagnostic,
                  method=request.method, http_status=500)
            response = JSONResponse({'detail': 'AI 服务处理失败，请通过诊断编号查看日志', 'diagnostic_id': diagnostic}, status_code=500)
            response.headers['X-WCDA-AI-Diagnostic'] = diagnostic
        if response.status_code >= 400 and not response.headers.get('X-WCDA-AI-Diagnostic'):
            diagnostic = new_id()
            response.headers['X-WCDA-AI-Diagnostic'] = diagnostic
            route = getattr(request.scope.get('route'), 'path', '/api/ai/unknown')
            event('http.rejected', level=logging.ERROR if response.status_code >= 500 else logging.WARNING,
                  diagnostic_id=diagnostic, method=request.method, route=route, http_status=response.status_code,
                  duration_ms=(time.monotonic()-started)*1000)
        response.headers[HEADER] = trace
        return response
