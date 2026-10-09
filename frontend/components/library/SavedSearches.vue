<template>
  <details class="mx-3 my-2 rounded border border-[var(--app-border)] p-2 text-xs">
    <summary class="cursor-pointer">保存的搜索</summary>
    <p class="my-2 text-[var(--app-text-secondary)]">保存关键词、消息类型和筛选条件；默认固定保存时的起止时间。</p>
    <label v-if="Number(rangeDays) > 0" class="mb-2 flex items-center gap-2">
      <input v-model="relative" type="checkbox" />每次重查最近 {{ rangeDays }} 天
    </label>
    <form class="flex gap-1" @submit.prevent="save">
      <input v-model="name" :class="{ 'privacy-blur': privacyMode }" aria-label="保存搜索名称" maxlength="120" placeholder="搜索名称" class="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1" />
      <button :disabled="busy || !account || !name.trim()" class="rounded px-2 py-1 disabled:opacity-40">保存当前</button>
    </form>
    <p v-if="error" role="alert" class="mt-2 text-red-500">{{ error }}</p>
    <p v-if="busy" role="status" class="mt-2">处理中…</p>
    <p v-else-if="!entries.length && !error" class="mt-2 text-[var(--app-text-secondary)]">还没有保存搜索。</p>
    <div v-for="entry in entries" :key="entry.id" class="mt-2 flex flex-wrap items-center gap-1">
      <template v-if="editing === entry.id">
        <input v-model="rename" :class="{ 'privacy-blur': privacyMode }" aria-label="新搜索名称" class="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-[var(--app-surface)] px-2 py-1" @keydown.enter.prevent="renameEntry(entry)" @keydown.esc="editing = ''" />
        <button :disabled="busy || !rename.trim()" @click="renameEntry(entry)">确定</button><button @click="editing = ''">取消</button>
      </template>
      <template v-else>
        <button :disabled="busy" class="min-w-0 flex-1 truncate text-left" @click="apply(entry)"><span :class="{ 'privacy-blur': privacyMode }">{{ entry.name }}</span></button>
        <button :disabled="busy" :aria-label="`重命名 ${entry.name}`" @click="editing = entry.id; rename = entry.name">改名</button>
        <button :disabled="busy" :aria-label="`删除 ${entry.name}`" @click="remove(entry)">删除</button>
      </template>
    </div>
    <button v-if="error" :disabled="busy" class="mt-2" @click="load">重新加载</button>
  </details>
</template>
<script setup>
import { ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePrivacyStore } from '~/stores/privacy'
import { useLibraryApi } from '~/composables/useLibraryApi'
const props = defineProps({account:{type:String,required:true},rangeDays:{type:String,default:''},getCriteria:{type:Function,required:true},applyCriteria:{type:Function,required:true}})
const api = useLibraryApi()
const { privacyMode } = storeToRefs(usePrivacyStore())
const entries = ref([]), name = ref(''), error = ref(''), busy = ref(false), editing = ref(''), rename = ref('')
const relative = ref(false)
let version = 0
const execute = async action => {
  const account = props.account, request = ++version
  busy.value = true; error.value = ''
  const current = () => request === version && account === props.account
  try { await action(account, current) }
  catch (err) { if (current()) error.value = err?.data?.detail || err.message }
  finally { if (current()) busy.value = false }
}
const load = () => execute(async (account,current) => {
  const result = await api.listSearches(account)
  if (current()) entries.value = result
})
const save = () => execute(async (account,current) => {
  const criteria = props.getCriteria({relative:relative.value})
  if (!criteria.query && criteria.retrieval_mode === 'hybrid') throw new Error('智能搜索需要关键词')
  if (!criteria.query && !criteria.render_types) throw new Error('请先输入关键词或选择消息类型')
  const result = await api.createSearch(account,{name:name.value.trim(),criteria})
  if (current()) {entries.value = [...entries.value,result];name.value = ''}
})
const apply = entry => execute(async (_account,current) => { if(current()) await props.applyCriteria(entry.criteria) })
const renameEntry = entry => execute(async (account,current) => {
  const result = await api.updateSearch(account,entry.id,{name:rename.value.trim()})
  if(current()) {entries.value = entries.value.map(item => item.id === entry.id ? result : item);editing.value = ''}
})
const remove = entry => execute(async (account,current) => {
  await api.deleteSearch(account,entry.id)
  if(current()) entries.value = entries.value.filter(item => item.id !== entry.id)
})
watch(() => props.account, account => {
  ++version;entries.value = [];error.value = '';busy.value = false;editing.value = '';name.value = '';relative.value = false
  if(account) void load()
},{immediate:true})
</script>
