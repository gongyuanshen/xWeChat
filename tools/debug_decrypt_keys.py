#!/usr/bin/env python3
"""调试媒体文件解密密钥检测"""

import sys
sys.path.insert(0, "src")

from pathlib import Path
from collections import Counter
import re

WXID_DIR = Path(r"D:\abc\wechatMSG\xwechat_files\wxid_v4mbduwqtzpt22_1e7a")
TEST_FILE = WXID_DIR / "msg" / "attach" / "0d6a4127daada32c5e407ae7201e785a" / "2025-12" / "Img" / "0923ad357c321cf286b794f8e5a66333.dat"

def extract_yyyymm_for_sort(p: Path) -> str:
    m = re.search(r"(\d{4}-\d{2})", str(p))
    return m.group(1) if m else "0000-00"

# ========== 检查测试文件 ==========
print(f"[1] 检查测试文件: {TEST_FILE}")
if TEST_FILE.exists():
    with open(TEST_FILE, "rb") as f:
        head = f.read(64)
    print(f"    存在, 大小: {TEST_FILE.stat().st_size} bytes")
    print(f"    前 16 字节: {head[:16].hex()}")
    sig = head[:6]
    if sig == b"\x07\x08V1\x08\x07":
        print("    版本: V1")
    elif sig == b"\x07\x08V2\x08\x07":
        print("    版本: V2")
    else:
        print("    版本: V0 (XOR only) 或未知")
else:
    print("    [ERROR] 文件不存在")

# ========== 查找 _t.dat 模板文件 ==========
print(f"\n[2] 查找 _t.dat 模板文件")
try:
    template_files = list(WXID_DIR.rglob("*_t.dat"))
    print(f"    找到 {len(template_files)} 个模板文件")
    template_files.sort(key=extract_yyyymm_for_sort, reverse=True)
    for tf in template_files[:5]:
        print(f"    - {tf}")
except Exception as e:
    print(f"    [ERROR] {e}")
    template_files = []

# ========== 计算 most_common_last2 ==========
print(f"\n[3] 计算模板文件末尾 2 字节的众数")
last_bytes_list = []
for file in template_files[:16]:
    try:
        with open(file, "rb") as f:
            f.seek(-2, 2)
            b2 = f.read(2)
            if b2 and len(b2) == 2:
                last_bytes_list.append(b2)
    except Exception:
        continue

if last_bytes_list:
    most_common = Counter(last_bytes_list).most_common(1)[0][0]
    print(f"    众数: {most_common.hex()} ({most_common})")
else:
    most_common = None
    print("    [ERROR] 没有有效的模板文件")

# ========== 计算 XOR key ==========
print(f"\n[4] 计算 XOR key")
if most_common and len(most_common) == 2:
    x, y = most_common[0], most_common[1]
    xor_key = x ^ 0xFF
    check = y ^ 0xD9
    print(f"    x=0x{x:02x}, y=0x{y:02x}")
    print(f"    xor_key = x ^ 0xFF = 0x{xor_key:02x} ({xor_key})")
    print(f"    check = y ^ 0xD9 = 0x{check:02x} ({check})")
    if xor_key == check:
        print(f"    [OK] XOR key 验证通过: {xor_key}")
    else:
        print(f"    [ERROR] XOR key 验证失败")
        xor_key = None
else:
    xor_key = None
    print("    [ERROR] 无法计算")

# ========== 查找 V2 密文 ==========
print(f"\n[5] 查找 V2 密文 (用于 AES key 提取)")
ciphertext = None
sig = b"\x07\x08V2\x08\x07"
for file in template_files:
    try:
        with open(file, "rb") as f:
            if f.read(6) != sig:
                continue
            f.seek(-2, 2)
            if most_common and f.read(2) != most_common:
                continue
            f.seek(0xF)
            ct = f.read(16)
            if ct and len(ct) == 16:
                ciphertext = ct
                print(f"    找到密文: {ct.hex()}")
                print(f"    来自文件: {file}")
                break
    except Exception:
        continue

if not ciphertext:
    print("    [ERROR] 未找到 V2 密文")

# ========== 检查 pycryptodome ==========
print(f"\n[6] 检查 pycryptodome")
try:
    from Crypto.Cipher import AES
    print("    [OK] pycryptodome 已安装")
except ImportError:
    print("    [ERROR] pycryptodome 未安装, 运行: uv add pycryptodome")

# ========== 尝试手动解密 ==========
print(f"\n[7] 尝试解密测试文件 (如果有 xor_key)")
if xor_key is not None and TEST_FILE.exists():
    with open(TEST_FILE, "rb") as f:
        data = f.read()
    
    sig = data[:6]
    print(f"    文件签名: {sig}")
    
    if sig == b"\x07\x08V2\x08\x07":
        print("    这是 V2 文件, 需要 AES key")
        # 检查是否可以从内存提取 AES key
        try:
            import psutil
            print("    psutil 已安装")
            
            # 查找微信进程
            weixin_pid = None
            for p in psutil.process_iter(["name"]):
                name = (p.info.get("name") or "").lower()
                if name in {"weixin.exe", "wechat.exe"}:
                    weixin_pid = p.pid
                    break
            
            if weixin_pid:
                print(f"    找到微信进程: PID={weixin_pid}")
                print("    需要从进程内存提取 AES key (需要管理员权限)")
            else:
                print("    [WARN] 未找到微信进程, 无法自动提取 AES key")
                print("    请确保微信正在运行")
        except ImportError:
            print("    [ERROR] psutil 未安装")
    elif sig == b"\x07\x08V1\x08\x07":
        print("    这是 V1 文件, 尝试使用 xor_key + 固定 AES key 解密")
    else:
        print("    这是 V0 文件, 尝试纯 XOR 解密")
        decrypted = bytes(b ^ xor_key for b in data)
        # 检查解密后的魔数
        if decrypted[:3] == b"\xff\xd8\xff":
            print("    [OK] 解密成功! 是 JPEG 图片")
        elif decrypted[:8] == b"\x89PNG\r\n\x1a\n":
            print("    [OK] 解密成功! 是 PNG 图片")
        else:
            print(f"    解密后前 16 字节: {decrypted[:16].hex()}")
            print("    [WARN] 解密后不是有效图片")

print("\n[Done]")
