"""账号级助手的查询条件；与历史对话归属、账号读取权限分开管理。"""
import json
import hashlib
import unicodedata

from .agent_schemas import AgentControl
from .providers import ProviderFailure


def comparable_name(value):
    """只忽略名称的装饰符号；不做模糊纠错，重名仍须用户澄清。"""
    return ''.join(char for char in unicodedata.normalize('NFKC', value)
                   if unicodedata.category(char)[0] in ('L', 'N', 'M')
                   and char not in ('\ufe0e', '\ufe0f'))


def resolve_directory_name(contacts, value):
    exact = [c for c in contacts if c['username'] == value]
    if not exact:
        exact = [c for c in contacts if c['name'] == value]
    if exact:
        return exact
    name = comparable_name(value)
    return [c for c in contacts if name and comparable_name(c['name']) == name]


class GlobalQueries:
    async def expand_query_scope(self, id, action):
        run = self.guard(id)
        request = {'username': action.username, 'reason': action.query}
        if run.get('parent_run_id'):
            self.update(id, scope_requests=[*run.get('scope_requests', []), request][-4:],
                        subtask_verified=True, pending_actions=[{'action': 'answer'}])
            return
        if run.get('intent', {}).get('scope_locked'):
            self.update(id, pending_actions=[], observations=(run['observations'] +
                        [{'warning':'用户明确限定了读取范围，本次没有扩展。'}])[-40:])
            return
        available = {c['username']: c for c in await self.tools.conversations(run['account'])}
        self.context_guard(run)
        targets = [action.username] if action.username else list(available)
        if any(target not in available for target in targets):
            raise ProviderFailure('扩展目标不存在，请先查找准确的会话。')
        excluded = set(run.get('excluded_conversations', []))
        scope = sorted((set(self.scope_for(run)) | set(targets)) - excluded)
        filters = {**run['query_filters'], 'conversations': scope}
        self.update(id, query_scope=scope, query_filters=filters,
                    query_all_conversations=not action.username, pending_actions=[],
                    observations=(run['observations'] + [{'expanded_scope': True, 'reason': action.query,
                                                         'conversation_count':len(scope)}])[-40:])
        thread = self.thread(run['thread_id'], run['account'])
        thread['task_context'] = {**thread.get('task_context', {}), 'query_scope':scope,
                                 'query_filters':filters, 'query_all_conversations':not action.username}
        self.store.put('agent_thread',thread)
        self.timeline_item(id,'progress','已按问题扩展读取范围：'+(available[action.username]['name'] if action.username else '当前账号全部聊天')+'。'+action.query)

    def inherited_coverage(self, prior_run, filters):
        """兼容旧追问的笔记来源链，只返回当前筛选允许的旧读取覆盖。"""
        account, thread_id, visited = prior_run['account'], prior_run['thread_id'], set()
        while prior_run and prior_run['id'] not in visited:
            visited.add(prior_run['id'])
            if prior_run.get('account') != account or prior_run.get('thread_id') != thread_id:
                return {}
            coverage = prior_run.get('analysis', {}).get('coverage', [])
            reading = {'run_id': prior_run['id'], 'query_filters': prior_run.get('query_filters', {}),
                       'coverage': [{k: row[k] for k in ('username', 'read', 'read_complete', 'warning') if k in row}
                                    for row in coverage]} if coverage else prior_run.get('inherited_reading', {})
            if reading:
                old = reading.get('query_filters', {})
                old_time, new_time = old.get('time_range', {}), filters['time_range']
                if (not old or not set(old.get('conversations', [])) <= set(filters['conversations'])
                        or new_time['start'] > old_time.get('start', 0) or new_time['end'] < old_time.get('end', 0)
                        or (filters.get('sender') and filters['sender'] != old.get('sender'))):
                    return {}
                return reading
            note = self.workspace.get(prior_run['id'], prior_run.get('applied_version') or prior_run['version'],
                                      prior_run.get('note_key', '')) or {}
            origin = note.get('inherited_from', {}).get('run_id')
            prior_run = self.store.get('agent_run', origin) if origin else None
        return {}

    async def read_time(self, id, username, start, end, capacity, cursor=''):
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

    async def apply_global_input(self, id, run, thread, contacts, texts, version):
        self.activity(id, '理解问题与查询条件')
        intent, interval = await self.parse_context(id, texts)
        current = self.guard(id)
        if current['version'] != version:
            from .agent_service import Revised
            raise Revised()
        available = {c['username']: c for c in contacts}
        self.reference_contacts[run['account']] = await self.tools.people(run['account']) if hasattr(self.tools, 'people') else contacts
        previous = thread.get('task_context', {})
        requested = intent.get('conversations')
        keep_scope = intent.get('followup') and not intent.get('reset_conversations')
        # 全账号是动态条件，不应把上轮目录快照误当成用户指定的会话白名单。
        owner = thread.get('username')
        mode = intent.get('scope_mode', 'auto')
        locked = intent.get('scope_locked', False) or (keep_scope and previous.get('scope_locked', False))
        if keep_scope and previous.get('scope_locked') and not intent.get('reset_conversations'):
            requested = previous.get('query_scope')
        all_conversations = (not requested and mode == 'all' and not locked) or (not requested and not owner)
        if keep_scope and mode == 'auto' and previous.get('query_all_conversations') and not locked:
            all_conversations = True
        scope = list(available) if all_conversations else ([owner] if owner in available else [])
        if mode == 'current' and owner:
            requested = [owner]
        if requested:
            scope = []
            for value in requested:
                matches = resolve_directory_name(contacts, value)
                if len(matches) != 1:
                    self.update(id, answer=f'无法唯一确定会话“{value}”，请补充完整名称或选择会话。', choices=matches)
                    self.finish(id, 'needs_input')
                    return
                scope.append(matches[0]['username'])
            scope = list(dict.fromkeys(scope))
        elif keep_scope and previous.get('query_scope') and not all_conversations:
            scope = [u for u in previous['query_scope'] if u in available]
        if not scope:
            raise ProviderFailure('当前账号没有符合条件且可读取的聊天。')
        excluded = set(previous.get('excluded_conversations', [])) if keep_scope and not requested else set()
        for value in intent.get('exclude_conversations', []):
            matches = resolve_directory_name(contacts, value)
            if len(matches) != 1:
                self.update(id, answer=f'无法唯一确定要排除的会话“{value}”，请补充完整名称。', choices=matches)
                self.finish(id, 'needs_input')
                return
            excluded.add(matches[0]['username'])
        scope = [u for u in scope if u not in excluded]
        if not scope:
            raise ProviderFailure('排除条件下没有可读取的聊天。')
        sender = intent.get('sender')
        if not sender and intent.get('followup') and not intent.get('reset_sender'):
            sender = (previous.get('query_filters') or {}).get('sender')
            intent['sender'] = sender
        if sender:
            people = self.reference_contacts[run['account']]
            group_people = await self.tools.group_people(run['account'], scope, people) if hasattr(self.tools, 'group_people') else []
            # 同一人在联系人目录与多个群里只算一个候选，不同 ID 的同名仍需澄清。
            matches = [c for c in people if c['username'] == sender]
            matches = matches or list({c['username']: c for c in [*people, *group_people]
                            if c['username'] == sender or sender in [c['name'], *c.get('aliases', [])]}.values())
            if len(matches) != 1:
                self.update(id, answer=f'无法唯一确定发言人“{sender}”，请补充可辨认的身份。')
                self.finish(id, 'needs_input')
                return
            intent['sender'] = matches[0]['username']
        # 笔记由查询条件隔离，不能把已排除会话的旧摘要送入新问题。
        filters = {'conversations': sorted(scope), 'time_range': interval, 'sender': intent.get('sender')}
        intent['scope_locked'] = bool(locked)
        self.workspace.restrict(id, scope, interval, exclusive=True, sender=intent.get('sender'))
        note_key = ''
        inherited_reading = {}
        previous_filters = previous.get('query_filters') or {}
        previous_range = previous_filters.get('time_range') or {}
        compatible = (intent.get('followup') and not intent.get('message_count') and set(previous_filters.get('conversations', [])) <= set(scope)
                      and interval.get('start', 0) <= previous_range.get('start', 0)
                      and interval.get('end', 0) >= previous_range.get('end', 0)
                      and (not filters['sender'] or filters['sender'] == previous_filters.get('sender')))
        same_query = (run.get('applied_version') and run.get('query_filters') == filters
                      and run.get('intent', {}).get('mode') == intent.get('mode')
                      and run.get('intent', {}).get('message_count') == intent.get('message_count'))
        if same_query and version != run['applied_version']:
            # 同一范围的补充沿用已提交断点，游标仍由新版本校验，原版本资料保留。
            with self.store.connection() as db:
                db.execute('INSERT OR IGNORE INTO agent_piece SELECT run_id,?,id,kind,body FROM agent_piece WHERE run_id=? AND version=?',
                           (version, id, run['applied_version']))
            note_key = run.get('note_key', '')
            inherited_reading = run.get('inherited_reading', {})
        if compatible:
            prior_id = previous.get('run_id')
            prior_run = self.store.get('agent_run', prior_id) if prior_id else None
            if (prior_run and prior_run.get('note_key') and prior_run.get('account') == run['account']
                    and prior_run.get('thread_id') == run['thread_id']):
                prior_version = prior_run.get('applied_version') or prior_run['version']
                note = self.workspace.get(prior_id, prior_version, prior_run['note_key'])
                if note:
                    if prior_run.get('note_strategy') == 'incremental':
                        from .agent_notes import saved_notes
                        note = {**note, 'notes': saved_notes(self.workspace, {**prior_run, 'version': prior_version}),
                                'note_strategy': 'cumulative', 'parent': None}
                    note_key = 'inherited:' + prior_id
                    self.workspace.put(id, version, note_key, 'stage_note', {
                        **note, 'inherited_from': {'run_id': prior_id, 'version': prior_run['version'], 'key': prior_run['note_key']}})
                    # 旧任务读完的范围供追问定位原文，不等于新问题已经分析完成。
                    inherited_reading = self.inherited_coverage(prior_run, filters)
        self.update(id, intent=intent, query_scope=scope, query_filters=filters, applied_version=version,
                    delegation_complete=False, delegation_verified=False,
                    query_all_conversations=all_conversations, excluded_conversations=sorted(excluded),
                    scope_input_index=len(texts), time_range=interval, answer='', answer_context=None,
                    pending_actions=[], scope_revision=thread['scope_revision'],
                    observations=run['observations'] if version == 1 else [],
                    note_key=note_key, inherited_reading=inherited_reading,
                    history_note=run.get('history_note', {}) if same_query else {},
                    analysis=run.get('analysis', {}) if same_query else {},
                    pending_material=run.get('pending_material', []) if same_query else [],
                    active_material=run.get('active_material', []) if same_query else [])
        if intent.get('scope_reason') and (len(scope) > 1 or (owner and scope != [owner])):
            self.timeline_item(id, 'progress', '本次需要跨聊天查证：'+intent['scope_reason'])
        thread = self.thread(run['thread_id'], run['account'])
        thread['task_context'] = {'objective': intent['objective'], 'time_range': interval, 'mode': intent['mode'],
                                  'scope_locked': bool(locked),
                                  'scope_revision': thread['scope_revision'], 'query_scope': scope,
                                  'query_all_conversations': all_conversations, 'excluded_conversations': sorted(excluded),
                                  'query_filters': filters, 'run_id': id}
        thread['task_context']['message_count'] = intent.get('message_count')
        self.store.put('agent_thread', thread)
        for item in self.run(id).get('timeline', []):
            if item['kind'] == 'supplement' and item['status'] == 'received':
                self.timeline_item(id, 'supplement', item['text'], item_id=item['id'], status='applied')
            elif item.get('input_version', version) < version and item['kind'] in ('answer', 'progress'):
                self.timeline_item(id, item['kind'], item['text'], item_id=item['id'], status='superseded')

    async def intent_directory(self, account, text):
        """仅提供原话提及的目录项，避免把数千联系人填满初始上下文。"""
        contacts = await self.tools.conversations(account)
        plain_text = comparable_name(text)
        matches = [c for c in contacts if c['username'] in text or
                   (len(comparable_name(c['name'])) > 1 and comparable_name(c['name']) in plain_text)]
        people = await self.tools.people(account) if hasattr(self.tools, 'people') else contacts
        groups = [c['username'] for c in matches if c['username'].endswith('@chatroom')]
        scoped = await self.tools.group_people(account, groups, people) if groups and hasattr(self.tools, 'group_people') else []
        mentioned = [p for p in [*people, *scoped] if p['username'] in text or
                     any(len(name) > 1 and name in text for name in [p['name'], *p.get('aliases', [])])]
        return json.dumps({'conversations': matches, 'people': mentioned}, ensure_ascii=False)

    def reference_people(self, run, messages):
        """已读取群的名片目录随任务保存，恢复时仍按原群解释人物引用。"""
        people = self.reference_contacts.get(run['account'], [])
        if not people and hasattr(self.tools, 'people_directory'):
            people = self.tools.people_directory(run['account'])
            self.reference_contacts[run['account']] = people
        if not hasattr(self.tools, 'group_people'):
            return people
        from .agent_tools import group_people_directory
        scoped = []
        for group in sorted({m['username'] for m in messages if m['username'].endswith('@chatroom')}):
            key = 'people-group:' + group
            directory = self.workspace.get(run['id'], run['version'], key)
            if directory is None:
                directory = group_people_directory(run['account'], [group], people)
                self.workspace.put(run['id'], run['version'], key, 'person_directory', directory)
            scoped.extend(directory)
        return [*people, *scoped]
