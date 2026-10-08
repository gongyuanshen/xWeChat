"""xwechat annual report (年度总结) backend modules.

This package is intentionally split into small modules so we can implement
ideas incrementally (按点子编号依次实现), avoiding a single giant file.
"""

from pathlib import Path
import sqlite3

from ..account_identity import resolve_account_self_username
from ..account_identity import normalize_account_directory_name


WRAPPED_CONTRACT_VERSION = 1


class WrappedIdentityError(RuntimeError):
    """A report cannot attribute source messages to the selected account."""


def require_wrapped_self_rowid(connection: sqlite3.Connection, account_dir: Path, *, database: str) -> int:
    username = resolve_wrapped_self_username(account_dir)
    row = connection.execute("SELECT rowid FROM Name2Id WHERE user_name = ? LIMIT 1", (username,)).fetchone()
    if row is None:
        raise WrappedIdentityError(f"年度总结无法确认本人发送身份：account={account_dir.name}, sender={username}, database={database}")
    return int(row[0])


def resolve_wrapped_self_username(account_dir: Path) -> str:
    """Return the message sender identity, not the account storage directory name."""
    username = resolve_account_self_username(account_dir)
    if username == account_dir.name:
        return normalize_account_directory_name(username)
    return username
