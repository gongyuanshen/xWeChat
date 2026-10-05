from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from ..snapshot_registry import begin_legacy_database_write
from ..app_paths import get_output_databases_dir, get_output_dir

from ..logging_config import get_logger
from ..path_fix import PathFixRoute
from ..key_store import upsert_account_keys_in_store
from ..wechat_decrypt import (
    WeChatDatabaseDecryptor,
    build_decrypt_summary_message,
    decrypt_wechat_databases,
    scan_account_databases_from_path,
)

logger = get_logger(__name__)

router = APIRouter(route_class=PathFixRoute)


_DEFERRED_DECRYPT_CLEANUPS: set[asyncio.Task[None]] = set()


def _normalize_decrypt_guard_accounts(accounts: Any) -> list[str]:
    if not accounts:
        return []

    out: list[str] = []
    seen: set[str] = set()
    for account in accounts:
        key = str(account or "").strip()
        if (not key) or (key in seen):
            continue
        seen.add(key)
        out.append(key)
    out.sort()
    return out


def _resolve_decrypt_guard_accounts(db_storage_path: str) -> list[str]:
    try:
        scan_result = scan_account_databases_from_path(db_storage_path)
    except Exception:
        logger.exception("[decrypt] pre-scan accounts failed db_storage_path=%s", db_storage_path)
        return []

    if scan_result.get("status") == "error":
        return []

    return _normalize_decrypt_guard_accounts((scan_result.get("account_databases") or {}).keys())


def _release_decrypt_account_guards(guards: list[tuple[str, Any]], *, reason: str) -> None:
    for account, lease in reversed(list(guards or [])):
        lease.release()


async def _release_decrypt_guards_after_worker(
    worker_task: asyncio.Task,
    guards: list[tuple[str, Any]],
) -> None:
    try:
        try:
            await asyncio.shield(worker_task)
        except asyncio.CancelledError:
            raise
        except BaseException:
            # The disconnected client no longer needs the worker result. The
            # guard still must remain held until the underlying worker stops.
            pass

        if guards:
            await asyncio.to_thread(
                _release_decrypt_account_guards,
                guards,
                reason="decrypt:sse-disconnected",
            )
    except asyncio.CancelledError:
        raise
    except BaseException:
        logger.exception("[decrypt] deferred SSE guard cleanup failed")


async def _release_decrypt_guards_after_acquire(
    acquire_task: asyncio.Task[list[tuple[str, Any]]],
) -> None:
    try:
        try:
            guards = await asyncio.shield(acquire_task)
        except asyncio.CancelledError:
            raise
        except BaseException:
            logger.exception("[decrypt] deferred SSE guard acquisition failed")
            return

        if guards:
            await asyncio.to_thread(
                _release_decrypt_account_guards,
                guards,
                reason="decrypt:sse-disconnected",
            )
    except asyncio.CancelledError:
        raise
    except BaseException:
        logger.exception("[decrypt] deferred SSE acquired guard cleanup failed")


def _track_deferred_decrypt_cleanup(cleanup_task: asyncio.Task[None]) -> None:
    _DEFERRED_DECRYPT_CLEANUPS.add(cleanup_task)
    cleanup_task.add_done_callback(_DEFERRED_DECRYPT_CLEANUPS.discard)


def _defer_decrypt_guard_cleanup(
    worker_task: asyncio.Task,
    guards: list[tuple[str, Any]],
) -> None:
    cleanup_task = asyncio.create_task(_release_decrypt_guards_after_worker(worker_task, guards))
    _track_deferred_decrypt_cleanup(cleanup_task)


def _defer_decrypt_guard_acquire_cleanup(
    acquire_task: asyncio.Task[list[tuple[str, Any]]],
) -> None:
    cleanup_task = asyncio.create_task(_release_decrypt_guards_after_acquire(acquire_task))
    _track_deferred_decrypt_cleanup(cleanup_task)


def _acquire_decrypt_account_guards(accounts: Any, *, reason: str) -> list[tuple[str, Any]]:
    guards: list[tuple[str, Any]] = []
    try:
        for account in _normalize_decrypt_guard_accounts(accounts):
            lease = begin_legacy_database_write(get_output_databases_dir() / account)
            guards.append((account, lease))
    except Exception:
        _release_decrypt_account_guards(guards, reason=reason)
        raise
    return guards


