export const ECHO_KINDS = ['global/overview','time/weekday_hour_heatmap','text/message_chars','chat/reply_speed','chat/monthly_best_friends_wall','emoji/annual_universe','text/keywords_wordcloud','global/bento_summary']
export const ECHO_SCENES = [
  {id:0,title:'误入这一年',kicker:'THRESHOLD',cards:[0]},
  {id:1,title:'日历后室',kicker:'THE DAY',cards:[0]},
  {id:2,title:'回声电话局',kicker:'CONNECTIONS',cards:[3]},
  {id:3,title:'十二号站台',kicker:'TWELVE MONTHS',cards:[4]},
  {id:4,title:'午夜水池',kicker:'AFTER HOURS',cards:[1]},
  {id:5,title:'词语广播厅',kicker:'WORDS IN THE AIR',cards:[6]},
  {id:6,title:'失重游乐室',kicker:'ZERO GRAVITY',cards:[5]},
  {id:7,title:'无声剧场',kicker:'THE UNSPOKEN',cards:[2]},
  {id:8,title:'记忆天体',kicker:'A YEAR IN ORBIT',cards:[0,1,2,3,4,5,6]},
  {id:9,title:'出口封存站',kicker:'TAKE IT WITH YOU',cards:[0,1,2,3,4,5,6]},
]
export const echoNumber = n => new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n)
export function echoDuration(seconds) {
  if(seconds==null)return '暂无回复样本'
  const s=Math.round(seconds)
  if(s<60)return `${s}秒`
  if(s<3600)return `${Math.floor(s/60)}分${s%60?`${s%60}秒`:''}`
  return `${Math.floor(s/3600)}时${Math.floor(s%3600/60)}分`
}
function count(n,name){if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw new Error(`年度统计 ${name} 必须为非负数`);return n}
function array(value,name){if(!Array.isArray(value))throw new Error(`年度统计 ${name} 缺少列表`);return value}
export function periodDayCount(year,period='all') {
  if(!Number.isInteger(year)||year<1900||year>9999)throw new Error('年度统计年份无效')
  if(!['all','weekday','weekend'].includes(period))throw new Error('时段范围无效')
  const days=Math.round((Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000)
  if(period==='all')return days
  let n=0
  for(let i=0;i<days;i++){const day=new Date(Date.UTC(year,0,i+1)).getUTCDay();if(period==='weekday'?(day!==0&&day!==6):(day===0||day===6))n++}
  return n
}
export function calendarMonths(year,dailyCounts){
  if(!Array.isArray(dailyCounts)||dailyCounts.length!==periodDayCount(year))throw new Error('日历数据长度与所选年份不一致')
  dailyCounts.forEach(n=>count(n,'dailyCounts'))
  let offset=0
  return Array.from({length:12},(_,i)=>{const days=new Date(Date.UTC(year,i+1,0)).getUTCDate();const counts=dailyCounts.slice(offset,offset+days);offset+=days;return {month:i+1,days,counts}})
}
export function scheduleHours(matrix,period='all'){
  if(!Array.isArray(matrix)||matrix.length!==7||matrix.some(row=>!Array.isArray(row)||row.length!==24))throw new Error('发送节律必须包含 7×24 个读数')
  if(!['all','weekday','weekend'].includes(period))throw new Error('时段范围无效')
  matrix.flat().forEach(n=>count(n,'matrix'))
  const selected=matrix.filter((_,i)=>period==='all'||(period==='weekday'?i<5:i>=5))
  return Array.from({length:24},(_,h)=>selected.reduce((sum,row)=>sum+row[h],0))
}
export function assertEchoCard(card,{account,year,id}){
  if(!card||card.account!==account)throw new Error('年度统计响应账号不匹配')
  if(card.year!==year)throw new Error('年度统计响应年份不匹配')
  if(card.id!==id||card.kind!==ECHO_KINDS[id])throw new Error('年度统计响应卡片类型不匹配')
  if(card.contractVersion!==1)throw new Error('年度统计接口版本不匹配，请重启后端')
  if(!['ok','building','error'].includes(card.status))throw new Error('年度统计响应状态无效')
  if(card.status!=='ok')return card
  const d=card.data
  if(!d||typeof d!=='object'||Array.isArray(d))throw new Error('年度统计正文缺失')
  if(d.year!==undefined&&d.year!==year)throw new Error('年度统计正文年份不匹配')
  if(id===0){['totalMessages','activeDays','messagesPerDay','sentMediaCount','sentStickerCount','addedFriends'].forEach(k=>count(d[k],k));calendarMonths(year,d.annualHeatmap?.dailyCounts)}
  if(id===1){scheduleHours(d.matrix);count(d.totalMessages,'totalMessages')}
  if(id===2){['sentChars','receivedChars'].forEach(k=>count(d[k],k));for(const [o,keys] of [[d.voice,['sentCount','sentSeconds','receivedCount','receivedSeconds']],[d.calls,['totalCount','totalSeconds','voiceCount','videoCount']]]){if(!o)throw new Error('声音统计缺失');keys.forEach(k=>count(o[k],k))}}
  if(id===3){array(d.topTotals,'topTotals');array(d.allContacts,'allContacts')}
  if(id===4){array(d.months,'months');if(d.months.length!==12||d.months.some((m,i)=>m.month!==i+1))throw new Error('月份数据必须按序包含十二个月')}
  if(id===5){['topStickers','topWechatEmojis','topTextEmojis','topUnicodeEmojis'].forEach(k=>array(d[k],k));['sentStickerCount','uniqueStickerTypeCount','revivedStickerCount'].forEach(k=>count(d[k],k))}
  if(id===6){array(d.keywords,'keywords').forEach(p=>{if(typeof p.word!=='string'||!p.word.trim())throw new Error('短句正文无效');count(p.count,'keyword count');array(p.monthlyCounts,'monthlyCounts');if(p.monthlyCounts.length!==12)throw new Error('短句月份统计必须包含十二个月');p.monthlyCounts.forEach(n=>count(n,'monthly phrase count'));if(p.monthlyCounts.reduce((s,n)=>s+n,0)!==p.count)throw new Error('短句月度数量与年度数量不一致')})}
  return card
}
export function cardData(cards,id){return cards[id]?.status==='ok'?cards[id].data:null}
export function assertEchoDetail(detail) {
  if(!['ok','building'].includes(detail.status)||!Array.isArray(detail.items))throw new Error('年度详情格式无效')
  if(detail.status==='building'){
    if(detail.summary!==null||detail.total!==null||detail.items.length!==0)throw new Error('正在构建的年度详情不能包含完成统计')
    return
  }
  if(!detail.summary||typeof detail.summary!=='object')throw new Error('年度详情缺少统计摘要')
  const summary=detail.summary
  for(const key of ['sent','received','messageCount','conversationCount'])count(summary[key],key)
  count(detail.total,'total');count(detail.offset,'offset');count(detail.limit,'limit')
  if(typeof detail.hasMore!=='boolean'||summary.sent+summary.received!==summary.messageCount||summary.messageCount!==detail.total)throw new Error('年度详情统计总量不一致')
  if(detail.kind==='day')array(summary.conversations,'conversations')
  if(detail.kind==='emoji')count(summary.occurrenceCount,'occurrenceCount')
  if(detail.kind==='contact'){
    if(!summary.reply)throw new Error('年度详情缺少双向回复统计')
    for(const side of ['me','them']){
      const reply=summary.reply[side]
      if(!reply)throw new Error('年度详情缺少一个方向的回复统计')
      count(reply.count,'reply count')
      if(reply.count===0){if(reply.p50Seconds!==null||reply.p90Seconds!==null)throw new Error('无回复样本不能产生分位数')}
      else {count(reply.p50Seconds,'P50');count(reply.p90Seconds,'P90')}
      array(reply.buckets,'reply buckets').forEach(bucket=>count(bucket.count,'bucket count'))
      if(reply.buckets.length!==4||reply.buckets.reduce((s,b)=>s+b.count,0)!==reply.count)throw new Error('回复分布与样本量不一致')
    }
    array(detail.replyPairs,'replyPairs');count(detail.pairsTotal,'pairsTotal')
  }
  for(const item of detail.items){
    if(typeof item.text!=='string'||typeof item.isSent!=='boolean'||!Number.isFinite(item.timestamp))throw new Error('年度来源消息格式无效')
    if(['username','dbStem','table'].some(key=>typeof item[key]!=='string'||!item[key])||!Number.isInteger(item.localId)||item.localId<=0)throw new Error('年度来源消息缺少有效锚点')
  }
}
export function echoContacts(data){
  if(!data)return []
  const items=new Map()
  // Counts are absent for identity-only contacts until their detail is loaded.
  for(const contact of [...data.topTotals,...data.allContacts])if(!items.has(contact.username))items.set(contact.username,contact)
  return [...items.values()]
}
export function echoEmojis(data,resolveMedia=url=>url){
  if(!data)return []
  const stickers=data.topStickers.map((e,i)=>({key:e.md5.startsWith('expr:')?e.md5:`md5:${e.md5}`,label:e.emojiLabel||`图片表情 ${i+1}`,url:e.emojiUrl?resolveMedia(e.emojiUrl):'',count:e.count,unit:'条图片表情',kind:'sticker'}))
  const known=new Set(stickers.map(item=>item.key))
  return [
    ...stickers,
    ...data.topWechatEmojis.filter(e=>!known.has(`expr:${e.id}`)).map(e=>({key:`expr:${e.id}`,label:e.key,url:e.assetPath?resolveMedia(e.assetPath):'',count:e.count,unit:'条原生表情',kind:'sticker'})),
    ...data.topTextEmojis.map(e=>({key:`text:${e.key}`,label:e.key,url:e.assetPath?resolveMedia(e.assetPath):'',emoji:e.key,count:e.count,unit:'次文本表情',kind:'text'})),
    ...data.topUnicodeEmojis.map(e=>({key:`text:${e.emoji}`,label:e.emoji,emoji:e.emoji,count:e.count,unit:'次 Emoji',kind:'unicode'})),
  ]
}
export function createEchoDocument({year,cards,loadedDetails=[]}){
  for(const id of ECHO_SCENES[8].cards)if(cards[id]?.status!=='ok')throw new Error(`请先完成第 ${id} 类统计，再生成完整档案`)
  const [o,h,v,r,m,e,p]=[0,1,2,3,4,5,6].map(id=>cards[id].data)
  const metric=(label,value,unit='',privacy)=>({label,value,unit,...(privacy?{private:privacy}:{})})
  const line=(label,value,privacy)=>({label,value,...(privacy?{private:privacy}:{})})
  const months=calendarMonths(year,o.annualHeatmap.dailyCounts)
  const days=months.flatMap(month=>month.counts.map((n,i)=>line(`${year}-${String(month.month).padStart(2,'0')}-${String(i+1).padStart(2,'0')}`,`${n} 条收发`)))
  const total=o.annualHeatmap.dailyCounts.reduce((s,n)=>s+n,0)
  const summaries=['从一个具体的日子，重新走过这一年。','日历以收发消息统计，每个日期都保留读数。','单聊往来与回复，描述记录，不推断亲密关系。','月度伙伴按互动量、回复速度、活跃天与时段覆盖综合评分。','全年发送节律，只计算本人发送；日均使用对应日历天数。','本人反复发送的 2–20 字完整短消息。','图片表情按条、文本表情和 Emoji 按出现次数分别统计。','字符、语音和通话各自计算，不相加为一个总量。','走过的空间，汇成这一年的形状。','本档案包含选中章节的统计与已选入的详情，保存在本地。']
  const scenes=ECHO_SCENES.map(s=>({id:s.id,title:s.title,kicker:s.kicker,summary:summaries[s.id],metrics:[],rows:[],details:[]}))
  scenes[0].metrics=[metric('年度',year),metric('收发活跃天',o.activeDays,'天')]
  scenes[1].metrics=[metric('全年收发',total,'条'),metric('收发活跃天',o.activeDays,'天')];scenes[1].rows=days
  if(o.peakDay)scenes[1].metrics.push(metric('峰值日',o.peakDay.date),metric('峰值日收发',o.peakDay.count,'条'))
  scenes[2].metrics=[metric('本人回复样本',r.replyEvents,'次'),metric('发送过消息的联系人',r.sentToContacts,'位')]
  scenes[2].rows=r.topTotals.map(c=>line(c.displayName,`${c.totalMessages} 条双方消息`,'person'))
  if(r.initiative){scenes[2].metrics.push(metric('我开启的对话',r.initiative.initiatedByMe,'段'),metric('对方开启的对话',r.initiative.initiatedByOthers,'段'));scenes[2].details.push({title:'对话段口径',rows:[line('规则','至少 1 小时的消息间隔划分新对话段')]})}
  scenes[3].metrics=[metric('有伙伴的月份',m.summary.monthsWithWinner,'个月')]
  scenes[3].rows=m.months.map(month=>month.winner?line(`${month.month}月`,`${month.winner.displayName} · ${month.raw.totalMessages} 条双方消息`,'person'):line(`${month.month}月`,'没有满足评选门槛的记录'))
  scenes[3].details=m.months.filter(month=>month.winner).map(month=>({title:`${month.month}月的评分分项`,rows:[line('互动量',`${(month.metrics.interactionScore*100).toFixed(1)} / 100 · 权重40%`),line('回复速度',`${(month.metrics.speedScore*100).toFixed(1)} / 100 · 权重30%`),line('活跃天',`${month.raw.activeDays} 天 · 权重20%`),line('时段覆盖',`${month.raw.timeBucketsCount} 个 · 权重10%`)]}))
  scenes[4].metrics=[metric('本人发送',h.totalMessages,'条')]
  scenes[4].rows=scheduleHours(h.matrix).map((n,i)=>line(`${String(i).padStart(2,'0')}:00—${String(i).padStart(2,'0')}:59`,`${n} 条`))
  scenes[4].details=['weekday','weekend'].map(period=>({title:period==='weekday'?'工作日发送':'周末发送',rows:scheduleHours(h.matrix,period).map((n,i)=>line(`${i}:00`,`${n} 条 · 日均 ${(n/periodDayCount(year,period)).toFixed(1)} 条`))}))
  if(h.nightCompanion?.partner)scenes[4].rows.push(line('深夜往来最多的伙伴',h.nightCompanion.partner.displayName,'person'))
  scenes[5].metrics=[metric('反复出现的短句',p.keywords.length,'条')];scenes[5].rows=p.keywords.map(word=>line(word.word,`${word.count} 次`,'message'))
  scenes[5].details=p.keywords.map(word=>({title:word.word,private:'message',rows:word.monthlyCounts.map((n,i)=>line(`${i+1}月`,`${n} 次`))}))
  scenes[6].metrics=[metric('发送图片表情',e.sentStickerCount,'条'),metric('表情种类',e.uniqueStickerTypeCount,'种'),metric('旧表情重现',e.revivedStickerCount,'种')]
  scenes[6].rows=echoEmojis(e).map(item=>line(item.label,`${item.count} ${item.unit}`,item.kind==='sticker'?'person':'message'))
  scenes[7].metrics=[metric('本人发送字符',v.sentChars,'个'),metric('收到字符',v.receivedChars,'个'),metric('发送语音',echoDuration(v.voice.sentSeconds)),metric('收到语音',echoDuration(v.voice.receivedSeconds)),metric('通话记录时长',echoDuration(v.calls.totalSeconds))]
  scenes[7].rows=[line('字符口径','渲染文本中去除空白符后的字符，包含标点'),line('语音/通话','单聊记录的时长，不等于实际收听时长'),line('语音消息',`${v.voice.sentCount} 条发出 / ${v.voice.receivedCount} 条收到`),line('通话次数',`${v.calls.voiceCount} 次语音 / ${v.calls.videoCount} 次视频`)]
  if(v.typedPhrases)scenes[7].details.push({title:'输入过的短句',private:'message',rows:v.typedPhrases.map((s,i)=>line(`短句 ${i+1}`,typeof s==='string'?s:s.text,'message'))})
  scenes[8].metrics=[metric('本人发送消息',o.totalMessages,'条'),metric('全年收发消息',total,'条'),metric('收发活跃天',o.activeDays,'天'),metric('发送日均',o.messagesPerDay,'条/发送活跃天'),metric('图片与视频',o.sentMediaCount,'条'),metric('添加好友提示',o.addedFriends,'条')]
  scenes[8].rows=[line('新朋友口径','依据本地添加好友系统提示推断，非完整好友新增名单')]
  scenes[9].metrics=[metric('年度',year),metric('本人发送',o.totalMessages,'条'),metric('收发活跃天',o.activeDays,'天')]
  const kinds={day:1,contact:2,hour:4,night:4,phrase:5,emoji:6}
  const kindNames={day:'日期记录',contact:'联系人往来',hour:'发送时段',night:'深夜往来',phrase:'短句出处',emoji:'表情出处'}
  const people=new Map([...echoContacts(r),...m.months.filter(month=>month.winner).map(month=>month.winner),...(h.nightCompanion?.partner?[h.nightCompanion.partner]:[])].map(person=>[person.username,person.displayName]))
  const expressions=new Map(echoEmojis(e).map(item=>[item.key,item]))
  const personOrdinals=new Map(),emojiOrdinals=new Map()
  for(const detail of loadedDetails){
    if(detail.status!=='ok'||detail.account!==cards[0].account||detail.year!==year)continue
    const chapter=scenes[kinds[detail.kind]]
    if(!chapter)throw new Error('档案详情类别无效')
    const summary=detail.summary
    const rows=[line('已载入消息',`${detail.items.length} / ${detail.total} 条${detail.hasMore?' · 还有未载入的记录':''}`),line('本人发送',`${summary.sent} 条`),line('收到',`${summary.received} 条`),line('匹配消息',`${summary.messageCount} 条`)]
    let objectLabel=''
    if(detail.kind==='contact'||detail.kind==='night'){
      if(!personOrdinals.has(detail.value))personOrdinals.set(detail.value,personOrdinals.size+1)
      objectLabel=`联系人 ${personOrdinals.get(detail.value)}`
      rows.unshift(line('回看对象',objectLabel))
      const name=people.get(detail.value)||detail.items.find(item=>item.username===detail.value)?.displayName
      if(name)rows.push(line('联系人',name,'person'))
    }
    if(detail.kind==='emoji'){
      if(!emojiOrdinals.has(detail.value))emojiOrdinals.set(detail.value,emojiOrdinals.size+1)
      objectLabel=`表情 ${emojiOrdinals.get(detail.value)}`
      rows.unshift(line('回看对象',objectLabel))
      const expression=expressions.get(detail.value)
      if(expression)rows.push(line('表情',expression.label,expression.kind==='sticker'?'person':'message'))
    }
    const detailTitle=`${kindNames[detail.kind]}${objectLabel?` · ${objectLabel}`:''}${detail.month!=null?` · ${detail.month}月`:''}`
    if(detail.month!=null)rows.push(line('月份范围',`${year}年${detail.month}月`))
    if(detail.kind==='day')rows.push(line('日期',detail.value))
    if(detail.kind==='hour')rows.push(line('时段',`${detail.value}:00—${detail.value}:59`),line('日期范围',{all:'全年',weekday:'周一至周五',weekend:'周末'}[detail.period]))
    if(detail.kind==='night')rows.push(line('时段','00:00—05:59'))
    if(detail.kind==='phrase')rows.push(line('完整短句',detail.value,'message'))
    if(summary.occurrenceCount!==undefined)rows.push(line('表情出现次数',`${summary.occurrenceCount} 次`))
    if(summary.reply){
      for(const direction of ['me','them']){
        const reply=summary.reply[direction],name=direction==='me'?'本人':'对方'
        rows.push(line(`${name}回复样本`,`${reply.count} 次`),line(`${name}回复 P50`,echoDuration(reply.p50Seconds)),line(`${name}回复 P90`,echoDuration(reply.p90Seconds)))
        for(const bucket of reply.buckets)rows.push(line(`${name}回复 · ${bucket.label}`,`${bucket.count} 次`))
      }
      rows.push(line('回复规则',summary.replyRule),line('已载入回复对',`${detail.replyPairs.length} / ${detail.pairsTotal} 对 · 对应已载入消息页中的回复`))
    }
    chapter.details.push({title:`已展开的${detailTitle}`,rows})
    if(summary.conversations)chapter.details.push({title:'当天会话',private:'person',rows:summary.conversations.map(c=>line(c.displayName,`${c.messageCount} 条双方消息`,'person'))})
    chapter.details.push({title:`${detailTitle} · 已载入正文`,private:'message',rows:detail.items.map(item=>line(new Date(item.timestamp*1000).toLocaleString('zh-CN'),`${item.isSent?'本人':'对方'}：${item.text}`,'message'))})
    if(detail.replyPairs?.length)chapter.details.push({title:`${detailTitle} · 双向回复对`,private:'message',rows:detail.replyPairs.flatMap(pair=>[line(`${pair.direction==='me'?'本人':'对方'}回复间隔`,echoDuration(pair.seconds)),line('前一条消息',pair.from.text,'message'),line('回复消息',pair.to.text,'message')])})
  }
  return {year,generatedAt:new Date().toISOString(),scenes}
}
