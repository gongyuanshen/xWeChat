"""
src/wechat_decrypt_tool/routers/chat_send.py
============================================
FastAPI Router for WeChat message sending, status probing, and AI reply suggestion.
Adheres strictly to Debug-First Policy (no silent fallbacks, Let-it-Fail, fail-fast).
"""
from __future__ import annotations

from datetime import datetime
import time
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.routing import APIRoute
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field, field_validator

from ..ai.messages import read_messages
from ..ai.model_selection import SelectedModel, selected_model
from ..ai.providers import ProviderFailure
from ..ai.service import AIService, get_ai_service
from ..logging_config import get_logger
from ..wechat_ui_bridge import (
    FileSendReceipt,
    SendReceipt,
    WeChatBridge,
    WeChatStatus,
)

logger = get_logger(__name__)

router = APIRouter(route_class=APIRoute)


# ---------------------------------------------------------------------------
# Request & Response Schemas
# ---------------------------------------------------------------------------
class SendChatRequest(BaseModel):
    account: str = Field(..., min_length=1, description="当前登录微信账号/目录名")
    username: str = Field(..., min_length=1, description="目标联系人或群聊 username (如 wxid_xxx 或 xxx@chatroom)")
    display_name: Optional[str] = Field(None, description="目标联系人或群聊展示名称 (优先作为会话搜索标题)")
    content: str = Field(..., min_length=1, description="待发送的消息正文")

    @field_validator("account", "username", "content")
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        raw = v.replace("\\r", " ").replace("\\n", " ").replace("\\t", " ").strip()
        if not raw:
            raise ValueError("字段不能为空或纯空白字符")
        return v


class SendChatResponse(BaseModel):
    success: bool = True
    session: str
    content_length: int
    duration_ms: float
    timestamp: float


class SendImageRequest(BaseModel):
    account: str = Field(..., min_length=1, description="当前登录微信账号/目录名")
    username: str = Field(..., min_length=1, description="目标联系人或群聊 username")
    display_name: Optional[str] = Field(None, description="目标展示名称，优先作为会话搜索标题")
    image_path: str = Field(..., min_length=1, description="单张本地 JPG/JPEG/PNG 图片的绝对路径")

    @field_validator("account", "username", "image_path")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("字段不能为空或纯空白字符")
        return value


class SendImageResponse(BaseModel):
    success: bool
    session: str
    image_name: str
    image_format: Literal["JPEG", "PNG"]
    image_size_bytes: int
    duration_ms: float
    timestamp: float
    confirmation: Literal["local_outgoing_image"]
    server_id: str = Field(..., pattern=r"^[1-9][0-9]*$")
    match_kind: Literal["exact_bytes", "exact_rgba"]
    generation: str


class SendFileRequest(BaseModel):
    account: str = Field(..., min_length=1, description="当前登录微信账号/目录名")
    username: str = Field(..., min_length=1, description="目标联系人或群聊 username")
    display_name: Optional[str] = Field(None, description="目标展示名称，优先作为会话搜索标题")
    file_path: str = Field(..., min_length=1, description="单个本地普通文件的绝对路径；JPG/JPEG/PNG 使用图片接口")

    @field_validator("account", "username", "file_path")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("字段不能为空或纯空白字符")
        return value


class SendFileResponse(BaseModel):
    success: bool
    session: str
    file_name: str
    file_size_bytes: int
    duration_ms: float
    timestamp: float


class WeChatStatusResponse(BaseModel):
    running: bool
    pid: Optional[int] = None
    window_found: bool
    hwnd: Optional[int] = None
    locked: bool


class SuggestReplyRequest(BaseModel):
    account: str = Field(..., min_length=1, description="微信账号标识")
    username: str = Field(..., min_length=1, description="联系人或群聊 username")
    display_name: Optional[str] = Field(None, description="联系人或群聊展示名")
    count: int = Field(default=10, ge=1, le=20, description="读取最近消息数量上下文 (1-20)")
    selected_model: Optional[SelectedModel] = Field(None, description="点击建议时的顶部 AI 模型选择；未传时使用已保存的选择")

    @field_validator("account", "username")
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("字段不能为空或纯空白字符")
        return v


class SuggestReplyResponse(BaseModel):
    suggestion: str
    context_count: int
    model_used: str


# ---------------------------------------------------------------------------
# Bridge Dependency
# ---------------------------------------------------------------------------
_wechat_bridge: Optional[WeChatBridge] = None


