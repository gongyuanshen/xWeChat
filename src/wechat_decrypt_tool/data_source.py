"""Validate the single supported database source at request boundaries."""
from typing import Any

from fastapi import HTTPException


def normalize_data_source(value: Any, default: str = "auto") -> str:
    source = str(value or default).strip().lower()
    if source in {"", "auto", "default", "decrypted", "local", "sqlite"}:
        return "decrypted"
    raise HTTPException(status_code=400, detail="Invalid source; only decrypted snapshots are supported.")
