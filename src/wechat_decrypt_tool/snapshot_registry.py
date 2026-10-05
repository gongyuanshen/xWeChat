"""Publish verified generations while keeping account assets at their stable root."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from contextvars import Context, ContextVar, copy_context
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
from typing import Any, Iterator

from .account_identity import canonical_account_name, is_internal_account_directory_name
from .app_paths import get_output_dir


_POINTER_NAME = "_snapshot_current.json"
_GENERATION_NAME = re.compile(r"generation-[0-9a-f]{32}\Z")
_READ_DIRECTORIES: ContextVar[dict[str, Path] | None] = ContextVar("snapshot_read_directories", default=None)
# ponytail: publication is infrequent; one process-wide lock serializes account pointers.
_PUBLISH_LOCK = threading.RLock()
_LEGACY_WRITES: dict[str, int] = {}
_EXCLUSIVE_LEGACY: dict[str, Any] = {}
_LEGACY_OWNER: ContextVar[Any] = ContextVar("legacy_write_owner", default=None)
_ACCOUNT_WORK: dict[str, int] = {}
_DELETING: set[str] = set()
_READ_LEASES: ContextVar[dict[str, Any] | None] = ContextVar("snapshot_read_leases", default=None)
_WORK_LEASES: ContextVar[dict[str, Any]] = ContextVar("snapshot_work_leases", default={})


class _ReadLeases(dict):
    closed = False


class SnapshotRegistryError(RuntimeError):
    """A publication or pointer is invalid; never substitute another data source."""


def _reject_link(path: Path, info: os.stat_result) -> None:
    if stat.S_ISLNK(info.st_mode) or (
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    ):
        raise SnapshotRegistryError(f"Snapshot paths cannot contain links: {path}")


def _check_ancestors(path: Path) -> None:
    for part in (*reversed(path.parents), path):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        _reject_link(part, info)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        _reject_link(path, path.lstat())
        result = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SnapshotRegistryError(f"Cannot read snapshot metadata {path}: {exc}") from exc
    if not isinstance(result, dict):
        raise SnapshotRegistryError(f"Snapshot metadata must be an object: {path}")
    return result


def _account_root(account_dir: Path) -> Path:
    root = Path(account_dir).absolute()
    expected_parent = (get_output_dir() / "databases").absolute()
    if root.parent != expected_parent or is_internal_account_directory_name(root.name):
        raise SnapshotRegistryError(f"Snapshot account must be a stable output account directory: {root}")
    _check_ancestors(root)
    return root


def _generation_account(account_dir: Path, value: Any) -> str:
    if not isinstance(value, str) or value not in {account_dir.name, canonical_account_name(account_dir.name)}:
        raise SnapshotRegistryError(f"Snapshot generation belongs to a different account: {account_dir.name}")
    return value


_CAPTURE_GUARANTEES = {'stable_observation', 'per_database_committed_prefix', 'mixed_per_database_capture'}


def _validate_capture_guarantee(result: dict) -> None:
    guarantee = result.get('guarantee')
    if guarantee == 'stable_observation' and result.get('source_unchanged') is True:
        manifest = result.get('manifest')
        if result.get('capture_boundaries') or (isinstance(manifest, dict) and any(
            isinstance(entry, dict) and entry.get('scope') == 'committed_prefix'
            for entry in manifest.values()
        )):
            raise SnapshotRegistryError('Stable observation contains contradictory live capture evidence')
        return
    boundaries = result.get('capture_boundaries')
    manifest = result.get('manifest')
    if (guarantee not in {'per_database_committed_prefix', 'mixed_per_database_capture'}
            or result.get('source_unchanged') is not None
            or result.get('captured_prefix_unchanged') is not True
            or not isinstance(boundaries, dict) or not boundaries or not isinstance(manifest, dict)):
        raise SnapshotRegistryError('Snapshot capture guarantee is not verified')
    databases = {name for name in manifest if name.lower().endswith('.db')}
    source_names_by_case = {name.casefold(): name for name in manifest}
    prefix_files = {name for name, entry in manifest.items()
                    if isinstance(entry, dict) and entry.get('scope') == 'committed_prefix'}
    if (not set(boundaries) <= databases
            or {name.casefold() for name in prefix_files} != {(name + '-wal').casefold() for name in boundaries}
            or (guarantee == 'per_database_committed_prefix') != (set(boundaries) == databases)):
        raise SnapshotRegistryError('Snapshot capture boundaries do not match the source inventory')
    for name, boundary in boundaries.items():
        if (not isinstance(boundary, dict)
                or any(type(boundary.get(key)) is not int or boundary[key] < 0
                       for key in ('mx_frame', 'page_size', 'database_pages'))):
            raise SnapshotRegistryError(f'Invalid snapshot commit boundary: {name}')
        frames, page_size = boundary['mx_frame'], boundary['page_size']
        empty_index = frames == page_size == boundary['database_pages'] == 0
        if ((not empty_index and (not 512 <= page_size <= 65536 or page_size & (page_size - 1)))
                or manifest[source_names_by_case[(name + '-wal').casefold()]].get('size')
                    != (32 + frames * (24 + page_size) if frames else 0)):
            raise SnapshotRegistryError(f'Snapshot WAL length does not match the commit boundary: {name}')


def _validate_generation(account_dir: Path, generation: Path, generation_account: str) -> dict[str, Any]:
    parent = (get_output_dir() / "verified_snapshots").absolute()
    if generation.parent != parent or not _GENERATION_NAME.fullmatch(generation.name):
        raise SnapshotRegistryError(f"Snapshot generation must be within {parent}")
    _check_ancestors(generation)
    result = _read_json(generation / "manifest.json")
    database_dir = generation / "databases" / generation_account
    _check_ancestors(database_dir)
    _validate_capture_guarantee(result)
    if (result.get("status") != "success"
            or result.get("account") != generation_account
            or result.get("generation_path") != str(generation)
            or result.get("account_path") != str(database_dir)):
        raise SnapshotRegistryError(f"Snapshot manifest does not describe this verified generation: {generation}")
    manifest = result.get("manifest")
    diagnostics = result.get("db_diagnostics")
    if (not isinstance(manifest, dict) or not manifest
            or not isinstance(diagnostics, dict) or not diagnostics
            or type(result.get("total_databases")) is not int
            or result["total_databases"] != len(diagnostics)):
        raise SnapshotRegistryError(f"Snapshot manifest is incomplete: {generation}")
    for name, diagnostic in diagnostics.items():
        if (not isinstance(name, str) or Path(name).name != name or not name.lower().endswith(".db")
                or not isinstance(diagnostic, dict)
                or diagnostic.get("success") is not True
                or diagnostic.get("key_authenticated") is not True
                or not isinstance(diagnostic.get("diagnostics"), dict)
                or diagnostic["diagnostics"].get("integrity_check_ok") is not True):
            raise SnapshotRegistryError(f"Snapshot database lacks authentication or integrity verification: {name}")
        path = database_dir / name
        try:
            info = path.lstat()
        except OSError as exc:
            raise SnapshotRegistryError(f"Verified snapshot database is unavailable: {path}") from exc
        _reject_link(path, info)
        if not stat.S_ISREG(info.st_mode) or diagnostic.get("output_path") != str(path):
            raise SnapshotRegistryError(f"Snapshot database path does not match its manifest: {path}")
    try:
        actual_names = {path.name for path in database_dir.glob("*.db")}
    except OSError as exc:
        raise SnapshotRegistryError(f"Cannot list snapshot databases: {database_dir}") from exc
    if actual_names != set(diagnostics):
        raise SnapshotRegistryError(f"Snapshot database inventory does not match its manifest: {database_dir}")
    return result


def get_current_snapshot(account_dir: Path) -> dict[str, Any] | None:
    """Read the latest pointer without consulting the current request's pin."""
    pointer_path = Path(account_dir) / _POINTER_NAME
    try:
        info = pointer_path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SnapshotRegistryError(f"Cannot inspect snapshot pointer: {pointer_path}") from exc
    _reject_link(pointer_path, info)
    root = _account_root(account_dir)
    pointer = _read_json(pointer_path)
    relative = pointer.get("generation_path")
    if (type(pointer.get("version")) is not int or pointer["version"] != 1
            or pointer.get("account") != root.name
            or type(pointer.get("revision")) is not int or pointer["revision"] <= 0
            or pointer.get("guarantee") not in _CAPTURE_GUARANTEES
            or not isinstance(pointer.get("published_at"), str) or not pointer["published_at"]
            or not isinstance(relative, str)
            or not re.fullmatch(r"verified_snapshots/generation-[0-9a-f]{32}", relative)):
        raise SnapshotRegistryError(f"Invalid snapshot pointer: {pointer_path}")
    generation_account = _generation_account(root, pointer.get("generation_account"))
    generation = get_output_dir().absolute() / relative
    result = _validate_generation(root, generation, generation_account)
    if pointer['guarantee'] != result['guarantee']:
        raise SnapshotRegistryError(f'Snapshot pointer capture guarantee differs from its manifest: {pointer_path}')
    return pointer


