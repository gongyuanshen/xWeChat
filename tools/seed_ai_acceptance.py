"""创建可核对的桌面 AI 验收聊天；只创建专用账号，不覆盖现有账号。"""
import argparse
import hashlib
import json
import sqlite3
import time
from pathlib import Path


def seed(output: Path):
    account = 'wxid_ai_acceptance'
    root = output / 'databases' / account
    root.mkdir(parents=True, exist_ok=False)
    now = int(time.time())
    conversations = {
        'acceptance_project@chatroom': ('验收 · 海桥项目', [
            '海桥项目第一版报价是 12800 元，包含界面设计和开发。',
            '客户要求增加数据导出模块，原来的预算不够。',
            '更新报价：海桥项目总价调整为 15600 元，包含数据导出，不再使用 12800 元旧报价。',
            '交付日从 9 月 18 日改到 9 月 25 日，原因是新增导出模块。',
            '请小林在周五前确认导出字段清单，小周负责测试。',
            '最终确认：15600 元，9 月 25 日交付，小林负责确认字段，小周负责测试。',
        ]),
        'acceptance_friend': ('验收 · 小林', [
            '聚餐原定周五晚上六点，在松林餐厅。',
            '我周五加班，能换个时间吃饭吗？',
            '大家的晚饭约会改到周六晚上七点，地点仍然是松林餐厅。',
            '我已经预订了六个人的座位，不需要再订。',
        ]),
        'acceptance_other@chatroom': ('验收 · 青禾项目', [
            '青禾项目报价 8600 元，交付时间是 10 月 8 日。',
            '这是另一个项目，不属于海桥项目范围。',
        ]),
    }
    with sqlite3.connect(root / 'contact.db') as db:
        schema = '(username TEXT, remark TEXT, nick_name TEXT, alias TEXT, local_type INTEGER, verify_flag INTEGER, big_head_url TEXT, small_head_url TEXT)'
        for table in ('contact', 'stranger'):
            db.execute(f'CREATE TABLE {table} {schema}')
        for username, name in [(account, 'AI 桌面验收'), *[(u, x[0]) for u, x in conversations.items()]]:
            db.execute('INSERT INTO contact VALUES (?,?,?,?,?,?,?,?)', (username, '', name, '', 1, 0, '', ''))
    with sqlite3.connect(root / 'session.db') as sessions, sqlite3.connect(root / 'message_0.db') as db:
        sessions.execute('CREATE TABLE SessionTable(username TEXT, is_hidden INTEGER, summary TEXT, draft TEXT, last_msg_type INTEGER, last_msg_sub_type INTEGER, sort_timestamp INTEGER, last_timestamp INTEGER, unread_count INTEGER)')
        db.execute('CREATE TABLE Name2Id(rowid INTEGER PRIMARY KEY,user_name TEXT)')
        db.execute('INSERT INTO Name2Id VALUES(1,?)', (account,))
        for index, (username, (name, texts)) in enumerate(conversations.items(), 2):
            db.execute('INSERT INTO Name2Id VALUES(?,?)', (index, username))
            table = 'msg_' + hashlib.md5(username.encode()).hexdigest()
            db.execute(f'CREATE TABLE {table}(local_id INTEGER,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,compress_content BLOB)')
            filler = [f'日常同步第 {i+1} 条：今天的例行检查已完成，暂无新的事项。' for i in range(35)]
            for i, text in enumerate(filler + texts, 1):
                db.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?,?,?)', (i, index*100000+i, 1, i, index if i%2 else 1, now-86400+i*60, text, None))
            sessions.execute('INSERT INTO SessionTable VALUES(?,0,?,"",1,0,?,?,0)', (username, texts[-1], now-index, now-index))
    (root / 'account.json').write_text(json.dumps({'username': account, 'nick': 'AI 桌面验收', 'avatar_url': ''}, ensure_ascii=False), encoding='utf8')
    (root / '_source.json').write_text(json.dumps({'import_mode': 'manual_import', 'account': account, 'nickname': 'AI 桌面验收'}), encoding='utf8')
    seed_moments(root, now)
    print(json.dumps({'account': account, 'conversations': len(conversations), 'path': str(root)}))


def seed_moments(root: Path, now: int):
    # 单独样例表，方便回归朋友圈布局；绝不连接或覆盖已有账号的 sns.db。
    target = root / 'sns.db'
    if target.exists(): raise ValueError('朋友圈验收样例已存在')
    with sqlite3.connect(target) as db:
        db.execute('CREATE TABLE SnsTimeLine(tid INTEGER, user_name TEXT, content TEXT)')
        xml = (f'<TimelineObject><id>42</id><username>acceptance_friend</username><createTime>{now}</createTime>'
               '<contentDesc>本地验收示例：今天已完成排期确认，接下来核对交付内容。</contentDesc>'
               '<ContentObject><contentStyle>1</contentStyle></ContentObject></TimelineObject>')
        db.execute('INSERT INTO SnsTimeLine VALUES(42,?,?)', ('acceptance_friend', xml))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    seed(parser.parse_args().output)
