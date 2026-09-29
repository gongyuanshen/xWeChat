import json
import sys
import re
import time
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, as_completed

try:
    import pefile
except ImportError:
    print("[!] 请先安装 pefile 库: pip install pefile")
    sys.exit()

# 编译好的特征码正则
PATTERN = re.compile(
    b"^\x48\xBA(.{8})"       # mov rdx, <8字节>
    b".{3,8}?"               # 中间的 mov [xxx], rdx
    b"\x48\xBA(.{8})"
    b".{3,8}?"
    b"\x48\xBA(.{8})"
    b".{3,8}?"
    b"\x48\xBA(.{8})"
    b".{3,8}?"
    b"\x48\x85\xC0",         # test rax, rax
    re.DOTALL
)

def worker_search(task):
    """
    子进程执行函数：读取自己负责的文件片段，进行极速搜索
    """
    file_path, file_offset, chunk_size, overlap, base_va = task
    results = []
    
    # 让子进程独立读取自己的分块，避免 Python 多进程之间传递巨量数据的 IPC 序列化卡顿
    with open(file_path, 'rb') as f:
        f.seek(file_offset)
        # 读取指定大小 + 冗余重叠部分(防止特征码被从中切断)
        chunk_data = f.read(chunk_size + overlap)
        
    offset = 0
    while True:
        idx = chunk_data.find(b'\x48\xBA', offset)
        
        # 如果找不到，或者找到了但已经进入了重叠区(交由下一个分块处理防止重复)
        if idx == -1 or idx >= chunk_size:
            break
            
        # 截取 85 字节进行严格正则匹配
        match = PATTERN.match(chunk_data[idx : idx + 85])
        if match:
            # 提取小端序 32 字节 Key
            key_bytes = match.group(1) + match.group(2) + match.group(3) + match.group(4)
            key_hex = key_bytes.hex().upper()
            formatted_key = " ".join(key_hex[i:i+2] for i in range(0, len(key_hex), 2))
            
            # 保存结果：VA 地址、物理偏移、格式化好的 Key
            results.append({
                'va': base_va + idx,
                'file_offset': file_offset + idx,
                'key': formatted_key
            })
            offset = idx + len(match.group(0))
        else:
            offset = idx + 1
            
    return results

def extract_xor_keys_multiprocess(dll_path, version="unknown"):
    print(f"[*] 正在分析目标: {dll_path}")
    print(f"[*] 正在启动多进程并行引擎 (CPU 核心数: {multiprocessing.cpu_count()})...")
    start_time = time.time()
    
    try:
        pe = pefile.PE(dll_path, fast_load=True) # fast_load 更快解析头
    except Exception as e:
        print(f"[!] PE 解析失败: {e}")
        return

    image_base = pe.OPTIONAL_HEADER.ImageBase
    tasks = []
    
    # 每个核心分配的数据块大小：2MB
    CHUNK_SIZE = 2 * 1024 * 1024 
    # 块与块之间的重叠大小，确保特征码跨越边界时不会被漏掉
    OVERLAP_SIZE = 100 

    # 1. 扫描 PE 段，生成切片任务
    for section in pe.sections:
        if section.Characteristics & 0x20000000: # 仅处理代码段
            sec_size = section.SizeOfRawData
            sec_file_offset = section.PointerToRawData
            sec_va = image_base + section.VirtualAddress
            
            # 将巨大的代码段切成若干个 2MB 的小块
            for i in range(0, sec_size, CHUNK_SIZE):
                current_chunk_size = min(CHUNK_SIZE, sec_size - i)
                tasks.append((
                    dll_path,
                    sec_file_offset + i,
                    current_chunk_size,
                    OVERLAP_SIZE,
                    sec_va + i
                ))

    # 2. 扔进进程池火力全开并行运算
    found_matches = []
    with ProcessPoolExecutor(max_workers=multiprocessing.cpu_count()) as executor:
        # 提交所有任务
        futures = {executor.submit(worker_search, task): task for task in tasks}
        
        # 实时收集结果
        for future in as_completed(futures):
            found_matches.extend(future.result())

    # 3. 按地址排序并输出结果
    found_matches.sort(key=lambda x: x['va'])

    pe.close()  # 及时关闭 PE 文件释放资源
    
    for i, res in enumerate(found_matches):
        print(f"\n[+] 发现第 {i+1} 处加密逻辑:")
        print(f"    -> 提取的 32 Byte Key: {res['key']}")
        print(f"    -> IDA 虚拟地址 (VA):  0x{res['va']:X}  <-- 请去 IDA 验证")
        print(f"    -> 文件物理偏移量:     0x{res['file_offset']:X}")

        json_dict = {
            "va": f"0x{res['va']:X}",
            "key": res['key']
        }

        with open(f"keys/{version}.jsonl", "a") as f:
            json.dump(json_dict, f)
            f.write("\n")
        
    print(f"\n[*] 并行扫描完毕，共发现 {len(found_matches)} 处，总耗时: {time.time() - start_time:.3f} 秒")

if __name__ == "__main__":
    # Windows 下多进程必须保护入口点
    multiprocessing.freeze_support()

    # 将此处的路径替换为你要分析的 DLL 路径
    path = r"C:\Users\Carto\Documents\Virtual Machines\共享\Weixin\weixin_4.1.9.23\install\4.1.9.23\Weixin.dll"
    path = r"C:\Users\Carto\Downloads\Telegram Desktop\Weixin_4.1.10.25\install\4.1.10.25\Weixin.dll"
    v = path.split("\\")[-2]  # 从路径中提取版本号
    extract_xor_keys_multiprocess(path, version=v)