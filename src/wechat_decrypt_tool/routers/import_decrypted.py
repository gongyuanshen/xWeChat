from __future__ import annotations

import os
import shutil
import json
import hashlib
import sqlite3
import asyncio
import stat
import tempfile
import threading
from contextvars import copy_context
from functools import partial
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..snapshot_registry import (
    legacy_database_write, begin_legacy_database_write,
)
from ..archive_checksums import ArchiveChecksumError, CHECKSUMS_PATH, read_zip_checksums
from ..legacy_archive_signature import read_zip_legacy_signature
from ..app_paths import get_data_dir, get_output_databases_dir
from ..logging_config import get_logger
from ..path_fix import PathFixRoute

logger = get_logger(__name__)

router = APIRouter(route_class=PathFixRoute)

_IMPORT_CANCEL_EVENTS: dict[str, threading.Event] = {}
_IMPORT_COMMIT_LOCK = threading.Lock()
_IMPORT_COMMITTED: set[threading.Event] = set()
_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class ImportCancelled(Exception):
    pass

class ImportRequest(BaseModel):
    import_path: str = Field(..., description="账号归档 ZIP 或已解密数据库目录的绝对路径")

def _is_valid_sqlite(path: Path) -> bool:
    SQLITE_HEADER = b"SQLite format 3\x00"
    try:
        if not path.exists() or not path.is_file():
            return False
        with path.open("rb") as f:
            return f.read(len(SQLITE_HEADER)) == SQLITE_HEADER
    except Exception:
        return False

def _clean_profile_text(value: object) -> str:
    text = str(value or "").replace("\u3164", "").strip()
    return text


def _validated_account_name(value: object) -> str:
    name = _clean_profile_text(value)
    reserved_base = name.rstrip(" .").split(".", 1)[0].upper()
    if (
        not name
        or name in {".", ".."}
        or name.endswith((" ", "."))
        or any(ord(char) < 32 or char in '<>:"/\\|?*' for char in name)
        or reserved_base in _WINDOWS_RESERVED_NAMES
    ):
        raise HTTPException(status_code=400, detail="账号标识不能安全地用作跨平台目录名")
    return name


def _pick_import_account_dir(import_path: Path) -> Path:
    """Resolve the actual account directory; supports selecting output root or wxid_xxx."""
    if (import_path / "databases").is_dir() or (import_path / "database").is_dir():
        return import_path
    if _is_valid_sqlite(import_path / "contact.db") and _is_valid_sqlite(import_path / "session.db"):
        return import_path
    account_dirs: list[Path] = []
    try:
        for child in import_path.iterdir():
            if child.is_dir() and (
                (child / "databases").is_dir()
                or (child / "database").is_dir()
                or (_is_valid_sqlite(child / "contact.db") and _is_valid_sqlite(child / "session.db"))
            ):
                account_dirs.append(child)
    except Exception:
        account_dirs = []
    if len(account_dirs) == 1:
        return account_dirs[0]
    if len(account_dirs) > 1:
        names = ", ".join(p.name for p in account_dirs[:5])
        raise HTTPException(status_code=400, detail=f"Multiple account directories found. Please select one account directory: {names}")
    return import_path


def _pick_database_dir(account_dir: Path) -> Path:
    """Support both this app's databases/ and wxdump's database/ directory names."""
    if _is_valid_sqlite(account_dir / "contact.db") and _is_valid_sqlite(account_dir / "session.db"):
        return account_dir
    for name in ("databases", "database"):
        db_dir = account_dir / name
        if db_dir.exists() and db_dir.is_dir():
            return db_dir
    raise HTTPException(
        status_code=400,
        detail=(
            "未找到可导入的 contact.db 和 session.db。"
            "如果这是本应用导出的账号归档，请直接选择原始 ZIP（无需解压）；"
            "如果 ZIP 内也缺少数据库，请回到原电脑完成数据库解密后重新导出。"
        ),
    )


def _pick_resource_dir(account_dir: Path) -> Optional[Path]:
    """Support both this app's resource/ and wxdump's media/ directory names."""
    for name in ("resource", "media"):
        resource_dir = account_dir / name
        if resource_dir.exists() and resource_dir.is_dir():
            return resource_dir
    return None


