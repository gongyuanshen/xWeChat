"""Observe one exact WeChat-native voice result in naturally published snapshots.

This module never triggers recognition, starts a refresh worker, or reads the
project's ASR cache. A completed result proves native text for the target record.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import time

from .chat_helpers import _decode_message_content, _extract_voice_transcript_from_packed_info, _extract_xml_attr, _quote_ident
from .account_identity import resolve_account_self_rowid
from .independent_snapshot import _source_manifest
from .snapshot_refresh import SNAPSHOT_REFRESH, SnapshotRefreshError
from .snapshot_registry import resolve_account_database_dir, snapshot_read_scope, SnapshotRegistryError


class NativeVoiceError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _message_manifest(manifest):
    return {name: fingerprint for name, fingerprint in manifest.items()
            if re.fullmatch(r'message_\d+\.db(?:-wal|-journal)?', Path(name).name, re.IGNORECASE)}


class NativeVoiceObservation:
    @classmethod
    def prepare(cls, account: str, username: str, message_id: str, server_id: str, create_time: int):
        match = re.fullmatch(r'(message_\d+):((?:Msg|Chat)_[0-9a-f]{32}):([1-9][0-9]*)',
                             message_id if isinstance(message_id, str) else '', re.IGNORECASE)
        if (not isinstance(username, str) or not username.strip() or any(ord(char) < 32 for char in username)
                or not isinstance(server_id, str) or not re.fullmatch(r'[1-9][0-9]*', server_id)
                or int(server_id) > 2**63 - 1 or type(create_time) is not int or create_time <= 0
                or match is None or int(match[3]) > 2**63 - 1):
            raise NativeVoiceError('invalid_target', '原生转写需要完整消息定位、准确的十进制 serverId 和创建时间')
        username = username.strip()
        if match[2].split('_', 1)[1].lower() != hashlib.md5(username.encode()).hexdigest():
            raise NativeVoiceError('invalid_target', '语音消息表不属于指定会话')
        try:
            account = SNAPSHOT_REFRESH._validate_account(account)
            stamp = datetime.fromtimestamp(create_time)
        except (SnapshotRefreshError, ValueError, OSError, OverflowError) as exc:
            raise NativeVoiceError('invalid_target', '原生转写账号或消息时间无效') from exc
        self = cls()
        self.account, self.username, self.message_id = account, username, message_id
        self.server_id, self.create_time = server_id, create_time
        self.db, self.table, self.local_id = match[1], match[2], int(match[3])
        self.date_label = f'{stamp.year}年{stamp.month}月{stamp.day}日'
        self.minute_label = stamp.strftime('%H:%M')
        self._source_binding = None
        self.is_sender = None
        self._deadline, self._timeout_code = time.monotonic() + 10, 'baseline_timeout'
        try:
            while True:
                self._checkpoint()
                with snapshot_read_scope(independent=True) as pins:
                    pins.clear()
                    generation, manifest, text, duration, count, is_sender = self._read_snapshot()
                    # Reading an existing result requires no new UI action and
                    # therefore does not require the trigger's minute uniqueness.
                    if not text:
                        self._require_sync()
                        self._require_unique(count)
                        current = self._source_message_manifest()
                        self._require_sync()
                        if current != _message_manifest(manifest):
                            self._sleep()
                            continue
                    self.generation = self._baseline_generation = generation
                    self.native_text, self.duration_ms = text, duration
                    self.is_sender = is_sender
                    self._message_manifest = _message_manifest(manifest)
                    return self
        finally:
            self._deadline = None

    def _checkpoint(self):
        if self._deadline is not None and time.monotonic() >= self._deadline:
            message = ('未在限定时间内观察到微信原生转写完成；请在微信核对，不会自动重新触发'
                       if self._timeout_code == 'result_timeout'
                       else '未在限定时间内取得新鲜语音消息基线；请完成自动同步后重试')
            raise NativeVoiceError(self._timeout_code, message)

    def _sleep(self):
        self._checkpoint()
        time.sleep(min(.1, max(0, self._deadline - time.monotonic())))

    def _require_sync(self):
        status = SNAPSHOT_REFRESH.status(self.account)
        if status['error']:
            error = status['error']
            raise NativeVoiceError('sync_failed', f"微信自动同步失败：{error['stage']} · {error['message']}")
        if not status['enabled'] or status['active_account'] != self.account:
            raise NativeVoiceError('sync_stopped', '当前账号的自动同步未开启或已停止，无法确认原生转写')

    @staticmethod
    def _require_unique(count):
        if count != 1:
            raise NativeVoiceError('target_ambiguous', f'该会话同一分钟有 {count} 条语音，无法唯一定位；未触发转写')

    def _read_snapshot(self, *, check_minute: bool = True):
        self._checkpoint()
        try:
            context, source, key = SNAPSHOT_REFRESH._inputs(self.account)
            info = source.stat()
            binding = (context.account_dir, source, info.st_dev, info.st_ino, hashlib.sha256(key.encode('ascii')).digest())
            if self._source_binding is not None and binding != self._source_binding:
                raise NativeVoiceError('source_changed', '账号来源目录或数据库密钥已变化，无法继续原生转写')
            directory = resolve_account_database_dir(context.account_dir)
            if directory == context.account_dir:
                raise NativeVoiceError('snapshot_unavailable', '原生转写需要当前账号已验证的独立快照')
            generation = directory.parents[1]
            ownership = json.loads((generation / 'ownership.json').read_text(encoding='utf-8'))
            if Path(ownership['source_db_storage_path']).resolve(strict=True) != source:
                raise NativeVoiceError('source_changed', '当前快照与所选账号的源目录不一致')
            manifest = json.loads((generation / 'manifest.json').read_text(encoding='utf-8'))['manifest']
        except (SnapshotRefreshError, SnapshotRegistryError, OSError, ValueError) as exc:
            raise NativeVoiceError('source_changed' if self._source_binding else 'snapshot_unavailable',
                                   f'无法验证原生语音来源：{exc}') from exc
        self._source_binding = binding
        self.source_dir, self.account_dir = source, context.account_dir
        expected = hashlib.md5(self.username.encode()).hexdigest()
        minute = self.create_time // 60 * 60
        target, count = None, 0
        try:
            for database in sorted(directory.glob('message_*.db')):
                self._checkpoint()
                if not re.fullmatch(r'message_\d+\.db', database.name, re.IGNORECASE):
                    continue
                with closing(sqlite3.connect(database.resolve(strict=True).as_uri() + '?mode=ro&immutable=1', uri=True)) as connection:
                    connection.row_factory = sqlite3.Row
                    names = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                    tables = [name for name in names if name.lower() in {'msg_' + expected, 'chat_' + expected}]
                    for table in tables:
                        quoted = _quote_ident(table)
                        if check_minute:
                            count += connection.execute(f'SELECT COUNT(*) FROM {quoted} WHERE local_type=34 AND create_time>=? AND create_time<?',
                                                        (minute, minute + 60)).fetchone()[0]
                        if database.stem.lower() != self.db.lower() or table.lower() != self.table.lower():
                            continue
                        rows = connection.execute(f'SELECT local_id,server_id,local_type,create_time,packed_info_data,compress_content,message_content,real_sender_id '
                                                  f'FROM {quoted} WHERE local_id=? LIMIT 2', (self.local_id,)).fetchall()
                        if len(rows) > 1:
                            raise NativeVoiceError('target_ambiguous', '该语音定位对应多条消息，未触发转写')
                        if rows:
                            target = rows[0]
                            self_id, _ = resolve_account_self_rowid(connection, context.account_dir)
                            sender_id = target['real_sender_id']
                            if self_id is None or type(sender_id) is not int or sender_id <= 0:
                                raise NativeVoiceError('target_metadata_invalid', '语音消息缺少准确的账号或发送者身份，无法判断收发方向')
                            sender = connection.execute('SELECT user_name FROM Name2Id WHERE rowid=?', (sender_id,)).fetchone()
                            if sender is None or not isinstance(sender[0], str) or not sender[0].strip():
                                raise NativeVoiceError('target_metadata_invalid', '语音发送者在当前分库没有有效身份，无法判断收发方向')
                            is_sender = sender_id == self_id
        except sqlite3.Error as exc:
            raise NativeVoiceError('snapshot_query_failed', f'无法读取原生语音快照：{exc}') from exc
        if target is None:
            raise NativeVoiceError('target_not_found', '当前快照中找不到指定语音，消息可能已删除或失效')
        if (str(target['server_id']) != self.server_id or target['create_time'] != self.create_time
                or target['local_type'] != 34):
            raise NativeVoiceError('target_changed', '指定定位的 serverId、创建时间或消息类型已变化，未匹配到原语音')
        if self.is_sender is not None and self.is_sender != is_sender:
            raise NativeVoiceError('target_changed', '指定语音的收发方向已变化，无法继续原生转写')
        raw = _decode_message_content(target['compress_content'], target['message_content'])
        duration = _extract_xml_attr(raw, 'voicelength')
        if not re.fullmatch(r'[1-9][0-9]*', duration or ''):
            raise NativeVoiceError('target_metadata_invalid', '指定语音缺少有效的原始毫秒时长，无法定位')
        text = _extract_voice_transcript_from_packed_info(target['packed_info_data'])
        self._checkpoint()
        return generation.name, manifest, text, int(duration), count, is_sender

    def _source_message_manifest(self):
        try:
            return _message_manifest(_source_manifest(self.source_dir, checkpoint=self._checkpoint))
        except NativeVoiceError:
            raise
        except Exception as exc:
            raise NativeVoiceError('source_changed', f'无法核对原生语音源数据库：{exc}') from exc

    def revalidate(self):
        self._deadline, self._timeout_code = time.monotonic() + 10, 'baseline_timeout'
        try:
            with snapshot_read_scope(independent=True) as pins:
                pins.clear()
                self._require_sync()
                _, _, _, _, count, _ = self._read_snapshot()
                self._require_unique(count)
                if self._source_message_manifest() != self._message_manifest:
                    raise NativeVoiceError('baseline_changed', '准备后语音消息数据库已变化，未触发转写；请重新选择并重试')
                self._require_sync()
                self._checkpoint()
        finally:
            self._deadline = None

    def wait_result(self, timeout_s: float = 20):
        if isinstance(timeout_s, bool) or not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError('Native voice result timeout must be positive and finite')
        self._deadline, self._timeout_code = time.monotonic() + timeout_s, 'result_timeout'
        try:
            while True:
                self._checkpoint()
                with snapshot_read_scope(independent=True) as pins:
                    pins.clear()
                    self._require_sync()
                    generation, _, text, _, _, _ = self._read_snapshot(check_minute=False)
                    self._require_sync()
                    if text and generation != self._baseline_generation:
                        self.native_text, self.generation = text, generation
                        return dict(text=text, model='wechat-native', generation=generation)
                self._sleep()
        finally:
            self._deadline = None
