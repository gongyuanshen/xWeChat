# AI 功能 macOS 兼容性与验收

更新时间：2026-09-08。此文档区分组件验收与完整桌面验收，不以模拟测试代替真实聊天流程。

**2026-09-10：下列 Mac 记录属于旧版本，仅作参考。本轮全账号助手尚未在 Mac 实机验收；最新状态与执行方法见 [本轮验收记录](ai-assistant-implementation-2026-09-10.md)。**

## 运行策略与修复

- AI 服务、总结、Agent、关注提醒和用量审计使用共享 Python / Vue 实现。模型接口仍读取用户配置，不写死模型名称。
- 本地检索在 Mac 使用 ONNX Runtime CPU。自动策略直接选择 CPU，不把未安装 Windows NVIDIA 组件误报为故障；界面隐藏 NVIDIA 下载入口。来自其他平台的 CUDA 偏好保留，实际执行回退 CPU。
- `uv.lock` 按平台固定 ORT：Mac 1.23.2，Windows 1.28.0。Mac 1.23.2 有 macOS 13+ 的 Apple Silicon 与 Intel wheel；1.28.0 的 Mac wheel 仅有 macOS 14+ arm64，因此不统一使用该版本。最低依赖平台不等同于全应用最低系统验收。
- SQLite 向量扩展使用应用运行时；系统 Python 不支持加载扩展时给出明确错误，并关闭失败连接。源码测试采用 uv 管理的 CPython 3.11。
- PyInstaller 统一收集 LangChain、LangGraph、SQLite 检查点、ONNX、分词器、文档解析和模型清单；修复模型清单缺少 `--add-data` 参数的问题。新增冻结程序离线检查，避免只在开发环境可用。
- Electron 持有通知对象直到点击、关闭或失败；应用停止时释放，避免 macOS 的延迟事件丢失。
- 修复首次使用页跳转被 `loadURL` 的 `ERR_ABORTED` 当成失败而持续重载：只有同源目标实际完成加载才接受跳转，真实连接失败继续进入原有重试。