def _read_contact_profile(db_dir: Path, username: str) -> dict:
    """Best-effort account profile inference from contact.db."""
    contact_db = db_dir / "contact.db"
    if not _is_valid_sqlite(contact_db):
        return {}
    try:
        conn = sqlite3.connect(contact_db.absolute().as_uri() + "?mode=ro&immutable=1", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("""
                SELECT username, remark, nick_name, alias, big_head_url, small_head_url
                FROM contact
                WHERE username = ?
                LIMIT 1
                """, (username,)).fetchone()
        finally:
            conn.close()
        if not row:
            return {}
        nick = _clean_profile_text(row["nick_name"]) or _clean_profile_text(row["remark"]) or _clean_profile_text(row["alias"]) or username
        return {"username": _clean_profile_text(row["username"]) or username, "nick": nick, "avatar_url": str(row["big_head_url"] or row["small_head_url"] or "").strip(), "alias": _clean_profile_text(row["alias"])}
    except Exception as e:
        logger.warning(f"Failed to read account profile from contact.db: {contact_db}, {e}")
        return {}


def _load_or_infer_account_info(account_dir: Path, db_dir: Path) -> tuple[dict, Optional[Path], bool]:
    """Read account.json; if missing in wxdump output, infer from folder name and contact.db."""
    account_json_path = account_dir / "account.json"
    if account_json_path.exists():
        try:
            account_info = json.loads(account_json_path.read_text(encoding="utf-8"))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to parse account.json: {e}")
        username = _clean_profile_text(account_info.get("username"))
        nick = _clean_profile_text(account_info.get("nick") or account_info.get("nickname"))
        if not username or not nick:
            raise HTTPException(status_code=400, detail="account.json is missing username or nick")
        account_info["username"] = _validated_account_name(username)
        account_info["nick"] = nick
        account_info.setdefault("avatar_url", "")
        return account_info, account_json_path, False
    inferred_username = _clean_profile_text(account_dir.name)
    if not inferred_username:
        raise HTTPException(status_code=400, detail="Missing account.json and cannot infer account from directory name")
    profile = _read_contact_profile(db_dir, inferred_username)
    username = _validated_account_name(_clean_profile_text(profile.get("username")) or inferred_username)
    nick = _clean_profile_text(profile.get("nick")) or _clean_profile_text(profile.get("alias")) or username
    return {"username": username, "nick": nick, "avatar_url": str(profile.get("avatar_url") or ""), "alias": str(profile.get("alias") or "")}, None, True


def _validate_import_structure(import_path: Path) -> dict:
    account_dir = _pick_import_account_dir(import_path)
    _require_plain_path(account_dir)
    if os.path.lexists(account_dir / "_snapshot_current.json"):
        raise HTTPException(
            status_code=400,
            detail="此目录通过指针选择独立快照，根目录数据库不是当前数据。请明确选择已验证代次中的账号数据库目录导入。",
        )
    db_dir = _pick_database_dir(account_dir)
    _require_plain_path(db_dir)
    resource_dir = _pick_resource_dir(account_dir)
    for db_name in ["contact.db", "session.db"]:
        if not _is_valid_sqlite(db_dir / db_name):
            raise HTTPException(status_code=400, detail=f"Missing valid {db_name} in {db_dir.name}")
    account_info, account_json_path, inferred_account = _load_or_infer_account_info(account_dir, db_dir)
    return {"username": account_info["username"], "nick": account_info["nick"], "avatar_url": account_info.get("avatar_url", ""), "alias": account_info.get("alias", ""), "has_resource": resource_dir is not None, "source_format": "wxdump" if db_dir.name == "database" or inferred_account else "wechat_data_analysis", "inferred_account": inferred_account, "account_dir": str(account_dir), "db_dir": str(db_dir), "resource_dir": str(resource_dir) if resource_dir else "", "account_json_path": str(account_json_path) if account_json_path else ""}


def _safe_zip_parts(name: str) -> tuple[str, ...]:
    raw = str(name or "")
    parts = raw.rstrip("/").split("/")
    if (not raw or raw.startswith("/") or "\\" in raw
            or any(not part or part in {".", ".."} or part.endswith((" ", "."))
                   or any(ord(char) < 32 or char in '<>:"|?*' for char in part)
                   or part.split(".", 1)[0].upper() in _WINDOWS_RESERVED_NAMES
                   for part in parts)):
        raise HTTPException(status_code=400, detail=f"Archive contains an unsafe path: {name}")
    return tuple(parts)


def _archive_file_map(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    result: dict[str, zipfile.ZipInfo] = {}
    casefold_names: set[str] = set()
    for item in archive.infolist():
        parts = _safe_zip_parts(item.filename)
        mode = (item.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise HTTPException(status_code=400, detail=f"Archive contains an unsupported symbolic link: {item.filename}")
        if item.flag_bits & 0x1:
            raise HTTPException(status_code=400, detail="Encrypted ZIP archives are not supported")
        if item.is_dir():
            continue
        normalized = "/".join(parts)
        folded = normalized.casefold()
        if normalized in result or folded in casefold_names:
            raise HTTPException(status_code=400, detail=f"Archive contains a duplicate path: {item.filename}")
        result[normalized] = item
        casefold_names.add(folded)
    return result


def _archive_integrity_entries(
    archive: zipfile.ZipFile, files: dict[str, zipfile.ZipInfo],
) -> dict[str, dict] | None:
    if {name.casefold() for name in files}.intersection({
        "_integrity/manifest.wce", "_integrity/signature.wce",
        "_integrity/manifest.json", "_integrity/signature.wes",
    }):
        try:
            return read_zip_legacy_signature(archive)
        except ArchiveChecksumError as exc:
            raise HTTPException(status_code=400, detail=f"旧归档签名验证失败: {exc}") from exc
    if CHECKSUMS_PATH in files:
        try:
            return read_zip_checksums(archive)
        except ArchiveChecksumError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    return None


def _read_archive_json(archive: zipfile.ZipFile, files: dict[str, zipfile.ZipInfo], name: str) -> dict:
    item = files.get(name)
    if item is None:
        return {}
    try:
        payload = json.loads(archive.read(item).decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse {name}: {exc}") from exc


def _validate_import_archive(import_path: Path) -> dict:
    try:
        archive = zipfile.ZipFile(import_path, "r")
    except (OSError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid ZIP archive: {exc}") from exc

    with archive:
        files = _archive_file_map(archive)
        _archive_integrity_entries(archive, files)
        database_parents: dict[str, set[str]] = {}
        for name in files:
            parts = PurePosixPath(name)
            if parts.suffix.lower() != ".db":
                continue
            database_parents.setdefault(str(parts.parent), set()).add(parts.name.lower())

        candidates = [
            parent
            for parent, names in database_parents.items()
            if {"contact.db", "session.db"}.issubset(names)
        ]
        if len(candidates) != 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    "账号归档必须包含同一账号下有效的 contact.db 和 session.db。"
                    "请确认导出时包含已解密数据库。"
                ),
            )

        db_prefix = candidates[0].strip("/")
        db_prefix_path = PurePosixPath(db_prefix)
        account_prefix_path = db_prefix_path.parent if db_prefix_path.name in {"databases", "database"} else db_prefix_path
        account_prefix = str(account_prefix_path).strip("/")
        if not account_prefix or account_prefix == ".":
            raise HTTPException(status_code=400, detail="Archive is missing an account directory")

        for required_name in ("contact.db", "session.db"):
            item = files.get(f"{db_prefix}/{required_name}")
            if item is None:
                raise HTTPException(status_code=400, detail=f"Archive is missing {required_name}")
            with archive.open(item, "r") as stream:
                if stream.read(16) != b"SQLite format 3\x00":
                    raise HTTPException(status_code=400, detail=f"Archive contains an invalid {required_name}")

        account_json_name = f"{account_prefix}/account.json"
        account_info = _read_archive_json(archive, files, account_json_name)
        inferred_username = account_prefix_path.name
        username = _validated_account_name(_clean_profile_text(account_info.get("username")) or inferred_username)
        nick = _clean_profile_text(account_info.get("nick") or account_info.get("nickname")) or username
        if not username:
            raise HTTPException(status_code=400, detail="Archive account name is empty")

        db_count = sum(1 for name in files if name.startswith(db_prefix + "/") and name.lower().endswith(".db"))
        resource_prefix = f"{account_prefix}/resource/"
        integrity_present = "_integrity/manifest.wce" in files or CHECKSUMS_PATH in files
        return {
            "username": username,
            "nick": nick,
            "avatar_url": str(account_info.get("avatar_url") or ""),
            "alias": str(account_info.get("alias") or ""),
            "has_resource": any(name.startswith(resource_prefix) for name in files),
            "source_format": "wechat_data_analysis_archive",
            "inferred_account": not bool(account_info),
            "account_dir": "",
            "db_dir": "",
            "resource_dir": "",
            "account_json_path": "",
            "archive_path": str(import_path),
            "archive_account_prefix": account_prefix,
            "archive_db_prefix": db_prefix,
            "incoming_db_count": db_count,
            "integrity_present": integrity_present,
        }


def _validate_import_source(import_path: Path) -> dict:
    if import_path.is_file():
        if import_path.suffix.lower() != ".zip":
            raise HTTPException(status_code=400, detail="Import file must be a ZIP account archive")
        return _validate_import_archive(import_path)
    if import_path.is_dir():
        return _validate_import_structure(import_path)
    raise HTTPException(status_code=400, detail="Import path does not exist")


def _copy_verified_database(source: Path, destination: Path, check_cancel) -> None:
    before = source.lstat()
    if stat.S_ISLNK(before.st_mode) or getattr(before, "st_file_attributes", 0) & 0x400:
        raise RuntimeError(f"Database source is an unsupported link: {source}")
    for suffix in ("-wal", "-journal"):
        sidecar = source.with_name(source.name + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise RuntimeError(f"Database source contains unmerged transaction data: {sidecar}")
    with source.open("rb") as src, destination.open("xb") as target:
        while True:
            check_cancel()
            data = src.read(1024 * 1024)
            if not data:
                break
            target.write(data)
    after = source.stat()
    if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        raise RuntimeError(f"Database source changed during import: {source}")
    for suffix in ("-wal", "-journal"):
        sidecar = source.with_name(source.name + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise RuntimeError(f"Database source acquired unmerged transaction data: {sidecar}")
    connection = sqlite3.connect(destination.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        connection.set_progress_handler(lambda: int(_cancelled(check_cancel)), 10000)
        result = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        if result != ["ok"]:
            raise RuntimeError(f"Database integrity check failed: {source.name}: {result}")
    except sqlite3.DatabaseError as exc:
        check_cancel()
        raise RuntimeError(f"Database integrity check failed: {source.name}: {exc}") from exc
    finally:
        connection.close()


def _cancelled(check_cancel) -> bool:
    check_cancel()
    return False


def _count_db_files(db_dir: Path) -> int:
    try:
        return sum(1 for f in db_dir.iterdir() if f.is_file() and f.suffix.lower() == ".db")
    except Exception:
        return 0


def _is_dir_nonempty(path: Path) -> bool:
    try:
        return path.exists() and path.is_dir() and any(path.iterdir())
    except Exception:
        return False


def _paths_overlap(a: Path, b: Path) -> bool:
    try:
        ar = a.resolve()
        br = b.resolve()
    except Exception:
        ar = a.absolute()
        br = b.absolute()
    return ar == br or ar in br.parents or br in ar.parents


def _build_target_state(info: dict) -> dict:
    output_base = get_output_databases_dir()
    account_name = str(info.get("username") or "").strip()
    target_dir = output_base / account_name if account_name else output_base
    resource_dir = target_dir / "resource"
    db_files: list[str] = []
    try:
        if target_dir.exists() and target_dir.is_dir():
            db_files = sorted(f.name for f in target_dir.iterdir() if f.is_file() and f.suffix.lower() == ".db")
    except Exception:
        db_files = []
    paths = [Path(str(info.get("account_dir") or "")), Path(str(info.get("db_dir") or ""))]
    if info.get("resource_dir"):
        paths.append(Path(str(info.get("resource_dir"))))
    archive_source = bool(info.get("archive_path"))
    incoming_db_count = (
        int(info.get("incoming_db_count") or 0)
        if archive_source
        else _count_db_files(Path(str(info.get("db_dir") or "")))
    )
    return {"target_dir": str(target_dir), "target_exists": target_dir.exists(), "target_nonempty": _is_dir_nonempty(target_dir), "existing_db_count": len(db_files), "existing_db_files": db_files[:50], "incoming_db_count": incoming_db_count, "target_has_resource": resource_dir.exists(), "will_replace_resource": bool(resource_dir.exists() and (info.get("resource_dir") or archive_source)), "source_overlaps_target": False if archive_source else any(_paths_overlap(x, target_dir) for x in paths if str(x))}


def _extract_import_archive(import_path: Path, destination: Path, check_cancel) -> None:
    with zipfile.ZipFile(import_path, "r") as archive:
        files = _archive_file_map(archive)
        checksums = _archive_integrity_entries(archive, files)
        expected_hashes = ({name: item["sha256"] for name, item in checksums.items()}
                           if checksums is not None else {})
        if expected_hashes:
            unsigned = sorted(name for name in files if not name.startswith("_integrity/") and name not in expected_hashes)
            if unsigned:
                raise RuntimeError(f"归档包含未登记到完整性清单的文件: {unsigned[0]}")
        verified_names: set[str] = set()
        for name, item in files.items():
            check_cancel()
            target = destination.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            written_size = 0
            with archive.open(item, "r") as source, target.open("wb") as output:
                while True:
                    check_cancel()
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    digest.update(chunk)
                    written_size += len(chunk)
            if checksums is not None and name in checksums and written_size != checksums[name]["size"]:
                raise RuntimeError(f"归档文件长度校验失败: {name}")
            expected = expected_hashes.get(name)
            if expected and digest.hexdigest() != expected:
                raise RuntimeError(f"归档文件校验失败: {name}")
            if expected:
                verified_names.add(name)
        missing = sorted(set(expected_hashes) - verified_names)
        if missing:
            raise RuntimeError(f"归档完整性清单中的文件缺失: {missing[0]}")


def _copy_portable_entry(source: Path, target: Path, check_cancel) -> None:
    check_cancel()
    before = source.lstat()
    if stat.S_ISLNK(before.st_mode) or getattr(before, "st_file_attributes", 0) & 0x400:
        raise RuntimeError(f"Import source contains an unsupported link: {source}")
    if stat.S_ISDIR(before.st_mode):
        target.mkdir()
        for child in sorted(source.iterdir()):
            _copy_portable_entry(child, target / child.name, check_cancel)
        return
    if not stat.S_ISREG(before.st_mode):
        raise RuntimeError(f"Import source is not a regular file: {source}")
    with source.open("rb") as src, target.open("xb") as output:
        while True:
            check_cancel()
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    after = source.stat()
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise RuntimeError(f"Import source changed during copy: {source}")


def _copy_supplemental_account_entries(info: dict, destination: Path, check_cancel=lambda: None) -> None:
    account_source = Path(info["account_dir"])
    db_source = Path(info["db_dir"])
    resource_source = Path(info["resource_dir"]) if info.get("resource_dir") else None
    excluded_names = {"account.json", "_source.json", "_snapshot_current.json", "_snapshot_cache", "_account_delete_plan.json"}
    excluded_names.update({"_media_keys.json", "_sns_realtime_sync_state.json", "media_path_index.db"})
    for item in sorted(account_source.iterdir()):
        if (item.name in excluded_names or item == db_source or item == resource_source
                or (item.name.startswith(".account-delete-") and item.suffix == ".json")):
            continue
        if item.is_file() and item.suffix.lower() == ".db":
            continue
        _copy_portable_entry(item, destination / item.name, check_cancel)


def _next_backup_dir(account_output_dir: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # Keep rollback copies outside output/databases. Account discovery treats
    # directories under databases as selectable accounts, so a sibling
    # `wxid_xxx.backup-*` would surface stale data in the UI.
    backup_root = account_output_dir.parent.parent / "account_backups" / account_output_dir.name
    _require_plain_path(backup_root)
    backup_root.mkdir(parents=True, exist_ok=True)
    base = backup_root / stamp
    candidate = base
    i = 1
    while candidate.exists():
        candidate = backup_root / f"{stamp}-{i}"
        i += 1
    return candidate


def _backup_existing_account_dir(account_output_dir: Path) -> Optional[Path]:
    if not account_output_dir.exists():
        return None
    backup_dir = _next_backup_dir(account_output_dir)
    os.replace(account_output_dir, backup_dir)
    return backup_dir


def _rollback_account_backup(account_output_dir: Path, backup_dir: Optional[Path]) -> None:
    if not backup_dir or not backup_dir.exists():
        return
    if account_output_dir.exists():
        if account_output_dir.is_symlink() or account_output_dir.is_file():
            account_output_dir.unlink()
        else:
            shutil.rmtree(account_output_dir)
    os.replace(backup_dir, account_output_dir)
    try:
        backup_dir.parent.rmdir()
        backup_dir.parent.parent.rmdir()
    except OSError:
        pass


def _remove_path(path: Optional[Path]) -> None:
    if path is None or not path.exists():
        return
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)


def _install_staged_account(staging_dir: Path, account_output_dir: Path,
                            cancel_event: Optional[threading.Event] = None) -> Optional[Path]:
    _require_plain_path(staging_dir)
    _require_plain_path(account_output_dir)
    with _IMPORT_COMMIT_LOCK, legacy_database_write(account_output_dir):
        if cancel_event is not None and cancel_event.is_set():
            raise ImportCancelled("用户已取消导入")
        backup_dir = _backup_existing_account_dir(account_output_dir)
        try:
            os.replace(staging_dir, account_output_dir)
        except Exception:
            _rollback_account_backup(account_output_dir, backup_dir)
            raise
        if cancel_event is not None:
            _IMPORT_COMMITTED.add(cancel_event)
        return backup_dir


def _require_plain_path(path: Path) -> None:
    for candidate in (*reversed(path.parents), path):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise RuntimeError(f"Import paths cannot contain links: {candidate}")


@router.post("/api/import_decrypted/preview", summary="预览待导入的账号信息")
async def preview_import(request: ImportRequest):
    import_path = Path(request.import_path.strip())
    if not import_path.exists():
        raise HTTPException(status_code=400, detail="导入路径不存在")
        
    info = _validate_import_source(import_path)
    info.update(_build_target_state(info))
    return info

@router.post("/api/import_decrypted/cancel", summary="取消正在执行的导入任务")
async def cancel_import_decrypted(job_id: str = Query(..., description="导入任务 ID")):
    with _IMPORT_COMMIT_LOCK:
        cancel_event = _IMPORT_CANCEL_EVENTS.get(str(job_id or ""))
        if cancel_event:
            if cancel_event in _IMPORT_COMMITTED:
                return {"status": "already_completed"}
            cancel_event.set()
            return {"status": "cancel_requested"}
    return {"status": "not_found"}

@router.get("/api/import_decrypted", summary="执行导入已解密的数据库和资源目录 (SSE)")
async def import_decrypted_directory(
    import_path: str = Query(..., description="已解密的数据库和资源所在目录的绝对路径"),
    job_id: str = Query("", description="导入任务 ID，用于取消导入")
):
    import_path_obj = Path(import_path.strip())
    account_output_dir: Optional[Path] = None
    staging_output_dir: Optional[Path] = None
    backup_dir: Optional[Path] = None
    backup_restored = False
    archive_temp_dir: Optional[tempfile.TemporaryDirectory] = None
    write_lease = None
    job_key = str(job_id or "").strip()
    cancel_event = threading.Event()
    if job_key:
        if job_key in _IMPORT_CANCEL_EVENTS:
            raise HTTPException(status_code=409, detail="An import with this job ID is already running")
        _IMPORT_CANCEL_EVENTS[job_key] = cancel_event
    
    def _sse(data: dict):
        return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

    def _check_cancel():
        if cancel_event.is_set():
            raise ImportCancelled("用户已取消导入")

    async def _run_worker(function, *args, **kwargs):
        # A cancelled asyncio waiter does not stop its OS thread. Keep waiting,
        # including repeated cancellation, before releasing paths or write leases.
        task = asyncio.get_running_loop().run_in_executor(
            None, copy_context().run, partial(function, *args, **kwargs)
        )
        cancelled = None
        while True:
            try:
                result = await asyncio.shield(task)
                break
            except asyncio.CancelledError as exc:
                cancel_event.set()
                if task.done():
                    # The executor has finished; propagate cancellation instead
                    # of repeatedly awaiting an already-completed future.
                    raise
                cancelled = exc
            except Exception:
                if cancelled is not None:
                    logger.exception("Import worker stopped after request cancellation")
                    raise cancelled
                raise
        if cancelled is not None:
            raise cancelled
        return result

    async def generate_progress():
        nonlocal account_output_dir, staging_output_dir, backup_dir, backup_restored, archive_temp_dir, write_lease
        try:
            if not import_path_obj.exists():
                yield _sse({"type": "error", "message": "导入路径不存在"})
                return

            yield _sse({"type": "progress", "percent": 5, "message": "正在验证目录结构..."})
            import_source = import_path_obj
            archive_source = import_path_obj.is_file()
            if archive_source:
                if import_path_obj.suffix.lower() != ".zip":
                    yield _sse({"type": "error", "message": "导入文件必须是 ZIP 账号归档"})
                    return
                temp_root = get_data_dir() / "import-tmp"
                await _run_worker(temp_root.mkdir, parents=True, exist_ok=True)
                archive_temp_dir = tempfile.TemporaryDirectory(prefix="account-archive-", dir=temp_root)
                yield _sse({"type": "progress", "percent": 7, "message": "正在校验并解压账号归档..."})
                await _run_worker(
                    _extract_import_archive,
                    import_path_obj,
                    Path(archive_temp_dir.name),
                    _check_cancel,
                )
                import_source = Path(archive_temp_dir.name)

            # 1. 验证并获取账号信息
            try:
                info = await _run_worker(_validate_import_structure, import_source)
                if archive_source:
                    info["source_format"] = "wechat_data_analysis_archive"
                    info["archive_path"] = str(import_path_obj)
            except HTTPException as e:
                yield _sse({"type": "error", "message": e.detail})
                return
            except Exception as e:
                yield _sse({"type": "error", "message": f"验证失败: {e}"})
                return
            
            _check_cancel()
            info.update(_build_target_state(info))
            if info.get("source_overlaps_target"):
                yield _sse({"type": "error", "message": "导入源目录与目标数据目录相同或相互包含，请选择外部备份目录。"})
                return

            account_name = info["username"]
            yield _sse({"type": "progress", "percent": 10, "message": f"验证成功：{account_name}"})
            
            # 2. 先写入同盘临时目录，全部成功后再替换正式账号目录。
            output_base = get_output_databases_dir()
            await _run_worker(output_base.mkdir, parents=True, exist_ok=True)
            account_output_dir = output_base / account_name
            write_lease = begin_legacy_database_write(account_output_dir, exclusive=True)
            staging_output_dir = Path(
                await _run_worker(
                    tempfile.mkdtemp,
                    prefix=f".{account_name}.import-",
                    dir=output_base,
                )
            )

            yield _sse({"type": "progress", "percent": 15, "message": "正在准备目标目录..."})

            # 3. 导入 databases 目录下的 .db 文件
            db_src_dir = Path(info["db_dir"])
            db_files = sorted(f for f in db_src_dir.iterdir() if f.is_file() and f.suffix.lower() == ".db")
            imported_files = []
            
            for i, item in enumerate(db_files):
                _check_cancel()
                target = staging_output_dir / item.name
                def _do_import_db(src, dst):
                    _check_cancel()
                    _copy_verified_database(src, dst, _check_cancel)
                
                try:
                    await _run_worker(_do_import_db, item, target)
                    imported_files.append(item.name)
                except Exception as e:
                    logger.error(f"导入数据库失败: {item.name}, error: {e}")
                    raise RuntimeError(f"导入数据库失败: {item.name}: {e}") from e
                
                percent = 15 + int((i + 1) / (len(db_files) or 1) * 15)
                yield _sse({"type": "progress", "percent": percent, "message": f"正在导入数据库: {item.name}"})

            # 4. 导入 resource 目录
            resource_src = Path(info["resource_dir"]) if info.get("resource_dir") else None
            if resource_src and resource_src.exists() and resource_src.is_dir():
                yield _sse({"type": "progress", "percent": 30, "message": "正在导入资源文件 (这可能需要一些时间)..."})
                resource_dst = staging_output_dir / "resource"
                
                await _run_worker(_copy_portable_entry, resource_src, resource_dst, _check_cancel)
                yield _sse({"type": "progress", "percent": 48, "message": "资源文件复制完成。"})

                # 5. 转换 .wxgf 资源 (新增加的流程)
                yield _sse({"type": "progress", "percent": 50, "message": "正在搜索并转换 .wxgf 图片..."})
                
                
            # 6. Copy metadata and all additional account resources (sns_resource, caches, media keys, ...).
            await _run_worker(_copy_supplemental_account_entries, info, staging_output_dir, _check_cancel)

            # 7. Copy or generate account.json
            def _write_imported_account_json(dst: Path, info: dict) -> None:
                src = Path(str(info.get("account_json_path") or ""))
                target = dst / "account.json"
                if src.exists() and src.is_file():
                    shutil.copy2(src, target)
                    return
                payload = {
                    "username": info.get("username") or dst.name,
                    "nick": info.get("nick") or info.get("username") or dst.name,
                    "avatar_url": info.get("avatar_url") or "",
                    "alias": info.get("alias") or "",
                    "generated_by": "manual_import",
                    "source_format": info.get("source_format") or "unknown",
                }
                target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

            yield _sse({"type": "progress", "percent": 85, "message": "正在更新账号配置..."})
            await _run_worker(_write_imported_account_json, staging_output_dir, info)

            # 8. 保存来源信息
            def _save_source_info(dst, path, info):
                (dst / "_source.json").write_text(
                    json.dumps(
                        {
                            # `path` is an archive/decrypted snapshot source, not
                            # a live WeChat db_storage directory. Recording it as
                            # db_storage_path makes source=auto reconnect to data
                            # from the current computer for the same wxid.
                            "import_source_path": str(path),
                            "import_mode": "manual_import",
                            "imported_at": datetime.now().isoformat(),
                            "original_info": info
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )

            source_path = import_path_obj if archive_source else Path(info.get("account_dir") or import_path_obj)
            await _run_worker(_save_source_info, staging_output_dir, source_path, info)

            # Independent imports preserve the verified databases byte for byte.
            _check_cancel()
            yield _sse({"type": "progress", "percent": 96, "message": "正在启用已验证的账号数据..."})
            with write_lease.scope():
                backup_dir = await _run_worker(_install_staged_account, staging_output_dir, account_output_dir, cancel_event)
            staging_output_dir = None

            yield _sse({
                "type": "complete",
                "status": "success",
                "account": account_name,
                "nick": info["nick"],
                "message": f"成功导入账号 {info['nick']} ({account_name})",
                "backup_dir": str(backup_dir) if backup_dir else ""
            })

        except ImportCancelled:
            try:
                await _run_worker(_remove_path, staging_output_dir)
            except Exception as rollback_error:
                logger.error(f"取消导入后清理临时目录失败: {rollback_error}", exc_info=True)
            suffix = "，已恢复导入前备份" if backup_restored else ""
            yield _sse({"type": "error", "message": f"导入已取消{suffix}"})
        except Exception as e:
            logger.error(f"导入失败: {e}", exc_info=True)
            try:
                await _run_worker(_remove_path, staging_output_dir)
            except Exception as rollback_error:
                logger.error(f"导入失败后清理临时目录失败: {rollback_error}", exc_info=True)
            suffix = "，已恢复导入前备份" if backup_restored else ""
            yield _sse({"type": "error", "message": f"导入失败: {str(e)}{suffix}"})
        finally:
            def _cleanup_import_paths():
                errors = []
                for path, cleanup in (
                    (staging_output_dir, lambda: _remove_path(staging_output_dir)),
                    (archive_temp_dir.name if archive_temp_dir else None,
                     lambda: archive_temp_dir.cleanup() if archive_temp_dir else None),
                ):
                    if path is None:
                        continue
                    try:
                        cleanup()
                    except OSError as exc:
                        logger.exception("Import cleanup failed: %s", path)
                        errors.append(exc)
                if errors:
                    raise RuntimeError("Import temporary paths could not all be cleaned") from errors[0]
            try:
                await _run_worker(_cleanup_import_paths)
            finally:
                if write_lease is not None:
                    write_lease.release()
                if job_key:
                    _IMPORT_CANCEL_EVENTS.pop(job_key, None)
                with _IMPORT_COMMIT_LOCK:
                    _IMPORT_COMMITTED.discard(cancel_event)

    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    }
    return StreamingResponse(generate_progress(), headers=headers)
