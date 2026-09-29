"""一层子智能体：磁盘队列、独立上下文、来源汇集与分组归并。"""
import asyncio
import hashlib
import json
import time
from datetime import datetime, timezone, timedelta

from .agent_context import Findings
from .model_scheduler import subtask_id
from .agent_schemas import AgentControl
from .agent_budget import size, ContextOverflow
from .model_execution import model_policy


class Subtasks:
    def __init__(self, service):
        self.service = service
        self.store = service.store
        with self.store.connection() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS agent_subtask (
                    id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,version INTEGER NOT NULL,
                    account TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,
                    body TEXT NOT NULL,updated REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS subtask_queue ON agent_subtask(parent_id,version,status,ordinal);
                CREATE INDEX IF NOT EXISTS subtask_account ON agent_subtask(account,parent_id,version);
                CREATE TRIGGER IF NOT EXISTS delete_agent_children AFTER DELETE ON records
                WHEN old.kind='agent_run' BEGIN
                    DELETE FROM records WHERE kind IN ('agent_run','agent_thread')
                        AND json_extract(body,'$.parent_run_id')=old.id;
                    DELETE FROM agent_subtask WHERE parent_id=old.id;
                END;
            ''')

    @staticmethod
    def eligible(run):
        if run.get('parent_run_id') or run.get('engine_version') != 2 or run.get('delegation_complete'):
            return False
        intent = run.get('intent', {})
        if intent.get('mode') == 'statistics' or intent.get('message_count'):
            return False
        scope = run.get('query_scope', [])
        interval = run.get('time_range', {})
        span = interval.get('end', 0) - interval.get('start', 0)
        return (intent.get('parallel_check', False) and len(scope) > 1) or (
            intent.get('mode') in ('overview', 'timeline', 'list') and
            (len(scope) > 1 or (interval.get('start', 0) > 0 and span > 60 * 86400)))

    def guard(self, parent):
        return self.service.context_guard(parent)

    def specifications(self, parent):
        interval = parent['time_range']
        goal = parent.get('input_digest') or parent.get('intent', {}).get('objective', '')
        names = {c['username']: c.get('name', c['username'])
                 for c in self.service.reference_contacts.get(parent['account'], [])}
        # 全历史没有已知起点时按会话拆分，避免从 1970 年创建大量空时间片。
        width = 30 * 86400 if interval['start'] > 0 and interval['end'] - interval['start'] > 60 * 86400 else None
        zone = timezone(timedelta(seconds=parent.get('timezone_offset', 0)))
        for username in parent['query_scope']:
            start = interval['start']
            while start < interval['end']:
                end = min(start + width, interval['end']) if width else interval['end']
                dates = (datetime.fromtimestamp(start, zone).strftime('%Y-%m-%d') + ' 至 '
                         + datetime.fromtimestamp(end - 1, zone).strftime('%Y-%m-%d')) if start else '全部历史'
                yield {'name': names.get(username, username) + ' · ' + dates,
                       'goal': goal, 'scope': [username], 'primary_range': {'start': start, 'end': end},
                       # 两分钟重叠只用于理解边界；汇总按真实消息 ID 去重。
                       'time_range': {'start': max(interval['start'], start - 120),
                                      'end': min(interval['end'], end + 120)}}
                start = end

    def prepare(self, parent):
        for ordinal, spec in enumerate(self.specifications(parent)):
            self.guard(parent)
            key = hashlib.sha256(json.dumps([parent['id'], parent['version'], ordinal, spec],
                                           ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:32]
            body = {**spec, 'id': key, 'parent_id': parent['id'], 'version': parent['version'],
                    'account': parent['account'], 'child_run_id': 'child:' + key,
                    'status': 'queued', 'created': time.time(), 'attempts': 0,
                    'result_handle': '', 'coverage': {}, 'error': ''}
            with self.store.connection() as db:
                db.execute('INSERT OR IGNORE INTO agent_subtask VALUES(?,?,?,?,?,?,?,?)',
                           (key, parent['id'], parent['version'], parent['account'], ordinal,
                            'queued', json.dumps(body, ensure_ascii=False), time.time()))
        with self.store.connection() as db:
            db.execute("UPDATE agent_subtask SET status='superseded',body=json_set(body,'$.status','superseded') "
                       "WHERE parent_id=? AND version<>? AND status<>'superseded'", (parent['id'], parent['version']))
        self.service.update(parent['id'], delegation_version=parent['version'])

    def claim(self, parent):
        self.guard(parent)
        with self.store.connection() as db:
            row = db.execute("SELECT body FROM agent_subtask WHERE parent_id=? AND version=? AND status='queued' ORDER BY ordinal LIMIT 1",
                             (parent['id'], parent['version'])).fetchone()
            if not row:
                return None
            body = json.loads(row[0])
            body.update(status='running', started_at=time.time(), attempts=body.get('attempts', 0) + 1)
            db.execute("UPDATE agent_subtask SET status='running',body=?,updated=? WHERE id=? AND status='queued'",
                       (json.dumps(body, ensure_ascii=False), time.time(), body['id']))
        self.publish(parent)
        return body

    def save(self, parent, body):
        self.guard(parent)
        with self.store.connection() as db:
            db.execute('UPDATE agent_subtask SET status=?,body=?,updated=? WHERE id=? AND parent_id=? AND version=?',
                       (body['status'], json.dumps(body, ensure_ascii=False), time.time(), body['id'], parent['id'], parent['version']))
        self.publish(parent)

    def summary(self, parent):
        with self.store.connection() as db:
            rows = db.execute('SELECT status,count(*) FROM agent_subtask WHERE parent_id=? AND version=? GROUP BY status',
                              (parent['id'], parent['version'])).fetchall()
        counts = dict(rows)
        return {'total': sum(counts.values()), 'completed': counts.get('completed', 0),
                'running': counts.get('running', 0), 'queued': counts.get('queued', 0),
                'failed': counts.get('failed', 0), 'interrupted': counts.get('interrupted', 0)}

    def publish(self, parent):
        summary = self.summary(parent)
        self.service.update(parent['id'], subtasks=summary)
        self.store.event(parent['account'], 'agent', {'type': 'subtasks_changed', 'thread_id': parent['thread_id'],
                                                    'run_id': parent['id'], 'subtasks_changed': True, 'version': parent['version']})

    def page(self, id, account, offset=0, limit=20, version=None):
        parent = self.service.authorize_material(id, account, version)
        with self.store.connection() as db:
            total = db.execute('SELECT count(*) FROM agent_subtask WHERE parent_id=? AND version=?', (id, parent['version'])).fetchone()[0]
            rows = db.execute('SELECT body FROM agent_subtask WHERE parent_id=? AND version=? ORDER BY ordinal LIMIT ? OFFSET ?',
                              (id, parent['version'], limit, offset)).fetchall()
            items = []
            for row in rows:
                body = json.loads(row[0])
                usage = db.execute("SELECT count(*),coalesce(sum(json_extract(body,'$.usage.input_tokens')),0),"
                                   "coalesce(sum(json_extract(body,'$.usage.output_tokens')),0),"
                                   "coalesce(sum(CASE WHEN json_extract(body,'$.usage_known')=1 THEN 0 ELSE 1 END),0) "
                                   "FROM records WHERE kind='usage' AND account=? AND json_extract(body,'$.subtask_id')=?",
                                   (account, body['id'])).fetchone()
                items.append({k: v for k, v in body.items() if k not in ('goal', 'account', 'child_run_id')} |
                             {'usage': dict(zip(('calls', 'input_tokens', 'output_tokens', 'unknown'), usage))})
        return {'items': items, 'total': total, 'offset': offset, 'has_more': offset + len(items) < total, 'version': parent['version']}

    def create_child(self, parent, job):
        service = self.service
        child_id = job['child_run_id']
        prior = self.store.get('agent_run', child_id)
        if prior:
            if prior['status'] != 'completed':
                service.update(child_id, status='queued', finished_at=None, error='', segment_started=time.time())
            return service.run(child_id)
        thread_id = 'thread:' + job['id']
        question = (job['goal'] + '\n这是独立子任务，仅处理所分配范围。按时间线保留证据与冲突；'
                    '不递归委派。相邻范围仅供理解背景，不单独重复统计。完成后返回紧凑结论和来源，'
                    '详细发现保留在本地。需要范围外证据时明确提出待核查对象，不自行越界。'
                    '\n主要范围：' + json.dumps(job['primary_range'], ensure_ascii=False))
        self.store.put('agent_thread', {'account': parent['account'], 'username': job['scope'][0],
            'title': job['name'], 'scope': job['scope'], 'scope_revision': 0, 'parent_run_id': parent['id'],
            'latest_run': child_id, 'messages': [{'id': 'input:' + job['id'], 'role': 'user', 'text': question,
                                               'run_id': child_id, 'created': time.time()}]}, id=thread_id)
        now = time.time()
        child = {k: parent[k] for k in ('account', 'profile', 'vision', 'timezone', 'timezone_offset',
                 'cutoff', 'effort', 'input_budget') if k in parent}
        child.update(thread_id=thread_id, parent_run_id=parent['id'], parent_version=parent['version'],
            subtask_id=job['id'], status='queued', stage='等待子任务执行', created=now, started_at=now,
            segment_started=now, elapsed_seconds=0, used={'tools': 0, 'models': 0, 'media': 0},
            version=1, applied_version=1, scope_revision=0, engine_version=2, note_strategy='cumulative',
            report_policy=None, query_scope=job['scope'], time_range=job['time_range'],
            query_filters={'conversations': job['scope'], 'time_range': job['time_range'],
                           'sender': parent.get('query_filters', {}).get('sender')},
            intent={**parent['intent'], 'parallel_check': False, 'scope_locked': True},
            input_digest=question, observations=[], activity=[], answer='', error='', read_count=0,
            request_ids=[], finished_at=None)
        return self.store.put('agent_run', child, id=child_id)

    async def work(self, parent, job):
        service = self.service
        try:
            child = self.create_child(parent, job)
            if child['status'] != 'completed':
                await service.execute(child['id'])
            self.guard(parent)
            child = service.run(child['id'])
            # 每个分片先保存原始结果，再提取供主任务归并的紧凑发现。
            if child['status'] != 'completed':
                job.update(status='failed', error=child.get('error') or '子任务未完成，继续时从检查点恢复。')
            else:
                from .agent_notes import saved_notes
                note = service.workspace.get(child['id'], child['version'], child.get('note_key', '')) or {}
                notes = note.get('notes', {})
                if child.get('note_strategy') == 'incremental':
                    notes = saved_notes(service.workspace, child)
                sources = [s for item in notes.get('items', []) for s in item.get('sources', [])]
                # 搜索型子任务未生成笔记时，仅从已验证的回答引用提取。
                if not notes.get('items') and child.get('answer'):
                    from .agent_references import cited_references
                    import re
                    sources = [s for s in re.findall(r'\[\[([a-f0-9]{24})\]\]', child['answer']) if s in child['evidence']]
                    if sources:
                        notes = {'items': [{'text': child['answer'], 'sources': list(dict.fromkeys(sources)), 'needs_check': True}]}
                key = 'subtask-result:' + job['id']
                service.workspace.put(parent['id'], parent['version'], key, 'subtask_result',
                                      {'notes': notes, 'answer': child['answer'], 'child_run_id': child['id']})
                # 用 SQL 迁移资料，不把全量原文加载到 Python 或主智能体上下文。
                service.workspace.inherit(child['id'], parent['id'])
                with self.store.connection() as db:
                    db.execute("INSERT OR IGNORE INTO agent_piece SELECT ?,?,id,kind,body FROM agent_piece "
                               "WHERE run_id=? AND version=? AND kind='finding'",
                               (parent['id'], parent['version'], child['id'], child['version']))
                service.workspace.restrict(parent['id'], parent['query_scope'], parent['time_range'], exclusive=True,
                                           sender=parent.get('query_filters', {}).get('sender'))
                preview = [{'text': i['text'][:300], 'sources': i['sources'][:3]} for i in notes.get('items', [])[:3]]
                job.update(status='completed', result_handle=key, findings=preview,
                           scope_requests=child.get('scope_requests', []),
                           coverage={'read': child.get('read_count', 0),
                                     'complete': bool(child.get('analysis', {}).get('complete')),
                                     'time_range': job['time_range']})
            job.update(finished_at=time.time(), elapsed_seconds=time.time() - job['started_at'])
            self.save(parent, job)
        except (asyncio.CancelledError, AgentControl):
            raise
        except Exception:
            job.update(status='failed', error='子任务处理失败，已完成步骤保留，可继续重试。', finished_at=time.time())
            self.save(parent, job)

    def resume(self, parent):
        with self.store.connection() as db:
            db.execute("UPDATE agent_subtask SET status='queued',body=json_set(body,'$.status','queued','$.error','') "
                       "WHERE parent_id=? AND version=? AND status IN ('running','interrupted','failed')",
                       (parent['id'], parent['version']))

    def interrupt(self, parent):
        with self.store.connection() as db:
            db.execute("UPDATE agent_subtask SET status='interrupted',body=json_set(body,'$.status','interrupted') "
                       "WHERE parent_id=? AND version=? AND status='running'", (parent['id'], parent['version']))

    async def reduce(self, parent):
        """小批量归并，全部分片发现另存；主上下文只读取最终根节点。"""
        service = self.service
        level = 0
        capacity = max(1024, min(12000, service.budget(parent) // 5))
        with self.store.connection() as db:
            db.execute("DELETE FROM agent_piece WHERE run_id=? AND version=? AND kind LIKE 'subtask_level_%'",
                       (parent['id'], parent['version']))

        async def merge(values, level, index):
            fingerprint = hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            key = f'subtask-merge:{level}:{index}:{fingerprint}'
            cached = service.workspace.get(parent['id'], parent['version'], key)
            if cached:
                return cached['notes']
            if len(values) == 1 and size(values[0]) <= capacity:
                notes = values[0]
            else:
                prompt = ('汇总以下子任务发现。保留影响问题答案的事实、时间变化及相互矛盾的说法；'
                          '相同事件按来源关联去重，不以多数意见判定真假。每项保留真实 sources，'
                          '冲突未核查时 needs_check=true。结果是摘要，完整发现仍保存在原子任务。'
                          f'输出 JSON 不超过 {capacity} UTF-8 字节。问题：' + parent.get('input_digest', '') +
                          '\n资料：' + json.dumps(values, ensure_ascii=False))
                with model_policy(seconds=90, output_tokens=2048):
                    notes = await service.context_call(parent['id'], prompt, Findings)
                allowed = {s for v in values for item in v.get('items', []) for s in item['sources']}
                if any(not set(item['sources']) <= allowed for item in notes.get('items', [])):
                    raise ValueError('归并结果引用未知来源')
                if size(notes) > capacity:
                    raise ContextOverflow('子任务归并结果超出预算，已保存分片结果。')
            self.guard(parent)
            service.workspace.put(parent['id'], parent['version'], key, 'subtask_merge', {'notes': notes})
            return notes

        # 逐页读取结果，任何时候最多保持一个归并批次。
        while True:
            offset, produced, batch = 0, 0, []
            while True:
                page = service.workspace.page(parent['id'], parent['version'],
                                              'subtask_result' if level == 0 else f'subtask_level_{level}', offset, 1)
                if not page['items']:
                    break
                value = page['items'][0]['notes']
                offset += 1
                # 超长子任务笔记按发现拆开，不截断全文结论。
                units = ([{'items': [item]} for item in value.get('items', [])] or [{'items': []}]) if level == 0 else [value]
                for unit in units:
                    if batch and (len(batch) >= 4 or size([*batch, unit]) > capacity * (3 if level else 1)):
                        result = await merge(batch, level, produced)
                        service.workspace.put(parent['id'], parent['version'], f'subtask-level:{level+1}:{produced:012d}',
                                              f'subtask_level_{level+1}', {'notes': result})
                        produced += 1
                        batch = []
                    batch.append(unit)
            if batch:
                result = await merge(batch, level, produced)
                service.workspace.put(parent['id'], parent['version'], f'subtask-level:{level+1}:{produced:012d}',
                                      f'subtask_level_{level+1}', {'notes': result})
                produced += 1
            if produced <= 1:
                return result if produced else {'items': []}
            # 后续层按整份归并结果合并，避免重复按 item 展开使层数不收敛。
            level += 1
            if level >= 12:
                raise ContextOverflow('子任务结果尚未收敛，已保留全部结果，请缩小查询范围后继续。')

    async def run(self, parent):
        if parent.get('delegation_version') != parent['version']:
            self.prepare(parent)
        async def worker():
            while True:
                job = self.claim(parent)
                if not job:
                    return
                await self.work(parent, job)
        workers = [asyncio.create_task(worker()) for _ in range(3)]
        try:
            await asyncio.gather(*workers)
            self.guard(parent)
            notes = await self.reduce(parent)
            root = 'subtask-root:' + str(parent['version'])
            self.service.workspace.put(parent['id'], parent['version'], root, 'stage_note', {'notes': notes})
            counts = self.summary(parent)
            partial = counts['completed'] < counts['total']
            with self.store.connection() as db:
                coverage = [dict(username=r[0], read=r[1], analyzed=r[1], complete=not partial)
                            for r in db.execute('SELECT username,count(*) FROM agent_material WHERE run_id=? GROUP BY username',
                                                (parent['id'],)).fetchall()]
                requests = db.execute("SELECT json_extract(j.value,'$.username'),json_extract(j.value,'$.reason') "
                    "FROM agent_subtask t,json_each(t.body,'$.scope_requests') j WHERE t.parent_id=? AND t.version=? LIMIT 4",
                    (parent['id'], parent['version'])).fetchall()
            observations = ([{'warning': '部分子任务未完成，以下为阶段结果；完整结果可继续分析。'}] if partial else [])
            if requests:
                observations.append({'scope_requests': [{'username':r[0],'reason':r[1]} for r in requests],
                                     'instruction':'子任务请求补充查证。先核对用户范围约束，确需范围外证据时使用 expand_scope，再定向检索。'})
            sources = {s for item in notes.get('items', []) for s in item['sources']}
            from .agent_references import material_references
            originals = self.service.run(parent['id'])['evidence'].get_many(sources)
            refs = material_references(parent['account'], list(originals.values()),
                    self.service.reference_people(parent, list(originals.values())), parent.get('references'))
            self.service.update(parent['id'], delegation_complete=True, delegation_partial=partial,
                delegation_verified=False, references=refs,
                note_key=root, note_strategy='cumulative', read_count=len(self.service.run(parent['id'])['evidence']),
                analysis={'complete': True, 'coverage': coverage},
                observations=observations)
        finally:
            for task in workers:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            self.interrupt(parent)
