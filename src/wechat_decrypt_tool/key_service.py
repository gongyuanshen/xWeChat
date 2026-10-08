# import sys
# import requests

from .platform_support import is_windows


import time
import threading
import psutil
import os
import json
import re
import logging
import asyncio
from pathlib import Path
from typing import Optional, Dict, Any

  # 建议使用 packaging 库处理版本比较
from .wechat_detection import parse_global_config
from .dll_key_scan import extract_xor_keys_from_dll
from .image_key_resolver import (
    ImageKeyResolution,
    TemplateScanResult,
    clean_wxid,
    derive_image_keys,
    resolve_local_image_key,
    scan_v2_templates,
    verify_key_pair,
)
from .image_key_memory_scan import scan_image_key_from_memory, raise_if_image_key_scan_cancelled
from .key_store import (
    get_account_keys_from_store,
    normalize_key_store_path,
    upsert_account_keys_in_store,
)
from .media_helpers import _resolve_account_dir, _resolve_account_wxid_dir
from .media_helpers import _load_media_keys
from .chat_accounts import resolve_chat_account_context
from .account_source_policy import source_metadata_is_imported_snapshot

logger = logging.getLogger(__name__)


WECHAT_EXECUTABLE_NAMES = ("Weixin.exe", "WeChat.exe")
KEY_SIZE = 32


