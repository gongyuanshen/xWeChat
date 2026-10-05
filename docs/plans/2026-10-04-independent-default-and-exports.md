# 第三阶段：默认独立运行与导出剩余依赖

承接用户确认的三阶段路线和已完成的自主密钥、认证快照、刷新、独立账号归档。本轮在当前工作区继续推进，保留前序未提交实现及用户数据。

用户最新明确要求：暂不开始删除式清理，先完成剩余功能任务。当前执行状态集中记录在 [剩余功能与真实验收计划](2026-10-04-remaining-functional-acceptance.md)；本文各轮历史“尚未完成”列表须结合后续验收读取，不能把已完成的表情动画重新算作缺口。

## 后续本地表情与 WXGF 动画进展（2026-10-04）

用户确认继续后，已在默认 Python 后端实现本地 CBC 表情容器读取及完整 WXGF 动画输出；原“本地容器不支持 / WXGF 表情一律拒绝”的状态由新实现取代。明确授权恢复并保存账号 code 后，7 条真实消息 GET 与 10 份 HTML/JSON 导出完成验证，覆盖月缓存、Persist 透明动画、PersistStore 和真实缺失文件。具体代码、测试、真实样本证据及边界见 [后续计划](2026-10-04-local-emoticon-and-wxgf-animation.md)。下文保留当时的历史验收边界，不代表新功能仍一律不支持，也不将本轮源码实现算作安装发行已完成。

## 继续推进：表情完整性与真实持续刷新（2026-10-04）

用户确认继续下一步，并同意配合约 10 分钟从手机向文件传输助手分批发送测试消息。观察器先完成基线才通知发送，源目录只读，不代替用户发送消息。频率、采集失败与代次发布均如实记录，不把一次新增或低频观察称为高频验收。

- [x] 复用真实刷新工具，补齐全量分页及独立 SQL 身份 / 内容对照，再完成新的 10 分钟窗口。保留旧读取会话并核对最新读取、导出；未添加静默自动重试。
- [x] 修复已复现的显式表情下载成功条件：HTML / 密文 / 后续帧损坏 / MD5 不符 / 已有坏资源不得返回保存成功；只有完整图片与声明身份核验通过才落盘。`force` 语义不变，不自动替换错误资源。
- [x] 独立 GET 表情明确传递媒体类型，避免将 WXGF 静态输出当作动画；本地读取不隐式转远端。显式下载仍由原有入口触发，不恢复已删除的 WxCDN 或远端图片密钥服务。
- [x] 限定读取消息原始腾讯 CDN 表情，仅写临时验收目录，核对原字节 MD5、完整帧数和时序，再验证显式下载后的离线读取 / 导出；不把这条路径算为 `PersistStore` 自主解码。
- [x] 完成 WXGF 动画接口的有界查证，定位本机调用方，但仍无匹配版本的 ABI、时间单位和可信动画向量。此项只表示调查完成，动画解码未完成；未调用未知函数或猜帧率。
- [x] 修复错误状态隐藏下载按钮、下载成功后错误状态未清除的问题。手动“下载并重试”才请求替换失败资源，成功后重读带版本参数的本地 URL；失败继续报错并保留重试入口。4 个前端行为用例先复现 3 失败、1 通过，再全部通过。

### 本次新增证据

真实观察 600.17 秒，共 19 次检查（初始 1 次、自然定时 18 次），发布 9 代快照，每代 21 库认证及完整性通过。文件助手文本 88 → 126，新增 38 条；实际新增时间跨度 273 秒，峰值 10 秒 4 条、30 秒 9 条、60 秒 11 条。固定旧 reader 始终读取 88 条，修正版实时 8 对读取和逐代 9 对读取的 SQL / API / JSON ZIP 身份与内容、内容清单全部一致。无源变化错误、自动重试、源写入、旧组件或网络调用；全局密钥摘要未变，全部进程及刷新线程已停止。证据 `tmp/phase3-live-filehelper-20261004-191806/acceptance-summary.json`。初版旁路观察器继承旧 scope，错误标记“latest”，原报告保留并作废该结论；修正版在独立 Context 中明确核对实际 revision，之后补核全部 9 代，未改生产 scope 语义。

真实 14 帧 GIF（229 × 256，394413 字节）经生产显式下载 API 获取，MD5 与真实消息字段一致；随后本地 GET、HTML 和 JSON 导出不访问网络。导出中实际消息引用精确指向 GIF，原字节、全部帧时长、循环设置及内容清单一致，缺失媒体为 0。证据 `tmp/real-media-followup/real-emoji-download-chain-final/report.json`。这证明手动下载后的离线链路，不能替代本地 Persist / PersistStore 解码或 WXGF 动画。媒体相关最终 13 文件为 193 passed、9 subtests passed，日志 `tmp/emoji-download-media-final3.log`。

