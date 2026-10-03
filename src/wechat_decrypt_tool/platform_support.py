from __future__ import annotations

import platform
import sys
from typing import Any


def current_platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform.startswith("linux"):
        return "linux"
    return str(sys.platform or "unknown")


def is_windows() -> bool:
    return current_platform() == "windows"


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
