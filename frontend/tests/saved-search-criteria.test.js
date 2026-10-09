import { describe, expect, it } from 'vitest'
import { buildLibraryMessageSource, canSaveLibraryMessage, snapshotSearchCriteria } from '../composables/chat/savedSearchCriteria'
describe('library search and message sources', () => {
  it('preserves attachment type and an explicitly rolling date range', () => {
    const state = {scope:'global',query:'',retrieval_mode:'keyword',render_types:'file',sender:'alice',session_type:'group',range:'30'}
    expect(snapshotSearchCriteria({...state, relative:true}, 3000000)).toMatchObject({query:'',render_types:'file',relative_days:30,start_time:null,end_time:null})
    expect(snapshotSearchCriteria(state, 3000000)).toMatchObject({render_types:'file',start_time:408000,end_time:3000000})
  })
  it('snapshots complete filters and excludes cursors', () => {
    expect(snapshotSearchCriteria({scope:'global',query:'项目',retrieval_mode:'hybrid',sender:'alice',session_type:'group',range:'7',offset:50,ticket:'old'}, 1000000)).toEqual({scope:'global',username:'',query:'项目',retrieval_mode:'hybrid',render_types:'text',sender:'alice',session_type:'group',start_time:395200,end_time:1000000})
  })
  it('preserves source identity', () => {
    expect(buildLibraryMessageSource('room', {id:'message_0:Msg_room:1',content:'证据',senderUsername:'alice',createTime:42,renderType:'text'})).toEqual({username:'room',anchor:'message_0:Msg_room:1'})
  })
  it('saves canonical attachment identity without display or transcript fields', () => {
    const attachment={id:'message_0:Msg_room:2',renderType:'voice',content:'[语音]',voiceTranscript:'转写文字'}
    expect(buildLibraryMessageSource('room',attachment)).toEqual({username:'room',anchor:'message_0:Msg_room:2'})
    expect(canSaveLibraryMessage(attachment)).toBe(true)
    expect(canSaveLibraryMessage({id:'chat-floating-1'})).toBe(false)
    expect(canSaveLibraryMessage({id:'0'})).toBe(false)
  })
})