WXGF 的本机 `Weixin.dll` 调用方已定位，但安装目录与项目内 VoipEngine 构建版本不同；未找到匹配头文件 / PDB / 序列参数、时长与内存所有权契约。已查证的公开实现也未提供可移植的 Windows 动画 ABI 与可信时序参考。证据 `tmp/wxgf-animation-source-audit-20261004/report.json`、`tmp/wxgf-local-caller-audit-20261004/report.json`。未知格式继续明确保留为未完成项，因此尚未执行删除式代码清理。

前端完整 `npm test` 通过：89 项 Node 测试、58 文件 739 项 Vitest（含新 4 项）；`npm run generate` 成功生成 32 个路由，更新桌面源码入口使用的 `.output/public`。独立审查未见本轮新增 P1 / P2。日志 `tmp/emoji-ui-frontend-full.log`、`tmp/emoji-ui-generate.log`；原有重复自动导入、过期 Browserslist 数据、旧 CSS 渐变语法及大 chunk 警告仍保留，未通过隐藏警告称为无问题构建。本轮未重跑下文历史全仓 Python 回归，193 项媒体回归与安装包契约测试分别证明本轮受影响范围。

本轮额外浏览器交互验收未通过环境启动：Vite 编译真实 MessageContent / useChatMessages / 懒加载插件的隔离 fixture，Electron 在页面加载前以 `0xC0000135` / FATAL 退出，无 GPU 模式同样失败；未安装依赖或更改用户配置。截图和 fixture GET / POST 均为 0，因此不声称已验证浏览器中的重试。自有 Electron 子进程退出、Vite 关闭、端口停止监听均有记录；CIM 进程枚举权限不足也保留在报告中。证据 `tmp/emoji-ui-browser-proof/summary.json`、`transport-report.json`。上述已通过的 DOM 测试、真实 GIF 后端链，以及下文上轮 Electron 默认启动验收分别保留其原范围，不能相互代替。

新目录 `tmp/phase3-emoji-refresh-build` 的 sdist → wheel 内容核验通过：212 个源码 / 资源、8 份 HTML 资源逐字匹配，仅携带允许的静态 WXGF DLL。实际安装的 `bc53ac384b841117ee03abfe1844a7a9a3acf9067d19d668ef4b57132cc99599` wheel 运行 56 项契约测试、6 份真实 WXGF 及 CLI TCP 健康 / HTML 验证通过，58 个应用模块均来自新安装目录并记录摘要；旧组件 / 外网探针为 0。依赖复用既有环境，Python 时间模拟不改变 Windows / DLL 时间。证据 `final-build-proof.json`、`runtime-proof/report.json`。

随后只将 README 的“下载前校验”纠正为“保存前校验”，最终包在 `tmp/phase3-emoji-refresh-build/metadata-final`：wheel SHA-256 `69dd5d48bdac4689a57a093d0a85326d9e32eb5b0f156a7c00665db38186d48a`，sdist `26f6148a19fe03c82f81aa807f70da812988527c2a16af85fde8222e8067f5ee`。wheel 仅 METADATA / RECORD 变化，sdist 仅 README / PKG-INFO 变化，全部 212 份执行源码 / 资源不变，故继承上述运行证据而未重跑。映射证明 `metadata-rebuild-proof.json`，历史产物与报告均保留。本轮没有安装器发行。

## 追加收尾与清理顺序（2026-10-04）

用户要求先完成剩余任务，再开始代码清理。本轮沿用现有接口和验收脚本，不扩展安装发行或重写未知密码学格式：

