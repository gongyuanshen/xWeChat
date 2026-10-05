from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

from .chat_helpers import (
    _decode_message_content,
    _decode_sqlite_text,
    _extract_md5_from_packed_info,
    _extract_sender_from_group_xml,
    _extract_voice_transcript_from_packed_info,
    _extract_xml_attr,
    _extract_xml_tag_or_attr,
    _extract_xml_tag_text,
    _infer_message_brief_by_local_type,
    _iter_message_db_paths,
    _parse_app_message,
    _parse_system_message_content,
    _quote_ident,
    _resolve_msg_table_name,
    _split_group_sender_prefix,
)
from .account_identity import (
    account_identity_candidates,
    resolve_account_self_rowid,
    resolve_account_self_username,
)
from .logging_config import get_logger

logger = get_logger(__name__)

_ANTI_REVOKE_DB_NAME = "anti_revoke.db"
_DB_INIT_LOCK = threading.Lock()
_INITED_PATHS: set[str] = set()
_SELF_ROWID_CACHE: dict[str, Optional[int]] = {}


def resolve_self_rowid_cached(account_dir: Path) -> Optional[int]:
    norm_dir = str(Path(account_dir).resolve())
    if norm_dir in _SELF_ROWID_CACHE:
        return _SELF_ROWID_CACHE[norm_dir]

    db_paths = _iter_message_db_paths(account_dir)
    for p in db_paths:
        try:
            conn = sqlite3.connect(str(p))
            rowid, _ = resolve_account_self_rowid(conn, account_dir)
            conn.close()
            if rowid is not None:
                _SELF_ROWID_CACHE[norm_dir] = rowid
                return rowid
        except Exception:
            continue
    _SELF_ROWID_CACHE[norm_dir] = None
    return None


def get_anti_revoke_db_path(account_dir: Path) -> Path:
    return Path(account_dir) / _ANTI_REVOKE_DB_NAME


