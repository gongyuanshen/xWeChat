import { createApp } from 'vue'
import Preview from './ChatInsightsPreview.vue'
import '../../assets/css/tailwind.css'
import '../../assets/css/chat.css'
// 仅用于隔离渲染验收，不读取聊天、不访问后端、不调用远程模型。
globalThis.useAiApi = () => ({ request: async path => {
  if (path.includes('/model-capabilities')) {
    const id = new URL(path, 'http://synthetic.local').searchParams.get('model_id')
    if (!id) throw new Error('合成模型ID缺失')
    return { metadata: { name: id === 'synthetic' ? '合成测试模型' : id, reasoning_controls: { efforts: ['low', 'medium', 'high'] } } }
  }
  if (path.endsWith('/models')) return { model_details: [{ id: 'synthetic', name: '合成测试模型' }] }
  throw new Error(`验收组件未声明请求：${path}`)
} })
const app = createApp(Preview)
app.directive('chat-lazy-src', { mounted: (el, binding) => { el.src = binding.value } })
app.directive('chat-media-perf', {})
app.mount('#app')
