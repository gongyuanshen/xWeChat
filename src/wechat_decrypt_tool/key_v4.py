import ctypes
import multiprocessing
import struct
import hmac
import os
import time
import logging
from ctypes import wintypes
from multiprocessing import freeze_support
import sys

from Crypto.Protocol.KDF import PBKDF2
from Crypto.Hash import SHA512

try:
    import pymem
except ImportError:
    pymem = None

try:
    import yara
except ImportError:
    yara = None

# 定义必要的常量
PROCESS_ALL_ACCESS = 0x1F0FFF
PAGE_READWRITE = 0x04
MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000

# Stream cipher constants
IV_SIZE = 16
HMAC_SHA256_SIZE = 64
HMAC_SHA512_SIZE = 64
KEY_SIZE = 32
AES_BLOCK_SIZE = 16
ROUND_COUNT = 256000
PAGE_SIZE = 4096
SALT_SIZE = 16

# Windows API Constants
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400

logger = logging.getLogger(__name__)
MEMORY_CHUNK_SIZE = 4 * 1024 * 1024


def xor_raw_key(raw_key: bytes, internal_db_key: bytes | None) -> bytes:
    """在派生前对原始 32 字节候选 key 执行 XOR 变换。"""
    if internal_db_key is None:
        return raw_key
    if len(raw_key) != KEY_SIZE:
        raise ValueError(f"raw key length must be {KEY_SIZE}, got {len(raw_key)}")
    if len(internal_db_key) != KEY_SIZE:
        raise ValueError(f"internal_db_key length must be {KEY_SIZE}, got {len(internal_db_key)}")
    return bytes(a ^ b for a, b in zip(raw_key, internal_db_key))


def verify_worker(task):
    """Pool worker wrapper for imap_unordered."""
    return check_chunk(*task)

if os.name == 'nt':
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

    OpenProcess = kernel32.OpenProcess
    OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    OpenProcess.restype = wintypes.HANDLE

    ReadProcessMemory = kernel32.ReadProcessMemory
    ReadProcessMemory.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.LPVOID, ctypes.c_size_t,
                                  ctypes.POINTER(ctypes.c_size_t)]
    ReadProcessMemory.restype = wintypes.BOOL

    CloseHandle = kernel32.CloseHandle
    CloseHandle.argtypes = [wintypes.HANDLE]
    CloseHandle.restype = wintypes.BOOL
else:
    kernel32 = None
    OpenProcess = None
    ReadProcessMemory = None
    CloseHandle = None


def _require_windows_runtime():
    if os.name != 'nt':
        raise RuntimeError('V4 数据库密钥提取仅支持 Windows。')
    if yara is None:
        raise RuntimeError('V4 数据库密钥提取缺少 Windows 运行时依赖。')


# 定义 MEMORY_BASIC_INFORMATION 结构
class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", ctypes.c_ulong),
        ("RegionSize", ctypes.c_size_t),
        ("State", ctypes.c_ulong),
        ("Protect", ctypes.c_ulong),
        ("Type", ctypes.c_ulong),
    ]


# 打开目标进程
def open_process(pid):
    handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        raise OSError(ctypes.get_last_error(), f"OpenProcess failed for PID {pid}")
    return handle


# 读取目标进程内存
def read_process_memory(process_handle, address, size):
    buffer = ctypes.create_string_buffer(size)
    bytes_read = ctypes.c_size_t(0)
    success = ReadProcessMemory(
        process_handle,
        ctypes.c_void_p(address),
        buffer,
        size,
        ctypes.byref(bytes_read)
    )
    if not success or bytes_read.value != size:
        raise OSError(ctypes.get_last_error(), f"ReadProcessMemory failed at 0x{address:x}, size={size}, read={bytes_read.value}")
    return buffer.raw[:bytes_read.value]


