"""Account work keeps its reservation until workers and responses actually exit."""
from __future__ import annotations

import asyncio
from functools import partial
import logging
from pathlib import Path
from typing import Any

from starlette.responses import FileResponse

from .app_paths import get_output_dir
from .snapshot_registry import begin_account_work, capture_snapshot_work


logger = logging.getLogger(__name__)
_ACTIVE_ACCOUNT_WORKERS: set[asyncio.Future[Any]] = set()


class AccountFileResponse(FileResponse):
    """Reserve before queueing the response; release after its final file read."""

    def __init__(self, path, *, account_dir: Path, **kwargs):
        super().__init__(path, **kwargs)
        self._account_lease = begin_account_work(account_dir)

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._account_lease.release()


def export_file_response(path, **kwargs) -> FileResponse:
    """Internal downloads follow their actual deletion owner, including aliases."""
    file = Path(path).resolve()
    output = get_output_dir().resolve()
    if file.is_relative_to(output):
        relative = file.relative_to(output)
        if len(relative.parts) >= 3 and relative.parts[0] in {
            "exports", "databases", "account_backups", "avatar_cache",
        }:
            return AccountFileResponse(file, account_dir=output / "databases" / relative.parts[1], **kwargs)
    return FileResponse(file, **kwargs)


async def account_to_thread(account_dir: Path, function, /, *args, **kwargs):
    """Run once in the executor; only the actual worker releases its lease.

    Cancelling the awaiter leaves queued or running work intact. Business
    cancellation remains the worker's responsibility through its existing
    cancellation event. The account_dir parameter is positional-only so the
    called function can also receive an account_dir keyword argument.
    """
    loop = asyncio.get_running_loop()
    work = capture_snapshot_work(account_dir)
    try:
        future = loop.run_in_executor(None, partial(work.run, function, *args, **kwargs))
    except BaseException:
        work.release()
        raise
    _ACTIVE_ACCOUNT_WORKERS.add(future)

    def finished(done: asyncio.Future[Any]) -> None:
        _ACTIVE_ACCOUNT_WORKERS.discard(done)
        if done.cancelled():
            return
        error = done.exception()
        if error is not None:
            logger.error("Account worker failed for %s", account_dir.name,
                         exc_info=(type(error), error, error.__traceback__))

    future.add_done_callback(finished)
    return await asyncio.shield(future)
