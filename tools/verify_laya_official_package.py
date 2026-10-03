"""Explicit official ZIP acceptance, separate from the product's Hugging Face downloader."""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import stat
import time
import zipfile

import httpx

from wechat_decrypt_tool.ai.insight_local_models import LocalInsightModels, SPEC
from wechat_decrypt_tool.ai.storage import AIStore
from wechat_decrypt_tool.local_search.catalog import file_hash, verify_model

URL = 'https://github.com/tswawa/WechatVibe/releases/download/v1.2.0/WechatVibe-Laya-model-v1.zip'
BYTES = 599362786
SHA256 = 'abdd8bc363726e40a94e77750d09828cd681e08876e13c9be6ef776a3a24c4af'
MINIMUM_RATE = 200_000


async def probe(client, root):
    started = time.monotonic()
    async with asyncio.timeout(30), client.stream('GET', URL, headers={'Range': 'bytes=0-1048575'}) as response:
        headers_at = time.monotonic()
        result = {'status': response.status_code, 'host': response.url.host,
                  'content_range': response.headers.get('content-range')}
        if response.status_code != 206 or result['content_range'] != f'bytes 0-1048575/{BYTES}':
            raise ValueError('官方 ZIP 1MiB 探测未返回精确的206范围，未启动完整下载')
        count = 0
        with (root / 'official-probe-1mib.bin').open('wb') as stream:
            async for chunk in response.aiter_bytes(65536):
                if count + len(chunk) > 1048576:
                    raise ValueError('官方 ZIP 探测超出请求范围')
                stream.write(chunk)
                count += len(chunk)
        elapsed = time.monotonic() - headers_at
        result.update(bytes=count, seconds=round(time.monotonic() - started, 3),
                      body_seconds=round(elapsed, 3), body_bytes_per_second=round(count / elapsed))
        if count != 1048576:
            raise ValueError('官方 ZIP 探测未收到完整1MiB')
        return result


async def download(client, root, state):
    partial = root / 'official-package.zip.part'
    async with client.stream('GET', URL) as response:
        response.raise_for_status()
        state.update(status=response.status_code, host=response.url.host,
                     content_length=response.headers.get('content-length'))
        if response.status_code != 200 or state['content_length'] != str(BYTES):
            raise ValueError('官方 ZIP 完整下载响应与固定包长度不一致')
        checkpoint, previous = time.monotonic(), 0
        with partial.open('wb') as stream:
            async for chunk in response.aiter_bytes(256 * 1024):
                count = state['downloaded_bytes'] + len(chunk)
                if count > BYTES:
                    raise ValueError('官方 ZIP 内容超过固定包大小')
                stream.write(chunk)
                state['downloaded_bytes'] = count
                interval = time.monotonic() - checkpoint
                if interval >= 60:
                    rate = (count - previous) / interval
                    state['recent_bytes_per_second'] = round(rate)
                    if rate < MINIMUM_RATE:
                        raise ValueError('官方 ZIP 连续60秒平均速度低于200KB/s，下载已停止且保留partial')
                    checkpoint, previous = time.monotonic(), count
    if partial.stat().st_size != BYTES:
        raise ValueError('官方 ZIP 下载长度不完整')
    digest = await asyncio.to_thread(file_hash, partial)
    if digest != SHA256:
        raise ValueError('官方 ZIP SHA256不匹配，未解压或导入')
    archive = root / 'official-package.zip'
    partial.replace(archive)
    return archive


def extract(archive, root):
    destination = (root / 'official-package').resolve()
    if not destination.is_relative_to(root) or destination == root:
        raise ValueError('官方 ZIP 解压目录越出隔离验收目录')
    expected = {'laya/' + item['path']: item for item in SPEC['files']}
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) != len(expected) or {item.filename for item in entries} != set(expected):
            raise ValueError('官方 ZIP 文件清单与固定6文件不一致')
        for item in entries:
            path = (destination / item.filename).resolve()
            if not path.is_relative_to(destination) or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError('官方 ZIP 含越界路径或符号链接')
            if item.file_size != expected[item.filename]['size']:
                raise ValueError('官方 ZIP 内文件大小与固定模型版本不一致')
        for item in entries:
            path = (destination / item.filename).resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            with package.open(item) as source, path.open('wb') as target:
                shutil.copyfileobj(source, target, 1024 * 1024)
    source = destination / 'laya'
    verify_model(source, SPEC)
    return source


async def main(root):
    started = time.monotonic()
    report = {'source': URL, 'started': datetime.now(timezone.utc).isoformat(), 'passed': False,
              'expected_bytes': BYTES, 'expected_sha256': SHA256, 'model_revision': SPEC['revision']}
    manager = None
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(60, connect=20),
                                    headers={'Accept-Encoding': 'identity'}) as client:
            report['probe'] = await probe(client, root)
            print(json.dumps({'probe': report['probe']}, ensure_ascii=False), flush=True)
            if report['probe']['body_bytes_per_second'] < MINIMUM_RATE:
                raise ValueError('官方 ZIP 1MiB探测速度低于200KB/s，未启动完整下载')
            report['download'] = state = {'downloaded_bytes': 0, 'total_bytes': BYTES}
            job = asyncio.create_task(download(client, root, state))
            while not job.done():
                print(json.dumps(state, ensure_ascii=False), flush=True)
                try:
                    await asyncio.wait_for(asyncio.shield(job), timeout=10)
                except asyncio.TimeoutError:
                    continue
            archive = await job
        report['archive_sha256_verified'] = True
        source = await asyncio.to_thread(extract, archive, root)
        report['extracted_files_verified'] = True
        manager = LocalInsightModels(root / 'models', AIStore(root / 'ai'))
        await manager.import_model(str(source))
        await manager.job
        report['installation'] = manager.status()
        report['passed'] = report['installation']['state'] == 'ready'
    except Exception as error:
        report['error_type'] = type(error).__name__
        if isinstance(error, ValueError):
            report['error'] = str(error)
        if isinstance(error, httpx.HTTPStatusError):
            report['http_status'] = error.response.status_code
    finally:
        if manager:
            await manager.stop()
        report['seconds'] = round(time.monotonic() - started, 3)
        report['finished'] = datetime.now(timezone.utc).isoformat()
        (root / 'official-package-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    parent = Path(__file__).resolve().parents[1] / 'tmp'
    if root == parent or not root.is_relative_to(parent):
        parser.error('--root must be a child of this repository tmp/ directory')
    root.mkdir(parents=True, exist_ok=True)
    raise SystemExit(asyncio.run(main(root)))
