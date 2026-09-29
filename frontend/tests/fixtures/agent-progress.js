import { createApp } from 'vue'
import Preview from './AgentProgressPreview.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../../assets/css/tailwind.css'
import '../../assets/css/agent.css'
// 独立预览只返回明确标注的示例子任务，不连接用户聊天或模型。
globalThis.useApiBase = () => '/preview-api'
// 资料入口使用本地示例响应，展开预览不会连接真实账号。
globalThis.useAiApi = () => ({request:async () => ({items:[],total:0,has_more:false})})
const previewNow = Date.now() / 1000
globalThis.$fetch = async path => {
  if (!path.includes('/agent/runs/progress-preview/subtasks')) throw new Error('预览未提供此操作')
  const now = previewNow, done = globalThis.progressPreviewCompleted
  return { items:[{id:'preview-child',name:'当前聊天 · 重要事项分析',status:done?'completed':'running',
    started_at:now-510,finished_at:done?now:null,current_action:'正在分析已读取的消息',action_started_at:now-98,
    last_activity_at:now-105,model_running:!done,
    objective:'归纳这段聊天中的重要安排，保留后续变化和消息依据。',
    latest_progress:{text:'已整理出工作安排和电脑配件两个话题。约饭时间出现过调整，目前这部分消息还不足以确认最后的安排。'},
    coverage:{read:350,analyzed:done?350:175,complete:done},
    activity:[{id:'b',kind:'tool',text:'读取聊天记录',status:'completed'},
      {id:'a',kind:'progress',text:'前半段讨论中的工作安排已整理，尚未看到落实的消息。',status:'completed'},
      {id:'c',kind:'tool',text:'保存分析发现',status:'completed'}],
    usage:{calls:4,input_tokens:5200,output_tokens:710},
  }],has_more:false }
}
createApp(Preview).mount('#app')
