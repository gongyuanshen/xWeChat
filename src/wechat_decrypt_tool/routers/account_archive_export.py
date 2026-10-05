import os
import re
import shutil
import stat
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, SecretStr

from ..snapshot_registry import start_snapshot_thread, resolve_account_database_dir
from ..account_workers import export_file_response
from ..archive_checksums import write_zip_checksums
from ..chat_helpers import _resolve_account_dir

from ..export_crypto import (
    decode_export_content_key,
    encrypt_export_file_and_remove_source,
    erase_export_content_key,
)

from ..path_fix import PathFixRoute

router = APIRouter(route_class=PathFixRoute)


class AccountArchiveExportRequest(BaseModel):
    account: Optional[str] = Field(None, description="Account directory name. Defaults to the first available account.")
    output_dir: Optional[str] = Field(None, description="Absolute output directory. Defaults to output/exports/{account}.")
    include_databases: bool = Field(True, description="Whether to include decrypted database files.")
    include_resources: bool = Field(True, description="Whether to include resource folders.")
    file_name: Optional[str] = Field(None, description="Optional zip file name, with or without .zip.")
    encrypt: bool = Field(False, description="Encrypt the completed archive as a WEC1 file.")
    content_key_base64: Optional[SecretStr] = Field(
        None,
        description="Base64-encoded 32-byte WEC1 content key; used only when encrypt=true.",
    )


class AccountArchiveCancelled(Exception):
    pass


@dataclass(frozen=True)
class AccountArchiveFile:
    path: Path
    arcname: str
    kind: str
    size: int
    mtime: float
    mode: int
    mtime_ns: int
    device: int
    inode: int


@dataclass
class AccountArchiveExportJob:
    export_id: str
    account: str = ""
    status: str = "queued"
    progress: int = 0
    message: str = "Waiting to start..."
    detail: str = ""
    error: str = ""
    zip_path: str = ""
    file_name: str = ""
    database_count: int = 0
    resource_file_count: int = 0
    total_bytes: int = 0
    processed_bytes: int = 0
    created_at: int = field(default_factory=lambda: int(time.time()))
    updated_at: int = field(default_factory=lambda: int(time.time()))
    cancel_requested: bool = False
    encrypted: bool = False
    content_key: Optional[bytearray] = field(default=None, repr=False)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "exportId": self.export_id,
            "account": self.account,
            "status": self.status,
            "progress": max(0, min(100, int(self.progress or 0))),
            "message": self.message,
            "detail": self.detail,
            "error": self.error,
            "zipPath": self.zip_path,
            "fileName": self.file_name,
            "databaseCount": int(self.database_count or 0),
            "resourceFileCount": int(self.resource_file_count or 0),
            "totalBytes": int(self.total_bytes or 0),
            "processedBytes": int(self.processed_bytes or 0),
            "createdAt": int(self.created_at or 0),
            "updatedAt": int(self.updated_at or 0),
            "cancelRequested": bool(self.cancel_requested),
            "encrypted": bool(self.encrypted),
        }


_SAFE_NAME_RE = re.compile(r"[^0-9A-Za-z._-]+")
# 账号归档以账号目录为边界。数据库通常在账号目录顶层，资源文件通常在子目录中。
_DB_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".db3"}
_SQLITE_HEADER = b"SQLite format 3\x00"
_JOBS: dict[str, AccountArchiveExportJob] = {}
_JOBS_LOCK = threading.RLock()


def _safe_file_name(value: object, fallback: str) -> str:
    text = str(value or "").strip().replace("\\", "/").split("/")[-1]
    text = _SAFE_NAME_RE.sub("_", text).strip("._-")
    return text or fallback


def _normalize_zip_name(value: object, fallback: str) -> str:
    name = _safe_file_name(value, fallback)
    if not name.lower().endswith(".zip"):
        name += ".zip"
    return name


