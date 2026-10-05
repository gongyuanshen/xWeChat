"""Portable file and ZIP checksums, without signatures or native components.

The manifest detects damaged or inconsistent payloads. It does not authenticate
the author: someone able to replace a payload can also replace its checksum.
"""
from __future__ import annotations

import hashlib
import copy
import json
import re
import stat
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any


CHECKSUMS_PATH = "_integrity/checksums.json"
_FORMAT = "xwechat-sha256"
_CHUNK_SIZE = 1024 * 1024
_RESERVED_NAMES = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$", re.IGNORECASE)


class ArchiveChecksumError(ValueError):
    """An archive cannot satisfy the independent checksum format."""


def _safe_path(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ArchiveChecksumError("Archive path must be a nonempty string")
    parts = value.split("/")
    if (
        any(part in {"", ".", ".."} or part.endswith((".", " ")) for part in parts)
        or any(ord(char) < 32 or ord(char) == 127 or char in '\\<>:"|?*' for char in value)
        or any(_RESERVED_NAMES.fullmatch(part.split(".", 1)[0]) for part in parts)
    ):
        raise ArchiveChecksumError(f"Archive contains an unsafe path: {value!r}")
    return value


def _files(
    archive: zipfile.ZipFile,
    *,
    integrity_paths: frozenset[str] = frozenset({CHECKSUMS_PATH}),
) -> dict[str, zipfile.ZipInfo]:
    files: dict[str, zipfile.ZipInfo] = {}
    paths: dict[str, bool] = {}
    for item in archive.infolist():
        directory = item.is_dir()
        name = _safe_path(item.filename[:-1] if directory else item.filename)
        # On Windows ZipFile.write constructs ZipInfo with backslashes and
        # stores its normalized filename. Existing archives must already use
        # the portable spelling. NUL truncation is never acceptable.
        if "\x00" in item.orig_filename or (
            archive.mode not in {"w", "x"} and item.orig_filename != item.filename
        ):
            raise ArchiveChecksumError(f"Archive contains an unsafe path: {item.orig_filename!r}")
        folded = name.casefold()
        if folded in paths:
            raise ArchiveChecksumError(f"Archive contains a duplicate path: {name}")
        paths[folded] = directory
        kind = stat.S_IFMT(item.external_attr >> 16)
        expected_kind = stat.S_IFDIR if directory else stat.S_IFREG
        if kind not in (0, expected_kind):
            raise ArchiveChecksumError(f"Archive member is not a regular file or directory: {name}")
        if item.flag_bits & 1:
            raise ArchiveChecksumError(f"Archive contains an encrypted ZIP member: {name}")
        if folded == "_integrity" and not directory:
            raise ArchiveChecksumError("Archive integrity directory is a file")
        if folded.startswith("_integrity/") and name not in integrity_paths:
            raise ArchiveChecksumError(f"Archive contains a mixed or unknown integrity entry: {name}")
        if not directory:
            files[name] = item
    for name in paths:
        parts = name.split("/")
        for index in range(1, len(parts)):
            parent = "/".join(parts[:index])
            if parent in paths and not paths[parent]:
                raise ArchiveChecksumError(f"Archive has conflicting file and directory paths: {name}")
    return files


def _export_id(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ArchiveChecksumError("Archive exportId must be a nonempty string without control characters")
    return value


def file_checksums(file_name: str, data: bytes, export_id: str) -> dict[str, Any]:
    """Describe one exported file using the same unsigned format as ZIPs."""
    return {
        "format": _FORMAT, "version": 1, "exportId": _export_id(export_id),
        "files": [{"path": _safe_path(file_name), "size": len(data),
                   "sha256": hashlib.sha256(data).hexdigest()}],
    }


def write_file_checksums(path: Path, export_id: str) -> Path:
    target = Path(path)
    manifest = file_checksums(target.name, target.read_bytes(), export_id)
    sidecar = target.with_name(target.name + ".checksums.json")
    sidecar.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return sidecar


def _file_checksum(
    archive: zipfile.ZipFile,
    item: zipfile.ZipInfo,
    check_cancel: Callable[[], None] | None,
) -> dict[str, Any]:
    digest = hashlib.sha256()
    size = 0
    if archive.mode in {"w", "x"} and item.orig_filename != item.filename:
        # CPython's Windows write() stores '/' in the local header but retains
        # '\\' in orig_filename; open() then compares against that stale value.
        # Use a private descriptor for the bytes we just wrote, without changing
        # the archive's member metadata or accepting aliases in imported ZIPs.
        item = copy.copy(item)
        item.orig_filename = item.filename
    try:
        with archive.open(item, "r") as stream:
            while True:
                if check_cancel is not None:
                    check_cancel()
                chunk = stream.read(_CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
                size += len(chunk)
    except (OSError, EOFError, zipfile.BadZipFile) as exc:
        raise ArchiveChecksumError(f"Failed to read archive member: {item.filename}") from exc
    if size != item.file_size:
        raise ArchiveChecksumError(f"Archive member size mismatch: {item.filename}")
    return {"size": size, "sha256": digest.hexdigest()}


def write_zip_checksums(
    archive: zipfile.ZipFile,
    export_id: str,
    *,
    check_cancel: Callable[[], None] | None = None,
) -> dict[str, Any]:
    """Append a checksum manifest for the bytes already written to this ZIP."""
    export_id = _export_id(export_id)
    files = _files(archive)
    if archive.mode not in {"w", "x"}:
        raise ArchiveChecksumError("Archive checksum writer requires a newly created ZIP")
    if CHECKSUMS_PATH in files:
        raise ArchiveChecksumError("Archive checksums already exist")
    if not files:
        raise ArchiveChecksumError("Archive checksum payload must not be empty")
    entries = [
        {"path": name, **_file_checksum(archive, files[name], check_cancel)}
        for name in sorted(files)
    ]
    manifest = {"format": _FORMAT, "version": 1, "exportId": export_id, "files": entries}
    if check_cancel is not None:
        check_cancel()
    archive.writestr(CHECKSUMS_PATH, json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))
    return manifest


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for name, value in pairs:
        if name in result:
            raise ArchiveChecksumError(f"Archive checksum JSON has a duplicate key: {name}")
        result[name] = value
    return result


def read_zip_checksums(archive: zipfile.ZipFile) -> dict[str, dict[str, Any]]:
    """Validate metadata and coverage; callers must also verify payload bytes.

    Returns path -> {size, sha256}. Streaming importers can validate while
    extracting. Use validate_zip_checksums for a complete standalone check.
    """
    files = _files(archive)
    item = files.pop(CHECKSUMS_PATH, None)
    if item is None:
        raise ArchiveChecksumError("Archive checksum manifest is missing")
    try:
        manifest = json.loads(archive.read(item).decode("utf-8"), object_pairs_hook=_unique_json_object)
    except (OSError, EOFError, zipfile.BadZipFile, UnicodeError, json.JSONDecodeError) as exc:
        raise ArchiveChecksumError("Archive checksum manifest cannot be read as UTF-8 JSON") from exc
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"format", "version", "exportId", "files"}
        or manifest["format"] != _FORMAT
        or type(manifest["version"]) is not int
        or manifest["version"] != 1
    ):
        raise ArchiveChecksumError("Archive checksum format or version is unsupported")
    _export_id(manifest["exportId"])
    return validate_file_entries(files, manifest["files"])


