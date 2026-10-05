"""Isolated WXGF decoding, preserving native frame timing, loops and alpha.

The bundled x64 codec's 32-byte options and metadata ABI are documented in
tests/fixtures/wxgf/README.md. No application/native-core runtime is imported.
"""
import ctypes
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Callable, NamedTuple

from PIL import Image, UnidentifiedImageError


DLL_PATH = Path(__file__).resolve().parent / "native" / "VoipEngine.dll"
DECODE_TIMEOUT_SECONDS = 30
MAX_OUTPUT_BYTES = 52 * 1024 * 1024


class _WxAMConfig(ctypes.Structure):
    # The export copies two 16-byte blocks, including the optional pointer at 24.
    _fields_ = [("mode", ctypes.c_int), ("reserved", ctypes.c_int * 7)]


class _WxGFMetadata(NamedTuple):
    width: int
    height: int
    frames: int
    alpha: bool
    loop: int
    delays: tuple[int, ...]

    @property
    def animated(self) -> bool:
        return self.frames > 1 or self.loop > 0


def _read_metadata(library, input_buffer, input_size: int) -> _WxGFMetadata:
    info = (ctypes.c_int * 13)()
    get_info = library.wxam_dec_getWXGFInfo_5
    get_info.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    get_info.restype = ctypes.c_int
    result = get_info(input_buffer, input_size, info)
    if result != 0:
        raise RuntimeError(f"WXGF metadata decoder returned {result}")
    if info[0] <= 0 or info[1] <= 0 or info[2] <= 0:
        raise ValueError(f"WXGF invalid dimensions/frame count: {tuple(info[:3])}")
    metadata = _WxGFMetadata(info[0], info[1], info[2], bool(info[3]), info[8], ())
    if not metadata.animated:
        return metadata

    init = library.wxam_dec_init_5
    init.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
    init.restype = ctypes.c_void_p
    decode = library.wxam_dec_decode_buffer_5
    decode.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                       ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
    decode.restype = ctypes.c_int
    get_option = library.wxam_dec_get_option_5
    get_option.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_int,
                           ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    get_option.restype = ctypes.c_int
    uninit = library.wxam_dec_uninit_5
    uninit.argtypes = [ctypes.c_void_p]
    uninit.restype = ctypes.c_int
    error = ctypes.c_int()
    handle = init(3, None, None, ctypes.byref(error))
    if not handle:
        raise RuntimeError(f"WXGF metadata initialization failed: {error.value}")
    try:
        if error.value:
            raise RuntimeError(f"WXGF metadata initialization failed: {error.value}")
        result = decode(handle, input_buffer, input_size, 1, None, ctypes.byref(error))
        if result != 0 or error.value != 0:
            raise RuntimeError(f"WXGF animation metadata failed: result={result}, error={error.value}")
        delays = []
        for index in range(metadata.frames):
            frame_index = ctypes.c_int(index)
            delay = ctypes.c_int()
            result = get_option(handle, 9, ctypes.byref(delay), 4,
                                ctypes.byref(frame_index), 4, ctypes.byref(error))
            if result != 0 or error.value != 0:
                raise RuntimeError(f"WXGF frame {index} timing failed: result={result}, error={error.value}")
            delays.append(delay.value)
        return metadata._replace(delays=tuple(delays))
    finally:
        result = uninit(handle)
        if result != 0:
            raise RuntimeError(f"WXGF metadata cleanup returned {result}")


def _decode_with_dll(data: bytes, dll_path: Path) -> bytes:
    library = ctypes.WinDLL(str(dll_path))
    input_buffer = ctypes.create_string_buffer(data, len(data))
    metadata = _read_metadata(library, input_buffer, len(data))
    decode = library.wxam_dec_wxam2pic_5
    decode.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                       ctypes.POINTER(ctypes.c_int), ctypes.c_void_p]
    decode.restype = ctypes.c_int
    mode = 3 if metadata.animated else (1 if metadata.alpha else 0)
    config = _WxAMConfig(mode)
    output_buffer = ctypes.create_string_buffer(MAX_OUTPUT_BYTES)
    output_size = ctypes.c_int(MAX_OUTPUT_BYTES)
    result = decode(ctypes.addressof(input_buffer), len(data),
                    ctypes.addressof(output_buffer), ctypes.byref(output_size),
                    ctypes.addressof(config))
    if result != 0:
        raise RuntimeError(f"WXGF mode-{mode} decoder returned {result}")
    if not 0 < output_size.value <= MAX_OUTPUT_BYTES:
        raise ValueError(f"WXGF decoder reported invalid output length: {output_size.value}")
    decoded = output_buffer.raw[:output_size.value]
    _validate_metadata(decoded, metadata)
    return decoded


