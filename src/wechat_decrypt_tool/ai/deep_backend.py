"""任务隔离的虚拟文件系统；永不访问宿主文件路径。"""
import fnmatch
import json
from datetime import datetime, timezone
from pathlib import PurePosixPath
from .deep_synchronization import serialized

from deepagents.backends.protocol import (BackendProtocol, ReadResult, WriteResult, EditResult,
    LsResult, GrepResult, GlobResult, FileDownloadResponse, FileUploadResponse)


class TaskBackend(BackendProtocol):
    def __init__(self, service, run_id, version):
        self.service, self.run_id, self.version = service, run_id, version
        self.owner = service.run(run_id)['account']

    def guard(self):
        run = self.service.guard(self.run_id)
        if run['account'] != self.owner or run['version'] != self.version:
            from .agent_service import Revised
            raise Revised()
        return run

    @staticmethod
    def path(value):
        if not isinstance(value, str) or not value.startswith('/') or '\\' in value or '\x00' in value or ':' in value or '..' in value.split('/'):
            raise ValueError('无效的内部资料路径')
        return str(PurePosixPath(value))

    def files(self):
        run = self.guard()
        from .deep_conversation import origins
        files = {}
        with self.service.store.connection() as db:
            for origin in [*origins(self.service, run), {'run_id': self.run_id, 'version': self.version}]:
                rows = db.execute("SELECT id,body FROM agent_piece WHERE run_id=? AND version=? AND kind='deep_file'",
                    (origin['run_id'], origin['version'])).fetchall()
                files.update({r[0].removeprefix('file:'): json.loads(r[1]) for r in rows})
        return files

    def data(self, path):
        run = self.guard()
        path = self.path(path)
        if path.startswith('/materials/') and path.endswith('.json'):
            source = PurePosixPath(path).stem
            value = self.service.run(self.run_id)['evidence'].get(source)
            if value:
                from .deep_tools import ChatGateway
                gateway = ChatGateway(self.service, self.run_id, self.version)
                if run.get('scope_handle') and not gateway.permits(gateway.scope(run['scope_handle']), value):
                    raise ValueError('原文不在当前查询范围')
                if run.get('manifest_id'):
                    fragments = self.service.analysis_plans.assigned_messages(run, source)
                    return self.file_data(json.dumps({'fragments': [{k: v for k, v in m.items() if k != 'media'} for m in fragments]},
                        ensure_ascii=False, indent=2))
                return self.file_data(json.dumps({k: v for k, v in value.items() if k != 'media'}, ensure_ascii=False, indent=2))
        local = self.service.workspace.get(self.run_id, self.version, 'file:' + path)
        if local is not None:
            return local
        from .deep_conversation import origins
        for origin in reversed(origins(self.service, run)):
            data = self.service.workspace.get(origin['run_id'], origin['version'], 'file:' + path)
            if data is not None:
                return data
        return None

    @staticmethod
    def file_data(content):
        now = datetime.now(timezone.utc).isoformat()
        return {'content': content, 'encoding': 'utf-8', 'created_at': now, 'modified_at': now}

    def read(self, file_path, offset=0, limit=2000):
        if limit <= 0:
            return ReadResult(file_data=self.file_data(''), no_lines_requested=True)
        try:
            data = self.data(file_path)
        except ValueError as exc:
            return ReadResult(error=str(exc))
        if data is None:
            return ReadResult(error='内部资料不存在')
        lines = data['content'].splitlines()
        offset = max(0, offset)
        selected = lines[offset:offset + min(limit, 2000)]
        if not selected:
            return ReadResult(file_data=self.file_data(''))
        end = offset + len(selected)
        return ReadResult(file_data={**data, 'content': '\n'.join(selected)}, start_line=offset + 1,
            end_line=end, total_lines=len(lines), next_offset=end if end < len(lines) else None)

    @serialized
    def write(self, file_path, content):
        try:
            self.guard()
            path = self.path(file_path)
            if path.startswith(('/materials/', '/skills/')):
                return WriteResult(error='原始资料及应用说明只读')
            local = self.service.workspace.get(self.run_id, self.version, 'file:' + path)
            if local is None and self.data(path) is not None:
                return WriteResult(error='继承的历史资料只读，请使用新的文件路径')
            if len(content.encode('utf-8')) > 8 * 1024 * 1024:
                return WriteResult(error='单份内部文件过大，请拆分保存')
            self.service.workspace.put(self.run_id, self.version, 'file:' + path, 'deep_file', self.file_data(content))
            return WriteResult(path=path)
        except ValueError as exc:
            return WriteResult(error=str(exc))

    @serialized
    def edit(self, file_path, old_string, new_string, replace_all=False):
        try:
            data = self.data(file_path)
            if not data:
                return EditResult(error='内部文件不存在')
            count = data['content'].count(old_string) if old_string else 0
            if count == 0 or (count > 1 and not replace_all):
                return EditResult(error='待替换文本不存在或不唯一')
            result = self.write(file_path, data['content'].replace(old_string, new_string, -1 if replace_all else 1))
            return EditResult(error=result.error, path=result.path, occurrences=count if replace_all else 1)
        except ValueError as exc:
            return EditResult(error=str(exc))

    def ls(self, path):
        try:
            prefix = self.path(path).rstrip('/') + '/'
            entries = {}
            for name, data in self.files().items():
                if name.startswith(prefix):
                    rest = name[len(prefix):]
                    directory = '/' in rest
                    child = prefix + rest.split('/')[0] + ('/' if directory else '')
                    entries[child] = {'path': child, 'is_dir': directory, 'size': len(data['content'].encode())}
            return LsResult(entries=list(entries.values()))
        except ValueError as exc:
            return LsResult(error=str(exc))

    def glob(self, pattern, path=None):
        prefix = self.path(path or '/').rstrip('/') + '/'
        return GlobResult(matches=[{'path': name, 'is_dir': False, 'size': len(data['content'].encode())}
            for name, data in self.files().items() if name.startswith(prefix) and fnmatch.fnmatch(name[len(prefix):], pattern)])

    def grep(self, pattern, path=None, glob=None, *, max_count=None):
        matches = []
        prefix = self.path(path or '/')
        cap = max(0, min(max_count if max_count is not None else 100, 1000))
        for name, data in self.files().items():
            if not (name == prefix or name.startswith(prefix.rstrip('/') + '/')) or (glob and not fnmatch.fnmatch(name, glob)):
                continue
            for line, text in enumerate(data['content'].splitlines(), 1):
                if pattern in text:
                    if len(matches) >= cap:
                        return GrepResult(matches=matches, truncated=True)
                    matches.append({'path': name, 'line': line, 'text': text})
        return GrepResult(matches=matches)

    def download_files(self, paths):
        values = []
        for path in paths:
            try:
                data = self.data(path)
                values.append(FileDownloadResponse(path=path, content=data['content'].encode() if data else None,
                    error=None if data else 'file_not_found'))
            except ValueError:
                values.append(FileDownloadResponse(path=path, content=None, error='invalid_path'))
        return values

    def upload_files(self, files):
        results = []
        for path, data in files:
            content = data.decode('utf-8')
            if path.startswith('/large_tool_results/'):
                try:
                    # 按行分页必须真正能续读，避免大 JSON 全部挤在一个来源行中。
                    content = json.dumps(json.loads(content), ensure_ascii=False, indent=2)
                except ValueError:
                    pass
            results.append(FileUploadResponse(path=path, error='permission_denied' if self.write(path, content).error else None))
        return results