def require_legacy_database_write(account_dir: Path) -> None:
    """Reject legacy writeback against an account with an active publication."""
    with _PUBLISH_LOCK:
        exclusive = _EXCLUSIVE_LEGACY.get(_account_write_key(account_dir))
        if exclusive is not None and exclusive is not _LEGACY_OWNER.get():
            raise SnapshotRegistryError("An exclusive account import is active; database writes are blocked")
        if exclusive is None:
            require_account_available(account_dir)
    if get_current_snapshot(account_dir) is not None:
        raise SnapshotRegistryError(
            "The verified snapshot is immutable; use snapshot refresh to publish new databases."
        )


@contextmanager
def snapshot_publication_scope() -> Iterator[None]:
    """Order source validation/publication against legacy-write admission."""
    with _PUBLISH_LOCK:
        yield


class _LegacyWriteLease:
    def __init__(self, account_key: str, *, exclusive: bool = False) -> None:
        self.account_key = account_key
        self.exclusive = exclusive
        self.released = False

    @contextmanager
    def scope(self):
        """Bind the import's own nested install without admitting other writers."""
        if self.released:
            raise RuntimeError("Legacy database write reservation was already released")
        token = _LEGACY_OWNER.set(self)
        try:
            yield
        finally:
            _LEGACY_OWNER.reset(token)

    def release(self) -> None:
        """The SSE cleanup thread may release the worker's reservation."""
        with _PUBLISH_LOCK:
            if self.released:
                raise RuntimeError("Legacy database write reservation was already released")
            if self.exclusive:
                if _LEGACY_WRITES[self.account_key] != 1:
                    raise RuntimeError("Cannot release import reservation while nested database writes are active")
                del _EXCLUSIVE_LEGACY[self.account_key]
            _LEGACY_WRITES[self.account_key] -= 1
            if _LEGACY_WRITES[self.account_key] == 0:
                del _LEGACY_WRITES[self.account_key]
            self.released = True


