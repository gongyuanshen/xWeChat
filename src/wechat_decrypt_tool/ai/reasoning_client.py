"""保留兼容接口扩展字段的官方 OpenAI SDK 传输层，不改变 Agent 执行循环。"""
import copy
import json

from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain_core.utils.function_calling import convert_to_openai_tool


class ReasoningClient:
    def __init__(self, profile, fallback, extra=None):
        self.profile, self.fallback, self.options = profile, fallback, dict(extra or {})

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, 'fallback'), name)

    def bind_tools(self, tools, **kwargs):
        bound = copy.copy(self)
        bound.options = {**self.options, 'tools': [convert_to_openai_tool(t) for t in tools], **kwargs}
        return bound

    def with_structured_output(self, *args, **kwargs):
        # 既有单次模式解析继续使用现有客户端；Agent 的多轮工具消息经过本类。
        return self.fallback.with_structured_output(*args, **kwargs)

    @staticmethod
    def messages(messages):
        result = []
        for message in messages:
            role = 'system' if isinstance(message, SystemMessage) else 'user' if isinstance(message, HumanMessage) else 'tool' if isinstance(message, ToolMessage) else 'assistant'
            item = {'role': role, 'content': message.content}
            if isinstance(message, ToolMessage):
                item['tool_call_id'] = message.tool_call_id
            if isinstance(message, AIMessage):
                if message.tool_calls:
                    item['tool_calls'] = [{'id': c['id'], 'type': 'function', 'function': {'name': c['name'], 'arguments': json.dumps(c['args'], ensure_ascii=False)}} for c in message.tool_calls]
                reasoning = message.additional_kwargs.get('reasoning_content')
                if reasoning is not None:
                    item['reasoning_content'] = reasoning
            result.append(item)
        return result

    @staticmethod
    def usage(value):
        if value is None:
            return None
        result = {'input_tokens': value.prompt_tokens, 'output_tokens': value.completion_tokens, 'total_tokens': value.total_tokens}
        cached = getattr(getattr(value, 'prompt_tokens_details', None), 'cached_tokens', None)
        reasoning = getattr(getattr(value, 'completion_tokens_details', None), 'reasoning_tokens', None)
        if cached is not None:
            result['input_token_details'] = {'cache_read': cached}
        if reasoning is not None:
            result['output_token_details'] = {'reasoning': reasoning}
        return result

    def client(self):
        from openai import AsyncOpenAI
        from .providers import model_base_url
        return AsyncOpenAI(api_key=self.profile.get('api_key') or 'local', base_url=model_base_url(self.profile['base_url']), max_retries=0, timeout=90)

    async def astream(self, messages, config=None, **kwargs):
        options = {**self.options, **kwargs}
        if options.pop('stream_usage', False):
            options['stream_options'] = {'include_usage': True}
        async with self.client() as client:
            stream = await client.chat.completions.create(model=self.profile['model'], messages=self.messages(messages), stream=True, **options)
            async with stream:
                async for raw in stream:
                    usage = self.usage(raw.usage)
                    if not raw.choices:
                        if usage:
                            yield AIMessageChunk(content='', id=raw.id, usage_metadata=usage)
                        continue
                    choice, delta = raw.choices[0], raw.choices[0].delta
                    reasoning = getattr(delta, 'reasoning_content', None)
                    calls = [{'name': c.function.name if c.function else None, 'args': c.function.arguments if c.function else '',
                        'id': c.id, 'index': c.index} for c in delta.tool_calls or []]
                    yield AIMessageChunk(content=delta.content or '', id=raw.id, tool_call_chunks=calls,
                        additional_kwargs={'reasoning_content': reasoning} if reasoning is not None else {},
                        usage_metadata=usage, response_metadata={'finish_reason': choice.finish_reason} if choice.finish_reason else {})

    async def ainvoke(self, messages, config=None, **kwargs):
        options = {**self.options, **kwargs}
        options.pop('stream_usage', None)
        async with self.client() as client:
            raw = await client.chat.completions.create(model=self.profile['model'], messages=self.messages(messages), stream=False, **options)
        choice = raw.choices[0]
        message = choice.message
        calls, invalid = [], []
        for call in message.tool_calls or []:
            try:
                args = json.loads(call.function.arguments)
                if not isinstance(args, dict):
                    raise ValueError('工具参数必须为对象')
                calls.append({'id': call.id, 'name': call.function.name, 'args': args, 'type': 'tool_call'})
            except ValueError:
                invalid.append({'id': call.id, 'name': call.function.name, 'args': call.function.arguments, 'error': '无效的 JSON 工具参数', 'type': 'invalid_tool_call'})
        reasoning = getattr(message, 'reasoning_content', None)
        return AIMessage(content=message.content or '', id=raw.id, tool_calls=calls, invalid_tool_calls=invalid,
            additional_kwargs={'reasoning_content': reasoning} if reasoning is not None else {},
            usage_metadata=self.usage(raw.usage), response_metadata={'finish_reason': choice.finish_reason})