# 获取所有内存区域
def get_memory_regions(process_handle, *, deadline=None, cancel_event=None):
    regions = []
    mbi = MEMORY_BASIC_INFORMATION()
    address = 0
    query = kernel32.VirtualQueryEx
    query.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, ctypes.POINTER(MEMORY_BASIC_INFORMATION), ctypes.c_size_t]
    query.restype = ctypes.c_size_t
    while address < 0x7FFF_FFFF_FFFF:
        _check_scan_budget(deadline, cancel_event)
        if not query(process_handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            error = ctypes.get_last_error()
            if error == 87:  # ERROR_INVALID_PARAMETER marks the end of the address space.
                break
            raise OSError(error, f"VirtualQueryEx failed at 0x{address:x}")
        if (mbi.State == MEM_COMMIT and mbi.Type == MEM_PRIVATE
                and not mbi.Protect & 0x101 and mbi.Protect & 0xFF in (2, 4, 8, 32, 64, 128)):
            regions.append((mbi.BaseAddress, mbi.RegionSize))
        next_address = int(mbi.BaseAddress or 0) + mbi.RegionSize
        if next_address <= address:
            raise RuntimeError(f"VirtualQueryEx returned a non-advancing region at 0x{address:x}")
        address = next_address
    return regions


def read_num(data: bytes, offset, size):
    """从二进制数据中读取指定大小的数字"""
    if size == 1:
        fmt = '<B'
    elif size == 2:
        fmt = '<H'
    elif size == 4:
        fmt = '<I'
    elif size == 8:
        fmt = '<Q'
    else:
        raise ValueError("Unsupported size")
    return struct.unpack_from(fmt, data, offset)[0]


def is_ok(passphrase, buf, internal_db_key=None):
    """验证密钥是否正确"""
    if len(passphrase) != KEY_SIZE or len(buf) < PAGE_SIZE:
        raise ValueError('V4 key verification requires a 32-byte key and a complete 4096-byte page')
    # 获取文件开头的 salt
    salt = buf[:SALT_SIZE]
    # salt 异或 0x3a 得到 mac_salt，用于计算 HMAC
    mac_salt = bytes(x ^ 0x3a for x in salt)
    # 使用 PBKDF2 生成新的密钥
    passphrase = xor_raw_key(passphrase, internal_db_key)
    new_key = PBKDF2(passphrase, salt, dkLen=KEY_SIZE, count=ROUND_COUNT, hmac_hash_module=SHA512)
    # 使用新的密钥和 mac_salt 计算 mac_key
    mac_key = PBKDF2(new_key, mac_salt, dkLen=KEY_SIZE, count=2, hmac_hash_module=SHA512)
    # 计算 hash 校验码的保留空间
    reserve = IV_SIZE + HMAC_SHA512_SIZE
    reserve = ((reserve + AES_BLOCK_SIZE - 1) // AES_BLOCK_SIZE) * AES_BLOCK_SIZE
    # 校验 HMAC
    start = SALT_SIZE
    end = PAGE_SIZE
    mac = hmac.new(mac_key, buf[start:end - reserve + IV_SIZE], SHA512)
    mac.update(struct.pack('<I', 1))  # page number as 1
    hash_mac = mac.digest()
    # 校验 HMAC 是否一致
    hash_mac_start_offset = end - reserve + IV_SIZE
    hash_mac_end_offset = hash_mac_start_offset + len(hash_mac)
    return hmac.compare_digest(hash_mac, buf[hash_mac_start_offset:hash_mac_end_offset])


def check_chunk(chunk, buf, internal_db_key=None):
    """检查单个密钥候选"""
    if is_ok(chunk, buf, internal_db_key):
        return chunk
    return False


def is_potential_key(key: bytes) -> bool:
    """
    通过熵分析与字符分布快速过滤非密钥的普通文本。
    """
    if len(key) != 32:
        return False
    # 1. 过滤字节太单一的数据（如全0，或大量重复字节）
    # 随机密钥包含的相异字节种类极大概率 >= 15
    if len(set(key)) < 15:
        return False
    # 2. 过滤可打印字符(ASCII 32-126)过多的普通文本
    # 密码学随机密钥匙中可打印字符数量很难超过 24 个
    printable_count = sum(32 <= b <= 126 for b in key)
    if printable_count > 24:
        return False
    return True


def _check_scan_budget(deadline, cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise RuntimeError('Database key scan cancelled')
    if deadline is not None and time.monotonic() >= deadline:
        raise TimeoutError('Database key memory scan timed out')


def get_key(pid, process_handle, buf, internal_db_key=None, *, deadline=None, cancel_event=None):
    """获取密钥：扫描进程内存，寻找有效的密钥"""
    regions = get_memory_regions(process_handle, deadline=deadline, cancel_event=cancel_event)
    rules = yara.compile(source=r'''rule GetKeyAddrStub {
        strings: $a = { ?? ?? ?? ?? ?? ?? 00 00 00 00 00 00 00 00 00 00 20 00 00 00 00 00 00 00 2f 00 00 00 00 00 00 00 }
        condition: $a
    }''')
    addresses = set()
    keys = set()
    for base, size in regions:
        for offset in range(0, size, MEMORY_CHUNK_SIZE):
            _check_scan_budget(deadline, cancel_event)
            memory = read_process_memory(process_handle, base + offset, min(MEMORY_CHUNK_SIZE + 31, size - offset))
            for match in rules.match(data=memory):
                for matched_string in match.strings:
                    for instance in matched_string.instances:
                        address = read_num(memory, instance.offset, 8)
                        if address in addresses:
                            continue
                        addresses.add(address)
                        # A signature is only a candidate; reject dangling pointers with diagnostics.
                        try:
                            key = read_process_memory(process_handle, address, KEY_SIZE)
                        except OSError as error:
                            if error.errno not in (299, 487, 998):
                                raise
                            logger.warning('V4 candidate pointer unreadable: pid=%s address=0x%x error=%s', pid, address, error)
                            continue
                        if is_potential_key(key):
                            keys.add(key)
    logger.info('V4 memory candidates: pid=%s regions=%s pointers=%s candidates=%s', pid, len(regions), len(addresses), len(keys))
    return verify_keys(list(keys), buf, internal_db_key, deadline=deadline, cancel_event=cancel_event)


def verify_keys(keys, buf, internal_db_key=None, *, deadline=None, cancel_event=None):
    """验证密钥候选列表，返回有效的密钥"""
    total = len(keys)
    if total == 0:
        print("[-] No key candidates found")
        return None

    worker_count = min(total, 8, max(1, multiprocessing.cpu_count() // 2))
    print(f"[*] Testing {total} filtered key candidates with {worker_count} workers...")

    completed = 0
    last_percent = -1
    with multiprocessing.Pool(processes=worker_count) as pool:
        task_iter = ((key, buf, internal_db_key) for key in keys)
        pending = pool.imap_unordered(verify_worker, task_iter, chunksize=16 if deadline is None else 1)
        while completed < total:
            _check_scan_budget(deadline, cancel_event)
            if deadline is None:
                r = next(pending)
            else:
                try:
                    r = pending.next(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
                except multiprocessing.TimeoutError:
                    continue
            completed += 1
            percent = int((completed / total) * 100)
            if percent != last_percent:
                print(f"[*] Verify progress: {completed}/{total} ({percent}%)")
                last_percent = percent

            if r:
                print(f"[+] Key found (length={len(r)} bytes; value redacted)")
                pool.terminate()
                return bytes.hex(r)

    print("[-] Verification completed, no valid key")
    return None


def recover_key(pid, db_file_path=None, internal_db_key=None, *, timeout_seconds=120.0, cancel_event=None):
    """
    主函数：从 WeChat 进程恢复密钥
    """
    deadline = time.monotonic() + timeout_seconds
    _check_scan_budget(deadline, cancel_event)
    _require_windows_runtime()
    if not db_file_path:
        raise ValueError('A database file is required for HMAC verification')
    with open(db_file_path, 'rb') as source:
        buf = source.read(PAGE_SIZE)
    if len(buf) != PAGE_SIZE or buf.startswith(b'SQLite format 3\0'):
        raise ValueError('Key recovery requires an encrypted 4096-byte database page')
    process_handle = open_process(pid)
    try:
        return get_key(pid, process_handle, buf, internal_db_key, deadline=deadline, cancel_event=cancel_event)
    finally:
        CloseHandle(process_handle)


if __name__ == '__main__':
    freeze_support()

    try:
        _require_windows_runtime()
    except RuntimeError as exc:
        print(f"[-] {exc}")
        sys.exit(1)
    
    try:
        pm = pymem.Pymem("Weixin.exe")
        pid = pm.process_id
        print(f"[*] Connected to Weixin.exe (PID: {pid})")
    except Exception as e:
        print(f"[-] Failed to connect to Weixin.exe: {e}")
        exit(1)
    
    db_path = input("[*] Enter database file path (e.g., favorite_fts.db): ").strip()
    raw_internal_db_key = input("[*] Enter internal database key hex (optional, 64 hex chars): ").strip()
    internal_db_key = None
    if raw_internal_db_key:
        try:
            internal_db_key = bytes.fromhex(raw_internal_db_key)
        except ValueError:
            print("[-] Invalid internal_db_key hex")
            exit(1)
        if len(internal_db_key) != KEY_SIZE:
            print(f"[-] internal_db_key must be {KEY_SIZE} bytes, got {len(internal_db_key)}")
            exit(1)
        print("[+] internal_db_key length:", len(internal_db_key))

    if not db_path:
        print("[-] No path provided")
        exit(1)
    
    key = recover_key(pid, db_path, internal_db_key)
    if key:
        key = xor_raw_key(bytes.fromhex(key), internal_db_key).hex()
    
    if key:
        print(f"[+] Successfully recovered key (length={len(key) // 2} bytes; value redacted)")
    else:
        print("[-] Failed to recover key")
