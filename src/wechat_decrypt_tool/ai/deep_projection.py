"""历史数据兼容投影及微信读取复用；不含旧模型调度或主循环。"""
import json
import hashlib
import time
from .diagnostics import observed
from .providers import ProviderFailure
from .agent_budget import input_limit, model_output_limit, active_budget
from .context_meter import ContextMeter

class DeepProjection:
    def budget(self, run):
        if run.get('engine_version') == 3:
            return input_limit(self.profile(run))
        token=active_budget.set(run.get('input_budget') or input_limit(self.profile(run)))
        try:return input_limit(self.profile(run))
        finally:active_budget.reset(token)

    def authorize_material(self,id,account,version=None):
        run=self.run(id,account)
        self.thread(run['thread_id'],account)
        if run.get('parent_run_id'):
            parent = self.run(run['parent_run_id'], account)
            if parent['version'] != run.get('parent_version'):
                raise ValueError('子任务所属范围已更新，请从主任务查看最新结果。')
        if version is not None and version!=run['version']:raise ValueError('任务条件已经更新，请刷新结果。')
        # 查询筛选不撤销同账号已保存的历史资料；读取接口不能顺便裁剪派生原文。
        return run

    @observed('agent.context.material_page', id_field='run_id')
    def material_page(self,id,account,kind='sources',offset=0,limit=20,query='',version=None):
        run=self.authorize_material(id,account,version)
        if kind=='statistics':return self.workspace.statistics(id,offset,limit)
        if kind=='sources':
            rows=list(run['evidence'].rows(offset=offset,limit=limit+1,query=query))
            return {'items':[self.public_source(x, account) for x in rows[:limit]],'total':len(run['evidence']) if not query else None,
                'has_more':len(rows)>limit,'offset':offset}
        result=self.workspace.page(id,run['version'],'finding',offset,limit,query)
        from .agent_references import cited_references
        for item in result['items']:
            item['citations']=[self.public_source(run['evidence'][s], account) for s in item.get('sources',[]) if s in run['evidence']]
            item['references'] = cited_references(item.get('text', ''), run.get('references', {}))
        return result

    def public_analysis(self,run):
        state=run.get('analysis',{})
        segments=state.get('segments',0)
        if run.get('engine_version') == 2 and run.get('intent',{}).get('mode') != 'statistics':
            segments=self.workspace.page(run['id'],run['version'],'stage_note',limit=0)['total']
        return {'coverage':state.get('coverage',[]),'segments':segments, 'tracked': state.get('tracked', True),
            'complete':state.get('complete',False),'known':bool(state),'mode':run.get('intent',{}).get('mode','search'),
            'findings':self.workspace.page(run['id'],run['version'],'finding',limit=0)['total'],
            'analyzed':sum(x.get('analyzed',0) for x in state.get('coverage',[]))}

    @staticmethod
    def public_source(value, account=''):
        from .agent_references import source_display
        return source_display(value, account)

    def context_meter(self, run):
        """校准数据只含哈希与计数，随所属对话保存、恢复和删除。"""
        meters = self.__dict__.setdefault('_context_meters', {})
        key = (run['account'], run['thread_id'])
        if key not in meters:
            thread = self.thread(run['thread_id'], run['account'])
            def save(samples):
                with self.store.connection() as db:
                    row = db.execute("SELECT body FROM records WHERE kind='agent_thread' AND id=? AND account=?", key[::-1]).fetchone()
                    if row is None:
                        return
                    current = json.loads(row[0])
                    current['context_meter_samples'] = samples
                    db.execute("UPDATE records SET body=? WHERE kind='agent_thread' AND id=? AND account=?",
                               (json.dumps(current, ensure_ascii=False), run['thread_id'], run['account']))
            meters[key] = ContextMeter(thread.get('context_meter_samples'), save)
        return meters[key]

    def publish_context(self, id, used):
        run = self.guard(id)
        profile = self.profile(run)
        window = profile.get('context_window')
        available = self.budget(run)
        snapshot = {'run_id': id, 'version': run['version'], 'used': used, 'input_capacity': available,
                    'model_window': window, 'output_reserve': model_output_limit(profile), 'safety_reserve': 512,
                    'percent': round(100 * used / available, 1) if window else None,
                    'measurement': 'conservative_estimate', 'unit': 'budget_units',
                    'description': '文本按 UTF-8 字节作保守上界估算，包含工具与请求封装；不是实测 Token。',
                    'model_id': profile.get('model'), 'profile_id': profile.get('id'),
                    'reasoning_effort': profile.get('reasoning_effort'), 'updated_at': time.time()}
        if run.get('engine_version') == 3:
            from .compaction_policy import policy_for
            policy = policy_for(profile)
            snapshot.update(context_revision=(run.get('context_compaction') or {}).get('id'),
                compaction=run.get('context_compaction'),
                window_percent=round(100 * used / window, 1) if window else None,
                trigger_capacity=min(available, int((window or available) * policy.pressure_ratio)),
                retain_capacity=int((window or available) * policy.recent_ratio))
        if run.get('engine_version') in (2, 3):
            measurement = self.context_meter(run).last
            if measurement.get('used') == used:
                snapshot.update(measurement)
                if measurement.get('measurement') == 'usage_anchored_estimate':
                    snapshot['description'] = '相同模型请求的实测输入用量加新增内容保守估算；含安全余量，不是本次实测 Token。'
        self.update(id, context_budget=snapshot)

    async def read_time(self, id, username, start, end, capacity, cursor='', *, probe_budget=None):
        run = self.guard(id)
        state = None
        if cursor:
            saved = self.workspace.get(id, run['version'], 'cursor:' + cursor)
            if not saved or saved['username'] != username:
                raise ProviderFailure('续读位置不属于当前任务、版本或会话，请重新请求读取。')
            start, end, state = saved['start'], saved['end'], saved['state']
            if state.get('partial_source'):
                original = run['evidence'].get(state['partial_source'])
                if not original:
                    raise ProviderFailure('续读原文缺失，已保留任务进度。')
                state = {**state, 'pending_message': original}
        options = {'session': f'{id}:{run["version"]}'} if getattr(self.tools, 'supports_time_prefetch', False) else {}
        if probe_budget is not None and getattr(self.tools, 'supports_time_prefetch', False):
            options['probe_budget'] = probe_budget
        result = await self.tools.time_window(run['account'], username, start, end, capacity, state,
                                              checkpoint=lambda: self.guard(id), **options)
        self.guard(id)
        if self.run(id)['version'] != run['version']:
            from .agent_service import Revised
            raise Revised()
        next_state = result.pop('next_state')
        if next_state:
            saved = {'username': username, 'start': start, 'end': end, 'state': next_state}
            token = hashlib.sha256(json.dumps(saved, sort_keys=True).encode()).hexdigest()[:32]
            self.workspace.put(id, run['version'], 'cursor:' + token, 'read_cursor', saved)
            result['next_cursor'] = token
        else:
            result['next_cursor'] = None
        return result
