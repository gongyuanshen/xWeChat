"""Explicit, cancellable H.264 previews; original media is never rewritten."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from typing import Awaitable, Callable

from .independent_video import validate_mp4_boxes, validate_video

PREVIEW_TIMEOUT_SECONDS = 120
_PROFILE = b'h264-yuv420p-crf23-fast-aac128-faststart-v1'


class VideoPreviewError(ValueError):
    """A requested preview cannot be generated or its cache is invalid."""


class VideoPreviewCancelled(VideoPreviewError):
    """The requester cancelled or disconnected."""


def _digest(path: Path, checkpoint: Callable[[], None] = lambda: None) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while data := handle.read(1024 * 1024):
            checkpoint()
            digest.update(data)
    return digest.hexdigest()


def verified_preview(cache_dir: Path, key: str) -> Path:
    if not re.fullmatch(r'[0-9a-f]{64}', key):
        raise VideoPreviewError('Invalid video preview identifier')
    entry = cache_dir / key
    path = entry / 'preview.mp4'
    if not entry.is_dir():
        raise FileNotFoundError('Video preview not found')
    try:
        metadata = json.loads((entry / 'manifest.json').read_text(encoding='utf-8'))
        if metadata['profile'] != _PROFILE.decode() or metadata['sha256'] != _digest(path):
            raise VideoPreviewError('Video preview checksum or profile mismatch')
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise VideoPreviewError('Invalid video preview cache manifest or file') from exc
    return path


def _create(source: Path, cache_dir: Path, ffmpeg: str, checkpoint: Callable[[], None]) -> Path:
    checkpoint()
    source_digest = _digest(source, checkpoint)
    # Account-local storage and source identity prevent reuse across media bindings.
    key = hashlib.sha256(str(source.resolve()).encode('utf-8') + source_digest.encode() + _PROFILE).hexdigest()
    entry = cache_dir / key
    if not ffmpeg and not entry.exists():
        raise VideoPreviewError('Video preview requires FFmpeg; configure WECHAT_TOOL_FFMPEG')
    try:
        validate_mp4_boxes(source.read_bytes(), source=source)
    except ValueError as exc:
        raise VideoPreviewError(str(exc)) from exc
    if entry.exists():
        return verified_preview(cache_dir, key)
    cache_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.preview-', dir=cache_dir) as temporary:
        stage = Path(temporary)
        output = stage / 'preview.mp4'
        with (stage / 'ffmpeg.log').open('w+b') as errors:
            try:
                process = subprocess.Popen(
                    [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
                     '-err_detect', 'explode', '-abort_on', 'empty_output_stream',
                     '-protocol_whitelist', 'file', '-i', str(source),
                     '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast',
                     '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
                     '-movflags', '+faststart', str(output)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                )
            except OSError as exc:
                raise VideoPreviewError(f'Cannot start video preview FFmpeg: {exc}') from exc
            try:
                while process.poll() is None:
                    checkpoint()
                    try:
                        process.wait(timeout=.1)
                    except subprocess.TimeoutExpired:
                        continue
                checkpoint()
                if process.returncode != 0:
                    errors.seek(0)
                    detail = errors.read().decode('utf-8', errors='replace').strip()
                    raise VideoPreviewError(f'Video preview FFmpeg exited {process.returncode}: {detail}')
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
        if not output.is_file() or output.stat().st_size == 0:
            raise VideoPreviewError('Video preview FFmpeg produced no video')
        # Reuse full MP4 bounds and frame decoding validation before publishing.
        try:
            validate_video(output.read_bytes(), ffmpeg=ffmpeg, source=output, checkpoint=checkpoint)
        except (ValueError, RuntimeError, OSError) as exc:
            if isinstance(exc, VideoPreviewError):
                raise
            raise VideoPreviewError(f'Video preview validation failed: {exc}') from exc
        if _digest(source, checkpoint) != source_digest:
            raise VideoPreviewError('Video source changed while generating preview')
        metadata = {'profile': _PROFILE.decode(), 'sha256': _digest(output, checkpoint),
                    'source_sha256': source_digest}
        (stage / 'manifest.json').write_text(json.dumps(metadata), encoding='utf-8')
        (stage / 'ffmpeg.log').unlink()
        checkpoint()
        # Publish the validated video and manifest together, never a partial MP4.
        if entry.exists():
            return verified_preview(cache_dir, key)
        os.rename(stage, entry)
    return entry / 'preview.mp4'


async def create_video_preview(
    source: Path, cache_dir: Path, ffmpeg: str,
    is_disconnected: Callable[[], Awaitable[bool]],
) -> Path:
    cancel = threading.Event()
    deadline = time.monotonic() + PREVIEW_TIMEOUT_SECONDS

    def checkpoint():
        if cancel.is_set():
            raise VideoPreviewCancelled('Video preview cancelled')
        if time.monotonic() >= deadline:
            raise VideoPreviewError(f'Video preview exceeded {PREVIEW_TIMEOUT_SECONDS} seconds')

    worker = asyncio.create_task(asyncio.to_thread(_create, source, cache_dir, ffmpeg, checkpoint))
    try:
        while not worker.done():
            if await is_disconnected():
                cancel.set()
            await asyncio.sleep(.05)
        return await worker
    except BaseException as original_error:
        cancel.set()
        # Keep ownership until cleanup finishes, including repeated task cancellation
        # or a failure in the request-disconnect monitor.
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except BaseException:
                break
        try:
            worker.result()
        except VideoPreviewCancelled:
            pass  # Expected worker cleanup; re-raise the original request failure.
        except BaseException as worker_error:
            if worker_error is not original_error:
                raise original_error from worker_error
        raise
