"""Build verified generations using explicit live-WAL or static capture rules.

Windows databases with an active SHM owner use one committed WAL prefix.
Inactive SHM is locked against reinitialization during ``stable_observation``.
Other sources retain the same strict checks. Neither method is a
transaction across multiple databases. Live capture failures never fall back.
"""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from typing import Any, Callable
import uuid

from .wechat_decrypt import WeChatDatabaseDecryptor, scan_account_databases_from_path


class SnapshotBuildError(RuntimeError):
    def __init__(self, stage: str, message: str, *, diagnostics: dict | None = None):
        super().__init__(f"[{stage}] {message}")
        self.stage = stage
        self.diagnostics = diagnostics if diagnostics is not None else {}


def _reject_link(path: Path, info: os.stat_result) -> None:
    if stat.S_ISLNK(info.st_mode) or (
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    ):
        raise SnapshotBuildError("validation", f"Linked paths are not accepted: {path}")


def _check_ancestors(path: Path) -> None:
    for part in (*reversed(path.parents), path):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        _reject_link(part, info)


def _source_inventory(root: Path) -> list[str]:
    def onerror(exc: OSError) -> None:
        raise exc

    names = []
    for directory, dirs, files in os.walk(root, onerror=onerror, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            info = path.lstat()
            _reject_link(path, info)
            if name in files and name.lower().endswith((".db", ".db-wal", ".db-journal")):
                if not stat.S_ISREG(info.st_mode):
                    raise SnapshotBuildError("validation", f"Source is not a regular file: {path}")
                names.append(path.relative_to(root).as_posix())
    return sorted(names)


def _file_fingerprint(path: Path, *, checkpoint: Callable[[], None] | None = None) -> dict[str, Any]:
    if checkpoint is not None:
        checkpoint()
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            if checkpoint is not None:
                checkpoint()
            digest.update(chunk)
    if checkpoint is not None:
        checkpoint()
    after = path.stat()
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in fields):
        raise SnapshotBuildError("source_changed", f"File changed while hashing: {path}")
    return {
        "device": before.st_dev,
        "inode": before.st_ino,
        "size": before.st_size,
        "mtime_ns": before.st_mtime_ns,
        "sha256": digest.hexdigest(),
    }


def _shm_identities(root: Path, names: list[str]) -> dict[str, tuple[int, int] | None]:
    identities = {}
    for name in names:
        if not name.lower().endswith('.db'):
            continue
        path = root / (name + '-shm')
        try:
            info = path.lstat()
        except FileNotFoundError:
            identities[name] = None
        else:
            _reject_link(path, info)
            identities[name] = (info.st_dev, info.st_ino)
    return identities


@contextmanager
def _capture_scope(root: Path, names: list[str]):
    """Select by SHM ownership before capture; never recover from a live error."""
    identities = _shm_identities(root, names)
    with ExitStack() as stack:
        files, headers = {}, {}
        if os.name == 'nt':
            from .windows_wal_capture import pin_wal_files
            for name, identity in identities.items():
                if identity is not None:
                    pinned, header = stack.enter_context(pin_wal_files(root / name))
                    files.update(pinned)
                    if header is not None:
                        headers[name] = header
        yield files, headers
        if identities != _shm_identities(root, names):
            raise SnapshotBuildError('source_changed', 'SHM presence or identity changed during capture')


def _stream_fingerprint(path: Path, stream, size: int, *, checkpoint: Callable[[], None] | None = None) -> dict[str, Any]:
    if checkpoint is not None:
        checkpoint()
    before = os.fstat(stream.fileno())
    stream.seek(0)
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        if checkpoint is not None:
            checkpoint()
        chunk = stream.read(min(remaining, 1024 * 1024))
        if checkpoint is not None:
            checkpoint()
        if not chunk:
            raise SnapshotBuildError('source_changed', f'Pinned source was truncated: {path}')
        digest.update(chunk)
        remaining -= len(chunk)
    if checkpoint is not None:
        checkpoint()
    after = os.fstat(stream.fileno())
    is_wal = path.name.lower().endswith('-wal')
    fields = ('st_dev', 'st_ino') if is_wal else ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns')
    if (before.st_size < size or after.st_size < size
            or any(getattr(before, field) != getattr(after, field) for field in fields)):
        raise SnapshotBuildError('source_changed', f'Pinned source changed while hashing: {path}')
    result = {'device': before.st_dev, 'inode': before.st_ino, 'size': size,
              'sha256': digest.hexdigest()}
    if is_wal:
        result['scope'] = 'committed_prefix'
    else:
        result['mtime_ns'] = before.st_mtime_ns
    return result