- [x] 已用真实消息关联验证视频、附件、合并记录与缺失媒体，并定位表情缓存格式缺口；修复合并记录字段解析和已关联表情包被误报缺失的问题。表情内容解码及 WXGF 动画仍未完成，本项只表示已完成当前样本调查与确证缺陷修复。
- [x] 追加 600.03 秒真实观察：20 次检查（初始加 19 次自然定时），21 库通过，无新增消息，固定旧 / 最新读取各 14 轮，共 28 个 JSON ZIP、各 88 条文本回读一致。线程与两个验证进程退出、全局密钥未改、禁止调用 0。新增受控 6 秒连续写入测试约 172 commit/s、32 次 WAL TRUNCATE、33 组盐，采集变化时明确停止并保持旧指针及 544 轮固定读取，手动恢复成功。既有 7 项加新增 1 项压力测试通过；这是受控压力，不等于真实微信长时高频成功验收。证据 `tmp/phase3-live-followup-extended-20261004-182740/acceptance-summary.json`。
- [x] 真实 Electron 40 启动 `desktop/src/main.cjs` → `uv run --no-dev --extra voice-transcription main.py`，未指定模式，健康结果 `offline/decrypted`。进程启动前隔离 APPDATA / LOCALAPPDATA，再限定 userData / sessionData / 输出目录；真实 SQLite 消息渲染、preload 双 IPC 往返、30 秒刷新控件默认关闭均通过，旧组件与外网探针 0，自有进程全部退出。使用已生成静态 UI、已有依赖与受控三库，不是 Nuxt 热更新、全新安装或真实账号全部 GUI 操作验收。证据 `tmp/phase3-electron-gui-proof-final-isolated/report.json` 及同目录截图。
- [x] 用户明确选择“排除企业微信联系人，仅统计普通微信联系人”。深夜伙伴的索引与原库读取共用同一筛选规则，聊天列表口径不变；缓存版本 39 → 40，使旧统计自动重算。先复现两个路径总数 7 对 2 的失败及旧缓存 7 对 1 的失败，再完成修复。年度总结相关 121 passed、5 skipped，日志 `tmp/phase3-night-wrapped-final.log`；跳过项不计完成。
- [ ] 格式与真实高频验收尚有未完成项，因此本轮只做引用审计，未执行删除式清理。候选为 `routers/sns.py` 的两个无调用辅助函数和引用不存在 Rust crate 的 `tools/build_wce_integrity.ps1`；同名在用实现、用户数据、静态图片解码库、验收证据与显式旧模式均保留。
- [x] 完成全仓执行、DPAPI 环境差异定位及最终受影响回归，结果与边界见下文；不以测试跳过、低频观察或受控样本充当全部完成。

### 本轮补充证据

合并记录已修复一处真实输入缺陷：外层 URL 可以包含未转义的 `&`，但 `recorditem` 中的 XML / CDATA 有效。现在先按字段层级精确取出 `recorditem`，再严格解析其内容；不修改 URL、不修补非法记录，不接受重复字段或 DTD / ENTITY。保留嵌套同名字段、CDATA、注释和不同换行的回归，共 14 项；与既有合并记录测试合计 35 passed。真实初筛的 11 个解析失败减至 1 个，剩余记录体仍未通过严格解析，未擅自修复数据。

使用真实 SQL 消息与生产 API 完成 9 个场景的 HTML / JSON 共 18 份导出：实际 MP4、PDF 的身份、原始字节与内容清单相符；真正缺少的视频和文件明确记录缺失；合并记录正文成功，内含媒体仍缺失。4 个表情场景均未导出表情，不能以 ZIP 任务 `done` 判为媒体成功。证据 `tmp/real-media-followup/real-export-summary.json`。消息关联的表情候选缓存确实存在，但不是已知明文图片或 DAT / WXGF 容器；未把远端下载的 AES-CBC 规则套用于本地缓存。固定源码调查证据 `tmp/emoticon-source-audit/report.json`。

后续修复上述 4 个表情场景中的一处明确误报：普通资源未命中时，若 `emoticon.db` 中请求 MD5 精确关联的本账号 `PersistStore` 包存在，抛出专用不支持异常；库损坏、缺必需列或权限错误均继续暴露。可用图片优先，真正未关联仍记录缺失，显式 native 行为不变。消息中另一 MD5 同名未知缓存的角色未证实，未将其强行归为正文或编造解码规则。源目录已知 XOR / CBC / ECB 的有限假设均未得到明文 MD5 与完整图片双重成功证据。

普通 ZIP 错误退出原先只在加密或文件夹模式清理 `.part`，真实表情错误复现了残留。现将已有临时 ZIP 清理应用到普通错误退出，保留原异常；清理本身失败仍暴露，日志保留原错误的 traceback 上下文，不删除已有 ZIP。3 个用例先失败后通过；关联 9 文件最终 78 passed、5 skipped、8 subtests passed，日志 `tmp/phase3-zip-media-final-2.log`，跳过的是旧格式。已知普通表情容器的 11 文件媒体组为 167 passed、9 subtests passed；两组有交集，不相加。

最新真实 JSON / HTML 表情导出均为明确 `error`、`mediaMissing=0`、无发布 ZIP 或遗留 `.part`，源文件和全局密钥摘要不变，旧组件 / 网络 / 源写入探针均 0。证据 `tmp/real-media-followup/unsupported-export-report.json`；旧残留报告另存 `unsupported-export-before-cleanup-report.json`。专用异常的受控 ASGI 入口验证为 422 且包含原因；真实 GET 的另一条普通未知缓存候选路径仍由读取器报格式错误 / 500，不将其混称为真实 422 验收。旧测试重载模块造成的异常类引用污染仅在新测试夹具隔离，未放宽生产捕获范围。

