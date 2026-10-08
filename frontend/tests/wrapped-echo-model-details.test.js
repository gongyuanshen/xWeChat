import { describe, it, expect } from 'vitest'
import { echoEmojis, createEchoDocument } from '../lib/wrapped-echo-model'
import { createEchoCardFixture, createEchoDetailFixture } from './fixtures/wrapped-echo-cards'
import { createEchoExportDocument } from '../lib/wrapped-echo-export'

describe('echo source-to-export contracts',()=>{
  it('preserves native expression keys and adds expressions outside the sticker top six exactly once',()=>{
    const data={topStickers:[{md5:'expr:1',emojiLabel:'[微笑]',count:4,emojiUrl:'/wxemoji/1.png'}],topWechatEmojis:[{id:1,key:'[微笑]',count:4,assetPath:'/wxemoji/1.png'},{id:2,key:'[撇嘴]',count:2,assetPath:'/wxemoji/2.png'}],topTextEmojis:[{key:'[微笑]',count:3}],topUnicodeEmojis:[]}
    const items=echoEmojis(data)
    expect(items.map(i=>i.key)).toEqual(['expr:1','expr:2','text:[微笑]'])
    expect(items.find(i=>i.key==='text:[微笑]').count).toBe(3)
  })
  it('retains bidirectional detail statistics without leaking names, sources, or text in anonymous archives',()=>{
    const cards=createEchoCardFixture(),detail=createEchoDetailFixture()
    const document=createEchoDocument({year:2025,cards,loadedDetails:[detail]})
    const safe=createEchoExportDocument(document)
    const text=JSON.stringify(safe.scenes[2].details)
    expect(text).toContain('本人回复 P50')
    expect(text).toContain('2 / 5')
    expect(text).not.toContain(detail.value)
    expect(text).not.toContain(detail.items[0].text)
    const full=JSON.stringify(createEchoExportDocument(document,{privacy:false,includeMessages:true}))
    expect(full).toContain('回复间隔')
    expect(full).toContain(detail.items[0].text)
    expect(full).not.toContain(detail.items[0].source.table)
  })
  it('retains expanded night records and marks their partial pagination honestly',()=>{
    const cards=createEchoCardFixture(),detail={...createEchoDetailFixture(),kind:'night'}
    const doc=createEchoDocument({year:2025,cards,loadedDetails:[detail]})
    const text=JSON.stringify(doc.scenes[4].details)
    expect(text).toContain('深夜往来')
    expect(text).toContain('2 / 5')
    expect(text).toContain(detail.items[0].text)
  })
  it('identifies the owner of exported contact and emoji details without serializing their source keys',()=>{
    const cards=createEchoCardFixture(),contact=createEchoDetailFixture()
    const emoji={...contact,kind:'emoji',value:'text:🌙',summary:{sent:5,received:0,messageCount:5,conversationCount:1,occurrenceCount:8},replyPairs:[]}
    const raw=createEchoDocument({year:2025,cards,loadedDetails:[contact,emoji]})
    const anonymous=JSON.stringify(createEchoExportDocument(raw))
    expect(anonymous).toContain('联系人 1')
    expect(anonymous).toContain('表情 1')
    const full=createEchoExportDocument(raw,{privacy:false,includeMessages:true})
    expect(JSON.stringify(full.scenes[2].details)).toContain(cards[3].data.topTotals[0].displayName)
    expect(JSON.stringify(full.scenes[6].details)).toContain('🌙')
    expect(JSON.stringify(full)).not.toContain(contact.value)
    expect(JSON.stringify(full)).not.toContain('text:🌙')
  })
})
