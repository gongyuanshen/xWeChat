"""全应用模型请求调度：前台优先、任务间轮转、限流后自动退让。"""
import asyncio
import time
import weakref
from contextvars import ContextVar
from contextlib import asynccontextmanager

model_priority = ContextVar('model_priority', default=1)
model_group = ContextVar('model_group', default='background')
subtask_id = ContextVar('model_subtask_id', default='')
_schedulers = weakref.WeakKeyDictionary()


class Scheduler:
    def __init__(self, limit=4):
        self.limit = limit
        self.active = 0
        self.waiting = []
        self.last_group = {}
        self.cooldown_until = 0

    def throttled(self):
        self.limit = max(1, self.limit // 2)
        self.cooldown_until = time.monotonic() + 30

    def dispatch(self):
        if self.cooldown_until and time.monotonic() >= self.cooldown_until:
            self.limit = min(4, self.limit + 1)
            self.cooldown_until = time.monotonic() + 30 if self.limit < 4 else 0
        self.waiting[:] = [w for w in self.waiting if not w[2].cancelled()]
        while self.active < self.limit and self.waiting:
            priority = min(w[0] for w in self.waiting)
            candidates = [w for w in self.waiting if w[0] == priority]
            # 同优先级的不同父任务轮转，不让一个联系人占满等待队列。
            chosen = next((w for w in candidates if w[1] != self.last_group.get(priority)), candidates[0])
            self.waiting.remove(chosen)
            self.last_group[priority] = chosen[1]
            self.active += 1
            chosen[2].set_result(True)

    @asynccontextmanager
    async def slot(self):
        future = asyncio.get_running_loop().create_future()
        ticket = (model_priority.get(), model_group.get(), future)
        self.waiting.append(ticket)
        self.dispatch()
        acquired = False
        try:
            await future
            acquired = True
            yield
        finally:
            if acquired or (future.done() and not future.cancelled()):
                self.active -= 1
            elif ticket in self.waiting:
                self.waiting.remove(ticket)
            self.dispatch()


def scheduler():
    loop = asyncio.get_running_loop()
    if loop not in _schedulers:
        _schedulers[loop] = Scheduler()
    return _schedulers[loop]


class ModelSlots:
    """保留旧 semaphore 的上下文接口；不同 ModelService 共用同一调度器。"""
    def __init__(self):
        self.slots = weakref.WeakKeyDictionary()

    async def __aenter__(self):
        slot = scheduler().slot()
        self.slots[asyncio.current_task()] = slot
        return await slot.__aenter__()

    async def __aexit__(self, *args):
        slot = self.slots.pop(asyncio.current_task(), None)
        if slot:
            return await slot.__aexit__(*args)
