from __future__ import annotations

import math
import random
import re
import sqlite3
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from ...chat_helpers import _decode_message_content, _decode_sqlite_text, _iter_message_db_paths, _quote_ident
from ...logging_config import get_logger
from .. import require_wrapped_self_rowid

logger = get_logger(__name__)


_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

# Align with WeFlow Annual Report "年度常用语" logic.
# Count repeated phrases (full short sent messages).
_WEFLOW_COMMON_PHRASE_LOCAL_TYPES = (1,)


def _year_range_epoch_seconds(year: int) -> tuple[int, int]:
    start = int(datetime(int(year), 1, 1).timestamp())
    end = int(datetime(int(year) + 1, 1, 1).timestamp())
    return start, end


def _list_message_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    names: list[str] = []
    for r in rows:
        if not r or not r[0]:
            continue
        name = _decode_sqlite_text(r[0]).strip()
        if not name:
            continue
        ln = name.lower()
        if ln.startswith(("msg_", "chat_")):
            names.append(name)
    return names


def _weflow_common_phrase_or_empty(text: Any) -> str:
    """
    Match WeFlow "年度常用语" filter:
    - Only short messages: 2 <= len <= 20
    - Exclude links/markup: contains "http" or "<"
    - Exclude bracketed / xml-like payloads: startswith "[" or "<?xml"

    Note: We intentionally do NOT strip URLs or collapse whitespace to stay close to WeFlow.
    """
    s = str(text or "")
    if not s:
        return ""

    # Invisible chars are common noise across exports; removing them won't change visible text.
    s = s.replace("\u200b", "").replace("\ufeff", "")
    s = _CTRL_RE.sub("", s)
    s = s.strip()
    if not s:
        return ""

    if len(s) < 2 or len(s) > 20:
        return ""
    if "http" in s:
        return ""
    if "<" in s:
        return ""
    if s.startswith("[") or s.startswith("<?xml"):
        return ""
    return s


def build_common_phrases_payload(
    *,
    phrase_counts: Counter[str],
    top_n: int = 32,
    bubble_limit: int = 180,
    example_texts: list[str] | None = None,
    examples_per_word: int = 3,
) -> dict[str, Any]:
    items = [(p, int(c)) for p, c in (phrase_counts or {}).items() if int(c) >= 2]
    if not items:
        return {"topKeyword": None, "keywords": [], "bubbleMessages": [], "examples": []}

    items.sort(key=lambda kv: (-kv[1], kv[0]))
    items = items[: max(0, int(top_n or 0))]
    if not items:
        return {"topKeyword": None, "keywords": [], "bubbleMessages": [], "examples": []}

    vals = [math.sqrt(max(0, c)) for _, c in items]
    minv = min(vals) if vals else 0.0
    maxv = max(vals) if vals else 0.0

    keywords: list[dict[str, Any]] = []
    for (phrase, count), v in zip(items, vals):
        if maxv <= minv:
            weight = 1.0
        else:
            weight = 0.2 + 0.8 * ((v - minv) / (maxv - minv))
        keywords.append({"word": phrase, "count": int(count), "weight": round(float(weight), 4)})

    # Bubble pool: unique phrases (not all raw messages). Keep it diverse and lightweight.
    bubble_candidates = list(dict.fromkeys([str(p or "").strip() for p in phrase_counts.keys()]))
    bubble_candidates = [p for p in bubble_candidates if p]
    rnd = random.SystemRandom()
    rnd.shuffle(bubble_candidates)
    bubble_messages = bubble_candidates[: max(0, int(bubble_limit or 0))]

    # Phrase evidence is a complete matching sent message. An empty sample stays empty.
    examples = [
        {"word": kw["word"], "count": int(kw["count"]), "messages": [
            text for text in (example_texts or []) if text == kw["word"]
        ][:max(1, int(examples_per_word))]}
        for kw in keywords
    ]

    top_kw = {"word": str(keywords[0]["word"]), "count": int(keywords[0]["count"])} if keywords else None

    return {
        "topKeyword": top_kw,
        "keywords": keywords,
        "bubbleMessages": bubble_messages,
        "examples": examples,
    }


