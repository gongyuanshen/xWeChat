"""内容分片的执行与归并；所有模型调用仍经过官方图和统一调度器。"""
import asyncio
import json
import time

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from .agent_budget import size, message_payload, input_limit
from .deep_partition import AnalysisPlans, PLAN_VERSION, QUEUE_LIMIT, WORKERS, fingerprint, capacity, covered_part
from .deep_tools import ChatGateway
from .providers import ProviderFailure
from .agent_schemas import AgentControl


class ParallelAnalysis:
    @property
    def planned_work(self):
        from .deep_planning import PlannedWork
        if not hasattr(self, '_planned_work'):
            self._planned_work = PlannedWork(self)
        return self._planned_work

    @property
    def analysis_plans(self):
        if not hasattr(self, '_analysis_plans'):
            self._analysis_plans = AnalysisPlans(self)
        return self._analysis_plans

    async def read_manifest(self, gateway, state):
        child = gateway.guard()
        parent = self.guard(child['parent_run_id'])
        manifest = self.analysis_plans.get(parent, child['manifest_id'])
        if not manifest or parent['version'] != child['parent_version']:
            raise ValueError('分片清单已失效')
        position, offset = json.loads(state['cursor']) if state['cursor'] else (0, 0)
        page_capacity = capacity(self, child)
        selected, used = [], 2
        while position < len(manifest['core']):
            ref = manifest['core'][position]
            value = self.analysis_plans.messages(parent, [{**ref, 'start': ref['start'] + offset}])[0]
            payload = message_payload(value)
            weight = size(payload) + 2
            if selected and used + weight > page_capacity:
                break
            if not selected and weight > page_capacity:
                text = value['text']
                lo, hi = 0, len(text)
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if size({**payload, 'text': text[:mid]}) + 2 <= page_capacity:
                        lo = mid
                    else:
                        hi = mid - 1
                if not lo:
                    raise ProviderFailure('分片来源元数据超出模型预算，已保留断点')
                value.update(text=text[:lo], next_text_offset=value['text_offset'] + lo, fragment_complete=False)
                offset += lo
                selected.append(value)
                break
            selected.append(value)
            used += weight
            position, offset = position + 1, 0
        originals = parent['evidence'].get_many(m['source'] for m in selected)
        for ref in manifest['core']:
            if ref['source'] in originals and ref.get('snapshot'):
                originals[ref['source']] = self.analysis_plans.get(parent, ref['snapshot'])
        payload = gateway.save_messages(selected, list(originals.values()))
        background = self.analysis_plans.messages(parent, manifest['context']) if state['pages'] == 0 else []
        if background:
            bg_originals = parent['evidence'].get_many(m['source'] for m in background)
            for ref in manifest['context']:
                if ref.get('snapshot'):
                    bg_originals[ref['source']] = self.analysis_plans.get(parent, ref['snapshot'])
            background = gateway.save_messages(background, list(bg_originals.values()))
        more = position < len(manifest['core'])
        page_id = f"page:{state['handle']}:{state['pages']:08d}"
        result = {'page_id': page_id, 'scope_handle': state['handle'], 'messages': payload,
            'background': background, 'has_more': more, 'requires_commit': True,
            'warning': '；'.join(manifest.get('warnings', [])),
            'instruction': '仅为 messages 提交发现；background 只用于理解边界，不计入正文覆盖。跨片关系留作待核查。'}
        next_state = {**state, 'pages': state['pages'] + 1, 'cursor': json.dumps([position, offset]),
            'pending_page': page_id, 'read_complete': not more, 'warnings': manifest.get('warnings', [])}
        self.workspace.put_pieces(child['id'], child['version'], [(page_id, 'deep_page', {'result': result,
            'covered': [{'source': m['source'], 'start': m.get('text_offset', 0),
                'end': m.get('text_offset', 0) + len(m.get('text', ''))} for m in selected]}),
            ('scope:' + state['handle'], 'deep_scope', next_state)])
        gateway.coverage()
        return result

    def create_partition_child(self, parent, job, scope):
        prior = self.store.get('agent_run', job['child_run_id'])
        if prior:
            if prior['status'] != 'completed':
                self.update(prior['id'], status='queued', error='', finished_at=None, segment_started=time.time())
            return self.run(prior['id'])
        now = time.time()
        users = job.get('scope') or scope['conversations']
        bound = {'conversations': users, 'start': scope['start'], 'end': scope['end'], 'sender': scope.get('sender', '')}
        description = job['objective']
        if job['role'] == 'range-analyst':
            description += '\n只分析程序清单中的正文并逐页提交发现。保留实体、事件时间、变化、关系线索和疑点；不撰写完整报告，不计算跨片总额。'
        else:
            description += '\n只完成这个独立检索或核查目标；证据足够即结束，不能把搜索命中声称为全量覆盖。'
        child = {k: parent[k] for k in ('account', 'profile', 'vision', 'timezone', 'timezone_offset', 'cutoff', 'effort', 'input_budget')}
        child.update(id=job['child_run_id'], thread_id='deep-thread:' + job['id'], parent_run_id=parent['id'],
            parent_version=parent['version'], version=1, applied_version=1, engine='deepagents', engine_version=3,
            checkpoint_schema=2, subtask_plan_version=PLAN_VERSION, child_role=job['role'], subtask_id=job['id'],
            manifest_id=job.get('manifest_id'), analysis_objective=job['objective'], bound_scope=bound,
            status='queued', stage='等待分析', stage_started_at=now, started_at=now, segment_started=now,
            created=now, elapsed_seconds=0, finished_at=None, input_digest=description, answer='', error='',
            query_scope=users, scope_handle='', time_range={k: scope[k] for k in ('start', 'end')},
            read_count=0, used={'tools': 0, 'models': 0, 'media': 0}, observations=[], activity=[],
            scope_revision=0, required_conversations=[], coverage_state='not_applicable', request_ids=[])
        self.store.put('agent_thread', {'id': child['thread_id'], 'account': parent['account'], 'username': users[0],
            'parent_run_id': parent['id'], 'scope': users, 'scope_revision': 0, 'messages': [],
            'latest_run': child['id'], 'title': job['name']})
        self.store.put('agent_run', child)
        directory = self.workspace.get(parent['id'], parent['version'], 'directory:conversations')
        if directory is not None:
            self.workspace.put(child['id'], 1, 'directory:conversations', 'deep_directory', directory)
        return self.run(child['id'])

    def merge_partition(self, parent, child, job):
        self.analysis_plans.guard(parent)
        self.workspace.inherit(child['id'], parent['id'])
        with self.store.connection() as db:
            rows = db.execute("SELECT id,kind,body FROM agent_piece WHERE run_id=? AND version=? AND "
                "(kind IN ('finding','stage_note','deep_media_result','deep_search_coverage') OR (kind='deep_file' AND id LIKE 'file:/results/media/%'))",
                (child['id'], child['version'])).fetchall()
        pieces = []
        for row in rows:
            body = json.loads(row[2])
            # 同来源但不同事实不能误合并；完全相同事实跨重试只保留一份。
            if row[1] == 'finding':
                body['sources'] = sorted(set(body.get('sources', [])))
            key = ('finding:' + fingerprint(body) if row[1] == 'finding' else
                row[0] if row[1] in ('deep_media_result', 'deep_file') else f"child:{job['id']}:{row[0]}")
            pieces.append((key, row[1], body))
        self.workspace.put_pieces(parent['id'], parent['version'], pieces)
        refs = {**self.run(parent['id']).get('references', {}), **child.get('references', {})}
        self.update(parent['id'], references=refs, read_count=len(self.run(parent['id'])['evidence']))

    async def work_partition(self, parent, job, scope):
        try:
            child = self.create_partition_child(parent, job, scope)
            if child['status'] != 'completed':
                self.update(child['id'], status='running')
                if not child.get('scope_handle'):
                    await ChatGateway(self, child['id'], child['version']).select(conversations=child['bound_scope']['conversations'],
                        complete=job['role'] == 'range-analyst')
                await self.execute(child['id'])
            self.analysis_plans.guard(parent)
            child = self.run(child['id'])
            self.merge_partition(parent, child, job)
            job.update(status=child['status'], error=child.get('error', ''), finished_at=time.time(),
                coverage={'read': child.get('read_count', 0),
                    'analyzed': sum(c.get('analyzed', 0) for c in child.get('analysis', {}).get('coverage', [])),
                    'complete': bool(child.get('analysis', {}).get('complete'))},
                result_handle='findings' if child['status'] == 'completed' else '')
            if child['status'] not in ('completed', 'failed', 'interrupted', 'cancelled'):
                job['status'] = 'failed'
            self.deep_job(parent, job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.analysis_plans.guard(parent)
            job.update(status='failed', error=str(exc), finished_at=time.time())
            self.deep_job(parent, job)

    async def execute_plan(self, parent, plan):
        manager = self.analysis_plans
        gateway = manager.gateway(parent)
        async with manager.lock(parent, 'execute:' + plan['id']):
            plan = manager.get(parent, plan['id'])
            if plan.get('phase') == 'completed':
                return plan
            manager.reset_jobs(parent, plan)
            plan['reused'] = len(manager.jobs(parent, plan['id'], ['completed']))
            plan.update(mode='parallel', phase='analyzing')
            manager.save(parent, plan)
            changed = manager.wake(parent)
            producer_done = asyncio.Event()

            async def produce():
                try:
                    while True:
                        manager.guard(parent)
                        while manager.queued_count(parent) >= QUEUE_LIMIT:
                            changed.clear()
                            await changed.wait()
                        # 向前多读一页仅用于下一片及边界背景；读取内容始终缓存。
                        while not plan['scan_complete'] and sum(r['weight'] for r in plan['buffer']) <= 2 * plan['capacity']:
                            await manager.fetch(parent, plan)
                        if not plan['buffer']:
                            break
                        while manager.queued_count(parent) >= QUEUE_LIMIT:
                            changed.clear()
                            await changed.wait()
                        manager.enqueue(parent, plan)
                        changed.set()
                        await asyncio.sleep(0)
                    manager.save(parent, plan)
                    manager.publish(parent)
                finally:
                    producer_done.set()
                    changed.set()

            async def consume():
                while True:
                    manager.guard(parent)
                    async with manager.slot(parent):
                        job = manager.claim(parent, plan['id'])
                        if job:
                            if not plan.get('first_started_at'):
                                plan['first_started_at'] = time.time()
                                manager.save(parent, plan)
                            changed.set()
                            await self.work_partition(parent, job, gateway.scope(plan['scope_handle']))
                            changed.set()
                            continue
                    if producer_done.is_set():
                        return
                    changed.clear()
                    # 清理通知后复查数据库，避免生产者最后一次通知丢失。
                    if manager.jobs(parent, plan['id'], ['queued']) or producer_done.is_set():
                        continue
                    await changed.wait()

            tasks = [asyncio.create_task(produce()), *(asyncio.create_task(consume()) for _ in range(WORKERS))]
            try:
                await asyncio.gather(*tasks)
                # 兄弟任务先完成，再为超限正文分片；不原样重试整片。
                for _ in range(16):
                    if not manager.split_failed(parent, plan):
                        break
                    tasks = [asyncio.create_task(consume()) for _ in range(WORKERS)]
                    await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                # 取消时允许结算旧版本自己的作业，绝不发布到新版本父任务。
                with self.store.connection() as db:
                    rows = db.execute("SELECT id,body FROM agent_subtask WHERE parent_id=? AND version=? AND status='running' "
                        "AND json_extract(body,'$.plan_id')=?", (parent['id'], parent['version'], plan['id'])).fetchall()
                    for key, raw in rows:
                        body = {**json.loads(raw), 'status': 'interrupted', 'finished_at': time.time()}
                        db.execute("UPDATE agent_subtask SET status='interrupted',body=?,updated=? WHERE id=?",
                            (json.dumps(body, ensure_ascii=False), time.time(), key))
            if not manager.validate(parent, plan):
                plan['phase'] = 'interrupted'
                plan['metrics'] = manager.metrics(parent, plan)
                manager.save(parent, plan)
                manager.publish(parent)
                if plan['warnings'] and manager.validate(parent, plan, ignore_warnings=True):
                    scope = gateway.scope(plan['scope_handle'])
                    scope.update(warnings=plan['warnings'])
                    gateway.put('scope:' + scope['handle'], 'deep_scope', scope)
                    self.update(parent['id'], needs_source_refresh=True)
                    from .deep_runtime import DeepSourceGap
                    raise DeepSourceGap('已处理可用资料，数据源仍有缺口，恢复后可继续。' + '；'.join(plan['warnings']))
                raise ProviderFailure('部分分片未完成，已保留全部成功结果与断点，可继续分析。')
            scope = gateway.scope(plan['scope_handle'])
            scope.update(read_complete=True, pending_page='', delegated=True, warnings=plan['warnings'])
            gateway.put('scope:' + scope['handle'], 'deep_scope', scope)
            gateway.coverage()
            if plan['warnings']:
                plan['phase'] = 'interrupted'
                manager.save(parent, plan)
                self.update(parent['id'], needs_source_refresh=True)
                from .deep_runtime import DeepSourceGap
                raise DeepSourceGap('可用分片已处理，数据源仍有缺口，已保存结果。' + '；'.join(plan['warnings']))
            plan['phase'] = 'reducing'
            manager.save(parent, plan)
            manager.publish(parent)
            plan['result'] = await self.reduce_plan(parent, plan)
            plan.update(phase='completed', finished_at=time.time(), metrics=manager.metrics(parent, plan))
            manager.save(parent, plan)
            gateway.coverage()
            manager.publish(parent)
            return plan

    async def reduce_plan(self, parent, plan):
        """归并必须访问每份发现；摘要之外的原始事实始终保留在结果索引。"""
        from .deep_model import DeepChatModel
        from .deep_backend import TaskBackend
        model = DeepChatModel(service=self, run_id=parent['id'], input_version=parent['version'], purpose='summary')
        budget = max(1024, min(12000, input_limit(self.profile(parent)) // 4))
        scope = self.analysis_plans.gateway(parent).scope(plan['scope_handle'])
        with self.store.connection() as db:
            # 同一父任务可同时处理不同对象，归并不能混入其他范围尚未完成的发现。
            rows = db.execute("SELECT f.id,f.body FROM agent_piece f WHERE f.run_id=? AND f.version=? AND f.kind='finding' "
                "AND EXISTS(SELECT 1 FROM json_each(f.body,'$.sources') s JOIN agent_material m ON m.source=s.value AND m.run_id=f.run_id "
                "WHERE json_extract(m.body,'$.username') IN (" + ','.join('?' for _ in scope['conversations']) + ") "
                "AND json_extract(m.body,'$.time')>=? AND json_extract(m.body,'$.time')<? "
                "AND (?='' OR coalesce(json_extract(m.body,'$.sender_id'),json_extract(m.body,'$.media.senderUsername'),json_extract(m.body,'$.sender'))=?) "
                "AND (? IS NULL OR EXISTS(SELECT 1 FROM agent_piece p WHERE p.run_id=f.run_id AND p.version=f.version AND p.kind='analysis_plan_source' "
                "AND json_extract(p.body,'$.plan_id')=? AND json_extract(p.body,'$.source')=s.value))) ORDER BY f.id",
                (parent['id'], parent['version'], *scope['conversations'], scope['start'], scope['end'],
                 scope.get('sender', ''), scope.get('sender', ''), scope.get('message_count'), plan['id'])).fetchall()
        entries = [{'id': row[0], **json.loads(row[1])} for row in rows]
        root = '/results/subtasks/' + plan['id'].split(':')[-1]
        backend = TaskBackend(self, parent['id'], parent['version'])
        def write_index(path, value):
            result = backend.write(path, json.dumps(value, ensure_ascii=False, indent=2))
            if result.error:
                raise ProviderFailure('原始发现已保存，结果索引写入失败：' + result.error)
        for offset in range(0, len(entries), 512):
            write_index(f'{root}/{offset // 512}.json', {'findings': [e['id'] for e in entries[offset:offset + 512]]})
        write_index(root + '.json', {'plan': plan['id'], 'finding_count': len(entries),
            'index_pages': (len(entries) + 511) // 512, 'index_path_pattern': root + '/{page}.json',
            'instruction': '索引页从 0 开始；read_results 分页回查全部原始发现。摘要不是原文证据。'})
        nodes = entries
        level = 0
        while size(nodes) > budget:
            groups, group = [], []
            for entry in nodes:
                if group and size([*group, entry]) > budget:
                    groups.append(group)
                    group = []
                group.append(entry)
            if group:
                groups.append(group)
            reduced = []
            for group in groups:
                key = 'reduce:' + fingerprint([plan['id'], plan['objective'], group])
                saved = self.workspace.get(parent['id'], parent['version'], key)
                if saved is None:
                    request = [SystemMessage(content='将这组分析发现归并为精简 JSON：{"text":"关联摘要","sources":["真实来源"],"unresolved":["影响答案的疑点"]}。'
                        '按实体、事件和时间关联，保留取消、变化、冲突和不确定性；同名不等于同一人。不得相加未确认关系的款项。'
                        '摘要不超过输入的一半，来源仅选支持摘要的输入来源。完整事实已经另存，不复制全部原文。'),
                        HumanMessage(content=json.dumps({'objective': plan['objective'], 'findings': group}, ensure_ascii=False))]
                    response = await model.ainvoke(request, config={'callbacks': [], 'tags': ['internal']})
                    self.analysis_plans.guard(parent)
                    try:
                        content = str(response.content).strip()
                        if content.startswith('```'):
                            content = content.split('\n', 1)[1].rsplit('```', 1)[0]
                        saved = json.loads(content)
                        allowed = {s for e in group for s in e.get('sources', [])}
                        if not isinstance(saved.get('text'), str) or not saved['text'].strip() or not isinstance(saved.get('sources'), list) or not set(saved['sources']) <= allowed or (allowed and not saved['sources']):
                            raise ValueError('归并结果来源无效')
                        if size(saved) >= size(group):
                            raise ValueError('归并结果未缩小，不能继续重复压缩')
                    except (ValueError, TypeError, AttributeError) as exc:
                        raise ProviderFailure('分片结果已保存，汇总未通过校验，可继续恢复：' + str(exc)) from exc
                    self.workspace.put(parent['id'], parent['version'], key, 'analysis_reduction',
                        {**saved, 'input_ids': [e['id'] for e in group]})
                reduced.append({k: v for k, v in saved.items() if k != 'input_ids'} | {'id': key})
            nodes = reduced
            level += 1
            if level > 12:
                raise ProviderFailure('汇总层级过多，已保留中间结果，请调整输出要求后继续')
        result = {'result_path': root + '.json', 'scope_handle': plan['scope_handle'], 'coverage': 'complete',
            'total': sum(j['status'] != 'superseded' for j in self.analysis_plans.jobs(parent, plan['id'])), 'finding_count': len(entries), 'summary': nodes,
            'findings_tool': 'read_results', 'requires_commit': False,
            'instruction': '全部分片已完成。利用摘要和 read_results 汇总；跨片关系需来源支持。仅对影响答案的疑点调用 fact-checker，最多两轮新证据核查；不要重复完整读取。'}
        return result

    async def focused_task(self, parent, scope, role, objective):
        manager = self.analysis_plans
        with self.store.connection() as db:
            evidence = [(r[0], fingerprint(r[1])) for r in db.execute("SELECT source,json_extract(body,'$.text') FROM agent_material WHERE run_id=? ORDER BY source", (parent['id'],))]
        epoch = fingerprint(evidence)
        key = 'focus:' + fingerprint([scope['handle'], role, objective, epoch])
        async with manager.lock(parent, key):
            prior = manager.get(parent, key)
            if prior and prior.get('result'):
                return prior['result']
            if role == 'fact-checker':
                rounds = manager.get(parent, 'verification:epochs') or {'epochs': []}
                if epoch not in rounds['epochs']:
                    if len(rounds['epochs']) >= 2:
                        return {'coverage': 'search_only', 'unresolved': objective, 'instruction': '已完成两轮补充核查，保留不确定性，不再重复查询。'}
                    rounds['epochs'].append(epoch)
                    self.workspace.put(parent['id'], parent['version'], 'verification:epochs', 'verification_rounds', rounds)
            signature = fingerprint([parent['id'], parent['version'], PLAN_VERSION, key])
            job = {'id': signature, 'parent_id': parent['id'], 'version': parent['version'], 'account': parent['account'],
                'plan_id': key, 'plan_version': PLAN_VERSION, 'child_run_id': 'deep-child:' + signature,
                'role': role, 'objective': objective, 'scope': scope['conversations'],
                'name': '事实核查' if role == 'fact-checker' else '专题检索', 'status': 'queued',
                'stage': '等待执行槽位', 'created': time.time(), 'result_handle': '',
                'time_range': {k: scope[k] for k in ('start', 'end')}}
            self.deep_job(parent, job)
            try:
                async with manager.slot(parent):
                    job.update(status='running', started_at=time.time())
                    self.deep_job(parent, job)
                    await self.work_partition(parent, job, scope)
            except (asyncio.CancelledError, AgentControl):
                # 只结算原版本作业，不允许迟到的取消通知修改新任务。
                with self.store.connection() as db:
                    job.update(status='interrupted', finished_at=time.time(), stage='已暂停，可继续未完成部分')
                    db.execute("UPDATE agent_subtask SET status='interrupted',body=?,updated=? WHERE id=? AND version=?",
                        (json.dumps(job, ensure_ascii=False), time.time(), job['id'], parent['version']))
                raise
            if job['status'] != 'completed':
                raise ProviderFailure('独立检索或核查尚未完成，已保留进度。' + job.get('error', ''))
            child = self.run(job['child_run_id'])
            result = {'coverage': 'checked' if role == 'fact-checker' else 'search_only', 'answer': child['answer'],
                'requires_commit': False, 'instruction': '此结果只支持本次独立目标，不能代替全量范围覆盖。'}
            self.workspace.put(parent['id'], parent['version'], key, 'analysis_focus', {'result': result})
            return result

    async def parallel_child(self, inputs, binding):
        parent = self.guard(binding['parent_id'])
        scope, role = binding['scope'], binding['role']
        objective = str(inputs['messages'][-1].content)
        if role != 'range-analyst':
            result = await self.focused_task(parent, scope, role, objective)
        else:
            gateway = ChatGateway(self, parent['id'], parent['version'])
            if scope.get('pending_page'):
                raise ValueError('先提交待分析页，再委派剩余范围')
            plan = await self.analysis_plans.prepare(gateway, scope)
            if plan['mode'] == 'direct':
                result = {'scope_handle': scope['handle'], 'coverage': 'pending', 'next_tool': 'read_messages',
                    'instruction': '范围较小，主任务直接 read_messages 使用预读资料，无需启动子 Agent。'}
            else:
                plan = await self.execute_plan(parent, plan)
                result = plan['result']
        return {'messages': [AIMessage(content=json.dumps(result, ensure_ascii=False))]}
