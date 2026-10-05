"""Lock Windows SQLite sources according to their actual SHM ownership.

The lock bytes and double-header protocol follow SQLite's Windows VFS and
walIndexTryHdr: https://sqlite.org/walformat.html and src/{os_win,wal}.c.
No source bytes or read-marks are written. Lock conflicts fail immediately.
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
import ctypes
import mmap
import os
from pathlib import Path
import struct

from .sqlite_wal import _checksum


class WalCaptureError(RuntimeError):
    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


@contextmanager
def _lock(handle: int, offset: int, size: int = 1, *, exclusive: bool = False):
    import pywintypes
    import win32file

    overlap = pywintypes.OVERLAPPED()
    overlap.Offset = offset
    try:
        win32file.LockFileEx(handle, 1 | (2 if exclusive else 0), size, 0, overlap)
    except pywintypes.error as exc:
        if exc.winerror == 33:  # ERROR_LOCK_VIOLATION, not an I/O failure.
            raise WalCaptureError('source_busy', f'SQLite source lock is busy at byte {offset}') from exc
        raise
    try:
        yield
    finally:
        win32file.UnlockFileEx(handle, size, 0, overlap)


def _read_index_header(mapped: mmap.mmap) -> dict:
    # The writer publishes copy 1, memory barrier, copy 0. Read in reverse.
    first = bytes(mapped[:48])
    barrier = ctypes.WinDLL('kernel32', use_last_error=True).FlushProcessWriteBuffers
    barrier.argtypes = []
    barrier.restype = None
    barrier()
    second = bytes(mapped[48:96])
    if first != second:
        raise WalCaptureError('source_busy', 'Concurrent WAL-index header publication')
    if first[12] != 1 or struct.unpack_from('<I', first)[0] != 3007000:
        raise WalCaptureError('source_format', 'Uninitialized or unsupported WAL-index header')
    if first[13] not in (0, 1) or _checksum(first[:40], '<') != struct.unpack_from('<II', first, 40):
        raise WalCaptureError('source_format', 'Invalid WAL-index header checksum or byte order')
    encoded_size = struct.unpack_from('<H', first, 14)[0]
    page_size = 65536 if encoded_size == 1 else encoded_size
    mx_frame, database_pages = struct.unpack_from('<II', first, 16)
    # walIndexRecover initializes the header to zero and sets szPage/nPage
    # only after recovering a committed frame. Preserve that explicit state.
    empty_index = page_size == mx_frame == database_pages == 0
    if not empty_index and (not 512 <= page_size <= 65536 or page_size & (page_size - 1)):
        raise WalCaptureError('source_format', 'Invalid WAL-index page size')
    return {
        'mx_frame': mx_frame,
        'page_size': page_size,
        'database_pages': database_pages,
        'salt': first[32:40],
        'frame_checksum': struct.unpack_from('<II', first, 24),
        'big_endian_checksum': first[13],
    }


def _verify_commit_boundary(wal, header: dict) -> int:
    if header['mx_frame'] == 0:
        return 0  # The index explicitly says to read only the main database.
    size = 32 + header['mx_frame'] * (24 + header['page_size'])
    if size > os.fstat(wal.fileno()).st_size:
        raise WalCaptureError('source_format', 'Committed WAL prefix extends beyond the file')
    wal.seek(0)
    start = wal.read(32)
    magic, version, page_size = struct.unpack('>III', start[:12])
    if (magic not in (0x377f0682, 0x377f0683) or version != 3007000
            or page_size != header['page_size'] or start[16:24] != header['salt']
            or magic & 1 != header['big_endian_checksum']):
        raise WalCaptureError('source_format', 'WAL header does not match the committed index')
    wal.seek(size - header['page_size'] - 24)
    end = wal.read(24)
    if (len(end) != 24 or struct.unpack_from('>I', end, 4)[0] != header['database_pages']
            or header['database_pages'] == 0 or end[8:16] != header['salt']
            or struct.unpack_from('>II', end, 16) != header['frame_checksum']):
        raise WalCaptureError('source_format', 'Final WAL frame does not match the indexed commit')
    return size


@contextmanager
def pin_wal_files(database: Path):
    """Select live WAL pinning or inactive-file observation while holding locks.

    This pins one DB, not a transaction across multiple databases. Callers must
    still verify complete WAL checksums, page authentication and SQLite integrity.
    Without a live VFS owner, keep DMS exclusive and yield no indexed streams or
    boundary. The caller must verify the complete stable DB/WAL files instead;
    stale SHM contents are never authoritative. Live capture errors still fail.
    """
    if os.name != 'nt':
        raise WalCaptureError('source_format', 'Windows WAL locking requires Windows')
    import msvcrt

    with ExitStack() as stack:
        main = stack.enter_context(database.open('rb'))
        main_handle = msvcrt.get_osfhandle(main.fileno())
        # The DB SHARED lock prevents the last owner from deleting WAL/SHM or
        # switching journal mode; PENDING is held only during lock acquisition.
        with _lock(main_handle, 0x40000000):
            stack.enter_context(_lock(main_handle, 0x40000002, 510))
        shm_path = Path(str(database) + '-shm')
        shm = stack.enter_context(shm_path.open('rb'))
        shm_handle = msvcrt.get_osfhandle(shm.fileno())
        try:
            stack.enter_context(_lock(shm_handle, 128, exclusive=True))
        except WalCaptureError as exc:
            if exc.stage != 'source_busy':
                raise
            active = True
        else:
            # Keep the exclusive DMS lock until observation ends. A new VFS
            # owner cannot truncate/reinitialize this inactive SHM underneath us.
            active = False
        streams = {database: main, shm_path: shm}
        if active:
            stack.enter_context(_lock(shm_handle, 128))  # DMS: prevent SHM reinitialization.
            stack.enter_context(_lock(shm_handle, 121))  # Prevent checkpoint/backfill.
            stack.enter_context(_lock(shm_handle, 124))  # Prevent WAL reset/recovery.
            if os.fstat(shm.fileno()).st_size < 136:
                raise WalCaptureError('source_format', 'WAL-index header is incomplete')
            mapped = stack.enter_context(mmap.mmap(shm.fileno(), 96, access=mmap.ACCESS_READ))
            wal_path = Path(str(database) + '-wal')
            wal = stack.enter_context(wal_path.open('rb'))
            streams[wal_path] = wal
        for path, stream in streams.items():
            if not os.path.samestat(os.fstat(stream.fileno()), path.stat()):
                raise WalCaptureError('source_changed', f'Opened source identity differs: {path}')
        if active:
            header = _read_index_header(mapped)
            wal_size = _verify_commit_boundary(wal, header)
            files = {database: (main, os.fstat(main.fileno()).st_size), wal_path: (wal, wal_size)}
            public_header = {k: header[k] for k in ('mx_frame', 'page_size', 'database_pages')}
        else:
            files, public_header = {}, None
        yield files, public_header
        if active:
            _verify_commit_boundary(wal, header)
        for path, stream in streams.items():
            if not os.path.samestat(os.fstat(stream.fileno()), path.stat()):
                raise WalCaptureError('source_changed', f'Source pathname was replaced: {path}')