class _DbKeyPersistenceRejected(ValueError):
    pass


def _database_diagnostic_role(diagnostic: dict[str, Any]) -> str:
    name = str(diagnostic.get("db_name") or "").strip().lower()
    if not name:
        name = Path(str(diagnostic.get("db_path") or "")).name.lower()
    if name in {"session.db", "sessiondata.db"}:
        return "session"
    if re.fullmatch(r"message(?:_\d+)?\.db", name) or re.fullmatch(r"msg\d*\.db", name):
        return "message"
    if name == "micromsg.db":
        return "combined"
    return "other"


def _database_diagnostic_verified(diagnostic: dict[str, Any]) -> bool:
    return bool(
        not bool(diagnostic.get("copied_as_sqlite"))
        and str(diagnostic.get("key_mode") or "").strip()
        in {"raw_enc_key", "sqlcipher_passphrase"}
        # Key authentication is independent of WAL/page/index integrity.
        # Retain compatibility with results produced before key_authenticated.
        and (diagnostic.get("key_authenticated") is True or (
            "key_authenticated" not in diagnostic
            and diagnostic.get("success") is True
            and int(diagnostic.get("failed_pages") or 0) == 0
            and str(diagnostic.get("diagnostic_status") or "").strip() == "ok"
        ))
    )


def _db_key_persistence_rejection(account_result: dict[str, Any]) -> str:
    diagnostics_value = account_result.get("db_diagnostics")
    if not isinstance(diagnostics_value, dict) or not diagnostics_value:
        return "missing per-database key verification evidence"

    diagnostics = [
        dict(value)
        for value in diagnostics_value.values()
        if isinstance(value, dict)
    ]
    verified = [item for item in diagnostics if _database_diagnostic_verified(item)]
    role_presence = {
        role
        for role in (_database_diagnostic_role(item) for item in diagnostics)
        if role != "other"
    }
    verified_roles = {
        role
        for role in (_database_diagnostic_role(item) for item in verified)
        if role != "other"
    }

    # Current WeChat 4.x splits account data between session.db and one or
    # more message_N.db files.  A raw encryption key captured from the later
    # two-iteration HMAC KDF can validate exactly one database, so accepting
    # any-success here silently replaces the reusable account passphrase and
    # makes subsequent account database decryption fail.
    if "session" in role_presence or "message" in role_presence:
        missing = [role for role in ("session", "message") if role not in verified_roles]
        if missing:
            return "required account databases did not verify: " + ",".join(missing)
        return ""

    # Older layouts may keep both roles in MicroMsg.db.  It still must have
    # passed encrypted page-1 verification; a plaintext copy proves no key.
    if "combined" in verified_roles:
        return ""

    # Unknown split layouts need corroboration from at least two encrypted
    # databases before a durable key is allowed to replace the previous one.
    if len(verified) < 2:
        return "database key was verified by fewer than two encrypted databases"
    return ""


def _save_db_key_for_account(account: str, key: str, account_result: dict[str, Any] | None) -> bool:
    payload = dict(account_result or {})
    success_count = int(payload.get("success") or 0)
    if success_count <= 0:
        logger.info("[decrypt] skip saving db key for failed account=%s success=%s", account, success_count)
        return False

    rejection = _db_key_persistence_rejection(payload)
    if rejection:
        raise _DbKeyPersistenceRejected(rejection)

    source_wxid_dir = str(payload.get("source_wxid_dir") or "").strip()
    source_db_storage_path = str(payload.get("source_db_storage_path") or "").strip()
    aliases: list[str] = []

    if source_wxid_dir:
        wxid_dir_name = str(Path(source_wxid_dir).name or "").strip()
        if wxid_dir_name and wxid_dir_name != str(account or "").strip():
            aliases.append(wxid_dir_name)

    upsert_account_keys_in_store(
        str(account),
        db_key=key,
        aliases=aliases,
        db_key_source_wxid_dir=source_wxid_dir or None,
        db_key_source_db_storage_path=source_db_storage_path or None,
        raise_on_write_error=True,
    )
    logger.info("[decrypt] saved independently verified db key account=%s", account)
    return True