def _is_valid_sqlite(path: Path) -> bool:
    try:
        if not path.is_file():
            return False
        with path.open("rb") as source:
            return source.read(len(_SQLITE_HEADER)) == _SQLITE_HEADER
    except OSError:
        return False


def _require_portable_database_pair(account_dir: Path) -> None:
    required_names = ("contact.db", "session.db")
    missing = [name for name in required_names if not _is_valid_sqlite(account_dir / name)]
    if not missing:
        return
    raise FileNotFoundError(
        "所选账号缺少可迁移的已解密数据库（需要有效的 contact.db 和 session.db）。"
        "实时读取可用不代表已有可导入备份，请先在原电脑完成数据库解密，再重新导出。"
    )


def _resolve_output_dir(account_dir: Path, output_dir_raw: object) -> Path:
    raw = str(output_dir_raw or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (account_dir.parents[1] / "exports" / account_dir.name).resolve()


def _get_job(export_id: str) -> Optional[AccountArchiveExportJob]:
    key = str(export_id or "").strip()
    if not key:
        return None
    with _JOBS_LOCK:
        return _JOBS.get(key)


def _update_job(export_id: str, **changes: Any) -> Optional[AccountArchiveExportJob]:
    with _JOBS_LOCK:
        job = _JOBS.get(str(export_id or "").strip())
        if not job:
            return None
        for key, value in changes.items():
            if hasattr(job, key):
                setattr(job, key, value)
        job.updated_at = int(time.time())
        return job


def _check_cancel(job: AccountArchiveExportJob, tmp_path: Optional[Path] = None) -> None:
    with _JOBS_LOCK:
        if job.cancel_requested:
            raise AccountArchiveCancelled()


def _remove_failed_archive(tmp_path: Optional[Path]) -> str:
    if tmp_path is None:
        return ""
    try:
        tmp_path.unlink(missing_ok=True)
    except OSError as exc:
        return f"Temporary archive cleanup failed: {tmp_path}: {exc}"
    return ""


def _add_file(zip_file: zipfile.ZipFile, item: AccountArchiveFile, check_cancel=lambda: None) -> int:
    expected = (item.device, item.inode, item.size, item.mtime_ns)
    modified = time.localtime(item.mtime)[:6]
    if modified[0] < 1980:
        modified = (1980, 1, 1, 0, 0, 0)
    info = zipfile.ZipInfo(item.arcname, modified)
    info.compress_type = zipfile.ZIP_STORED
    info.file_size = item.size
    info.external_attr = (item.mode & 0xFFFF) << 16
    count = 0
    with item.path.open("rb") as source, zip_file.open(info, "w", force_zip64=True) as target:
        before = os.fstat(source.fileno())
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != expected:
            raise RuntimeError(f"Archive source changed before reading: {item.path}")
        while True:
            check_cancel()
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            target.write(chunk)
            count += len(chunk)
        after = os.fstat(source.fileno())
    current = item.path.stat()
    if (count != item.size or
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != expected or
            (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != expected):
        raise RuntimeError(f"Archive source changed while reading: {item.path}")
    return count


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _iter_selected_account_files(
    *, job: AccountArchiveExportJob, account_dir: Path,
    include_databases: bool, include_resources: bool,
    tmp_path: Optional[Path], zip_path: Optional[Path], output_dir: Optional[Path],
):
    """Flatten the pinned database generation alongside portable account assets."""
    account_prefix = _safe_file_name(account_dir.name, "account")
    database_dir = resolve_account_database_dir(account_dir)
    excluded_names = {"_snapshot_current.json", "_snapshot_cache", "_account_delete_plan.json"}
    excluded_names.update({"_source.json", "_media_keys.json", "_sns_realtime_sync_state.json",
                           "media_path_index.db", "_cache", "cache", "_wrapped"})
    excluded_paths = {Path(p).absolute() for p in (tmp_path, zip_path) if p is not None}
    output_subdir = None
    if output_dir is not None and output_dir != account_dir and _is_relative_to(output_dir, account_dir):
        output_subdir = output_dir

    def selected(path: Path, relative: str, kind: str):
        status = path.lstat()
        if stat.S_ISLNK(status.st_mode) or getattr(status, "st_file_attributes", 0) & 0x400:
            raise RuntimeError(f"Archive source contains an unsupported link: {path}")
        if not stat.S_ISREG(status.st_mode):
            raise RuntimeError(f"Archive source is not a regular file: {path}")
        if path.suffix.lower() in _DB_SUFFIXES:
            for suffix in ("-wal", "-journal"):
                sidecar = path.with_name(path.name + suffix)
                if sidecar.exists() and sidecar.stat().st_size:
                    raise RuntimeError(f"Archive database contains unmerged transaction data: {sidecar}")
        return AccountArchiveFile(path, f"{account_prefix}/{relative}", kind,
                                  status.st_size, status.st_mtime, status.st_mode,
                                  status.st_mtime_ns, status.st_dev, status.st_ino)

    if include_databases:
        for path in sorted(database_dir.iterdir()):
            _check_cancel(job)
            if path.suffix.lower() in _DB_SUFFIXES and path.name not in excluded_names:
                yield selected(path, path.name, "database")
    metadata_path = account_dir / "account.json"
    if metadata_path.exists():
        yield selected(metadata_path, metadata_path.name, "metadata")
    if not include_resources:
        return
    stack = [account_dir]
    while stack:
        root = stack.pop()
        _check_cancel(job)
        with os.scandir(root) as entries:
            for entry in sorted(entries, key=lambda item: item.name):
                path = Path(entry.path)
                relative = path.relative_to(account_dir)
                if (relative.parts[0] in excluded_names
                        or (root == account_dir and path.name.startswith(".account-delete-") and path.suffix == ".json")
                        or path.absolute() in excluded_paths
                        or path == output_subdir or relative.as_posix() == "account.json"):
                    continue
                if root == account_dir and any(entry.name.lower().endswith(suffix + tail)
                                              for suffix in _DB_SUFFIXES for tail in ("-wal", "-shm", "-journal")):
                    continue
                status = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(status.st_mode) or getattr(status, "st_file_attributes", 0) & 0x400:
                    raise RuntimeError(f"Archive source contains an unsupported link: {path}")
                if stat.S_ISDIR(status.st_mode):
                    stack.append(path)
                    continue
                if root == account_dir and path.suffix.lower() in _DB_SUFFIXES:
                    # User-owned anti-revoke history is an asset, never a source shard.
                    if database_dir == account_dir or path.name != "anti_revoke.db":
                        continue
                yield selected(path, relative.as_posix(), "resource")


def _run_account_archive_export(export_id: str, payload: dict[str, Any]) -> None:
    job = _update_job(export_id, status="running", progress=1, message="Preparing export...", detail="")
    if not job:
        return

    zip_path: Optional[Path] = None
    tmp_path: Optional[Path] = None
    temporary_created = False

    try:
        include_databases = bool(payload.get("include_databases"))
        include_resources = bool(payload.get("include_resources"))
        if not include_databases and not include_resources:
            raise ValueError("Please select at least one export option.")

        _check_cancel(job)
        account_dir = _resolve_account_dir(payload.get("account"))
        account_name = account_dir.name
        _update_job(export_id, account=account_name)
        if include_databases:
            _require_portable_database_pair(resolve_account_database_dir(account_dir))
        output_dir = _resolve_output_dir(account_dir, payload.get("output_dir"))
        database_dir = resolve_account_database_dir(account_dir)
        if database_dir != account_dir and _is_relative_to(output_dir, database_dir):
            raise ValueError("Archive output cannot be written inside an immutable database generation")
        output_dir.mkdir(parents=True, exist_ok=True)

        stamp = time.strftime("%Y%m%d_%H%M%S")
        fallback_name = f"wechat_archive_{_safe_file_name(account_name, 'account')}_{stamp}.zip"
        zip_name = _normalize_zip_name(payload.get("file_name"), fallback_name)
        zip_path = (output_dir / zip_name).resolve()
        final_path = zip_path.with_name(zip_path.name + ".wec") if job.content_key is not None else zip_path
        tmp_path = zip_path.with_name(f".{zip_path.name}.{export_id}.tmp")

        _update_job(
            export_id,
            account=account_name,
            file_name=final_path.name,
            zip_path=str(final_path),
            progress=1,
            message="Scanning export content...",
            detail="Calculating total archive size.",
            total_bytes=0,
            processed_bytes=0,
        )

        selected_files = list(_iter_selected_account_files(
            job=job,
            account_dir=account_dir,
            include_databases=include_databases,
            include_resources=include_resources,
            tmp_path=tmp_path,
            zip_path=zip_path,
            output_dir=output_dir,
        ))
        if not selected_files:
            raise FileNotFoundError("No exportable files found for this account.")

        planned_db_count = sum(1 for item in selected_files if item.kind == "database")
        planned_resource_count = sum(1 for item in selected_files if item.kind != "database")
        total_files = len(selected_files)
        total_bytes = sum(max(0, int(item.size or 0)) for item in selected_files)
        if include_databases and not include_resources and planned_db_count <= 0:
            raise FileNotFoundError("No database files found for this account.")
        if include_resources and not include_databases and planned_resource_count <= 0:
            raise FileNotFoundError("No resource files found for this account.")

        _update_job(
            export_id,
            progress=5,
            database_count=planned_db_count,
            resource_file_count=planned_resource_count,
            total_bytes=total_bytes,
            processed_bytes=0,
            message="Writing ZIP archive...",
            detail=f"Ready to pack {total_files} files ({total_bytes / 1024 / 1024:.1f} MB).",
        )

        db_count = 0
        resource_file_count = 0
        processed_bytes = 0
        processed = 0
        last_progress_at = time.monotonic()

        # Use ZIP_STORED intentionally: account archives are mostly SQLite,
        # images, videos and cache files. Re-compressing them is CPU-heavy and
        # often saves little space. This makes archive export behave like a fast
        # folder pack/copy operation.
        with zipfile.ZipFile(tmp_path, "x", compression=zipfile.ZIP_STORED, allowZip64=True) as raw_zf:
            temporary_created = True
            zf = (raw_zf)
            for item in selected_files:
                _check_cancel(job, tmp_path)
                added_size = _add_file(zf, item, lambda: _check_cancel(job))
                processed += 1
                if item.kind == "database":
                    db_count += 1
                else:
                    resource_file_count += 1
                processed_bytes += added_size

                now = time.monotonic()
                if processed <= 5 or processed % 20 == 0 or (now - last_progress_at) >= 0.5:
                    last_progress_at = now
                    if total_bytes > 0:
                        progress = min(95, 5 + int((processed_bytes / total_bytes) * 90))
                    else:
                        progress = min(95, 5 + int((processed / max(1, total_files)) * 90))
                    _update_job(
                        export_id,
                        progress=progress,
                        database_count=db_count,
                        resource_file_count=resource_file_count,
                        total_bytes=total_bytes,
                        processed_bytes=processed_bytes,
                        message="Writing ZIP archive...",
                        detail=(
                            f"Packed {processed}/{total_files} files "
                            f"({processed_bytes / 1024 / 1024:.1f}/{total_bytes / 1024 / 1024:.1f} MB)."
                        ),
                    )
            write_zip_checksums(raw_zf, export_id, check_cancel=lambda: _check_cancel(job))

        _check_cancel(job, tmp_path)
        _update_job(export_id, progress=97, message="Finalizing ZIP archive...", detail="Moving archive to target folder.")
        if job.content_key is not None:
            encrypt_export_file_and_remove_source(
                tmp_path,
                final_path,
                export_id=export_id,
                content_key=job.content_key,
            )
        else:
            with _JOBS_LOCK:
                _check_cancel(job)
                os.replace(tmp_path, final_path)
                job.status = "done"

        _update_job(
            export_id,
            status="done",
            progress=100,
            message="Export completed.",
            detail=f"Exported {db_count} database files and {resource_file_count} resource files.",
            database_count=db_count,
            resource_file_count=resource_file_count,
            total_bytes=total_bytes,
            processed_bytes=processed_bytes,
            zip_path=str(final_path),
            file_name=final_path.name,
        )
    except AccountArchiveCancelled:
        cleanup_error = _remove_failed_archive(tmp_path if temporary_created else None)
        _update_job(export_id, status="error" if cleanup_error else "cancelled",
                    error=cleanup_error, message="Export cancelled.",
                    detail=cleanup_error or "Temporary archive has been removed.")
    except Exception as exc:
        cleanup_error = _remove_failed_archive(tmp_path if temporary_created else None)
        _update_job(export_id, status="error", error=str(exc), message="Export failed.", detail=cleanup_error)
    finally:
        erase_export_content_key(job.content_key)
        job.content_key = None


@router.post("/api/account/archive_export", summary="Create account archive export job")
async def export_account_archive(req: AccountArchiveExportRequest):
    account_dir = _resolve_account_dir(req.account)
    if not req.include_databases and not req.include_resources:
        raise HTTPException(status_code=400, detail="Please select at least one export option.")

    try:
        content_key = decode_export_content_key(
            req.content_key_base64.get_secret_value() if req.content_key_base64 else None,
            enabled=bool(req.encrypt),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = {
        "account": account_dir.name,
        "output_dir": req.output_dir,
        "include_databases": bool(req.include_databases),
        "include_resources": bool(req.include_resources),
        "file_name": req.file_name,
    }
    export_id = uuid.uuid4().hex
    job = AccountArchiveExportJob(
        export_id=export_id,
        encrypted=bool(req.encrypt),
        content_key=content_key,
    )
    with _JOBS_LOCK:
        _JOBS[export_id] = job

    try:
        start_snapshot_thread(account_dir, _run_account_archive_export, args=(export_id, payload),
                              name=f"account-archive-{export_id}")
    except Exception:
        with _JOBS_LOCK:
            _JOBS.pop(export_id, None)
        erase_export_content_key(content_key)
        raise
    return {"status": "success", "job": job.to_public_dict()}


@router.get("/api/account/archive_export/download", summary="Download account archive by file path")
async def download_account_archive(path: str):
    zip_path = Path(str(path or "").strip()).expanduser().resolve()
    if not zip_path.exists() or not zip_path.is_file():
        raise HTTPException(status_code=404, detail="Export file not found.")
    if zip_path.suffix.lower() not in {".zip", ".wec"}:
        raise HTTPException(status_code=400, detail="Invalid export file.")
    return export_file_response(
        str(zip_path),
        media_type="application/octet-stream" if zip_path.suffix.lower() == ".wec" else "application/zip",
        filename=zip_path.name,
    )


@router.get("/api/account/archive_export/{export_id}", summary="Get account archive export job")
async def get_account_archive_export(export_id: str):
    job = _get_job(export_id)
    if not job:
        raise HTTPException(status_code=404, detail="Export not found.")
    return {"status": "success", "job": job.to_public_dict()}


@router.delete("/api/account/archive_export/{export_id}", summary="Cancel account archive export job")
async def cancel_account_archive_export(export_id: str):
    job = _get_job(export_id)
    if not job:
        raise HTTPException(status_code=404, detail="Export not found.")

    with _JOBS_LOCK:
        if job.status in {"done", "error", "cancelled"}:
            return {"status": "success", "job": job.to_public_dict()}
        job.cancel_requested = True
        job.message = "Cancelling export..."
        job.detail = "Waiting for the current file operation to stop."
        job.updated_at = int(time.time())

    return {"status": "success", "job": job.to_public_dict()}
