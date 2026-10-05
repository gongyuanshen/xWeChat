"""Verify legacy ZIP signatures without loading their original signers.

The v2 P-256 pair may be accompanied by WES1/WES2 sidecars over the same
canonical manifest; all supplied signatures must verify. Import streams verify
every payload against the returned sizes and hashes before publication.
"""
from __future__ import annotations

import base64
import json
import re
import zipfile
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils

from .archive_checksums import (
    ArchiveChecksumError, _export_id, _files, _unique_json_object, validate_file_entries,
)
from .independent_wes import WesVerificationError, verify_export_seal


MANIFEST_PATH = "_integrity/manifest.wce"
SIGNATURE_PATH = "_integrity/signature.wce"
WES_MANIFEST_PATH = "_integrity/manifest.json"
WES_SIGNATURE_PATH = "_integrity/signature.wes"
_LEGACY_SIDECARS = frozenset({MANIFEST_PATH, SIGNATURE_PATH})
_WES_SIDECARS = frozenset({WES_MANIFEST_PATH, WES_SIGNATURE_PATH})
SIDECAR_PATHS = _LEGACY_SIDECARS | _WES_SIDECARS

# The original runtime_js() pins these coordinates for ECDSA P-256/SHA-256.
# Source extension SHA-256:
# 3e7a56653f052e561276d96b419336153353f7833991aa1a1dc85ae7e9c93ee4
# See tests/fixtures/legacy_wce/README.md and provenance.json. Archive-supplied
# public keys are never accepted. No signer/native client is loaded here.
_PUBLIC_X = "vb3wgoqIKct7sWWNozX84kBo-GostetwGX55WEOrl8A"
_PUBLIC_Y = "bRj71qxTuhbnK9zuljeLPSfTIP_VpyGcD-pGou4CRew"


def _unsupported_number(value: str) -> Any:
    raise ArchiveChecksumError(f"Legacy signature manifest contains an unsupported number: {value}")


def read_zip_legacy_signature(archive: zipfile.ZipFile) -> dict[str, dict[str, Any]]:
    """Authenticate the manifest, validate its schema and bind all ZIP payloads.

The native signer signs compact sorted-key UTF-8 JSON, while the sidecar holds
the pretty form of that same object. Reconstructing those bytes from the parsed
sidecar binds the signature to exactly the file records returned to the caller.
"""
    files = _files(archive, integrity_paths=SIDECAR_PATHS)
    if not _LEGACY_SIDECARS.issubset(files):
        raise ArchiveChecksumError("Legacy signature archive requires both manifest.wce and signature.wce")
    has_wes = bool(_WES_SIDECARS.intersection(files))
    if has_wes and not _WES_SIDECARS.issubset(files):
        raise ArchiveChecksumError("WES archive requires both manifest.json and signature.wes")
    try:
        manifest = json.loads(
            archive.read(files.pop(MANIFEST_PATH)).decode("utf-8"),
            object_pairs_hook=_unique_json_object,
            parse_float=_unsupported_number,
            parse_constant=_unsupported_number,
        )
        signature = archive.read(files.pop(SIGNATURE_PATH))
        canonical = json.dumps(
            manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
    except (OSError, EOFError, zipfile.BadZipFile, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ArchiveChecksumError("Legacy signature sidecars cannot be read as UTF-8 JSON and signature") from exc
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"a", "e", "f", "h", "p", "q", "v"}
        or type(manifest["v"]) is not int or manifest["v"] != 2
        or not isinstance(manifest["a"], dict)
        or set(manifest["a"]) != {"c", "cs", "i", "m", "r", "rs", "s"}
        or not all(isinstance(value, str) for value in manifest["a"].values())
        or not all(isinstance(manifest[name], list) for name in ("h", "p", "q"))
    ):
        raise ArchiveChecksumError("Legacy signature manifest format or version is unsupported")
    _export_id(manifest["e"])
    if not re.fullmatch(rb"[A-Za-z0-9_-]{86}(?:\r?\n)?", signature):
        raise ArchiveChecksumError("Legacy signature must be a base64url-encoded 64-byte P-256 signature")
    encoded = signature.rstrip(b"\r\n")
    raw = base64.b64decode(encoded + b"==", altchars=b"-_", validate=True)
    if base64.urlsafe_b64encode(raw).rstrip(b"=") != encoded:
        raise ArchiveChecksumError("Legacy signature has a noncanonical base64url encoding")
    public_key = ec.EllipticCurvePublicNumbers(
        int.from_bytes(base64.urlsafe_b64decode(_PUBLIC_X + "="), "big"),
        int.from_bytes(base64.urlsafe_b64decode(_PUBLIC_Y + "="), "big"),
        ec.SECP256R1(),
    ).public_key()
    der = utils.encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    try:
        public_key.verify(der, canonical, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise ArchiveChecksumError("Legacy signature verification failed for the pinned public key") from exc
    if has_wes:
        try:
            wes_manifest = archive.read(files.pop(WES_MANIFEST_PATH))
            envelope = archive.read(files.pop(WES_SIGNATURE_PATH))
        except (OSError, EOFError, zipfile.BadZipFile) as exc:
            raise ArchiveChecksumError("WES archive sidecars cannot be read") from exc
        if wes_manifest != canonical:
            raise ArchiveChecksumError("WES canonical manifest differs from the legacy signed manifest")
        try:
            verify_export_seal(envelope, wes_manifest, expected_export_id=manifest["e"])
        except WesVerificationError as exc:
            raise ArchiveChecksumError(str(exc)) from exc
    return validate_file_entries(files, manifest["f"])
