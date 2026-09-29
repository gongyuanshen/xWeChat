import { AssistantRuntimeImpl, ExternalStoreRuntimeCore } from '@assistant-ui/core/internal'
import { RuntimeAdapter } from '@assistant-ui/core/store'
import { AuiConfig } from '@assistant-ui/vue'

// 后端仍持有会话和运行状态；只把消息投影交给 Vue primitives 管理。
export function createAssistantThread(initial) {
  let state = initial
  const adapter = () => ({
    messages: state.messages,
    isRunning: state.running,
    isDisabled: true,
    convertMessage: message => ({
      id: message.id,
      role: message.role,
      content: [{ type: 'text', text: message.text || '' }],
      ...(message.role === 'assistant' ? { status: message.running ? { type: 'running' } : message.status && message.status !== 'completed' ? { type: 'incomplete', reason: message.status === 'failed' ? 'error' : message.status === 'cancelled' ? 'cancelled' : 'other' } : { type: 'complete', reason: 'stop' } } : {}),
    }),
    // 复用现有输入区的幂等提交、补充要求和停止逻辑。
    onNew: async () => {},
  })
  const core = new ExternalStoreRuntimeCore(adapter())
  return {
    config: AuiConfig({ threads: RuntimeAdapter(new AssistantRuntimeImpl(core)) }),
    update(next) { state = next; core.setAdapter(adapter()) },
  }
}