def get_wechat_bridge() -> WeChatBridge:
    """Retrieve shared WeChatBridge instance."""
    global _wechat_bridge
    if _wechat_bridge is None:
        _wechat_bridge = WeChatBridge()
    return _wechat_bridge


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.post("/chat/send", response_model=SendChatResponse, summary="向指定微信会话发送消息")
async def send_chat_message(
    req: SendChatRequest,
    bridge: WeChatBridge = Depends(get_wechat_bridge),
) -> SendChatResponse:
    """
    Send text message to target WeChat session:
    - Session target is display_name.strip() if present and non-empty, otherwise username.strip().
    - Invokes bridge.send_message(session_title, content).
    - Let-It-Fail: All WeChatBridgeErrors propagate to global exception handler.
    """
    session_title = (
        req.display_name.strip()
        if req.display_name and req.display_name.strip()
        else req.username.strip()
    )
    receipt: SendReceipt = await bridge.send_message(session_title=session_title, content=req.content)
    return SendChatResponse(
        success=receipt.success,
        session=receipt.session_title,
        content_length=receipt.content_length,
        duration_ms=receipt.duration_ms,
        timestamp=receipt.timestamp,
    )


@router.post("/chat/send/image", response_model=SendImageResponse, summary="向指定微信会话发送单张本地图片")
async def send_chat_image(
    req: SendImageRequest,
    bridge: WeChatBridge = Depends(get_wechat_bridge),
) -> SendImageResponse:
    """Confirm an exact new local outgoing image, retaining uncertainty on failure."""
    session_title = (
        req.display_name.strip()
        if req.display_name and req.display_name.strip()
        else req.username.strip()
    )
    receipt = await bridge.send_image(session_title=session_title, image_path=req.image_path,
                                      account=req.account, username=req.username)
    return SendImageResponse(success=receipt.success, session=receipt.session_title,
        image_name=receipt.image_name, image_format=receipt.image_format,
        image_size_bytes=receipt.image_size_bytes, duration_ms=receipt.duration_ms, timestamp=receipt.timestamp,
        confirmation="local_outgoing_image", server_id=receipt.server_id,
        match_kind=receipt.match_kind, generation=receipt.generation)


@router.post("/chat/send/file", response_model=SendFileResponse, summary="向指定微信会话发送单个本地文件")
async def send_chat_file(
    req: SendFileRequest,
    bridge: WeChatBridge = Depends(get_wechat_bridge),
) -> SendFileResponse:
    """The bridge validates the file; success confirms local submission only."""
    session_title = (
        req.display_name.strip()
        if req.display_name and req.display_name.strip()
        else req.username.strip()
    )
    receipt: FileSendReceipt = await bridge.send_file(session_title=session_title, file_path=req.file_path)
    return SendFileResponse(
        success=receipt.success, session=receipt.session_title,
        file_name=receipt.file_name, file_size_bytes=receipt.file_size_bytes,
        duration_ms=receipt.duration_ms, timestamp=receipt.timestamp,
    )


@router.get("/chat/send/status", response_model=WeChatStatusResponse, summary="探测微信客户端及窗口状态")
@router.get("/chat/status", response_model=WeChatStatusResponse, include_in_schema=False)
async def get_send_status(
    bridge: WeChatBridge = Depends(get_wechat_bridge),
) -> WeChatStatusResponse:
    """
    Probe WeChat process, main window, and workstation locked status.
    """
    status_info: WeChatStatus = bridge.probe_status()
    return WeChatStatusResponse(
        running=status_info.running,
        pid=status_info.pid,
        window_found=status_info.window_found,
        hwnd=status_info.hwnd,
        locked=status_info.locked,
    )


