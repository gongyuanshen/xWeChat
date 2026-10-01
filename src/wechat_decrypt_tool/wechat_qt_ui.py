"""WeChat 4.x Qt controls, observed on Windows Weixin 4.1.15.13.

Qt's chat_input_field is a UIA element, not a native Edit HWND. This adapter
uses the provider's Value pattern and clicks located controls; it never falls
back to blind keystrokes. A receipt confirms local submission, not delivery.
"""
from __future__ import annotations

import time
import logging

from comtypes import COMError

from .wechat_ui_bridge import (
    WeChatBridgeError,
    WeChatInputBoxNotFoundError,
    WeChatSessionNotFoundError,
)

logger = logging.getLogger(__name__)


def _text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


class WeChatQtUI:
    def __init__(self, hwnd: int, automation, timeout_s: float) -> None:
        self.hwnd = hwnd
        self.automation = automation
        self.root = automation.ControlFromHandle(hwnd)
        self.deadline = time.monotonic() + timeout_s
        self.submission_attempted = False
        self.stage = "session"

    def _wait(self, probe, error):
        # Qt destroys/replaces elements during navigation. Re-query only the
        # documented UIA_E_ELEMENTNOTAVAILABLE transition, within timeout_s;
        # access/COM/provider failures with any other HRESULT fail immediately.
        replaced = None
        while True:
            try:
                value = probe()
            except COMError as exc:
                if exc.hresult != -2147220991:  # UIA_E_ELEMENTNOTAVAILABLE
                    raise
                if replaced is None:
                    logger.warning("WeChat Qt replaced a UIA element during stage=%s; re-querying until deadline", self.stage)
                replaced = exc
                value = None
            if value:
                return value
            if time.monotonic() >= self.deadline:
                raise error from replaced
            time.sleep(0.05)

    def _focus(self, control) -> None:
        # Use raw COM so provider failures are not swallowed by SetFocus().
        control.Element.SetFocus()
        self._wait(
            lambda: control.HasKeyboardFocus,
            WeChatBridgeError("微信输入控件未获得焦点", code="WECHAT_INPUT_FOCUS_FAILED", status_code=502),
        )

    def _write(self, control, content: str) -> None:
        pattern = control.GetValuePattern()
        if pattern is None or pattern.IsReadOnly:
            raise WeChatBridgeError("微信控件不支持文本写入", code="WECHAT_INPUT_WRITE_FAILED", status_code=502)
        if not pattern.SetValue(content, waitTime=0):
            raise WeChatBridgeError("微信控件拒绝文本写入", code="WECHAT_INPUT_WRITE_FAILED", status_code=502)
        self._wait(
            lambda: _text(pattern.Value) == _text(content),
            WeChatBridgeError("微信控件文本回读与待写入内容不一致", code="WECHAT_INPUT_WRITE_FAILED", status_code=502),
        )

    def _session_matches(self, session: str) -> bool:
        title = self.root.TextControl(Compare=lambda c, d: c.AutomationId.endswith(".current_chat_name_label"))
        return title.Exists(0) and title.Name == session

    def locate_input(self, session: str):
        """Read-only probe; no navigation, focus, typing or sending."""
        panel = self.root.GroupControl(AutomationId="chat_message_page")
        if not panel.Exists(0):
            return None
        edit = panel.EditControl(AutomationId="chat_input_field")
        # Empty Qt input Name includes its voice hint; only the chat header is
        # the session identity. Scope the stable input ID to the chat page.
        if (edit.Exists(0) and edit.IsEnabled
                and not edit.IsOffscreen and self._session_matches(session)):
            return edit
        return None

    def prepare_session(self, session: str):
        """Resolve an exact, unambiguous local search result before editing."""
        search = self.root.EditControl(ClassName="mmui::XValidatorTextEdit", Name="搜索")
        if not search.Exists(0):
            raise WeChatSessionNotFoundError("微信会话搜索框不可用（当前适配 Windows 微信 4.x 中文界面）")
        self._focus(search)
        self._write(search, session)

        def search_result():
            results = self.root.ListControl(AutomationId="search_list")
            if not results.Exists(0):
                return None
            matches = [c for c in results.GetChildren()
                       if c.ControlTypeName == "ListItemControl" and c.Name == session
                       and c.AutomationId in (f"search_item_{session}", f"search_item_function_{session}")]
            if len(matches) > 1:
                raise WeChatBridgeError("存在同名会话，无法唯一确定收件人", code="WECHAT_SESSION_AMBIGUOUS", status_code=409)
            return matches[0] if matches and matches[0].IsEnabled and not matches[0].IsOffscreen else None

        result = self._wait(search_result, WeChatSessionNotFoundError("微信搜索未返回名称完全一致的会话"))
        # On Weixin 4.1.15 the search item's Invoke may return S_OK without
        # opening the chat. Click the located item's UIA rectangle, then verify
        # the header; no fixed coordinates or blind Enter on the first result.
        result.Click(simulateMove=False, waitTime=0)
        self._wait(lambda: self._session_matches(session), WeChatSessionNotFoundError("微信当前会话与目标名称不一致"))
        return self._wait(lambda: self.locate_input(session), WeChatInputBoxNotFoundError("目标会话的 chat_input_field 不可用"))

    def _message_ids(self, message_list, content: str) -> set[tuple[int, ...]]:
        return {tuple(c.GetRuntimeId()) for c in message_list.GetChildren()
                if c.ControlTypeName == "ListItemControl" and _text(c.Name) == _text(content)}

    def _image_ids(self, message_list) -> set[tuple[int, ...]]:
        return {tuple(c.GetRuntimeId()) for c in message_list.GetChildren()
                if c.ControlTypeName == "ListItemControl" and c.Name == "图片"
                and c.ClassName == "mmui::ChatBubbleReferItemView"}

    def _image_draft(self, edit) -> tuple[str, str, int]:
        value = edit.GetValuePattern()
        text = edit.GetTextPattern()
        if value is None or text is None:
            raise WeChatBridgeError("微信输入框未提供图片草稿核验接口",
                                    code="WECHAT_IMAGE_DRAFT_UNCONFIRMED", status_code=502)
        return value.Value, text.DocumentRange.GetText(-1), len(text.DocumentRange.GetChildren())

    def send_image(self, session: str, image_path: str, *, window_api, process_api) -> None:
        """Stage one validated image using the observed native file dialog.

        Weixin 4.1.15.13 inserts one U+FFFC object in its editor. Local
        Draft clearing and a new picture are observable, but this UIA version
        exposes neither message direction nor image content. These observations
        are reported as unconfirmed rather than fabricated successful delivery.
        No clipboard, blind keystrokes, alternate route or automatic resend.
        """
        edit = self.prepare_session(session)
        self.stage = "image_prepare"
        if self._image_draft(edit) != ("", "", 0):
            raise WeChatBridgeError("微信输入框已有文字或图片草稿，请先处理后重试",
                                    code="WECHAT_DRAFT_CONFLICT", status_code=409)
        messages = self.root.ListControl(AutomationId="chat_message_list")
        if not messages.Exists(0):
            raise WeChatBridgeError("微信消息列表不可用，无法核实图片发送结果",
                                    code="WECHAT_MESSAGE_LIST_NOT_FOUND", status_code=502)
        before = self._image_ids(messages)
        panel = self.root.GroupControl(AutomationId="chat_message_page")
        file_button = panel.ButtonControl(Name="发送文件")
        self._wait(lambda: file_button.Exists(0) and file_button.IsEnabled and not file_button.IsOffscreen,
                   WeChatBridgeError("微信发送文件按钮不可用",
                                     code="WECHAT_IMAGE_BUTTON_NOT_FOUND", status_code=502))
        if window_api.GetForegroundWindow() != self.hwnd or not self.locate_input(session):
            raise WeChatBridgeError("选择图片前微信前台或会话发生变化",
                                    code="WECHAT_SEND_STATE_CHANGED", status_code=409)
        file_button.Click(simulateMove=False, waitTime=0)
        self.stage = "image_file_dialog"
        main_pid = process_api.GetWindowThreadProcessId(self.hwnd)[1]

        def owned_dialog():
            hwnd = window_api.GetForegroundWindow()
            if (hwnd and hwnd != self.hwnd and window_api.GetClassName(hwnd) == "#32770"
                    and window_api.GetWindow(hwnd, 4) == self.hwnd  # GW_OWNER
                    and process_api.GetWindowThreadProcessId(hwnd)[1] == main_pid):
                return hwnd
            return None

        dialog_hwnd = self._wait(owned_dialog, WeChatBridgeError(
            "未找到属于微信主窗口的文件选择框",
            code="WECHAT_IMAGE_DIALOG_NOT_FOUND", status_code=502))
        dialog = self.automation.ControlFromHandle(dialog_hwnd)
        filename = dialog.EditControl(AutomationId="1148")
        open_button = dialog.SplitButtonControl(AutomationId="1")
        # The native dialog becomes foreground before its child controls finish
        # initialization. Wait for readiness within the existing send deadline.
        self._wait(
            lambda: owned_dialog() == dialog_hwnd
            and filename.Exists(0) and filename.IsEnabled
            and open_button.Exists(0) and open_button.IsEnabled,
            WeChatBridgeError("微信文件选择框的文件名或打开控件在超时内未就绪",
                              code="WECHAT_IMAGE_DIALOG_NOT_FOUND", status_code=502),
        )
        self._write(filename, image_path)
        if owned_dialog() != dialog_hwnd or not self._session_matches(session):
            raise WeChatBridgeError("打开图片前文件选择框或目标会话发生变化",
                                    code="WECHAT_SEND_STATE_CHANGED", status_code=409)
        open_button.Click(simulateMove=False, waitTime=0)
        self.stage = "image_draft"

        def prepared():
            current = self.locate_input(session)
            return current is not None and self._image_draft(current) == ("\ufffc", "\ufffc", 0)

        self._wait(prepared, WeChatBridgeError(
            "未确认微信输入框包含一张图片；请核对客户端草稿",
            code="WECHAT_IMAGE_DRAFT_UNCONFIRMED", status_code=502))
        button = panel.ButtonControl(Name="发送")
        self._wait(lambda: button.Exists(0) and button.IsEnabled and not button.IsOffscreen,
                   WeChatBridgeError("微信发送按钮不可用", code="WECHAT_SEND_BUTTON_NOT_FOUND", status_code=502))
        if window_api.GetForegroundWindow() != self.hwnd or not prepared():
            raise WeChatBridgeError("发送图片前微信前台、会话或草稿发生变化",
                                    code="WECHAT_SEND_STATE_CHANGED", status_code=409)
        self.stage = "image_confirm"
        self.submission_attempted = True
        button.Click(simulateMove=False, waitTime=0)

        def confirmed():
            current = self.locate_input(session)
            return (current is not None and self._image_draft(current) == ("", "", 0)
                    and len(self._image_ids(messages) - before) == 1)

        self._wait(confirmed, WeChatBridgeError(
            "未确认图片草稿清空及一条新图片消息出现；请核对客户端，避免重复发送",
            code="WECHAT_SEND_UNCONFIRMED", status_code=504))
        # A generic picture may be incoming. The observed Qt provider exposes
        # no sender and its rectangle spans the whole row, so this adapter has
        # no evidence to attribute the new picture to our outbound submission.
        raise WeChatBridgeError(
            "微信图片草稿已清空且出现新图片，但客户端未提供发送方向，无法确认出站图片；"
            "请在微信核对对应的新图片，避免重复发送",
            code="WECHAT_SEND_UNCONFIRMED", status_code=504)

    def send_text(self, session: str, content: str) -> None:
        edit = self.prepare_session(session)
        self.stage = "write"
        existing = edit.GetValuePattern().Value
        if existing and _text(existing) != _text(content):
            raise WeChatBridgeError("微信输入框已有其他草稿，请先处理草稿后重试", code="WECHAT_DRAFT_CONFLICT", status_code=409)
        self._focus(edit)
        self._write(edit, content)

        # Input and toolbar belong to chat_message_page; bottom_ui_ is a sibling
        # placeholder, not their ancestor (verified on Weixin 4.1.15.13).
        panel = self.root.GroupControl(AutomationId="chat_message_page")
        if not panel.Exists(0):
            raise WeChatInputBoxNotFoundError("微信聊天输入面板不可用")
        button = panel.ButtonControl(Name="发送")
        self._wait(lambda: button.Exists(0) and button.IsEnabled and not button.IsOffscreen,
                   WeChatBridgeError("微信发送按钮不可用", code="WECHAT_SEND_BUTTON_NOT_FOUND", status_code=502))
        messages = self.root.ListControl(AutomationId="chat_message_list")
        if not messages.Exists(0):
            raise WeChatBridgeError("微信消息列表不可用，无法核实发送结果", code="WECHAT_MESSAGE_LIST_NOT_FOUND", status_code=502)
        before = self._message_ids(messages, content)
        # Recheck the target and exact draft immediately before the only send.
        if not self.locate_input(session) or _text(edit.GetValuePattern().Value) != _text(content):
            raise WeChatBridgeError("发送前会话或草稿发生变化，已中止", code="WECHAT_SEND_STATE_CHANGED", status_code=409)

        self.stage = "confirm"
        self.submission_attempted = True
        # A failure after this point is ambiguous; never automatically retry.
        # Weixin 4.1.15.13 also returns S_OK for the send button's Invoke without
        # submitting. Use its observed UIA rectangle as for search navigation.
        button.Click(simulateMove=False, waitTime=0)
        def confirmed():
            current = self.locate_input(session)
            return (current is not None and current.GetValuePattern().Value == ""
                    and bool(self._message_ids(messages, content) - before))
        self._wait(confirmed, WeChatBridgeError(
            "未确认微信输入框清空及新消息出现；请先核对客户端，避免重复发送",
            code="WECHAT_SEND_UNCONFIRMED", status_code=504,
        ))
