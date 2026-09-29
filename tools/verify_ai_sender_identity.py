"""用真实原文比较 AI 时间读取和当前聊天接口的发送者身份，不调用模型。"""
import argparse
import asyncio
import json
import os
from pathlib import Path

import httpx


async def verify(args):
    from wechat_decrypt_tool.native_core_client import configure_native_core_entrypoint
    configure_native_core_entrypoint()
    from wechat_decrypt_tool.ai.agent_tools import ChatTools, normalize
    from wechat_decrypt_tool.ai.agent_references import material_references
    from wechat_decrypt_tool.ai.agent_budget import message_payload
    tools = ChatTools()
    output = args.output.resolve()
    if output.is_relative_to(args.data_dir.resolve()):
        raise ValueError('验证报告必须放在原应用数据目录之外')
    page = await tools.time_window(args.account, args.username, args.start, args.end, 32768)
    if page['has_more']:
        raise ValueError('验证区间超过一页，请缩小时间范围')
    messages = page['messages']
    images = [m for m in messages if m['kind'] == 'image']
    if not images:
        raise ValueError('本次区间没有真实图片消息，无法验证图片身份')
    people = await tools.people(args.account)
    group_people = await tools.group_people(args.account, [args.username], people)
    refs = material_references(args.account, messages, [*people, *group_people])
    checks = []
    async with httpx.AsyncClient(base_url=args.backend, timeout=30) as client:
        for message in images:
            response = await client.get('/api/chat/messages/around', params={
                'account': args.account, 'username': args.username, 'anchor_id': message['anchor'],
                'before': 0, 'after': 0, 'source': 'auto'})
            response.raise_for_status()
            candidates = [m for m in response.json()['messages'] if m['id'] == message['anchor']]
            if len(candidates) != 1:
                raise AssertionError('聊天接口没有返回唯一的同一条原消息')
            chat = normalize(args.account, args.username, candidates[0])
            equal = all(message[k] == chat[k] for k in ('source', 'sender_id', 'sender', 'time', 'kind'))
            image_refs = [r for r in refs.values() if r['kind'] == 'image' and r['source'] == message['source']]
            checks.append({'source': message['source'], 'anchor': message['anchor'],
                'sender_id': message['sender_id'], 'sender': message['sender'],
                'sender_aliases': message.get('sender_aliases', []), 'time': message['time'],
                'matches_chat_api': equal, 'image_reference_valid': len(image_refs) == 1 and not image_refs[0]['missing'],
                'model_payload_preserves_aliases': message_payload(message).get('sender_aliases') == message.get('sender_aliases')})
    by_source = {m['source']: m for m in messages}
    image_senders = {m['sender_id'] for m in images}
    mentions = []
    for ref in refs.values():
        if ref['kind'] != 'person' or ref['username'] not in image_senders:
            continue
        for source in ref.get('mentioned_sources', []):
            original = by_source[source]
            if original['sender_id'] != ref['username']:
                mentions.append({'source': source, 'source_sender_id': original['sender_id'],
                                 'source_sender': original['sender'], 'subject_id': ref['username'],
                                 'subject': ref['name'], 'text': original['text'],
                                 'explicit_at_identity': ref['username'] in (original.get('media') or {}).get('atUsernames', [])})
    report = {'data': 'real_realtime', 'remote_model_calls': 0, 'messages_read': len(messages),
              'mentions_of_image_sender': mentions,
              'checks': checks, 'passed': all(c['matches_chat_api'] and c['image_reference_valid'] and
                                            c['model_payload_preserves_aliases'] for c in checks)
                                            and (not args.require_mention or bool(mentions))
                                            and (not args.require_explicit_at or any(m['explicit_at_identity'] for m in mentions))}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report['passed']:
        raise AssertionError('AI 读取与聊天接口身份未对齐，报告已保存')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--native-core-dir', type=Path, required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--username', required=True)
    parser.add_argument('--start', type=int, required=True)
    parser.add_argument('--end', type=int, required=True)
    parser.add_argument('--backend', default='http://127.0.0.1:10392')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--require-mention', action='store_true', help='同时验证其他发言人提到图片发送者的来源关系')
    parser.add_argument('--require-explicit-at', action='store_true', help='要求真实原消息的 @ 元数据验证人物身份')
    args = parser.parse_args()
    if not 0 <= args.start < args.end:
        parser.error('时间范围必须为有效的左闭右开区间')
    from urllib.parse import urlparse
    if urlparse(args.backend).hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('只允许使用本机聊天接口')
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(args.data_dir.resolve())
    os.environ['WCE_NATIVE_CORE_SOURCE_DIR'] = str(args.native_core_dir.resolve())
    asyncio.run(verify(args))


if __name__ == '__main__':
    main()
