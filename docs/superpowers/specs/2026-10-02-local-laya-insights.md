# 聊天画像：本地 Laya 与 API 双来源

用户要求增加应用内可下载的离线画像模型，并于 2026-10-02 明确选择「Laya 分析、统计规则整理画像；详细文字继续使用 API」。本次按此设计实施，不另装生成式大模型。

## 模型边界

使用 WechatVibe 锁定的 `mizchi/laya-multilingual-onnx`，revision `d9d003d543e63d6d3375c21d44624136bd1e0bad`。它是约 322M 参数的分类/评分模型，不生成自由文本；模型实际上下文为 1024 token，包含问题与选项。API 模式的用户指定 258000/90% 设置不用于本地模型。

复用项目现有 Python、onnxruntime、tokenizers、numpy、jieba、AIStore、消息分页器与 SSE。推理显式采用 CPU、4 线程，不引入 Electron Node 推理服务，不自动切换 API/GPU/CPU。下载固定版本文件并检查大小与 SHA-256；不运行远端自定义代码。保留所移植代码与模型的 Apache-2.0 许可及来源说明。

## 用户流程与数据

- 画像面板选择 API 或本地 Laya；初始继续使用 API，用户主动切换。
- 本地模式提供状态、下载进度、暂停/继续、已有模型目录导入；未就绪明确提示，打开面板不下载、不分析。
- 本地分析沿用手动日期范围、群整体/成员选择与原文来源。消息标签由模型分类，六维为模型信号的统计均值；亲近倾向仅来自单聊对方的关系信号。
- 简短画像摘要、常见用词与统计解释明确标为本地统计结果，不伪装成模型自由生成文字。MBTI 仍以实际分析的目标本人有效文本达到 100 条为展示门槛，缺少自述稳定偏好时保持未知。
- 本地每完成一批即保存标签和累计画像；取消、失败仍可看已经完成部分。来源、模型修订与规则版本进入任务快照。API 与本地历史/标签隔离；旧任务无 engine 字段明确视为旧 API 任务。
- 保留原文与出处，媒体跳过，引用上下文不当本人发言。对无法完整装入本地上下文的消息明确报告超长，不悄悄截断。
- 本次不扩展历史归档/删除功能，不修改原始聊天数据。

## 接口契约

`InsightTaskInput.engine` 新增 `api|laya`，默认 api。laya 要求 selected_model=null；API 仍复用现有模型选择。任务返回 engine、公开 model 快照；本地 context_budget=null，并单独展示模型 1024 上下文。

`GET /api/ai/insights/tasks` 增加可选 engine 筛选，空值保持现有调用契约。

`GET /api/ai/insights/local-model` 返回 `{id,name,revision,license,total_bytes,downloaded_bytes,state,error,path,device,context_window}`。state 为 missing/downloading/verifying/ready/paused/failed；error 为 null 或 `{code,message,diagnostic_id}`。`POST /local-model/download`、`/pause`、`/import`（body `{path}`）返回最新状态。仅下载会联网，推理从经过校验的本地路径读取。

## 实施与验证

1. 模型文件管理与下载/导入边界测试；中断不写成 ready，SHA 错误和 HTTP 错误明确失败。
2. 原生 ONNX 推理适配，按上游 prompt、marker、分词、温度校准解释真实 logits；输入超长/损坏/非有限值直接报错。
3. 模型问题、统计画像与任务集成：来源隔离、成员身份、逐批保存、取消/账号清除不接受迟到写入、API 原有行为回归。
4. 模式选择与下载界面、旧历史兼容、异步响应隔离、测试与构建。
5. 下载真实固定版本模型，用人工单聊、群整体、同名成员样例离线验收；不读取私人聊天。记录耗时、结构与出处检查，不能把分类置信度当画像准确率。

来源：[模型卡](https://huggingface.co/mizchi/laya-multilingual-onnx/tree/d9d003d543e63d6d3375c21d44624136bd1e0bad)、[WechatVibe](https://github.com/tswawa/WechatVibe)、[Laya-MLX](https://github.com/mizchi/laya-mlx)。

## 已完成验证

双模式、模型下载/导入、CPU 推理与统计画像已实现。相关后端 259 项、前端 664 项、桌面资源清单 2 项通过；真实权重导入及三个人工聊天任务通过，固定上游 tokenizer/tensor/数值一致性通过。详细记录见 [功能文档](../../chat-insights.md)。

真实分类仍出现明显误判，输入格式对照没有支持一个统一修正方案。保留模型原始输出和实验性提示，不用规则覆盖误判或宣称准确率。正式下载源在本机的长连接超时与显式官方 ZIP 验收路径分别记录，不伪称正式下载已完整成功。
