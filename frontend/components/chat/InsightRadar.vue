<script setup>
import { computed } from 'vue'
const props = defineProps({ traits: { type: Object, required: true } })
const axes = [['energy', '活力'], ['humor', '幽默'], ['calm', '平静'], ['initiative', '主动'], ['care', '关怀'], ['closeness', '亲近']]
const point = (index, radius) => { const angle = index * Math.PI / 3 - Math.PI / 2; return [150 + Math.cos(angle) * radius, 150 + Math.sin(angle) * radius] }
const polygon = radius => axes.map((_, i) => point(i, radius).join(',')).join(' ')
const known = computed(() => axes.map(([key], i) => ({ score: props.traits[key].score, point: props.traits[key].score === null ? null : point(i, props.traits[key].score * .88) })))
const complete = computed(() => known.value.every(axis => axis.point !== null))
const area = computed(() => known.value.map(axis => axis.point?.join(',')).join(' '))
</script>
<template>
  <figure class="insight-radar">
    <svg viewBox="0 0 300 280" role="img" aria-label="聊天特征六维雷达，0至100，空缺表示证据不足">
      <polygon v-for="radius in [22, 44, 66, 88]" :key="radius" :points="polygon(radius)" class="grid" />
      <line v-for="(_, i) in axes" :key="i" x1="150" y1="150" :x2="point(i, 88)[0]" :y2="point(i, 88)[1]" class="grid" />
      <polygon v-if="complete" :points="area" class="area" data-radar-area />
      <template v-for="(axis, i) in known" :key="axes[i][0]">
        <circle v-if="axis.point" :cx="axis.point[0]" :cy="axis.point[1]" r="4" class="dot" />
        <text :x="point(i, 111)[0]" :y="point(i, 111)[1]" :text-anchor="i === 0 || i === 3 ? 'middle' : i < 3 ? 'start' : 'end'">{{ axes[i][1] }} {{ axis.score === null ? '?' : axis.score }}</text>
      </template>
    </svg>
    <figcaption><span v-for="([key, name]) in axes" :key="key">{{ name }}：{{ traits[key].score === null ? '证据不足' : traits[key].score }}</span></figcaption>
  </figure>
</template>
<style scoped>
.insight-radar { margin: 12px 0; }
svg { width: 100%; max-height: 300px; overflow: visible; }
.grid { fill: none; stroke: var(--app-border, #dfe7e2); stroke-width: 1; }
.area { fill: #07a75c25; stroke: #079b57; stroke-width: 2; }
.dot { fill: #079b57; }
text { fill: var(--app-text-secondary, #66786c); font-size: 11px; }
figcaption { display: flex; flex-wrap: wrap; gap: 5px 12px; font-size: 11px; color: var(--app-text-secondary, #66786c); }
</style>