def _key_payload_log_metadata(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = payload or {}
    xor_key = str(payload.get("xor_key", payload.get("xorKey", "")) or "").strip()
    aes_key = str(payload.get("aes_key", payload.get("aesKey", "")) or "").strip()
    return {
        "wxid": str(payload.get("wxid") or "").strip(),
        "has_xor": bool(xor_key),
        "has_aes": bool(aes_key),
        "xor_length": len(xor_key),
        "aes_length": len(aes_key),
    }


def _image_key_account_match_variants(value: Any) -> set[str]:
    """Return account names that should be considered equivalent for image key matching.

    Windows WeChat 4.x stores account data under a folder such as
    ``wxid_testuser000001_a001`` while its logical account ID is
    ``wxid_testuser000001``.  The trailing four-hex folder suffix is not part
    of the logical account id, so both names must match.  Do not strip
    arbitrary suffixes: names like ``wxid_demo_extra`` may be a distinct
    account in tests or legacy data.
    """
    raw = str(value or "").strip().lower()
    if not raw:
        return set()

    variants = {raw}
    suffix_match = re.match(r"^(wxid_[^_\s]+)_[0-9a-f]{4}$", raw, flags=re.IGNORECASE)
    if suffix_match:
        variants.add(suffix_match.group(1).lower())
    return variants


def _resolve_wxid_dir_for_image_key(
        account: Optional[str] = None,
        *,
        wxid_dir: Optional[str] = None,
        db_storage_path: Optional[str] = None,
) -> Path:
    explicit_wxid_dir = str(wxid_dir or "").strip()
    if explicit_wxid_dir:
        candidate = Path(explicit_wxid_dir).expanduser()
        if candidate.exists() and candidate.is_dir():
            logger.info("[image_key] 使用显式 wxid_dir: %s", str(candidate))
            return candidate
        raise FileNotFoundError(f"指定的 wxid_dir 不存在或不是目录: {candidate}")

    explicit_db_storage_path = str(db_storage_path or "").strip()
    if explicit_db_storage_path:
        db_storage_dir = Path(explicit_db_storage_path).expanduser()
        if db_storage_dir.exists() and db_storage_dir.is_dir():
            if db_storage_dir.name.lower() == "db_storage":
                candidate = db_storage_dir.parent
                if candidate.exists() and candidate.is_dir():
                    logger.info(
                        "[image_key] 通过 db_storage_path 反推出 wxid_dir: db_storage_path=%s wxid_dir=%s",
                        str(db_storage_dir),
                        str(candidate),
                    )
                    return candidate
            nested_db_storage = db_storage_dir / "db_storage"
            if nested_db_storage.exists() and nested_db_storage.is_dir():
                logger.info(
                    "[image_key] db_storage_path 指向 wxid_dir，自动使用其子目录: wxid_dir=%s",
                    str(db_storage_dir),
                )
                return db_storage_dir
        logger.info(
            "[image_key] 提供的 db_storage_path 无法解析 wxid_dir: %s",
            explicit_db_storage_path,
        )

    if account:
        try:
            account_dir = _resolve_account_dir(account)
            wx_id_dir = _resolve_account_wxid_dir(account_dir)
            if wx_id_dir:
                logger.info(
                    "[image_key] 通过已解密账号目录解析 wxid_dir: account=%s account_dir=%s wxid_dir=%s",
                    str(account).strip(),
                    str(account_dir),
                    str(wx_id_dir),
                )
                return wx_id_dir
        except Exception as e:
            logger.info(
                "[image_key] 无法通过已解密账号目录解析 wxid_dir: account=%s error=%s",
                str(account).strip(),
                str(e),
            )

    raise FileNotFoundError("无法定位该账号的 wxid_dir，请传入有效的 db_storage_path 或先完成数据库解密")


def _normalize_user_path(value: Any) -> str:
    raw = str(value or "").strip().strip('"').strip("'")
    if not raw:
        return ""
    try:
        return os.path.normpath(os.path.expandvars(raw))
    except Exception:
        return raw


def _read_wechat_version_from_exe(exe_path: str) -> str:
    normalized = _normalize_user_path(exe_path)
    if not normalized:
        return ""
    try:
        import win32api

        version_info = win32api.GetFileVersionInfo(normalized, "\\")
        return (
            f"{version_info['FileVersionMS'] >> 16}."
            f"{version_info['FileVersionMS'] & 0xFFFF}."
            f"{version_info['FileVersionLS'] >> 16}."
            f"{version_info['FileVersionLS'] & 0xFFFF}"
        )
    except Exception:
        return ""


def _resolve_manual_wechat_exe_path(wechat_install_path: Optional[str] = None) -> str:
    normalized = _normalize_user_path(wechat_install_path)
    if not normalized:
        return ""

    candidate = Path(normalized).expanduser()
    executable_names = {name.lower() for name in WECHAT_EXECUTABLE_NAMES}
    if candidate.is_file():
        if candidate.name.lower() not in executable_names:
            raise RuntimeError("手动路径必须指向微信安装目录，或直接指向 Weixin.exe / WeChat.exe")
        return str(candidate)

    if candidate.is_dir():
        for exe_name in WECHAT_EXECUTABLE_NAMES:
            exe_path = candidate / exe_name
            if exe_path.is_file():
                return str(exe_path)
        raise RuntimeError("手动指定的微信安装目录中未找到 Weixin.exe 或 WeChat.exe")

    raise RuntimeError(f"手动指定的微信安装目录不存在: {candidate}")


def _normalize_db_key(value: Any) -> str:
    if value is None:
        raise RuntimeError("V4 内存扫描未返回数据库密钥")

    if isinstance(value, (bytes, bytearray)):
        raw_bytes = bytes(value)
        # 两种常见形态：32 字节原始 key / 64 字符 ASCII hex
        if len(raw_bytes) == 32:
            key = raw_bytes.hex()
        else:
            try:
                key = raw_bytes.decode("utf-8", errors="ignore").strip()
            except Exception:
                key = raw_bytes.hex()
    else:
        key = str(value).strip()

    key = key.lower()
    if key.startswith("0x"):
        key = key[2:]

    if not re.fullmatch(r"[0-9a-f]{64}", key):
        raise RuntimeError(f"V4 内存扫描返回了非 64 位十六进制密钥（type={type(value).__name__}, len={len(key)}）")
    return key


def _normalize_internal_db_key(value: Any) -> bytes:
    """把 scan.py 里扫出来的 32 字节 DLL key 规范化成 bytes。"""
    if value is None:
        return b""

    if isinstance(value, (bytes, bytearray)):
        raw_bytes = bytes(value)
        if len(raw_bytes) == KEY_SIZE:
            return raw_bytes
        try:
            value = raw_bytes.decode("utf-8", errors="ignore")
        except Exception:
            value = raw_bytes.hex()

    raw = str(value or "").strip()
    if not raw:
        return b""

    if raw.startswith("{") and raw.endswith("}"):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for candidate_key in ("internal_db_key", "internal_db_key_hex", "dll_key", "key", "key_hex"):
                    candidate = str(parsed.get(candidate_key) or "").strip()
                    if candidate:
                        raw = candidate
                        break
        except Exception:
            pass

    raw = raw.lower().replace("0x", "")
    cleaned = re.sub(r"[^0-9a-f]", "", raw)
    if not cleaned:
        return b""
    if len(cleaned) != KEY_SIZE * 2:
        raise RuntimeError(
            f"internal_db_key 格式无效：需要 32 字节（64 位十六进制），当前长度={len(cleaned)}"
        )
    try:
        return bytes.fromhex(cleaned)
    except Exception as e:
        raise RuntimeError("internal_db_key 格式无效：无法解析为十六进制") from e


def _xor_hex_key_with_internal_db_key(db_key: Any, internal_db_key: bytes) -> str:
    normalized_key = _normalize_db_key(db_key)
    key_bytes = bytes.fromhex(normalized_key)
    if len(key_bytes) != len(internal_db_key):
        raise RuntimeError(
            f"internal_db_key 长度不匹配：db_key={len(key_bytes)} bytes internal_db_key={len(internal_db_key)} bytes"
        )
    return bytes(a ^ b for a, b in zip(key_bytes, internal_db_key)).hex()


# ======================  数据库密钥内存扫描  =====================================


def _get_db_key_with_pure_memory(db_storage_path, *, wechat_install_path=None,
                                internal_db_key=None, cancel_event=None, timeout_seconds=120.0):
    """Read the running client and authenticate its candidate against this account only."""
    from . import key_v4
    from .wechat_decrypt import scan_account_databases_from_path, validate_realtime_database_key

    deadline = time.monotonic() + timeout_seconds
    key_v4._check_scan_budget(deadline, cancel_event)
    if not db_storage_path:
        raise ValueError('请指定账号的 db_storage_path 后再扫描数据库密钥')
    scan = scan_account_databases_from_path(db_storage_path)
    if scan['status'] != 'success':
        raise ValueError(scan['message'])
    account, source = next(iter(scan['account_sources'].items()))
    db_root = Path(source['db_storage_path']).resolve()
    probe_paths = sorted((Path(item['path']) for item in scan['account_databases'][account]),
                         key=lambda path: (path.name.lower() != 'session.db', _sort_probe_database(path)))
    probe_db = None
    for path in probe_paths:
        with path.open('rb') as stream:
            page = stream.read(key_v4.PAGE_SIZE)
        if len(page) == key_v4.PAGE_SIZE and not page.startswith(b'SQLite format 3\0'):
            probe_db = path
            break
    if probe_db is None:
        raise ValueError('账号目录中没有可用于 HMAC 验真的完整加密数据库首页')

    manual_exe = _resolve_manual_wechat_exe_path(wechat_install_path) if wechat_install_path else ''
    processes = [process for process in psutil.process_iter(['pid', 'name', 'exe'])
                 if str(process.info['name']).lower() in {'weixin.exe', 'wechat.exe'}]
    if not processes:
        raise RuntimeError('未找到运行中的微信进程，请先自行启动并登录微信')
    scanned = []
    for process in processes:
        key_v4._check_scan_budget(deadline, cancel_event)
        pid = process.info['pid']
        exe = process.info['exe']
        if not exe:
            raise PermissionError(f'无法读取微信进程 PID {pid} 的可执行路径')
        if manual_exe and Path(manual_exe).resolve() != Path(exe).resolve():
            continue
        dlls = {Path(module.path) for module in process.memory_maps()
                if Path(module.path).name.lower() in {'weixin.dll', 'wechat.dll'}}
        if not dlls:
            continue  # Chromium helper processes do not load the database module.
        if len(dlls) != 1:
            raise RuntimeError(f'PID {pid} 加载了多个微信数据库 DLL，无法确定扫描目标')
        dll_path = dlls.pop()
        version = _read_wechat_version_from_exe(exe)
        if not version:
            raise RuntimeError(f'无法读取微信版本: {exe}')
        logger.info('[db_key_pure] process=%s version=%s dll=%s account=%s', pid, version, dll_path, account)
        if internal_db_key:
            masks = [_normalize_internal_db_key(internal_db_key)]
        else:
            masks = list(dict.fromkeys(bytes.fromhex(item['key_hex'])
                                       for item in extract_xor_keys_from_dll(dll_path, max_workers=1)))
        key_v4._check_scan_budget(deadline, cancel_event)
        if not masks:
            raise RuntimeError(f'当前微信版本 {version} DLL 不匹配源码辅助密钥签名: {dll_path}')
        if any(len(mask) != KEY_SIZE for mask in masks):
            raise ValueError('DLL scanner returned an invalid internal key length')
        scanned.append(pid)
        for mask in masks:
            key_v4._check_scan_budget(deadline, cancel_event)
            raw = key_v4.recover_key(pid, str(probe_db), mask,
                                     timeout_seconds=deadline - time.monotonic(), cancel_event=cancel_event)
            if raw is None:
                continue
            candidate = _xor_hex_key_with_internal_db_key(raw, mask)
            verification = validate_realtime_database_key(db_root, candidate)
            key_v4._check_scan_budget(deadline, cancel_event)
            if not verification['valid']:
                raise RuntimeError(f'扫描候选未通过账号跨库 HMAC 验真: account={account} verified_roles={verification["verified_roles"]}')
            return {'db_key': candidate, 'method': 'pure_memory', 'pid': pid,
                    'account': account, 'db_key_probe_path': str(probe_db),
                    'db_storage_path': str(db_root), 'wechat_version': version,
                    'wechat_dll_path': str(dll_path), 'verified_roles': verification['verified_roles'],
                    'verified': True, 'internal_db_key_candidate_count': len(masks)}
    raise RuntimeError(f'源码内存扫描未找到匹配账号的数据库密钥: account={account} scanned_pids={scanned}')


def get_db_key_workflow(
    wechat_install_path: Optional[str] = None,
    *,
    db_storage_path: Optional[str] = None,
    internal_db_key: Optional[str] = None,
    key_mode: str = "auto",
    cancel_event: Any = None,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    if not is_windows():
        raise RuntimeError("当前平台不支持自动获取数据库密钥，请使用同类工具获取后手动填写。")

    mode = str(key_mode or "auto").strip().lower()
    if mode not in {'auto', 'v4', 'key_v4', 'memory', 'memory_scan', 'pure_memory'}:
        raise ValueError(f'未知密钥获取模式: {key_mode}')
    return _get_db_key_with_pure_memory(db_storage_path, wechat_install_path=wechat_install_path,
                                       internal_db_key=internal_db_key, cancel_event=cancel_event,
                                       timeout_seconds=timeout_seconds)


# ==============================   以下是图片密钥逻辑  =====================================


def _parse_image_xor_key(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if 0 <= value <= 0xFF else None

    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if raw.lower().startswith("0x"):
            parsed = int(raw[2:], 16)
        elif re.fullmatch(r"\d+", raw):
            parsed = int(raw, 10)
        else:
            parsed = int(raw, 16)
    except (TypeError, ValueError):
        return None
    return parsed if 0 <= parsed <= 0xFF else None


def _normalize_complete_image_key_payload(payload: Dict[str, Any]) -> Optional[tuple[int, str]]:
    xor_key = _parse_image_xor_key(
        payload.get("xor_key", payload.get("xorKey", payload.get("image_xor_key")))
    )
    aes_key = str(
        payload.get("aes_key", payload.get("aesKey", payload.get("image_aes_key", ""))) or ""
    ).strip()
    if xor_key is None or len(aes_key) < 16:
        return None
    aes_key = aes_key[:16]
    try:
        if len(aes_key.encode("ascii")) != 16:
            return None
    except UnicodeEncodeError:
        return None
    return xor_key, aes_key


def _get_image_key_kvcomm_dirs(account_dir: Optional[Path] = None) -> tuple[Path, ...]:
    override = str(os.environ.get("WECHAT_IMAGE_KVCOMM_DIR") or "").strip()
    if override:
        return (Path(override).expanduser(),)

    appdata = str(os.environ.get("APPDATA") or "").strip()
    appdata_root = Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
    candidates = [appdata_root / "Tencent" / "xwechat" / "net" / "kvcomm"]

    deduplicated: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = normalize_key_store_path(str(candidate))
        if normalized in seen:
            continue
        seen.add(normalized)
        deduplicated.append(candidate)

    existing = tuple(candidate for candidate in deduplicated if candidate.is_dir())
    if existing:
        return existing
    return tuple(deduplicated[:1])


def _resolve_local_image_key_from_kvcomm_candidates(
        *,
        account_dir: Path,
        target_wxid: str,
        account: Optional[str],
        local_native_wxids: list[str],
        template_scan: Optional[TemplateScanResult],
) -> Optional[ImageKeyResolution]:
    for kvcomm_dir in _get_image_key_kvcomm_dirs(account_dir):
        logger.info("[image_key] 尝试本地 kvcomm 目录: %s", kvcomm_dir)
        resolution = resolve_local_image_key(
            kvcomm_dir=kvcomm_dir,
            account_dir=account_dir,
            target_wxid=target_wxid,
            account=account,
            local_native_wxids=local_native_wxids,
            template_scan=template_scan,
        )
        if resolution is not None:
            return resolution
    return None


def _image_key_aliases(canonical_account: str, *values: Any) -> list[str]:
    aliases: list[str] = []
    seen = {str(canonical_account or "").strip().lower()}
    for value in values:
        alias = str(value or "").strip()
        normalized = alias.lower()
        if not alias or normalized in seen:
            continue
        seen.add(normalized)
        aliases.append(alias)
    return aliases


def _is_trusted_image_key_alias(
    alias: Any,
    *,
    canonical_account: str,
    matched_wxid: str,
    source_wxid_dir: Path,
) -> bool:
    alias_text = str(alias or "").strip()
    if not alias_text:
        return False
    alias_variants = _image_key_account_match_variants(alias_text)
    if alias_variants & _image_key_account_match_variants(canonical_account):
        return True
    if alias_variants & _image_key_account_match_variants(matched_wxid):
        return True
    try:
        account_dir = _resolve_account_dir(alias_text)
        resolved_source = _resolve_account_wxid_dir(account_dir)
    except Exception:
        return False
    return (
        resolved_source is not None
        and normalize_key_store_path(str(resolved_source))
        == normalize_key_store_path(str(source_wxid_dir))
    )


def _load_verified_image_key_cache(
        canonical_account: str,
        request_account: Optional[str],
        source_wxid_dir: Path,
) -> Optional[Dict[str, Any]]:
    candidates = [canonical_account, str(request_account or "").strip()]
    for value in list(candidates):
        candidates.extend(sorted(_image_key_account_match_variants(value)))

    seen: set[str] = set()
    expected_source = normalize_key_store_path(str(source_wxid_dir))
    for candidate in candidates:
        candidate = str(candidate or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        saved = get_account_keys_from_store(candidate)
        if not isinstance(saved, dict) or saved.get("image_key_verified") is not True:
            continue
        if normalize_key_store_path(saved.get("image_key_source_wxid_dir")) != expected_source:
            continue
        normalized = _normalize_complete_image_key_payload(saved)
        if normalized is None:
            continue
        xor_key, aes_key = normalized
        return {
            "wxid": canonical_account,
            "matched_wxid": str(saved.get("image_key_derived_wxid") or canonical_account),
            "xor_key": f"0x{xor_key:02X}",
            "aes_key": aes_key,
            "source": "verified_cache",
            "cached_source": str(saved.get("image_key_source") or ""),
            "verified": True,
            "code": saved.get("image_key_code"),
        }
    return None


def _verified_image_key_cache_matches_templates(
    cached: Dict[str, Any],
    template_scan: TemplateScanResult,
) -> bool:
    if not template_scan.templates:
        return True
    normalized = _normalize_complete_image_key_payload(cached)
    if normalized is None:
        return False
    xor_key, aes_key = normalized

    if str(cached.get("cached_source") or "").strip() == "weflow_local_verified":
        try:
            code = int(cached.get("code"))
            derived = derive_image_keys(code, str(cached.get("matched_wxid") or ""))
        except (TypeError, ValueError):
            return False
        if derived.xor_key != xor_key or derived.aes_key != aes_key:
            return False
        return verify_key_pair(
            xor_key,
            aes_key,
            template_scan,
            require_xor_match=False,
        )

    return verify_key_pair(
        xor_key,
        aes_key,
        template_scan,
        require_xor_match=True,
    )


def _persist_verified_image_keys(
        *,
        canonical_account: str,
        request_account: Optional[str],
        source_wxid_dir: Path,
        matched_wxid: str,
        xor_key: int,
        aes_key: str,
        source: str,
        code: Optional[int] = None,
        trust_matched_alias: bool = True,
) -> None:
    normalized = _normalize_complete_image_key_payload({"xor_key": xor_key, "aes_key": aes_key})
    if normalized is None:
        raise RuntimeError("拒绝保存不完整的图片密钥")
    normalized_xor, normalized_aes = normalized
    if code is None and source == "memory_v2_verified":
        saved = get_account_keys_from_store(canonical_account)
        if (
            saved.get("image_key_verified") is True
            and saved.get("image_key_code") is not None
            and normalize_key_store_path(saved.get("image_key_source_wxid_dir"))
            == normalize_key_store_path(str(source_wxid_dir))
            and clean_wxid(saved.get("image_key_derived_wxid")) == clean_wxid(matched_wxid)
            and _normalize_complete_image_key_payload(saved) == normalized
        ):
            derived = derive_image_keys(saved["image_key_code"], matched_wxid)
            if (derived.xor_key, derived.aes_key) == normalized:
                code = saved["image_key_code"]
    alias_values: list[str] = []
    if _is_trusted_image_key_alias(
        request_account,
        canonical_account=canonical_account,
        matched_wxid=matched_wxid,
        source_wxid_dir=source_wxid_dir,
    ):
        alias_values.append(str(request_account or "").strip())
    if trust_matched_alias:
        alias_values.append(matched_wxid)
    upsert_account_keys_in_store(
        account=canonical_account,
        image_xor_key=f"0x{normalized_xor:02X}",
        image_aes_key=normalized_aes,
        aliases=_image_key_aliases(canonical_account, *alias_values),
        image_key_verified=True,
        image_key_source=source,
        image_key_source_wxid_dir=str(source_wxid_dir),
        image_key_derived_wxid=matched_wxid,
        image_key_code=code,
        raise_on_write_error=True,
    )


def _verified_image_key_result(
        *,
        canonical_account: str,
        matched_wxid: str,
        xor_key: int,
        aes_key: str,
        source: str,
        code: Optional[int] = None,
        template_path: Optional[Path] = None,
) -> Dict[str, Any]:
    return {
        "wxid": canonical_account,
        "matched_wxid": matched_wxid,
        "xor_key": f"0x{xor_key:02X}",
        "aes_key": aes_key,
        "source": source,
        "verified": True,
        "code": code,
        "template_path": str(template_path) if template_path else "",
    }


async def get_image_key_integrated_workflow(
        account: Optional[str] = None,
        *,
        wxid_dir: Optional[str] = None,
        db_storage_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Resolve image keys locally and require real V2 validation."""
    resolved_wxid_dir: Optional[Path] = None
    try:
        resolved_wxid_dir = _resolve_wxid_dir_for_image_key(
            account,
            wxid_dir=wxid_dir,
            db_storage_path=db_storage_path,
        )
    except Exception as error:
        logger.info("[image_key] 无法解析本地目标账号目录: %s", str(error))

    canonical_account = (
        resolved_wxid_dir.name if resolved_wxid_dir is not None else str(account or "").strip()
    )
    template_scan: Optional[TemplateScanResult] = None
    if resolved_wxid_dir is not None:
        template_scan = await asyncio.to_thread(scan_v2_templates, resolved_wxid_dir)
        logger.info(
            "[image_key] V2 模板扫描完成: account=%s templates=%s files_scanned=%s inferred_xor_present=%s fallback=%s",
            canonical_account,
            len(template_scan.templates),
            template_scan.files_scanned,
            template_scan.inferred_xor_key is not None,
            template_scan.used_fallback,
        )
        cached = _load_verified_image_key_cache(canonical_account, account, resolved_wxid_dir)
        if cached is not None and _verified_image_key_cache_matches_templates(cached, template_scan):
            logger.info(
                "[image_key] 命中已验真缓存: account=%s source=%s",
                canonical_account,
                cached.get("cached_source"),
            )
            return cached
        if cached is not None:
            logger.info(
                "[image_key] 已验真缓存未通过最新 V2 模板复验，将重新解析: account=%s source=%s",
                canonical_account,
                cached.get("cached_source"),
            )

    local_native_wxids: list[str] = []
    if resolved_wxid_dir is not None:
        global_info = await asyncio.to_thread(parse_global_config, str(resolved_wxid_dir.parent))
        if isinstance(global_info, dict) and str(global_info.get("wxid") or "").strip():
            global_wxid = str(global_info["wxid"]).strip()
            local_native_wxids.append(global_wxid)
        try:
            siblings = await asyncio.to_thread(lambda: list(resolved_wxid_dir.parent.iterdir()))
            local_native_wxids.extend(
                item.name for item in siblings[:128]
                if item.is_dir() and item.name.lower() != "all_users"
            )
        except OSError:
            pass

        try:
            resolution: Optional[ImageKeyResolution] = await asyncio.to_thread(
                _resolve_local_image_key_from_kvcomm_candidates,
                account_dir=resolved_wxid_dir,
                target_wxid=canonical_account,
                account=account,
                local_native_wxids=local_native_wxids,
                template_scan=template_scan,
            )
        except Exception as error:
            logger.warning("[image_key] WeFlow 本地派生失败: %s", str(error))
            resolution = None


        if resolution is not None and resolution.verified is True:
            _persist_verified_image_keys(
                canonical_account=canonical_account,
                request_account=account,
                source_wxid_dir=resolved_wxid_dir,
                matched_wxid=resolution.wxid,
                xor_key=resolution.xor_key,
                aes_key=resolution.aes_key,
                source="weflow_local_verified",
                code=resolution.code,
            )
            logger.info(
                "[image_key] WeFlow 本地派生验真成功: account=%s matched_wxid=%s key_pair_verified=true",
                canonical_account,
                resolution.wxid,
            )
            return _verified_image_key_result(
                canonical_account=canonical_account,
                matched_wxid=resolution.wxid,
                xor_key=resolution.xor_key,
                aes_key=resolution.aes_key,
                source="weflow_local_verified",
                code=resolution.code,
                template_path=resolution.template_path,
            )


    raise RuntimeError(
        "未能在本地获取并验证图片密钥，请使用内存扫描或手动填写有效密钥。"
    )


async def get_image_key_memory_workflow(
        account: Optional[str] = None,
        *,
        wxid_dir: Optional[str] = None,
        db_storage_path: Optional[str] = None,
        timeout: float = 60,
        cancel_event: threading.Event | None = None,
) -> Dict[str, Any]:
    """Scan WeChat process memory and persist only a V2-verified image key pair."""
    cancel_event = cancel_event if cancel_event is not None else threading.Event()
    raise_if_image_key_scan_cancelled(cancel_event)
    resolved_wxid_dir = _resolve_wxid_dir_for_image_key(
        account,
        wxid_dir=wxid_dir,
        db_storage_path=db_storage_path,
    )
    canonical_account = resolved_wxid_dir.name
    logger.info(
        "[image_key] 开始显式内存扫描: account=%s wxid_dir=%s timeout=%ss",
        canonical_account,
        str(resolved_wxid_dir),
        timeout,
    )

    timeout_seconds = max(0.0, float(timeout))
    try:
        resolution = await asyncio.wait_for(
            asyncio.to_thread(
                scan_image_key_from_memory,
                resolved_wxid_dir,
                timeout_seconds,
                cancel_event=cancel_event,
            ),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        cancel_event.set()
        resolution = None
    except BaseException:
        cancel_event.set()
        raise
    if resolution is None or resolution.verified is not True:
        raise RuntimeError(
            f"{int(timeout_seconds)} 秒内未在微信进程内存中找到可通过 V2 图片验真的 AES 密钥"
        )

    raise_if_image_key_scan_cancelled(cancel_event)
    _persist_verified_image_keys(
        canonical_account=canonical_account,
        request_account=account,
        source_wxid_dir=resolved_wxid_dir,
        matched_wxid=canonical_account,
        xor_key=resolution.xor_key,
        aes_key=resolution.aes_key,
        source="memory_v2_verified",
    )
    logger.info(
        "[image_key] 内存候选通过 V2 验真: account=%s pid=%s encoding=%s key_pair_verified=true",
        canonical_account,
        resolution.pid,
        resolution.encoding,
    )

    result = _verified_image_key_result(
        canonical_account=canonical_account,
        matched_wxid=canonical_account,
        xor_key=resolution.xor_key,
        aes_key=resolution.aes_key,
        source="memory_v2_verified",
        template_path=resolution.template_path,
    )
    result.update({"pid": resolution.pid, "encoding": resolution.encoding})
    return result


def prepare_export_image_keys(account_dir: Path, *, cancel_event: threading.Event) -> str:
    """Prepare one source-bound key pair for an explicitly opted-in export."""
    deadline = time.monotonic() + 60.0

    def checkpoint() -> None:
        raise_if_image_key_scan_cancelled(cancel_event)
        if time.monotonic() >= deadline:
            raise TimeoutError("导出前图片密钥获取超时（60 秒，包含样本扫描）")

    checkpoint()
    context = resolve_chat_account_context(account_dir.name)
    if context.account_dir.resolve() != account_dir.resolve():
        raise ValueError("导出账号目录与媒体密钥账号不一致")
    if source_metadata_is_imported_snapshot(context.source_info):
        raise RuntimeError("导入的历史记录不能从本机微信获取媒体密钥")
    source = _resolve_wxid_dir_for_image_key(
        wxid_dir=context.wxid_dir, db_storage_path=context.db_storage_path,
    )
    templates = scan_v2_templates(source, checkpoint=checkpoint)
    checkpoint()
    cached = _load_verified_image_key_cache(source.name, context.name, source)
    if cached is not None and _verified_image_key_cache_matches_templates(cached, templates):
        checkpoint()
        return "verified_cache"
    if not templates.templates:
        raise RuntimeError("未找到可验证媒体密钥的 V2 图片样本，无法执行导出前密钥获取")

    media_keys = _load_media_keys(account_dir)
    pair = _normalize_complete_image_key_payload({"xor_key": media_keys.get("xor"), "aes_key": media_keys.get("aes")})
    if pair is not None and verify_key_pair(*pair, templates):
        checkpoint()
        _persist_verified_image_keys(
            canonical_account=source.name, request_account=context.name,
            source_wxid_dir=source, matched_wxid=context.name,
            xor_key=pair[0], aes_key=pair[1], source="local_v2_verified",
        )
        return "local_v2_verified"

    checkpoint()
    result = asyncio.run(get_image_key_memory_workflow(
        account=context.name, wxid_dir=str(source), cancel_event=cancel_event,
        timeout=deadline - time.monotonic(),
    ))
    return result["source"]


def _sort_probe_database(path: Path) -> tuple[int, int, str]:
    name = path.name.lower()
    try:
        priority = DB_PROBE_NAME_PRIORITY.index(name)
    except ValueError:
        priority = len(DB_PROBE_NAME_PRIORITY)
    depth = len(path.parts)
    return priority, depth, str(path).lower()

DB_PROBE_NAME_PRIORITY = (
    "msg0.db",
    "msg.db",
    "micromsg.db",
    "favorite.db",
    "mediamsg0.db",
    "media_msg0.db",
    "sns.db",
)
