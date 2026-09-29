import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import AgentModelPicker from '../components/chat/AgentModelPicker.vue'

afterEach(() => vi.unstubAllGlobals())
const profiles = [{ id: 'service', name: '服务', model: 'saved', model_metadata: { reasoning_controls: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], toggle: false } } }]
function setup(extra = {}, request = vi.fn(async () => ({}))) {
  vi.stubGlobal('useAiApi', () => ({ request }))
  return mount(AgentModelPicker, { attachTo: document.body, props: { profiles, modelValue: { profile_id: 'service', model_id: 'saved', reasoning_effort: 'high' }, ...extra } })
}
async function openModels(wrapper) { await wrapper.find('[aria-label="切换模型"]').trigger('click') }

it('单一入口显示已保存档位，滑动时预览、释放后提交，恢复默认清除所有覆盖', async () => {
  const wrapper = setup()
  expect(wrapper.find('summary').text()).toBe('saved · 高')
  expect(wrapper.findAll('select')).toHaveLength(0)
  const slider = wrapper.find('input[type=range]')
  expect(slider.attributes('max')).toBe('4')
  expect(slider.element.value).toBe('2')
  slider.element.value = '4'; await slider.trigger('input')
  expect(wrapper.find('.strength-center').text()).toContain('最高')
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  await slider.trigger('change')
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual({ profile_id: 'service', model_id: 'saved', reasoning_effort: 'max' })
  await wrapper.find('[aria-label="恢复模型默认"]').trigger('click')
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual({ profile_id: 'service', model_id: 'saved', reasoning_effort: null })
  wrapper.unmount()
})

it('重新加载手动模型保留已存档位，不编造未知模型的滑杆', async () => {
  const wrapper = setup({ modelValue: { profile_id: 'service', model_id: 'manual-model', reasoning_effort: 'high' } })
  await flushPromises()
  expect(wrapper.find('summary').text()).toBe('manual-model · 高')
  expect(wrapper.find('input[type=range]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="恢复模型默认"]').attributes('disabled')).toBeUndefined()
  wrapper.unmount()
})

it('中心进入同一浮层的模型列表；新模型清除旧强度，返回滑杆并按新能力显示', async () => {
  const request = vi.fn(async url => url.endsWith('/models') ? { model_details: [{ id: 'saved' }, { id: 'other' }] } : url.includes('other') ? { metadata: { reasoning_controls: { efforts: ['low', 'high'], toggle: false } } } : {})
  const wrapper = setup({}, request)
  wrapper.find('details').element.open = true
  await openModels(wrapper)
  expect(wrapper.find('.strength-slider').exists()).toBe(false)
  await wrapper.find('section header button').trigger('click'); await flushPromises()
  await wrapper.find('[aria-label="返回思考强度"]').trigger('click')
  expect(wrapper.find('input[type=range]').attributes('max')).toBe('4')
  await openModels(wrapper)
  await wrapper.findAll('.model-row').find(row => row.text() === 'other').trigger('click')
  const choice = wrapper.emitted('update:modelValue').at(-1)[0]
  expect(choice).toEqual({ profile_id: 'service', model_id: 'other', reasoning_effort: null })
  await wrapper.setProps({ modelValue: choice }); await flushPromises()
  expect(wrapper.find('details').element.open).toBe(true)
  expect(wrapper.find('.model-list').exists()).toBe(false)
  expect(wrapper.find('input[type=range]').attributes('max')).toBe('1')
  expect(wrapper.find('summary').text()).toBe('other · 默认')
  wrapper.unmount()
})

it('较慢的旧模型能力响应不能覆盖新模型，配置修改后重新读取能力', async () => {
  let resolveOld
  const request = vi.fn(url => url.includes('model_id=saved') ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve({ metadata: { reasoning_controls: { efforts: ['low', 'high'] } } }))
  const wrapper = setup({}, request)
  await wrapper.setProps({ modelValue: { profile_id: 'service', model_id: 'other' } }); await flushPromises()
  resolveOld({ metadata: { reasoning_controls: { efforts: ['low', 'high', 'max'] } } }); await flushPromises()
  expect(wrapper.find('input[type=range]').attributes('max')).toBe('1')
  await wrapper.setProps({ profiles: [{ ...profiles[0], revision: 2 }] }); await flushPromises()
  expect(request).toHaveBeenCalledTimes(3)
  wrapper.unmount()
})

