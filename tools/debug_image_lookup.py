#!/usr/bin/env python3
"""调试图片查找"""
import sqlite3
from pathlib import Path

account = 'wxid_v4mbduwqtzpt22'
md5 = '8753fcd3b1f8c4470b53551e13c5fbc1'

db_dir = Path(r'd:\abc\PycharmProjects\WeChatDataAnalysis\output\databases') / account
hardlink_db = db_dir / 'hardlink.db'

print(f'Hardlink DB exists: {hardlink_db.exists()}')

if hardlink_db.exists():
    conn = sqlite3.connect(str(hardlink_db))
    conn.row_factory = sqlite3.Row
    
    # List tables
    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    print(f'Tables: {[t[0] for t in tables]}')
    
    # Find image hardlink table
    for t in tables:
        tname = t[0]
        if 'image' in tname.lower() and 'hardlink' in tname.lower():
            print(f'\nChecking table: {tname}')
            cols = conn.execute(f"PRAGMA table_info({tname})").fetchall()
            print(f'Columns: {[c[1] for c in cols]}')
            
            # Search for the md5
            row = conn.execute(f"SELECT * FROM [{tname}] WHERE md5 = ? LIMIT 1", (md5,)).fetchone()
            if row:
                print(f'Found: {dict(row)}')
                dir1 = row['dir1']
                dir2 = row['dir2']
                file_name = row['file_name']
                
                # Check dir2id table structure
                dir2id_cols = conn.execute("PRAGMA table_info(dir2id)").fetchall()
                print(f'dir2id columns: {[c[1] for c in dir2id_cols]}')
                
                # Get sample from dir2id
                dir2id_sample = conn.execute("SELECT * FROM dir2id LIMIT 3").fetchall()
                print(f'dir2id sample: {[dict(r) for r in dir2id_sample]}')
                
                # Try to find matching dir2 value using rowid
                dir2id_row = conn.execute("SELECT rowid, username FROM dir2id WHERE rowid = ? LIMIT 1", (dir2,)).fetchone()
                print(f'dir2id lookup for rowid={dir2}: {dict(dir2id_row) if dir2id_row else "NOT FOUND"}')
                
                # Try to construct the path
                weixin_root = Path(r'D:\abc\wechatMSG\xwechat_files\wxid_v4mbduwqtzpt22_1e7a')
                if dir2id_row:
                    dir_name = dir2id_row['username']  # In WeChat 4.x, username column is the folder name
                else:
                    dir_name = str(dir2)
                
                possible_path = weixin_root / str(dir1) / dir_name / file_name
                print(f'Possible path: {possible_path}')
                print(f'Path exists: {possible_path.exists()}')
                
                # Also try _h.dat variant
                h_path = possible_path.with_name(possible_path.stem + '_h.dat')
                print(f'_h.dat path: {h_path}')
                print(f'_h.dat exists: {h_path.exists()}')
            else:
                print(f'MD5 {md5} not found in {tname}')
                
            # Show sample data
            sample = conn.execute(f"SELECT md5, dir1, dir2, file_name FROM [{tname}] LIMIT 3").fetchall()
            print(f'Sample data:')
            for s in sample:
                print(f'  md5={s[0]}, dir1={s[1]}, dir2={s[2]}, file_name={s[3]}')
    
    conn.close()
