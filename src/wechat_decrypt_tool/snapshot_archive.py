"""Archive originals from one explicitly pinned, verified snapshot generation.

No timestamp watermark can detect an original row replaced in place by a revoke.
Changed message shards are therefore scanned in full; completed generations and
unresolved event evidence are durable. Media references are saved, not media files.
"""
from __future__ import annotations

from contextlib import ExitStack, closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3

from .anti_revoke import (
    get_anti_revoke_connection, get_anti_revoke_db_path, parse_revoke_xml,
    process_revocation_event, save_messages_to_archive,
)
from .chat_helpers import (
    _extract_md5_from_packed_info, _iter_message_db_paths, _lookup_resource_md5,
    _resolve_msg_table_name_by_map, _resource_lookup_chat_id,
)
from .snapshot_registry import _generation_account, _validate_generation, snapshot_read_scope


def read_archive_state(account_dir: Path) -> dict | None:
    path = get_anti_revoke_db_path(account_dir)
    if not path.exists():
        return None
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        if conn.execute("SELECT 1 FROM sqlite_master WHERE name='snapshot_archive_state'").fetchone() is None:
            return None
        row = conn.execute("SELECT * FROM snapshot_archive_state WHERE account=?", (account_dir.name,)).fetchone()
        return dict(row) if row is not None else None


