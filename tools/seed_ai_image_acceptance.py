"""建立独立图片问答样例；金额和日期仅存在于图片，不预填模型分析结果。"""
import argparse
import hashlib
import io
import json
import sqlite3
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from seed_ai_acceptance import seed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--font', type=Path, required=True)
    args = parser.parse_args()
    if not args.font.is_file():
        parser.error('需要本机可用的 TrueType 字体')
    seed(args.output)
    account = 'wxid_ai_acceptance'
    root = args.output / 'databases' / account
    cards = [
        ('acceptance_project@chatroom', '视觉验收：请看后面的海桥新版报价图。',
         ['PROJECT HAIQIAO', 'REVISION B', 'QUOTE: CNY 18,400', 'DELIVERY: 2026-10-16', 'Dashboard + CSV export']),
        ('acceptance_friend', '视觉验收：请看后面的聚餐确认单。',
         ['DINNER CONFIRMATION', 'SATURDAY 19:30', '8 GUESTS', 'MAPLE RESTAURANT']),
        ('acceptance_other@chatroom', '其他图片存档，与本次视觉验收问题无关。',
         ['UNRELATED ARCHIVE', 'CODE 7729']),
    ]
    expected = []
    now = int(time.time()) - 180
    with sqlite3.connect(root / 'message_0.db') as db, sqlite3.connect(root / 'session.db') as sessions:
        for index, (username, caption, lines) in enumerate(cards):
            image = Image.new('RGB', (1000, 680), '#f5faf7')
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle((35, 35, 965, 645), radius=24, fill='white', outline='#14834d', width=4)
            for line, text in enumerate(lines):
                font = ImageFont.truetype(str(args.font), 44 if line == 0 else 38)
                draw.text((72, 85 + line * 103), text, fill='#145c3b' if line == 0 else '#15221b', font=font)
            buffer = io.BytesIO(); image.save(buffer, format='PNG')
            data = buffer.getvalue(); md5 = hashlib.md5(data).hexdigest()
            path = root / 'resource' / md5[:2] / (md5 + '.png')
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
            table = 'msg_' + hashlib.md5(username.encode()).hexdigest()
            local = db.execute(f'SELECT max(local_id) FROM "{table}"').fetchone()[0] + 1
            sender = db.execute('SELECT rowid FROM Name2Id WHERE user_name=?', (username,)).fetchone()[0]
            for offset, (kind, content) in enumerate(((1, caption), (3, f'<msg><img md5="{md5}" /></msg>'))):
                db.execute(f'INSERT INTO "{table}" VALUES(?,?,?,?,?,?,?,?)',
                           (local + offset, 9800000 + index * 10 + offset, kind, local + offset, sender,
                            now + index * 10 + offset, content, None))
            sessions.execute('UPDATE SessionTable SET summary=?,last_msg_type=3,sort_timestamp=?,last_timestamp=? WHERE username=?',
                             ('[图片]', now + index * 10 + 1, now + index * 10 + 1, username))
            expected.append({'username': username, 'md5': md5, 'path': str(path.resolve()), 'text_in_image': lines,
                             'source': hashlib.sha256(f'{account}:{username}:s:{9800000 + index * 10 + 1}'.encode()).hexdigest()[:24],
                             'expected_in_answer': index < 2})
    (args.output / 'image-acceptance-oracle.json').write_text(json.dumps(expected, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'images': len(expected), 'database_sha256': hashlib.sha256((root / 'message_0.db').read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
