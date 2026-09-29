"""把版本检查和同步提交放在同一个应用存储锁内。"""
from functools import wraps


def serialized(method):
    @wraps(method)
    def invoke(self, *args, **kwargs):
        store = self.store if hasattr(self, 'store') else self.service.store
        with store.lock:
            return method(self, *args, **kwargs)
    return invoke
