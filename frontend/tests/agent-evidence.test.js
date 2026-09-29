import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentEvidence from '../components/chat/AgentEvidence.vue'
import AgentRun from '../components/chat/AgentRun.vue'

const a = 'a'.repeat(24), b = 'b'.repeat(24), c = 'c'.repeat(24)
const run = () => ({id:'test', status:'completed', answer:`结论 [[${a}]]`, citations:[
  {source:a, text:'报价', time:100, match_methods:['keyword','semantic']},
  {source:b, text:'上下文', time:101, match_methods:['semantic']},
  {source:c, text:'更多资料', time:102},
], answer_context:{status:'completed', sources:[{source:a, text_chars:2, truncated:false},{source:b, text_chars:6000, truncated:true}], omitted:1}})

describe('回答依据可核验', () => {
  it('区分已读、请求原文、引用与上下文截断，并能定位', async () => {
    const w=mount(AgentEvidence,{props:{run:run()}})
    expect(w.text()).toContain('已找到 3 条消息 · 本次回答请求包含 2 条原文 · 回答标注引用 1 条')
    const rows=w.findAll('article')
    expect(rows[0].text()).toContain('关键词＋语义命中')
    expect(rows[0].text()).toContain('回答已引用')
    expect(rows[1].text()).toContain('截取前 6000 字符')
    expect(rows[1].text()).toContain('回答未标注引用')
    expect(rows[2].text()).toContain('未放入本次请求原文资料')
    await rows[0].find('button').trigger('click')
    expect(w.emitted('locate')[0][0].source).toBe(a)
    w.unmount()
  })
  it('历史记录与失败调用不伪称来源已发送成功', async () => {
    const r=run(); delete r.answer_context
    const w=mount(AgentEvidence,{props:{run:r}})
    expect(w.text()).toContain('无法确认哪些原文传入了模型')
    expect(w.text()).not.toContain('已放入本次请求')
    await w.setProps({run:{...run(),answer_context:{...run().answer_context,status:'prepared'}}})
    expect(w.text()).toContain('回答调用尚未完成')
    w.unmount()
  })
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