def _persist_db_keys(
    account_results: dict[str, Any] | None,
    key: str,
) -> tuple[bool, list[str]]:
    attempted = False
    failed_accounts: list[str] = []

    for account_name, account_result in (account_results or {}).items():
        account = str(account_name)
        try:
            attempted = _save_db_key_for_account(account, key, account_result) or attempted
        except _DbKeyPersistenceRejected as exc:
            attempted = True
            failed_accounts.append(account)
            logger.warning(
                "[decrypt] rejected db key persistence account=%s reason=%s",
                account,
                str(exc),
            )
        except Exception:
            attempted = True
            failed_accounts.append(account)
            logger.exception("[decrypt] failed to persist db key account=%s", account)

    return attempted and not failed_accounts, failed_accounts


class DecryptRequest(BaseModel):
    """解密请求模型"""

    key: str = Field(..., description="解密密钥，64位十六进制字符串")
    db_storage_path: str = Field(..., description="数据库存储路径，必须是绝对路径")


@router.post("/api/decrypt/snapshot", summary="构建独立验证快照，不替换当前账号")
async def build_database_snapshot(request: DecryptRequest):
    from ..independent_snapshot import SnapshotBuildError, build_verified_snapshot
    from ..snapshot_registry import begin_account_work
    from ..wechat_decrypt import _derive_account_name_from_path

    if re.fullmatch(r"[0-9a-fA-F]{64}", request.key) is None:
        raise HTTPException(status_code=400, detail="密钥必须是64位十六进制字符串")
    source = Path(request.db_storage_path)
    if not source.is_absolute() or source.name.lower() != "db_storage":
        raise HTTPException(status_code=400, detail="必须指定完整的绝对 db_storage 路径")
    lease = begin_account_work(get_output_databases_dir() / _derive_account_name_from_path(source))
    worker = asyncio.create_task(asyncio.to_thread(
        build_verified_snapshot, source, request.key, get_output_dir() / "verified_snapshots",
    ))
    def finished(task):
        lease.release()
        if not task.cancelled() and task.exception() is not None:
            error = task.exception()
            logger.error("Independent snapshot worker failed: %s", error,
                         exc_info=(type(error), error, error.__traceback__))
    worker.add_done_callback(finished)
    _track_deferred_decrypt_cleanup(worker)
    try:
        # A disconnected request cannot cancel the real thread or its lease.
        return await asyncio.shield(worker)
    except SnapshotBuildError as exc:
        status_code = {"validation": 400, "source_changed": 409, "decrypt": 422}.get(exc.stage, 500)
        raise HTTPException(status_code=status_code, detail={
            "code": "snapshot_build_failed", "stage": exc.stage, "message": str(exc),
        }) from exc


@router.post("/api/decrypt", summary="解密微信数据库")
async def decrypt_databases(request: DecryptRequest):
    """使用提供的密钥解密指定账户的微信数据库

    参数:
    - key: 解密密钥（必选）- 64位十六进制字符串
    - db_storage_path: 数据库存储路径（必选），如 D:\\wechatMSG\\xwechat_files\\{微信id}\\db_storage

    注意：
    - 一个密钥只能解密对应账户的数据库
    - 必须提供具体的db_storage_path，不支持自动检测多账户
    - 支持自动处理Windows路径中的反斜杠转义问题
    """
    logger.info(f"开始解密请求: db_storage_path={request.db_storage_path}")
    try:
        # 验证密钥格式
        if not request.key or len(request.key) != 64:
            logger.warning(f"密钥格式无效: 长度={len(request.key) if request.key else 0}")
            raise HTTPException(status_code=400, detail="密钥格式无效，必须是64位十六进制字符串")

        guard_accounts = _resolve_decrypt_guard_accounts(request.db_storage_path)
        guards = _acquire_decrypt_account_guards(guard_accounts, reason="decrypt:post")
        try:
            # 使用新的解密API
            results = decrypt_wechat_databases(
                db_storage_path=request.db_storage_path,
                key=request.key,
            )
        finally:
            _release_decrypt_account_guards(guards, reason="decrypt:post")

        if results["status"] == "error":
            logger.error(f"解密失败: {results['message']}")
            raise HTTPException(status_code=400, detail=results["message"])

        logger.info(f"解密完成: 成功 {results['successful_count']}/{results['total_databases']} 个数据库")
        if int(results.get("diagnostic_warning_count") or 0) > 0:
            logger.warning(
                "解密完成但检测到诊断告警: warning_dbs=%s total=%s",
                int(results.get("diagnostic_warning_count") or 0),
                int(results.get("total_databases") or 0),
            )

        # 成功解密后，按账号保存数据库密钥（用于前端自动回填及实时消息）。
        db_key_persisted, db_key_persistence_errors = _persist_db_keys(
            results.get("account_results"),
            request.key,
        )

        return {
            "status": "completed" if results["status"] == "success" else "failed",
            "total_databases": results["total_databases"],
            "success_count": results["successful_count"],
            "failure_count": results["failed_count"],
            "output_directory": results["output_directory"],
            "message": results["message"],
            "processed_files": results["processed_files"],
            "failed_files": results["failed_files"],
            "account_results": results.get("account_results", {}),
            "diagnostic_warning_count": int(results.get("diagnostic_warning_count") or 0),
            "db_key_persisted": db_key_persisted,
            "db_key_persistence_errors": db_key_persistence_errors,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"解密API异常: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/decrypt_stream", summary="解密微信数据库（SSE实时进度）")
