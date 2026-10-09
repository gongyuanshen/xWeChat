import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ChatOverlays from '../components/chat/ChatOverlays.vue'
let wrapper
const open = message => {
  vi.spyOn(console,'warn').mockImplementation(()=>{})
  const state={selectedAccount:ref('owner'),selectedContact:ref({username:'room'}),contextMenu:ref({visible:true,message,x:0,y:0}),closeContextMenu:vi.fn(),previewImageUrl:ref(''),chatHistoryModalOpen:false,timeSidebarOpen:false,messageSearchOpen:false,previewImageOpen:false,previewVideoOpen:false,contactProfileCardOpen:false,groupAnnouncementOpen:false,exportModalOpen:false}
  wrapper=mount(ChatOverlays,{props:{state},global:{stubs:{LibrarySaveDialog:{name:'LibrarySaveDialog',props:['open','account','item'],template:'<div />'},ChatHistoryFloatingWindows:true,ChatExportDialog:true}}})
  return state
}
afterEach(()=>{wrapper?.unmount();vi.restoreAllMocks()})
it.each(['text','file'])('context menu saves canonical %s row source and account',async renderType=>{
  const state=open({id:'message_0:Msg_room:5',renderType,content:'显示文本',senderUsername:'alice',createTime:55})
  await wrapper.findAll('button').find(button=>button.text()==='保存原文到资料夹').trigger('click')
  const dialog=wrapper.findComponent({name:'LibrarySaveDialog'})
  expect(dialog.props('account')).toBe('owner')
  expect(dialog.props('item')).toEqual({kind:'message',source:{username:'room',anchor:'message_0:Msg_room:5'}})
  expect(state.closeContextMenu).toHaveBeenCalledOnce()
})
it.each(['file', 'image', 'video'])('context menu saves the %s attachment by authoritative source', async renderType => {
  open({ id: 'message_0:Msg_room:5', renderType, fileMd5: 'untrusted-client-value' })
  await wrapper.findAll('button').find(button => button.text() === '保存附件副本到资料夹').trigger('click')
  expect(wrapper.findComponent({ name: 'LibrarySaveDialog' }).props('item')).toEqual({ kind: 'attachment', source: { username: 'room', anchor: 'message_0:Msg_room:5' } })
})
it('text messages do not offer an attachment copy', () => {
  open({ id: 'message_0:Msg_room:5', renderType: 'text' })
  expect(wrapper.text()).not.toContain('保存附件副本到资料夹')
})