官方参考：[ORT 安装](https://onnxruntime.ai/docs/install/)、[sqlite-vec Python 运行环境](https://alexgarcia.xyz/sqlite-vec/python.html)、[Electron 桌面通知](https://www.electronjs.org/docs/latest/tutorial/notifications)。具体 wheel 分别核对 [ORT 1.23.2](https://pypi.org/pypi/onnxruntime/1.23.2/json) 与 [ORT 1.28.0](https://pypi.org/pypi/onnxruntime/1.28.0/json)。

## 实机环境

- MacBook Air，Apple M4，16 GB，arm64，macOS 26.3.1。
- uv 管理的 CPython 3.11、Node 24.13.0、Electron 40.0.0。
- 测试目录：`~/WeChatDataAnalysis-ai-check-20260908`。使用独立用户数据目录；未覆盖已有应用、密钥或微信数据。
- 模拟模型与合成消息测试不调用在线模型 API。真实本地模型来自固定 Hugging Face 目录，未使用 Hugging Face Token。

## 已通过

| 检查 | macOS 结果 | 验收边界 |
| --- | --- | --- |
| 后端 AI / Agent / 本地检索回归 | 132 项通过 | 包含模拟模型、协议恢复、权限、审计、索引与设备策略 |
| Vue 回归 | 168 项通过 | 14 个测试文件，包含按钮状态和 Mac 设备界面 |
| 桌面通知、打包与页面启动 | 8 项通过 | 点击路由为自动化测试；覆盖首次使用页跳转 |
| 生产前端构建 | 34 个路由生成成功 | 非完整签名 DMG |
| 公共运行时 | 通过 | 模型适配器初始化、业务 SQLite、LangGraph 检查点、FTS5、sqlite-vec |
| 媒体解析 | 通过 | 合成 DOCX、XLSX、PPTX、图片 PDF、JPEG、PNG、WebP、GIF |
| 三款检索模型 | 完整匿名下载并加载通过 | BGE Small 中文、BGE Base 中文、Multilingual E5 Small |
| 离线混合检索 | 三款均通过 | 真实分词、CPU 推理、FTS5、向量索引与 RRF，合成数据 |
| 冻结程序 | 通过 | onefile 动态库加载、媒体、SQLite、检查点及独立 CPU 子进程推理 |
| 原生通知 | `supported=true`、`shown=true` | Mac Electron 实际 show 事件；未实测人手点击 |
| 本地检索 / Agent 渲染 | 通过 | Mac Electron 真实组件、虚拟数据、浅色及深色；不是已连接微信的整机页面 |
| 完整源码桌面启动 | 通过 | Mac 图形会话启动真实 Electron → 原生 broker → FastAPI，健康接口正常，首次使用页不再循环重载 |
| 运行中的 AI HTTP 接口 | 4 个入口均返回 200 JSON | 全局 AI 设置、Agent 设置、本地检索状态与设备列表；未读取真实聊天 |

Windows 对应后端 132 项、Vue 168 项、桌面 8 项回归通过，公共运行时检查通过。最后一次设备显示文案调整后，另行复验本地检索 Vue 31 项通过。新增 `.github/workflows/ai-cross-platform.yml` 持续检查 Windows / macOS；此记录不宣称新工作流已在 GitHub 执行。

## 本地检索样例

48 条合成消息、8 个固定问题，三款模型的关键词 Recall@20 为 0.25，混合检索为 1.0。该样例用于检查执行链路，不代表真实账号效果或普遍准确率。

| 模型 | 查询中位数 | 推理工作进程 RSS |
| --- | --- | --- |
| BGE Small 中文 | 5.21 ms | 221.69 MB |
| BGE Base 中文 | 25.21 ms | 580.47 MB |
| Multilingual E5 Small | 4.28 ms | 1615.16 MB |

以上是该合成小索引的局部测量，不包含模型下载、首次启动、完整 UI 往返和在线回答；不能据此承诺大量聊天的耗时或内存。

## 桌面启动排障与未覆盖项目

源码原生组件下载及校验通过。直接从 SSH 后台启动时，原生数据库 broker 报 `Cannot create device identity: broker unavailable`（退出码 4）；改由 macOS 图形会话通过 `open -n -a ... --args ...` 启动后，原生组件与后端正常。没有关闭安全检查、修改钥匙串权限或绕过原生组件。该现象表明远程 shell 启动与桌面启动不同，未进一步推断底层钥匙串错误类型。

随后发现并修复首次使用页正常重定向引发的循环重载。2026-09-08 19:39 的实机启动健康接口返回正常，桌面停留首次使用页。当时仅完成启动和组件测试。

同日随后补充了真实 Mac Electron 用户流程：模型下载、本地索引、真实账号副本语义搜索、真实模型总结、连续追问、跨群对比、停止继续、补充要求、引用定位和审计。详细结果、实际 Token 以及仍未覆盖的实时提醒等场景见 [Mac AI 实机用户流程验收](ai-macos-user-acceptance.md)。Intel Mac、macOS 13/14 实机以及签名安装包均未完成实测，不能承诺所有 Mac 组合均已验证。

## 复验入口与证据

CI 与源码复验均显式使用 uv 托管的 CPython 3.11。仅运行 `uv sync` 或指定 `--python 3.11` 仍可能复用已有解释器；部分 macOS Python 构建缺少 SQLite 扩展加载能力，导致 sqlite-vec 初始化失败。

```sh
export UV_MANAGED_PYTHON=true
uv python install 3.11
uv sync --locked --python 3.11 --managed-python --extra build
uv run python tools/verify_ai_runtime.py
uv run pytest -q tests/test_ai*.py tests/test_local_search*.py
cd frontend
npm ci
npx vitest run
npm run generate
cd ..
node --test desktop/tests/ai-notifications.test.cjs desktop/tests/ai-packaging.test.cjs desktop/tests/renderer-startup.test.cjs
node tools/build_ai_smoke.cjs
```

AI 跨平台 CI 同样设置 `UV_MANAGED_PYTHON=true` 并安装 uv 管理的 Python 3.11，使源码检查与 PyInstaller 冻结检查共用支持 SQLite 扩展的解释器。仅指定 Python 3.11 版本不足以保证此能力：macOS 上 `actions/setup-python` 提供的解释器也可能缺少 `enable_load_extension`。参见 [uv 的托管 Python 设置](https://docs.astral.sh/uv/reference/environment/#uv_managed_python)。

模型已下载时，运行检查器可加 `--model-root <模型目录>` 验证真实 BGE Small 子进程推理。检查器仅生成合成数据，不读取账号和密钥。完整后端打包脚本也自动调用 `--smoke-ai`。

Mac 测试目录中的 `logs/` 保留：`python-tests.log`、`vue-tests-complete.log`、`frontend-build-release.log`、`runtime.log`、`models.log`、`retrieval.log`、`frozen-build.log`、`frozen-inference.log`、`desktop-ai-tests.log`、`ai-notification-smoke.json`、`mac-ui-check.json` 及界面截图。初次启动失败诊断保存在 `mac-desktop.log`；修复后的启动记录在 `mac-desktop-probe.log` 和测试用户目录的 `desktop-main.log`。
