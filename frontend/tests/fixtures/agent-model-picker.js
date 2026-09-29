import { createApp } from 'vue'
import Preview from './AgentModelPickerPreview.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../../assets/css/tailwind.css'
import '../../assets/css/agent.css'
// 验收用声明覆盖档位、开关、预算和未知模型，不访问真实聊天或调用模型。
export const entries = {
  'gpt-6-astra': { name: 'GPT-6 Astra', reasoning_controls: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'gpt-5.5': { name: 'GPT-5.5', reasoning_controls: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] } },
  'claude-opus-4-6': { name: 'Claude Opus 4.6', reasoning_controls: { efforts: ['low', 'medium', 'high', 'max'] } },
  'deepseek-flash': { name: 'DeepSeek V4.1 Flash', reasoning_controls: { efforts: ['low', 'high', 'max'], toggle: true } },
  'budget-example': { name: '预算示例', reasoning_controls: { efforts: [], budget: { min: 1024, max: 8191 } } },
  'toggle-example': { name: '开关示例', reasoning_controls: { efforts: [], toggle: true } },
  'unknown': { name: '未声明档位的模型' },
}
globalThis.useAiApi = () => ({ request: async url => {
  if (url.includes('/model-capabilities')) return { metadata: entries[new URL(url, location.href).searchParams.get('model_id')] || {} }
  const ids = url.includes('/openai/') ? ['gpt-6-astra', 'gpt-5.5'] : url.includes('/claude/') ? ['claude-opus-4-6'] : ['deepseek-flash']
  return { model_details: ids.map(id => ({ id, ...entries[id] })) }
} })
createApp(Preview).mount('#app')
