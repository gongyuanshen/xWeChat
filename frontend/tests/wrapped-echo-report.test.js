import { describe, expect, it, vi } from 'vitest'
import { createEchoReport } from '../composables/useEchoReport'
import { ECHO_SCENES, calendarMonths, scheduleHours, periodDayCount, assertEchoCard } from '../lib/wrapped-echo-model'

const kinds=['global/overview','time/weekday_hour_heatmap','text/message_chars','chat/reply_speed','chat/monthly_best_friends_wall','emoji/annual_universe','text/keywords_wordcloud','global/bento_summary']
const meta=(account,year)=>({account,year,contractVersion:1,availableYears:[year],cards:kinds.map((kind,id)=>({id,kind,title:kind}))})
const emptyOverview=(account='a',year=2025)=>({account,year,contractVersion:1,id:0,kind:kinds[0],status:'ok',data:{year,totalMessages:0,activeDays:0,messagesPerDay:0,sentMediaCount:0,sentStickerCount:0,addedFriends:0,peakDay:null,annualHeatmap:{year,dailyCounts:Array(periodDayCount(year,'all')).fill(0)}}})
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}

describe('Echo annual report identity and data',()=>{
  it('the new journey separates scene positions from backend card ids',()=>{
    expect(ECHO_SCENES).toHaveLength(10)
    expect(ECHO_SCENES[2].cards).toEqual([3])
    expect(ECHO_SCENES[7].cards).toEqual([2])
  })
  it('calendar retains leap-day counts and rejects truncated data',()=>{
    const days=Array(366).fill(0);days[59]=27
    const months=calendarMonths(2024,days)
    expect(months[1]).toMatchObject({month:2,days:29})
    expect(months[1].counts[28]).toBe(27)
    expect(()=>calendarMonths(2024,days.slice(1))).toThrow(/日历/)
  })
  it('weekday filtering uses the actual calendar denominator',()=>{
    const matrix=Array.from({length:7},(_,d)=>Array(24).fill(d+1))
    expect(scheduleHours(matrix,'weekday')[0]).toBe(15)
    expect(scheduleHours(matrix,'weekend')[0]).toBe(13)
    expect(periodDayCount(2025,'weekday')+periodDayCount(2025,'weekend')).toBe(365)
  })
  it('rejects wrong identities and malformed count data before presentation',()=>{
    const card=emptyOverview()
    expect(()=>assertEchoCard(card,{account:'b',year:2025,id:0})).toThrow(/账号/)
    expect(()=>assertEchoCard({...card,data:{...card.data,totalMessages:-1}},{account:'a',year:2025,id:0})).toThrow(/totalMessages/)
  })
  it('late cards and details cannot overwrite the newly selected account',async()=>{
    const cardTask=deferred(),detailTask=deferred()
    const api={getWrappedAnnualMeta:vi.fn(({account,year})=>meta(account,year)),getWrappedAnnualCard:vi.fn(()=>cardTask.promise),getWrappedAnnualDetail:vi.fn(()=>detailTask.promise)}
    const report=createEchoReport(api)
    await report.load({account:'a',year:2025})
    const card=report.loadCard(0),detail=report.loadDetail({kind:'day',value:'2025-01-01'})
    await report.load({account:'b',year:2025})
    cardTask.resolve(emptyOverview('a'));detailTask.resolve({account:'a',year:2025,contractVersion:1,kind:'day',value:'2025-01-01',period:'all',status:'ok',items:[],summary:{messageCount:0},total:0,hasMore:false,offset:0,limit:40})
    await card;await detail
    expect(report.state.meta.account).toBe('b')
    expect(report.state.cards[0].status).toBe('idle')
    expect(report.state.detail).toBeNull()
  })
  it('coalesces pending cards and requires explicit retry after errors',async()=>{
    const task=deferred(),api={getWrappedAnnualMeta:vi.fn(()=>meta('a',2025)),getWrappedAnnualCard:vi.fn(()=>task.promise)}
    const report=createEchoReport(api);await report.load({account:'a',year:2025})
    const a=report.loadCard(0),b=report.loadCard(0)
    task.reject(new Error('read failed'));await a;await b
    expect(report.state.cards[0].status).toBe('error')
    await report.loadCard(0)
    expect(api.getWrappedAnnualCard).toHaveBeenCalledTimes(1)
    api.getWrappedAnnualCard.mockResolvedValue(emptyOverview())
    await report.loadCard(0,{retry:true})
    expect(report.state.cards[0].data.totalMessages).toBe(0)
  })
  it('closing a detail revokes its pending response',async()=>{
    const task=deferred(),report=createEchoReport({getWrappedAnnualMeta:()=>meta('a',2025),getWrappedAnnualDetail:()=>task.promise})
    await report.load({account:'a',year:2025});const pending=report.loadDetail({kind:'phrase',value:'收到'})
    report.closeDetail();task.resolve({account:'a',year:2025,contractVersion:1,kind:'phrase',value:'收到',period:'all',status:'ok',items:[],summary:{},total:0,hasMore:false,offset:0,limit:40});await pending
    expect(report.state.detail).toBeNull()
  })
  it('rejects an annual response for a month-filtered detail',async()=>{
    const api={getWrappedAnnualMeta:()=>meta('a',2025),getWrappedAnnualDetail:vi.fn(()=>({account:'a',year:2025,contractVersion:1,kind:'phrase',value:'收到',period:'all',month:null,status:'ok',items:[],summary:{sent:0,received:0,messageCount:0,conversationCount:0},total:0,hasMore:false,offset:0,limit:40}))}
    const report=createEchoReport(api);await report.load({account:'a',year:2025})
    await report.loadDetail({kind:'phrase',value:'收到',month:2})
    expect(api.getWrappedAnnualDetail.mock.calls[0][0].month).toBe(2)
    expect(report.state.detail.status).toBe('error')
    expect(report.state.loadedDetails).toHaveLength(0)
  })
  it('rejects a success detail with a missing summary instead of showing an empty result',async()=>{
    const api={getWrappedAnnualMeta:()=>meta('a',2025),getWrappedAnnualDetail:()=>({account:'a',year:2025,contractVersion:1,kind:'day',value:'2025-01-01',period:'all',month:null,status:'ok',items:[],summary:null,total:0,hasMore:false,offset:0,limit:40})}
    const report=createEchoReport(api);await report.load({account:'a',year:2025})
    await report.loadDetail({kind:'day',value:'2025-01-01'})
    expect(report.state.detail.status).toBe('error')
    expect(report.state.detail.error).toMatch(/统计/)
    expect(report.state.loadedDetails).toHaveLength(0)
  })
})