本轮最终冻结源码重新构建 sdist → wheel，两包各 216 文件、212 份源码 / 资源逐字一致，仅携带允许的静态 WXGF 解码 DLL。wheel SHA-256 `c7ee979b87a7bcb24ddf1dbb984fd48f7747f4e9882fb434b5727c29b11d34e5`，sdist `2366db9da3ee51959ce792f48d97ea7b80db26b2bd3b3eca2e2ecf1e7e53fc72`，取代下方历史产物。实际安装包的合并记录、年度规则、缓存更新、表情分类、HTTP 与 ZIP 清理共 36 项通过；58 个已加载包模块均来自安装目录。6 份真实 WXGF 输出与参考逐字一致，CLI 健康检查与 HTML 校验通过，Python 禁止调用探针 0。证据 `tmp/phase3-completion-build/contents-proof.json`、`runtime-proof-final-2/report.json`；依赖复用与 Python 时间模拟的边界不变。

构建目录复用了同名产物，`runtime-proof-2/report.json` 只对应本轮较早的 `5ae64fd5584593679229acf9943502801453bdf1bc3ee2c6a8aa306b4f3ee0de` wheel，不代表最终运行结果。`final-rebuild-proof.json` 逐项确认最终包仅增加上述三个生产文件的修改及 RECORD 更新，其余成员不变；旧包成员摘要保存在 `pre-emoticon-final-content-hashes.json`。未恢复安装器发行。

本轮完整 Python 回归已跑完：3736 passed、19 skipped、10 failed、273 subtests passed，800.26 秒。10 个失败集中在 Windows 当前用户 DPAPI 的 `WinError 2` 及其持久缓存；不导入生产模块的原生 crypt32 探针也在沙箱用户上下文失败，同一探针在正常宿主用户上下文成功。原样三个测试文件在沙箱重现同 10 个失败，在宿主为 52 passed、4 subtests passed，未修改生产或测试、未访问已有用户凭据。证据 `tmp/phase3-completion-dpapi-comparison.json`；不能推导产品必须管理员运行，也未确定到具体 DPAPI 主密钥文件。全仓原始日志 `tmp/phase3-completion-full.log` 保留，不将分环境补验改写为单次全仓全绿。

全仓运行结束时生产文件与运行前摘要一致；期间只在既有 XML 测试里追加注释假字段，最终版本已另跑 14 项及安装包 17 项，不能将早前收集的全套称为最终测试字节完全一致。摘要核对 `tmp/phase3-completion-full-source-proof.json`。随后 `PersistStore` 错误分类、HTTP 专用错误及临时 ZIP 清理的三个生产文件按上述受影响范围另行回归，不计入前面的全仓结果。

## 最新验收基准（用户后续澄清）

目标是解除受时间限制的组件对实际使用的影响，允许复用不经过该期限 / 授权链的现有本地组件。正规签名发行、恢复原厂归档签名及从零重写所有旧二进制不再作为完成前提。下文较早记录中“完全独立解码”和“安装发行验收”等未完成项，按本节重新界定，不能继续统称为期限脱离的阻塞项。

用户已提供当前微信根目录 `E:\xwechat_files`，并确认微信已登录。用户不确定是否曾使用 WEC / WES 归档；本轮直接从微信数据库与媒体缓存验证，不要求用户识别旧备份格式，也不推定用户没有历史归档。

已确认有期限约束的是 `wechatdb_client.dll` / `wechatdb_broker.exe` 所属运行时及其上层 build / lease 检查。现有 WXGF `VoipEngine.dll` 调用不经过这些模块，不能仅因它是旧 DLL 就判定为限时组件；其真实解码与二进制自身行为另行验证。未来日期测试只修改验证进程的 Python 时间，不修改系统时间，也不等同于模拟 DLL 内部 Windows 时钟。

真实刷新验收在隔离临时输出目录和短命验证进程中运行，源目录只读；不更改用户软件的全局设置，不向微信发送消息。只有实际观察到自然写入并完成新快照发布，才计为真实新增刷新证据；无新增或源变化失败会如实记录。

期限后验证已完成：新增 `tests/test_offline_expired_runtime.py` 在 2027 / 2030 两个子进程时间下先确认旧构建清单确实被判定过期，再完成受控真实 SQLite 认证解密、HTTP 消息读取及 TXT / JSON / Excel 文件回读，2 项通过。2030 的源码入口及前次已安装 wheel 命令行入口均通过真实 TCP 启动，旧 client / broker / lease / telemetry / Hook / 外网失败探针均 0 次。既有真实快照的隔离副本也完成 21 库 / 160 会话 / 100 消息的 JSON 和 HTML 回读核对。证据：`tmp/phase3-after-expiry-2030/report.json`、`tmp/phase3-expired-runtime-tests.log`。该真实快照未在本轮重新采集，已安装 CLI 是此前冻结版本；没有更改机器时钟。

