import { dateToUnixSeconds } from '~/lib/chat/formatters'
export const snapshotSearchCriteria = (state, now = Math.floor(Date.now() / 1000)) => {
  let start = null, end = null
  const relativeDays = state.relative && Number(state.range) > 0 ? Number(state.range) : null
  if (state.fixedBounds && relativeDays === null) ({start_time: start, end_time: end} = state.fixedBounds)
  else if (state.range === 'custom') {
    start = dateToUnixSeconds(state.startDate, false)
    end = dateToUnixSeconds(state.endDate, true)
  } else if (Number(state.range) > 0 && relativeDays === null) {
    end = now
    start = Math.max(0, now - Number(state.range) * 86400)
  }
  if (start !== null && end !== null && start > end) throw new Error('开始日期不能晚于结束日期')
  return {scope:state.scope, username:state.scope === 'conversation' ? state.username : '', query:state.query.trim(), retrieval_mode:state.retrieval_mode,render_types:state.render_types ?? 'text',sender:state.sender,session_type:state.scope === 'global' ? state.session_type : '',start_time:start,end_time:end,...(relativeDays !== null ? {relative_days:relativeDays} : {})}
}
export const canSaveLibraryMessage = message => typeof message?.id === 'string' && /^[^:]+:[^:]+:[1-9][0-9]*$/.test(message.id)
export const buildLibraryMessageSource = (username, message) => ({username,anchor:message.id})
export const searchBoundDate = timestamp => {
  if (timestamp === null) return ''
  const date = new Date(timestamp * 1000)
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