def _source_manifest_locked(root: Path, names: list[str], files: dict, *, checkpoint: Callable[[], None] | None = None) -> dict:
    manifest = {}
    for name in names:
        path = root / name
        manifest[name] = (_stream_fingerprint(path, *files[path], checkpoint=checkpoint) if path in files
                          else _file_fingerprint(path, checkpoint=checkpoint))
    if names != _source_inventory(root):
        raise SnapshotBuildError('source_changed', 'Source file inventory changed while hashing')
    if checkpoint is not None:
        checkpoint()
    return manifest


def _source_manifest(root: Path, *, checkpoint: Callable[[], None] | None = None) -> dict[str, dict[str, Any]]:
    try:
        if checkpoint is not None:
            checkpoint()
        names = _source_inventory(root)
        if checkpoint is not None:
            checkpoint()
        with _capture_scope(root, names) as (files, _):
            return _source_manifest_locked(root, names, files, checkpoint=checkpoint)
    except FileNotFoundError as exc:
        raise SnapshotBuildError("source_changed", f"Source file disappeared: {exc}") from exc


def _copy_pinned_file(stream, size: int, destination: Path) -> None:
    stream.seek(0)
    remaining = size
    with destination.open('wb') as output:
        while remaining:
            chunk = stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise SnapshotBuildError('source_changed', f'Pinned file was truncated: {destination.name}')
            output.write(chunk)
            remaining -= len(chunk)


def _remove_owned_directory(path: Path, parent: Path) -> None:
    if path.parent != parent or not path.resolve().is_relative_to(parent):
        raise SnapshotBuildError("cleanup", f"Refusing cleanup outside output parent: {path}")
    _reject_link(path, path.lstat())
    shutil.rmtree(path)