当前微信真实刷新已验证：用户从手机向文件传输助手发送一条测试消息，独立观察进程运行 200 秒、完成 6 次自然 30 秒检查并发布 3 代快照；每代 21 库均通过认证与完整性检查。文件传输助手记录从 206 增至 207 条，新增记录 ID / 时间与生产读取器完全匹配，总消息数从 34505 增至 34506。持有的旧读取会话仍固定于原代次。观察结束后线程已退出、自动刷新已停止，用户密钥配置摘要不变。证据：`tmp/phase3-live-followup/acceptance-summary.json`。一次审计拒绝来自 Windows `nul` 特殊设备，被误当成文件写入；原始记录保留，允许精确空设备后的限定诊断 / 读取补验通过。没有源文件或全局配置写入，旧组件及网络调用为 0。本轮证明真实新增消息被定时刷新拾取，不宣称已完成长时间高频压力验收。

WXGF 静态图片已接入默认读取与导出：新增 `wxgf_codec.py` 在独立 Python 子进程中调用既有 `VoipEngine.dll` 的 mode 0，不进入 client / broker / lease。错误返回、崩溃、非法输出及 30 秒超时直接失败；图片、视频缩略图、引用及合并记录均传递取消检查，取消后回收进程并清理临时数据。原始容器和严格 DAT 解密后的容器共用同一路径，无 mode 3 或旧模式回退。Windows x64 源码与 wheel 后端受支持，frozen 后端与 WXGF 表情动画明确拒绝，带未知前缀的 WXGF 不做猜测。

真实媒体证据新增 6 份当前微信样本（3 份缓存 WXGF、3 份 V2 DAT），原文件只读。默认 reader 输出均为可完整解码的 JPEG，与参考 mode 0 输出逐字节相同；将这 6 份样本副本关联到隔离受控会话后，HTML / JSON ZIP 各导出 6 图、缺失 0，图片字节与内容清单通过回读。这里验证真实媒体字节与导出路径，不将受控会话关系当作真实消息关联验收。样本副本及全局密钥文件摘要不变，旧 core 调用探针为 0。证据：`tmp/wxgf-decoder-audit/default-reader-export-report.json`、`six-sample-mode0-report.json`。

本轮 WXGF / 媒体 / 导出关联 7 文件回归为 137 passed、9 subtests passed；故障覆盖真实子进程退出、崩溃、超时、取消和坏输出。已配置项目既有 FFmpeg，未因首次环境缺失而放宽校验。日志：`tmp/phase3-wxgf-media-final-2.log`。独立代码审查未发现新增 P1 / P2；以上结果不覆盖全仓既有年度总结规则冲突，下方保留全仓结果。

构建恢复仅包含一个本地 WXGF 解码 DLL，SHA-256 为 `5fef396573ea80e3c92bdc4be1e4ac04f099aa805b74d7f046ff01d16323537e`；旧 client / broker / 完整性扩展 / 大图 Hook 与其他 DLL 继续排除。已安装 wheel 的 6 个真实样本输出与源码参考逐字节相同，源码及命令行默认启动、HTML / CSS 与清单核验通过。证据：`tmp/phase3-wheel-wxgf-proof/report.json`、`tmp/phase3-startup-proof/report.json`、`tmp/phase3-wxgf-build/contents-proof.json`。DLL 静态导入包含系统时间和网络 API；Python 审计探针不覆盖 DLL 内部全部调用，不能据此宣称 DLL 永不过期或绝不联网。安装器发行仍暂停。

README 更新后的最终 sdist / wheel 各 216 文件，212 份代码 / 资源与工作区一致，包含 8 份 HTML 资源；wheel SHA-256 为 `6bdab077de870911bf7bac6ef83ffc8ca7ec2b58ee5dcc9434577a6febe77f30`，sdist 为 `49ad98485c015487e332b3cfa6e2c0143d6c51f21f9d3d3072f93797604db662`。实际解码 / TCP 验收运行于文档更新前的 `4c559cd9408374deb040522234cddacb3390cafe1bd8a6903f47d08a59b84cdb` wheel；重建逐文件比对只有 README 与包元数据变化，全部执行字节相同，故未重复运行验收。关联证明：`tmp/phase3-wxgf-build/metadata-rebuild-proof.json`。

## 首轮实施与验收（历史记录；当前状态以上节为准）