def validate_file_entries(
    files: dict[str, zipfile.ZipInfo], entries: Any,
) -> dict[str, dict[str, Any]]:
    """Check safe paths, SHA-256/size records and exact payload coverage."""
    if not isinstance(entries, list) or not entries:
        raise ArchiveChecksumError("Archive checksum file list must not be empty")
    result: dict[str, dict[str, Any]] = {}
    folded_names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise ArchiveChecksumError("Archive checksum file entry is invalid")
        name = _safe_path(entry["path"])
        if name.casefold() in folded_names:
            raise ArchiveChecksumError(f"Archive checksum list has a duplicate path: {name}")
        folded_names.add(name.casefold())
        size, digest = entry["size"], entry["sha256"]
        if type(size) is not int or size < 0:
            raise ArchiveChecksumError(f"Archive checksum file size is invalid: {name}")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ArchiveChecksumError(f"Archive checksum digest is invalid: {name}")
        result[name] = {"size": size, "sha256": digest}
    if set(result) != set(files):
        missing = sorted(set(result) - set(files))
        extra = sorted(set(files) - set(result))
        raise ArchiveChecksumError(f"Archive checksum file set mismatch; missing={missing}, unlisted={extra}")
    for name, entry in result.items():
        if entry["size"] != files[name].file_size:
            raise ArchiveChecksumError(f"Archive checksum size mismatch: {name}")
    return result


def validate_zip_checksums(
    archive: zipfile.ZipFile,
    *,
    check_cancel: Callable[[], None] | None = None,
) -> dict[str, dict[str, Any]]:
    """Verify the manifest and every payload byte, including the ZIP CRC."""
    if check_cancel is not None:
        check_cancel()
    expected = read_zip_checksums(archive)
    for name, entry in expected.items():
        actual = _file_checksum(archive, archive.getinfo(name), check_cancel)
        if actual != entry:
            raise ArchiveChecksumError(f"Archive checksum verification failed: {name}")
    return expected


def remove_file_export_artifacts(path: Path) -> None:
    """Remove one generated plaintext export and its temporary/checksum files."""
    target = Path(path)
    errors: list[OSError] = []
    for candidate in (target, target.with_name(target.name + ".tmp"), target.with_name(target.name + ".checksums.json")):
        try:
            candidate.unlink(missing_ok=True)
        except OSError as exc:
            errors.append(exc)
    if errors:
        raise OSError("failed to remove one or more plaintext export artifacts") from errors[0]