def build_verified_snapshot(
    db_storage_path: str | Path, key: str, output_parent: str | Path,
) -> dict[str, Any]:
    """Capture once, authenticate every business DB, then retain a new generation.

    Only key-authenticated encrypted source databases are accepted. No source
    writes, key-store writes, active-account replacement or retry occurs.
    All DB/WAL/journal files enter the manifest, including derived DBs that the
    existing scanner excludes from decryption. Only selected DBs and their
    sidecars are copied. Returned paths are usable only after this call succeeds.
    """
    stage = "validation"
    staging: Path | None = None
    generation: Path | None = None
    diagnostics: dict[str, dict] = {}
    try:
        source = Path(db_storage_path)
        parent = Path(output_parent)
        if not source.is_absolute() or source.name.lower() != "db_storage":
            raise SnapshotBuildError("validation", "An absolute single-account db_storage path is required")
        if not parent.is_absolute():
            raise SnapshotBuildError("validation", "output_parent must be absolute")
        _check_ancestors(source)
        _check_ancestors(parent)
        source = source.resolve(strict=True)
        parent = parent.resolve()
        if not source.is_dir():
            raise SnapshotBuildError("validation", f"Source is not a directory: {source}")
        if parent.is_relative_to(source):
            raise SnapshotBuildError("validation", "Output must be outside the source db_storage directory")
        try:
            decryptor = WeChatDatabaseDecryptor(key)
        except (TypeError, ValueError) as exc:
            raise SnapshotBuildError("validation", f"Invalid database key: {exc}") from exc

        stage = "source_read"
        observation_started_at = datetime.now(timezone.utc).isoformat()
        source_names = _source_inventory(source)
        with _capture_scope(source, source_names) as (pinned_files, capture_boundaries):
            manifest = _source_manifest_locked(source, source_names, pinned_files)
            scan = scan_account_databases_from_path(str(source))
            if scan["status"] != "success" or len(scan["account_databases"]) != 1:
                raise SnapshotBuildError("validation", str(scan["message"]))
            account, databases = next(iter(scan["account_databases"].items()))
            names = [database["name"].casefold() for database in databases]
            if len(names) != len(set(names)):
                raise SnapshotBuildError("validation", "Source databases have colliding output filenames")
            databases = sorted(databases, key=lambda item: item["name"].casefold())
            source_names_by_case = {name.casefold(): name for name in source_names}
            selected = set()
            for database in databases:
                relative = Path(database["path"]).relative_to(source).as_posix()
                if relative not in manifest:
                    raise SnapshotBuildError("source_changed", f"Database appeared after inventory: {relative}")
                selected.add(relative)
                selected.update(source_names_by_case[(relative + suffix).casefold()]
                                for suffix in ("-wal", "-journal")
                                if (relative + suffix).casefold() in source_names_by_case)

            stage = "copy"
            parent.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=parent))
            ownership = {"version": 1, "account": account, "source_db_storage_path": str(source)}
            (staging / "ownership.json").write_text(json.dumps(ownership), encoding="utf-8")
            captured = staging / "source"
            candidate = staging / "databases" / account
            candidate.mkdir(parents=True)
            for relative in sorted(selected):
                destination = captured / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    if source / relative in pinned_files:
                        _copy_pinned_file(*pinned_files[source / relative], destination)
                    else:
                        shutil.copyfile(source / relative, destination)
                except FileNotFoundError as exc:
                    raise SnapshotBuildError("source_changed", f"Source file disappeared during copy: {relative}") from exc
                fingerprint = _file_fingerprint(destination)
                if any(fingerprint[field] != manifest[relative][field] for field in ("size", "sha256")):
                    raise SnapshotBuildError("source_changed", f"Captured bytes differ from source observation: {relative}")

            stage = "source_read"
            if manifest != _source_manifest_locked(source, source_names, pinned_files):
                raise SnapshotBuildError("source_changed", "Source inventory, metadata or content changed during capture")
            observation_completed_at = datetime.now(timezone.utc).isoformat()
        database_count = sum(name.lower().endswith(".db") for name in source_names)
        guarantee = ("per_database_committed_prefix" if len(capture_boundaries) == database_count
                     else "mixed_per_database_capture") if capture_boundaries else "stable_observation"

        stage = "decrypt"
        for database in databases:
            name = database["name"]
            relative = Path(database["path"]).relative_to(source)
            ok = decryptor.decrypt_database(str(captured / relative), str(candidate / name))
            diagnostic = dict(decryptor.last_result)
            diagnostic["source_db_path"] = str(source / relative)
            diagnostics[name] = diagnostic
            if not ok:
                raise SnapshotBuildError("decrypt", f"Database {name}: {diagnostic['error']}", diagnostics=diagnostics)
            if diagnostic["key_authenticated"] is not True:
                raise SnapshotBuildError(
                    "decrypt",
                    f"Database {name}: expected encrypted source database; plaintext import use existing importer",
                    diagnostics=diagnostics,
                )

        stage = "persist"
        source_info = {
            "db_storage_path": str(source),
            "wxid_dir": str(source.parent),
            "snapshot_guarantee": guarantee,
            "observation_completed_at": observation_completed_at,
        }
        (candidate / "_source.json").write_text(json.dumps(source_info, ensure_ascii=False, indent=2), encoding="utf-8")
        # Reserve the generation with mkdir; even a name collision cannot replace
        # an existing directory. This is an unpublished candidate, not a read-side switch.
        generation_target = parent / f"generation-{uuid.uuid4().hex}"
        generation_target.mkdir()
        generation = generation_target
        (generation / "ownership.json").write_text(json.dumps(ownership), encoding="utf-8")
        (generation / "databases").mkdir()
        account_path = generation / "databases" / account
        for name, diagnostic in diagnostics.items():
            diagnostic["output_path"] = str(account_path / name)
            diagnostic["diagnostics"]["path"] = str(account_path / name)
            diagnostic["output_header_debug"]["path"] = str(account_path / name)
        result = {
            "status": "success",
            "account": account,
            "generation_path": str(generation),
            "account_path": str(account_path),
            "guarantee": guarantee,
            "source_unchanged": None if capture_boundaries else True,
            "captured_prefix_unchanged": True,
            "capture_boundaries": capture_boundaries,
            "observation_started_at": observation_started_at,
            "observation_completed_at": observation_completed_at,
            "total_databases": len(databases),
            "manifest": manifest,
            "db_diagnostics": diagnostics,
        }
        (staging / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        candidate.rename(account_path)
        (staging / "manifest.json").rename(generation / "manifest.json")
        stage = "cleanup"
        _remove_owned_directory(staging, parent)
        staging = None
        return result
    except Exception as exc:
        error = exc if isinstance(exc, SnapshotBuildError) else SnapshotBuildError(getattr(exc, "stage", stage), str(exc), diagnostics=diagnostics)
        try:
            for owned in (staging, generation):
                if owned is not None and owned.exists():
                    _remove_owned_directory(owned, parent)
        except Exception as cleanup_exc:
            raise SnapshotBuildError("cleanup", f"{error}; cleanup failed: {cleanup_exc}", diagnostics=diagnostics) from exc
        if error is exc:
            raise
        raise error from exc
