"""按当前电脑的内存余量限制索引批量，不依赖显卡型号。"""


def choose_read_batch_size(requested=0):
    """0 为自动；手动批量也受可用内存保护，每一批重新评估。"""
    try:
        import psutil
        memory = psutil.virtual_memory()
        gib = 1024 ** 3
        if memory.total <= 4 * gib or memory.available < gib:
            limit = 100
        elif memory.total <= 8 * gib or memory.available < 3 * gib:
            limit = 500
        else:
            limit = 2000
    except (ImportError, OSError, RuntimeError):
        # 系统信息不可用时采用保守批量，仍允许在普通 CPU 电脑使用。
        limit = 100
    preferred = int(requested or 1000)
    return max(100, min(preferred, limit, 2000))