- [x] Python / Electron 缺省启动统一独立模式；显式旧模式保留清楚的边界。真实 API 生命周期、TCP 健康检查及桌面启动契约检查未触发旧组件下载、初始化、授权和遥测。
- [x] `wx_key` 移至显式 `legacy-native` extra；Python sdist / wheel 排除旧原生 DLL / PYD / EXE 和完整性扩展。修正 console entrypoint，保留旧模式源码以供显式选择。
- [x] HTML 复用现有 Python 渲染；静态展示资源落为可审计文件并保留来源。新聊天 ZIP 使用既有 SHA-256 清单，不提供旧签名或来源认证。
- [x] 核查本地图片、视频、语音、文件、表情及合并记录的导出路径；修复读取错误被吞、密文伪装成成功媒体、引用语音错误被吞及文件句柄泄漏。完整媒体真实验收仍未完成，详见下文。
- [x] 朋友圈独立导出直接读固定快照，不尝试旧实时同步或旧签名；发布失败不会以临时文件冒充成功。取消在最终发布前生效并清理临时 ZIP；进入发布后明确拒绝取消。
- [x] 联系人、收藏及通用记录的剩余旧签名调用改为内容清单；浏览器联系人导出也写入清单，真实数据源读取失败直接报错。
- [ ] WEC / WES 密码学兼容：未找到足够的算法规则、可信验签材料和测试向量。用户已确认目前没有对应规范，明确留作未完成项。独立模式在入口拒绝 WEC 和旧签名账号 ZIP，包括与新清单混合的旧签名文件。
- [x] 受影响回归、独立审查、真实已验证快照的隔离导出回读；按验证层记录结果，不将受控媒体或已有快照等同于新采集的全部真实客户端数据。

## 约束

不修改原微信数据库，不输出密钥或聊天正文，不更改全局自动刷新设置、不发送消息、不调用真实模型。上节真实刷新只在短命隔离验证进程中开启，结束时停止。独立模式是数据链路的明确选择，不是全应用网络隔离。现存显式旧模式不计作独立实现；恢复的静态 UI 资源不计作自主密码学实现。安装包发行仍按原决定暂停。

## 已实现行为及验证边界

缺省 `WECHAT_TOOL_DATA_MODE` 与空值均为 `offline`，健康接口返回 `default_source=decrypted`；只有显式 `native` 选择旧链路。旧大图 Hook 和微信原生转写在能力接口明确不可用。本地转写保留独立配置，未进行模型调用验收。

HTML 支持目录 / ZIP、分页、搜索及本地媒体。静态资源的恢复来源与摘要记录在 `src/wechat_decrypt_tool/resources/html_export/sources.json`；构建和运行不再读取旧 `.pyd`。没有伪造旧验签成功状态，也不会自动以远程资源替换本地媒体。已有 DAT 源码算法读取本地已保存密钥；图片必须通过实际解码验证；找不到资源会记录缺失，解密、格式、权限和写入错误会使任务失败。

真实数据回读使用前序已通过验真的 21 库账号快照的隔离副本，未重新捕获当前微信数据库。最终文本验证为 160 个会话中的 100 条普通消息：编号和时间与 SQL 一致，JSON 内容及 HTML 分页重建文本一致，源快照摘要不变；JSON ZIP、HTML ZIP、HTML 目录均通过，旧原生调用和源写入探针均为 0。证据：`tmp/phase3-real-exports/run-5/report.json`。另有 3 条真实 SILK 语音成功转换并回读 WAV，时长分别为 9.14、22.94、44.18 秒，旧原生调用为 0；证据：`tmp/phase3-real-exports/voice-2/report.json`。

真实 Chrome 本地文件检查覆盖分页、搜索和受控图片解码，无脚本错误，资源请求仅 `file:` / `data:`；证据：`tmp/html-independent-audit/browser-report.json`。受控图片 / 视频 / 语音测试使用可实际解码的文件。它们证明这些固定输入的行为，不证明全部真实媒体兼容。

## 回归与构建记录

