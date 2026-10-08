"""Bounded eight-range official ZIP acceptance; no retry and no product source change."""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import time
from urllib.parse import urlsplit

import httpx

from verify_laya_official_package import URL, BYTES, SHA256, extract
from wechat_decrypt_tool.ai.insight_local_models import LocalInsightModels
from wechat_decrypt_tool.ai.storage import AIStore
from wechat_decrypt_tool.local_search.catalog import file_hash

PIECE_BYTES = 4 * 1024 * 1024


def exception_chain(error):
    chain, seen = [], set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        text = re.sub(r'https?://[^\s\x22\x27<>]+', lambda match: '<URL:' + str(urlsplit(match[0]).hostname) + '>', str(error))
        chain.append({'type': type(error).__name__, 'message': text})
        error = error.__cause__ or error.__context__
    return chain


async def fetch_range(client, start, end, path, state, started, *, append=False, on_progress=None, url=URL):
    state.update(start=start, end=end, downloaded_bytes=0)
    async with client.stream('GET', url, headers={'Range': f'bytes={start}-{end}'}) as response:
        state.update(status=response.status_code, host=response.url.host,
                     headers_seconds=round(time.perf_counter() - started, 3),
                     content_range=response.headers.get('content-range'))
        response.raise_for_status()
        if response.status_code != 206 or state['content_range'] != f'bytes {start}-{end}/{BYTES}':
            raise ValueError('官方 ZIP 分段响应区间不一致')
        length = response.headers.get('content-length')
        if length is not None and int(length) != end - start + 1:
            raise ValueError('官方 ZIP 分段响应长度不一致')
        if response.headers.get('content-encoding', 'identity') != 'identity':
            raise ValueError('官方 ZIP 分段响应编码不符合原始文件要求')
        with path.open('ab' if append else 'wb') as stream:
            async for chunk in response.aiter_bytes(65536):
                if not state['downloaded_bytes']:
                    state['first_bytes_seconds'] = round(time.perf_counter() - started, 3)
                if state['downloaded_bytes'] + len(chunk) > end - start + 1:
                    raise ValueError('官方 ZIP 分段数据超出已请求区间')
                stream.write(chunk)
                state['downloaded_bytes'] += len(chunk)
                if on_progress:
                    on_progress(state['downloaded_bytes'])
        if state['downloaded_bytes'] != end - start + 1:
            raise ValueError('官方 ZIP 分段数据未接收完整')
        state['seconds'] = round(time.perf_counter() - started, 3)
        state['complete'] = True


async def resume_part(client, start, end, path, state, started, *, url=URL):
    prefix = path.stat().st_size if path.exists() else 0
    if prefix > end - start + 1:
        raise ValueError('保留分段长度超出已指定区间，不能续传')
    state.update(start=start, end=end, prefix_bytes=prefix, downloaded_bytes=prefix, requests=[])
    offset = start + prefix
    while offset <= end:
        stop = min(end, offset + PIECE_BYTES - 1)
        request = {}
        state['requests'].append(request)
        before = state['downloaded_bytes']
        try:
            await fetch_range(client, offset, stop, path, request, started, append=True,
                              on_progress=lambda count: state.update(downloaded_bytes=before + count), url=url)
        except BaseException as error:
            request['error_type'] = type(error).__name__
            request['exception_chain'] = exception_chain(error)
            if isinstance(error, httpx.RequestError):
                request['error_host'] = error.request.url.host
            raise
        offset = stop + 1
    state['complete'] = True


async def ranges(client, intervals, folder, report, *, resume=False, concurrency=8, url=URL):
    folder.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    report['parts'] = [{'downloaded_bytes': (folder / f'{index}.part').stat().st_size
                        if resume and (folder / f'{index}.part').exists() else 0} for index in range(len(intervals))]
    report['starting_bytes'] = sum(part['downloaded_bytes'] for part in report['parts'])
    operation = resume_part if resume else fetch_range
    semaphore = asyncio.Semaphore(concurrency)
    async def run(index, start, end):
        async with semaphore:
            await operation(client, start, end, folder / f'{index}.part', report['parts'][index], started, url=url)
    jobs = [asyncio.create_task(run(index, start, end))
            for index, (start, end) in enumerate(intervals)]
    group = asyncio.gather(*jobs)
    try:
        while not group.done():
            try:
                await asyncio.wait_for(asyncio.shield(group), timeout=10)
            except asyncio.TimeoutError:
                print(json.dumps({'stage': folder.name, 'bytes': report.get('base_bytes', 0) + sum(p.get('downloaded_bytes', 0) for p in report['parts']),
                                  'seconds': round(time.perf_counter() - started, 1)}, ensure_ascii=False), flush=True)
        await group
    except BaseException:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        raise
    finally:
        elapsed = time.perf_counter() - started
        report['seconds'] = round(elapsed, 3)
        report['written_bytes'] = sum(p.get('downloaded_bytes', 0) for p in report['parts'])
        report['received_bytes'] = report['written_bytes'] - report['starting_bytes']
        report['bytes_per_second'] = round(report['received_bytes'] / elapsed)


