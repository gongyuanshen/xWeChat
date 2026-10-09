import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import SavedSearches from '../components/library/SavedSearches.vue'
const api = vi.hoisted(() => ({listSearches:vi.fn(),createSearch:vi.fn(),updateSearch:vi.fn(),deleteSearch:vi.fn()}))
const state = vi.hoisted(() => ({privacy:null}))
vi.mock('~/composables/useLibraryApi',()=>({useLibraryApi:()=>api}))
vi.mock('~/stores/privacy',()=>({usePrivacyStore:()=>({privacyMode:state.privacy})}))
vi.mock('pinia',()=>({storeToRefs:store=>store}))
let wrapper
beforeEach(()=>{vi.clearAllMocks();state.privacy=ref(false);api.listSearches.mockResolvedValue([])})
afterEach(()=>wrapper?.unmount())
const open = async () => {wrapper = mount(SavedSearches,{props:{account:'a',getCriteria:()=>({query:'项目',scope:'global'}),applyCriteria:vi.fn()}});await flushPromises()}
it('shows storage errors without adding a fabricated saved search',async()=>{
  await open();api.createSearch.mockRejectedValue(new Error('磁盘写入失败'))
  await wrapper.find('input').setValue('项目记录');await wrapper.find('form').trigger('submit');await flushPromises()
  expect(wrapper.find('[role=alert]').text()).toBe('磁盘写入失败')
  expect(wrapper.text()).not.toContain('项目记录改名')
})
it('discards list responses from the previous account',async()=>{
  let finish
  api.listSearches.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValueOnce([{id:'b1',name:'账号乙',criteria:{query:'乙'}}])
  wrapper=mount(SavedSearches,{props:{account:'a',getCriteria:vi.fn(),applyCriteria:vi.fn()}})
  await wrapper.setProps({account:'b'});await flushPromises();finish([{id:'a1',name:'账号甲',criteria:{query:'甲'}}]);await flushPromises()
  expect(wrapper.text()).toContain('账号乙');expect(wrapper.text()).not.toContain('账号甲')
})
it('applies stored complete criteria',async()=>{
  const criteria={scope:'global',query:'项目',retrieval_mode:'hybrid',sender:'alice',session_type:'group',render_types:'text',start_time:123,end_time:456}
  api.listSearches.mockResolvedValue([{id:'one',name:'已保存',criteria}]);await open()
  await wrapper.findAll('button').find(button=>button.text()==='已保存').trigger('click');await flushPromises()
  expect(wrapper.props('applyCriteria')).toHaveBeenCalledWith(criteria)
})
it('saves a type-only query and forwards the selected rolling-date mode',async()=>{
  const getCriteria=vi.fn().mockReturnValue({query:'',render_types:'file',retrieval_mode:'keyword',relative_days:30})
  wrapper=mount(SavedSearches,{props:{account:'a',rangeDays:'30',getCriteria,applyCriteria:vi.fn()}})
  await flushPromises()
  api.createSearch.mockResolvedValue({id:'files',name:'近月文件',criteria:getCriteria()})
  await wrapper.find('input[type=checkbox]').setValue(true)
  await wrapper.find('input[aria-label="保存搜索名称"]').setValue('近月文件')
  await wrapper.find('form').trigger('submit');await flushPromises()
  expect(getCriteria).toHaveBeenLastCalledWith({relative:true})
  expect(api.createSearch).toHaveBeenCalledWith('a',expect.objectContaining({name:'近月文件',criteria:expect.objectContaining({render_types:'file',relative_days:30})}))
})

it('privacy mode covers saved names and rename fields while preserving search actions',async()=>{
  api.listSearches.mockResolvedValue([{id:'one',name:'私人搜索',criteria:{scope:'global',query:'项目'}}]);await open()
  const entry=wrapper.findAll('button').find(button=>button.text()==='私人搜索')
  expect(entry.element.closest('.privacy-blur')).toBeNull()
  state.privacy.value=true;await flushPromises()
  expect((entry.element.querySelector('span')||entry.element).closest('.privacy-blur')).not.toBeNull()
  expect(wrapper.find('input[aria-label="保存搜索名称"]').element.closest('.privacy-blur')).not.toBeNull()
  expect(entry.element.closest('.privacy-blur')).toBeNull()
  await entry.trigger('click');await flushPromises()
  expect(wrapper.props('applyCriteria')).toHaveBeenCalledWith({scope:'global',query:'项目'})
  await wrapper.findAll('button').find(button=>button.text()==='改名').trigger('click')
  const rename=wrapper.find('input[aria-label="新搜索名称"]')
  expect(rename.element.closest('.privacy-blur')).not.toBeNull()
  const confirm=wrapper.findAll('button').find(button=>button.text()==='确定')
  expect(confirm.element.closest('.privacy-blur')).toBeNull();expect(confirm.attributes('disabled')).toBeUndefined()
  state.privacy.value=false;await flushPromises()
  expect(rename.element.closest('.privacy-blur')).toBeNull()
})