- 最终重点回归 37 个 Python 测试文件：550 项通过、1 项跳过、22 个子测试通过，耗时 95.45 秒。覆盖独立快照、密钥、WAL、导入导出、联系人 / 记录、启动、刷新、取消及账号隔离。日志：`tmp/phase3-final-regression-2.log`。初轮发现朋友圈夹具缺 `contact` 表，按真实必需结构修正夹具后通过，没有增加吞错路径。
- HTML / 媒体相关 11 文件组合：103 项通过、24 个子测试通过。
- 头像相关 15 项通过；其中 5 个明确测试原生实时行为的用例补上显式 `native` 模式，其余继续按默认模式验证。各测试组存在交集，不累加为独立用例总数。
- 朋友圈取消 / 发布 / 清理的独立复核：18 项通过；校验过程中及结束后取消均不发布 ZIP、不遗留临时文件，校验异常保留原始错误，清理失败同时暴露原错误与清理错误。发布已开始时拒绝取消，接口返回 409。
- 前端：Node 89 项、Vitest 731 项通过；静态生成成功，32 条路由。日志：`tmp/phase3-final-frontend.log`、`tmp/phase3-final-generate.log`。
- 桌面启动及相关契约：128 项通过。日志：`tmp/phase3-final-desktop.log`。没有进行 Electron GUI 人工验收。
- 最终默认 sdist → wheel 构建成功；两包均为 213 个文件，209 个包内源码 / 资源与当前工作区逐字节一致，8 份 HTML 资源完整，没有旧 DLL / PYD / EXE、Hook wheel 或 `node_modules`；保留现有 SNS WASM。证据：`tmp/phase3-final-build/contents-proof.json`。wheel SHA-256：`c5d602e6eea568a4753894dee03a04b52e4050904d848c575ebdd976437beb17`。
- 源码入口和已安装 wheel 命令行入口都通过真实 TCP 启动检查：缺省 `offline/decrypted`，`wx_key` 未加载，旧 client / broker / lease / telemetry / 外网连接探针均为 0；联系人 HTML 的 HTTP 样式字节、CSP 及最终内容 SHA-256 均通过。证据：`tmp/phase3-startup-proof/report.json`。wheel 使用 `--no-deps` 安装、复用项目现有依赖，不是全新联网依赖安装验收。
- `git diff --check` 通过。
- 全仓 Python 尝试在早期失败后停止，未跑完：已定位 `tests/test_ai_agent.py` 的 `FakeTools` 缺少 `latest` 方法，独立和旧模式均可复现；本轮未修改无关 AI 实现，也不将受影响测试通过表述为全仓通过。日志：`tmp/phase3-all-python.log`、`tmp/phase3-ai-native-compare.log`。

## 尚未完成（按最新基准更新）

1. WEC 加解密与 WES 旧签名的独立实现和可信测试向量。
2. WXGF 动画保真及无本地 DLL 的完整源码实现。静态图片已复用本地 DLL 验收通过，完整重写不作为解除既有期限授权链的前提。
3. 全部真实图片、视频、表情、文件、合并记录及缺失资源场景的客户端验收；已验证上述 3 条语音及新增 6 份 WXGF 静态图片，不能代表全部媒体类型。
4. 手动开启的 30 秒刷新在长时间高频真实写入下的验收。
5. Electron 图形界面的完整人工流程及安装包发行验收。安装包构建 / 发布仍按前序决定暂停；正规签名发行不作为当前目标的前提，Python 构建和前端生成仍不等于完整发行验收。

默认独立运行与主要导出路径已脱离已确认的期限授权链；上述格式覆盖及长时间验收仍有边界，不将当前结果表述为所有旧格式和全部媒体完全兼容。

## 后续代码收尾：用户要求解决可由代码解决的余项

本节承接上面的首轮记录。用户确认没有 WEC / 旧签名规范，继续将其列为未完成；没有用旧原生组件冒充独立实现。

### 代码修正

- MP4 原先只识别文件头、部分路径直接复制，不能证明文件可播放。现检查容器声明长度并通过已有 FFmpeg 完整解码视频和音轨；拒绝损坏、截断、零帧和缺少解码器的情况。单文件上限 120 秒，既有导出取消贯通普通与合并记录视频，并回收实际子进程和临时文件。
- DAT 按已有算法检查 15 字节头、版本、AES 声明明文长度、PKCS#7 完整块与 XOR 尾段边界，合法的对齐长度仍可解密。
- 复核复现了媒体密钥库权限错误被吞后仍可用旧缓存成功解密的路径。独立模式改用已有 `load_account_keys_store(strict=True)`，同一次严格读取用于优先级判断和字段补全；损坏 JSON、非对象账号记录和手动缓存读取错误直接暴露，正常缺少记录仍允许明确保存的手动密钥，显式 native 行为不变。
- 合并记录外层 `recorditem` 原先被正则在同名内层结束标签截断，改为结构化读取 XML / CDATA。已知图片、表情、MP4 和文件复用独立媒体出口，覆盖 TXT / JSON / Excel / HTML；未知媒体类型明确失败。精确 MD5 文件名可以找到任意扩展的普通附件；HTML 合并记录支持文件下载和无封面视频打开。
- 解密页的平台能力请求失败不再构造 Windows 成功结果；显示原错误并提供重试，图片扫描要求后端明确返回 `true`。

### 新增验证及边界

