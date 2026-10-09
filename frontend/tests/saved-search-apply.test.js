import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useChatSearch } from '../composables/chat/useChatSearch'
vi.mock('~/composables/useAiApi',()=>({useAiApi:()=>({request:vi.fn()})}))
let wrapper
const open = (selectContact = vi.fn()) => {
  vi.stubGlobal('useSettingsDialog',()=>({openDialog:vi.fn()}))
  vi.spyOn(console,'info').mockImplementation(()=>{})
  let state
  const senders=vi.fn().mockResolvedValue({status:'success',senders:[]})
  const account=ref('a'), search=vi.fn().mockResolvedValue({status:'success',messages:[],total:0})
  wrapper=mount(defineComponent({setup(){state=useChatSearch({api:{searchChatMessages:search,listChatSearchSenders:senders},selectedAccount:account,selectedContact:ref({username:'room'}),contacts:ref([{username:'room'}]),searchContext:ref({active:false}),highlightMessageId:ref(''),messagesMeta:ref({}),allMessages:ref({}),selectContact});return ()=>null}}))
  return {state,account,search,senders}
}
afterEach(()=>{wrapper?.unmount();vi.unstubAllGlobals();vi.restoreAllMocks()})
it('applies a type-only rolling search and recalculates its date on a new first page',async()=>{
  const {state,search}=open()
  const clock=vi.spyOn(Date,'now').mockReturnValue(3000000000)
  await state.applySavedSearch({scope:'global',username:'',query:'',retrieval_mode:'keyword',render_types:'file',sender:'alice',session_type:'group',relative_days:30,start_time:null,end_time:null})
  expect(search).toHaveBeenCalledTimes(1)
  expect(search.mock.calls[0][0]).toMatchObject({q:'',render_types:'file',start_time:408000,end_time:3000000,offset:0})
  expect(state.getSavedSearchCriteria({relative:true})).toMatchObject({relative_days:30,start_time:null,end_time:null})
  clock.mockReturnValue(3086400000)
  await state.runMessageSearch({reset:false})
  expect(search.mock.calls[1][0].end_time).toBe(3000000)
  await state.runMessageSearch({reset:true})
  expect(search.mock.calls[2][0].end_time).toBe(3086400)
})
it('rejects a type-only smart search without invoking retrieval',async()=>{
  const {state,search}=open()
  await state.applySavedSearch({scope:'global',username:'',query:'',retrieval_mode:'hybrid',render_types:'file',sender:'',session_type:'',start_time:null,end_time:null})
  expect(search).not.toHaveBeenCalled()
  expect(state.messageSearchError.value).toContain('智能搜索需要关键词')
})
it('does not show an old type result after switching type while its request is pending',async()=>{
  const {state,search}=open();let finish
  state.messageSearchRenderType.value='file'
  search.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  const pending=state.runMessageSearch({reset:true})
  state.messageSearchRenderType.value='image'
  finish({status:'success',hits:[{id:'old-file'}],total:1})
  await pending
  expect(state.messageSearchResults.value).toEqual([])
})
it('restores all criteria and reruns once with fresh first-page identity',async()=>{
  const {state,search}=open()
  state.messageSearchOffset.value=150
  await state.applySavedSearch({scope:'global',username:'',query:'项目',retrieval_mode:'hybrid',render_types:'text',sender:'alice',session_type:'group',start_time:123,end_time:456})
  expect(search).toHaveBeenCalledTimes(1)
  expect(search.mock.calls[0][0]).toMatchObject({account:'a',q:'项目',retrieval_mode:'hybrid',sender:'alice',session_type:'group',start_time:123,end_time:456,offset:0})
  expect(search.mock.calls[0][0]).not.toHaveProperty('search_ticket')
  expect(state.getSavedSearchCriteria()).toMatchObject({start_time:123,end_time:456,sender:'alice'})
})
it('discards an in-flight search when account changes',async()=>{
  const {state,account,search}=open();let finish
  search.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  state.messageSearchQuery.value='甲'
  const pending=state.runMessageSearch({reset:true})
  account.value='b'
  finish({status:'success',messages:[],total:99,searchTicket:'account-a'})
  await pending
  expect(state.messageSearchTotal.value).toBe(0)
  expect(state.messageSearchLoading.value).toBe(false)
})

it('old sender facet response cannot clear saved sender or issue another search',async()=>{
  const {state,search,senders}=open();let finish
  state.messageSearchOpen.value=true
  state.messageSearchQuery.value='旧条件'
  await flushPromises()
  senders.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
  state.messageSearchScope.value='conversation'
  await flushPromises()
  expect(senders).toHaveBeenCalledOnce()
  await state.applySavedSearch({scope:'global',username:'',query:'项目',retrieval_mode:'keyword',render_types:'text',sender:'alice',session_type:'group',start_time:null,end_time:null})
  const count=search.mock.calls.length
  finish({status:'success',senders:[{username:'bob'}]})
  await flushPromises()
  expect(state.messageSearchSender.value).toBe('alice')
  expect(state.messageSearchSenderOptions.value).toEqual([])
  expect(search).toHaveBeenCalledTimes(count)
})
it('account A to B to A cannot revive a saved-search application awaiting contact selection',async()=>{
  let finish
  const {state,account,search}=open(()=>new Promise(resolve=>{finish=resolve}))
  const pending=state.applySavedSearch({scope:'conversation',username:'room',query:'旧账号应用',retrieval_mode:'keyword',render_types:'text',sender:'alice',session_type:'',start_time:null,end_time:null})
  account.value='b';account.value='a'
  finish();await pending
  expect(search).not.toHaveBeenCalled()
  expect(state.messageSearchQuery.value).toBe('')
})
