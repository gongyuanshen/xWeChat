import { reactive } from 'vue'
import { ECHO_KINDS, ECHO_SCENES, assertEchoCard, assertEchoDetail } from '../lib/wrapped-echo-model'

export function createEchoReport(api){
  const state=reactive({meta:null,cards:{},loading:false,error:'',detail:null,loadedDetails:[]})
  let generation=0,detailGeneration=0,refresh=false,metaController=null,detailController=null
  const pending=new Map(),controllers=new Set()
  function closeDetail(){detailGeneration++;detailController?.abort();detailController=null;state.detail=null}
  function cancel(){generation++;metaController?.abort();for(const c of controllers)c.abort();controllers.clear();pending.clear();closeDetail()}
  async function load({account,year,refresh:force=false}){
    cancel();const token=generation
    state.meta=null;state.cards={};state.detail=null;state.loadedDetails=[];state.loading=true;state.error='';refresh=force
    metaController=new AbortController()
    try{
      if(!account)throw new Error('请先选择一个已有聊天数据的账号')
      const meta=await api.getWrappedAnnualMeta({account,year,refresh:force,signal:metaController.signal})
      if(token!==generation)return null
      if(meta?.account!==account)throw new Error('年度目录响应账号不匹配')
      if(meta.contractVersion!==1)throw new Error('年度目录接口版本不匹配，请重启后端')
      if(!Number.isInteger(meta.year)||!Array.isArray(meta.availableYears)||meta.availableYears.some(y=>!Number.isInteger(y))||!Array.isArray(meta.cards))throw new Error('年度目录格式无效')
      if(meta.cards.length!==8||new Set(meta.cards.map(c=>c.id)).size!==8||meta.cards.some(c=>!Number.isInteger(c.id)||c.id<0||c.id>7||ECHO_KINDS[c.id]!==c.kind))throw new Error('年度目录卡片契约不匹配')
      state.meta=meta;state.cards=Object.fromEntries(meta.cards.map(c=>[c.id,{...c,status:'idle',data:null,error:''}]))
      return meta
    }catch(error){if(token===generation)state.error=error.message||String(error);return null}
    finally{if(token===generation)state.loading=false}
  }
  function loadCard(id,{retry=false}={}){
    if(!state.meta)throw new Error('年度目录尚未准备好')
    if(pending.has(id))return pending.get(id)
    const existing=state.cards[id]
    if(!existing)throw new Error('年度目录没有所请求的卡片')
    if(existing.status==='ok'||(!retry&&['error','building'].includes(existing.status)))return Promise.resolve(existing)
    const token=generation,{account,year}=state.meta,controller=new AbortController()
    controllers.add(controller);state.cards[id]={...existing,status:'loading',error:''}
    const promise=(async()=>{
      try{
        const card=await api.getWrappedAnnualCard(id,{account,year,refresh:refresh||retry,signal:controller.signal})
        if(token!==generation)return null
        assertEchoCard(card,{account,year,id});state.cards[id]=card;return card
      }catch(error){if(token===generation)state.cards[id]={...existing,status:'error',data:null,error:error.message||String(error)};return null}
      finally{controllers.delete(controller);if(token===generation)pending.delete(id)}
    })()
    pending.set(id,promise);return promise
  }
  async function loadScene(index,options){
    if(!ECHO_SCENES[index])throw new Error('未知的年度空间')
    await Promise.all(ECHO_SCENES[index].cards.map(id=>loadCard(id,options)))
  }
  async function requireScene(index){
    const token=generation;await loadScene(index)
    if(token!==generation)throw new Error('账号或年份已变化，本次导出已取消')
    const failed=ECHO_SCENES[index].cards.map(id=>state.cards[id]).find(c=>c.status!=='ok')
    if(failed)throw new Error(failed.error||`${failed.title} 尚未就绪，请完成统计后重试`)
  }
  async function loadDetail(query,{append=false,refresh:force=false}={}){
    if(!state.meta)throw new Error('年度目录尚未准备好')
    detailController?.abort();detailController=new AbortController()
    const token=++detailGeneration,epoch=generation,{account,year}=state.meta
    const previous=append?state.detail?.data:null
    const request={kind:query.kind,value:String(query.value),period:query.period||'all',month:query.month??null,offset:append?previous.offset+previous.items.length:0,limit:40}
    state.detail={query:request,status:'loading',data:previous,error:''}
    try{
      const response=await api.getWrappedAnnualDetail({...request,account,year,refresh:force,signal:detailController.signal})
      if(token!==detailGeneration||epoch!==generation)return null
      if(response?.account!==account||response.year!==year||response.contractVersion!==1||response.kind!==request.kind||String(response.value)!==request.value||response.period!==request.period||response.month!==request.month)throw new Error('年度详情的账号、年份或选择不匹配')
      assertEchoDetail(response)
      const data=previous?{...response,offset:0,items:[...previous.items,...response.items],replyPairs:[...(previous.replyPairs||[]),...(response.replyPairs||[])]}:response
      state.detail={query:request,status:response.status,data,error:''}
      if(response.status==='ok'){
        const key=d=>JSON.stringify([d.kind,d.value,d.period,d.month])
        state.loadedDetails=state.loadedDetails.filter(d=>key(d)!==key(data));state.loadedDetails.push(data)
      }
      return data
    }catch(error){if(token===detailGeneration&&epoch===generation)state.detail={query:request,status:'error',data:previous,error:error.message||String(error)};return null}
  }
  return {state,load,loadCard,loadScene,requireScene,loadDetail,closeDetail,dispose:cancel,getIdentity:()=>({generation,account:state.meta?.account,year:state.meta?.year})}
}
