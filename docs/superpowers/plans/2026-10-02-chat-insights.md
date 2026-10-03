# 聊天画像与消息标签实施计划

用户已确认：复用现有 AI 模型；聊天页画像面板与消息标签；手动选择范围。依据本聊天中已批准的方案实施，不复制 WechatVibe 运行环境。

## 功能与约束

- 单聊人物画像（摘要、话题、交流特点、六维雷达、对方对本人的亲近倾向、MBTI 四轴），群整体画像与按需成员画像，逐条文本的情绪/意图标签。
- 默认最近七天，固定 `[start,end)` Unix 秒范围；只处理非空文本，不推断媒体占位符。群成员画像保留其他人的上下文但只归因目标本人。
- MBTI 至少 100 条目标本人非空文本才展示，证据不足为 null；这是产品展示规则，不是准确率保证。群整体不生成 MBTI/好感度，群成员不生成好感度。
- 打开面板仅恢复保存结果；开始分析才调用模型。标签开关无模型调用；消息内容改变后旧标签不显示。
- 复用模型选择、调度、预算、审计、AIStore、消息分页和账号 SSE。独立 insights 任务，不改摘要任务语义。
- 入口集中校验，严格结构化输出；无隐式回退、补分数、补消息 ID、假成功。实时读取失败直接失败，导入快照显示 snapshot。失败/取消保留已完成批次；重新分析新建任务。
- 不修改或提交用户现有其他改动。当前 main 含大量用户业务修改；本次在已授权的当前工作区就地实现以保留实际依赖状态，不从 HEAD 新建缺少这些依赖的副本。

## 锁定接口（前后端共同契约）

API 前缀 `/api/ai/insights`；沿用 local_only 和 account_name 校验。

- `POST /tasks`: `{account, username, member_username:"", start, end, selected_model?: SelectedModel}`；返回任务详情。
- `GET /tasks?account&username&member_username=&limit=50&offset=0`: 当前会话/对象的任务数组（不含标签明细）。
- `GET /tasks/{id}?account`: 任务详情。
- `POST /tasks/{id}/cancel?account`: 取消并返回详情。
- `GET /tasks/{id}/messages?account&limit=100&offset=0`: `{items, total}`，每条包含下述标签及消息定位元数据。
- `GET /members?account&username`: 使用严格消息读取获得该群已发言者 `{username, displayName}` 数组；绝不使用会静默回退的联系人 HTTP 接口。只读，不调用模型。
- SSE 复用 `/api/ai/events?account=...`，事件 `insight`，body `{task_id,status,stage,progress}`。

任务详情：`{id,account,username,member_username,start,end,selected_model,model,status,stage,progress,created,finished_at?,data_source,coverage,portrait,references,context_budget,error}`。
`model` 为不含密钥的公开模型快照；状态 queued/running/completed/failed/cancelled；`progress` 为 `{read,analyzed,batches}`，不伪造百分比。
`coverage` 为 `{total,text,skipped,target_text,participants}`（participants 为去重发言人数）。data_source 为 realtime/snapshot。
`error` 为 null 或 `{code,message,diagnostic_id}`。
`portrait` 为 null 或下述画像对象。
`references` 保留画像引用的原文及原消息定位信息。`context_budget` 为 `{window,compression_at,source,compressions,measurement}`；source 为 model_metadata 或 user_assumed，measurement 为 utf8_upper_bound。

标签模型输出：`{labels:[{source,emotion:string|null,intent:string|null,reason:string,sources:string[]}]}`。每个目标 source 必须恰好出现一次，sources 只能引用输入来源。模型返回 null 必须有解释，解析缺失不能变成 null。
返回 UI 标签额外包含 `{anchor,identity,time,sender_id,text,fingerprint}`；fingerprint 是 text 的 SHA-256 hex，text 为实际发送给模型的本人文本，引用文本独立上下文。

画像模型输出（字段均显式给出）：
```
{
  summary: {text,sources},
  topics: [{text,sources}],
  communication: [{text,sources}],
  mood: {text,sources}|null,
  traits: {energy:Score,humor:Score,calm:Score,initiative:Score,care:Score,closeness:Score},
  affinity: Score|null,
  mbti: {EI:Score,SN:Score,TF:Score,JP:Score}|null,
  uncertain: string[]
}
Score = {score:integer 0..100|null,reason:string,sources:string[]}
```
MBTI 分数高表示轴左侧（E/S/T/J）；50 表示无倾向，null 表示不足，只有四轴均非空且非50才显示完整类型。后端根据对象类型和 target_text 强制禁用不适用字段，不把不足证据补为50。已知分数和非空结论必须有合法原文出处。