def _account_write_key(account_dir: Path) -> str:
    root = Path(account_dir).absolute()
    return os.path.normcase(str(root.parent / canonical_account_name(root.name)))


def require_account_available(account_dir: Path) -> None:
    with _PUBLISH_LOCK:
        if _account_write_key(account_dir) in _DELETING:
            raise SnapshotRegistryError("Account deletion is in progress; new work is blocked")


class _AccountWorkLease:
    def __init__(self, key: str) -> None:
        self.key = key
        self.released = False

    def release(self) -> None:
        with _PUBLISH_LOCK:
            if self.released:
                raise RuntimeError("Account work reservation was already released")
            _ACCOUNT_WORK[self.key] -= 1
            if not _ACCOUNT_WORK[self.key]:
                del _ACCOUNT_WORK[self.key]
            self.released = True


def begin_account_work(account_dir: Path) -> _AccountWorkLease:
    with _PUBLISH_LOCK:
        key = _account_write_key(account_dir)
        if not _has_account_lease(key):
            require_account_available(account_dir)
        _ACCOUNT_WORK[key] = _ACCOUNT_WORK.get(key, 0) + 1
        return _AccountWorkLease(key)


def _has_account_lease(key: str) -> bool:
    for leases in (_READ_LEASES.get(), _WORK_LEASES.get()):
        if leases is not None and key in leases and not leases[key].released:
            return True
    return False


