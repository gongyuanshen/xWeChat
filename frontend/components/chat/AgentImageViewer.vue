<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { referenceUrl } from '~/utils/agentMarkdown'
import { ChevronLeft, ChevronRight, Image, Minus, Plus, X } from '@lucide/vue'
const props = defineProps({ images: { type: Array, default: () => [] }, selected: String, citations: { type: Array, default: () => [] }, apiBase: String, locating: Boolean, locateError: String })
const emit = defineEmits(['close', 'locate'])
const dialog = ref(null), index = ref(0), scale = ref(1), angle = ref(0), x = ref(0), y = ref(0), failed = ref(false)
const current = computed(() => props.images[index.value])
const source = computed(() => props.citations.find(c => c.source === current.value?.source))
const url = computed(() => referenceUrl(current.value?.path, props.apiBase))
const reset = () => { scale.value = 1; angle.value = 0; x.value = 0; y.value = 0 }
const zoom = n => { scale.value = Math.max(.1, Math.min(8, scale.value * n)) }
const move = delta => { index.value = (index.value + delta + props.images.length) % props.images.length }
let trigger, drag
const pointerStart = event => { if (event.button !== 0) return; drag = { id: event.pointerId, x: event.clientX - x.value, y: event.clientY - y.value }; event.currentTarget.setPointerCapture?.(event.pointerId) }
const pointerMove = event => { if (drag?.id === event.pointerId) { x.value = event.clientX - drag.x; y.value = event.clientY - drag.y } }
watch(() => props.selected, id => { index.value = Math.max(0, props.images.findIndex(i => i.id === id)) }, { immediate: true })
watch(current, () => { reset(); failed.value = false })
onMounted(async () => { trigger = document.activeElement; await nextTick(); dialog.value?.showModal?.() })
onBeforeUnmount(() => { dialog.value?.close?.(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }) })
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="agent-image-viewer" aria-label="回答引用的图片" @cancel.prevent="emit('close')" @keydown.esc.stop.prevent="emit('close')" @keydown.left.prevent="move(-1)" @keydown.right.prevent="move(1)">
    <header><div class="agent-image-heading"><Image :size="16" :stroke-width="1.8" aria-hidden="true" /><div><strong>{{ current?.label || '聊天图片' }}</strong><small v-if="source">{{ source.sender }} · {{ source.name || source.username }} · {{ new Date(source.time * 1000).toLocaleString() }}</small></div></div><button type="button" aria-label="关闭图片查看器" @click="emit('close')"><X :size="16" :stroke-width="1.8" aria-hidden="true" /></button></header>
    <div class="agent-image-stage" @dblclick="reset" @wheel.prevent="zoom($event.deltaY > 0 ? .9 : 1.1)" @pointerdown="pointerStart" @pointermove="pointerMove" @pointerup="drag = null" @pointercancel="drag = null">
      <img v-if="url && !failed" :key="current?.id" :src="url" :alt="current?.label || '聊天图片'" draggable="false" :style="{ transform: `translate(${x}px,${y}px) rotate(${angle}deg) scale(${scale})` }" @error="failed = true" />
      <p v-else role="status">图片暂不可用，可定位原消息核对。</p>
      <small class="agent-image-hint">滚轮缩放 · 双击还原 · Esc 关闭</small>
    </div>
    <footer><span>图片 {{ index + 1 }} / {{ images.length }}</span><div class="agent-image-toolbar"><button type="button" :disabled="images.length < 2" aria-label="上一张图片" @click="move(-1)"><ChevronLeft :size="16" :stroke-width="1.8" aria-hidden="true" /></button><button type="button" aria-label="缩小图片" @click="zoom(.8)"><Minus :size="16" :stroke-width="1.8" aria-hidden="true" /></button><button type="button" aria-label="复位图片" @click="reset">适应窗口</button><span>{{ Math.round(scale * 100) }}%</span><button type="button" aria-label="放大图片" @click="zoom(1.25)"><Plus :size="16" :stroke-width="1.8" aria-hidden="true" /></button><button type="button" aria-label="旋转图片" @click="angle += 90">旋转</button><button type="button" :disabled="images.length < 2" aria-label="下一张图片" @click="move(1)"><ChevronRight :size="16" :stroke-width="1.8" aria-hidden="true" /></button></div>
      <button v-if="source" class="agent-image-locate" type="button" :disabled="locating" :aria-busy="locating" @click="emit('locate', source)">{{ locating ? '正在定位…' : locateError ? '重试定位原消息' : '定位原消息' }}</button><p v-if="locateError" role="alert">{{ locateError }}</p>
    </footer>
  </dialog></Teleport>
</template>
