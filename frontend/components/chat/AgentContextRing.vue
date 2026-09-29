<script setup>
import { computed, onBeforeUnmount, onMounted, provide, ref, useId } from 'vue'
import ContextIcon from '../ai-elements/context/ContextIcon.vue'
import { ContextKey } from '../ai-elements/context/context'
const props = defineProps({ budget: Object })
const known = computed(() => props.budget?.percent != null)
const trigger = ref(null), hovered = ref(false), focused = ref(false), dismissed = ref(false)
const tooltipId = useId(), tooltipStyle = ref({})
const open = computed(() => (hovered.value || focused.value) && !dismissed.value)
// 与预算原始数值保持同一口径，只压缩显示位数，不冒充精确 Token 计数。
const formatAmount = value => {
  if (value == null || !Number.isFinite(Number(value))) return '未知'
  const amount = Number(value)
  if (amount < 1000) return String(amount)
  return `${Number((amount / 1000).toFixed(amount < 10000 ? 1 : 0))}k`
}
const usageLabel = computed(() => known.value ? `约 ${props.budget.window_percent ?? props.budget.percent}% 已用` : '容量未知')
const remaining = computed(() => {
  const { input_capacity, used } = props.budget || {}
  if (input_capacity == null || used == null || !Number.isFinite(Number(input_capacity)) || !Number.isFinite(Number(used))) return null
  return Math.max(0, Number(input_capacity) - Number(used))
})
const amountLabel = computed(() => props.budget
  ? `已用约 ${formatAmount(props.budget.used)} / 剩余可用 ${formatAmount(remaining.value)}`
  : '开始提问后显示用量')
const windowLabel = computed(() => props.budget?.model_window ? `模型窗口 ${formatAmount(props.budget.model_window)}` : '')
const label = computed(() => `上下文窗口（估算值），${usageLabel.value}，${amountLabel.value}，${windowLabel.value}`)
// 默认对准圆环；接近输入框或视口边缘时只平移浮层，箭头继续指向圆环。
const positionTooltip = () => {
  const element = trigger.value
  if (!element) return
  const ring = element.getBoundingClientRect()
  const container = (element.closest('.agent-input-box') || element.parentElement).getBoundingClientRect()
  const minLeft = Math.max(8, container.left + 8)
  const maxRight = Math.min(window.innerWidth - 8, container.right - 8)
  const width = Math.min(196, Math.max(0, maxRight - minLeft))
  const center = ring.left + ring.width / 2
  const left = Math.max(minLeft, Math.min(center - width / 2, maxRight - width))
  tooltipStyle.value = { width: `${width}px`, left: `${left - ring.left}px`, '--agent-tooltip-arrow': `${center - left}px` }
}
const showTooltip = source => {
  if (source === 'pointer') hovered.value = true
  else focused.value = true
  dismissed.value = false
  positionTooltip()
}
const closeOnEscape = event => {
  if (event.key !== 'Escape' || !open.value) return
  dismissed.value = true
  // 鼠标悬停时焦点可能仍在输入框；优先关闭提示，不折叠助手。
  event.preventDefault()
  event.stopPropagation()
}
let resizeObserver
onMounted(() => {
  resizeObserver = new ResizeObserver(positionTooltip)
  resizeObserver.observe(trigger.value.closest('.agent-input-box') || trigger.value.parentElement)
  window.addEventListener('resize', positionTooltip)
  document.addEventListener('keydown', closeOnEscape, true)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', positionTooltip)
  document.removeEventListener('keydown', closeOnEscape, true)
})
provide(ContextKey, {
  usedTokens: computed(() => props.budget?.used || 0),
  maxTokens: computed(() => known.value ? (props.budget.window_percent != null ? props.budget.model_window : props.budget.input_capacity) : 0),
  usage: computed(() => undefined), modelId: computed(() => props.budget?.model_id),
})
</script>
<template>
  <span ref="trigger" class="agent-context-ring" tabindex="0" :aria-label="label"
    :aria-describedby="open ? tooltipId : undefined"
    @mouseenter="showTooltip('pointer')" @mouseleave="hovered = false"
    @focus="showTooltip('focus')" @blur="focused = false">
    <ContextIcon aria-hidden="true" />
    <span v-show="open" :id="tooltipId" class="agent-budget-tooltip" role="tooltip" :style="tooltipStyle">
      <span class="agent-budget-heading">上下文窗口 <span class="agent-budget-estimate">估算值</span></span>
      <span class="agent-budget-usage">{{ usageLabel }}</span>
      <span class="agent-budget-amount">{{ amountLabel }}</span>
      <span v-if="windowLabel" class="agent-budget-usage">{{ windowLabel }}</span>
    </span>
  </span>
</template>
