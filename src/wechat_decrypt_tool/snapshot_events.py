"""Account-scoped wakeups for published snapshots and completed archives.

Notifications contain no messages. Consumers reread the current published state;
several publications may intentionally coalesce into one refresh of that state.
"""
import threading

_condition = threading.Condition()
_versions: dict[str, int] = {}


def snapshot_event_version(account: str) -> int:
    with _condition:
        return _versions.get(account, 0)


def notify_snapshot_change(account: str) -> None:
    with _condition:
        _versions[account] = _versions.get(account, 0) + 1
        _condition.notify_all()


def wait_snapshot_change(account: str, version: int, *, timeout: float = 10) -> int:
    with _condition:
        _condition.wait_for(lambda: _versions.get(account, 0) != version, timeout=timeout)
        return _versions.get(account, 0)