async def download_tail(client, root, index, report, *, concurrency=4, url=URL, resume=False):
    block = (BYTES + 7) // 8
    target = root / 'official-parts' / f'{index}.part'
    start, end = index * block, min(BYTES - 1, (index + 1) * block - 1)
    prefix = target.stat().st_size
    if not 0 <= prefix < end - start + 1:
        raise ValueError('尾段前缀长度不符合未完成大区间')
    for other in range(8):
        expected = min(BYTES, (other + 1) * block) - other * block
        if other != index and (root / 'official-parts' / f'{other}.part').stat().st_size != expected:
            raise ValueError('显式尾段处理要求其余7个大区间均完整')
    intervals = [(offset, min(end, offset + PIECE_BYTES - 1)) for offset in range(start + prefix, end + 1, PIECE_BYTES)]
    if resume:
        previous = json.loads((root / 'official-tail-report.json').read_text(encoding='utf-8'))
        saved = previous['download']
        if (previous['expected_bytes'] != BYTES or previous['expected_sha256'] != SHA256
                or saved['tail_index'] != index or saved['original_prefix_bytes'] != prefix
                or [(part['start'], part['end']) for part in saved['parts']] != intervals):
            raise ValueError('尾块续传记录与固定模型包或原始前缀不一致')
    report.update(tail_index=index, original_prefix_bytes=prefix, base_bytes=BYTES - (end - start + 1 - prefix))
    await ranges(client, intervals, root / 'tail-parts', report, concurrency=concurrency, url=url, resume=resume)
    if target.stat().st_size != prefix:
        raise ValueError('下载尾块期间原始前缀发生变化，未拼接')
    with target.open('ab') as output:
        for piece, (left, right) in enumerate(intervals):
            path = root / 'tail-parts' / f'{piece}.part'
            if path.stat().st_size != right - left + 1:
                raise ValueError('尾块长度与已验证区间不一致，未继续拼接')
            with path.open('rb') as source:
                shutil.copyfileobj(source, output, 1024 * 1024)
    if target.stat().st_size != end - start + 1:
        raise ValueError('尾块拼接后大区间长度不一致')
    report['tail_received_bytes'] = report['written_bytes']
    report['written_bytes'] = BYTES


def merge(root, count):
    partial = root / 'official-package.zip.part'
    with partial.open('wb') as output:
        for index in range(count):
            with (root / 'official-parts' / f'{index}.part').open('rb') as source:
                shutil.copyfileobj(source, output, 1024 * 1024)
    if partial.stat().st_size != BYTES or file_hash(partial) != SHA256:
        raise ValueError('官方 ZIP 合并后的大小或完整SHA256校验失败')
    archive = root / 'official-package.zip'
    partial.replace(archive)
    return archive


async def main(root, resume=False, concurrency=8, tail_index=None):
    started = time.perf_counter()
    report = {'source': URL, 'concurrency': concurrency, 'expected_bytes': BYTES, 'expected_sha256': SHA256,
              'started': datetime.now(timezone.utc).isoformat(), 'passed': False, 'resume': resume}
    report_path = root / ('official-tail-report.json' if tail_index is not None else 'official-parallel-resume-report.json' if resume else 'official-parallel-download-report.json')
    if report_path.exists():
        shutil.copyfile(report_path, report_path.with_name(report_path.stem + '-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.json'))
    manager = None
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(60, connect=20),
                                    limits=httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency),
                                    headers={'Accept-Encoding': 'identity'}) as client:
            # The previous eight-range probe succeeded. This invocation is the explicitly
            # authorized full download; network speed is measured, not used as a hidden gate.
            response = await client.head(URL)
            response.raise_for_status()
            if response.status_code != 200 or response.headers.get('content-length') != str(BYTES) or response.url.host != 'release-assets.githubusercontent.com':
                raise ValueError('官方下载链接解析未确认固定ZIP长度和官方资产域名')
            resolved_url = str(response.url)  # The anonymous signed redirect lives only in memory.
            report['resolved_asset'] = {'host': response.url.host, 'bytes': BYTES}
            block = (BYTES + 7) // 8
            report['download'] = {}
            if tail_index is not None:
                await download_tail(client, root, tail_index, report['download'], concurrency=concurrency, url=resolved_url, resume=resume)
            else:
                await ranges(client, [(i * block, min(BYTES - 1, (i + 1) * block - 1)) for i in range(8)],
                             root / 'official-parts', report['download'], resume=resume, concurrency=concurrency, url=resolved_url)
        archive = await asyncio.to_thread(merge, root, 8)
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
        report['exception_chain'] = exception_chain(error)
        if isinstance(error, ValueError):
            report['error'] = str(error)
        if isinstance(error, httpx.HTTPStatusError):
            report['http_status'] = error.response.status_code
    finally:
        if manager:
            await manager.stop()
        report['seconds'] = round(time.perf_counter() - started, 3)
        report['finished'] = datetime.now(timezone.utc).isoformat()
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ('passed', 'seconds', 'error_type', 'error', 'http_status') if key in report}
                     | {'report': str(report_path), 'model_path': str(manager.path) if manager else None}, ensure_ascii=False), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--resume', action='store_true', help='Explicitly continue each saved segment in requests of at most 4MiB')
    parser.add_argument('--concurrency', type=int, choices=range(1, 9), default=8)
    parser.add_argument('--tail-index', type=int, choices=range(8), help='Explicitly parallelize the sole unfinished large interval')
    args = parser.parse_args()
    root = args.root.resolve()
    parent = Path(__file__).resolve().parents[1] / 'tmp'
    if root == parent or not root.is_relative_to(parent):
        parser.error('--root must be a child of this repository tmp/ directory')
    root.mkdir(parents=True, exist_ok=True)
    raise SystemExit(asyncio.run(main(root, resume=args.resume, concurrency=args.concurrency, tail_index=args.tail_index)))
