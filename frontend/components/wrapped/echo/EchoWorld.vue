<template>
  <div class="echo-world" :data-failed="Boolean(failure)">
    <canvas ref="canvas" class="echo-world__canvas" aria-hidden="true" />
    <p v-if="failure" class="echo-world__error" role="alert" data-world-block>{{ privacy ? '三维场景失败，请关闭匿名后查看详细原因。' : failure.message }}</p>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { createEchoWorld } from '~/lib/wrapped-echo-world'

const props = defineProps({
  scene: { type: Number, required: true },
  year: { type: Number, required: true },
  data: { type: Object, required: true },
  selection: { type: Object, default: () => ({}) },
  motion: { type: Boolean, default: true },
  exportMode: { type: Boolean, default: false },
  privacy: { type: Boolean, default: false },
})
const emit = defineEmits(['pick', 'ready', 'error'])
const canvas = ref(null)
const failure = shallowRef(null)
let world = null
let revision = 0
let disposed = false

function fail(error) {
  if (disposed || failure.value === error) return
  failure.value = error
  emit('error', error)
}

async function announceReady(token) {
  try {
    await world.prepareCapture()
    if (!disposed && token === revision && !failure.value) emit('ready')
  } catch (error) {
    if (!disposed && token === revision) fail(error)
  }
}

function updateScene() {
  if (!world || disposed) return
  const token = ++revision
  failure.value = null
  try {
    world.setData({ year: props.year, data: props.data, privacy: props.privacy }, props.scene)
    world.setSelection(props.selection)
    void announceReady(token)
  } catch (error) { fail(error) }
}

onMounted(() => {
  try {
    world = createEchoWorld(canvas.value, {
      year: props.year, data: props.data, privacy: props.privacy,
      motion: props.motion, exportMode: props.exportMode,
      onPick: (kind, value) => emit('pick', kind, value), onError: fail,
    })
    world.setScene(props.scene)
    world.setSelection(props.selection)
    void announceReady(++revision)
  } catch (error) { fail(error) }
})

watch(() => [props.scene, props.year, props.data, props.privacy], updateScene, { deep: true })
watch(() => props.selection, value => {
  if (!world) return
  try { world.setSelection(value) } catch (error) { fail(error) }
}, { deep: true })
watch(() => props.motion, value => {
  if (!world) return
  try { world.setMotion(value) } catch (error) { fail(error) }
})
watch(() => props.exportMode, value => {
  if (!world) return
  try { world.setExportMode(value) } catch (error) { fail(error) }
})

onBeforeUnmount(() => {
  disposed = true
  revision++
  world?.dispose()
  world = null
})

defineExpose({
  async prepareCapture() {
    if (failure.value) throw failure.value
    if (!world) throw new Error('三维场景尚未就绪。')
    return world.prepareCapture()
  },
  resetView() { world?.resetView() },
  getState() { return world?.getState() ?? { rendered: false, disposed, error: failure.value?.message || '' } },
})
</script>

<style scoped>
.echo-world { position: absolute; inset: 0; overflow: hidden; background: #080e0b; }
.echo-world__canvas { display: block; width: 100%; height: 100%; touch-action: none; }
.echo-world[data-failed="true"] .echo-world__canvas { visibility: hidden; }
.echo-world__error { position: absolute; inset: 35% 10% auto; margin: 0; color: #ffe1d2; font-size: 1rem; line-height: 1.8; text-align: center; }
</style>
