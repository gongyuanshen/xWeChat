// SSE 与查询快照共享合并规则，重放旧事件不会覆盖较新的步骤状态。
export function mergeReferenceData(current = [], incoming = [], key = 'source') {
  return [...new Map([...current, ...incoming].map(item => [item[key], item])).values()]
}

export function mergeTimeline(current = [], incoming = []) {
  const items = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) {
    if (!items.has(item.id) || (item.revision || 0) > (items.get(item.id).revision || 0)) items.set(item.id, item)
  }
  const ordered = [...items.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0))
  // 压缩分隔及其摘要入口永久保留，普通步骤继续沿用快照上限。
  return ordered.filter((item, index) => index >= ordered.length - 200 || (item.kind === 'notice' && Number.isFinite(item.context_job?.before)))
}

// 运行版本与更新时间同时单调前进；重放的旧预算、覆盖和状态不能覆盖新进度。
export function mergeRunEvent(current, event) {
  if (!current || event?.run_id !== current.id || (event.version ?? current.version ?? 0) < (current.version || 0)) return current
  const newerVersion = (event.version || 0) > (current.version || 0)
  const next = { ...current, version: event.version ?? current.version }
  const acceptsState = newerVersion || !event.updated_at || event.updated_at >= (current.updated_at || 0)
  if (acceptsState) {
    if (event.updated_at) next.updated_at = event.updated_at
    if (event.status) next.status = event.status
    if (event.patch && typeof event.patch === 'object' && !Array.isArray(event.patch)) Object.assign(next, event.patch)
    const belongs = value => value && (!value.run_id || value.run_id === current.id) && (value.version == null || value.version === next.version)
    if (belongs(event.context_budget)) next.context_budget = event.context_budget
    if (!event.patch?.analysis && belongs(event.coverage)) next.analysis = { ...next.analysis, known: true, complete: event.coverage.complete, coverage: event.coverage.conversations }
  }
  if (event.timeline_item) {
    next.timeline = mergeTimeline(current.timeline, [event.timeline_item])
    const accepted = next.timeline.find(item => item.id === event.timeline_item.id)
    if (accepted === event.timeline_item) {
      next.citations = mergeReferenceData(current.citations, event.citations)
      next.references = mergeReferenceData(current.references, event.references, 'id')
    }
    if (accepted?.kind === 'answer' && accepted.status !== 'superseded') next.answer = accepted.text
  } else if (acceptsState) {
    next.citations = mergeReferenceData(current.citations, event.citations)
    next.references = mergeReferenceData(current.references, event.references, 'id')
  }
  return next
}

// 只合并相邻、同工具同范围的调用；旁白与补充要求仍保留原来的时间顺序。
export function groupTimelineTools(records = []) {
  const groups = []
  for (const item of records) {
    const previous = groups.at(-1)
    const same = item.kind === 'tool' && item.action && previous?.kind === 'tool' &&
      ['action', 'username', 'query', 'start', 'end', 'input_version'].every(key => previous[key] === item[key])
    if (same) previous.calls.push(item)
    else groups.push(item.kind === 'tool' ? { ...item, calls: [item] } : item)
  }
  return groups
}
