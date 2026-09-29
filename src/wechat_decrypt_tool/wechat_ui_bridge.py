"""
src/wechat_decrypt_tool/wechat_ui_bridge.py
===========================================
Zero-Injection Windows UI Automation Bridge for WeChat Client.
Provides non-intrusive desktop automation, status probing, clipboard safety,
rate limiting, and fail-fast exception handling adhering to Debug-First Policy.
"""
from __future__ import annotations

import asyncio
import ctypes
from dataclasses import dataclass
import hashlib
import logging
import sys
import time
from typing import Any, Callable, Optional, Union

import psutil

if sys.platform == "win32":
    import win32api
    import win32clipboard
    import win32con
    import win32gui
    import win32process
else:
    win32api = None
    win32clipboard = None
    win32con = None
    win32gui = None
    win32process = None

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Strong-Typed Exception Hierarchy (Let-It-Fail)
# ---------------------------------------------------------------------------
class WeChatBridgeError(Exception):
    """Base class for all WeChat UI Automation bridge exceptions."""

    code: str = "WECHAT_BRIDGE_ERROR"
    status_code: int = 500
    detail: str = "微信桌面桥接服务异常"

    def __init__(
        self,
        detail: str | None = None,
        *,
        code: str | None = None,
        status_code: int | None = None,
    ) -> None:
        if detail is not None:
            self.detail = detail
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        super().__init__(f"[{self.code}] {self.detail} (HTTP {self.status_code})")

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "status_code": self.status_code,
            "detail": self.detail,
        }


class WeChatProcessNotFoundError(WeChatBridgeError):
    code: str = "WECHAT_NOT_RUNNING"
    status_code: int = 503
    detail: str = "未检测到运行中的微信进程，请确认微信客户端已启动"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


class WeChatWindowNotFoundError(WeChatBridgeError):
    code: str = "WECHAT_WINDOW_NOT_FOUND"
    status_code: int = 503
    detail: str = "未找到微信主窗口(WeChatMainWndForPC)，请确认微信主界面未完全退出或关闭"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


class WeChatLockedError(WeChatBridgeError):
    code: str = "WECHAT_LOCKED"
    status_code: int = 423
    detail: str = "微信处于锁定状态，请在电脑端解锁微信后重试"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


class WeChatSessionNotFoundError(WeChatBridgeError):
    code: str = "WECHAT_SESSION_NOT_FOUND"
    status_code: int = 404
    detail: str = "未找到指定联系人或群聊会话，请确认会话名称准确或已存在于聊天列表"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


class WeChatInputBoxNotFoundError(WeChatBridgeError):
    code: str = "WECHAT_INPUT_BOX_NOT_FOUND"
    status_code: int = 502
    detail: str = "未定位到微信消息输入框控件，可能界面被遮挡、处于非聊天界面或UI结构不匹配"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


class WeChatSendTimeoutError(WeChatBridgeError):
    code: str = "WECHAT_SEND_TIMEOUT"
    status_code: int = 504
    detail: str = "消息发送超时，微信未能及时响应发送动作"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


class WeChatRateLimitExceededError(WeChatBridgeError):
    code: str = "WECHAT_RATE_LIMIT_EXCEEDED"
    status_code: int = 429
    detail: str = "操作过于频繁或3秒内重复发送相同内容，已被风控拦截，请稍候重试"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


class WeChatClipboardLockedError(WeChatBridgeError):
    code: str = "CLIPBOARD_LOCKED"
    status_code: int = 500
    detail: str = "访问系统剪贴板超时或被拒绝，剪贴板被其他应用锁定"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail=detail if detail is not None else self.detail)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------
@dataclass
class SendReceipt:
    success: bool
    session_title: str
    content_length: int
    duration_ms: float
    timestamp: float


@dataclass
class WeChatStatus:
    running: bool
    pid: Optional[int]
    window_found: bool
    hwnd: Optional[int]
    locked: bool


@dataclass
class ClipboardBackup:
    text: Optional[str] = None
    was_empty: bool = False
    has_non_text: bool = False


