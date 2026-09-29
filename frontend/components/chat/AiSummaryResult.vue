<template>
  <div v-if="summary">
    <p class="ai-prose">{{ summary.overview }}</p>
    <section v-for="group in groups" :key="group.key">
      <h4 v-if="summary[group.key]?.length" class="ai-section-title">{{ group.label }}</h4>
      <div v-for="(point, i) in summary[group.key] || []" :key="i" class="mb-2">
        <p class="ai-prose">{{ point.text || point.reason }}</p>
        <button v-for="source in point.sources" :key="source" class="ai-source" type="button" @click="$emit('locate', source)">查看原消息</button>
      </div>
    </section>
  </div>
</template>
<script setup>
defineProps({ summary: Object })
defineEmits(['locate'])
const groups = [{ key: 'topics', label: '主要话题' }, { key: 'conclusions', label: '重要结论' }, { key: 'todos', label: '待办事项' }, { key: 'matches', label: '关注命中' }]
</script>
