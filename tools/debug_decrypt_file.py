#!/usr/bin/env python3
"""直接测试文件解密逻辑"""

import sys
sys.path.insert(0, "src")

import json
import struct
from pathlib import Path

# 测试参数
ACCOUNT_DIR = Path(r"d:\abc\PycharmProjects\WeChatDataAnalysis\output\databases\wxid_v4mbduwqtzpt22")
TEST_FILE = Path(r"D:\abc\wechatMSG\xwechat_files\wxid_v4mbduwqtzpt22_1e7a\msg\attach\0d6a4127daada32c5e407ae7201e785a\2025-12\Img\0923ad357c321cf286b794f8e5a66333.dat")
WXID_DIR = Path(r"D:\abc\wechatMSG\xwechat_files\wxid_v4mbduwqtzpt22_1e7a")

# ========== 1. 读取密钥 ==========
print("[1] 读取密钥文件")
keys_file = ACCOUNT_DIR / "_media_keys.json"
if keys_file.exists():
    with open(keys_file, "r", encoding="utf-8") as f:
        keys = json.load(f)
    print(f"    keys = {keys}")
    xor_key = keys.get("xor")
    aes_str = str(keys.get("aes") or "").strip()
    aes_key16 = aes_str.encode("ascii", errors="ignore")[:16] if aes_str else b""
    print(f"    xor_key = {xor_key}")
    print(f"    aes_key16 = {aes_key16}")
else:
    print("    [ERROR] 密钥文件不存在")
    sys.exit(1)

# ========== 2. 读取测试文件 ==========
print(f"\n[2] 读取测试文件: {TEST_FILE}")
with open(TEST_FILE, "rb") as f:
    data = f.read()
print(f"    文件大小: {len(data)} bytes")
print(f"    前 16 字节: {data[:16].hex()}")

# ========== 3. 检测版本 ==========
print("\n[3] 检测文件版本")
sig = data[:6]
if sig == b"\x07\x08V1\x08\x07":
    version = 1
    print("    版本: V1")
elif sig == b"\x07\x08V2\x08\x07":
    version = 2
    print("    版本: V2")
else:
    version = 0
    print("    版本: V0 (纯 XOR)")

# ========== 4. 尝试解密 ==========
print("\n[4] 尝试解密")

from Crypto.Cipher import AES
from Crypto.Util import Padding

def decrypt_v4(data: bytes, xor_key: int, aes_key: bytes) -> bytes:
    """使用 api.py 相同的解密逻辑"""
    header, rest = data[:0xF], data[0xF:]
    print(f"    头部 (15 bytes): {header.hex()}")
    
    signature, aes_size, xor_size = struct.unpack("<6sLLx", header)
    print(f"    signature: {signature}")
    print(f"    aes_size: {aes_size}")
    print(f"    xor_size: {xor_size}")
    
    # 对齐到 AES 块大小
    aes_size_aligned = aes_size + (AES.block_size - aes_size % AES.block_size) if aes_size % AES.block_size != 0 else aes_size
    print(f"    aes_size_aligned: {aes_size_aligned}")
    
    aes_data = rest[:aes_size_aligned]
    print(f"    aes_data 长度: {len(aes_data)}")
    print(f"    aes_data 前 16 字节: {aes_data[:16].hex()}")
    
    cipher = AES.new(aes_key[:16], AES.MODE_ECB)
    decrypted_aes_raw = cipher.decrypt(aes_data)
    print(f"    解密后 (带 padding) 前 16 字节: {decrypted_aes_raw[:16].hex()}")
    
    try:
        decrypted_data = Padding.unpad(decrypted_aes_raw, AES.block_size)
        print(f"    去 padding 后长度: {len(decrypted_data)}")
    except Exception as e:
        print(f"    [WARN] unpad 失败: {e}, 使用原始数据")
        decrypted_data = decrypted_aes_raw
    
    if xor_size > 0:
        raw_data = rest[aes_size_aligned:-xor_size]
        xor_data = rest[-xor_size:]
        xored_data = bytes(b ^ xor_key for b in xor_data)
        print(f"    raw_data 长度: {len(raw_data)}")
        print(f"    xor_data 长度: {len(xor_data)}")
    else:
        raw_data = rest[aes_size_aligned:]
        xored_data = b""
        print(f"    raw_data 长度: {len(raw_data)}")
    
    result = decrypted_data + raw_data + xored_data
    print(f"    最终结果长度: {len(result)}")
    print(f"    结果前 16 字节: {result[:16].hex()}")
    
    # 检查是否是有效图片
    if result[:3] == b"\xff\xd8\xff":
        print("    [OK] 解密成功! 是 JPEG 图片")
    elif result[:8] == b"\x89PNG\r\n\x1a\n":
        print("    [OK] 解密成功! 是 PNG 图片")
    else:
        print("    [WARN] 解密后不是有效图片头")
    
    return result

if version == 2 and xor_key is not None and aes_key16:
    print("\n[4.1] 使用本地 decrypt_v4 函数:")
    decrypted = decrypt_v4(data, xor_key, aes_key16)
     
    # 保存解密后的文件
    output_file = Path("test_decrypted_manual.jpg")
    with open(output_file, "wb") as f:
        f.write(decrypted)
    print(f"    已保存: {output_file} ({len(decrypted)} bytes)")
else:
    print("    [ERROR] 无法解密: 缺少必要参数")

print("\n[Done]")
