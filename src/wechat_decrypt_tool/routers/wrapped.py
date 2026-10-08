from __future__ import annotations

import json
import sqlite3
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Path, Query

from ..path_fix import PathFixRoute
from ..account_workers import account_to_thread
from ..chat_helpers import _resolve_account_dir
from ..wrapped.service import build_wrapped_annual_card, build_wrapped_annual_meta, build_wrapped_annual_response
from ..wrapped import WrappedIdentityError
from ..wrapped.detail import WrappedDetailInputError, WrappedIndexError, build_wrapped_annual_detail

router = APIRouter(route_class=PathFixRoute)


@router.get("/api/wrapped/annual/detail", summary="回声异境年度总结 - 本地消息证据")
async def wrapped_annual_detail(
    account: str = Query(..., min_length=1),
    year: int = Query(..., ge=1970, le=9998),
    kind: Literal["day", "hour", "phrase", "contact", "night", "emoji"] = Query(...),
    value: str = Query(..., min_length=1, max_length=512),
    period: Literal["all", "weekday", "weekend"] = Query("all"),
    month: Optional[int] = Query(None, ge=1, le=12),
    offset: int = Query(0, ge=0),
    limit: int = Query(40, ge=1, le=100),
    refresh: bool = Query(False, description="用户主动重试已失败的索引构建。"),
):
    account_dir = _resolve_account_dir(account)
    try:
        return await account_to_thread(
            account_dir, build_wrapped_annual_detail, account=account_dir.name, year=year,
            kind=kind, value=value, period=period, month=month, offset=offset, limit=limit, refresh=refresh,
        )
    except WrappedDetailInputError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except WrappedIdentityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except WrappedIndexError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (sqlite3.DatabaseError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"年度详情数据读取失败：{exc}") from exc


@router.get("/api/wrapped/annual", summary="xwechat 年度总结 - 后端数据")
async def wrapped_annual(
    year: Optional[int] = Query(None, description="年份（例如 2026）。默认当前年份。"),
    account: Optional[str] = Query(None, description="解密后的账号目录名。默认取第一个可用账号。"),
    refresh: bool = Query(False, description="是否强制重新计算（忽略缓存）。"),
):
    """返回年度总结完整数据（一次性包含全部卡片，可能较慢）。"""

    # This endpoint performs blocking sqlite/file IO, so run it in a worker thread.
    account_dir = _resolve_account_dir(account)
    try:
        return await account_to_thread(account_dir, build_wrapped_annual_response,
                                       account=account_dir.name, year=year, refresh=refresh)
    except WrappedIdentityError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except WrappedIndexError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/api/wrapped/annual/meta", summary="xwechat 年度总结 - 目录（轻量）")
async def wrapped_annual_meta(
    year: Optional[int] = Query(None, description="年份（例如 2026）。默认当前年份。"),
    account: Optional[str] = Query(None, description="解密后的账号目录名。默认取第一个可用账号。"),
    refresh: bool = Query(False, description="是否强制重新计算（忽略缓存）。"),
):
    """返回年度总结的目录/元信息，用于前端懒加载每一页。"""

    account_dir = _resolve_account_dir(account)
    return await account_to_thread(account_dir, build_wrapped_annual_meta,
                                   account=account_dir.name, year=year, refresh=refresh)


@router.get("/api/wrapped/annual/cards/{card_id}", summary="xwechat 年度总结 - 单张卡片（按页加载）")
async def wrapped_annual_card(
    card_id: int = Path(..., description="卡片ID（与前端页面一一对应）", ge=0),
    year: Optional[int] = Query(None, description="年份（例如 2026）。默认当前年份。"),
    account: Optional[str] = Query(None, description="解密后的账号目录名。默认取第一个可用账号。"),
    refresh: bool = Query(False, description="是否强制重新计算（忽略缓存）。"),
):
    """按卡片 ID 返回单页数据（避免首屏一次性计算全部卡片）。"""

    account_dir = _resolve_account_dir(account)
    try:
        return await account_to_thread(
            account_dir,
            build_wrapped_annual_card,
            account=account_dir.name,
            year=year,
            card_id=card_id,
            refresh=refresh,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except WrappedIdentityError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except WrappedIndexError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
