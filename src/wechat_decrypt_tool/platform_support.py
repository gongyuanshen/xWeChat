from __future__ import annotations

import json
import os
import platform
import sys
from pathlib import Path
from typing import Any


def current_platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform.startswith("linux"):
        return "linux"
    return str(sys.platform or "unknown")


def is_windows() -> bool:
    return current_platform() == "windows"


def _native_root() -> Path:
    return Path(__file__).resolve().parent / "native"


def _bundled_native_candidates(relative_path: Path, *, explicit: str = "") -> list[Path]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())

    if getattr(sys, "frozen", False):
        # PyInstaller may normalize Mach-O files collected inside its onefile
        # archive.  The sibling native directory is copied byte-for-byte into
        # the signed app bundle specifically to provide stable runtime paths.
        executable_dir = Path(sys.executable).resolve().parent
        candidates.extend(
            (
                executable_dir / "native" / relative_path,
                executable_dir / "wechat_decrypt_tool" / "native" / relative_path,
            )
        )

    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        root = Path(bundle_root)
        candidates.extend(
            (
                root / "native" / relative_path,
                root / "wechat_decrypt_tool" / "native" / relative_path,
            )
        )

    candidates.append(_native_root() / relative_path)
    return candidates


def _first_existing_native_resource(relative_path: Path, *, explicit: str = "") -> Path:
    candidates = _bundled_native_candidates(relative_path, explicit=explicit)

    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate.resolve()
        except OSError:
            continue
    return candidates[0]


def _native_core_resources_ready(paths: tuple[Path, Path, Path]) -> bool:
    client, broker, manifest_path = paths
    try:
        if not client.is_file() or not broker.is_file() or not manifest_path.is_file():
            return False
        if client.stat().st_size <= 0 or broker.stat().st_size <= 0:
            return False
        if manifest_path.stat().st_size <= 0 or manifest_path.stat().st_size > 16 * 1024:
            return False
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    if (
        not isinstance(manifest, dict)
        or not str(manifest.get("buildId") or "").strip()
        or not isinstance(manifest.get("developmentBuild"), bool)
    ):
        return False
    return manifest.get("schemaVersion") == 2 and "platform" not in manifest


def runtime_capabilities() -> dict[str, Any]:
    system = current_platform()
    architecture = (platform.machine() or "unknown").lower()
    return {
        "platform": system,
        "platform_release": platform.release(),
        "architecture": architecture,
        "apple_silicon": False,
        "database_key_extraction": system == "windows",
        "database_key_manual_input": True,
        "database_decryption": True,
        "image_key_memory_scan": system == "windows",
        "image_key_memory_scan_note": "",
        "realtime_wcdb": system == "windows",
        "realtime_wcdb_note": "",
        "wechat_process_media_hook": system == "windows",
        "account_archive_export": True,
        "account_archive_import": True,
        "account_archive_cross_platform": True,
        "database_key_guidance": "",
        "database_key_build_id": "",
        "database_key_build_expires_at_unix": None,
        "database_key_online_authorization_required": False,
        "suggested_key_tools": [],
    }


__all__ = [
    "current_platform",
    "is_windows",
    "runtime_capabilities",
]
