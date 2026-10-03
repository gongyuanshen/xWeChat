"""Directional image evidence from the existing live reader, never archives.

Combined with the Qt draft and new-bubble checks, one newly acknowledged
outgoing image permits the attachment queue to advance. This is not proof
that the recipient has downloaded/viewed it. Concurrent sends from another
device must be avoided during a batch; ambiguous new images remain unconfirmed.
"""
import logging
import time

from .chat_realtime_reader import fetch_rows_via_exec
from .media_helpers import _resolve_account_dir
from .wcdb_realtime import WCDB_REALTIME, exec_query
from .wechat_ui_bridge import WeChatBridgeError

logger = logging.getLogger(__name__)


class ImageSendObserver:
    def __init__(self, account: str, username: str) -> None:
        self.account_dir = _resolve_account_dir(account)
        self.username = username
        try:
            self.connection = WCDB_REALTIME.ensure_connected(self.account_dir)
        except Exception as exc:
            raise WeChatBridgeError(
                "图片发送需要当前账号的实时消息连接；连接失败，未提交图片，请检查后台日志",
                code="WECHAT_IMAGE_RECEIPT_UNAVAILABLE", status_code=503,
            ) from exc
        # Preflight before manipulating the client. Capture again at the actual
        # send boundary so messages arriving while the picker is open are old.
        self.capture()

    def _rows(self):
        try:
            batch = fetch_rows_via_exec(
                rt_conn=self.connection, account_dir=self.account_dir,
                username=self.username, take=100,
                db_storage_dir=self.connection.db_storage_dir,
                exec_query=exec_query, normalize_item=dict,
            )
            if not batch.authoritative or batch.tables_found == 0:
                raise ValueError(f"Live message read is incomplete: {batch.diagnostics}")
            if not self.connection.native_wxid or any(
                row.get('computed_is_send') not in (0, 1)
                for row in batch.rows if int(row['local_type']) == 3
            ):
                raise ValueError("Live messages do not expose a verified sender identity")
            return batch.rows
        except Exception as exc:
            raise WeChatBridgeError(
                "无法读取完整的实时消息及发送方向，请检查后台日志；不能用历史缓存确认图片发送",
                code="WECHAT_IMAGE_RECEIPT_UNAVAILABLE", status_code=503,
            ) from exc

    def capture(self) -> None:
        self.before = {(row['_db_path'], int(row['local_id'])) for row in self._rows()}
        self.started_at = int(time.time())

    def confirmed(self) -> bool:
        candidates = [row for row in self._rows()
                      if (row['_db_path'], int(row['local_id'])) not in self.before
                      and int(row['local_type']) == 3
                      and row['computed_is_send'] == 1
                      and row['sender_username'] == self.connection.native_wxid
                      and int(row['create_time']) >= self.started_at]
        if len(candidates) != 1 or int(candidates[0]['server_id']) == 0:
            return False
        logger.info("WeChat image confirmed by live outgoing row: local_id=%s server_id=%s",
                    candidates[0]['local_id'], candidates[0]['server_id'])
        return True