def init_anti_revoke_db(db_path: Path) -> None:
    if db_path.is_dir() or db_path.name != _ANTI_REVOKE_DB_NAME:
        db_path = get_anti_revoke_db_path(db_path)
    norm_path = str(db_path.resolve())
    with _DB_INIT_LOCK:
        if norm_path in _INITED_PATHS and db_path.exists():
            return
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS revoked_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account TEXT NOT NULL DEFAULT '',
                    username TEXT NOT NULL,
                    server_id TEXT NOT NULL DEFAULT '0',
                    local_id INTEGER NOT NULL DEFAULT 0,
                    create_time INTEGER NOT NULL DEFAULT 0,
                    revoke_time INTEGER NOT NULL DEFAULT 0,
                    is_revoked INTEGER NOT NULL DEFAULT 0,
                    sort_seq INTEGER NOT NULL DEFAULT 0,
                    sender_username TEXT NOT NULL DEFAULT '',
                    is_sent INTEGER NOT NULL DEFAULT 0,
                    local_type INTEGER NOT NULL DEFAULT 0,
                    content TEXT NOT NULL DEFAULT '',
                    compress_content BLOB,
                    packed_info_data BLOB,
                    extra_json TEXT NOT NULL DEFAULT '{}'
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_revoked_account_user_server ON revoked_messages(account, username, server_id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_revoked_account_user_local ON revoked_messages(account, username, local_id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_revoked_is_revoked ON revoked_messages(account, username, is_revoked)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_revoked_create_time ON revoked_messages(account, username, create_time)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_revoked_server_id ON revoked_messages(server_id)"
            )
            columns = {row[1] for row in conn.execute("PRAGMA table_info(revoked_messages)")}
            for name in ("source_db", "source_table"):
                if name not in columns:
                    conn.execute(f"ALTER TABLE revoked_messages ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
            if "revoke_xml" not in columns:
                conn.execute("ALTER TABLE revoked_messages ADD COLUMN revoke_xml TEXT NOT NULL DEFAULT ''")
                # Older builds guessed the latest sent message on every replay.
                # Their flags cannot establish a revocation. Keep all original
                # content and old timestamps; exact events re-confirm the flags
                # as the conversation is read, and persist the evidence below.
                reset_count = conn.execute(
                    "UPDATE revoked_messages SET is_revoked = 0 WHERE is_revoked = 1"
                ).rowcount
                if reset_count:
                    logger.warning(
                        "[anti_revoke] Reset %s unverified legacy flags in %s; archived content and timestamps retained; exact events required for confirmation",
                        reset_count, db_path,
                    )
            # Older post-parse writes could attach the replacement system row's
            # renderType to an archived original. Repair that impossible pairing
            # at storage initialization; rendering then uses the original type.
            repaired_count = conn.execute(
                """
                UPDATE revoked_messages
                SET extra_json = json_remove(extra_json, '$.renderType')
                WHERE local_type != 10000 AND json_extract(extra_json, '$.renderType') = 'system'
                """
            ).rowcount
            if repaired_count:
                logger.warning(
                    "[anti_revoke] Removed replacement-system metadata from %s archived originals in %s",
                    repaired_count, db_path,
                )
            # Older archives preferred XML's transfer hash over the local resource
            # identifier. Rebuild this derived field from the preserved source bytes.
            image_repairs = 0
            for row_id, packed_info in conn.execute(
                "SELECT id, packed_info_data FROM revoked_messages WHERE local_type = 3 AND packed_info_data IS NOT NULL"
            ).fetchall():
                local_md5 = _extract_md5_from_packed_info(packed_info)
                if local_md5:
                    image_repairs += conn.execute(
                        "UPDATE revoked_messages SET extra_json = json_set(extra_json, '$.imageMd5', ?) "
                        "WHERE id = ? AND json_extract(extra_json, '$.imageMd5') IS NOT ?",
                        (local_md5, row_id, local_md5),
                    ).rowcount
            if image_repairs:
                logger.info("[anti_revoke] Repaired %s archived image resource identifiers in %s", image_repairs, db_path)
            # Purge any corrupt system rows or previous placeholder bubbles created by older versions
            conn.execute(
                """
                DELETE FROM revoked_messages
                WHERE local_type = 10000
                   OR content IN ('你撤回了一条消息', '对方撤回了一条消息')
                   OR content LIKE '<sysmsg type="revokemsg"%'
                """
            )
            conn.commit()
            _INITED_PATHS.add(norm_path)
        finally:
            conn.close()


def get_anti_revoke_connection(account_dir: Path) -> sqlite3.Connection:
    db_path = get_anti_revoke_db_path(account_dir)
    init_anti_revoke_db(db_path)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def parse_revoke_xml(xml_text: str) -> Optional[dict[str, Any]]:
    if not xml_text or "revokemsg" not in xml_text.lower():
        return None

    raw = xml_text.strip()
    session = _extract_xml_tag_text(raw, "session")
    newmsgid = _extract_xml_tag_text(raw, "newmsgid")
    msgid = _extract_xml_tag_text(raw, "msgid")

    if not newmsgid:
        m_new = re.search(r"<newmsgid[^>]*>([0-9]+)</newmsgid>", raw, re.IGNORECASE)
        if m_new:
            newmsgid = m_new.group(1).strip()

    if not msgid:
        m_msg = re.search(r"<msgid[^>]*>([0-9]+)</msgid>", raw, re.IGNORECASE)
        if m_msg:
            msgid = m_msg.group(1).strip()

    if not session:
        m_sess = re.search(r"<session[^>]*>([^<]+)</session>", raw, re.IGNORECASE)
        if m_sess:
            session = m_sess.group(1).strip()

    content_val = _extract_xml_tag_text(raw, "content")
    if not content_val:
        m_content = re.search(r"<content[^>]*>([^<]+)</content>", raw, re.IGNORECASE)
        if m_content:
            content_val = m_content.group(1).strip()

    replacemsg = _extract_xml_tag_text(raw, "replacemsg")
    if not replacemsg:
        replacemsg = _extract_xml_tag_text(raw, "revokemsg")
    if not replacemsg and content_val:
        replacemsg = content_val

    clean_replace = _parse_system_message_content(raw)
    if not clean_replace and content_val:
        clean_replace = content_val

    revoketime = 0
    rt_str = _extract_xml_tag_text(raw, "revoketime")
    if not rt_str:
        m_rt = re.search(r"<revoketime[^>]*>([0-9]+)</revoketime>", raw, re.IGNORECASE)
        if m_rt:
            rt_str = m_rt.group(1).strip()
    if rt_str:
        try:
            revoketime = int(rt_str)
        except Exception:
            revoketime = 0

    return {
        "session": str(session or "").strip(),
        "newmsgid": str(newmsgid or "").strip(),
        "msgid": str(msgid or "").strip(),
        "replacemsg": clean_replace or str(replacemsg or "").strip() or "撤回了一条消息",
        "revoketime": revoketime,
    }


def _extract_extra_metadata_from_row(
    local_type: int,
    raw_text: str,
    packed_info_data: Any,
) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    if not raw_text and not packed_info_data:
        return extra

    if local_type == 3:
        # Match normal chat parsing: packed metadata identifies the cached local
        # image; the XML hash can identify a different transfer representation.
        md5 = _extract_md5_from_packed_info(packed_info_data)
        if not md5:
            md5 = _extract_xml_attr(raw_text, "md5") or _extract_xml_tag_text(raw_text, "md5")
        if not md5:
            for k in ["cdnthumbmd5", "cdnmidimgmd5", "cdnbigimgmd5", "hdmd5", "imgmd5", "filemd5"]:
                md5 = _extract_xml_attr(raw_text, k) or _extract_xml_tag_text(raw_text, k)
                if md5:
                    break
        if md5:
            extra["imageMd5"] = md5

    elif local_type == 34:
        vt = _extract_voice_transcript_from_packed_info(packed_info_data)
        if vt:
            extra["voiceTranscript"] = vt
            extra["voiceTranscriptStatus"] = "success"

    elif local_type == 43:
        vmd5 = _extract_xml_attr(raw_text, "md5") or _extract_xml_tag_text(raw_text, "md5")
        vt_md5 = _extract_xml_attr(raw_text, "cdnthumbmd5") or _extract_xml_tag_text(raw_text, "cdnthumbmd5")
        if not vt_md5 and packed_info_data:
            vt_md5 = _extract_md5_from_packed_info(packed_info_data)
        if vmd5:
            extra["videoMd5"] = vmd5
        if vt_md5:
            extra["videoThumbMd5"] = vt_md5

    elif local_type == 47:
        emd5 = _extract_xml_attr(raw_text, "md5") or _extract_xml_tag_text(raw_text, "md5")
        if emd5:
            extra["emojiMd5"] = emd5

    elif local_type == 49:
        parsed = _parse_app_message(raw_text)
        for key in [
            "renderType",
            "content",
            "title",
            "url",
            "from",
            "fromUsername",
            "linkType",
            "linkStyle",
            "fileSize",
            "fileMd5",
            "quoteTitle",
            "quoteContent",
            "quoteUsername",
            "quoteServerId",
            "quoteType",
            "amount",
            "transferStatus",
            "paySubType",
            "recordItem",
            "thumbUrl",
        ]:
            val = parsed.get(key)
            if val:
                extra[key] = val

    return extra


def save_messages_to_archive(
    account_dir: Path,
    account_name: str,
    username: str,
    rows: list[dict[str, Any] | Any],
    my_rowid: Optional[int] = None,
    self_username: Optional[str] = None,
) -> int:
    if not rows:
        return 0

    account_name = str(account_name or account_dir.name).strip()
    username = str(username or "").strip()
    self_u = str(self_username or resolve_account_self_username(account_dir) or account_name or account_dir.name).strip()
    candidates = list(account_identity_candidates(account_dir))
    for c in (account_name, str(account_dir.name).strip(), self_u):
        if c and c not in candidates:
            candidates.append(c)
    self_candidates_set = set(candidates)

    effective_my_rowid = my_rowid
    if effective_my_rowid is None and any(
        (r.get("real_sender_id") or r.get("realSenderId")) if isinstance(r, dict)
        else getattr(r, "real_sender_id", None) for r in rows
    ):
        effective_my_rowid = resolve_self_rowid_cached(account_dir)

    conn = get_anti_revoke_connection(account_dir)
    saved_count = 0
    revoke_events: list[dict[str, Any]] = []
    try:
        conn.execute("BEGIN IMMEDIATE")
        for r in rows:
            if isinstance(r, dict):
                local_id = int(r.get("local_id") or r.get("localId") or 0)
                server_id = str(r.get("server_id") or r.get("serverIdStr") or r.get("serverId") or "0").strip()
                local_type = int(r.get("local_type") or r.get("type") or 0)
                sort_seq = int(r.get("sort_seq") or r.get("sortSeq") or 0)
                create_time = int(r.get("create_time") or r.get("createTime") or 0)
                sender_username = str(r.get("sender_username") or r.get("senderUsername") or "").strip()
                is_sent = 1 if (r.get("is_sent") or r.get("isSent") or r.get("computed_is_send") or r.get("is_send")) else 0
                compress_content = r.get("compress_content") or r.get("compressContent")
                message_content = r.get("message_content") or r.get("messageContent")
                packed_info_data = r.get("packed_info_data") or r.get("packedInfoData")
                row_user = str(r.get("username") or username).strip()
                real_sender_id = r.get("real_sender_id") or r.get("realSenderId")
                source_db = str(r.get("source_db") or r.get("db") or "")
                source_table = str(r.get("source_table") or r.get("table") or "")
            else:
                local_id = int(getattr(r, "local_id", 0) or 0)
                server_id = str(getattr(r, "server_id", "0") or "0").strip()
                local_type = int(getattr(r, "local_type", 0) or 0)
                sort_seq = int(getattr(r, "sort_seq", 0) or 0)
                create_time = int(getattr(r, "create_time", 0) or 0)
                sender_username = str(getattr(r, "sender_username", "") or "").strip()
                is_sent = 1 if (getattr(r, "is_sent", False) or getattr(r, "isSent", False) or getattr(r, "computed_is_send", False)) else 0
                compress_content = getattr(r, "compress_content", None) or getattr(r, "compressContent", None)
                message_content = getattr(r, "message_content", None) or getattr(r, "messageContent", None)
                packed_info_data = getattr(r, "packed_info_data", None) or getattr(r, "packedInfoData", None)
                row_user = username
                real_sender_id = getattr(r, "real_sender_id", None)
                source_db = str(getattr(r, "db_stem", ""))
                source_table = str(getattr(r, "table_name", ""))

            if bool(source_db) != bool(source_table):
                raise ValueError("Archive source identity requires both database and table")
            raw_text = _decode_message_content(compress_content, message_content).strip()
            if not raw_text and isinstance(r, dict):
                raw_text = str(r.get("content") or "").strip()

            # Check if this row is a revocation event
            if local_type == 10000:
                if "revokemsg" in raw_text.lower():
                    revoke_events.append(dict(
                        username=row_user, xml_text=raw_text,
                        revoke_time=create_time or int(time.time()),
                        server_id=server_id, local_id=local_id,
                        source_db=source_db, source_table=source_table,
                    ))
                continue

            # Determine is_sent accurately
            if not is_sent and effective_my_rowid is not None and real_sender_id is not None:
                try:
                    if int(real_sender_id) == int(effective_my_rowid):
                        is_sent = 1
                except Exception:
                    pass

            if not is_sent and sender_username:
                if sender_username in self_candidates_set:
                    is_sent = 1

            if is_sent:
                if not sender_username:
                    sender_username = self_u
            else:
                is_group = bool(row_user.endswith("@chatroom"))
                if is_group and (not sender_username) and raw_text and not raw_text.startswith("<"):
                    prefix, body = _split_group_sender_prefix(raw_text, sender_username)
                    if prefix:
                        if prefix in self_candidates_set:
                            is_sent = 1
                            sender_username = self_u
                        else:
                            sender_username = prefix
                        raw_text = body

            extra = _extract_extra_metadata_from_row(local_type, raw_text, packed_info_data)
            if isinstance(r, dict):
                for k in (
                    "imageMd5",
                    "emojiMd5",
                    "videoMd5",
                    "videoThumbMd5",
                    "title",
                    "url",
                    "fileSize",
                    "fileMd5",
                    "quoteTitle",
                    "quoteContent",
                    "renderType",
                ):
                    val = r.get(k)
                    if val and (k not in extra or k == "imageMd5"):
                        extra[k] = val
            extra_json_str = json.dumps(extra, ensure_ascii=False) if extra else "{}"

            # Check if already in revoked_messages
            existing = None
            if server_id and server_id != "0":
                existing = conn.execute(
                    "SELECT id, is_revoked, revoke_time FROM revoked_messages WHERE account = ? AND username = ? AND server_id = ? LIMIT 1",
                    (account_name, row_user, server_id),
                ).fetchone()
            if existing is None and local_id > 0:
                existing = conn.execute(
                    "SELECT id, is_revoked, revoke_time FROM revoked_messages WHERE account = ? AND username = ? AND local_id = ? AND server_id = '0' AND source_db = ? AND source_table = ? LIMIT 1",
                    (account_name, row_user, local_id, source_db, source_table),
                ).fetchone()

            if existing is not None:
                row_id = existing["id"]
                if source_db and source_table:
                    conn.execute(
                        "UPDATE revoked_messages SET source_db = ?, source_table = ? "
                        "WHERE id = ? AND source_db = '' AND source_table = ''",
                        (source_db, source_table, row_id),
                    )
                conn.execute(
                    """
                    UPDATE revoked_messages
                    SET local_id = CASE WHEN local_id = 0 THEN ? ELSE local_id END,
                        server_id = CASE WHEN server_id = '0' THEN ? ELSE server_id END,
                        sort_seq = CASE WHEN sort_seq = 0 THEN ? ELSE sort_seq END,
                        create_time = CASE WHEN create_time = 0 THEN ? ELSE create_time END,
                        sender_username = CASE WHEN (sender_username = '' AND ? != '') THEN ? ELSE sender_username END,
                        is_sent = CASE WHEN (is_sent = 0 AND ? = 1) THEN 1 ELSE is_sent END,
                        content = CASE WHEN content = '' THEN ? ELSE content END,
                        extra_json = CASE WHEN (extra_json = '{}' OR extra_json IS NULL) THEN ? ELSE extra_json END,
                        packed_info_data = CASE WHEN (packed_info_data IS NULL OR length(packed_info_data) = 0) THEN ? ELSE packed_info_data END
                    WHERE id = ?
                    """,
                    (
                        local_id,
                        server_id,
                        sort_seq,
                        create_time,
                        sender_username,
                        sender_username,
                        is_sent,
                        raw_text,
                        extra_json_str,
                        packed_info_data if isinstance(packed_info_data, bytes) else None,
                        row_id,
                    ),
                )
                # The second, normalized pass may resolve message_resource.db.
                # Preserve that identifier on later raw XML-only replays.
                if local_type == 3:
                    resolved_md5 = (r.get("imageMd5") if isinstance(r, dict) else "") or _extract_md5_from_packed_info(packed_info_data)
                    if resolved_md5:
                        conn.execute(
                            "UPDATE revoked_messages SET extra_json = json_set(extra_json, '$.imageMd5', ?) "
                            "WHERE id = ? AND json_extract(extra_json, '$.imageMd5') IS NOT ?",
                            (resolved_md5, row_id, resolved_md5),
                        )
            else:
                conn.execute(
                    """
                    INSERT INTO revoked_messages (
                        account, username, server_id, local_id, create_time,
                        revoke_time, is_revoked, sort_seq, sender_username,
                        is_sent, local_type, content, compress_content,
                        packed_info_data, extra_json, source_db, source_table
                    ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        account_name,
                        row_user,
                        server_id,
                        local_id,
                        create_time,
                        sort_seq,
                        sender_username,
                        is_sent,
                        local_type,
                        raw_text,
                        compress_content if isinstance(compress_content, bytes) else None,
                        packed_info_data if isinstance(packed_info_data, bytes) else None,
                        extra_json_str,
                        source_db,
                        source_table,
                    ),
                )
                saved_count += 1

        conn.commit()
    finally:
        conn.close()
    # Queries arrive newest first. Commit original content before processing events,
    # also avoiding a second writer while this connection owns a transaction.
    for event in revoke_events:
        process_revocation_event(account_dir, account_name, **event)
    return saved_count


def _search_decrypted_db_for_message(
    account_dir: Path,
    username: str,
    server_id: str,
    local_id: str,
) -> Optional[dict[str, Any]]:
    db_paths = _iter_message_db_paths(account_dir)
    s_id = int(server_id) if (server_id and server_id.isdigit()) else 0
    l_id = int(local_id) if (local_id and local_id.isdigit()) else 0
    if not s_id and not l_id:
        return None

    self_username = resolve_account_self_username(account_dir)
    is_group = bool(username and username.endswith("@chatroom"))
    local_candidates: list[dict[str, Any]] = []

    for db_path in db_paths:
        conn = None
        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            conn.text_factory = bytes

            my_rowid, matched_self_u = resolve_account_self_rowid(conn, account_dir)
            resolved_self_u = matched_self_u or self_username

            raw_tbl = _resolve_msg_table_name(conn, username) if username else None
            table_name = _decode_sqlite_text(raw_tbl) if raw_tbl else None
            candidate_tables = [table_name] if table_name else []

            for tbl in candidate_tables:
                quoted = _quote_ident(_decode_sqlite_text(tbl))
                where_clause = ""
                param: tuple[Any, ...] = ()
                if s_id > 0:
                    where_clause = "m.server_id = ? AND m.local_type != 10000"
                    param = (s_id,)
                elif l_id > 0:
                    where_clause = "m.local_id = ? AND (m.server_id = 0 OR m.server_id IS NULL) AND m.local_type != 10000"
                    param = (l_id,)

                row = None
                try:
                    sql_join = (
                        f"SELECT m.*, n.user_name AS sender_username "
                        f"FROM {quoted} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid "
                        f"WHERE {where_clause} LIMIT 1"
                    )
                    row = conn.execute(sql_join, param).fetchone()
                except Exception:
                    try:
                        row = conn.execute(f"SELECT * FROM {quoted} WHERE {where_clause.replace('m.', '')} LIMIT 1", param).fetchone()
                    except Exception:
                        row = None

                if row is not None:
                    raw_text = _decode_message_content(
                        _row_safe_get(row, "compress_content"),
                        _row_safe_get(row, "message_content"),
                    ).strip()
                    packed_info = _row_safe_get(row, "packed_info_data")
                    real_sender_id = _row_safe_get(row, "real_sender_id")

                    is_sent = 0
                    if my_rowid is not None and real_sender_id is not None:
                        try:
                            is_sent = 1 if int(real_sender_id) == int(my_rowid) else 0
                        except Exception:
                            is_sent = 0

                    sender_u = _decode_sqlite_text(_row_safe_get(row, "sender_username") or "").strip()
                    if is_sent:
                        sender_u = resolved_self_u
                    elif (not is_group) and (not sender_u) and username:
                        sender_u = username

                    original = {
                        "local_id": int(_row_safe_get(row, "local_id") or 0),
                        "server_id": str(int(_row_safe_get(row, "server_id") or 0)),
                        "local_type": int(_row_safe_get(row, "local_type") or 0),
                        "sort_seq": int(_row_safe_get(row, "sort_seq") or 0),
                        "create_time": int(_row_safe_get(row, "create_time") or 0),
                        "sender_username": sender_u,
                        "is_sent": is_sent,
                        "raw_text": raw_text,
                        "compress_content": _row_safe_get(row, "compress_content"),
                        "packed_info_data": packed_info,
                    }
                    if s_id:
                        return original
                    local_candidates.append(original)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    if len(local_candidates) == 1:
        return local_candidates[0]
    if len(local_candidates) > 1:
        logger.error(
            "[anti_revoke] Ambiguous local target across message shards account=%s session=%s local_id=%s candidates=%s",
            account_dir.name, username, l_id, len(local_candidates),
        )
    return None


def _row_safe_get(row: sqlite3.Row, key: str) -> Any:
    try:
        return row[key]
    except Exception:
        return None


def process_revocation_event(
    account_dir: Path,
    account_name: str,
    username: str,
    xml_text: str,
    revoke_time: Optional[int] = None,
    server_id: Optional[str] = None,
    local_id: Optional[int] = None,
    *,
    source_db: str = "",
    source_table: str = "",
    recover_missing: bool = True,
) -> Optional[dict[str, Any]]:
    parsed = parse_revoke_xml(xml_text)
    if not parsed:
        return None

    target_session = str(parsed.get("session") or username).strip()
    newmsgid = str(parsed.get("newmsgid") or "").strip()
    msgid = str(parsed.get("msgid") or "").strip()
    replacemsg = str(parsed.get("replacemsg") or "").strip()
    rev_time = int(parsed.get("revoketime") or revoke_time or int(time.time()))
    is_self = replacemsg.startswith("你撤回")
    account_name = str(account_name or account_dir.name).strip()

    # Explicit XML targets describe a separate notification. Without them WeChat
    # replaces the original row in place, retaining its server/local identity.
    # Never select a nearby message, or switch to a different ID after a miss.
    if newmsgid and newmsgid != "0":
        target_server, target_local = newmsgid, ""
    elif msgid and msgid != "0":
        target_server, target_local = "", msgid
    else:
        target_server = str(server_id or "0").strip()
        target_local = str(local_id or 0)
    if not target_session or (
        target_server in ("", "0") and target_local in ("", "0")
    ):
        logger.warning(
            "[anti_revoke] Unresolved event: missing target identity account=%s session=%s revoke_time=%s",
            account_name, target_session, rev_time,
        )
        return None

    if target_server not in ("", "0"):
        identity_sql, identity_value = "server_id = ?", target_server
    else:
        identity_sql, identity_value = "local_id = ? AND server_id IN ('', '0')", int(target_local)

    self_u = resolve_account_self_username(account_dir)
    query = f"SELECT * FROM revoked_messages WHERE account = ? AND username = ? AND {identity_sql} AND local_type != 10000"
    parameters = (account_name, target_session, identity_value)
    if newmsgid in ("", "0") and msgid in ("", "0") and target_server in ("", "0") and (source_db or source_table):
        query += " AND source_db = ? AND source_table = ?"
        parameters += (source_db, source_table)
    conn = get_anti_revoke_connection(account_dir)
    try:
        conn.execute("BEGIN IMMEDIATE")
        matched_rows = conn.execute(query, parameters).fetchall()
        if not matched_rows:
            if not recover_missing:
                return None
            # Recovery writes through the regular archive path. Release this
            # transaction, then resolve again under the write lock before updating.
            conn.rollback()
            original = _search_decrypted_db_for_message(
                account_dir, target_session, target_server, target_local,
            )
            if original is None:
                logger.warning(
                    "[anti_revoke] Original message not captured account=%s session=%s server_id=%s local_id=%s revoke_time=%s",
                    account_name, target_session, target_server, target_local, rev_time,
                )
                return None
            save_messages_to_archive(
                account_dir, account_name, target_session,
                [{**original, "message_content": original["raw_text"]}],
            )
            conn.execute("BEGIN IMMEDIATE")
            matched_rows = conn.execute(query, parameters).fetchall()
        if len(matched_rows) != 1:
            logger.error(
                "[anti_revoke] Ambiguous target account=%s session=%s server_id=%s local_id=%s candidates=%s",
                account_name, target_session, target_server, target_local, len(matched_rows),
            )
            return None
        row_id = matched_rows[0]["id"]
        conn.execute(
            """
            UPDATE revoked_messages
            SET is_revoked = 1, revoke_time = ?, revoke_xml = ?,
                is_sent = CASE WHEN ? = 1 THEN 1 ELSE is_sent END,
                sender_username = CASE WHEN sender_username = '' AND ? = 1 THEN ? ELSE sender_username END
            WHERE id = ?
            """,
            (rev_time, xml_text, int(is_self), int(is_self), self_u, row_id),
        )
        updated = conn.execute(
            "SELECT * FROM revoked_messages WHERE id = ?", (row_id,),
        ).fetchone()
        conn.commit()
        return dict(updated)
    finally:
        conn.close()


def get_revoked_messages_map(
    account_dir: Path,
    username: Optional[str] = None,
) -> dict[str, dict[str, Any]]:
    db_path = get_anti_revoke_db_path(account_dir)
    if not db_path.exists():
        return {}

    conn = get_anti_revoke_connection(account_dir)
    res_map: dict[str, dict[str, Any]] = {}
    try:
        if username:
            rows = conn.execute(
                "SELECT * FROM revoked_messages WHERE is_revoked = 1 AND local_type != 10000 AND (username = ? OR username = '')",
                (username,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM revoked_messages WHERE is_revoked = 1 AND local_type != 10000"
            ).fetchall()

        for r in rows:
            d = dict(r)
            cnt = str(d.get("content") or "").strip()
            if cnt in ("你撤回了一条消息", "对方撤回了一条消息") or cnt.startswith("<sysmsg"):
                continue
            s_id = str(d.get("server_id") or "").strip()
            l_id = int(d.get("local_id") or 0)
            u = str(d.get("username") or "").strip()
            if s_id and s_id != "0":
                res_map[f"server:{s_id}"] = d
            if l_id > 0:
                source_db, source_table = str(d.get("source_db") or ""), str(d.get("source_table") or "")
                identity = f"{source_db}:{source_table}:{l_id}" if source_db and source_table else str(l_id)
                if username:
                    res_map[f"local:{identity}"] = d
                if u:
                    res_map[f"local:{u}:{identity}"] = d
    finally:
        conn.close()
    return res_map


def get_revoked_messages_list(
    account_dir: Path,
    username: str,
) -> list[dict[str, Any]]:
    db_path = get_anti_revoke_db_path(account_dir)
    if not db_path.exists():
        return []

    conn = get_anti_revoke_connection(account_dir)
    try:
        rows = conn.execute(
            """
            SELECT * FROM revoked_messages
            WHERE is_revoked = 1 AND local_type != 10000 AND (username = ? OR username = '')
            ORDER BY create_time DESC, sort_seq DESC, local_id DESC
            """,
            (username,),
        ).fetchall()
        valid = []
        for r in rows:
            d = dict(r)
            cnt = str(d.get("content") or "").strip()
            if cnt in ("你撤回了一条消息", "对方撤回了一条消息") or cnt.startswith("<sysmsg"):
                continue
            valid.append(d)
        return valid
    finally:
        conn.close()


def get_all_revoked_messages(
    account_dir: Path,
) -> list[dict[str, Any]]:
    db_path = get_anti_revoke_db_path(account_dir)
    if not db_path.exists():
        return []

    conn = get_anti_revoke_connection(account_dir)
    try:
        rows = conn.execute(
            """
            SELECT * FROM revoked_messages
            WHERE is_revoked = 1 AND local_type != 10000
            ORDER BY create_time DESC, sort_seq DESC, local_id DESC
            """
        ).fetchall()
        valid = []
        for r in rows:
            d = dict(r)
            cnt = str(d.get("content") or "").strip()
            if cnt in ("你撤回了一条消息", "对方撤回了一条消息") or cnt.startswith("<sysmsg"):
                continue
            valid.append(d)
        return valid
    finally:
        conn.close()


def format_revoked_message_as_chat_item(
    rev_row: dict[str, Any],
    account_dir: Path,
) -> Optional[dict[str, Any]]:
    local_type = int(rev_row.get("local_type") or 1)
    if local_type == 10000:
        return None

    raw_content = str(rev_row.get("content") or "").strip()
    if raw_content in ("你撤回了一条消息", "对方撤回了一条消息") or raw_content.startswith("<sysmsg"):
        return None

    username = str(rev_row.get("username") or "").strip()
    server_id_str = str(rev_row.get("server_id") or "").strip()
    server_id = int(server_id_str) if server_id_str.isdigit() else 0
    local_id = int(rev_row.get("local_id") or 0)
    create_time = int(rev_row.get("create_time") or 0)
    revoke_time = int(rev_row.get("revoke_time") or create_time)
    sort_seq = int(rev_row.get("sort_seq") or 0)

    self_u = str(resolve_account_self_username(account_dir) or account_dir.name).strip()
    candidates = list(account_identity_candidates(account_dir))
    for c in (account_dir.name, self_u):
        if c and c not in candidates:
            candidates.append(c)
    self_candidates_set = set(candidates)

    sender_username = str(rev_row.get("sender_username") or "").strip()
    is_sent = bool(rev_row.get("is_sent")) or (sender_username in self_candidates_set)

    is_group = bool(username.endswith("@chatroom"))
    if is_sent:
        if not sender_username:
            sender_username = self_u
    elif is_group and raw_content:
        sender_prefix, body = _split_group_sender_prefix(raw_content, sender_username)
        if sender_prefix:
            if sender_prefix in self_candidates_set:
                is_sent = True
                sender_username = sender_prefix
            elif not sender_username:
                sender_username = sender_prefix
            raw_content = body

    extra: dict[str, Any] = {}
    extra_json = rev_row.get("extra_json")
    if extra_json and isinstance(extra_json, str):
        try:
            extra = json.loads(extra_json)
        except Exception:
            extra = {}

    render_type = str(extra.get("renderType") or "text")
    if render_type == "text":
        if local_type == 3:
            render_type = "image"
        elif local_type == 34:
            render_type = "voice"
        elif local_type == 43:
            render_type = "video"
        elif local_type == 47:
            render_type = "emoji"
        elif local_type == 49:
            render_type = "link"
        elif local_type == 10000:
            return None

    content_text = str(extra.get("content") or "").strip()
    if not content_text:
        content_text = raw_content
    if (content_text.startswith("<") or content_text.startswith('"<')) and "<appmsg" in content_text.lower():
        parsed_app = _parse_app_message(content_text)
        if parsed_app:
            rt = str(parsed_app.get("renderType") or "")
            if rt and rt != "text":
                render_type = rt
            app_content = str(parsed_app.get("content") or "")
            if app_content:
                content_text = app_content
            for k, v in parsed_app.items():
                if v and k not in extra:
                    extra[k] = v

    if not content_text:
        content_text = _infer_message_brief_by_local_type(local_type)

    source_db, source_table = str(rev_row.get("source_db") or ""), str(rev_row.get("source_table") or "")
    source_id = f"{source_db}:{source_table}:{local_id}" if source_db and source_table else str(local_id)
    return {
        "id": f"anti_revoke:{username}:{server_id_str if server_id else source_id}",
        "db": source_db,
        "table": source_table,
        "localId": local_id,
        "serverId": server_id,
        "serverIdStr": server_id_str if server_id else "",
        "type": local_type,
        "createTime": create_time,
        "sortSeq": sort_seq,
        "senderUsername": sender_username,
        "senderDisplayName": "" if is_sent else "",
        "conversationUsername": username,
        "username": username,
        "isSent": is_sent,
        "renderType": render_type,
        "content": content_text,
        "title": str(extra.get("title") or ""),
        "url": str(extra.get("url") or ""),
        "linkType": str(extra.get("linkType") or ""),
        "linkStyle": str(extra.get("linkStyle") or ""),
        "imageMd5": str(extra.get("imageMd5") or ""),
        "emojiMd5": str(extra.get("emojiMd5") or ""),
        "videoMd5": str(extra.get("videoMd5") or ""),
        "videoThumbMd5": str(extra.get("videoThumbMd5") or ""),
        "voiceLength": str(extra.get("voiceLength") or ""),
        "voiceTranscript": str(extra.get("voiceTranscript") or ""),
        "voiceTranscriptStatus": str(extra.get("voiceTranscriptStatus") or ""),
        "quoteTitle": str(extra.get("quoteTitle") or ""),
        "quoteContent": str(extra.get("quoteContent") or ""),
        "quoteUsername": str(extra.get("quoteUsername") or ""),
        "quoteServerId": str(extra.get("quoteServerId") or ""),
        "amount": str(extra.get("amount") or ""),
        "transferStatus": str(extra.get("transferStatus") or ""),
        "fileSize": str(extra.get("fileSize") or ""),
        "fileMd5": str(extra.get("fileMd5") or ""),
        "isRevoked": True,
        "revokeTime": revoke_time,
    }
