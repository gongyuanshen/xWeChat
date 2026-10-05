"""Verify historical WES1/WES2 export seals without loading the native runtime.

This profile is pinned to wcdb-prod-20260907-v240-6, whose client SHA-256 is
59fdf95ba7eae4bc20c971fd28f714f154a54c84ab0b06184af5eb15ad33a06f.
WES2 genuine compatibility vectors are in tests/fixtures/legacy_wes. WES1's
fixed-root certificate format is recovered from that same binary and covered
with controlled test roots; a genuine WES1 positive archive is not available.

The import policy checks signing time, so a valid historical archive continues
to verify after a build or lease expires. WES2 authenticates content under its
included device key; it does not certify the source device's external identity.
"""
from __future__ import annotations

import hashlib
import hmac
import struct
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils

_BUILD_HASH = hashlib.sha256(b"wcdb-prod-20260907-v240-6").digest()
_BUILD_ISSUED = 1788792288
_BUILD_EXPIRES = 1792680288
# Public P-256 coordinates, compiled at RVA 0x1e6e0 in the pinned client.
_ROOT_PUBLIC = bytes.fromhex(
    "5B3F802AE89FE96E6372119F2175A59718793367FCA211DE94B6AFE5F44556BF9"
    "5267AE2BD7A3A38BF37D661A71966372C16B830F032E47794DB2E62F7C1CDC9"
)
_HEADER = struct.Struct("<4sHHIIQQQII32s64s32s32s")
_LEASE = struct.Struct("<4sHHQQQQQ16s32s32s32s")


class WesVerificationError(ValueError):
    """A seal fails format, signature, or identity validation at a known stage."""

    def __init__(self, stage: str, status: int | None):
        self.stage = stage
        self.status = status  # Corresponding native format status, when applicable.
        super().__init__(f"WES verification failed: {stage}")


def _verify_signature(public: bytes, message: bytes, signature: bytes, stage: str) -> None:
    try:
        key = ec.EllipticCurvePublicNumbers(
            int.from_bytes(public[:32], "big"), int.from_bytes(public[32:], "big"), ec.SECP256R1(),
        ).public_key()
        der = utils.encode_dss_signature(
            int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big"),
        )
        key.verify(der, message, ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, ValueError) as exc:
        raise WesVerificationError(stage, -11) from exc


def verify_export_seal(
    envelope: bytes, manifest: bytes, *, expected_export_id: str,
) -> dict[str, Any]:
    """Verify exact manifest bytes and return metadata with an explicit trust kind.

    WES1 requires its lease certificate to verify under the pinned root. WES2
    has no such certificate and is reported as self_signed. The caller remains
    responsible for validating manifest schema and all covered payload bytes.
    """
    if (not 273 <= len(envelope) <= 624 or not manifest
            or manifest[:1] != b"{" or manifest[-1:] != b"}" or b"\0" in manifest):
        raise WesVerificationError("input", -1)
    try:
        manifest.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WesVerificationError("manifest_utf8", -1) from exc
    (magic, version, algorithm, manifest_format, reserved, sealed_at, expires,
     manifest_size, id_size, certificate_size, manifest_hash, device_public,
     build_hash, device_id) = _HEADER.unpack_from(envelope)
    if (magic, version) not in ((b"WES1", 1), (b"WES2", 2)):
        raise WesVerificationError("format", -3)
    if (algorithm != 1 or manifest_format != 1 or reserved != 0 or not 1 <= id_size <= 128
            or certificate_size != (224 if version == 1 else 0)
            or manifest_size != len(manifest)
            or len(envelope) != _HEADER.size + id_size + certificate_size + 64):
        raise WesVerificationError("layout", -3)
    identity_bytes = envelope[_HEADER.size:_HEADER.size + id_size]
    try:
        identity = identity_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WesVerificationError("export_id", -3) from exc
    if any(byte < 0x20 or byte == 0x7f for byte in identity_bytes):
        raise WesVerificationError("export_id", -3)
    if not hmac.compare_digest(hashlib.sha256(manifest).digest(), manifest_hash):
        raise WesVerificationError("manifest_digest", -11)
    derived_device_id = hashlib.sha256(b"WCE-DEVICE-ID-V1" + device_public).digest()
    if not hmac.compare_digest(derived_device_id, device_id):
        raise WesVerificationError("device_binding", -10)
    if version == 1:
        certificate = envelope[_HEADER.size + id_size:-64]
        (lease_magic, lease_version, lease_reserved, issued, not_before, lease_expires,
         counter, features, license_id, lease_device, lease_build, _startup_nonce) = _LEASE.unpack_from(certificate)
        if lease_magic != b"WCL1" or lease_version != 1 or lease_reserved != 0:
            raise WesVerificationError("root_certificate_format", -11)
        _verify_signature(_ROOT_PUBLIC, certificate[:160], certificate[160:], "root_signature")
        if (counter == 0 or not any(license_id) or lease_expires <= not_before
                or lease_expires <= issued or lease_expires - issued > 3888000
                or not max(issued, not_before) <= sealed_at <= lease_expires or expires != lease_expires):
            raise WesVerificationError("lease_window", -6)
        if not hmac.compare_digest(lease_build, _BUILD_HASH):
            raise WesVerificationError("lease_build_binding", -9)
        if not hmac.compare_digest(lease_device, device_id):
            raise WesVerificationError("lease_device_binding", -10)
        if not features & 2:
            raise WesVerificationError("lease_export_feature", -8)
        trust = "root_signed"
    else:
        if expires != _BUILD_EXPIRES or not _BUILD_ISSUED <= sealed_at <= _BUILD_EXPIRES:
            raise WesVerificationError("build_window", -6)
        features = 3
        trust = "self_signed"
    if not hmac.compare_digest(build_hash, _BUILD_HASH):
        raise WesVerificationError("build_binding", -9)
    _verify_signature(device_public, b"WCE-EXPORT-SEAL-V" + str(version).encode("ascii") + envelope[:-64],
                      envelope[-64:], "device_signature")
    if identity != expected_export_id:
        raise WesVerificationError("expected_export_id", None)
    return {
        "format": magic.decode("ascii"), "trust": trust, "time_policy": "historical_sealed_at",
        "export_id": identity, "manifest_format": manifest_format,
        "sealed_at_unix": sealed_at, "lease_expires_unix": expires, "feature_bits": features,
        "manifest_sha256": manifest_hash.hex(), "build_id": build_hash.hex(), "device_id": device_id.hex(),
    }