def _create_tables(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS snapshot_archive_state (
        account TEXT PRIMARY KEY, generation TEXT NOT NULL,
        manifest_json TEXT NOT NULL, completed_at TEXT NOT NULL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS snapshot_revoke_events (
        event_id TEXT PRIMARY KEY, account TEXT NOT NULL, username TEXT NOT NULL,
        xml_text TEXT NOT NULL, revoke_time INTEGER NOT NULL,
        server_id TEXT NOT NULL, local_id INTEGER NOT NULL,
        source_db TEXT NOT NULL, source_table TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unresolved', reason TEXT NOT NULL DEFAULT '',
        generation TEXT NOT NULL, resolved_at TEXT)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_snapshot_revoke_pending ON snapshot_revoke_events(account,status,event_id)")
    conn.commit()


def _source_files(manifest, database):
    names = {database, database + '-wal', database + '-journal'}
    return {name: entry for name, entry in manifest.items() if Path(name).name in names}


def _conversation_tables(database: Path, seeds: set[str]) -> dict[str, str]:
    from .chat_export_service import _load_name2id_usernames
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        tables = {name.lower(): name for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
                  if name.lower().startswith(('msg_', 'chat_'))}
        if not tables:
            return {}
        mapped = {}
        for username in sorted(seeds | _load_name2id_usernames(conn)):
            name = _resolve_msg_table_name_by_map(tables, username)
            if name is not None:
                if name in mapped and mapped[name] != username:
                    raise sqlite3.DatabaseError(f"Ambiguous conversation mapping in {database.name}: {name}")
                mapped[name] = username
        missing = set(tables.values()) - mapped.keys()
        if missing:
            raise sqlite3.DatabaseError(f"Unmapped message tables in {database.name}: {sorted(missing)}")
        return mapped


def archive_published_snapshot(account_dir: Path, generation: Path, *, progress, stopped) -> dict | None:
    """Return durable completion, or None when stopped at a batch boundary.

    The refresh worker owns the account work lease for this entire call. Every
    write targets the stable account archive; source snapshots remain immutable.
    """
    from .chat_export_service import (
        _iter_rows_for_conversation, _load_export_contact_usernames,
        _load_export_session_targets,
    )
    manifest_path = generation / 'manifest.json'
    metadata = json.loads(manifest_path.read_text(encoding='utf-8'))
    generation_account = _generation_account(account_dir, metadata['account'])
    result = _validate_generation(account_dir, generation, generation_account)
    previous = read_archive_state(account_dir)
    if previous is not None and previous['generation'] == generation.name:
        return previous
    previous_manifest = json.loads(previous['manifest_json']) if previous is not None else {}
    if not isinstance(previous_manifest, dict):
        raise ValueError('Archived generation manifest must be an object')
    current_manifest = result['manifest']
    state = dict(initial=previous is None, messages_processed=0, databases_done=0, databases_total=0)
    with snapshot_read_scope(independent=True) as directories:
        # independent=True may copy an existing request pin. Bind this exact
        # verified generation explicitly, never the caller's older pin.
        directories[os.path.normcase(str(account_dir.absolute()))] = Path(result['account_path'])
        paths = _iter_message_db_paths(account_dir)
        resource_changed = (_source_files(current_manifest, 'message_resource.db') !=
                            _source_files(previous_manifest, 'message_resource.db'))
        changed = [path for path in paths if previous is None or resource_changed or
                   _source_files(current_manifest, path.name) != _source_files(previous_manifest, path.name)]
        state['databases_total'] = len(changed)
        progress(dict(state))
        sessions, _ = _load_export_session_targets(account_dir)
        seeds = {username for username, _ in sessions} | _load_export_contact_usernames(account_dir)
        with ExitStack() as opened:
            conn = opened.enter_context(closing(get_anti_revoke_connection(account_dir)))
            resource_path = Path(result['account_path']) / 'message_resource.db'
            resource = (opened.enter_context(closing(sqlite3.connect(
                resource_path.resolve().as_uri() + '?mode=ro', uri=True))) if resource_path.exists() else None)
            resource_has_chats = resource is not None and resource.execute(
                "SELECT 1 FROM sqlite_master WHERE name='ChatName2Id'").fetchone() is not None
            _create_tables(conn)
            def save_batch(username, rows, events):
                save_messages_to_archive(account_dir, account_dir.name, username, rows)
                if events:
                    conn.executemany("""INSERT OR IGNORE INTO snapshot_revoke_events (
                        event_id,account,username,xml_text,revoke_time,server_id,local_id,
                        source_db,source_table,generation,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)""", events)
                    conn.commit()
                progress(dict(state))

            for database in changed:
                if stopped():
                    return None
                for table, username in _conversation_tables(database, seeds).items():
                    rows, events = [], []
                    resource_chat = _resource_lookup_chat_id(resource, username, strict=True) if resource_has_chats else None
                    stream = _iter_rows_for_conversation(account_dir=account_dir,
                        conv_username=username, start_time=None, end_time=None,
                        include_archive=False, db_paths=[database])
                    with closing(stream):
                        for row in stream:
                            if row.local_type == 10000:
                                if parse_revoke_xml(row.raw_text) is not None:
                                    evidence = (account_dir.name, username, row.raw_text,
                                        row.create_time, str(row.server_id), row.local_id,
                                        row.db_stem, row.table_name)
                                    event_id = hashlib.sha256(json.dumps(evidence, ensure_ascii=False).encode()).hexdigest()
                                    events.append((event_id, *evidence, generation.name, 'original_not_captured_or_ambiguous'))
                            else:
                                item = dict(local_id=row.local_id, server_id=str(row.server_id),
                                    local_type=row.local_type, sort_seq=row.sort_seq, create_time=row.create_time,
                                    sender_username=row.sender_username, is_sent=row.is_sent,
                                    message_content=row.raw_text, packed_info_data=row.packed_info_data,
                                    source_db=row.db_stem, source_table=row.table_name)
                                if row.local_type == 3:
                                    identifier = _extract_md5_from_packed_info(row.packed_info_data)
                                    if not identifier and resource is not None and (row.server_id > 0 or resource_chat is not None):
                                        identifier = _lookup_resource_md5(resource, resource_chat, row.local_type,
                                            row.server_id, row.local_id, row.create_time, strict=True)
                                    if identifier:
                                        item['imageMd5'] = identifier
                                rows.append(item)
                            state['messages_processed'] += 1
                            if state['messages_processed'] % 400 == 0:
                                save_batch(username, rows, events)
                                rows, events = [], []
                                if stopped():
                                    return None
                    save_batch(username, rows, events)
                state['databases_done'] += 1
                progress(dict(state))

            # All originals from every changed shard are committed before any
            # event is applied. Revisit durable misses when later captures arrive.
            cursor = ''
            while not stopped():
                events = conn.execute("SELECT * FROM snapshot_revoke_events WHERE account=? AND status='unresolved' AND event_id>? ORDER BY event_id LIMIT 400",
                                      (account_dir.name, cursor)).fetchall()
                if not events:
                    break
                for event in events:
                    if stopped():
                        return None
                    match = process_revocation_event(account_dir, account_dir.name,
                        event['username'], event['xml_text'], revoke_time=event['revoke_time'],
                        server_id=event['server_id'], local_id=event['local_id'],
                        source_db=event['source_db'], source_table=event['source_table'], recover_missing=False)
                    if match is not None:
                        conn.execute("UPDATE snapshot_revoke_events SET status='resolved',reason='',resolved_at=? WHERE event_id=?",
                                     (datetime.now(timezone.utc).isoformat(), event['event_id']))
                        conn.commit()
                    cursor = event['event_id']
            if stopped():
                return None
            completed_at = datetime.now(timezone.utc).isoformat()
            conn.execute("INSERT INTO snapshot_archive_state VALUES(?,?,?,?) ON CONFLICT(account) DO UPDATE SET generation=excluded.generation,manifest_json=excluded.manifest_json,completed_at=excluded.completed_at",
                         (account_dir.name, generation.name, json.dumps(current_manifest), completed_at))
            conn.commit()
    return {'generation': generation.name, 'completed_at': completed_at}
