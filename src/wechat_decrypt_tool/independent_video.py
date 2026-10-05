"""Verify exported videos with the application's existing FFmpeg dependency."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
from typing import Callable


VALIDATION_TIMEOUT_SECONDS = 120


def validate_mp4_boxes(data: bytes, *, source: Path) -> None:
    # FFmpeg deliberately tolerates a truncated index after the last frame.
    # Enforce the declared top-level box bounds before asking it to decode.
    # Box sizes: FFmpeg n6.1.1 libavformat/mov.c, mov_read_default/mov_probe.
    offset = 0
    while offset < len(data):
        if len(data) - offset < 8:
            raise ValueError(f"Invalid video media: {source}; truncated MP4 box at {offset}")
        size = int.from_bytes(data[offset:offset + 4], "big")
        header_size = 8
        if size == 1:
            header_size = 16
            if len(data) - offset < header_size:
                raise ValueError(f"Invalid video media: {source}; truncated extended MP4 box at {offset}")
            size = int.from_bytes(data[offset + 8:offset + 16], "big")
        elif size == 0:
            size = len(data) - offset
        if size < header_size or size > len(data) - offset:
            raise ValueError(f"Invalid video media: {source}; invalid MP4 box size at {offset}")
        offset += size


def validate_video(
    data: bytes, *, ffmpeg: str, source: Path,
    checkpoint: Callable[[], None] | None = None,
) -> None:
    validate_mp4_boxes(data, source=source)

    if not ffmpeg:
        raise RuntimeError("Video validation requires FFmpeg; set WECHAT_TOOL_FFMPEG or add ffmpeg to PATH")

    # A seekable input is required for MP4 files with metadata after the media
    # payload. Validate exactly the bytes that the caller will write to export.
    with tempfile.TemporaryDirectory(prefix="xwechat-video-") as directory:
        path = Path(directory) / "input.mp4"
        path.write_bytes(data)
        if checkpoint:
            checkpoint()
        with subprocess.Popen(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                 "-xerror", "-err_detect", "explode", "-abort_on", "empty_output_stream",
                 "-protocol_whitelist", "file", "-i", str(path),
                 "-map", "0:v", "-map", "0:a?", "-f", "null", "-"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        ) as process:
            deadline = time.monotonic() + VALIDATION_TIMEOUT_SECONDS
            try:
                while True:
                    if checkpoint:
                        checkpoint()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f"Video validation exceeded {VALIDATION_TIMEOUT_SECONDS} seconds: {source}")
                    try:
                        _, stderr = process.communicate(timeout=min(0.1, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        continue
                if checkpoint:
                    checkpoint()
                if process.returncode != 0:
                    error = stderr.decode("utf-8", errors="replace").strip()
                    raise ValueError(f"Invalid video media: {source}; FFmpeg exited {process.returncode}: {error}")
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate()
