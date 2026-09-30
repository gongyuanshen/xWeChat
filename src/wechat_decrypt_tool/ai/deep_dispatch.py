"""内容分片的执行与归并；所有模型调用仍经过官方图和统一调度器。"""
import asyncio
import json
import re
import time

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from .agent_budget import size, message_payload, input_limit
from .deep_partition import AnalysisPlans, PLAN_VERSION, QUEUE_LIMIT, WORKERS, fingerprint, capacity, covered_part
from .deep_tools import ChatGateway
from .providers import ProviderFailure
from .agent_schemas import AgentControl
from .model_execution import model_policy


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
                "(kind IN ('finding','stage_note','deep_media_result','deep_search_coverage') OR (kind='deep_file' AND (id LIKE 'file:/results/media/%' OR id LIKE 'file:/notes/%')))",
                (child['id'], child['version'])).fetchall()
            parent_note_rows = db.execute(
                "SELECT id FROM agent_piece WHERE run_id=? AND version=? AND kind='deep_file' AND id LIKE 'file:/notes/%'",
                (parent['id'], parent['version'])).fetchall()

        existing_note_keys = {r[0] for r in parent_note_rows}
        existing_batch_indices = set()
        for k in existing_note_keys:
            m = re.match(r'^file:/notes/batch_(\d+)\.json$', k)
            if m:
                existing_batch_indices.add(int(m.group(1)))

        sorted_rows = sorted(rows, key=lambda r: (0 if r[1] == 'deep_file' else 1, r[0]))
        path_remap = {}
        pieces = []

        for row in sorted_rows:
            body = json.loads(row[2])
            # 同来源但不同事实不能误合并；完全相同事实跨重试只保留一份。
            if row[1] == 'finding':
                body['sources'] = sorted(set(body.get('sources', [])))
                key = 'finding:' + fingerprint(body)
            elif row[1] == 'deep_media_result':
                key = row[0]
            elif row[1] == 'deep_file':
                if row[0].startswith('file:/notes/'):
                    if row[0] in existing_note_keys:
                        next_idx = max(existing_batch_indices, default=0) + 1
                        existing_batch_indices.add(next_idx)
                        new_path = f"/notes/batch_{next_idx:05d}.json"
                        key = f"file:{new_path}"
                        existing_note_keys.add(key)
                        old_path = row[0].removeprefix('file:')
                        path_remap[old_path] = (new_path, next_idx)
                        if isinstance(body, dict):
                            body['path'] = new_path
                            if 'batch_index' in body:
                                body['batch_index'] = next_idx
                            for ckey in ('content', 'data'):
                                if ckey not in body:
                                    continue
                                val = body[ckey]
                                if isinstance(val, str):
                                    try:
                                        nd = json.loads(val)
                                        if isinstance(nd, dict):
                                            nd['batch_index'] = next_idx
                                            if 'note_path' in nd:
                                                nd['note_path'] = new_path
                                            if 'path' in nd:
                                                nd['path'] = new_path
                                            body[ckey] = json.dumps(nd, ensure_ascii=False, indent=2)
                                    except Exception:
                                        pass
                                elif isinstance(val, dict):
                                    val['batch_index'] = next_idx
                                    if 'note_path' in val:
                                        val['note_path'] = new_path
                                    if 'path' in val:
                                        val['path'] = new_path
                    else:
                        key = row[0]
                        existing_note_keys.add(key)
                        m = re.match(r'^file:/notes/batch_(\d+)\.json$', row[0])
                        if m:
                            existing_batch_indices.add(int(m.group(1)))
                        if isinstance(body, dict):
                            body.setdefault('path', row[0].removeprefix('file:'))
                else:
                    key = row[0]
            else:
                key = f"child:{job['id']}:{row[0]}"
                if row[1] == 'stage_note' and isinstance(body, dict):
                    if body.get('note_path') in path_remap:
                        new_p, new_i = path_remap[body['note_path']]
                        body['note_path'] = new_p
                        body['batch_index'] = new_i

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
                if job.get('role') == 'range-analyst':
                    with model_policy(constrain_thinking=True):
                        await self.execute(child['id'])
                else:
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
        from .agent_notes import load_stage_notes

        stage_notes = load_stage_notes(self.store, parent['id'], parent['version'])
        if stage_notes:
            await self.aggregate_stage_notes(parent)

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
        if stage_notes:
            result['aggregated_notes_path'] = '/notes/aggregated.json'
        return result

    async def relay_compress_group(self, parent: dict, group_id: str, batch_notes: list[dict]) -> dict:
        """对一组批次笔记进行中间接力压缩并写入 /notes/relay_{group_id}.json。"""
        from .deep_model import DeepChatModel
        from .deep_backend import TaskBackend
        from .agent_citation_check import compact
        from datetime import datetime, timezone

        model = DeepChatModel(service=self, run_id=parent['id'], input_version=parent['version'], purpose='summary')
        backend = TaskBackend(self, parent['id'], parent['version'])

        input_facts = []
        for n in batch_notes:
            input_facts.extend(n.get('facts') or n.get('consolidated_facts') or [])
        input_mappings = {}
        for n in batch_notes:
            input_mappings.update(n.get('message_mappings', {}))
        ev = parent.get('evidence', {})
        for s in {s for n in batch_notes for s in n.get('sources', [])}:
            if s not in input_mappings and hasattr(ev, '__contains__') and s in ev and isinstance(ev[s], dict):
                input_mappings[s] = {'sender': ev[s].get('sender', ''), 'sent_at': ev[s].get('sent_at', ''),
                                     'time': ev[s].get('time', 0), 'text': ev[s].get('text', '')}

        allowed_sources = {s for n in batch_notes for s in n.get('sources', [])}
        batches_covered = [n.get('batch_index', 0) for n in batch_notes if n.get('batch_index')]
        if not batches_covered:
            batches_covered = [int(group_id)] if group_id.isdigit() else [1]

        prompt_system = (
            "你是事实归并与精炼编辑。将这批微信事实笔记做精简接力归并，输出 JSON：\n"
            "{\n"
            '  "consolidated_facts": [\n'
            '    {\n'
            '      "text": "精炼事实陈述",\n'
            '      "sources": ["真实24位source_id"],\n'
            '      "quote": "可选逐字原话，无完全一致原话则必须省略",\n'
            '      "sender": "发送者",\n'
            '      "sent_at": "ISO时间",\n'
            '      "event_time": "原文明示事件时间",\n'
            '      "entities": ["相关实体"],\n'
            '      "relation": "关系或状态演进",\n'
            '      "evidence_status": "supported"\n'
            "    }\n"
            "  ],\n"
            '  "unresolved": ["未确认疑点"]\n'
            "}\n"
            "严格约束：\n"
            "1. sources 必须且只能从输入事实的 sources 中选取，严禁编造任何编号。\n"
            "2. quote 必须从对应消息原文连续逐字摘录；改写或概括语句严禁加引号。\n"
            "3. 必须保留关键状态转变（发起、修改、确认、取消）及金额、时间线。\n"
            "4. 压缩后的体积必须显著小于输入。"
        )
        prompt_human = json.dumps({
            'group_id': group_id,
            'batches_covered': batches_covered,
            'input_facts': input_facts,
            'message_mappings': input_mappings,
        }, ensure_ascii=False)

        request = [SystemMessage(content=prompt_system), HumanMessage(content=prompt_human)]
        response = await model.ainvoke(request, config={'callbacks': [], 'tags': ['internal', 'relay_compression']})
        content_text = re.sub(r'^```(?:json)?\s*|\s*```$', '', str(response.content).strip())
        try:
            result_dict = json.loads(content_text)
        except Exception as exc:
            raise ProviderFailure(f"接力压缩模型未返回合法 JSON：{exc}") from exc

        if isinstance(result_dict, list):
            consolidated = result_dict
            unresolved = []
        elif isinstance(result_dict, dict):
            consolidated = result_dict.get('consolidated_facts') or result_dict.get('facts') or []
            unresolved = result_dict.get('unresolved', [])
        else:
            raise ProviderFailure("接力压缩模型返回结构无效")

        for fact in consolidated:
            if isinstance(fact, dict):
                fact_sources = fact.get('sources', [])
                if not isinstance(fact_sources, list):
                    fact_sources = [fact_sources]
                    fact['sources'] = fact_sources
                if not fact_sources or not set(fact_sources) <= allowed_sources:
                    raise ValueError(f"Relay compression produced invalid sources: {fact_sources}")
                quote = fact.get('quote')
                if quote:
                    matched = any(
                        compact(quote) in compact(input_mappings.get(s, {}).get('text', ''))
                        for s in fact_sources if s in input_mappings
                    )
                    if not matched and hasattr(ev, '__contains__'):
                        matched = any(
                            compact(quote) in compact(ev[s]['text'])
                            for s in fact_sources if s in ev and isinstance(ev[s], dict) and 'text' in ev[s]
                        )
                    if not matched:
                        fact.pop('quote', None)
            elif isinstance(fact, str):
                fact_srcs = re.findall(r'\[\[([a-f0-9]{24}|src_[^\]]+)\]\]', fact)
                if fact_srcs and not set(fact_srcs) <= allowed_sources:
                    raise ValueError(f"Relay compression produced invalid sources: {fact_srcs}")

        relay_path = f"/notes/relay_{group_id}.json"
        cited_sources = {s for f in consolidated if isinstance(f, dict) for s in f.get('sources', [])}
        relay_payload = {
            'relay_id': f"relay_{group_id}",
            'group_id': group_id,
            'batch_range': [min(batches_covered, default=0), max(batches_covered, default=0)],
            'batches_covered': batches_covered,
            'messages_count': sum(n.get('messages_count', len(n.get('sources', []))) for n in batch_notes),
            'sources': sorted(allowed_sources),
            'message_mappings': {s: input_mappings[s] for s in cited_sources if s in input_mappings},
            'facts': consolidated,
            'consolidated_facts': consolidated,
            'unresolved': unresolved,
            'compressed_at': datetime.now(timezone.utc).isoformat(),
        }
        write_res = backend.write(relay_path, json.dumps(relay_payload, ensure_ascii=False, indent=2))
        if write_res.error:
            raise ProviderFailure(f"Failed to write relay note {relay_path}: {write_res.error}")
        return relay_payload

    async def aggregate_stage_notes(self, parent: dict, force_relay: bool = False) -> dict:
        """汇聚所有 /notes/batch_*.json；超限时触发接力压缩，最终写入 /notes/aggregated.json。"""
        from .agent_notes import (
            load_stage_notes,
            check_notes_exceed_safe_window,
            partition_notes_for_relay,
            consolidate_aggregated_note,
            SAFE_NOTE_WINDOW_BYTES,
            RELAY_CHUNK_MAX_BYTES,
        )
        from .deep_backend import TaskBackend

        notes = load_stage_notes(self.store, parent['id'], parent['version'])
        if not notes:
            return {'total_batches': 0, 'total_facts': 0, 'path': '', 'relay_compressed': False}

        backend = TaskBackend(self, parent['id'], parent['version'])
        exceeds_window, total_bytes = check_notes_exceed_safe_window(notes, safe_window_bytes=SAFE_NOTE_WINDOW_BYTES)

        if exceeds_window or force_relay:
            groups = partition_notes_for_relay(notes, max_chunk_bytes=RELAY_CHUNK_MAX_BYTES)
            relay_notes = []
            for idx, group in enumerate(groups, 1):
                group_id = f"{idx:05d}"
                relay_note = await self.relay_compress_group(parent, group_id, group)
                relay_notes.append(relay_note)
            final_aggregated = consolidate_aggregated_note(relay_notes, is_relay=True)
        else:
            final_aggregated = consolidate_aggregated_note(notes, is_relay=False)

        agg_path = "/notes/aggregated.json"
        write_res = backend.write(agg_path, json.dumps(final_aggregated, ensure_ascii=False, indent=2))
        if write_res.error:
            raise ProviderFailure(f"Failed to write aggregated notes to {agg_path}: {write_res.error}")

        return {
            'path': agg_path,
            'total_batches': final_aggregated['total_batches'],
            'total_facts': final_aggregated['total_facts'],
            'relay_compressed': final_aggregated['relay_compressed'],
        }

    async def synthesize_global_report(self, parent_or_id, version: int = None, plan: dict = None) -> dict:
        """Stage 2 Reduce 2: 全局长报告统稿与日历/引文治理核验。"""
        from .deep_backend import TaskBackend
        from .deep_model import DeepChatModel
        from .agent_notes import (
            load_stage_notes,
            compose_synthesis_context,
            normalize_date_headings,
            answer_year,
            REPORT_SYNTHESIZER_SYSTEM_PROMPT,
        )
        from .deep_validation import calendar_issues
        from .agent_citation_check import check_quoted_sources

        parent = self.guard(parent_or_id) if isinstance(parent_or_id, str) else parent_or_id
        ver = version or parent['version']
        backend = TaskBackend(self, parent['id'], ver)

        agg_file = backend.read('/notes/aggregated.json')
        if not agg_file.error and agg_file.file_data:
            agg_data = json.loads(agg_file.file_data['content'])
            notes = [agg_data]
        else:
            agg_res = await self.aggregate_stage_notes(parent)
            if agg_res.get('path'):
                agg_file = backend.read('/notes/aggregated.json')
                agg_data = json.loads(agg_file.file_data['content'])
                notes = [agg_data]
            else:
                notes = load_stage_notes(self.store, parent['id'], ver)

        if not notes:
            raise ValueError('未找到已提交的批次笔记，无法生成全局长报告')

        ev = parent.get('evidence', {})
        originals = ev.get_many(list(ev)) if hasattr(ev, 'get_many') else (dict(ev) if isinstance(ev, dict) else {})
        ctx = compose_synthesis_context(notes, parent, originals)

        model = DeepChatModel(service=self, run_id=parent['id'], input_version=ver, purpose='report_synthesis')
        messages = [
            SystemMessage(content=REPORT_SYNTHESIZER_SYSTEM_PROMPT),
            HumanMessage(content='以下为全周期汇聚的事实上下文，请严格按照长报告规范输出完整 Markdown 报告：\n\n'
                                 + json.dumps(ctx, ensure_ascii=False, indent=2))
        ]
        response = await model.ainvoke(messages, config={'callbacks': [], 'tags': ['report_synthesis']})
        raw_report = str(response.content).strip()

        default_year = answer_year(parent)
        normalized_report = normalize_date_headings(raw_report, default_year=default_year)

        cal_errs = calendar_issues(normalized_report, parent)
        if cal_errs:
            import logging
            logging.getLogger(__name__).warning('全局长报告包含日历格式疑点：%s', cal_errs)

        check_quoted_sources(normalized_report, originals, parent.get('references', {}))

        report_path = '/notes/final_report.md'
        write_res = backend.write(report_path, normalized_report)
        if write_res.error:
            raise ValueError(f'保存全局长报告失败: {write_res.error}')

        return {
            'report_path': report_path,
            'report_text': normalized_report,
            'calendar_issues': cal_errs,
            'total_batches': ctx['total_batches'],
            'total_messages': ctx['total_messages'],
        }

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
