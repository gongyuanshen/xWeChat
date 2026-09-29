"""跨轮上下文投影；原始检查点、归档与每轮执行状态保持隔离。"""
import hashlib
import json

from langchain_core.messages import AIMessage, ToolMessage, message_to_dict, messages_from_dict


def encode(messages):
    return [message_to_dict(m) for m in messages]


def fingerprint(messages):
    return hashlib.sha256(json.dumps(encode(messages), ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def effective_messages(service, run_id, version, values):
    messages = list(values.get('messages', []))
    event = values.get('_summarization_event')
    durable = service.workspace.get(run_id, version, 'context:event')
    if durable:
        cutoff = durable['cutoff_index']
        if cutoff <= len(messages) and fingerprint(messages[:cutoff]) == durable['prefix_hash']:
            if not event or cutoff >= event.get('cutoff_index', 0):
                event = {**durable, 'summary_message': messages_from_dict([durable['summary_message']])[0]}
    if event and 0 < event.get('cutoff_index', 0) <= len(messages):
        return [event['summary_message'], *messages[event['cutoff_index']:]]
    return messages


def close_interrupted_calls(messages):
    """跨轮只继承已发生的交互；未返回的调用补中断结果，绝不重放执行。"""
    pending, result = {}, []
    for message in messages:
        if not isinstance(message, ToolMessage) and pending:
            result.extend(ToolMessage(content='该调用已中断，未取得结果；需要时请重新确认当前查询范围。',
                                      tool_call_id=key) for key in pending)
            pending.clear()
        result.append(message)
        if isinstance(message, AIMessage):
            pending.update({call['id']: call for call in message.tool_calls})
        elif isinstance(message, ToolMessage):
            pending.pop(message.tool_call_id, None)
    result.extend(ToolMessage(content='该调用已中断，未取得结果；需要时请重新确认当前查询范围。',
                              tool_call_id=key) for key in pending)
    return result


def origins(service, run):
    """只允许访问明确继承的同账号、同对话旧版本。"""
    result = []
    for item in run.get('context_origins', []):
        origin = service.store.get('agent_run', item['run_id'])
        if (origin and origin['account'] == run['account'] and origin['thread_id'] == run['thread_id']
                and (origin['id'] != run['id'] or item['version'] < run['version'])):
            result.append(item)
    return result


async def inherit_context(service, run, saver):
    if service.workspace.get(run['id'], run['version'], 'context:seed') is not None:
        return
    previous_id = run['id'] if run['version'] > 1 else run.get('previous_run_id')
    previous = service.store.get('agent_run', previous_id or '')
    if not previous or previous['account'] != run['account'] or previous['thread_id'] != run['thread_id']:
        return
    version = run['version'] - 1 if previous_id == run['id'] else previous['version']
    config = {'configurable': {'thread_id': service.checkpoint_id(previous, version)}}
    # 官方图负责折叠增量检查点；直接读取 saver 最新行可能只有 __pregel_tasks。
    values = {}
    if previous.get('engine_version') == 3:
        graph, _ = service.graph({**previous, 'version': version}, saver)
        checkpoint = await graph.aget_state(config)
        values = checkpoint.values or {}
    messages = effective_messages(service, previous_id, version, values)
    if not messages:
        saved = service.workspace.get(previous_id, version, 'context:seed')
        if saved:
            messages = messages_from_dict(saved['messages'])
    chain = [*previous.get('context_origins', []), {'run_id': previous_id, 'version': version}]
    chain = list({(item['run_id'], item['version']): item for item in chain}.values())
    service.update(run['id'], context_origins=chain,
                   references={**previous.get('references', {}), **run.get('references', {})})
    if previous_id != run['id']:
        service.workspace.inherit(previous_id, run['id'])
    if messages:
        service.workspace.put(run['id'], run['version'], 'context:seed', 'context_snapshot',
            {'messages': encode(close_interrupted_calls(messages)), 'origin_run': previous_id, 'origin_version': version})
