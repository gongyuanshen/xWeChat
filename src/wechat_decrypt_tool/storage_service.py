"""Measure managed account files and explicitly remove only rebuildable indexes."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import stat

from fastapi import HTTPException

from .account_identity import canonical_account_name
from .app_paths import get_output_dir
from .chat_accounts import _safe_account_name
from .key_store import load_account_keys_store
from .snapshot_registry import (
    SnapshotRegistryError, _check_ancestors, _read_json, _reject_link,
    account_deletion_scope, begin_account_work, get_current_snapshot,
    require_account_available, require_account_idle, snapshot_read_scope,
)


_INDEX_NAMES = {name + suffix for name in (
    'chat_search_index.db', 'chat_search_index.tmp.db', 'message_fts.db',
) for suffix in ('', '-wal', '-shm', '-journal')}
_MEDIA_INDEX_NAMES = {'media_path_index.db' + suffix for suffix in ('', '-wal', '-shm', '-journal')}
_GENERATION = re.compile(r'generation-[0-9a-f]{32}\Z')
_CATEGORIES = (
    ('databases', '数据库', '账号数据库和防撤回原文留存，保留。'),
    ('media', '媒体与附件', '本应用保存的媒体和附件，保留；不扫描微信原始目录。'),
    ('indexes', '搜索及媒体索引', '仅聊天全文搜索索引可清理；下次搜索时重新构建。语义和媒体路径索引保留。'),
    ('snapshots', '保留快照', '当前快照、历史快照和未完成候选全部保留。'),
    ('library', '资料夹副本', '主动保存到资料夹的附件副本，保留。文字与报告存于共享 AI 数据库。'),
    ('other', '其他账号文件', '账号配置、导出和其他文件，保留。'),
)


def _directory(path: Path) -> bool:
    _check_ancestors(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(info.st_mode):
        raise SnapshotRegistryError(f'Expected an account storage directory: {path}')
    return True


def _files(root: Path, *, exclude: set[str] | None = None):
    if not _directory(root):
        return
    def failed(error):
        raise error
    for directory, directories, files in os.walk(root, followlinks=False, onerror=failed):
        if Path(directory) == root and exclude:
            directories[:] = [name for name in directories if name not in exclude]
        directories.sort()
        for name in directories + sorted(files):
            path = Path(directory) / name
            info = path.lstat()
            _reject_link(path, info)
            if name in directories:
                if not stat.S_ISDIR(info.st_mode):
                    raise SnapshotRegistryError(f'Storage directory changed during scan: {path}')
            elif stat.S_ISREG(info.st_mode):
                yield path, info
            else:
                raise SnapshotRegistryError(f'Unsupported storage file type: {path}')


def _account_roots(account: str) -> tuple[Path, list[Path]]:
    selected = _safe_account_name(account)
    if not selected:
        raise HTTPException(422, '账号名称无效，不能包含路径。')
    family = canonical_account_name(selected)
    parent = get_output_dir().absolute() / 'databases'
    if not _directory(parent):
        raise HTTPException(404, '账号目录不存在。')
    roots = sorted((path for path in parent.iterdir()
                    if _safe_account_name(path.name) and canonical_account_name(path.name) == family),
                   key=lambda path: path.name)
    for root in roots:
        _directory(root)
    choices = {root.name: root for root in roots}
    root = choices.get(selected) or choices.get(family)
    if root is None:
        raise HTTPException(404, '账号目录不存在。')
    return root, roots


def _sources(roots: list[Path]) -> list[Path]:
    sources = []
    def remember(value):
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise SnapshotRegistryError('账号来源元数据必须包含绝对路径。')
        sources.append(Path(value).resolve())
    for root in roots:
        pointer = get_current_snapshot(root)
        metadata = [root / '_source.json']
        if pointer is not None:
            metadata.append(get_output_dir().absolute() / pointer['generation_path'] /
                            'databases' / pointer['generation_account'] / '_source.json')
        for path in metadata:
            _check_ancestors(path)
            if path.exists():
                data = _read_json(path)
                for key in ('db_storage_path', 'wxid_dir'):
                    if data.get(key):
                        remember(data[key])
    # Source aliases in the key store can supersede an older _source.json.
    # Validate the whole store rather than turn damaged metadata into no source.
    _check_ancestors(get_output_dir().absolute() / 'account_keys.json')
    for entry in load_account_keys_store(strict=True).values():
        if not isinstance(entry, dict):
            raise SnapshotRegistryError('账号密钥存储中的来源元数据损坏。')
        for key in ('db_key_source_db_storage_path', 'db_key_source_wxid_dir'):
            if entry.get(key):
                remember(entry[key])
    return sources


def _is_search_index(path: Path, root: Path) -> bool:
    return path.name in _INDEX_NAMES and (path.parent == root or (
        path.parent.parent == root / '_snapshot_cache' and _GENERATION.fullmatch(path.parent.name)))


def _search_index_files(roots: list[Path]):
    """Cleanup inspects the allowlist, without rescanning retained media/models."""
    for root in roots:
        directories = [root]
        cache = root / '_snapshot_cache'
        if _directory(cache):
            directories.extend(path for path in sorted(cache.iterdir()) if _GENERATION.fullmatch(path.name))
        for directory in directories:
            if not _directory(directory):
                raise SnapshotRegistryError(f'索引目录在检查期间消失：{directory}')
            for name in sorted(_INDEX_NAMES):
                path = directory / name
                try:
                    info = path.lstat()
                except FileNotFoundError:
                    continue
                _reject_link(path, info)
                if not stat.S_ISREG(info.st_mode):
                    raise SnapshotRegistryError(f'索引清理目标不是普通文件：{path}')
                yield path, info


def _inventory(root: Path, roots: list[Path]):
    categories = {id: dict(id=id, label=label, description=description, bytes=0, files=0, cleanup_bytes=0, locations=[])
                  for id, label, description in _CATEGORIES}
    locations = {id: {} for id, _, _ in _CATEGORIES}
    targets = []
    def add(category, info, location):
        categories[category]['bytes'] += info.st_size
        categories[category]['files'] += 1
        locations[category][location] = dict(path=str(location), kind='directory')
    for account_root in roots:
        for path, info in _files(account_root):
            relative = path.relative_to(account_root)
            location = account_root / relative.parts[0] if len(relative.parts) > 1 else account_root
            if _is_search_index(path, account_root):
                category = 'indexes'
                targets.append((path, info))
                categories[category]['cleanup_bytes'] += info.st_size
            elif path.parent == account_root and path.name in _MEDIA_INDEX_NAMES:
                category = 'indexes'
            elif relative.parts[0] == 'resource':
                category = 'media'
            elif path.parent == account_root and re.search(r'\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$', path.name):
                category = 'databases'
            else:
                category = 'other'
            add(category, info, location)
    output = get_output_dir().absolute()
    family = canonical_account_name(root.name)
    # These sibling directories have the same account-family ownership as the
    # existing account deletion flow, but storage management only measures them.
    for folder, category in (('exports', 'other'), ('avatar_cache', 'media'), ('account_backups', 'snapshots')):
        parent = output / folder
        if _directory(parent):
            for candidate in parent.iterdir():
                if canonical_account_name(candidate.name) == family:
                    for path, info in _files(candidate):
                        add(category, info, parent)
    for candidate in root.parent.iterdir():
        if candidate not in roots and canonical_account_name(candidate.name) == family:
            for path, info in _files(candidate):
                add('snapshots', info, root.parent)
    snapshots = output / 'verified_snapshots'
    if _directory(snapshots):
        for snapshot in sorted(snapshots.iterdir()):
            if not _directory(snapshot) or not (_GENERATION.fullmatch(snapshot.name) or snapshot.name.startswith('.snapshot-')):
                raise SnapshotRegistryError(f'Unknown snapshot entry: {snapshot}')
            owner_path, manifest_path = snapshot / 'ownership.json', snapshot / 'manifest.json'
            _check_ancestors(owner_path)
            _check_ancestors(manifest_path)
            owner = _read_json(owner_path) if owner_path.exists() else _read_json(manifest_path)
            owner_name = owner.get('account')
            if not isinstance(owner_name, str) or not _safe_account_name(owner_name):
                raise SnapshotRegistryError(f'Snapshot account ownership is invalid: {snapshot}')
            if owner_path.exists():
                source = owner.get('source_db_storage_path')
                if type(owner.get('version')) is not int or owner['version'] != 1 or not isinstance(source, str) or not Path(source).is_absolute():
                    raise SnapshotRegistryError(f'Snapshot ownership metadata is invalid: {snapshot}')
            if canonical_account_name(owner_name) != family:
                continue
            if manifest_path.exists():
                manifest = _read_json(manifest_path)
                if manifest.get('account') != owner_name or manifest.get('generation_path') != str(snapshot):
                    raise SnapshotRegistryError(f'Snapshot ownership and manifest disagree: {snapshot}')
            for path, info in _files(snapshot):
                add('snapshots', info, snapshots)
    ai_root = output / 'ai'
    account_hashes = {hashlib.sha256(account.encode()).hexdigest() for account in {family, *(path.name for path in roots)}}
    for account_hash in account_hashes:
        library = ai_root / 'library' / account_hash
        for path, info in _files(library):
            add('library', info, ai_root / 'library')
    semantic_names = {account_hash + '.sqlite3' + suffix for account_hash in account_hashes
                      for suffix in ('', '-wal', '-shm', '-journal')}
    for path, info in _files(output / 'local_search' / 'indexes'):
        if path.name in semantic_names:
            add('indexes', info, output / 'local_search' / 'indexes')
    for id, paths in locations.items():
        categories[id]['locations'] = [paths[path] for path in sorted(paths)]
    shared = dict(bytes=0, files=0, locations=[], description='共享 AI 数据库、本地检索状态和检查点；不能按账号拆分物理文件，保留且不计入账号合计。不含独立安装的模型。')
    shared_locations = {}
    for parent, exclude in ((ai_root, {'library'}), (output / 'local_search', {'indexes'})):
        for path, info in _files(parent, exclude=exclude):
            shared['bytes'] += info.st_size
            shared['files'] += 1
            shared_locations[parent] = dict(path=str(parent), kind='directory')
    shared['locations'] = [shared_locations[path] for path in sorted(shared_locations)]
    return list(categories.values()), targets, shared


def storage_summary(account: str) -> dict:
    from .snapshot_refresh import SNAPSHOT_REFRESH

    root, roots = _account_roots(account)
    require_account_available(root)
    busy = ''
    try:
        require_account_idle(root)
    except SnapshotRegistryError:
        busy = '账号正在同步、读取或运行任务；请结束任务后再清理。'
    lease = begin_account_work(root)
    try:
        _sources(roots)
        categories, targets, shared = _inventory(root, roots)
        # Status resolves account DBs; release its read pins within this summary,
        # rather than retaining them in the surrounding HTTP request scope.
        with snapshot_read_scope(independent=True):
            refresh = SNAPSHOT_REFRESH.status(root.name)
        sync = {key: refresh[key] for key in (
            'enabled', 'running', 'user_paused', 'refresh_available', 'unavailable_reason', 'phase',
        )}
        clean_bytes = sum(info.st_size for _, info in targets)
        return dict(account=root.name, total_bytes=sum(row['bytes'] for row in categories), categories=categories,
            cleanup=dict(category='search_index', bytes=clean_bytes, files=len(targets),
                         available=bool(targets) and not busy, reason=busy or ('' if targets else '没有可清理的聊天搜索索引。')),
            sync=sync, shared=shared, scope_note='仅统计本应用管理目录中的文件大小，不含微信原始目录；文件大小不等同于磁盘实际可释放空间。当前与历史快照、原文、媒体和资料夹副本均保留。存放位置按主要文件夹展示，统计仍按账号和分类区分。')
    finally:
        lease.release()


def cleanup_search_indexes(account: str) -> dict:
    from .chat_search_index import forget_account_search_index
    root, roots = _account_roots(account)
    removed_bytes = removed_files = 0
    with account_deletion_scope(root):
        try:
            require_account_idle(root)
        except SnapshotRegistryError as error:
            raise HTTPException(409, dict(code='storage_busy', message='账号正在同步、读取或运行任务；请结束任务后再清理。',
                reason=str(error), removed_bytes=0, removed_files=0)) from error
        sources = _sources(roots)
        targets = list(_search_index_files(roots))
        identities = {parent: parent.lstat() for path, _ in targets for parent in path.parents
                      if parent == get_output_dir().absolute() or parent.is_relative_to(get_output_dir().absolute())}
        for path, _ in targets:
            if any(path == source or path.is_relative_to(source) for source in sources):
                raise SnapshotRegistryError(f'索引路径属于原始来源目录，不能清理：{path}')
        try:
            for path, expected in targets:
                _check_ancestors(path)
                for parent in path.parents:
                    if parent in identities and not os.path.samestat(identities[parent], parent.lstat()):
                        raise SnapshotRegistryError(f'清理目录在检查后被替换：{parent}')
                current = path.lstat()
                if not os.path.samestat(expected, current) or (expected.st_size, expected.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
                    raise SnapshotRegistryError(f'索引文件在检查后发生变化：{path}')
                path.unlink()
                removed_bytes += expected.st_size
                removed_files += 1
        except (OSError, SnapshotRegistryError) as error:
            raise HTTPException(500, dict(code='storage_cleanup_failed', message=str(error),
                removed_bytes=removed_bytes, removed_files=removed_files)) from error
        finally:
            if removed_files:
                for account_root in roots:
                    forget_account_search_index(account_root)
    return dict(status='success', account=root.name, removed_bytes=removed_bytes, removed_files=removed_files,
                note='已移除可重建的聊天搜索索引，下次搜索时重新构建；移除文件大小不等同于磁盘实际释放空间。')
