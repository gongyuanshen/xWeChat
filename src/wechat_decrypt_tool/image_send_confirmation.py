"""Confirm a matching local outgoing image record from verified snapshots.

This proves local record/content correlation, not recipient delivery. No send or
retry operation is performed here; ambiguous evidence is always an error.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sqlite3
import time

from PIL import Image

from .account_identity import resolve_account_self_rowid
from . import chat_helpers as chat
from . import media_helpers as media
from .independent_snapshot import _source_manifest
from .logging_config import get_logger
from .snapshot_refresh import SNAPSHOT_REFRESH
from .snapshot_registry import resolve_account_database_dir, snapshot_read_scope

logger = get_logger(__name__)


class ImageConfirmationError(RuntimeError):
    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


@dataclass(frozen=True)
class ImageRecordConfirmation:
    generation: str
    db: str
    table: str
    local_id: int
    server_id: str
    match_kind: str


def _readonly(path: Path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _pixels(data: bytes):
    with Image.open(io.BytesIO(data)) as image:
        if getattr(image, "n_frames", 1) != 1:
            raise ImageConfirmationError("image_format", "图片记录确认仅支持单帧图片")
        image.load()
        return image.size, int(image.getexif().get(274, 1)), image.info.get("icc_profile", b""), image.convert("RGBA").tobytes()


def _check_refresh_status(status):
    error = status.get("error")
    if error:
        raise ImageConfirmationError("snapshot_refresh", f"图片记录确认的快照同步失败：{error['stage']} · {error['message']}")


def _message_manifest(manifest):
    return {name: fingerprint for name, fingerprint in manifest.items()
            if re.fullmatch(r"message_\d+\.db(?:-wal|-journal)?", Path(name).name, re.IGNORECASE)}


class ImageSendConfirmation:
    @classmethod
    def prepare(cls, account: str, username: str, image_path: Path):
        account = SNAPSHOT_REFRESH._validate_account(account)
        if not isinstance(username, str) or not username.strip() or any(ord(c) < 32 for c in username):
            raise ImageConfirmationError("conversation", "图片记录确认需要明确的会话用户名")
        self = cls()
        self.account, self.username = account, username.strip()
        self.image_path = Path(image_path)
        self.image_bytes = self.image_path.read_bytes()
        self.image_digest = hashlib.sha256(self.image_bytes).digest()
        self.image_pixels = _pixels(self.image_bytes)
        self.prepared_at = int(time.time())
        self.source_binding = None
        self.captured = False
        self.deadline = None
        with snapshot_read_scope(independent=True) as pins:
            pins.clear()
            status = SNAPSHOT_REFRESH.status(account)
            _check_refresh_status(status)
            if status["active_account"] is not None and (
                status["active_account"] != account or not status["enabled"]
            ):
                raise ImageConfirmationError("snapshot_busy", "快照同步正在处理其他任务，未提交图片；请稍后重试")
        with snapshot_read_scope(independent=True) as pins:
            pins.clear()
            self._read_snapshot()
        return self

    def _checkpoint(self):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            if not self.captured:
                raise ImageConfirmationError("baseline_timeout", "未在限定时间内取得新鲜的图片发送基线，未提交图片；请完成同步后重试")
            raise ImageConfirmationError("timeout", "未在限定时间内确认匹配的本地出站图片记录，请在微信核对，避免重复发送")

    def _read_snapshot(self):
        self._checkpoint()
        context, source, key = SNAPSHOT_REFRESH._inputs(self.account)
        source_stat = source.stat()
        binding = (context.account_dir, source, source_stat.st_dev, source_stat.st_ino,
                   hashlib.sha256(key.encode("ascii")).digest())
        if self.source_binding is not None and binding != self.source_binding:
            raise ImageConfirmationError("source_changed", "图片发送期间账号来源或数据库密钥发生变化，请人工核对")
        directory = resolve_account_database_dir(context.account_dir)
        if directory == context.account_dir:
            raise ImageConfirmationError("snapshot_missing", "图片发送需要当前账号已验证的独立快照，请先完成同步")
        generation = directory.parents[1]
        ownership = json.loads((generation / "ownership.json").read_text(encoding="utf-8"))
        if Path(ownership["source_db_storage_path"]).resolve() != source:
            raise ImageConfirmationError("source_changed", "已验证快照与当前账号来源不一致，未确认图片记录")
        self.source_binding = binding
        self.account_dir, self.source_dir = context.account_dir, source
        expected = hashlib.md5(self.username.encode("utf-8")).hexdigest()
        rows = []
        tables_found = 0
        for database in sorted(directory.glob("message_*.db")):
            self._checkpoint()
            if not re.fullmatch(r"message_\d+", database.stem):
                continue
            with closing(_readonly(database)) as connection:
                names = [str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                tables = [name for name in names if name.lower() in {"msg_" + expected, "chat_" + expected}]
                if len(tables) > 1:
                    raise ImageConfirmationError("conversation", "消息分库包含多个同会话表，无法唯一确认图片")
                if not tables:
                    continue
                table = tables[0]
                tables_found += 1
                sender_id, sender = resolve_account_self_rowid(connection, context.account_dir)
                if sender_id is None:
                    raise ImageConfirmationError("sender", "消息分库缺少当前账号的准确发送者身份，未确认图片")
                for record in connection.execute(
                    f"SELECT * FROM {chat._quote_ident(table)} WHERE local_type=3 AND create_time>=?",
                    (self.prepared_at,),
                ):
                    row = dict(record)
                    row.update(db=database.stem, table=table,
                               identity=(database.stem, table, int(record["local_id"])),
                               outgoing=int(record["real_sender_id"] or 0) == sender_id)
                    rows.append(row)
        if not tables_found:
            raise ImageConfirmationError("conversation", "已验证快照中没有目标会话的准确消息表，未提交图片")
        self._checkpoint()
        return directory, rows

    def capture(self, timeout_s: float = 10):
        """Require a snapshot covering the current committed source before submission."""
        self.captured = False
        if hashlib.sha256(self.image_path.read_bytes()).digest() != self.image_digest:
            raise ImageConfirmationError("image_changed", "待发送图片在准备确认后发生变化，未提交图片")
        if isinstance(timeout_s, bool) or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("Image baseline timeout must be positive and finite")
        started = time.monotonic()
        self.deadline = started + timeout_s
        try:
            with snapshot_read_scope(independent=True) as pins:
                pins.clear()
                with SNAPSHOT_REFRESH._lock:
                    requested = SNAPSHOT_REFRESH.once(self.account)
                    _check_refresh_status(requested)
                    worker = None if requested["enabled"] else SNAPSHOT_REFRESH._thread
            if worker is not None:
                # A single refresh still owns the service while archiving and
                # while releasing its work lease after clearing active_account.
                # Wait for this exact worker; continuous workers stay enabled.
                worker.join(max(0, self.deadline - time.monotonic()))
                self._checkpoint()
            while True:
                self._checkpoint()
                with snapshot_read_scope(independent=True) as pins:
                    # Independent work normally inherits pins. This observation
                    # needs the latest generation without changing its caller.
                    pins.clear()
                    with SNAPSHOT_REFRESH._lock:
                        status = SNAPSHOT_REFRESH.status(self.account)
                        worker = SNAPSHOT_REFRESH._thread
                        finished = status["active_account"] is None and (
                            worker is None or not worker.is_alive())
                    _check_refresh_status(status)
                    if finished or (status["enabled"] and (
                        not status["running"] or status["phase"] == "archiving"
                    )):
                        directory, rows = self._read_snapshot()
                        manifest = json.loads((directory.parents[1] / "manifest.json").read_text(encoding="utf-8"))
                        # Idle state alone is no proof: an old generation can
                        # omit an already committed row, including future-dated
                        # records. Check the same committed source fingerprint.
                        if _source_manifest(self.source_dir, checkpoint=self._checkpoint) != manifest["manifest"]:
                            raise ImageConfirmationError("baseline_stale", "微信已提交数据尚未被当前快照完整覆盖，未提交图片；请完成同步后重试")
                        self._checkpoint()
                        self.generation = directory.parents[1].name
                        self.before = {row["identity"] for row in rows}
                        self.message_manifest = _message_manifest(manifest["manifest"])
                        self.captured = True
                        return
                self._checkpoint()
                time.sleep(min(.1, max(0, self.deadline - time.monotonic())))
        finally:
            self.deadline = None
            logger.info("Image confirmation capture: elapsed_ms=%.1f; ready=%s; completed_at=%.6f",
                        (time.monotonic() - started) * 1000, self.captured, time.time())

    def revalidate(self, timeout_s: float = 10):
        """Reuse the baseline unless message DB contents or inventory changed."""
        if not self.captured:
            raise ImageConfirmationError("state", "图片提交前尚未准备确认基线")
        if isinstance(timeout_s, bool) or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("Image baseline timeout must be positive and finite")
        started = time.monotonic()
        self.deadline = started + timeout_s
        self.captured = False
        rebuilt = False
        try:
            with snapshot_read_scope(independent=True) as pins:
                pins.clear()
                # Reuse the existing account/source/key validation and verified
                # generation reader. This does not request or publish a refresh.
                self._read_snapshot()
                current = _source_manifest(self.source_dir, checkpoint=self._checkpoint)
            self._checkpoint()
            if _message_manifest(current) != self.message_manifest:
                rebuilt = True
                self.capture(timeout_s=self.deadline - time.monotonic())
            else:
                self.captured = True
        finally:
            self.deadline = None
            logger.info("Image confirmation revalidate: elapsed_ms=%.1f; rebuilt=%s; ready=%s; completed_at=%.6f",
                        (time.monotonic() - started) * 1000, rebuilt, self.captured, time.time())

    def _candidate_paths(self, directory, row):
        from .routers.chat_media import _fast_probe_image_path_in_chat_attach

        raw = chat._decode_message_content(row["compress_content"], row["message_content"])
        md5s = {chat._extract_md5_from_packed_info(row.get("packed_info_data"))}
        for tag in ("md5", "cdnbigimgmd5", "hdmd5", "hevc_md5", "imgmd5", "filemd5"):
            value = chat._extract_xml_attr(raw, tag) or chat._extract_xml_tag_text(raw, tag)
            if value and re.fullmatch(r"[0-9a-fA-F]{32}", value):
                md5s.add(value.lower())
        resource = directory / "message_resource.db"
        if resource.exists():
            with closing(_readonly(resource)) as connection:
                chat_id = chat._resource_lookup_chat_id(connection, self.username, strict=True)
                if chat_id is not None:
                    md5s.add(chat._lookup_resource_md5(connection, chat_id, 3, int(row["server_id"]),
                        int(row["local_id"]), int(row["create_time"]), strict=True))
        paths = set()
        for md5 in sorted(md5s - {""}):
            self._checkpoint()
            # A new attachment may appear after the snapshot. Do not cache an
            # earlier missing-file result for this bounded confirmation attempt.
            found = _fast_probe_image_path_in_chat_attach.__wrapped__(
                wxid_dir_str=str(self.source_dir.parent), username=self.username, md5=md5)
            if found:
                # This resolver also discovers thumbnails and loose filename
                # prefixes. Only exact high/big rendition names bind full-image
                # evidence; an arbitrary cached thumbnail cannot prove it.
                for suffix in ("_h.dat", "_b.dat", ".h.dat", ".b.dat"):
                    path = Path(found).parent / (md5 + suffix)
                    if path.is_file():
                        paths.add(path)
        self._checkpoint()
        return sorted(paths)

    def _match(self, directory, row):
        match = ""
        for path in self._candidate_paths(directory, row):
            self._checkpoint()
            data, _media_type = media._read_and_maybe_decrypt_media(
                path, account_dir=self.account_dir, media_kind="image", checkpoint=self._checkpoint)
            if data == self.image_bytes:
                match = "exact_bytes"
            elif _pixels(data) == self.image_pixels and not match:
                match = "exact_rgba"
        self._checkpoint()
        return match

    def confirm(self, timeout_s: float = 15) -> ImageRecordConfirmation:
        if not self.captured:
            raise ImageConfirmationError("state", "图片提交前未取得确认基线")
        if isinstance(timeout_s, bool) or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("Image confirmation timeout must be positive and finite")
        started = time.monotonic()
        self.deadline = started + timeout_s
        # One refresh request only. A continuous worker retains its scheduling;
        # neither a previous idle flag nor an unchanged check is confirmation.
        confirmed = False
        try:
            with snapshot_read_scope(independent=True) as pins:
                pins.clear()
                _check_refresh_status(SNAPSHOT_REFRESH.once(self.account))
            while True:
                self._checkpoint()
                with snapshot_read_scope(independent=True) as pins:
                    pins.clear()
                    _check_refresh_status(SNAPSHOT_REFRESH.status(self.account))
                    directory, rows = self._read_snapshot()
                    matches = []
                    if directory.parents[1].name != self.generation:
                        for row in rows:
                            if (row["identity"] in self.before or not row["outgoing"]
                                    or int(row["server_id"] or 0) == 0):
                                continue
                            match = self._match(directory, row)
                            if match:
                                matches.append(ImageRecordConfirmation(directory.parents[1].name,
                                    row["db"], row["table"], int(row["local_id"]), str(row["server_id"]), match))
                    if len(matches) > 1:
                        raise ImageConfirmationError("ambiguous", "发现多条内容完全相同的新出站图片，无法唯一确认本次发送")
                    if matches:
                        confirmed = True
                        return matches[0]
                self._checkpoint()
                time.sleep(min(.1, max(0, self.deadline - time.monotonic())))
        finally:
            self.deadline = None
            logger.info("Image confirmation confirm: elapsed_ms=%.1f; confirmed=%s; completed_at=%.6f",
                        (time.monotonic() - started) * 1000, confirmed, time.time())
