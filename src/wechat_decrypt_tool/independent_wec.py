"""WEC1 streaming AEAD, verified against pinned native public fixtures.

The file/atomic-publication boundary lives in export_crypto. This module
has no native runtime, lease, account key, or signature-authority dependency.
See tests/fixtures/wec1/README.md for format and interoperability provenance.
"""
from __future__ import annotations

import hashlib
import secrets
import struct

from Crypto.Cipher import ChaCha20_Poly1305

from dataclasses import dataclass, field

_HEADER = struct.Struct('<4sHHIIQQII24s')
_RECORD = struct.Struct('<QQII')
_KEY_DOMAIN = b'WCE-EXPORT-CONTENT-KEY-V1'


class WecFormatError(ValueError):
    """The WEC1 record stream is malformed, incomplete, or already closed."""


class WecAuthenticationError(ValueError):
    """The supplied key or the authenticated header/record does not match."""


@dataclass(frozen=True)
class EncryptedExportHeader:
    export_id: str
    plaintext_size: int
    chunk_size: int
    chunk_count: int
    salt: bytes = field(repr=False)
    encoded: bytes = field(repr=False)


def parse_encrypted_export_header(
    payload: bytes,
    *,
    expected_export_id: str | None = None,
    expected_plaintext_size: int | None = None,
) -> EncryptedExportHeader:
    raw = bytes(payload)
    if len(raw) < 65 or len(raw) > 192:
        raise WecFormatError("WEC1 encrypted export header has an invalid size.")
    (
        magic,
        version,
        algorithm,
        header_size,
        chunk_size,
        plaintext_size,
        chunk_count,
        export_id_size,
        reserved,
        salt,
    ) = struct.unpack_from("<4sHHIIQQII24s", raw, 0)
    if (
        magic != b"WEC1"
        or version != 1
        or algorithm != 1
        or header_size != len(raw)
        or header_size != 64 + export_id_size
        or not 1 <= export_id_size <= 128
        or reserved != 0
        or not 64 * 1024 <= chunk_size <= 768 * 1024
        or plaintext_size <= 0
        or plaintext_size > 256 * 1024 * 1024 * 1024
    ):
        raise WecFormatError("WEC1 encrypted export header is invalid.")
    expected_chunks = (plaintext_size + chunk_size - 1) // chunk_size
    if chunk_count != expected_chunks:
        raise WecFormatError("WEC1 encrypted export chunk count is invalid.")
    try:
        export_id = raw[64:].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WecFormatError("WEC1 encrypted export id is not UTF-8.") from exc
    if not export_id or any(ord(value) < 0x20 or ord(value) == 0x7F for value in export_id):
        raise WecFormatError("WEC1 encrypted export id contains control characters.")
    if expected_export_id is not None and export_id != expected_export_id:
        raise WecFormatError("WEC1 encrypted export id does not match the request.")
    if expected_plaintext_size is not None and plaintext_size != int(expected_plaintext_size):
        raise WecFormatError("WEC1 encrypted export size does not match the request.")
    return EncryptedExportHeader(
        export_id=export_id,
        plaintext_size=int(plaintext_size),
        chunk_size=int(chunk_size),
        chunk_count=int(chunk_count),
        salt=bytes(salt),
        encoded=raw,
    )


class _WecSession:
    def __init__(self, header: EncryptedExportHeader, content_key, *, decrypt: bool):
        with memoryview(content_key) as key_view:
            if key_view.nbytes != 32:
                raise ValueError('content_key must contain exactly 32 bytes')
        self.header = header
        self._key = bytearray(hashlib.blake2b(
            _KEY_DOMAIN + header.encoded, key=content_key, digest_size=32,
        ).digest())
        self._decrypt = decrypt
        self._index = 0
        self._offset = 0
        self.closed = False

    def write(self, payload: bytes | bytearray | memoryview) -> bytes:
        if self.closed:
            raise WecFormatError('WEC1 session is closed')
        try:
            expected = min(self.header.chunk_size, self.header.plaintext_size - self._offset)
            if expected <= 0:
                raise WecFormatError('WEC1 stream is already complete')
            raw = bytes(payload)
            prefix = _RECORD.pack(self._index, self._offset, expected, 0)
            if self._decrypt:
                if len(raw) != expected + 40 or raw[:24] != prefix:
                    raise WecFormatError('WEC1 record index, offset, size, or reserved field is invalid')
            elif len(raw) != expected:
                raise WecFormatError('WEC1 plaintext record size does not match the header')
            nonce = self.header.salt[:16] + self._index.to_bytes(8, 'little')
            cipher = ChaCha20_Poly1305.new(key=self._key, nonce=nonce)
            cipher.update(prefix)
            if self._decrypt:
                try:
                    result = cipher.decrypt_and_verify(raw[40:], raw[24:40])
                except ValueError as exc:
                    raise WecAuthenticationError('WEC1 authentication failed: incorrect key or modified data') from exc
            else:
                ciphertext, tag = cipher.encrypt_and_digest(raw)
                result = prefix + tag + ciphertext
            self._index += 1
            self._offset += expected
            return result
        except BaseException:
            self.abort()
            raise

    def finish(self) -> None:
        if self.closed:
            raise WecFormatError('WEC1 session is closed')
        try:
            if self._index != self.header.chunk_count or self._offset != self.header.plaintext_size:
                raise WecFormatError('WEC1 stream is incomplete')
        finally:
            self.abort()

    def abort(self) -> None:
        # Wipe the mutable key buffer owned by this session. Python and the
        # crypto provider may hold temporary copies; this is not secure-heap erasure.
        self._key[:] = b'\0' * len(self._key)
        self.closed = True


def begin_encrypted_export(
    export_id: str,
    *,
    plaintext_size: int,
    content_key: bytes | bytearray | memoryview,
    chunk_size: int,
) -> _WecSession:
    if not 1 <= plaintext_size <= 2**38:
        raise WecFormatError('WEC1 plaintext size must be between 1 and 274877906944')
    if not 65536 <= chunk_size <= 786432:
        raise WecFormatError('WEC1 chunk size must be between 65536 and 786432')
    identity = export_id.encode('utf-8')
    if not 1 <= len(identity) <= 128:
        raise WecFormatError('WEC1 export identity must contain 1 to 128 UTF-8 bytes')
    count = (plaintext_size + chunk_size - 1) // chunk_size
    encoded = _HEADER.pack(b'WEC1', 1, 1, 64 + len(identity), chunk_size,
                           plaintext_size, count, len(identity), 0,
                           secrets.token_bytes(24)) + identity
    header = parse_encrypted_export_header(encoded)
    return _WecSession(header, content_key, decrypt=False)


def begin_decrypted_export(
    header: EncryptedExportHeader,
    *,
    content_key: bytes | bytearray | memoryview,
) -> _WecSession:
    # A dataclass can be constructed directly; take all values from its validated
    # encoded header so metadata cannot disagree with the KDF input.
    validated = parse_encrypted_export_header(header.encoded)
    return _WecSession(validated, content_key, decrypt=True)
