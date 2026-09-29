import { createApp } from 'vue'
import Preview from './AgentCompactionPreview.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../../assets/css/tailwind.css'
import '../../assets/css/agent.css'
// 示例摘要仅用于界面验收，不访问真实聊天资料。
globalThis.useAiApi = () => ({ request: async () => ({ before: 832995, after: 273953, model_window: 1000000, summary: '用户目标与纠正\n统计这段聊天中的借款和还款，核对尚欠金额。\n\n已完成工作\n已找到借款和部分还款记录，原文已保留。\n\n未完成工作\n核对每笔金额、日期和重复转账，再计算合计。' }) })
createApp(Preview).mount('#app')
