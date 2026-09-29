import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptySearchContext, useChatSearch } from '../composables/chat/useChatSearch'

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve=yes }); return { promise, resolve } }
let wrapper, originalClient
beforeEach(() => { originalClient=process.client; process.client=true; vi.spyOn(console,'info').mockImplementation(()=>{}); vi.stubGlobal('useSettingsDialog',()=>({openDialog:vi.fn()}));vi.stubGlobal('useApiBase',()=>'/api') })
afterEach(() => { wrapper?.unmount(); process.client=originalClient; vi.restoreAllMocks();vi.unstubAllGlobals() })
const setup = (fetchContext = vi.fn(async () => ({messages:[{id:'target'}],anchorId:'target',anchorIndex:0}))) => {
  const args = {
    api:{getChatMessagesAround:fetchContext}, contacts:ref([{username:'chat',name:'会话'}]), selectedAccount:ref('account'), selectedContact:ref({username:'chat',name:'会话'}), privacyMode:ref(false),
    allMessages:ref({chat:[{id:'recent'}]}), messagesMeta:ref({chat:{hasMore:true}}), messages:ref([]), messageContainerRef:ref(null), messagePageSize:50,
    hasMoreMessages:ref(false), isLoadingMessages:ref(false), normalizeMessage:message=>message, updateJumpToBottomState:vi.fn(), scrollToMessageId:vi.fn(async()=>true), flashMessage:vi.fn(), highlightMessageId:ref(''), searchContext:ref(createEmptySearchContext()), selectContact:vi.fn(), loadMoreMessages:vi.fn()
  }
  let search
  args.selectContact.mockImplementation(async contact=>{args.selectedContact.value=contact})
  wrapper=mount(defineComponent({setup(){search=useChatSearch(args);return()=>h('div')}}))
  const locate = (anchorId='target') => search.locateByAnchorId({targetUsername:'chat',anchorId,kind:'ai',throwOnError:true})
  return {args,search,locate,fetchContext}
}

describe('AI 来源定位',()=>{
  it('智能搜索明确区分正在建立的关键词索引',()=>{
    const {search}=setup()
    search.messageSearchMode.value='hybrid'
    search.messageSearchIndexInfo.value={exists:false,build:{status:'building'}}
    expect(search.messageSearchIndexText.value).toBe('关键词索引正在建立')
    search.messageSearchIndexInfo.value={exists:false,build:{status:'idle'}}
    expect(search.messageSearchIndexText.value).toBe('关键词索引未建立')
  })
  it('已加载的消息直接高亮，不请求上下文也不替换列表',async()=>{
    const {args,locate,fetchContext}=setup()
    await expect(locate('recent')).resolves.toBe(true)
    expect(fetchContext).not.toHaveBeenCalled()
    expect(args.flashMessage).toHaveBeenCalledWith('recent')
    expect(args.searchContext.value.active).toBe(false)
  })
  it('打开预览不切换会话，定位复用尚未完成的预读请求',async()=>{
    const task=deferred(), {args,search,locate,fetchContext}=setup(vi.fn(()=>task.promise))
    const prepare=search.prepareAnchorContext({targetUsername:'chat',anchorId:'target'})
    expect(args.searchContext.value.active).toBe(false)
    expect(args.selectContact).not.toHaveBeenCalled()
    const result=locate()
    task.resolve({messages:[{id:'target'}],anchorId:'target',anchorIndex:0})
    await prepare; await expect(result).resolves.toBe(true)
    expect(fetchContext).toHaveBeenCalledTimes(1)
    expect(args.flashMessage).toHaveBeenCalledWith('target')
  })
  it.each(['account','contact','exit'])('定位等待期间切换 %s，旧结果不改写当前列表',async kind=>{
    const task=deferred(), {args,locate}=setup(vi.fn(()=>task.promise))
    const result=locate()
    if(kind==='account') args.selectedAccount.value='other-account'
    if(kind==='contact') args.selectedContact.value={username:'other-chat'}
    if(kind==='exit') args.searchContext.value=createEmptySearchContext()
    task.resolve({messages:[{id:'target'}],anchorId:'target'})
    await expect(result).resolves.toBe(false)
    expect(args.allMessages.value.chat).toEqual([{id:'recent'}])
    expect(args.flashMessage).not.toHaveBeenCalled()
  })
  it('快速定位两条来源时，只接受最后一次结果',async()=>{
    const first=deferred(), second=deferred()
    const {args,locate}=setup(vi.fn(params=>params.anchor_id==='first'?first.promise:second.promise))
    const a=locate('first'), b=locate('second')
    second.resolve({messages:[{id:'second'}],anchorId:'second'}); await b
    first.resolve({messages:[{id:'first'}],anchorId:'first'}); await a
    expect(args.allMessages.value.chat).toEqual([{id:'second'}])
    expect(args.flashMessage).toHaveBeenCalledTimes(1)
    expect(args.flashMessage).toHaveBeenCalledWith('second')
  })
  it('失败返回给引用卡片处理，重试重新取数据',async()=>{
    const fetch=vi.fn().mockRejectedValueOnce(new Error('暂时断线')).mockResolvedValueOnce({messages:[{id:'target'}],anchorId:'target'})
    const {args,locate}=setup(fetch)
    await expect(locate()).rejects.toThrow('暂时断线')
    expect(args.searchContext.value.active).toBe(false)
    expect(args.allMessages.value.chat).toEqual([{id:'recent'}])
    await expect(locate()).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