# ---------------------------------------------------------------------------
# Rate Limiter & Idempotency Cache
# ---------------------------------------------------------------------------
class WeChatRateLimiter:
    """In-memory rate limiter and anti-flood protection for WeChat UI automation."""

    def __init__(
        self,
        duplicate_window_s: float = 3.0,
        session_cooldown_s: float = 1.0,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.duplicate_window_s = float(duplicate_window_s)
        self.session_cooldown_s = float(session_cooldown_s)
        self._clock = clock
        self._msg_cache: dict[str, float] = {}
        self._session_cache: dict[str, float] = {}

    @staticmethod
    def compute_message_key(session: str, content: str) -> str:
        """MD5 key for duplicate idempotency: MD5("{session}:{content}")."""
        payload = f"{session}:{content}".encode("utf-8")
        return hashlib.md5(payload).hexdigest()

    def _prune(self, now: float) -> None:
        """Evict expired records to keep memory bounded."""
        cutoff_msg = now - self.duplicate_window_s
        cutoff_session = now - self.session_cooldown_s
        for k in [k for k, ts in self._msg_cache.items() if ts < cutoff_msg]:
            del self._msg_cache[k]
        for s in [s for s, ts in self._session_cache.items() if ts < cutoff_session]:
            del self._session_cache[s]

    def check_and_record(self, session: str, content: str) -> None:
        """Enforce rate limits and record timestamps atomically.

        Raises:
            WeChatRateLimitExceededError: On duplicate content within 3s or session flood within 1s.
        """
        now = self._clock()
        self._prune(now)

        # 1. Check duplicate message within 3.0 seconds
        msg_key = self.compute_message_key(session, content)
        last_msg = self._msg_cache.get(msg_key)
        if last_msg is not None and (now - last_msg) < self.duplicate_window_s:
            rem = self.duplicate_window_s - (now - last_msg)
            raise WeChatRateLimitExceededError(
                f"3秒内禁止向会话[{session}]重复发送相同内容（防重保护生效中，还需等待 {rem:.1f} 秒）"
            )

        # 2. Check session cooldown within 1.0 second
        last_session = self._session_cache.get(session)
        if last_session is not None and (now - last_session) < self.session_cooldown_s:
            rem = self.session_cooldown_s - (now - last_session)
            raise WeChatRateLimitExceededError(
                f"会话[{session}]发送频率超限，每秒最多发送1条消息（请等待 {rem:.1f} 秒冷却）"
            )

        self._msg_cache[msg_key] = now
        self._session_cache[session] = now

    def rollback_message(self, session: str, content: str, rollback_session: bool = True) -> None:
        """Roll back idempotency cache if send fails due to OS/UI error."""
        msg_key = self.compute_message_key(session, content)
        self._msg_cache.pop(msg_key, None)
        if rollback_session:
            self._session_cache.pop(session, None)

    def reset(self) -> None:
        """Reset internal caches (for tests and teardown)."""
        self._msg_cache.clear()
        self._session_cache.clear()


# ---------------------------------------------------------------------------
# Core Bridge Class
# ---------------------------------------------------------------------------
class WeChatBridge:
    def __init__(
        self,
        rate_limiter: Optional[WeChatRateLimiter] = None,
        lock: Optional[asyncio.Lock] = None,
        send_timeout_s: float = 10.0,
    ) -> None:
        self.psutil = psutil
        self.win32api = win32api
        self.win32clipboard = win32clipboard
        self.win32con = win32con
        self.win32gui = win32gui
        self.win32process = win32process
        self.user32 = ctypes.windll.user32 if sys.platform == "win32" and hasattr(ctypes, "windll") else None

        self.rate_limiter = rate_limiter or WeChatRateLimiter()
        self._lock = lock
        self.send_timeout_s = float(send_timeout_s)

    def _get_lock(self) -> asyncio.Lock:
        """Lazy lock initialization bound to the current running event loop."""
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None

        if self._lock is None or (
            current_loop is not None and getattr(self._lock, "_loop", None) not in (None, current_loop)
        ):
            self._lock = asyncio.Lock()
        return self._lock

    def _is_workstation_locked(self) -> bool:
        """Check if Windows desktop / workstation is locked (Win+L / Secure Desktop)."""
        if sys.platform != "win32" or not self.user32:
            return False
        try:
            hdesk = self.user32.OpenInputDesktop(0, False, 0x01FF)
            if not hdesk:
                return True
            try:
                self.user32.SetThreadDesktop(hdesk)
            finally:
                if hasattr(self.user32, "CloseDesktop"):
                    self.user32.CloseDesktop(hdesk)
            return False
        except Exception:
            return True

    def _ensure_desktop_access(self) -> None:
        """Ensure current thread desktop is attached to active input desktop."""
        if sys.platform == "win32" and self.user32:
            try:
                hdesk = self.user32.OpenInputDesktop(0, False, 0x01FF)
                if hdesk:
                    try:
                        self.user32.SetThreadDesktop(hdesk)
                    finally:
                        if hasattr(self.user32, "CloseDesktop"):
                            self.user32.CloseDesktop(hdesk)
            except Exception:
                pass

    def _find_main_process_pid(self) -> Optional[int]:
        """Fast process probe (wechat.exe / weixin.exe), shortest cmdline main process."""
        candidates: list[tuple[int, int]] = []
        for proc in self.psutil.process_iter(["pid", "name"]):
            try:
                name = proc.info.get("name") if hasattr(proc, "info") and isinstance(proc.info, dict) else proc.name()
                if name and name.lower() in ("wechat.exe", "weixin.exe"):
                    try:
                        cmdline = proc.cmdline() if hasattr(proc, "cmdline") else []
                    except Exception:
                        cmdline = []
                    cmdline_str = " ".join(cmdline).lower() if cmdline else ""
                    if "--type=" not in cmdline_str:
                        candidates.append((len(cmdline_str), proc.pid))
            except Exception:
                continue
        if not candidates:
            return None
        candidates.sort(key=lambda x: x[0])
        return candidates[0][1]

    def _find_main_window_hwnd(self, pid: Optional[int] = None) -> Optional[int]:
        """Window probe: WeChat 3.x (WeChatMainWndForPC) or WeChat 4.x Qt class/title."""
        if not self.win32gui:
            return None
        self._ensure_desktop_access()

        # 1. Try WeChat 3.x standard window class
        try:
            hwnd = self.win32gui.FindWindow("WeChatMainWndForPC", None)
            if hwnd and self.win32gui.IsWindow(hwnd):
                if pid is not None and self.win32process:
                    try:
                        _, win_pid = self.win32process.GetWindowThreadProcessId(hwnd)
                        if win_pid == pid:
                            return hwnd
                    except Exception:
                        pass
                elif pid is None:
                    return hwnd
        except Exception:
            pass

        # 2. Try WeChat 4.x Qt window enumeration
        candidates: list[int] = []

        def enum_cb(h: int, _extra: Any) -> None:
            if not self.win32gui.IsWindow(h):
                return
            match_pid = (pid is None)
            if pid is not None and self.win32process:
                try:
                    _, win_pid = self.win32process.GetWindowThreadProcessId(h)
                    match_pid = (win_pid == pid)
                except Exception:
                    match_pid = False
            if match_pid:
                try:
                    title = self.win32gui.GetWindowText(h)
                    cls = self.win32gui.GetClassName(h).lower()
                    if title in ("微信", "WeChat") or "qwindowicon" in cls or "wechat" in cls:
                        candidates.append(h)
                except Exception:
                    pass

        try:
            self.win32gui.EnumWindows(enum_cb, None)
        except Exception:
            pass

        return candidates[0] if candidates else None

    def _find_main_window(self, pid: Optional[int] = None) -> int:
        hwnd = self._find_main_window_hwnd(pid)
        return hwnd or 0

    def _check_window_locked(self, hwnd: int) -> bool:
        """Check if window title or child windows indicate locked state."""
        if not hwnd or not self.win32gui:
            return False
        try:
            title = self.win32gui.GetWindowText(hwnd) or ""
            if "已锁定" in title or "locked" in title.lower():
                return True
        except Exception:
            pass

        locked = False

        def child_cb(h: int, _extra: Any) -> None:
            nonlocal locked
            try:
                t = self.win32gui.GetWindowText(h) or ""
                if "已锁定" in t or "locked" in t.lower():
                    locked = True
            except Exception:
                pass

        try:
            self.win32gui.EnumChildWindows(hwnd, child_cb, None)
        except Exception:
            pass
        return locked

    def _is_locked(self, hwnd: int) -> bool:
        return self._check_window_locked(hwnd)

    def _is_window_hung(self, hwnd: int) -> bool:
        """Check if the WeChat window is frozen or hung (Let-it-fail)."""
        if sys.platform != "win32" or not self.user32 or not hwnd:
            return False
        try:
            return bool(self.user32.IsHungAppWindow(hwnd))
        except Exception:
            return False

    def _locate_input_box(self, hwnd: int, session_title: str) -> bool:
        """Check window hierarchy and verify that an editable input control is ready (Let-it-fail)."""
        if not hwnd or not self.win32gui:
            return False
        if not self.win32gui.IsWindow(hwnd):
            return False
        if self.win32gui.IsIconic(hwnd):
            return False

        found_input = False
        input_class_keywords = ("edit", "richedit", "chatedit", "mmedit", "textedit", "qlineedit")

        def enum_child_cb(child_hwnd: int, _extra: Any) -> None:
            nonlocal found_input
            if found_input:
                return
            try:
                if self.win32gui.IsWindow(child_hwnd):
                    cls_name = self.win32gui.GetClassName(child_hwnd).lower()
                    if any(kw in cls_name for kw in input_class_keywords):
                        found_input = True
            except Exception:
                pass

        try:
            self.win32gui.EnumChildWindows(hwnd, enum_child_cb, None)
        except Exception:
            return False

        return found_input

    def _activate_window(self, hwnd: int) -> None:
        """Restore window if minimized, bring to foreground, and strictly verify activation."""
        if not self.win32gui or not hwnd:
            raise WeChatWindowNotFoundError("无效的微信窗口句柄，无法激活")
        self._ensure_desktop_access()

        if self.win32gui.IsIconic(hwnd):
            self.win32gui.ShowWindow(hwnd, win32con.SW_RESTORE if self.win32con else 9)
            time.sleep(0.05)

        try:
            self.win32gui.SetForegroundWindow(hwnd)
        except Exception as exc:
            logger.warning("SetForegroundWindow failed for hwnd=%s: %s", hwnd, exc)
        time.sleep(0.05)

        fg_hwnd = self.win32gui.GetForegroundWindow()
        if fg_hwnd != hwnd:
            raise WeChatBridgeError(
                f"无法将微信窗口(hwnd={hwnd})激活至前台(当前前台hwnd={fg_hwnd})，消息发送中止",
                code="ACTIVATION_FAILED",
                status_code=500,
            )

    def _backup_clipboard(self) -> ClipboardBackup:
        """Read current CF_UNICODETEXT or format state with retry loop (Let-it-fail).

        Raises:
            WeChatClipboardLockedError: If clipboard cannot be opened after retries.
        """
        if not self.win32clipboard or not self.win32con:
            return ClipboardBackup(text=None, was_empty=True, has_non_text=False)

        last_exc: Optional[Exception] = None
        opened = False
        for _ in range(5):
            try:
                self.win32clipboard.OpenClipboard()
                opened = True
                break
            except Exception as exc:
                last_exc = exc
                time.sleep(0.02)

        if not opened:
            raise WeChatClipboardLockedError(
                f"无法访问系统剪贴板进行备份，剪贴板被其他应用锁定: {last_exc}"
            )

        try:
            # 1. Check Unicode text format
            if self.win32clipboard.IsClipboardFormatAvailable(self.win32con.CF_UNICODETEXT):
                text = self.win32clipboard.GetClipboardData(self.win32con.CF_UNICODETEXT)
                return ClipboardBackup(text=text, was_empty=False, has_non_text=False)

            # 2. Check non-text formats (images, files)
            has_non_text = False
            for fmt in (
                getattr(self.win32con, "CF_DIB", 8),
                getattr(self.win32con, "CF_BITMAP", 2),
                getattr(self.win32con, "CF_HDROP", 15),
            ):
                try:
                    if self.win32clipboard.IsClipboardFormatAvailable(fmt):
                        has_non_text = True
                        break
                except Exception:
                    pass

            if hasattr(self.win32clipboard, "CountClipboardFormats"):
                try:
                    if self.win32clipboard.CountClipboardFormats() > 0:
                        has_non_text = True
                except Exception:
                    pass

            if has_non_text:
                return ClipboardBackup(text=None, was_empty=False, has_non_text=True)

            return ClipboardBackup(text=None, was_empty=True, has_non_text=False)
        finally:
            self.win32clipboard.CloseClipboard()

    def _set_clipboard_text(self, text: str) -> None:
        """Write Unicode text to clipboard with bounded retry loop."""
        if not self.win32clipboard or not self.win32con:
            raise WeChatClipboardLockedError("系统剪贴板模块不可用")
        last_exc: Optional[Exception] = None
        for _ in range(5):
            try:
                self.win32clipboard.OpenClipboard()
                try:
                    self.win32clipboard.EmptyClipboard()
                    self.win32clipboard.SetClipboardData(self.win32con.CF_UNICODETEXT, text)
                    return
                finally:
                    self.win32clipboard.CloseClipboard()
            except Exception as exc:
                last_exc = exc
                time.sleep(0.02)
        raise WeChatClipboardLockedError(f"访问系统剪贴板超时或被拒绝: {last_exc}")

    def _restore_clipboard(self, backup: Optional[Union[ClipboardBackup, str]]) -> None:
        """Restore original text to clipboard with bounded retry loop (Let-it-fail).

        Raises:
            WeChatClipboardLockedError: If restoring fails after retries.
        """
        if not self.win32clipboard or not self.win32con:
            return

        text_to_restore: Optional[str] = None
        should_empty = False

        if isinstance(backup, ClipboardBackup):
            if backup.text is not None:
                text_to_restore = backup.text
                should_empty = True
            elif backup.was_empty:
                should_empty = True
            # If backup.has_non_text: should_empty is False, do NOT wipe user clipboard!
        elif isinstance(backup, str):
            text_to_restore = backup
            should_empty = True
        elif backup is None:
            # None passed without explicit empty confirmation: NEVER wipe out clipboard
            return

        if not should_empty and text_to_restore is None:
            return

        last_exc: Optional[Exception] = None
        restored = False
        for _ in range(5):
            try:
                self.win32clipboard.OpenClipboard()
                try:
                    self.win32clipboard.EmptyClipboard()
                    if text_to_restore is not None:
                        self.win32clipboard.SetClipboardData(self.win32con.CF_UNICODETEXT, text_to_restore)
                    restored = True
                    return
                finally:
                    self.win32clipboard.CloseClipboard()
            except Exception as exc:
                last_exc = exc
                time.sleep(0.02)

        if not restored:
            raise WeChatClipboardLockedError(
                f"无法恢复系统剪贴板，剪贴板被其他应用锁定: {last_exc}"
            )

    def _trigger_paste(self) -> None:
        """Send Ctrl + V keystroke to paste clipboard content."""
        if not self.win32api or not self.win32con:
            return
        try:
            self.win32api.keybd_event(self.win32con.VK_CONTROL, 0, 0, 0)
            time.sleep(0.01)
            try:
                self.win32api.keybd_event(ord("V"), 0, 0, 0)
                time.sleep(0.01)
            finally:
                self.win32api.keybd_event(ord("V"), 0, self.win32con.KEYEVENTF_KEYUP, 0)
        finally:
            self.win32api.keybd_event(self.win32con.VK_CONTROL, 0, self.win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.02)

    def _trigger_send_shortcut(self) -> None:
        """Send Alt + S shortcut to trigger message sending."""
        if not self.win32api or not self.win32con:
            return
        try:
            self.win32api.keybd_event(self.win32con.VK_MENU, 0, 0, 0)
            time.sleep(0.01)
            try:
                self.win32api.keybd_event(ord("S"), 0, 0, 0)
                time.sleep(0.01)
            finally:
                self.win32api.keybd_event(ord("S"), 0, self.win32con.KEYEVENTF_KEYUP, 0)
        finally:
            self.win32api.keybd_event(self.win32con.VK_MENU, 0, self.win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.02)

    def _switch_to_session(self, session_title: str) -> None:
        """Focus search box via Ctrl+F, paste target session_title, and press Enter to switch."""
        if not self.win32api or not self.win32con:
            return

        # 1. Focus search box: Ctrl + F
        try:
            self.win32api.keybd_event(self.win32con.VK_CONTROL, 0, 0, 0)
            time.sleep(0.01)
            try:
                self.win32api.keybd_event(ord("F"), 0, 0, 0)
                time.sleep(0.01)
            finally:
                self.win32api.keybd_event(ord("F"), 0, self.win32con.KEYEVENTF_KEYUP, 0)
        finally:
            self.win32api.keybd_event(self.win32con.VK_CONTROL, 0, self.win32con.KEYEVENTF_KEYUP, 0)

        time.sleep(0.02)

        # 2. Paste target session_title into search box
        self._set_clipboard_text(session_title)
        self._trigger_paste()
        time.sleep(0.03)

        # 3. Press Enter to select the target chat session
        try:
            self.win32api.keybd_event(self.win32con.VK_RETURN, 0, 0, 0)
            time.sleep(0.01)
        finally:
            self.win32api.keybd_event(self.win32con.VK_RETURN, 0, self.win32con.KEYEVENTF_KEYUP, 0)

        time.sleep(0.05)

    def probe_status(self) -> WeChatStatus:
        """Probe WeChat process and main window status (Let-it-fail)."""
        if self._is_workstation_locked():
            pid = self._find_main_process_pid()
            hwnd = self._find_main_window_hwnd(pid) if pid else None
            return WeChatStatus(
                running=bool(pid),
                pid=pid,
                window_found=bool(hwnd and self.win32gui and self.win32gui.IsWindow(hwnd)),
                hwnd=hwnd,
                locked=True,
            )

        pid = self._find_main_process_pid()
        if not pid:
            return WeChatStatus(running=False, pid=None, window_found=False, hwnd=None, locked=False)

        hwnd = self._find_main_window_hwnd(pid)
        if not hwnd or not (self.win32gui and self.win32gui.IsWindow(hwnd)):
            return WeChatStatus(running=True, pid=pid, window_found=False, hwnd=None, locked=False)

        locked = self._check_window_locked(hwnd)
        return WeChatStatus(running=True, pid=pid, window_found=True, hwnd=hwnd, locked=locked)

    async def send_message(self, session_title: str, content: str) -> SendReceipt:
        """
        Send text message to target WeChat session:
        1. Entry validation & fail-fast
        2. Anti-flood rate limiting
        3. Single-flight lock acquisition
        4. Workstation / desktop lock verification
        5. WeChat process & window probe
        6. Client lock & hung verification
        7. Window activation & foreground verification
        8. Atomic clipboard backup, session switch navigation, input box check, text injection, paste, Alt+S trigger, and restoration
        9. Return SendReceipt with execution timing
        """
        # 1. Centralized Entry Validation (Fail-Fast)
        session = str(session_title or "").strip()
        if not session:
            raise WeChatSessionNotFoundError("会话名称不能为空")
        if content is None or not str(content).strip():
            raise WeChatBridgeError("发送消息内容不能为空", code="INVALID_PAYLOAD", status_code=400)

        # 2. Rate Limiting (Fails fast before lock)
        self.rate_limiter.check_and_record(session, content)

        # 3. Concurrency Serialization
        t_start = time.perf_counter()
        async with self._get_lock():
            # 4. Check workstation / desktop lock
            if self._is_workstation_locked():
                self.rate_limiter.rollback_message(session, content)
                raise WeChatLockedError("Windows桌面处于锁屏状态，无法投递按键与消息")

            # 5. Check process
            pid = self._find_main_process_pid()
            if not pid:
                self.rate_limiter.rollback_message(session, content)
                raise WeChatProcessNotFoundError()

            # 6. Check window
            hwnd = self._find_main_window_hwnd(pid)
            if not hwnd or not (self.win32gui and self.win32gui.IsWindow(hwnd)):
                self.rate_limiter.rollback_message(session, content)
                raise WeChatWindowNotFoundError()

            # 7. Check locked window ("微信已锁定")
            if self._check_window_locked(hwnd):
                self.rate_limiter.rollback_message(session, content)
                raise WeChatLockedError("微信客户端处于锁定状态，请在电脑端解锁微信后重试")

            # 8. Check hung window
            if self._is_window_hung(hwnd):
                self.rate_limiter.rollback_message(session, content)
                raise WeChatSendTimeoutError("微信主窗口无响应，发送超时")

            # 9. Activate window & verify foreground
            try:
                self._activate_window(hwnd)
            except WeChatBridgeError:
                self.rate_limiter.rollback_message(session, content)
                raise

            # 10. Atomic clipboard backup, session switch, input check, injection, and send
            backup = self._backup_clipboard()
            try:
                # Switch to session
                self._switch_to_session(session)

                # Locate input box
                if not self._locate_input_box(hwnd, session):
                    raise WeChatInputBoxNotFoundError()

                # Paste content and send
                self._set_clipboard_text(content)
                self._trigger_paste()
                self._trigger_send_shortcut()
            except (WeChatBridgeError, Exception):
                self.rate_limiter.rollback_message(session, content)
                raise
            finally:
                self._restore_clipboard(backup)

        duration_ms = round((time.perf_counter() - t_start) * 1000.0, 2)
        return SendReceipt(
            success=True,
            session_title=session,
            content_length=len(content),
            duration_ms=duration_ms,
            timestamp=time.time(),
        )