- 新增 7 项 WAL / 刷新压力用例，实际 SQLite 连续提交、真实 30 秒定时、WAL 截断和换代、并发读取固定代次、半帧、复制中追加 / 截断 / 替换、显式重试及账号切换 / 删除均覆盖。相关 7 文件为 160 passed、1 skipped；跳过项是平台符号链接权限。本组使用隔离夹具、生产加密辅助函数以及同一受控表作为三种数据库角色，不能证明跨库事务原子性或长时间真实微信写入。
- 合并媒体 / 视频 / 取消等最终组合为 98 passed；DAT / 图片相关组合为 132 passed、9 subtests。这些组有交集，不相加作为独立总数。
- 合并媒体在真实 Chrome 本地文件中回读：GIF 3×3、MP4 16×16、文本附件链接可用，无脚本错误和 HTTP(S) 请求。证据：`tmp/merged-media-browser-report.json`。输入为受控可解码媒体，不是完整真机媒体验收。
- 再次使用已验证真实快照的隔离副本，21 库 / 160 会话中 100 条消息的 JSON ZIP / HTML ZIP / HTML 目录回读一致，原快照摘要不变，旧组件及源写入探针 0 次；3 条真实 SILK 再次解码为 WAV。证据：`tmp/phase3-real-exports/run-6/report.json`、`tmp/phase3-real-exports/voice-3/report.json`；没有重新采集微信数据库。
- 前端最终 Node 89 passed、Vitest 735 passed；32 路由静态生成成功。桌面启动契约 128 passed。日志：`tmp/phase3-followup-frontend.log`、`tmp/phase3-followup-generate.log`、`tmp/phase3-followup-desktop.log`。
- 最后媒体密钥严格读取及媒体 / 导出 17 文件组合为 225 passed、9 subtests（包含 16 个新增用例）；既有有效密钥优先级、来源绑定和部分手动字段补全均验证，没有依赖伪造解码成功。日志：`tmp/phase3-media-key-final.log`。独立复核再次使用原损坏配置和权限错误复现路径，分别得到原始 `JSONDecodeError` / `PermissionError`，源文件不变：`tmp/dat-key-error-audit/closed-report.json`。
- 严格读取修正后重新执行 sdist → wheel：两包各 214 文件、210 份源码 / 资源与最终工作区逐字节一致，8 份 HTML 资源齐全，旧原生二进制 / manifest / Hook 包均为 0。新 wheel SHA-256 为 `c4eb7b7b253ca946041e1feeacacb905d4296f721c991a280b8e489de2b48826`，取代首轮构建摘要。源码及已安装 `wechat-decrypt.exe` 真实 TCP 启动均为 `offline/decrypted`，旧组件及外网失败探针均 0 次，HTML / CSS 真字节及清单核对通过。证据更新至 `tmp/phase3-final-build/contents-proof.json`、`tmp/phase3-startup-proof/report.json`；复用本机依赖的边界不变。
- 测试维护明确划分默认独立与显式旧模式，修正缺少真实账号 / 发送者结构的夹具及 Windows 临时目录工作目录释放顺序；没有为测试更改生产发送者或账号业务。实际旧 WEC / 签名集成在 offline 下明确跳过，显式 native 且缺组件时仍失败，跳过不代表兼容完成。
- 全仓发现年度总结既有业务冲突：测试要求排除所有 `@openim`，共享会话规则允许普通 `@openim`。使用精确 HEAD 的两个相关生产模块和测试、真实隔离 SQLite 复现同样的 7 对 2 失败；未擅自改统计口径。证据：`tmp/wrapped-head-audit/report.json`。这是一处另外的待确认业务规则，不能把本轮回归表述为全仓全绿。
- 全仓 Python 本次已跑完：3694 passed、17 skipped、4 failed、273 subtests，785.93 秒；日志 `tmp/phase3-followup-full-final.log` 和 XML 同名文件。4 个失败包含上述年度总结冲突，以及 3 个 UI bridge 测试未隔离 Qt 窗口枚举的夹具问题。全仓运行在最后媒体密钥读取修正前启动，该修正使用前述最终 225 项关联回归另验，因此不将单次全仓运行表述为所有最终改动的完整全绿结果。
- 上述 3 个 UI 测试失败已在假 OS 边界下复现并修正：三套 legacy 测试构造 bridge 前隔离 Win32 / ctypes / psutil 引用，自动恢复，避免改写共享模块及访问真实桌面。保留原窗口缺失、锁释放和剪贴板断言；相关 13 文件最终 311 passed，18.03 秒，测试全程不操作真实窗口 / 剪贴板 / 键盘。日志：`tmp/phase3-ui-isolation-final.log`，红 / 绿专项：`tmp/phase3-ui-isolation-red.log`、`tmp/phase3-ui-isolation-green3.log`。生产发送逻辑未修改。修正后复跑范围为相关组，全仓全绿仍未经验证，年度总结规则冲突仍未处理。

当时 WEC / WES 再查固定上游提交仍只有原生 ABI 调用和开发签名脚本，缺少独立密码学实现与可信生产测试向量。WXGF 公开实现依赖分片扫描和比例 / 帧率猜测，当时也未取得可靠样本。后续用户提供目录后，已找到真实 WXGF 并复用本地解码库完成静态呈现验证；当前状态与剩余边界以上方最新验收基准为准。
