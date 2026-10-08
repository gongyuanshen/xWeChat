from __future__ import annotations

from pathlib import Path
from ..snapshot_registry import snapshot_cache_dir


def wrapped_cache_dir(account_dir: Path) -> Path:
    d = snapshot_cache_dir(account_dir) / "_wrapped" / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def wrapped_cache_path(
    *,
    account_dir: Path,
    scope: str,
    year: int,
    implemented_upto: int,
    options_tag: str | None = None,
) -> Path:
    # NOTE: Keep the filename stable and versioned by "implemented_upto" so when we
    # add more cards later we don't accidentally serve a partial cache.
    suffix = f"_{options_tag}" if options_tag else ""
    return wrapped_cache_dir(account_dir) / f"{scope}_{year}_upto_{implemented_upto}{suffix}.json"
