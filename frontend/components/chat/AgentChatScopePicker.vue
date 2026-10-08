<template>
  <div ref="anchor" class="agent-chat-scope" @keydown.esc.stop="close(true)">
    <button ref="trigger" type="button" class="agent-chat-scope-trigger" aria-label="选择聊天范围" :aria-expanded="open" :aria-controls="id" :disabled="disabled || !account" :title="disabled ? '停止处理后可更改聊天范围' : '选择本次对话可查阅的聊天'" @click="toggle">
      <AtSign :size="16" :stroke-width="1.8" aria-hidden="true" /><span>{{ label }}</span>
    </button>
    <section v-if="open" :id="id" class="agent-chat-scope-popover" aria-label="聊天范围">
      <header><strong>选择聊天范围</strong><button type="button" aria-label="关闭范围选择" @click="close(true)"><X :size="16" :stroke-width="1.8" aria-hidden="true" /></button></header>
      <label class="agent-chat-scope-search"><Search :size="16" :stroke-width="1.8" aria-hidden="true" /><input ref="search" v-model="query" aria-label="搜索聊天范围" placeholder="搜索联系人或群聊" /></label>
      <label class="agent-chat-scope-all"><input type="checkbox" aria-label="所有聊天" :checked="allChecked" :indeterminate="!allChecked && selected.length > 0" @change="selectAll($event.target.checked)" />所有聊天<small>查阅当前账号的全部聊天</small></label>
      <p v-if="loading" role="status">正在加载聊天列表…</p>
      <p v-else-if="error" class="agent-error" role="alert">{{ error }} <button type="button" aria-label="重新加载聊天列表" @click="load">重试</button></p>
      <div v-else class="agent-chat-scope-options">
        <label v-for="item in filtered" :key="item.username"><input type="checkbox" :value="item.username" :checked="all || selected.includes(item.username)" @change="selectChat(item.username, $event.target.checked)" /><span>{{ item.name || item.username }}</span><small>{{ item.username.endsWith('@chatroom') ? '群聊' : '联系人' }}</small></label>
        <p v-if="!filtered.length">{{ query ? '没有找到匹配的聊天' : '当前账号还没有聊天' }}</p>
      </div>
      <footer><small>{{ all ? '所有聊天' : `已选择 ${selected.length} 个聊天` }}</small><button type="button" aria-label="应用聊天范围" :disabled="loading || !!error || (!all && !selected.length)" @click="apply">应用范围</button></footer>
    </section>
  </div>
</template>
<script setup>
import { computed, getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { AtSign, Search, X } from '@lucide/vue'
const props = defineProps({ account: String, modelValue: { type: Array, default: null }, disabled: Boolean })
const emit = defineEmits(['update:modelValue', 'loaded'])
const api = useAiApi()
const anchor = ref(null), trigger = ref(null), search = ref(null), open = ref(false)
const query = ref(''), all = ref(true), selected = ref([]), items = ref([]), loading = ref(false), error = ref('')
const id = `agent-chat-scope-${getCurrentInstance().uid}`
let revision = 0, disposed = false, loadedAccount = ''
const filtered = computed(() => items.value.filter(item => `${item.name} ${item.username}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const allChecked = computed(() => all.value || (items.value.length > 0 && items.value.every(item => selected.value.includes(item.username))))
const label = computed(() => props.modelValue === null ? '所有聊天' : props.modelValue.length === 1 ? items.value.find(item => item.username === props.modelValue[0])?.name || props.modelValue[0] : `${props.modelValue.length} 个聊天`)
const selectAll = checked => { all.value = checked; selected.value = [] }
const selectChat = (username, checked) => {
  if (all.value) { selected.value = items.value.map(item => item.username); all.value = false }
  selected.value = checked ? [...selected.value, username] : selected.value.filter(item => item !== username)
}
const close = (focus = false) => { open.value = false; if (focus) trigger.value?.focus() }
const load = async () => {
  const account = props.account, current = ++revision
  loading.value = true; error.value = ''
  try {
    const result = await api.request('/conversations', { query: { account } })
    if (!Array.isArray(result) || result.some(item => typeof item.username !== 'string' || !item.username)) throw new Error('聊天列表返回格式异常')
    if (!disposed && current === revision && account === props.account) { items.value = result; loadedAccount = account; emit('loaded', result) }
  } catch (e) { if (!disposed && current === revision && account === props.account) error.value = `聊天列表加载失败：${e.message}` }
  finally { if (current === revision) loading.value = false }
}
const toggle = async () => {
  if (props.disabled || !props.account) return
  if (open.value) { close(); return }
  all.value = props.modelValue === null; selected.value = [...(props.modelValue || [])]; query.value = ''; open.value = true
  await nextTick(); search.value?.focus()
  if (loadedAccount !== props.account) void load()
}
const apply = () => { emit('update:modelValue', all.value ? null : [...selected.value]); close(true) }
const outside = event => { if (!anchor.value?.contains(event.target)) close() }
watch(() => props.account, () => { ++revision; loadedAccount = ''; items.value = []; loading.value = false; error.value = ''; close() })
watch(() => props.disabled, value => { if (value) close() })
watch([() => props.account, () => props.modelValue], ([account, scope]) => { if (account && scope?.length && loadedAccount !== account && !loading.value) void load() }, { immediate: true })
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => { disposed = true; ++revision; document.removeEventListener('pointerdown', outside) })
</script>