def _scan_common_phrase_counts(
    *,
    account_dir: Path,
    year: int,
    outgoing_only: bool,
    max_seen: int | None = None,
) -> tuple[Counter[str], dict[str, list[int]], dict[str, Any]]:
    start_ts, end_ts = _year_range_epoch_seconds(int(year))

    db_paths = _iter_message_db_paths(account_dir)
    # Prefer chat shards; biz_message often contains service/ads content.
    db_paths = [p for p in db_paths if not p.name.lower().startswith("biz_message")]

    phrase_counts: Counter[str] = Counter()
    monthly_counts: dict[str, list[int]] = {}
    scanned = 0
    matched = 0
    capped = False

    t0 = time.time()
    for db_path in db_paths:
        if not db_path.exists():
            continue

        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            conn.text_factory = bytes

            tables = _list_message_tables(conn)
            if not tables:
                continue
            tables.sort()

            my_rowid: int | None = None
            if outgoing_only:
                my_rowid = require_wrapped_self_rowid(conn, account_dir, database=db_path.name)

            ts_expr = (
                "CASE "
                "WHEN CAST(create_time AS INTEGER) > 1000000000000 "
                "THEN CAST(CAST(create_time AS INTEGER)/1000 AS INTEGER) "
                "ELSE CAST(create_time AS INTEGER) "
                "END"
            )

            local_types_csv = ",".join(str(int(x)) for x in _WEFLOW_COMMON_PHRASE_LOCAL_TYPES)

            for table in tables:
                if max_seen is not None and scanned >= int(max_seen):
                    capped = True
                    break

                qt = _quote_ident(table)
                where_sender = ""
                params: tuple[Any, ...]
                if outgoing_only and my_rowid is not None:
                    where_sender = " AND CAST(real_sender_id AS INTEGER) = ?"
                    params = (start_ts, end_ts, int(my_rowid))
                else:
                    params = (start_ts, end_ts)

                sql = (
                    f"SELECT message_content, compress_content, {ts_expr} AS timestamp "
                    f"FROM {qt} "
                    f"WHERE CAST(local_type AS INTEGER) IN ({local_types_csv}) "
                    f"  AND {ts_expr} >= ? AND {ts_expr} < ?"
                    f"{where_sender}"
                )

                cur = conn.execute(sql, params)

                for r in cur:
                    if max_seen is not None and scanned >= int(max_seen):
                        capped = True
                        break

                    scanned += 1
                    raw_txt = _decode_message_content(r["compress_content"], r["message_content"])

                    phrase = _weflow_common_phrase_or_empty(raw_txt)
                    if not phrase:
                        continue
                    phrase_counts[phrase] += 1
                    month_counts = monthly_counts.setdefault(phrase, [0] * 12)
                    month_counts[datetime.fromtimestamp(int(r["timestamp"])).month - 1] += 1
                    matched += 1
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

        if max_seen is not None and scanned >= int(max_seen):
            break

    elapsed = time.time() - t0
    meta = {
        "scannedCandidates": int(scanned),
        "matchedCandidates": int(matched),
        "uniquePhrases": int(len(phrase_counts)),
        "capped": bool(capped),
        "elapsedSec": round(float(elapsed), 3),
        "localTypes": list(_WEFLOW_COMMON_PHRASE_LOCAL_TYPES),
    }
    return phrase_counts, monthly_counts, meta