async def decrypt_databases_stream(
    request: Request,
    key: str | None = None,
    db_storage_path: str | None = None,
):
    """通过SSE实时推送数据库解密进度。

    注意：EventSource 只支持 GET，因此参数通过 querystring 传递。
    """

    def _sse(payload: dict) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    async def generate_progress():
        # 1) Basic validation (keep 200 + SSE error event, avoid 422 breaking EventSource).
        k = str(key or "").strip()
        p = str(db_storage_path or "").strip()

        if not k or len(k) != 64:
            yield _sse({"type": "error", "message": "密钥格式无效，必须是64位十六进制字符串"})
            return

        try:
            bytes.fromhex(k)
        except Exception:
            yield _sse({"type": "error", "message": "密钥必须是有效的十六进制字符串"})
            return

        if not p:
            yield _sse({"type": "error", "message": "请提供 db_storage_path 参数"})
            return

        storage_path = Path(p)
        if not storage_path.exists():
            yield _sse({"type": "error", "message": f"指定的数据库路径不存在: {p}"})
            return

        # 2) Scan databases.
        yield _sse({"type": "scanning", "message": "正在扫描数据库文件..."})
        await asyncio.sleep(0)

        scan_result = scan_account_databases_from_path(p)
        if scan_result["status"] == "error":
            payload = {"type": "error", "message": scan_result["message"]}
            detected_accounts = scan_result.get("detected_accounts") or []
            if detected_accounts:
                payload["detected_accounts"] = detected_accounts
            yield _sse(payload)
            return

        account_databases = scan_result.get("account_databases", {})
        account_sources = scan_result.get("account_sources", {})
        total_databases = sum(len(dbs) for dbs in account_databases.values())

        decrypt_guards: list[tuple[str, Any]] = []
        guard_acquire_task: asyncio.Task[list[tuple[str, Any]]] | None = None
        active_worker_task: asyncio.Task | None = None
        try:
            guard_accounts = _normalize_decrypt_guard_accounts(account_databases.keys())
            if guard_accounts:
                yield _sse(
                    {
                        "type": "phase",
                        "phase": "decrypt_guard",
                        "message": "正在暂停实时同步并等待解密写锁...",
                    }
                )
                await asyncio.sleep(0)
                guard_acquire_task = asyncio.create_task(
                    asyncio.to_thread(
                        _acquire_decrypt_account_guards,
                        guard_accounts,
                        reason="decrypt:sse",
                    )
                )
                decrypt_guards = await asyncio.shield(guard_acquire_task)
                guard_acquire_task = None

            yield _sse({"type": "start", "total": total_databases, "message": f"开始解密 {total_databases} 个数据库"})
            await asyncio.sleep(0)

            # 3) Init output dir & decryptor.
            base_output_dir = get_output_databases_dir()
            base_output_dir.mkdir(parents=True, exist_ok=True)

            try:
                decryptor = WeChatDatabaseDecryptor(k)
            except ValueError as e:
                yield _sse({"type": "error", "message": f"密钥错误: {e}"})
                return

            # 4) Decrypt per account, stream progress.
            success_count = 0
            fail_count = 0
            processed_files: list[str] = []
            failed_files: list[str] = []
            account_results: dict = {}
            diagnostic_warning_count = 0
            overall_current = 0

            for account, dbs in account_databases.items():
                account_output_dir = base_output_dir / account
                account_output_dir.mkdir(parents=True, exist_ok=True)

                # Save a hint for later UI (same as non-stream endpoint).
                try:
                    source_info = account_sources.get(account, {})
                    source_db_storage_path = str(source_info.get("db_storage_path") or p)
                    wxid_dir = str(source_info.get("wxid_dir") or "")
                    (account_output_dir / "_source.json").write_text(
                        json.dumps(
                            {"db_storage_path": source_db_storage_path, "wxid_dir": wxid_dir},
                            ensure_ascii=False,
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                except Exception:
                    pass

                account_success = 0
                account_processed: list[str] = []
                account_failed: list[str] = []
                account_db_diagnostics: dict[str, dict] = {}
                account_diagnostic_warning_count = 0

                for db_info in dbs:
                    if await request.is_disconnected():
                        return

                    overall_current += 1
                    db_path = str(db_info.get("path") or "")
                    db_name = str(db_info.get("name") or "")
                    current_file = f"{account}/{db_name}" if account else db_name

                    # Emit a "processing" event so UI updates immediately for large db files.
                    yield _sse(
                        {
                            "type": "progress",
                            "current": overall_current,
                            "total": total_databases,
                            "success_count": success_count,
                            "fail_count": fail_count,
                            "current_file": current_file,
                            "status": "processing",
                            "message": "解密中...",
                        }
                    )

                    output_path = account_output_dir / db_name
                    task = asyncio.create_task(asyncio.to_thread(decryptor.decrypt_database, db_path, str(output_path)))
                    active_worker_task = task

                    # Wait with heartbeat (can't yield while awaiting the thread directly).
                    last_heartbeat = time.time()
                    disconnected = False
                    while not task.done():
                        if await request.is_disconnected():
                            disconnected = True
                            break
                        now = time.time()
                        if now - last_heartbeat > 15:
                            last_heartbeat = now
                            # SSE comment heartbeat; browsers ignore but keeps proxies alive.
                            yield ": ping\n\n"
                        await asyncio.sleep(0.6)
                    try:
                        ok = bool(await asyncio.shield(task))
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        ok = False
                    finally:
                        if task.done():
                            active_worker_task = None
                    if disconnected:
                        return
                    db_diagnostic = dict(getattr(decryptor, "last_result", {}) or {})
                    if not db_diagnostic:
                        db_diagnostic = {
                            "db_path": str(db_path),
                            "db_name": str(db_name),
                            "output_path": str(output_path),
                            "success": bool(ok),
                        }
                    db_diagnostic["account"] = str(account)
                    account_db_diagnostics[db_name] = db_diagnostic

                    if (
                        (not bool(db_diagnostic.get("success", ok)))
                        or int(db_diagnostic.get("failed_pages") or 0) > 0
                        or int(db_diagnostic.get("hmac_warning_pages") or 0) > 0
                        or str(db_diagnostic.get("diagnostic_status") or "") != "ok"
                    ):
                        account_diagnostic_warning_count += 1

                    if ok:
                        account_success += 1
                        success_count += 1
                        account_processed.append(str(output_path))
                        processed_files.append(str(output_path))
                        status = "success"
                        msg = "解密成功"
                    else:
                        account_failed.append(db_path)
                        failed_files.append(db_path)
                        fail_count += 1
                        status = "fail"
                        msg = "解密失败"

                    payload = {
                        "type": "progress",
                        "current": overall_current,
                        "total": total_databases,
                        "success_count": success_count,
                        "fail_count": fail_count,
                        "current_file": current_file,
                        "status": status,
                        "message": msg,
                    }
                    if db_diagnostic:
                        payload["diagnostic_status"] = str(db_diagnostic.get("diagnostic_status") or "")
                        payload["page_failures"] = int(db_diagnostic.get("failed_pages") or 0)
                        payload["hmac_warning_pages"] = int(db_diagnostic.get("hmac_warning_pages") or 0)
                        if db_diagnostic.get("failed_page_samples"):
                            payload["failed_page_samples"] = db_diagnostic.get("failed_page_samples")
                        if db_diagnostic.get("hmac_warning_samples"):
                            payload["hmac_warning_samples"] = db_diagnostic.get("hmac_warning_samples")
                        if db_diagnostic.get("diagnostics"):
                            payload["diagnostics"] = db_diagnostic.get("diagnostics")

                    yield _sse(payload)

                    if overall_current % 5 == 0:
                        await asyncio.sleep(0)

                account_results[account] = {
                    "total": len(dbs),
                    "success": account_success,
                    "failed": len(dbs) - account_success,
                    "output_dir": str(account_output_dir),
                    "source_db_storage_path": str(source_db_storage_path),
                    "source_wxid_dir": str(wxid_dir),
                    "processed_files": account_processed,
                    "failed_files": account_failed,
                    "db_diagnostics": account_db_diagnostics,
                    "diagnostic_warning_count": int(account_diagnostic_warning_count),
                }
                diagnostic_warning_count += int(account_diagnostic_warning_count)

                # Build cache table (keep behavior consistent with the POST endpoint).
                if os.environ.get("WECHAT_TOOL_BUILD_SESSION_LAST_MESSAGE", "1") != "0":
                    yield _sse(
                        {
                            "type": "phase",
                            "phase": "session_last_message",
                            "account": account,
                            "message": "正在构建会话缓存（最后一条消息）...",
                        }
                    )
                    await asyncio.sleep(0)

                    try:
                        from ..session_last_message import build_session_last_message_table

                        task = asyncio.create_task(
                            asyncio.to_thread(
                                build_session_last_message_table,
                                account_output_dir,
                                rebuild=True,
                                include_hidden=True,
                                include_official=True,
                            )
                        )
                        active_worker_task = task
                        last_heartbeat = time.time()
                        disconnected = False
                        while not task.done():
                            if await request.is_disconnected():
                                disconnected = True
                                break
                            now = time.time()
                            if now - last_heartbeat > 15:
                                last_heartbeat = now
                                yield ": ping\n\n"
                            await asyncio.sleep(0.6)
                        account_results[account]["session_last_message"] = await asyncio.shield(task)
                        if disconnected:
                            return
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        account_results[account]["session_last_message"] = {"status": "error", "message": str(e)}
                    finally:
                        if active_worker_task is not None and active_worker_task.done():
                            active_worker_task = None

            status = "completed" if success_count > 0 else "failed"
            result = {
                "status": status,
                "total_databases": total_databases,
                "success_count": success_count,
                "failure_count": total_databases - success_count,
                "output_directory": str(base_output_dir.absolute()),
                "message": build_decrypt_summary_message(
                    success_count=success_count,
                    total_databases=total_databases,
                    diagnostic_warning_count=diagnostic_warning_count,
                ),
                "processed_files": processed_files,
                "failed_files": failed_files,
                "account_results": account_results,
                "diagnostic_warning_count": int(diagnostic_warning_count),
            }

            # Save the verified db key for frontend autofill and later snapshot decryption.
            db_key_persisted, db_key_persistence_errors = _persist_db_keys(account_results, k)
            result["db_key_persisted"] = db_key_persisted
            result["db_key_persistence_errors"] = db_key_persistence_errors

            yield _sse({"type": "complete", **result})
        finally:
            acquire_to_clean = guard_acquire_task
            if acquire_to_clean is not None:
                if acquire_to_clean.done():
                    try:
                        decrypt_guards = acquire_to_clean.result()
                    except BaseException:
                        pass
                else:
                    _defer_decrypt_guard_acquire_cleanup(acquire_to_clean)
                guard_acquire_task = None

            worker_to_wait = active_worker_task
            if worker_to_wait is not None and not worker_to_wait.done():
                current_task = asyncio.current_task()
                if current_task is not None and current_task.cancelling():
                    _defer_decrypt_guard_cleanup(worker_to_wait, decrypt_guards)
                    decrypt_guards = []
                else:
                    try:
                        await asyncio.shield(worker_to_wait)
                    except asyncio.CancelledError:
                        # A second cancellation while closing the response must
                        # not cancel the thread-backed worker or release its guard.
                        _defer_decrypt_guard_cleanup(worker_to_wait, decrypt_guards)
                        decrypt_guards = []
                        raise
                    except BaseException:
                        pass
            if decrypt_guards:
                await asyncio.to_thread(_release_decrypt_account_guards, decrypt_guards, reason="decrypt:sse")

    headers = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    return StreamingResponse(generate_progress(), media_type="text/event-stream", headers=headers)
