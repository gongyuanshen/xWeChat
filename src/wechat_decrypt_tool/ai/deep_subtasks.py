"""子任务的历史与界面投影；执行完全由官方 DeepAgents task 工具负责。"""
import json

class DeepSubtasks:
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

    def summary(self, parent):
        with self.store.connection() as db:
            rows = db.execute('SELECT status,count(*) FROM agent_subtask WHERE parent_id=? AND version=? GROUP BY status',
                              (parent['id'], parent['version'])).fetchall()
            plans = [json.loads(r[0]) for r in db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='analysis_plan'",
                (parent['id'], parent['version']))]
            focus = [r[0] for r in db.execute("SELECT json_extract(body,'$.role') FROM agent_subtask WHERE parent_id=? AND version=? "
                "AND status IN ('running','queued') AND json_extract(body,'$.role') IN ('fact-checker','retrieval-analyst')",
                (parent['id'], parent['version']))]
        counts = dict(rows)
        result = {'total': sum(v for k, v in counts.items() if k != 'superseded'), 'completed': counts.get('completed', 0),
                'running': counts.get('running', 0), 'queued': counts.get('queued', 0),
                'failed': counts.get('failed', 0), 'interrupted': counts.get('interrupted', 0) + counts.get('cancelled', 0)}
        if parent.get('subtask_plan_version') == 2:
            with self.store.connection() as db:
                work = [json.loads(r[0]) for r in db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='work_plan' ORDER BY id", (parent['id'], parent['version']))]
            plan = max(work, key=lambda p: p['created']) if work else None
            paused = parent.get('status') in ('cancelled', 'interrupted', 'failed')
            result.update(plan_version=2, total_known=True, scanning=False, concurrency_limit=3,
                phase='interrupted' if paused else 'completed' if plan and plan.get('closed') else 'analyzing' if plan else 'planning',
                main_work=(plan['main']['description'] if plan else parent.get('stage', '主模型分析资料')),
                main_completed=bool(plan and plan.get('main_result')), planned=len(plan['branches']) if plan else 0,
                parallel_reason=plan['parallel_reason'] if plan else '')
            if paused:
                result.update(running=0, queued=0)
            return result
        active = [p for p in plans if p['mode'] == 'parallel']
        if active:
            phases = {p['phase'] for p in active}
            paused = parent.get('status') in ('cancelled', 'interrupted', 'failed') and phases != {'completed'}
            result.update(plan_version=1, scanning=not paused and any(not p['scan_complete'] for p in active),
                total_known=all(p['scan_complete'] for p in active),
                phase='interrupted' if paused else next((phase for phase in ('partitioning', 'analyzing', 'reducing', 'interrupted') if phase in phases), 'completed'),
                reused=sum(p.get('reused', 0) for p in active), concurrency_limit=4)
        if focus and not result.get('scanning') and result.get('phase') not in ('analyzing', 'reducing'):
            result.update(plan_version=1, phase='checking' if 'fact-checker' in focus else 'retrieving',
                total_known=True, scanning=False)
        return result

    def page(self, id, account, offset=0, limit=20, version=None):
        parent = self.service.authorize_material(id, account, version)
        with self.store.connection() as db:
            total = db.execute('SELECT count(*) FROM agent_subtask WHERE parent_id=? AND version=?', (id, parent['version'])).fetchone()[0]
            rows = db.execute('SELECT body FROM agent_subtask WHERE parent_id=? AND version=? ORDER BY ordinal LIMIT ? OFFSET ?',
                              (id, parent['version'], limit, offset)).fetchall()
            items = []
            for row in rows:
                body = json.loads(row[0])
                # 作业表记录分派生命周期，进行中的实际进度读取子任务记录。
                child_row = db.execute("SELECT body FROM records WHERE kind='agent_run' AND id=? AND account=?",
                    (body.get('child_run_id', ''), account)).fetchone()
                if child_row:
                    child = json.loads(child_row[0])
                    if child.get('parent_run_id') == id and child.get('parent_version') == parent['version']:
                        analysis = child.get('analysis', {})
                        # 只投影公开阶段回复及工具动作，不返回模型内部推理或工具原始资料。
                        activity = [{k: item[k] for k in ('id', 'kind', 'text', 'status', 'started_at', 'finished_at') if k in item}
                            for item in child.get('timeline', []) if item.get('kind') in ('progress', 'tool', 'notice')
                            and item.get('input_version', child['version']) == child['version']]
                        progress = [item for item in activity if item['kind'] == 'progress' and item.get('text', '').strip()]
                        body.update(activity=activity[-8:], latest_progress=progress[-1] if progress else None,
                            objective=body.get('objective') or child.get('input_digest', '')[:1000],
                            last_activity_at=max((item.get('finished_at') or item.get('started_at') or 0 for item in activity), default=child.get('started_at', 0)),
                            action_started_at=child.get('stage_started_at'), current_action=child.get('stage', ''),
                            model_running=False)
                        lifecycle = {k: body.get(k) for k in ('status', 'stage', 'error', 'finished_at')}
                        model_row = db.execute("SELECT body FROM records WHERE kind='usage' AND account=? "
                            "AND json_extract(body,'$.subtask_id')=? ORDER BY updated DESC LIMIT 1",
                            (account, body['child_run_id'])).fetchone()
                        model = json.loads(model_row[0]) if model_row else {}
                        if child['status'] == 'running' and model.get('status') == 'running':
                            body.update(model_running=True, action_started_at=model.get('started_at'),
                                current_action='正在分析已读取的消息' if not analysis.get('complete') else '正在整理子任务结果')
                        body.update(status=child['status'], stage=child.get('stage', ''), error=child.get('error', ''),
                            finished_at=child.get('finished_at'),
                            coverage={'read': child.get('read_count', 0),
                                'analyzed': sum(c.get('analyzed', 0) for c in analysis.get('coverage', [])),
                                'complete': analysis.get('complete', False)})
                        if body.get('plan_version') in (1, 2) and lifecycle['status'] != 'running':
                            # 替换、恢复排队和完成后的作业状态优先于旧子进程的停止状态。
                            body.update(lifecycle, current_action=lifecycle['stage'] or '', model_running=False)
                        if body.get('manifest_id'):
                            manifest = self.service.workspace.get(id, parent['version'], body['manifest_id'])
                            if manifest:
                                core_sources = {r['source'] for r in manifest['core']}
                                notes = [json.loads(r[0]) for r in db.execute("SELECT body FROM agent_piece WHERE run_id=? AND version=? AND kind='stage_note'",
                                    (child['id'], child['version']))]
                                spans = {}
                                for note in notes:
                                    for ref in note.get('covered', []):
                                        spans.setdefault(ref['source'], []).append((ref['start'], ref['end']))
                                from .deep_partition import uncommitted
                                pending = [part for ref in manifest['core'] for part in uncommitted(ref, spans)]
                                body['coverage']['read'] = len(core_sources)
                                body['coverage']['analyzed'] = len(core_sources - {r['source'] for r in pending})
                                body['coverage']['body_characters'] = sum(r['end'] - r['start'] for r in manifest['core'])
                                body['coverage']['analyzed_characters'] = body['coverage']['body_characters'] - sum(r['end'] - r['start'] for r in pending)
                                body['coverage']['complete'] = body['status'] == 'completed' and not pending
                usage = db.execute("SELECT count(*),coalesce(sum(json_extract(body,'$.usage.input_tokens')),0),"
                                   "coalesce(sum(json_extract(body,'$.usage.output_tokens')),0),"
                                   "coalesce(sum(CASE WHEN json_extract(body,'$.usage_known')=1 THEN 0 ELSE 1 END),0) "
                                   "FROM records WHERE kind='usage' AND account=? AND json_extract(body,'$.subtask_id')=?",
                                   (account, body.get('child_run_id') if body.get('child_run_id', '').startswith('deep-child:') else body['id'])).fetchone()
                items.append({k: v for k, v in body.items() if k not in ('goal', 'account', 'child_run_id')} |
                             {'usage': dict(zip(('calls', 'input_tokens', 'output_tokens', 'unknown'), usage))})
        return {'items': items, 'total': total, 'offset': offset, 'has_more': offset + len(items) < total,
                'version': parent['version'], 'summary': self.summary(parent)}
