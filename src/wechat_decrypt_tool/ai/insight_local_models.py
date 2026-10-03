"""Pinned, explicit CPU model installation; no retries or provider fallback."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
import re
import time
import uuid

import httpx

from ..local_search.catalog import file_hash, verify_model
from ..local_search.downloads import copy_import_file
from .diagnostics import event

SPEC = json.loads((Path(__file__).parents[1] / 'resources/insight_local_model.json').read_text(encoding='utf-8'))


class LocalInsightModels:
    def __init__(self, root, store):
        self.root, self.store = Path(root).resolve(), store
        self.path = self.root / SPEC['id'] / SPEC['revision']
        self.job = None
        self.stopping = False
        self.lock = asyncio.Lock()
        saved = store.get('insight_local_model', SPEC['id'])
        self.record = saved if saved and saved['revision'] == SPEC['revision'] and saved['path'] == str(self.path) else {
            'id': SPEC['id'], 'revision': SPEC['revision'], 'path': str(self.path),
            'state': 'missing', 'downloaded_bytes': 0, 'error': None,
        }
        if self.record['state'] in {'downloading', 'verifying'}:
            self._save(state='paused')

    def _save(self, **values):
        self.record.update(values, updated=time.time())
        self.store.put('insight_local_model', self.record, id=SPEC['id'])

    def _file(self, name):
        path = self.path / name
        if path.is_symlink() or not path.resolve().is_relative_to(self.root):
            raise ValueError('模型目录含无效文件路径')
        return path

    def status(self):
        if self.record['state'] == 'ready':
            try:
                for item in SPEC['files']:
                    path = self._file(item['path'])
                    if not path.is_file() or path.stat().st_size != item['size']:
                        raise ValueError('模型文件缺失或大小已变化，请重新下载或导入')
            except (OSError, ValueError) as error:
                self._failed(error, 'LOCAL_MODEL_FILES_INVALID')
        return {**self.record, 'name': SPEC['name'], 'license': SPEC['license'],
                'total_bytes': sum(item['size'] for item in SPEC['files']),
                'device': 'cpu', 'context_window': SPEC['context_window']}

    def require_ready(self):
        if self.status()['state'] != 'ready':
            raise ValueError('本地 Laya 模型未就绪，请先下载或导入完整模型')
        return self.path

    async def download(self):
        async with self.lock:
            if self.stopping:
                raise ValueError('本地模型服务正在停止')
            if self.job and not self.job.done():
                return self.status()
            if self.status()['state'] == 'ready':
                return self.status()
            self._save(state='downloading', error=None, downloaded_bytes=0)
            self.job = asyncio.create_task(self._run(self._download))
            return self.status()

    async def import_model(self, path):
        source = Path(path).expanduser().resolve()
        if not source.is_dir():
            raise ValueError('请选择包含全部 Laya 模型文件的目录')
        async with self.lock:
            if self.stopping:
                raise ValueError('本地模型服务正在停止')
            await self._pause()
            self._save(state='verifying', error=None, downloaded_bytes=0)
            self.job = asyncio.create_task(self._run(self._import, source))
            return self.status()

    async def _thread(self, function, *args):
        """A stopped task cannot leave a verification thread reading live files."""
        operation = asyncio.create_task(asyncio.to_thread(function, *args))
        try:
            return await asyncio.shield(operation)
        except asyncio.CancelledError:
            # A real verification error still propagates if it occurred while stopping.
            await operation
            raise

    def _failed(self, error, code):
        diagnostic_id = uuid.uuid4().hex
        event('download.insight.failed', level=logging.ERROR, error=error, diagnostic_id=diagnostic_id,
              model=SPEC['id'])
        if isinstance(error, httpx.HTTPStatusError):
            message = f'下载服务返回 HTTP {error.response.status_code}，未自动重试'
        elif isinstance(error, ValueError):
            message = str(error)
        else:
            message = f'本地模型操作失败（{type(error).__name__}），请查看诊断记录'
        self._save(state='failed', error={'code': code, 'message': message, 'diagnostic_id': diagnostic_id})

    async def _run(self, operation, *args):
        try:
            await operation(*args)
            self._save(state='verifying')
            await self._thread(verify_model, self.path, SPEC)
            self._save(state='ready', error=None, downloaded_bytes=sum(item['size'] for item in SPEC['files']))
        except asyncio.CancelledError:
            self._save(state='paused')
            raise
        except Exception as error:
            self._failed(error, 'LOCAL_MODEL_DOWNLOAD_FAILED')

    async def _download(self):
        self.path.mkdir(parents=True, exist_ok=True)
        completed = 0
        # Downloads are explicit and anonymous; httpx performs no automatic retry.
        async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(60, connect=20),
                                    headers={'Accept-Encoding': 'identity'}) as client:
            for item in SPEC['files']:
                await self._download_file(client, item, completed)
                completed += item['size']
                self._save(downloaded_bytes=completed)

    async def _download_file(self, client, item, completed):
        path = self._file(item['path'])
        partial = self._file(item['path'] + '.part')
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file():
            if path.stat().st_size == item['size'] and await self._thread(file_hash, path) == item['sha256']:
                return
            # This is an explicit new download request repairing an invalid installation.
            path.unlink()
        if partial.is_file() and partial.stat().st_size >= item['size']:
            if partial.stat().st_size == item['size'] and await self._thread(file_hash, partial) == item['sha256']:
                partial.replace(path)
                return
            # A previous request retained a complete corrupt file. Explicit retry starts it over.
            partial.unlink()
        offset = partial.stat().st_size if partial.exists() else 0
        self.record['downloaded_bytes'] = completed + offset
        url = f'https://huggingface.co/{SPEC["repo"]}/resolve/{SPEC["revision"]}/{item["path"]}'
        headers = {'Range': f'bytes={offset}-'} if offset else {}
        async with client.stream('GET', url, headers=headers) as response:
            response.raise_for_status()
            if response.headers.get('content-encoding', 'identity') != 'identity':
                raise ValueError('下载响应编码不符合原始模型文件要求')
            if response.status_code == 206:
                match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('content-range', ''))
                if not match or tuple(map(int, match.groups())) != (offset, item['size'] - 1, item['size']):
                    raise ValueError('下载续传响应范围不一致，未追加文件')
                mode = 'ab' if offset else 'wb'
            elif response.status_code == 200:
                # A server may ignore Range. Its entire body replaces, never appends to, the partial.
                mode, offset = 'wb', 0
            else:
                raise ValueError(f'不支持的模型下载状态：HTTP {response.status_code}')
            content_length = response.headers.get('content-length')
            if content_length is not None and int(content_length) != item['size'] - offset:
                raise ValueError('下载响应长度与固定模型版本不符')
            last_progress = time.monotonic()
            with partial.open(mode) as stream:
                async for data in response.aiter_bytes(256 * 1024):
                    if offset + len(data) > item['size']:
                        raise ValueError('下载内容超出固定模型文件大小')
                    stream.write(data)
                    offset += len(data)
                    self.record['downloaded_bytes'] = completed + offset
                    if time.monotonic() - last_progress >= .25:
                        self._save(downloaded_bytes=completed + offset)
                        last_progress = time.monotonic()
            self._save(downloaded_bytes=completed + offset)
        if offset != item['size'] or await self._thread(file_hash, partial) != item['sha256']:
            raise ValueError('下载的模型文件未通过完整性校验，请重新下载或导入')
        partial.replace(path)

    async def _import(self, source):
        await self._thread(verify_model, source, SPEC)
        self.path.mkdir(parents=True, exist_ok=True)
        completed = 0
        for item in SPEC['files']:
            destination = self._file(item['path'])
            destination.parent.mkdir(parents=True, exist_ok=True)
            self._file(item['path'] + '.importing')
            if destination.resolve() != (source / item['path']).resolve():
                await copy_import_file(source / item['path'], destination)
            completed += item['size']
            self._save(downloaded_bytes=completed)

    async def _pause(self):
        if self.job and not self.job.done():
            self.job.cancel()
            try:
                await self.job
            except asyncio.CancelledError:
                # Also covers cancelling before the coroutine entered its first instruction.
                self._save(state='paused')

    async def pause(self):
        async with self.lock:
            await self._pause()
            return self.status()

    async def stop(self):
        self.stopping = True
        await self.pause()
