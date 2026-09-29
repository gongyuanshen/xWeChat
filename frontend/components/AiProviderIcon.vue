<template>
  <span class="ais-provider-icon" :data-provider="provider" aria-hidden="true">
    <img v-if="colorLogo" :src="colorLogo" alt="" class="ais-provider-mark ais-provider-color" :class="{ 'ais-provider-avatar': isAppIcon }" />
    <span v-else-if="logo" class="ais-provider-mark ais-provider-monochrome" :style="logoStyle"></span>
    <component v-else :is="provider === 'custom' ? SlidersHorizontal : Plug" :size="16" :stroke-width="1.8" />
  </span>
</template>

<script setup>
import { computed } from 'vue'
import { Plug, SlidersHorizontal } from '@lucide/vue'

const props = defineProps({ provider: { type: String, required: true } })
// 彩色资源保留原始配色；仅单色品牌使用遮罩，与圆底一起适配深浅主题。
const logos = import.meta.glob('../assets/icons/ai-providers/*.{svg,png}', { eager: true, query: '?url', import: 'default' })
const slug = computed(() => ({ anthropic: 'claude', siliconflow: 'siliconcloud' }[props.provider] || props.provider))
const isAppIcon = computed(() => ['doubao', 'lmstudio'].includes(slug.value))
const colorLogo = computed(() => logos[`../assets/icons/ai-providers/${slug.value}${isAppIcon.value ? '.png' : '-color.svg'}`])
const logo = computed(() => logos[`../assets/icons/ai-providers/${slug.value}.svg`])
const logoStyle = computed(() => ({ maskImage: `url("${logo.value}")`, WebkitMaskImage: `url("${logo.value}")` }))
</script>
