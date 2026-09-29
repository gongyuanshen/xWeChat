#!/usr/bin/env python3
"""调试表情消息内容"""

import sqlite3
from pathlib import Path

db_path = Path(r'd:\abc\PycharmProjects\WeChatDataAnalysis\output\databases\wxid_v4mbduwqtzpt22')
msg_dbs = list(db_path.glob('message_*.db'))
print(f'Found {len(msg_dbs)} message databases')

for db in msg_dbs[:1]:
    print(f'\nDatabase: {db.name}')
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    
    # 先查看表结构
    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    print(f'Tables: {[t[0] for t in tables]}')
    
    # 找到消息表
    for t in tables:
        tname = t[0]
        if 'msg' in tname.lower():
            # 查看列名
            cols = conn.execute(f"PRAGMA table_info({tname})").fetchall()
            col_names = [c[1] for c in cols]
            print(f'Table {tname} columns: {col_names}')
            
            # 查找 type=47 的消息
            type_col = 'local_type' if 'local_type' in col_names else 'type'
            content_col = 'message_content' if 'message_content' in col_names else 'content'
            compress_col = 'compress_content' if 'compress_content' in col_names else None
            
            query = f"SELECT * FROM {tname} WHERE {type_col} = 47 LIMIT 3"
            try:
                rows = conn.execute(query).fetchall()
                print(f'Found {len(rows)} emoji messages')
                import zstandard as zstd
                for r in rows:
                    d = dict(r)
                    content = d.get('message_content') or d.get('content') or b''
                    
                    # 尝试解压 message_content
                    if isinstance(content, bytes) and content.startswith(b'\x28\xb5\x2f\xfd'):
                        try:
                            dctx = zstd.ZstdDecompressor()
                            content = dctx.decompress(content).decode('utf-8', errors='replace')
                        except Exception as e:
                            print(f'  zstd decompress message_content failed: {e}')
                    
                    print(f'  Decompressed content (first 800):')
                    print(f'  {str(content)[:800]}')
                    
                    # 提取 md5 和 cdnurl
                    import re
                    md5_match = re.search(r'md5="([^"]+)"', str(content))
                    cdnurl_match = re.search(r'cdnurl="([^"]+)"', str(content))
                    thumburl_match = re.search(r'thumburl="([^"]+)"', str(content))
                    
                    print(f'  md5: {md5_match.group(1) if md5_match else "NOT FOUND"}')
                    print(f'  cdnurl: {cdnurl_match.group(1)[:80] if cdnurl_match else "NOT FOUND"}')
                    print(f'  thumburl: {thumburl_match.group(1)[:80] if thumburl_match else "NOT FOUND"}')
                    break
            except Exception as e:
                print(f'Query failed: {e}')
    conn.close()