## 职责分配与顺序

1. 路由/schema/契约测试：`ai/insight_schemas.py`、`routers/ai_insights.py`、api.py 路由挂载；service 接口见下。
2. 核心服务：`ai/insights.py`，独立任务生命周期、分批分析、证据校验、保存恢复；严格模式最小扩展现有 CallPolicy/ModelService。
3. 前端：ChatInsightsPanel、六维 SVG 雷达、工具栏入口、消息标签、消息原文回跳、测试。
4. 联调、隔离回归、渲染检查、真实模型测试、文档与来源说明。

服务公共接口：`get_insight_service()`；`InsightService(ai_service=None, reader=None)` 复用 AIService 的 store/models。
`create_task(options:dict)->dict`（async 请求线程内调用后 schedule）；`get_task(id,account)->dict`；`list_tasks(account,username,member_username='',limit=50,offset=0)->list`；`messages(id,account,limit=100,offset=0)->dict`；`async cancel(id,account)->dict`；`async members(account,username)->list`；`start()`；`async stop()`。
`get_task` 不存在/非本账号抛 KeyError；输入/状态错误 ValueError；模型错误 ProviderFailure。

## 验证

测试先行：时间边界、同秒去重、账号隔离、同名成员、文本/媒体覆盖、严格结构校验与引用、模型选择快照、超上下文分页、空输入、MBTI 门槛、取消、重启、账号删除。
前端：打开不调用模型、手动创建、进度/错误、模型/成员切换、迟到响应隔离、标签指纹、历史恢复、来源定位、移动/展开布局。
真实模型：用户选择聊天样本前只使用人工构造的非私人样本；分别记录结构/语义观察和 token 耗时，不把 mock/构建成功当真实模型证明。

## 进度

- 2026-10-02：只读调查完成，用户批准方案。当前开始实施。接口审查：路由/schema/服务/前端共用上面契约；现有摘要任务未支持该输出，选独立服务；默认调用策略不变，仅 insights 使用严格模式。
- Task 1: complete — 严格 schema、本机/账号隔离路由与 app 挂载完成，API 与 schema 独立回归通过。
- Task 2: complete — 独立分析服务、原文材料、分批标签与画像、模型快照、严格调用、启停和账号清除联动完成。补充回归修复旧地址混新密钥、跨批语境、累计原文超预算、引用回复跳过。
- Task 3: complete — Vue 画像面板、消息标签、SVG 雷达和聊天页接线完成，前端 76 Node + 582 Vitest 通过，Nuxt 生成 34 routes。真实 Chrome 合成材料交互 8 项通过，覆盖手动模型选择不启动分析、标签位置/指纹、原文定位与移动布局。
- Task 4: complete — 预算变更后相关后端回归 208 passed（两项已有 LangChainBetaWarning）；提示词修正后核心/集成 23 passed。独立最终复审通过；真实 gpt-5.6-terra 三个人工样例通过，浏览器 8 项合成交互通过。验证边界与报告见 docs/chat-insights.md。
- Ruling: 当前工作区保留全部原业务改动，未新建基于旧 HEAD 的副本，未提交/推送。
- Ruling: 分批前测量完整提示词（包括 schema/旧画像/邻近语境）；旧结论只携带出处身份目录，完整旧原文保存在本地，不因输入过大回退/截断或重试已失败的模型请求。
- 用户确认真实模型测试仅使用人工非私人样例。实际桌面模型 gpt-5.6-terra 的配置及上游模型列表没有上下文容量；用户明确指定本功能默认 258,000 token、90% 开始压缩。已按该参数实现并记录 user_assumed，不改全局模型配置、不声称上游已确认容量。
- 首轮真实模型三个样例均被消息 ID 完整性校验拒绝，未被保存为成功分析。单独诊断保留的真实返回显示：提示词“每条本人文本”被解释为仅 sender 显示名为“本人”的消息，单聊只返回 4 条账号发言、遗漏 4 条对方发言。已改为明确分析所有发送者、所有 target 状态的每条消息，完整性校验保持不变；重新创建人工样例任务 3/3 完成，无自动重试。
- 最终真实报告：tmp/chat-insights-model-1002/20261002-163032-7e0e8d93/report.json。根代理核对实际画像：单聊方向为对方对账号本人；群整体限制适用；同名成员只归因 sample_alex 的海报发言，没有归入 sample_bao 的饮水/现场分工。
