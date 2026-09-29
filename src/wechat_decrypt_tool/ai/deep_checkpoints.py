"""并发父子图共享官方检查点连接，避免多个写连接互相等待。"""
import asyncio
from contextlib import asynccontextmanager

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver


class CheckpointPool:
    def __init__(self, path):
        self.path = str(path)
        self.loop = asyncio.get_running_loop()
        self.lock = asyncio.Lock()
        self.saver = None
        self.users = 0

    @asynccontextmanager
    async def session(self):
        async with self.lock:
            if self.saver is None:
                connection = await aiosqlite.connect(self.path, timeout=30)
                try:
                    saver = AsyncSqliteSaver(connection)
                    await saver.setup()
                except BaseException:
                    await connection.close()
                    raise
                self.saver = saver
            self.users += 1
            saver = self.saver
        try:
            yield saver
        finally:
            async with self.lock:
                self.users -= 1
                if not self.users:
                    self.saver = None
                    await saver.conn.close()


def checkpoint_session(service):
    pool = getattr(service, '_checkpoint_pool', None)
    if pool is None or pool.loop is not asyncio.get_running_loop():
        pool = service._checkpoint_pool = CheckpointPool(service.store.root / 'deepagents_checkpoints.sqlite3')
    return pool.session()