@router.post("/chat/suggest_reply", response_model=SuggestReplyResponse, summary="基于会话最近上下文生成智能回复建议")
async def suggest_chat_reply(
    req: SuggestReplyRequest,
    service: AIService = Depends(get_ai_service),
) -> SuggestReplyResponse:
    """
    Generate an AI reply suggestion based on recent chat history:
    1. Read recent messages via read_messages.
    2. Fail-fast with HTTP 400 if history is empty.
    3. Resolve the same selected model as the AI conversation; fail-fast if unavailable.
    4. Format multi-turn conversation transcript with sender differentiation.
    5. Invoke LLM client with concise Chinese conversational instructions.
    6. Return suggestion draft, context count, and model used.
    """
    now_ts = int(time.time())
    try:
        raw_result = read_messages(
            account=req.account,
            username=req.username,
            start=0,
            end=now_ts,
            count=req.count,
        )
    except Exception as exc:
        logger.error("Failed to read chat messages for suggest_reply: %s", exc)
        raise HTTPException(
            status_code=500,
            detail={"code": "CHAT_HISTORY_READ_FAILED", "message": f"读取会话历史记录失败: {str(exc)}"},
        ) from exc

    if isinstance(raw_result, dict):
        messages = raw_result.get("messages", [])
    elif isinstance(raw_result, list):
        messages = raw_result
    else:
        messages = []

    # Fail-fast on empty history
    if not messages:
        raise HTTPException(
            status_code=400,
            detail={"code": "NO_CHAT_HISTORY", "message": "该会话暂无历史消息，无法生成回复建议"},
        )

    # Use the global AI conversation selection, including its native reasoning settings.
    try:
        choice = req.selected_model.model_dump() if req.selected_model is not None else selected_model(service.store)
        if not choice.get("profile_id"):
            raise ProviderFailure("未选择可用的 AI 模型，请在顶部 AI 中选择模型，或前往设置 → AI 服务配置")
        profile = service.models.resolve_turn(
            choice["profile_id"], choice.get("model_id", ""), choice.get("reasoning_effort"),
            choice.get("thinking_mode"), choice.get("thinking_budget"),
        )
        if not profile or not profile.get("model"):
            raise ProviderFailure("所选 AI 模型配置缺少模型名称，请前往设置 → AI 服务检查配置")
    except ProviderFailure as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "AI_MODEL_NOT_CONFIGURED", "message": str(exc)},
        ) from exc
    except Exception as exc:
        logger.exception("Failed to resolve AI model for suggest_reply: account=%s username=%s", req.account, req.username)
        raise HTTPException(
            status_code=500,
            detail={"code": "AI_MODEL_RESOLVE_FAILED", "message": "读取 AI 模型配置失败，请查看后端日志"},
        ) from exc

    # Build chat transcript
    transcript_lines: list[str] = []
    peer_name = (
        req.display_name.strip()
        if req.display_name and req.display_name.strip()
        else req.username.strip()
    )

    for m in messages:
        media = m.get("media") if isinstance(m.get("media"), dict) else {}
        is_sent = m.get("isSent")
        if is_sent is None:
            is_sent = media.get("isSent", False)

        if is_sent:
            sender = "我"
        else:
            sender = m.get("sender") or peer_name

        text = m.get("text") or media.get("content") or ""
        if not text and m.get("kind"):
            text = f"[{m['kind']}]"

        msg_time = m.get("time")
        if msg_time:
            try:
                time_str = datetime.fromtimestamp(msg_time).strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                time_str = str(msg_time)
            transcript_lines.append(f"[{time_str}] {sender}: {text}")
        else:
            transcript_lines.append(f"{sender}: {text}")

    transcript = "\n".join(transcript_lines)

    # Format prompt
    system_prompt = (
        "你是一个微信聊天助手。请根据提供的最近聊天记录，以“我”的口吻生成一条简短、自然、得体、贴切的回复草稿。\n"
        "要求：\n"
        "1. 直接输出回复内容本身，不要带有任何多余的寒暄、解释、问候前缀或引号。\n"
        "2. 符合中文即时聊天口语习惯，语气亲切自然，符合上下文语境。\n"
        "3. 保持简练，通常在1-3句话以内。"
    )
    user_prompt = f"以下是与【{peer_name}】的最近聊天记录：\n\n{transcript}\n\n请直接生成回复草稿："

    # Invoke LLM client
    try:
        client = service.models.client(profile)
        response = await client.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ])
    except Exception as exc:
        logger.exception("AI client inference failed: %s", exc)
        raise HTTPException(
            status_code=502,
            detail={"code": "AI_UPSTREAM_ERROR", "message": f"AI 服务调用失败: {str(exc)}"},
        ) from exc

    # Extract response text
    if hasattr(response, "content"):
        response_text = response.content
        if isinstance(response_text, list):
            response_text = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in response_text
            )
        else:
            response_text = str(response_text)
    else:
        response_text = str(response)

    suggestion = response_text.strip()
    if (suggestion.startswith('"') and suggestion.endswith('"')) or (
        suggestion.startswith("“") and suggestion.endswith("”")
    ):
        suggestion = suggestion[1:-1].strip()

    return SuggestReplyResponse(
        suggestion=suggestion,
        context_count=len(messages),
        model_used=str(profile.get("model") or ""),
    )
