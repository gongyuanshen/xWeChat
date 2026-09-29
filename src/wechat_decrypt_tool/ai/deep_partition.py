"""持久化的内容分片；读取游标、正文归属和模型上下文彼此独立。"""
import asyncio
import hashlib
import json
import re
import time

from .agent_budget import input_limit, message_payload, size

PLAN_VERSION = 1
QUEUE_LIMIT = 8
WORKERS = 4


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]


def capacity(service, run):
    return max(1024, min(48 * 1024, input_limit(service.profile(run)) // 3))


def fragment(message):
    start = message.get('text_offset', 0)
    return {'source': message['source'], 'start': start, 'end': start + len(message.get('text', '')),
            'username': message['username'], 'time': message['time'],
            'weight': size(message_payload(message)) + 2}


def covered_part(ref):
    return {k: ref[k] for k in ('source', 'start', 'end')}


def uncommitted(ref, covered):
    """按字符区间相减；刷新及超限拆分都不能重交已经提交的半条正文。"""
    spans = [(ref['start'], ref['end'])]
    if ref['start'] == ref['end']:
        return [] if ref['source'] in covered else [ref]
    for lo, hi in covered.get(ref['source'], []):
        spans = [(a, b) for start, end in spans
            for a, b in ((start, min(end, lo)), (max(start, hi), end)) if a < b]
    return [{**ref, 'start': lo, 'end': hi,
        'weight': max(1, int(ref['weight'] * (hi - lo) / max(1, ref['end'] - ref['start'])))} for lo, hi in spans]


class AnalysisPlans:
    def __init__(self, service):
        self.service = service
        self.locks = {}
        self.slots = {}
        self.events = {}

    def gateway(self, run):
        from .deep_tools import ChatGateway
        return ChatGateway(self.service, run['id'], run['version'])

    def guard(self, parent):
        run = self.service.guard(parent['id'])
        if run['version'] != parent['version']:
            from .agent_service import Revised
            raise Revised()
        return run

    def slot(self, parent):
        # 多次 task 调用共享父任务的槽位，模型层还有全应用上限。
        return self.slots.setdefault((parent['id'], parent['version']), asyncio.Semaphore(WORKERS))

    def lock(self, parent, key):
        return self.locks.setdefault((parent['id'], parent['version'], key), asyncio.Lock())

    def wake(self, parent):
        return self.events.setdefault((parent['id'], parent['version']), asyncio.Event())

    def queued_count(self, parent):
        with self.service.store.connection() as db:
            return db.execute("SELECT count(*) FROM agent_subtask WHERE parent_id=? AND version=? AND status='queued' "
                "AND json_extract(body,'$.plan_version')=1", (parent['id'], parent['version'])).fetchone()[0]

    def get(self, parent, key):
        self.guard(parent)
        return self.service.workspace.get(parent['id'], parent['version'], key)

    def save(self, parent, plan, pieces=(), job=None, *, jobs=(), replaced=None):
        """领取正文和推进生产者游标同事务提交，重启不会丢片或重复分派。"""
        self.guard(parent)
        rows = [(plan['id'], 'analysis_plan', plan), *pieces]
        with self.service.store.connection() as db:
            current = db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=?", (parent['id'],)).fetchone()
            if not current or json.loads(current[0])['version'] != parent['version']:
                from .agent_service import Revised
                raise Revised()
            db.executemany('INSERT OR REPLACE INTO agent_piece VALUES(?,?,?,?,?)',
                [(parent['id'], parent['version'], key, kind, json.dumps(body, ensure_ascii=False)) for key, kind, body in rows])
            for item in ([job] if job else []) + list(jobs):
                ordinal = db.execute('SELECT coalesce(max(ordinal),-1)+1 FROM agent_subtask WHERE parent_id=? AND version=?',
                    (parent['id'], parent['version'])).fetchone()[0]
                db.execute('INSERT OR IGNORE INTO agent_subtask VALUES(?,?,?,?,?,?,?,?)',
                    (item['id'], parent['id'], parent['version'], parent['account'], ordinal, item['status'],
                     json.dumps(item, ensure_ascii=False), time.time()))
            if replaced:
                db.execute('UPDATE agent_subtask SET status=?,body=?,updated=? WHERE id=?',
                    (replaced['status'], json.dumps(replaced, ensure_ascii=False), time.time(), replaced['id']))

    def publish(self, parent):
        self.guard(parent)
        self.service.update(parent['id'], subtasks=self.service.subtasks.summary(parent))

    async def prepare(self, gateway, scope):
        parent = gateway.guard()
        key = 'plan:' + fingerprint([scope['handle'], parent.get('input_digest'), PLAN_VERSION])
        async with self.lock(parent, key):
            existing = self.get(parent, key)
            if existing and existing['mode'] != 'probing':
                return existing
            scan = dict(scope)
            scan.pop('analysis_plan', None)
            plan = {'id': key, 'plan_version': PLAN_VERSION, 'scope_handle': scope['handle'],
                'objective': parent.get('input_digest', ''), 'role': 'range-analyst', 'phase': 'partitioning',
                'mode': 'probing', 'capacity': capacity(self.service, parent), 'scan': scan,
                'buffer': [], 'previous': [], 'scan_complete': bool(scope.get('read_complete')),
                'warnings': list(scope.get('warnings', [])), 'next_ordinal': 0, 'created': time.time(),
                'prefetched': 0, 'reused': 0}
            plan = existing or plan
            if existing is None and parent['version'] > 1 and not scope.get('message_count'):
                with self.service.store.connection() as db:
                    previous = db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='analysis_plan' "
                        "AND json_extract(body,'$.scope_handle')=?", (parent['id'], parent['version'] - 1, scope['handle'])).fetchone()
                prior = json.loads(previous[0]) if previous else None
                if prior and prior['scan_complete'] and not prior.get('warnings'):
                    # 补充目标仍使用同一截止时刻与筛选时，复用上一版本原文，重新分析目标。
                    plan['reuse_version'] = parent['version'] - 1
                    plan['replay_cursor'] = [0, 0]
            # 小范围的预读页保留原始分页形状，主 Agent 直接消费，不再访问数据源。
            while not plan['scan_complete'] and sum(r['weight'] for r in plan['buffer']) <= 2 * plan['capacity']:
                await self.fetch(parent, plan, prefetch=True)
            plan['mode'] = 'direct' if plan['scan_complete'] and sum(r['weight'] for r in plan['buffer']) <= 2 * plan['capacity'] else 'parallel'
            if plan['mode'] == 'direct':
                plan['phase'] = 'direct'
            scope['analysis_plan'] = key
            self.save(parent, plan, [("scope:" + scope['handle'], 'deep_scope', scope)])
            if plan['mode'] == 'parallel':
                self.publish(parent)
            return plan

    async def fetch(self, parent, plan, *, prefetch=False):
        gateway = self.gateway(parent)
        probe_budget = 2 * plan['capacity'] - sum(r['weight'] for r in plan['buffer']) if prefetch else None
        async with self.lock(parent, 'source-reader'):
            if plan.get('reuse_version'):
                result, following = self.replay_page(parent, plan, probe_budget=probe_budget)
            else:
                result, following = await gateway.fetch_page(plan['scan'], plan['capacity'], probe_budget=probe_budget)
        self.guard(parent)
        messages = result.get('messages', [])
        originals = result.get('originals', messages)
        payload = gateway.save_messages(messages, originals)
        refs = [fragment({**m, **p}) for m, p in zip(messages, payload)]
        snapshots = []
        by_source = {m['source']: m for m in originals}
        for message, ref in zip(messages, refs):
            original = by_source.get(message['source'], message)
            snapshot_id = 'snapshot:' + fingerprint([ref['source'], original])
            ref['snapshot'] = snapshot_id
            snapshots.append((snapshot_id, 'analysis_source', {**original, 'source': ref['source']}))
            snapshots.append(('plan-source:' + fingerprint([plan['id'], ref['source']]), 'analysis_plan_source',
                {'plan_id': plan['id'], 'source': ref['source']}))
        if plan.get('refreshing'):
            # 数据恢复后只补齐未提交正文，已有明确覆盖继续复用。
            with self.service.store.connection() as db:
                notes = [json.loads(r[0]) for r in db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='stage_note'",
                    (parent['id'], parent['version']))]
            covered = {}
            for note in notes:
                for r in note.get('covered', []):
                    covered.setdefault(r['source'], []).append((r['start'], r['end']))
            refs = [part for ref in refs for part in uncommitted(ref, covered)]
        plan['buffer'].extend(refs)
        plan['scan'] = following
        plan['scan_complete'] = following['read_complete']
        plan['warnings'] = list(dict.fromkeys([*plan['warnings'], *following.get('warnings', [])]))
        plan['data_sources'] = list(dict.fromkeys([*plan.get('data_sources', []), result.get('data_source', 'unknown')]))
        pieces = snapshots
        if prefetch:
            number = plan['prefetched']
            plan['prefetched'] += 1
            pieces.append((f"prefetch:{plan['scope_handle']}:{number}", 'analysis_prefetch',
                {'result': {**result, 'messages': [{**m, **p} for m, p in zip(messages, payload)]}, 'next': following}))
        self.save(parent, plan, pieces)

    def replay_page(self, parent, plan, *, probe_budget=None):
        scope = plan['scan']
        position, offset = plan['replay_cursor']
        with self.service.store.connection() as db:
            where = "run_id=? AND version=? AND kind='analysis_source' AND json_extract(body,'$.username') IN (" + ','.join('?' for _ in scope['conversations']) + ") AND json_extract(body,'$.time')>=? AND json_extract(body,'$.time')<?"
            args = [parent['id'], plan['reuse_version'], *scope['conversations'], scope['start'], scope['end']]
            if scope.get('sender'):
                where += " AND coalesce(json_extract(body,'$.sender_id'),json_extract(body,'$.sender'))=?"
                args.append(scope['sender'])
            rows = [json.loads(r[0]) for r in db.execute('SELECT body FROM agent_piece WHERE ' + where +
                " GROUP BY json_extract(body,'$.source') ORDER BY json_extract(body,'$.time'),json_extract(body,'$.source') LIMIT 100 OFFSET ?", [*args, position])]
        messages, originals, used, consumed = [], [], 2, 0
        for original in rows:
            text = original.get('text', '')
            value = {**original, 'text': text[offset:], 'text_offset': offset}
            if messages and used + size(message_payload(value)) + 2 > plan['capacity']:
                break
            if size(message_payload(value)) + 2 > plan['capacity']:
                lo, hi = 0, len(text) - offset
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if size(message_payload({**value, 'text': text[offset:offset + mid]})) + 2 <= plan['capacity']:
                        lo = mid
                    else:
                        hi = mid - 1
                if not lo:
                    raise ValueError('复用资料元数据超过当前分页容量')
                value.update(text=text[offset:offset + lo], next_text_offset=offset + lo)
                offset += lo
                messages.append(value)
                originals.append(original)
                break
            messages.append(value)
            originals.append(original)
            used += size(message_payload(value)) + 2
            consumed += 1
            offset = 0
            if probe_budget is not None and used > probe_budget:
                break
        position += consumed
        more = consumed < len(rows) or len(rows) == 100
        plan['replay_cursor'] = [position, offset]
        return {'messages': messages, 'originals': originals, 'has_more': more, 'warning': '',
            'data_source': 'saved_task_snapshot'}, {**scope, 'read_complete': not more,
                'conversation_index': 0 if more else len(scope['conversations']), 'cursor': json.dumps([position, offset])}

    def messages(self, parent, refs):
        originals = self.guard(parent)['evidence'].get_many(r['source'] for r in refs)
        values = []
        for ref in refs:
            original = self.get(parent, ref['snapshot']) if ref.get('snapshot') else originals.get(ref['source'])
            if original is None:
                raise ValueError('分片原文缺失，不能跳过正文宣称完成')
            values.append({**original, 'text': original.get('text', '')[ref['start']:ref['end']],
                'text_offset': ref['start'], 'next_text_offset': ref['end'],
                'fragment_complete': ref['end'] >= len(original.get('text', '')),
                **({'context_only': True} if ref.get('context_only') else {})})
        return values

    def assigned_messages(self, child, source=''):
        parent = self.service.guard(child['parent_run_id'])
        if parent['version'] != child['parent_version']:
            from .agent_service import Revised
            raise Revised()
        manifest = self.get(parent, child['manifest_id'])
        refs = [r for r in manifest['core'] + manifest['context'] if not source or r['source'] == source]
        return self.messages(parent, sorted(refs, key=lambda r: (r['time'], r['source'], r['start'])))

    def refresh(self, parent, scope):
        if not scope.get('analysis_plan'):
            return
        plan = self.get(parent, scope['analysis_plan'])
        if not plan:
            return
        for job in self.jobs(parent, plan['id'], ['interrupted']):
            child = self.service.store.get('agent_run', job['child_run_id']) or {}
            if child.get('needs_source_refresh'):
                job.update(status='completed', warnings=[], error='', result_handle='findings')
                self.service.deep_job(parent, job)
        plan.update(scan={**scope, 'cursor': '', 'conversation_index': 0, 'read_complete': False,
            'pending_page': '', 'warnings': []}, scan_complete=False, buffer=[], warnings=[],
            phase='partitioning', refreshing=True)
        plan.pop('result', None)
        plan.pop('reuse_version', None)
        self.save(parent, plan)

    def jobs(self, parent, plan_id, statuses=None):
        self.guard(parent)
        with self.service.store.connection() as db:
            query = 'SELECT body FROM agent_subtask WHERE parent_id=? AND version=? AND json_extract(body,\'$.plan_id\')=?'
            args = [parent['id'], parent['version'], plan_id]
            if statuses:
                query += ' AND status IN (' + ','.join('?' for _ in statuses) + ')'
                args.extend(statuses)
            return [json.loads(r[0]) for r in db.execute(query + ' ORDER BY ordinal', args)]

    def claim(self, parent, plan_id):
        self.guard(parent)
        with self.service.store.connection() as db:
            row = db.execute("SELECT body FROM agent_subtask WHERE parent_id=? AND version=? AND status='queued' "
                "AND json_extract(body,'$.plan_id')=? ORDER BY ordinal LIMIT 1", (parent['id'], parent['version'], plan_id)).fetchone()
            if not row:
                return None
            job = json.loads(row[0])
            job.update(status='running', started_at=time.time(), stage='正在分析分配的资料')
            db.execute("UPDATE agent_subtask SET status='running',body=?,updated=? WHERE id=? AND status='queued'",
                (json.dumps(job, ensure_ascii=False), time.time(), job['id']))
        self.publish(parent)
        self.wake(parent).set()
        return job

    def enqueue(self, parent, plan, *, whole=False, persist=True):
        target = 2 * plan['capacity']
        used, stop, cuts = 0, 0, []
        for index, ref in enumerate(plan['buffer']):
            if stop and used + ref['weight'] > target:
                break
            used += ref['weight']
            stop = index + 1
            if stop < len(plan['buffer']):
                following = plan['buffer'][stop]
                if used >= target * .8 and (ref['username'] != following['username'] or following['time'] - ref['time'] >= 1800):
                    cuts.append(stop)
        if cuts:
            stop = cuts[-1]
        if whole:
            stop = len(plan['buffer'])
        core = plan['buffer'][:stop]
        if not core:
            return None
        remaining = plan['buffer'][stop:]
        context, context_size = [], 0
        candidates = ([r for r in plan['previous'] if r['username'] == core[0]['username']][-10:]
            + [r for r in remaining if r['username'] == core[-1]['username']][:10])
        for ref in candidates:
            if ref['source'] not in {r['source'] for r in core} and context_size + ref['weight'] <= plan['capacity'] * .1:
                context.append({**ref, 'context_only': True})
                context_size += ref['weight']
        signature = fingerprint([parent['id'], parent['version'], PLAN_VERSION, plan['objective'], plan['role'], core])
        manifest = {'id': 'manifest:' + signature, 'plan_id': plan['id'], 'core': core, 'context': context,
            'scope_handle': plan['scope_handle'], 'scan_cursor': plan['scan'], 'warnings': list(plan['warnings'])}
        scope = self.gateway(parent).scope(plan['scope_handle'])
        users = list(dict.fromkeys(r['username'] for r in core))
        job = {'id': signature, 'parent_id': parent['id'], 'version': parent['version'], 'account': parent['account'],
            'plan_id': plan['id'], 'plan_version': PLAN_VERSION, 'manifest_id': manifest['id'],
            'child_run_id': 'deep-child:' + signature, 'role': plan['role'], 'objective': plan['objective'],
            'name': '、'.join(scope.get('names', {}).get(u, u) for u in users[:3]) + f" · 分片 {plan['next_ordinal'] + 1}",
            'time_range': {'start': min(r['time'] for r in core), 'end': max(r['time'] for r in core) + 1},
            'scope': users, 'status': 'queued', 'stage': '等待执行槽位', 'created': time.time(),
            'coverage': {'read': len({r['source'] for r in core}), 'analyzed': 0, 'complete': False},
            'result_handle': '', 'warnings': list(plan['warnings'])}
        plan['buffer'] = remaining
        plan['previous'] = (plan['previous'] + core)[-10:]
        plan['next_ordinal'] += 1
        if not persist:
            return job, manifest
        self.save(parent, plan, [(manifest['id'], 'analysis_manifest', manifest)], job)
        self.publish(parent)
        return job

    def reset_jobs(self, parent, plan):
        for job in self.jobs(parent, plan['id'], ['running', 'failed', 'interrupted', 'cancelled']):
            job.update(status='queued', error='', finished_at=None, stage='等待恢复未完成部分')
            self.service.deep_job(parent, job)

    def metrics(self, parent, plan):
        """以正文区间计量覆盖和重复提交；模型耗时与用量仍由现有 usage 审计记录。"""
        read, analyzed = {}, {}
        for job in self.jobs(parent, plan['id']):
            manifest = self.get(parent, job['manifest_id'])
            for ref in manifest['core']:
                read.setdefault(ref['source'], []).append((ref['start'], ref['end']))
            with self.service.store.connection() as db:
                for row in db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=1 AND kind='stage_note'", (job['child_run_id'],)):
                    for ref in json.loads(row[0]).get('covered', []):
                        analyzed.setdefault(ref['source'], []).append((ref['start'], ref['end']))
        def length(values):
            total = 0
            for spans in values.values():
                end = 0
                for lo, hi in sorted(spans):
                    total += max(0, hi - max(end, lo))
                    end = max(end, hi)
            return total
        unique = length(analyzed)
        return {'read_sources': len(read), 'analyzed_sources': len(analyzed),
            'read_characters': length(read), 'analyzed_characters': unique,
            'repeated_characters': sum(hi - lo for spans in analyzed.values() for lo, hi in spans) - unique,
            'first_partition_seconds': max(0, plan.get('first_started_at', plan['created']) - plan['created']),
            'wall_seconds': max(0, time.time() - plan['created']), 'reused_partitions': plan.get('reused', 0)}

    def split_failed(self, parent, plan):
        """仅重分上下文失败的未提交正文，完成区间仍由原子任务的笔记证明。"""
        changed = False
        for job in self.jobs(parent, plan['id'], ['failed']):
            if self.queued_count(parent) > QUEUE_LIMIT - 2:
                break
            if not re.search(r'上下文|窗口|context.{0,20}(?:length|window|overflow)', job.get('error', ''), re.I):
                continue
            manifest = self.get(parent, job['manifest_id'])
            with self.service.store.connection() as db:
                notes = [json.loads(r[0]) for r in db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=1 AND kind='stage_note'", (job['child_run_id'],))]
            covered = {}
            for note in notes:
                for ref in note.get('covered', []):
                    covered.setdefault(ref['source'], []).append((ref['start'], ref['end']))
            remaining = []
            for ref in manifest['core']:
                remaining.extend(uncommitted(ref, covered))
            if not remaining:
                job.update(status='completed', error='', result_handle='findings')
                self.service.deep_job(parent, job)
                changed = True
                continue
            if len(remaining) == 1:
                ref = remaining[0]
                if ref['end'] - ref['start'] <= 1:
                    continue
                middle = (ref['start'] + ref['end']) // 2
                remaining = [{**ref, 'end': middle, 'weight': max(1, ref['weight'] // 2)},
                    {**ref, 'start': middle, 'weight': max(1, ref['weight'] // 2)}]
            middle = max(1, len(remaining) // 2)
            original_buffer, previous = plan['buffer'], plan['previous']
            replacements, pieces = [], []
            for half in (remaining[:middle], remaining[middle:]):
                plan.update(buffer=half, previous=[])
                replacement, new_manifest = self.enqueue(parent, plan, whole=True, persist=False)
                replacement['replacement_reason'] = '原分片上下文超限，仅重分尚未提交的正文。'
                replacement['replaces'] = job['id']
                replacements.append(replacement)
                pieces.append((new_manifest['id'], 'analysis_manifest', new_manifest))
            plan.update(buffer=original_buffer, previous=previous)
            job.update(status='superseded', replacement_reason='未完成正文已拆为更小分片，已提交发现继续复用。')
            self.save(parent, plan, pieces, jobs=replacements, replaced=job)
            self.publish(parent)
            self.wake(parent).set()
            changed = True
        return changed

    def validate(self, parent, plan, *, ignore_warnings=False):
        if not plan['scan_complete'] or plan['buffer']:
            return False
        manifests, spans = [], {}
        for job in self.jobs(parent, plan['id']):
            if job['status'] not in ('completed', 'superseded'):
                child = self.service.store.get('agent_run', job['child_run_id']) or {}
                if not (ignore_warnings and job['status'] == 'interrupted' and child.get('needs_source_refresh')):
                    return False
            manifests.append(self.get(parent, job['manifest_id']))
            with self.service.store.connection() as db:
                rows = db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='stage_note'",
                    (job['child_run_id'], 1)).fetchall()
            for row in rows:
                for ref in json.loads(row[0]).get('covered', []):
                    spans.setdefault(ref['source'], []).append((ref['start'], ref['end']))
        for manifest in manifests:
            for ref in manifest['core']:
                position = ref['start']
                for lo, hi in sorted(spans.get(ref['source'], [])):
                    if lo <= position:
                        position = max(position, hi)
                if position < ref['end'] or ref['source'] not in spans:
                    return False
        return True