@contextmanager
def account_work(account_dir: Path) -> Iterator[None]:
    lease = begin_account_work(account_dir)
    token = _WORK_LEASES.set({**_WORK_LEASES.get(), lease.key: lease})
    try:
        with snapshot_read_scope(independent=True):
            resolve_account_database_dir(account_dir)
            yield
    finally:
        _WORK_LEASES.reset(token)
        lease.release()


@contextmanager
def account_deletion_scope(account_dir: Path) -> Iterator[None]:
    key = _account_write_key(account_dir)
    with _PUBLISH_LOCK:
        require_account_available(account_dir)
        _DELETING.add(key)
    try:
        yield
    finally:
        with _PUBLISH_LOCK:
            _DELETING.remove(key)


def require_account_idle(account_dir: Path) -> None:
    with _PUBLISH_LOCK:
        key = _account_write_key(account_dir)
        if _ACCOUNT_WORK.get(key, 0) or _LEGACY_WRITES.get(key, 0):
            raise SnapshotRegistryError("Account work is active; wait for readers and workers to finish before deletion")


def require_no_legacy_database_write(account_dir: Path) -> None:
    with _PUBLISH_LOCK:
        if _LEGACY_WRITES.get(_account_write_key(account_dir), 0):
            raise SnapshotRegistryError("Legacy database write is active for this account; snapshot refresh is blocked")


def begin_legacy_database_write(account_dir: Path, *, exclusive: bool = False) -> _LegacyWriteLease:
    """Reserve legacy mutation until its real worker exits, across threads."""
    key = _account_write_key(account_dir)
    with _PUBLISH_LOCK:
        if exclusive and _LEGACY_WRITES.get(key, 0):
            raise SnapshotRegistryError("Account database write is active; import is blocked")
        require_legacy_database_write(account_dir)
        _LEGACY_WRITES[key] = _LEGACY_WRITES.get(key, 0) + 1
        lease = _LegacyWriteLease(key, exclusive=exclusive)
        if exclusive:
            _EXCLUSIVE_LEGACY[key] = lease
        return lease


@contextmanager
def legacy_database_write(account_dir: Path) -> Iterator[None]:
    lease = begin_legacy_database_write(account_dir)
    try:
        yield
    finally:
        lease.release()


def publish_snapshot(account_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    """Atomically replace only the pointer, after validating the builder's manifest."""
    root = _account_root(account_dir)
    if not isinstance(result, dict) or not isinstance(result.get("generation_path"), str):
        raise SnapshotRegistryError("Snapshot publication requires a verified builder result")
    generation_account = _generation_account(root, result.get("account"))
    generation = Path(result["generation_path"])
    verified = _validate_generation(root, generation, generation_account)
    if result != verified:
        raise SnapshotRegistryError("Snapshot result does not match the persisted builder manifest")
    temp_path = None
    try:
        with _PUBLISH_LOCK:
            require_account_available(root)
            require_no_legacy_database_write(root)
            previous = get_current_snapshot(root)
            pointer = {
                "version": 1,
                "account": root.name,
                "generation_account": generation_account,
                "generation_path": generation.relative_to(get_output_dir().absolute()).as_posix(),
                "revision": previous["revision"] + 1 if previous is not None else 1,
                "guarantee": verified["guarantee"],
                "published_at": datetime.now(timezone.utc).isoformat(),
            }
            root.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=root,
                                             prefix=".snapshot-current-", suffix=".tmp", delete=False) as stream:
                temp_path = Path(stream.name)
                json.dump(pointer, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_path, root / _POINTER_NAME)
            temp_path = None
            return pointer
    except OSError as exc:
        raise SnapshotRegistryError(f"Could not publish snapshot for {root.name}: {exc}") from exc
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@contextmanager
def snapshot_read_scope(*, independent: bool = False) -> Iterator[dict[str, Path]]:
    """Reuse nested scopes; copied contexts share one request's lazy account pins."""
    existing = _READ_DIRECTORIES.get()
    leases = _READ_LEASES.get()
    if existing is not None and leases is not None and not independent and not leases.closed:
        yield existing
        return
    directories: dict[str, Path] = dict(existing or {})
    leases = _ReadLeases()
    token = _READ_DIRECTORIES.set(directories)
    lease_token = _READ_LEASES.set(leases)
    try:
        yield directories
    finally:
        _READ_DIRECTORIES.reset(token)
        _READ_LEASES.reset(lease_token)
        with _PUBLISH_LOCK:
            leases.closed = True
            for lease in leases.values():
                lease.release()