def _scan_message_pool(
    *,
    account_dir: Path,
    year: int,
    outgoing_only: bool,
    max_pool: int = 3000,
    max_seen: int = 120_000,
) -> tuple[list[str], dict[str, Any]]:
    start_ts, end_ts = _year_range_epoch_seconds(int(year))
    rnd = random.SystemRandom()

    db_paths = _iter_message_db_paths(account_dir)
    # Prefer chat shards; biz_message often contains service/ads content.
    db_paths = [p for p in db_paths if not p.name.lower().startswith("biz_message")]
    rnd.shuffle(db_paths)

    pool: list[str] = []
    seen = 0

    t0 = time.time()
    for db_path in db_paths:
        if not db_path.exists():
            continue

        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            conn.text_factory = bytes

            tables = _list_message_tables(conn)
            if not tables:
                continue
            rnd.shuffle(tables)

            my_rowid: int | None = None
            if outgoing_only:
                my_rowid = require_wrapped_self_rowid(conn, account_dir, database=db_path.name)

            ts_expr = (
                "CASE "
                "WHEN CAST(create_time AS INTEGER) > 1000000000000 "
                "THEN CAST(CAST(create_time AS INTEGER)/1000 AS INTEGER) "
                "ELSE CAST(create_time AS INTEGER) "
                "END"
            )

            for table in tables:
                if seen >= int(max_seen):
                    break
                qt = _quote_ident(table)
                where_sender = ""
                params: tuple[Any, ...]
                if outgoing_only and my_rowid is not None:
                    where_sender = " AND CAST(real_sender_id AS INTEGER) = ?"
                    params = (start_ts, end_ts, int(my_rowid))
                else:
                    params = (start_ts, end_ts)
                sql = (
                    "SELECT message_content, compress_content "
                    f"FROM {qt} "
                    "WHERE CAST(local_type AS INTEGER) = 1 "
                    f"  AND {ts_expr} >= ? AND {ts_expr} < ?"
                    f"{where_sender}"
                )

                cur = conn.execute(sql, params)

                for r in cur:
                    if seen >= int(max_seen):
                        break
                    raw_txt = _decode_message_content(r["compress_content"], r["message_content"])
                    cleaned = _weflow_common_phrase_or_empty(raw_txt)
                    if not cleaned:
                        continue
                    seen += 1

                    if len(pool) < int(max_pool):
                        pool.append(cleaned)
                        continue

                    # Reservoir sampling over the accepted stream.
                    j = rnd.randrange(seen)
                    if j < int(max_pool):
                        pool[j] = cleaned
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

        if seen >= int(max_seen):
            break

    elapsed = time.time() - t0
    meta = {
        "scannedMessages": int(seen),
        "sampledMessages": int(len(pool)),
        "sampleRate": round(float(len(pool)) / float(seen), 6) if seen > 0 else 0.0,
        "elapsedSec": round(float(elapsed), 3),
    }
    return pool, meta


def build_card_05_keywords_wordcloud(*, account_dir: Path, year: int) -> dict[str, Any]:
    title = "这一年，你把哪些话说了一遍又一遍？"

    phrase_counts, monthly_counts, scan_meta = _scan_common_phrase_counts(
        account_dir=account_dir,
        year=year,
        outgoing_only=True,
    )
    example_pool: list[str] = []
    pool_meta: dict[str, Any] = {}
    if phrase_counts:
        example_pool, pool_meta = _scan_message_pool(
            account_dir=account_dir,
            year=year,
            outgoing_only=True,
            max_pool=3000,
            max_seen=120_000,
        )

    payload = build_common_phrases_payload(
        phrase_counts=phrase_counts,
        example_texts=example_pool,
        # 例句候选池：前端每次点击从中随机抽 3 条展示，池子越大重复感越低。
        examples_per_word=10,
    )
    for keyword in payload["keywords"]:
        keyword["monthlyCounts"] = monthly_counts[keyword["word"]]

    logger.info(
        "Wrapped card#6 common phrases computed: account=%s year=%s phrases=%s bubble=%s scanned=%s matched=%s capped=%s elapsed=%.2fs",
        str(account_dir.name or "").strip(),
        int(year),
        len(payload.get("keywords") or []),
        len(payload.get("bubbleMessages") or []),
        int(scan_meta.get("scannedCandidates") or 0),
        int(scan_meta.get("matchedCandidates") or 0),
        bool(scan_meta.get("capped") or False),
        float(scan_meta.get("elapsedSec") or 0.0),
    )

    return {
        "id": 6,
        "title": title,
        "scope": "global",
        "category": "C",
        "status": "ok",
        "kind": "text/keywords_wordcloud",
        "narrative": "你的年度常用语词云",
        "data": {
            "year": int(year),
            **payload,
            "meta": {
                "scannedCandidates": int(scan_meta.get("scannedCandidates") or 0),
                "matchedCandidates": int(scan_meta.get("matchedCandidates") or 0),
                "uniquePhrases": int(scan_meta.get("uniquePhrases") or 0),
                "capped": bool(scan_meta.get("capped") or False),
                "localTypes": list(scan_meta.get("localTypes") or []),
                "outgoingOnly": True,
                "examplePoolScannedMessages": int(pool_meta.get("scannedMessages") or 0),
                "examplePoolSampledMessages": int(pool_meta.get("sampledMessages") or 0),
            },
        },
    }