def _validate_metadata(decoded: bytes, metadata: _WxGFMetadata) -> None:
    with Image.open(io.BytesIO(decoded)) as image:
        image.verify()
    with Image.open(io.BytesIO(decoded)) as image:
        if image.size != (metadata.width, metadata.height):
            raise ValueError(f"WXGF decoded dimensions mismatch: {image.size}")
        if getattr(image, "n_frames", 1) != metadata.frames:
            raise ValueError(f"WXGF decoded frame count mismatch: expected {metadata.frames}")
        if metadata.alpha and "A" not in image.getbands() and "transparency" not in image.info:
            raise ValueError("WXGF decoded alpha channel is missing")
        if metadata.animated and image.info.get("loop") != metadata.loop:
            raise ValueError(f"WXGF decoded loop count mismatch: expected {metadata.loop}")
        for index in range(metadata.frames):
            image.seek(index)
            image.load()
            if metadata.animated and image.info.get("duration") != metadata.delays[index]:
                raise ValueError(f"WXGF frame {index} duration mismatch: expected {metadata.delays[index]}")


def decode_wxgf(data: bytes, *, checkpoint: Callable[[], None] | None = None) -> bytes:
    """Return a validated image; codec failures, crashes and cancellation propagate."""
    if not data.startswith(b"wxgf"):
        raise ValueError("Invalid WXGF header")
    if len(data) > 0x7fffffff:
        raise ValueError("WXGF input exceeds the codec's signed 32-bit length")
    if getattr(sys, "frozen", False):
        raise RuntimeError("WXGF local decoding requires the Python backend; frozen backend worker is not packaged")
    if sys.platform != "win32":
        raise RuntimeError("WXGF local decoding requires Windows and VoipEngine.dll")
    if not DLL_PATH.is_file():
        raise FileNotFoundError(f"WXGF decoder DLL not found: {DLL_PATH}")

    with tempfile.TemporaryDirectory(prefix="xwechat-wxgf-") as directory:
        source = Path(directory) / "input.wxgf"
        output = Path(directory) / "output.image"
        source.write_bytes(data)
        if checkpoint:
            checkpoint()
        with subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), str(source), str(output)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        ) as process:
            deadline = time.monotonic() + DECODE_TIMEOUT_SECONDS
            try:
                while True:
                    if checkpoint:
                        checkpoint()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f"WXGF decoding exceeded {DECODE_TIMEOUT_SECONDS} seconds")
                    try:
                        _, stderr = process.communicate(timeout=min(0.1, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        continue
                if checkpoint:
                    checkpoint()
                if process.returncode != 0:
                    error = stderr.decode("utf-8", errors="replace").strip()
                    raise RuntimeError(f"WXGF decoder worker exited {process.returncode}: {error}")
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate()
        decoded = output.read_bytes()
        if not 0 < len(decoded) <= MAX_OUTPUT_BYTES:
            raise ValueError(f"WXGF decoder produced invalid output length: {len(decoded)}")
        try:
            with Image.open(io.BytesIO(decoded)) as image:
                image.verify()
            with Image.open(io.BytesIO(decoded)) as image:
                for frame in range(getattr(image, "n_frames", 1)):
                    image.seek(frame)
                    image.load()
        except (OSError, ValueError, SyntaxError, UnidentifiedImageError) as exc:
            raise ValueError("Invalid WXGF decoded image") from exc
        if checkpoint:
            checkpoint()
        return decoded


if __name__ == "__main__":
    # Run as a file so the child imports neither package startup nor a broker.
    if len(sys.argv) != 3:
        raise ValueError("WXGF worker requires input and output paths")
    Path(sys.argv[2]).write_bytes(_decode_with_dll(Path(sys.argv[1]).read_bytes(), DLL_PATH))
