#!/usr/bin/env python3
"""调试媒体文件查找逻辑"""

import sqlite3
from pathlib import Path

# ========== 配置 ==========
ACCOUNT = "wxid_v4mbduwqtzpt22"
MD5 = "0923ad357c321cf286b794f8e5a66333"
USERNAME = "wxid_qmzc7q0xfm0j22"

REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DB_DIR = REPO_ROOT / "output" / "databases" / ACCOUNT

# ========== 读取 _source.json ==========
import json

source_json = OUTPUT_DB_DIR / "_source.json"
print(f"[1] 检查 _source.json: {source_json}")
if source_json.exists():
    with open(source_json, "r", encoding="utf-8") as f:
        source = json.load(f)
    wxid_dir = source.get("wxid_dir", "")
    db_storage_path = source.get("db_storage_path", "")
    print(f"    wxid_dir: {wxid_dir}")
    print(f"    db_storage_path: {db_storage_path}")
else:
    print("    [ERROR] _source.json 不存在!")
    wxid_dir = ""
    db_storage_path = ""

# ========== 检查 hardlink.db ==========
hardlink_db = OUTPUT_DB_DIR / "hardlink.db"
print(f"\n[2] 检查 hardlink.db: {hardlink_db}")
rows = []
dir2id_map = {}

if not hardlink_db.exists():
    print("    [ERROR] hardlink.db 不存在!")
else:
    print("    [OK] 文件存在")
    conn = sqlite3.connect(str(hardlink_db))
    
    # 先列出所有表
    print(f"\n[2.1] 列出所有表:")
    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    for t in tables:
        print(f"    - {t[0]}")
        # 列出表的列
        cols = conn.execute(f"PRAGMA table_info({t[0]})").fetchall()
        col_names = [c[1] for c in cols]
        print(f"      列: {col_names}")
    
    # 尝试不同的表名查询
    print(f"\n[3] 查询 hardlink 表 (md5={MD5})")
    possible_tables = ["image_hardlink_info", "HardLinkImageAttribute", "HardLinkImageAttribute2"]
    for tbl in possible_tables:
        try:
            # 先检查表是否存在
            exists = conn.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name=?", (tbl,)).fetchone()
            if not exists:
                continue
            print(f"    尝试表: {tbl}")
            # 获取列名
            cols = conn.execute(f"PRAGMA table_info({tbl})").fetchall()
            col_names = [c[1] for c in cols]
            print(f"    列: {col_names}")
            # 查询 md5
            if "Md5" in col_names:
                rows = conn.execute(f"SELECT * FROM {tbl} WHERE Md5 = ? LIMIT 5", (MD5,)).fetchall()
            elif "md5" in col_names:
                rows = conn.execute(f"SELECT * FROM {tbl} WHERE md5 = ? LIMIT 5", (MD5,)).fetchall()
            else:
                print(f"    [WARN] 没有 md5 列")
                continue
            if rows:
                print(f"    找到 {len(rows)} 条记录:")
                for i, row in enumerate(rows):
                    print(f"    [{i}] {dict(zip(col_names, row))}")
            else:
                print(f"    [WARN] 没有匹配记录")
        except Exception as e:
            print(f"    [ERROR] 查询 {tbl} 失败: {e}")
    
    # 查询 dir2id 映射
    print(f"\n[4] 查询 dir2id 表")
    try:
        # 先检查列名
        cols = conn.execute("PRAGMA table_info(dir2id)").fetchall()
        col_names = [c[1] for c in cols]
        print(f"    列: {col_names}")
        dir2id_rows = conn.execute("SELECT * FROM dir2id LIMIT 10").fetchall()
        print(f"    共 {len(dir2id_rows)} 条(最多显示10条):")
        for row in dir2id_rows:
            print(f"    {dict(zip(col_names, row))}")
        # 构建映射
        if len(col_names) >= 2:
            dir2id_map = {row[0]: row[1] for row in dir2id_rows}
    except Exception as e:
        print(f"    [ERROR] 查询失败: {e}")
        dir2id_map = {}
    
    conn.close()

# ========== 尝试拼接路径并检查文件是否存在 ==========
print(f"\n[5] 尝试拼接路径并检查文件")
if wxid_dir and rows:
    wxid_path = Path(wxid_dir)
    for i, row in enumerate(rows):
        dir1, dir2, file_name, _ = row
        dir_name = dir2id_map.get(dir2, str(dir2))
        
        # 尝试多个根目录
        roots = [
            wxid_path,
            wxid_path / "msg" / "attach",
            wxid_path / "msg" / "file",
            wxid_path / "msg" / "video",
            wxid_path / "cache",
        ]
        
        for root in roots:
            candidate = root / dir1 / dir_name / file_name
            exists = candidate.exists()
            print(f"    [{i}] {candidate}")
            print(f"        存在: {exists}")
            if exists:
                print(f"        [FOUND!] 大小: {candidate.stat().st_size} bytes")

# ========== 直接搜索 md5 文件 ==========
print(f"\n[6] 直接在 wxid_dir 下搜索 md5 文件")
if wxid_dir:
    wxid_path = Path(wxid_dir)
    search_dirs = [
        wxid_path / "msg" / "attach",
        wxid_path / "msg" / "file",
        wxid_path / "msg" / "video",
        wxid_path / "cache",
    ]
    patterns = [f"{MD5}*.dat", f"{MD5}*.jpg", f"{MD5}*.png"]
    
    found_any = False
    for d in search_dirs:
        if not d.exists():
            print(f"    [SKIP] {d} 不存在")
            continue
        for pat in patterns:
            try:
                matches = list(d.rglob(pat))
                for m in matches:
                    print(f"    [FOUND] {m} ({m.stat().st_size} bytes)")
                    found_any = True
            except Exception as e:
                print(f"    [ERROR] 搜索 {d}/{pat} 失败: {e}")
    
    if not found_any:
        print("    [WARN] 没有找到任何匹配文件")

print("\n[Done]")
