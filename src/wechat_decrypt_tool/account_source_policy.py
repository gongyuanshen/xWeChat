from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_DECRYPTED_SNAPSHOT_IMPORT_MODES = {
    "manual_import",
    "account_archive_import",
}


def load_account_source_metadata(account_dir: Path) -> dict[str, Any]:
    path = Path(account_dir) / "_source.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def source_metadata_is_imported_snapshot(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    mode = str(value.get("import_mode") or "").strip().lower()
    return mode in _DECRYPTED_SNAPSHOT_IMPORT_MODES

__all__ = [
    "load_account_source_metadata",
    "source_metadata_is_imported_snapshot",
]