it('开关与思考预算使用声明范围，不发送虚构的高低档位', async () => {
  const wrapper = setup({ profiles: [{ ...profiles[0], model_metadata: { reasoning_controls: { efforts: [], toggle: true, budget: { min: 1024, max: 4095 } } } }], modelValue: { profile_id: 'service', model_id: 'saved' } })
  const slider = wrapper.find('[aria-label="思考预算"]')
  expect(slider.attributes('min')).toBe('1023')
  expect(slider.attributes('max')).toBe('4095')
  await slider.setValue(2048)
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual({ profile_id: 'service', model_id: 'saved', reasoning_effort: null, thinking_budget: 2048 })
  await slider.setValue(1023)
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toEqual({ profile_id: 'service', model_id: 'saved', reasoning_effort: null, thinking_mode: 'disabled' })
  wrapper.unmount()
})

it('只有开关时只显示两档；能力加载失败仍能选模型及重试', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ metadata: { reasoning_controls: { efforts: [], toggle: true } } })
  const wrapper = setup({ profiles: [{ ...profiles[0], model_metadata: {} }] }, request)
  await flushPromises()
  expect(wrapper.text()).toContain('模型能力暂时未更新')
  await wrapper.find('.strength-note button').trigger('click'); await flushPromises()
  const slider = wrapper.find('input[type=range]')
  expect(slider.attributes('max')).toBe('1')
  await slider.setValue(1)
  expect(wrapper.emitted('update:modelValue').at(-1)[0]).toMatchObject({ reasoning_effort: null, thinking_mode: 'enabled' })
  wrapper.unmount()
})

it('获取上游列表补齐未知能力后，清除旧空缓存并立即显示新档位', async () => {
  let fetched = false
  const request = vi.fn(async url => {
    if (url.endsWith('/models')) { fetched = true; return { models: ['saved'] } }
    return { metadata: fetched ? { reasoning_controls: { efforts: ['low', 'high'] } } : {} }
  })
  const wrapper = setup({ profiles: [{ ...profiles[0], model_metadata: {} }] }, request)
  await flushPromises()
  expect(wrapper.find('input[type=range]').exists()).toBe(false)
  await openModels(wrapper)
  await wrapper.find('section header button').trigger('click'); await flushPromises()
  await wrapper.find('[aria-label="返回思考强度"]').trigger('click')
  expect(wrapper.find('input[type=range]').attributes('max')).toBe('1')
  wrapper.unmount()
})

it('默认状态可以直接选首档，Home 与 End 提交真实边界', async () => {
  const wrapper = setup({ modelValue: { profile_id: 'service', model_id: 'saved' } })
  const slider = wrapper.find('input[type=range]')
  await slider.trigger('click')
  expect(wrapper.emitted('update:modelValue').at(-1)[0].reasoning_effort).toBe('low')
  await slider.trigger('keydown', { key: 'End' })
  expect(wrapper.emitted('update:modelValue').at(-1)[0].reasoning_effort).toBe('max')
  wrapper.unmount()
})

it('点击菜单外关闭，内部手动输入保持打开，不改变模型配置', async () => {
  const wrapper = setup()
  const menu = wrapper.find('details').element
  menu.open = true
  await openModels(wrapper); await wrapper.find('.manual-toggle').trigger('click')
  await wrapper.find('[aria-label="手动模型 ID"]').trigger('pointerdown')
  expect(menu.open).toBe(true)
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(menu.open).toBe(false)
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  wrapper.unmount()
})

it('Esc 关闭菜单而不传给 AI 父视图；内部焦点返回入口，外部焦点不被抢走', async () => {
  const wrapper = setup()
  const menu = wrapper.find('details').element
  const outside = document.createElement('button'), parentEscape = vi.fn()
  outside.addEventListener('keydown', parentEscape); document.body.append(outside)
  outside.focus(); menu.open = true
  outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(menu.open).toBe(false)
  expect(document.activeElement).toBe(outside)
  expect(parentEscape).not.toHaveBeenCalled()
  menu.open = true
  wrapper.find('[aria-label="切换模型"]').element.focus()
  await wrapper.find('[aria-label="切换模型"]').trigger('keydown', { key: 'Escape' })
  expect(document.activeElement).toBe(wrapper.find('summary').element)
  wrapper.unmount()
  outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(parentEscape).toHaveBeenCalledOnce()
  outside.remove()
})
