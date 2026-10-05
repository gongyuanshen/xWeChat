import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentRun from '../components/chat/AgentRun.vue'

const a = 'a'.repeat(24), b = 'b'.repeat(24), c = 'c'.repeat(24)
const run = () => ({id:'test', status:'completed', answer:`结论 [[${a}]]`, citations:[
  {source:a, text:'报价', time:100, match_methods:['keyword','semantic']},
  {source:b, text:'上下文', time:101, match_methods:['semantic']},
  {source:c, text:'更多资料', time:102},
], answer_context:{status:'completed', sources:[{source:a, text_chars:2, truncated:false},{source:b, text_chars:6000, truncated:true}], omitted:1}})

describe('回答依据可核验', () => {
  it('显示实际混合检索、双路命中和退回关键词的原因', async () => {
    const r={...run(),timeline:[{id:'search',kind:'tool',action:'search_messages',text:'搜索聊天记录',status:'completed',result:{retrieval_mode:'hybrid',returned:3,match_counts:{keyword:2,semantic:3}}}]}
    const w=mount(AgentRun,{props:{run:r,viewState:{test:true}}})
    expect(w.text()).toContain('智能检索：关键词＋语义')
    expect(w.text()).toContain('本页关键词命中 2 条 · 语义命中 3 条')
    r.timeline=[{...r.timeline[0],result:{retrieval_mode:'keyword',returned:0,warning:'语义索引尚未覆盖所选范围'}}]
    await w.setProps({run:{...r}})
    expect(w.text()).toContain('已退回关键词检索')
    expect(w.text()).toContain('语义索引尚未覆盖所选范围')
    w.unmount()
  })
})
