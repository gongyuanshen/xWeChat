"""只读真实解密快照，记录读取数量和游标校验，不保存聊天正文、不连接实时微信或模型。"""
import argparse
import asyncio
import json
import os
import sqlite3
import time
from pathlib import Path
from unittest.mock import patch


async def verify(root, output):
    from wechat_decrypt_tool.ai.agent_tools import ChatTools
    connect = sqlite3.connect
    def readonly(database, *args, **kwargs):
        if isinstance(database, (str, Path)):
            candidate = str(database)
            if candidate.startswith('file:'):
                candidate = candidate[5:].split('?',1)[0]
            path = Path(candidate).resolve()
            if path.is_relative_to(root):
                database = path.as_uri() + '?mode=ro&immutable=1'
                kwargs['uri'] = True
        return connect(database,*args,**kwargs)
    before = {str(p.relative_to(root)):(p.stat().st_size,p.stat().st_mtime_ns) for p in root.glob('*.db')}
    report = {'source':'existing_decrypted_snapshot_readonly', 'realtime':False, 'model_calls':0, 'chats':[]}
    with readonly(root / 'session.db') as db:
        candidates = [row[0] for row in db.execute('SELECT username FROM SessionTable ORDER BY sort_timestamp DESC').fetchall()]
    def resolve(account):
        if account != root.name: raise ValueError('只允许指定账号的只读快照')
        return root
    try:
        with patch('sqlite3.connect',readonly), patch('wechat_decrypt_tool.chat_helpers._resolve_account_dir',resolve), patch('wechat_decrypt_tool.account_source_policy.account_prefers_decrypted_snapshot',return_value=True):
            tools = ChatTools()
            for group in (True,False):
                selected = [u for u in candidates if u.endswith('@chatroom') == group and not u.startswith(('gh_','filehelper')) and u != root.name][:15]
                for username in selected:
                    page = await tools.time_window(root.name,username,0,int(time.time()),8000)
                    # 自适应二分可能先返回空时间段；有稳定游标时继续，不把空页当成会话为空。
                    for _ in range(40):
                        if page['messages'] or not page['next_state']: break
                        page = await tools.time_window(root.name,username,0,int(time.time()),8000,page['next_state'])
                    if not page['messages']: continue
                    assert all(m['username'] == username for m in page['messages'])
                    assert len({m['source'] for m in page['messages']}) == len(page['messages'])
                    state = page['next_state']
                    if state and not state.get('partial_source'):
                        following = await tools.time_window(root.name,username,0,int(time.time()),8000,state)
                        assert not {m['source'] for m in page['messages']} & {m['source'] for m in following['messages']}
                    report['chats'].append({'kind':'group' if group else 'private','read_messages':len(page['messages']),'continuation_checked':bool(state and not state.get('partial_source'))})
                    break
            assert {item['kind'] for item in report['chats']} == {'group','private'}
            report['passed'] = True
    finally:
        after = {str(p.relative_to(root)):(p.stat().st_size,p.stat().st_mtime_ns) for p in root.glob('*.db')}
        report['source_metadata_unchanged'] = before == after
        if not report['source_metadata_unchanged']: report['passed'] = False
        (output / 'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    assert report['source_metadata_unchanged']
    print(json.dumps(report,ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-dir',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    output = args.output.resolve(); output.mkdir(parents=True,exist_ok=False)
    os.environ['WECHAT_TOOL_DATA_DIR'] = str(output)
    os.environ['WECHAT_TOOL_OUTPUT_DIR'] = str(output / 'output')
    asyncio.run(verify(args.account_dir.resolve(),output))
