import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import EchoExperience from '../components/wrapped/echo/EchoExperience.vue'
import { createEchoCardFixture, FIXTURE_PRIVATE } from './fixtures/wrapped-echo-cards'
import { periodDayCount, scheduleHours } from '../lib/wrapped-echo-model'

vi.mock('../components/wrapped/echo/EchoWorld.vue',()=>({default:defineComponent({name:'EchoWorld',props:['data','scene','selection','privacy'],emits:['pick','error'],setup(_,context){context.expose({prepareCapture:async()=>document.createElement('canvas'),getState:()=>({rendered:true})});return()=>null}})}))
describe('production echo experience',()=>{
  let wrapper
  afterEach(()=>{wrapper?.unmount();document.body.innerHTML=''})
  function create(scene=0,privacy=false,cards=createEchoCardFixture()){
    wrapper=mount(EchoExperience,{props:{scene,year:2025,cards,privacy,motion:false},attachTo:document.body})
    return wrapper
  }
  it('keeps all ten chapters reachable and no private labels or images in anonymous DOM',async()=>{
    create(0,true)
    for(let scene=0;scene<10;scene++){
      await wrapper.setProps({scene})
      expect(wrapper.findAll('.echo-dots button')).toHaveLength(10)
      for(const secret of [...FIXTURE_PRIVATE.names,...FIXTURE_PRIVATE.phrases,FIXTURE_PRIVATE.account,FIXTURE_PRIVATE.username])expect(wrapper.html()).not.toContain(secret)
      expect(wrapper.findAll('img')).toHaveLength(0)
      expect(wrapper.find('h1').exists()).toBe(true)
    }
  })
  it('identity-only contacts show no fabricated statistics and request their own source',async()=>{
    create(2)
    await wrapper.find('select').setValue('3')
    expect(wrapper.find('.echo-facts').text()).not.toContain('0')
    await wrapper.find('.echo-primary').trigger('click')
    expect(wrapper.emitted('detail')[0][0]).toEqual({kind:'contact',value:`${FIXTURE_PRIVATE.username}-3`,period:'all'})
  })
  it('uses weekday-only counts and actual calendar denominator for daily averages',async()=>{
    create(4)
    await wrapper.findAll('.echo-tabs button')[1].trigger('click')
    await wrapper.find('input[type=range]').setValue('12')
    await wrapper.find('input[type=checkbox]').setValue(true)
    const n=scheduleHours(createEchoCardFixture()[1].data.matrix,'weekday')[12]/periodDayCount(2025,'weekday')
    expect(wrapper.find('.echo-number').text()).toContain(new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n))
    await wrapper.find('.echo-primary').trigger('click')
    expect(wrapper.emitted('detail')[0][0]).toEqual({kind:'hour',value:12,period:'weekday'})
  })
  it('opens real calendar days and retains the source date across the modal boundary',async()=>{
    create(1)
    await wrapper.find('.echo-secondary').trigger('click');await flushPromises()
    const dialog=document.querySelector('dialog')
    expect(dialog.open).toBe(true)
    const day=dialog.querySelector('.echo-calendar-grid button')
    expect(day.getAttribute('aria-label')).toMatch(/^2025-07-01/)
    day.click();await flushPromises()
    expect(wrapper.emitted('detail')[0][0]).toEqual({kind:'day',value:'2025-07-01',period:'all'})
    expect(document.querySelector('dialog')).toBeNull()
  })
  it('does not replace unavailable chapters with zero stats and exposes an explicit retry',async()=>{
    const cards=createEchoCardFixture();cards[3]={...cards[3],status:'error',data:null,error:'fixture read failure'}
    create(2,false,cards)
    expect(wrapper.text()).toContain('fixture read failure')
    expect(wrapper.find('.echo-facts').exists()).toBe(false)
    await wrapper.find('.echo-primary').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
    await expect(wrapper.vm.prepareCapture()).rejects.toThrow('本章统计尚未就绪')
  })
  it('maps a second window of 3D contact picks back to the actual contact and handles metric picks',async()=>{
    const cards=createEchoCardFixture();cards[3].data.allContacts.push({username:'fifth',displayName:'第五位'})
    create(2,false,cards);await wrapper.find('select').setValue('3')
    const world=wrapper.findComponent({name:'EchoWorld'})
    expect(world.props('data').contacts).toHaveLength(2)
    world.vm.$emit('pick','contact',1);await flushPromises()
    await wrapper.find('.echo-primary').trigger('click')
    expect(wrapper.emitted('detail')[0][0].value).toBe('fifth')
    await wrapper.setProps({scene:7});world.vm.$emit('pick','metric','call');await flushPromises()
    expect(wrapper.findAll('.echo-tabs button')[2].attributes('aria-pressed')).toBe('true')
  })
  it('locks arrow-key navigation while editing a range and restores the selected scene controls for capture',async()=>{
    create(4)
    await wrapper.find('input[type=range]').trigger('keydown',{key:'ArrowRight'})
    expect(wrapper.emitted('scene')).toBeUndefined()
    await wrapper.trigger('keydown',{key:'ArrowRight'})
    expect(wrapper.emitted('scene')[0]).toEqual([5])
    const saved=wrapper.vm.getSelection();wrapper.vm.setSelection({...saved,hour:3});expect(wrapper.vm.getSelection().hour).toBe(3)
    await wrapper.setProps({exportMode:true})
    expect(wrapper.find('nav').exists()).toBe(false)
  })
  it('revisits the selected chapter from a memory-orbit object',async()=>{
    create(8)
    wrapper.findComponent({name:'EchoWorld'}).vm.$emit('pick','chapter',4)
    await flushPromises()
    expect(wrapper.emitted('scene')?.[0]).toEqual([4])
  })
  it('filters phrases by measured monthly counts and passes that month to the source query',async()=>{
    const cards=createEchoCardFixture()
    cards[6].data.keywords.forEach((phrase,i)=>{phrase.monthlyCounts=Array(12).fill(0);phrase.monthlyCounts[1]=i===0?0:4-i;phrase.monthlyCounts[0]=phrase.count-phrase.monthlyCounts[1]})
    create(5,false,cards)
    const filter=wrapper.find('select[aria-label="短句月份"]')
    expect(filter.exists()).toBe(true)
    await filter.setValue('2')
    expect(wrapper.find('.echo-person').text()).toContain(FIXTURE_PRIVATE.phrases[1])
    expect(wrapper.find('.echo-caption').text()).toContain('3 次')
    await wrapper.find('.echo-primary').trigger('click')
    expect(wrapper.emitted('detail')[0][0]).toEqual({kind:'phrase',value:FIXTURE_PRIVATE.phrases[1],period:'all',month:2})
  })
  it('projects failed data and renderer errors without private strings after anonymity changes',async()=>{
    const cards=createEchoCardFixture();cards[3]={...cards[3],status:'error',data:null,error:`失败 ${FIXTURE_PRIVATE.username}`}
    create(2,false,cards)
    expect(wrapper.text()).toContain(FIXTURE_PRIVATE.username)
    await wrapper.setProps({privacy:true})
    expect(wrapper.html()).not.toContain(FIXTURE_PRIVATE.username)
    wrapper.findComponent({name:'EchoWorld'}).vm.$emit('error',new Error(`图片失败 ${FIXTURE_PRIVATE.names[0]}`));await flushPromises()
    expect(wrapper.html()).not.toContain(FIXTURE_PRIVATE.names[0])
    expect(wrapper.text()).toContain('场景读取失败')
  })
  it('restores the selected phrase by content after statistics are reordered',async()=>{
    const cards=createEchoCardFixture();create(5,false,cards)
    const snapshot=wrapper.vm.getSelection(),selected=FIXTURE_PRIVATE.phrases[0]
    const next=createEchoCardFixture();next[6].data.keywords[0].count=1
    await wrapper.setProps({cards:next});wrapper.vm.setSelection(snapshot);await flushPromises()
    expect(wrapper.find('.echo-person').text()).toContain(selected)
    await wrapper.find('.echo-primary').trigger('click')
    expect(wrapper.emitted('detail')[0][0].value).toBe(selected)
  })
  it('shows an explicit missing selection instead of an empty statistic when a saved object disappears',async()=>{
    create(5)
    await wrapper.findAll('select').at(-1).setValue('2')
    const snapshot=wrapper.vm.getSelection(),next=createEchoCardFixture()
    next[6].data.keywords=next[6].data.keywords.slice(0,1)
    await wrapper.setProps({cards:next});wrapper.vm.setSelection(snapshot);await flushPromises()
    expect(wrapper.text()).toContain('此前选中的短句已不在当前范围，请重新选择')
    expect(wrapper.text()).not.toContain('没有找到反复发送的完整短句')
    expect(wrapper.findAll('select').at(-1).findAll('option').some(option=>option.text()===FIXTURE_PRIVATE.phrases[0])).toBe(true)
  })
  it('keeps pending stable targets when another switch happens before the card arrives',async()=>{
    create(5);await wrapper.findAll('select').at(-1).setValue('2')
    const original=wrapper.vm.getSelection(),loading=createEchoCardFixture()
    loading[6]={...loading[6],status:'loading',data:null}
    await wrapper.setProps({scene:0,cards:loading});wrapper.vm.setSelection(original)
    const pending=wrapper.vm.getSelection()
    expect(pending.targets.phrase).toBe(FIXTURE_PRIVATE.phrases[2])
    const next=createEchoCardFixture();next[6].data.keywords[2].count=500
    await wrapper.setProps({scene:5,cards:next});wrapper.vm.setSelection(pending);await flushPromises()
    expect(wrapper.find('.echo-person').text()).toContain(FIXTURE_PRIVATE.phrases[2])
  })
})