def resolve_account_database_dir(account_dir: Path) -> Path:
    """Resolve source DBs only. Callers retain account_dir for writable assets."""
    root = Path(account_dir)
    key = os.path.normcase(str(root.absolute()))
    directories = _READ_DIRECTORIES.get()
    leases = _READ_LEASES.get()
    with _PUBLISH_LOCK:
        if leases is not None and leases.closed:
            raise SnapshotRegistryError("The account read scope has ended; background work requires its own reservation")
        work_key = _account_write_key(root)
        if not _has_account_lease(work_key):
            require_account_available(root)
        if leases is not None and work_key not in leases:
            leases[work_key] = begin_account_work(root)
    if directories is not None and key in directories:
        return directories[key]
    pointer = get_current_snapshot(root)
    database_dir = root if pointer is None else (
        get_output_dir().absolute() / pointer["generation_path"] / "databases" / pointer["generation_account"]
    )
    # Threads can first resolve the same account concurrently. Every caller must
    # return the winning pin, including the thread that lost the setdefault race.
    return directories.setdefault(key, database_dir) if directories is not None else database_dir


def capture_snapshot_context(account_dir: Path) -> Context:
    """Pin at job creation, before a raw worker thread is started."""
    with snapshot_read_scope(independent=True):
        resolve_account_database_dir(account_dir)
        context = copy_context()
    context.run(_READ_LEASES.set, None)
    return context


class _SnapshotWork:
    """One queued worker owns its reservation through its actual final exit."""
    def __init__(self, account_dir: Path) -> None:
        self.lease = begin_account_work(account_dir)
        try:
            self.context = capture_snapshot_context(account_dir)
        except BaseException:
            self.lease.release()
            raise

    def release(self) -> None:
        """Release an unstarted worker when thread creation/start fails."""
        self.lease.release()

    @contextmanager
    def scope(self):
        token = _WORK_LEASES.set({**_WORK_LEASES.get(), self.lease.key: self.lease})
        try:
            with snapshot_read_scope(independent=True):
                yield
        finally:
            _WORK_LEASES.reset(token)

    def run(self, function, *args, **kwargs):
        def run_in_scope():
            with self.scope():
                return function(*args, **kwargs)
        try:
            return self.context.run(run_in_scope)
        finally:
            self.lease.release()


def capture_snapshot_work(account_dir: Path) -> _SnapshotWork:
    return _SnapshotWork(account_dir)


def start_snapshot_thread(account_dir: Path, function, *, args=(), kwargs=None, name: str) -> threading.Thread:
    work = capture_snapshot_work(account_dir)
    try:
        thread = threading.Thread(target=work.run, args=(function, *args), kwargs=kwargs,
                                  name=name, daemon=True)
        thread.start()
    except BaseException:
        work.release()
        raise
    return thread


def create_account_task(account_dir: Path, function, *args, **kwargs) -> asyncio.Task:
    """Reserve before queuing, including cancellation before coroutine start."""
    work = capture_snapshot_work(account_dir)
    async def execute():
        with work.scope():
            return await function(*args, **kwargs)
    coroutine = execute()
    try:
        task = asyncio.get_running_loop().create_task(coroutine, context=work.context)
    except BaseException:
        coroutine.close()
        work.release()
        raise
    task.add_done_callback(lambda _task: work.release())
    return task


def snapshot_cache_dir(account_dir: Path) -> Path:
    """Keep derived artifacts stable while separating each generation's results."""
    root = Path(account_dir)
    database_dir = resolve_account_database_dir(root)
    return root if database_dir == root else root / "_snapshot_cache" / database_dir.parents[1].name


class SnapshotReadMiddleware:
    """Pure ASGI scope spans response bodies and copied async/thread contexts."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        with snapshot_read_scope():
            await self.app(scope, receive, send)
