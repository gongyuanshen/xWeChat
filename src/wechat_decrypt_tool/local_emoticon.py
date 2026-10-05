"""Read the account-encrypted local emoticon cache without modifying it.

The CBC rule is independently validated against Weixin 4.1.15.13 and real
Persist / PersistStore files. Store offsets address the decrypted container.
The requested original MD5 and WXGF's indexed extern_md5 are distinct identities.
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

from .image_key_resolver import clean_wxid, derive_image_keys, enumerate_kvcomm_codes


class LocalEmoticonError(ValueError):
    """A local emoticon's account key, container, or indexed identity is invalid."""


@dataclass(frozen=True)
class _Resource:
    path: Path
    original_md5: str
    external_md5: str = ""
    offset: int | None = None
    size: int | None = None


def _md5(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", value):
        raise LocalEmoticonError("Invalid local emoticon MD5")
    return value.lower()


def _persist_path(wxid_dir: Path, category: str, digest: str) -> Path:
    return Path(wxid_dir) / "business" / "emoticon" / category / digest[:2] / digest


def is_local_emoticon_path(path: Path, wxid_dir: Path) -> bool:
    try:
        parts = Path(path).resolve().relative_to(Path(wxid_dir).resolve()).parts
    except ValueError:
        return False
    if len(parts) != 5 or not re.fullmatch(r"[0-9a-fA-F]{32}", parts[-1]):
        return False
    if parts[-2].lower() != parts[-1][:2].lower():
        return False
    return (
        parts[:2] == ("business", "emoticon") and parts[2] in {"Persist", "PersistStore"}
    ) or (
        parts[0] == "cache" and re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", parts[1]) is not None
        and parts[2] == "Emoticon"
    )


def _standalone_path(wxid_dir: Path, digest: str) -> Path | None:
    path = _persist_path(wxid_dir, "Persist", digest)
    if path.is_file():
        return path
    cache = Path(wxid_dir) / "cache"
    if not cache.is_dir():
        return None
    for month in sorted(cache.iterdir(), reverse=True):
        if not re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", month.name) or not month.is_dir():
            continue
        path = month / "Emoticon" / digest[:2] / digest
        if path.is_file():
            return path
    return None


def _find_resource(db_path: Path, wxid_dir: Path, requested_md5: str) -> _Resource | None:
    digest = _md5(requested_md5)
    nonstore = []
    packages = []
    if Path(db_path).is_file():
        with closing(sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "kNonStoreEmoticonTable" in tables:
                nonstore = db.execute(
                    "SELECT DISTINCT md5, extern_md5 FROM kNonStoreEmoticonTable "
                    "WHERE lower(md5)=? OR lower(extern_md5)=?", (digest, digest)
                ).fetchall()
            if "kStoreEmoticonFilesTable" in tables:
                packages = db.execute(
                    "SELECT DISTINCT package_id_, md5_, emoticon_offset_, emoticon_size_ "
                    "FROM kStoreEmoticonFilesTable WHERE lower(md5_)=?", (digest,)
                ).fetchall()
    candidates: set[_Resource] = set()
    for original, external in nonstore:
        original = _md5(original)
        external = _md5(external) if external else ""
        for name in dict.fromkeys((original, external)):
            if not name:
                continue
            path = _standalone_path(wxid_dir, name)
            if path is not None:
                candidates.add(_Resource(path, original, external))
    if not candidates:
        path = _standalone_path(wxid_dir, digest)
        if path is not None:
            candidates.add(_Resource(path, digest))
    if len(candidates) > 1:
        raise LocalEmoticonError("Ambiguous local emoticon resource or identity")
    if candidates:
        return next(iter(candidates))
    for package, original, offset, size in packages:
        if not isinstance(package, str) or not package:
            raise LocalEmoticonError("Invalid local emoticon package ID")
        if type(offset) is not int or type(size) is not int or offset < 0 or size <= 0:
            raise LocalEmoticonError("Invalid local emoticon package bounds")
        path = _persist_path(wxid_dir, "PersistStore", hashlib.md5(package.encode("utf-8")).hexdigest())
        if path.is_file():
            candidates.add(_Resource(path, _md5(original), offset=offset, size=size))
    if len(candidates) > 1:
        raise LocalEmoticonError("Ambiguous local emoticon packages for requested MD5")
    return next(iter(candidates)) if candidates else None


def find_local_emoticon(db_path: Path, wxid_dir: Path, md5: str) -> Path | None:
    resource = _find_resource(db_path, wxid_dir, md5)
    return resource.path if resource is not None else None


def _account_key(keys: dict[str, Any], wxid_dir: Path, kvcomm_dirs: Iterable[Path]) -> bytes:
    if keys.get("verified") is not True:
        raise LocalEmoticonError("Local emoticon requires verified account image keys")
    source = keys.get("source_wxid_dir")
    if not source or Path(source).resolve() != Path(wxid_dir).resolve():
        raise LocalEmoticonError("Local emoticon account key source does not match source directory")
    wxid = clean_wxid(keys.get("derived_wxid"))
    if not wxid or wxid == "unknown" or wxid != clean_wxid(Path(wxid_dir).name):
        raise LocalEmoticonError("Local emoticon key is not bound to the requested account")
    code = keys.get("code")
    if code is not None:
        if type(code) is not int or not 0 < code <= 0xFFFFFFFF:
            raise LocalEmoticonError("Invalid local emoticon account code")
        codes = {code}
    else:
        codes = set()
        for directory in kvcomm_dirs:
            # The legacy enumerator suppresses directory errors; expose them at this boundary.
            with os.scandir(directory) as entries:
                list(entries)
            codes.update(enumerate_kvcomm_codes(directory))
    matches = []
    for candidate in codes:
        derived = derive_image_keys(candidate, wxid)
        if derived.aes_key == keys.get("aes") and derived.xor_key == keys.get("xor"):
            matches.append(candidate)
    if len(matches) != 1:
        raise LocalEmoticonError("Local emoticon account code must uniquely match verified image keys")
    return hashlib.md5(f"{matches[0]}{wxid}EMOTICON".encode("utf-8")).digest()


def read_local_emoticon(
    path: Path, db_path: Path, wxid_dir: Path, md5: str, keys: dict[str, Any],
    *, kvcomm_dirs: Iterable[Path] = (), expected_extern_md5: str = "",
) -> bytes:
    resource = _find_resource(db_path, wxid_dir, md5)
    if resource is None or Path(path).resolve() != resource.path.resolve():
        raise LocalEmoticonError("Local emoticon path is not associated with the requested MD5")
    external_md5 = resource.external_md5
    if expected_extern_md5:
        expected_extern_md5 = _md5(expected_extern_md5)
        if external_md5 and external_md5 != expected_extern_md5:
            raise LocalEmoticonError("Local emoticon database and message external MD5 conflict")
        external_md5 = expected_extern_md5
    key = _account_key(keys, wxid_dir, kvcomm_dirs)
    encrypted = resource.path.read_bytes()
    if not encrypted or len(encrypted) % AES.block_size:
        raise LocalEmoticonError("Invalid local emoticon ciphertext block length")
    try:
        plaintext = unpad(AES.new(key, AES.MODE_CBC, iv=key).decrypt(encrypted), AES.block_size)
    except ValueError as error:
        raise LocalEmoticonError("Local emoticon decryption failed: invalid CBC padding") from error
    if resource.offset is not None:
        end = resource.offset + resource.size
        if end > len(plaintext):
            raise LocalEmoticonError("Local emoticon package bounds exceed decrypted container")
        plaintext = plaintext[resource.offset:end]
    actual_md5 = hashlib.md5(plaintext).hexdigest()
    if actual_md5 != resource.original_md5 and not (
        plaintext.startswith(b"wxgf") and actual_md5 == external_md5
    ):
        raise LocalEmoticonError("Local emoticon plaintext MD5 does not match its indexed identity")
    return plaintext
