# 剩余功能与真实验收计划

> **For agentic workers:** 使用 Superpowers 的逐项执行与验证流程；各项取得明确证据后更新状态。

**Goal:** 先完成剩余功能和可执行验收，暂不进行任何删除式代码清理。

**Architecture:** 延续默认独立 Python 后端、现有固定快照与媒体出口。先追踪实际失败或证据缺口，再做最小变更；不以旧链路回退、跳过验签或模拟成功替代实现。

**Tech Stack:** Python / FastAPI / SQLite、Nuxt、Electron、既有本地媒体组件。

**Spec:** 本轮用户“先完成未完成的功能任务”；前序 [独立运行计划](2026-10-04-independent-default-and-exports.md) 与 [表情及动画验收](2026-10-04-local-emoticon-and-wxgf-animation.md)。

## 约束

- 删除式清理暂停，保留现有未提交业务变更、数据、密钥和验收材料。
- 微信源目录只读，不代用户发消息、不伪造真实客户端写入、不改全局刷新设置。
- 本任务同类必要密钥读取和核验已获授权；仍限定当前账号与实际任务，不输出或上传密钥。
- 安装器构建／发布沿用此前暂停决定；Python sdist／wheel 验证可以继续，不混称安装发行完成。
- 真实观察、受控压力、源码／安装包、浏览器／Electron 验证分别记录，不混用证据。

## 当前事实

本地 Persist／PersistStore／月缓存解码与 WXGF 动画已实现，日常密钥记录已补齐 code。真实 7 消息／10 ZIP 验收和最终 89 项关联测试通过，此项不再列为未完成功能。历史文档较早的动画“不支持”和单帧验证描述保留为历史记录。

## 执行项

- [x] **WEC／WES 实现。** 独立 WEC 加解密、WES 历史验签、旧 ZIP 双签导入均已接入；WEC/WES2 真实样本互通、两实现交叉审查通过。WES1 固定构建实现和受控验证完成，真实正向旧归档验收仍缺样本，单列于下文。
- [x] **真实持续刷新。** 已完成修复后的 600.05 秒窗口、实际新增负载统计、旧/新 reader 与逐代 SQL／API／JSON ZIP 对照，细节见下文；不将实测速率扩展为任意高频保证。
- [x] **Electron 使用流程。** 真实隐藏 Electron 窗口验证账号进入、7 条实际媒体消息、5 个本地表情、HTML/JSON 导出及用户确认的视频预览生成/取消/画面播放；产物独立回读。不是人工完整验收。
- [x] **最新源码包安装验证。** WEC/WES 接入后重新构建 sdist→wheel，218 个业务文件及 README 核对通过；全新安装目录 290 项测试通过，实际默认后端启动正常。复用本机依赖，未构建安装器或 frozen 后端。
- [x] **本轮收口。** 汇总完成事实和无法补齐的真实样本边界，独立复核生产变更与证据。未开始删除式清理。

调查脚本与私人数据只存已忽略的 `tmp/`。全局记录不会因整理计划而改动。

## 本轮新增事实（2026-10-04，持续更新）

WEC/WES 已接入并完成本轮验证：算法、nonce/AAD、封装布局和固定构建信任配置已恢复，先前“未知算法/格式”段落为当时调查记录。公开算法向量及真实旧组件合成 WEC/WES2 向量已通过独立对照；WES1 仍无真实正向签名样本。用户已明确选择 WES 按签名生成时有效验证，允许历史归档日后导入；两套签名与内容/身份/构建绑定不能省略。WES2 设备自签不称为根授权证明。用户确认以前没有保留 ZIP，不再等待档案输入。

### 旧 ZIP 签名验证

- 已支持默认独立模式导入完整 `manifest.wce` / `signature.wce` 签名对。固定信任原组件 runtime 中的 P-256 公钥，重建同一 manifest 的规范 UTF-8 JSON 后验证 ECDSA/SHA-256；不加载签名原生组件、不接受归档自带公钥。
- 复用原有路径、文件覆盖、分阶段导入与发布流程，在发布前逐文件核对已签名的大小和 SHA-256。取消、损坏、未知签名者及混合完整性格式均明确失败。
- 受控真实签名夹具与出处位于 `tests/fixtures/legacy_wce/`，不含用户数据或私钥。根独立运行 `test_legacy_archive_signature.py`、`test_offline_legacy_archive.py`、`test_archive_checksums.py`、`test_account_archive_cross_platform.py`：135 passed。实现者扩展到 independent account archive 共 155 passed。
- 此项不是 WEC1 解密，也不是 WES1/WES2 authority envelope 验签；默认导出仍为 SHA-256 清单，不能混称旧签名发行能力已恢复。

### 真实持续刷新：首轮失败记录，未达到 10 分钟

- 用户手机配合；正式窗口从 21:00:34 开始，目标 600 秒。第 11 代后，363.45 秒时采集在 `session/session.db-wal` 哈希期间遇到微信写入，明确报 `source_changed`，观察器与 reader 停止。已通知用户停止发送。
- 已保留代次的独立 SQL 身份/时间审计得到 45 条真实新增：文字 26、图片 3、表情 11、文件类型 5；新增时间跨度 287 秒，滚动 30 秒峰值 11 条。以上是实际负载，不扩展为任意高频保证。
- 全类型身份审计不证明附件内容已解码或导出。文字 reader/API/SQL/JSON ZIP 的逐代检查另存报告。
- 证据目录 `tmp/phase3-live-filehelper-ready-20261004-205645/`；失败报告保留，后续修复或重验不会覆盖成成功。正在检查一致性采集边界，不增加静默重试或忽略变化。

#### 已提交 WAL 前缀原型与第二次用户短测

- 依据 [SQLite WAL 锁协议](https://www.sqlite.org/walformat.html)，Windows 原型持有主库读锁、SHM 生命周期锁、checkpoint/read 锁，固定已校验的 WAL-index 提交边界；允许边界后的普通追加，不写源库/SHM，不写 readmark。复制同一打开文件身份的主库及已提交前缀，并重复核对这些固定字节；不复制尚未提交的尾部。
- 受控真实 SQLite 双连接：固定快照时另一连接提交 100 次，捕获快照仍为原来的 1 行，当前库为 101 行；checkpoint 在固定期间报告 busy，释放后成功。没有重试。
- 用户第二次配合的 60 秒短测于 21:23:05 开始，43.953 秒时一次捕获真实 `session.db` 的 7 个已提交密文 WAL 帧（28,872 字节），通过 WAL 校验、页面 HMAC 和 SQLite integrity_check；随后已通知用户停止。
- 证据 `tmp/snapshot-wal-capture-next/{controlled-report,real-report,short-report}.json`。原型验证不等于正式刷新已修复或新一轮 600 秒通过；生产接入和异常释放测试进行中。结果保证必须区分逐库已提交前缀与跨库全局事务。

### Electron 媒体入口发现真实缺陷

- 使用隔离账号、真实消息及真实源媒体启动 Electron 后，发现消息列表在仅有加密本地缓存时仍向页面提供 CDN URL，没有调用本地 emoji endpoint。
- 修复范围限定在默认离线模式的两个 URL 装配入口：有真实 MD5 时使用既有本地接口，远程地址保留用于用户显式下载。缺失和密钥/身份错误由既有本地 GET 明确返回，不新增列表扫描或解密。
- 两入口修复已完成；根独立跑 URL、本地错误和容器集成共 25 项通过，另一执行者交叉审查无阻塞。最终真实 GUI 重验已通过，见下文。

### 首轮源码包安装验证（最终重建结果见下文）

- `uv build --sdist --offline` 后显式以该 `.tar.gz` 为输入构建 wheel；两包内各 214 个源码/资源逐字节对照当前源码，唯一二进制为 `native/VoipEngine.dll`。
- wheel 安装至新的 `tmp/remaining-functional-build/installed/`。从该安装目录运行本地表情、WXGF 动画、code 保留、旧签名归档及消息 URL 行为测试共 146 passed；逐一检查全部已加载业务模块来自安装目录。
- 未设置 data mode，实际运行已安装的 `python -m wechat_decrypt_tool.backend_entry`，健康接口返回 `offline` / `decrypted`；旧 client、broker、lease、签名原生组件和外部 socket 调用探针为零，结束后回收自有后端。
- 证据 `tmp/remaining-functional-build/{contents-proof,installed-tests-report,startup-report}.json`。复用项目现有依赖，不等于全新机器安装；未构建安装器或 frozen 后端。后续若修改生产快照代码，需要重新构建验证才可称最终包。

### WEC1 / WES1 / WES2 的明确缺口

- WEC1 已知头、分片边界、32 字节显式内容密钥和调用 ABI；缺少 alg1 的具体 AEAD、salt 到 key 的派生/域串、记录 nonce/计数规则、AAD/头绑定及终块认证规则。不能由字段长度推断密码学算法。
- WES1/WES2 仅有 magic、封装长度边界和 verify ABI；缺少字段布局、签名字节范围、信任根及轮换/版本规则。旧 `manifest.wce` 的 P-256 根不能挪用于 WES。
- 仓库没有 `wechatdb_client.dll` 或对应原生源码目录；现有测试通过原生动态生成，未找到固化可信向量。只有测试伪头的文件不作为兼容证据。后续沿现有桌面 bootstrap 定位到用户目录中原 v2.4.0 缓存 DLL，SHA-256 与项目固定值 `59fdf95ba7eae4bc20c971fd28f714f154a54c84ab0b06184af5eb15ad33a06f` 一致；静态确认含 `wce_export_verify_seal`，证据 `tmp/legacy-format-next/pinned-runtime-static-report.json`。这修正了组件位置判断，但还没有真实 WES 正向向量或独立密码学实现；未启动旧 broker 或恢复 lease。
- 恢复独立兼容需要精确版本的可信实现/格式依据以及合成已知密钥和明文的正负向量。此项仍未完成，不绕过认证、恢复租约依赖或伪造支持。

### HEVC 桌面预览：用户已确认的修复范围

- 默认 GPU 的真实 Electron 播放 HEVC/AAC 样本时，播放时间推进但 `videoWidth` / `videoHeight` 与解码帧数为零，只有音频。源码视频本身为 640×368 HEVC，不是无视频轨文件；不能据播放时间判为画面通过。
- 用户明确选择增加“生成本地预览”按钮。按显式操作生成 H.264 预览副本，原视频与导出字节保持不变；不自动转换、不将错误隐藏成播放成功，取消和错误需完整暴露。
- 该项实现已完成：原 MP4 边界校验、转换前后源摘要、FFmpeg 严格错误、完整输出解码、账号独立缓存与摘要验证，成功后原子发布。只在显式点击时调用，支持关闭/切换/取消，原始 GET 与导出字节不变。
- 真实 HTTP 中间件曾使 `Request.is_disconnected()` 一直返回 false；已用真实两层中间件与真实子进程复现，改为 bodyless POST 专有 receive monitor，并保持账号任务租约到实际子进程回收。破损输入曾被 FFmpeg 修复成成功，已复用既有 MP4 边界校验在转换前拒绝。两次失败证据均保留。
- 最终 `tmp/electron-real-media-20261004-9/`：HEVC 原片无画面时暂停并显示按钮，用户式点击生成→取消后真实 FFmpeg 退出且无部分文件→再次生成，得到 640×368、71 个解码帧、2.26 秒实际播放。700px 最小视口内按钮可见。原文件摘要不变；5 个表情所有帧/时序/循环与源 oracle 一致；HTML/JSON 两个 ZIP 校验和、引用及载荷一致。隐藏真实窗口自动化与测试专用目录选择结果均在报告注明，外部请求与 UI/API 错误为零，自有进程已退出。
- 前端 Node 89 项、Vitest 756 项通过，静态生成通过；视频后端及相邻链路最终 47 项通过，独立审查视频/WAL/快照/注册表 86 项通过。最终源码全量回归和新包验证另行记录。

### 正式 WAL 接入与修复后 600 秒真实验收

- 已接入 `windows_wal_capture.py` 与现有快照/刷新/注册表：只读同句柄主库、SHM、WAL，按 SQLite 锁协议固定提交前缀；坏头、锁忙、文件身份变化直接失败，不隐式回退或重试。精确支持 SQLite 恢复生成的全零初始 index 状态；非该状态仍执行页大小校验。
- 注册表核对每库提交边界、前缀长度、数据库集合和 guarantee 一致性。整批在线源返回 `per_database_committed_prefix`，混合来源为 `mixed_per_database_capture`，静态源保持 `stable_observation`；不声称在线全源不变或跨库事务。
- 本机 Weixin 4.1.15.13 静态 VFS 锁偏移证据、受控并发、真实短测和正式验收相互补充，见 `tmp/snapshot-wal-capture-next/protocol-evidence.json`。静态包含兼容实现本身不等于证明所有版本运行时绑定。
- 用户配合正式窗口为 21:39:00.938697 至 21:49:00.938697，实际观察 600.05 秒、19 次检查、14 个已发布代次；每代固定 24 源库，21 个业务库页面 HMAC/WAL/SQLite integrity 全通过，6 代含非零已提交 WAL。已及时提示停止发送。
- 21 轮实时配对检查与全部 14 代重核：旧文本 reader 始终 183 条，新文本 reader 最终 200 条；SQL、API、JSON ZIP 逐条身份、时间、发送者、方向、内容一致。
- 全类型实际新增 47 条：文本 17、图片 8、表情 19、`25769803825` 文件类型 3；消息时间跨度 516 秒，9 个非空 30 秒桶，滚动 30 秒峰值 10 条、60 秒峰值 13 条。该项只核消息身份时间，不冒充新增附件内容全验。
- 最后源检查 21:48:43.142808，最后发布 21:48:13.060295；未附加窗口外捕获。微信源写入 0、全局密钥不变、冻结源码摘要不变、旧原生/租约调用为零，observer/reader/两项审计均 exit 0 且退出。
- 完整证据 `tmp/phase3-live-filehelper-wal-20261004-214200/{acceptance-summary,report,reader-export-v2-report,generation-reader-export-report,all-type-identity-timestamp-report}.json`。旧失败目录仍保留。

### 2026-10-05 自动同步遗留 SHM 修复

- 真实日志在 `_source_manifest` 阶段报 `source_inactive / Existing SHM has no active SQLite VFS owner`。原实现只根据 SHM 存在选择在线采集，任何连接关闭后遗留的 SHM 都会停止整个账号同步；报错后只读探测时 24 个源库已全部活动，不能据此断言报错瞬间的具体库名。
- 采集前根据 DMS 所有权选择协议：有活动 owner 维持已提交前缀；无 owner 保持独占 DMS 锁，执行现有完整主库/WAL 的大小、时间和 SHA-256 稳定观测，不信任遗留 SHM 头，也不伪造提交边界。活动库坏头、锁忙、文件变化仍明确失败；没有从在线错误恢复或自动重试。
- 真实 SQLite 正常关闭遗留 sidecar 的新测试先复现 6 项 `source_inactive` 失败；加密快照测试亦先复现同一失败。五文件相关检查中其余 105 项通过；重开连接测试的初始 BUSY 断言按 SQLite 官方 WAL 内部循环会返回 PROTOCOL 的行为修正，且在释放 Windows 强制字节锁后比较完整 SHM 内容。最终 Windows 文件 16 项复测通过，其余四文件 90 项已通过，共覆盖 106 项相关用例，未重跑源码全量回归。
- `tmp/autosync-shm-20261005/real-report.json`：只读实际微信源，24 库固定提交边界、21 个业务库认证与完整性全通过；两库真实加密数据的关闭副本带不可信 SHM，稳定观测恢复通过且解密结果与在线版本逐字节相同。本次真实来源捕获的两库提交帧均为零，非零 WAL 的关闭恢复由受控认证用例验证。
- `tmp/autosync-shm-20261005/refresh-report.json`：实际刷新服务在隔离输出完成发布及第二轮检查，修订号 1、worker 正常退出。源及原 output 写入审计无记录，原密钥文件摘要不变，未发布到原账号；当前已运行桌面进程仍须重启才能加载新代码。本轮未要求真实客户端新发消息或重新执行 600 秒持续发送验收。

### 2026-10-05 部分群聊加载失败修复

- 原读取层在解析消息 XML 之前要求非系统消息必须有非空 Name2Id 映射。当前真实快照的群聊历史中，45 条原生拍一拍与 7 条原生视频使用空的映射项，但真实身份分别位于 `msg/appmsg/patinfo/fromusername` 与 `msg/videomsg/@fromusername`。聊天、预览和导出/AI 的读取入口先读取这些明确的格式字段，再执行身份校验；发送方向使用真实发起者与已解析的账号身份比较。缺身份、畸形 XML、普通消息缺映射仍失败，引用和转发内容不能代替当前消息的发送者；没有跨分库使用相同 rowid 或添加默认身份。
- 另一群的两条合并转发记录原始 XML 均合法，解压后全局 `html.unescape()` 把引用文本中的实体编码 XML 声明激活为标记，破坏内层 recordinfo。传输解码现保留原文，字段读取只展开当前标量的非 CDATA 实体，结构块留到下一层读取；后续 URL 消费点移除重复解码。原严格合并记录校验保留，畸形数据不修补或跳过。
- 发送者、压缩/编码载体、CDATA、标量显示、URL 单次解码与转发作者隔离用例均先复现失败。最终 25 文件相关回归为 **307 passed、2 failed、14 subtests passed**；两失败为旧测试要求已移除的 realtime 请求值/sourceFallback 字段，临时仅撤销本轮初始身份修复的 baseline 同样复现。初次缺 FFmpeg 的视频项指定本机已有 desktop 二进制后通过，未安装依赖或修改长期环境；未重跑源码全量回归。
- 最终独立只读复核未发现阻塞问题，相关测试 **117 passed**；47 群的 76 条原生拍一拍/视频逐项核对 XML 身份，其中 24 条已有非空映射，解析异常和映射身份冲突均为零。保留了既有群发送者前缀处理，未把验证脚本初次遗漏前缀剥离造成的异常归咎于源数据。
- `tmp/group-pat-sender-20261005/real-report.json`：当前修订号 4 的 21 库快照复制到隔离输出后，截图报错群、对照群及合并记录报错群的真实 HTTP 路由均返回 200；47 个群的最新页共 1,124 条消息、160 个会话预览以及 21,997 条历史身份读取流均无错误。11 条拍一拍与两条合并记录的导出/AI 消息读取验证通过，模型调用为零。历史流验证身份读取，不代表所有历史消息都完成媒体导出或图形界面验收。
- `original-unchanged-report.json` 确认原 21 库和账号密钥文件在验收后摘要完全不变；原源目录/output 写入审计无记录。运行中的桌面后端仍需重启以加载本轮源码；没有写入原账号、重新解密用户数据或重建发行包。测试 XML/日志与逐步失败证据保留在上述临时目录。

### WEC/WES 隔离向量生成的继续查证

- 缓存 client、broker、build JSON 三者均与仓库固定清单 SHA-256 相符；静态 metadata 的 offline bootstrap 允许 export，现有 client 有不触发 lease refresh 的直接 API，因此并非永远无法生成合成向量。
- 但 broker 导入 WinHTTP/WS2_32 与 NCryptCreatePersistedKey；只改数据目录不能隔离当前用户 CNG key store，Python socket 探针也不能证明子进程不联网。当前尚无已验证的 OS 无网运行域和临时密钥隔离，未启动 broker。具体最小合成向量与隔离条件存 `tmp/legacy-format-next/oracle-feasibility.json`。
- WEC/WES 独立实现继续保持未完成，不能拿上述旧 ZIP 签名、静态导出符号或其他格式成功代替正向可信向量。

### 冻结源码的最终 Python 包验证

- `tmp/remaining-functional-build-final/`：从源码生成 sdist，再显式以该 sdist 构建 wheel；两包各 220 个总文件，其中 216 个业务源码/资源逐字节匹配冻结源码，最终 README 也匹配，唯一二进制仍是 `native/VoipEngine.dll`。没有带入旧 client/broker、缓存、用户数据或前端依赖。
- wheel 安装至新的隔离目录，172 项行为测试通过，零失败、零跳过；67 个已加载业务模块全部来自该 wheel。覆盖本地表情、WXGF、code 保留、旧 ZIP 验签、消息 URL、视频转换/取消/损坏输入与 Windows WAL。
- 真正启动已安装的 `python -m wechat_decrypt_tool.backend_entry`，未配置 data mode 时健康接口仍是 offline/decrypted；旧 native/lease/签名组件及 Python 外部 socket 探针无记录，自有后端退出。仅证明对应探针覆盖，不能当作全系统网络隔离证明。
- 复用本机依赖，未验证全新机器依赖安装或 Electron 安装器/frozen 发行。最初测试辅助模块路径缺失只修正隔离脚本的 sys.path，初始日志保留；生产源码未变化。
- 最终报告 `tmp/remaining-functional-build-final/final-build-report.json`，源码全量回归另行记录。

### 当前源码全量回归

- 宿主权限、指定本机既有 FFmpeg 下运行全量 Python suite：3,945 passed、17 skipped、273 subtests passed，耗时 646.90 秒；唯一失败为 README 仍断言“不提供旧签名”的过时文本。
- 该断言已更新为分别验证新 ZIP 的 SHA-256 边界及旧 ZIP 固定公钥验签导入，原文件全部 6 项复测通过。没有为此修改生产实现或已验收包；全量初始失败日志保留 `tmp/remaining-functional-full-regression.log`，未冒称该首次运行零失败。

### WEC/WES 原生向量的签名启动阻断定位

- 动态 WFP 隔离与临时 CNG 名称方案已通过实际 IPv4/IPv6 TCP/UDP 接收验证：隔离前后四项送达，隔离期间零送达；动态规则和子层均已回收。真正启动时限定 Python 直接父进程和 broker，未运行数据库、租约或账号操作。
- `tmp/wfp-oracle-next/run-881e2dea7a0f4b9e8412fc662b222e65/` 中原 broker 因 `Broker code signature validation failed` 返回 20，尚未生成真实 WEC/WES 向量；自有进程、动态规则和子层已回收，未生成临时 CNG key。
- 静态分支显示原组件明确允许特定的单叶证书 `CERT_E_CHAINING`，因此缺少私有根证书不是已证实的根因，不安装私有 Root/CA。额外强制项是可信时间戳链错误必须为零。
- 同语义的只读、仅缓存 WinVerifyTrust 诊断显示 TSA 三张证书链完整且根已可信，但叶和中间证书的吊销状态为 `0x01000040`（未知/离线），与原生拒绝条件吻合。去掉吊销检查所得成功链不作为有效通过证据；真实隔离 broker 内部状态未 hook，诊断边界保留。
- 静态证据 `tmp/legacy-format-next/broker-signature-static-report.json`，公开证书与 WinVerifyTrust 证据 `tmp/wfp-oracle-next/signature-readonly-report.json`。下一步仅考虑正常获取、验证公开 TSA 吊销状态缓存，保持原组件、时间、信任库与校验策略不变；没有进行根证书安装或原生校验补丁。

### 旧签名导入的模式绕过修复

- 后续入口审查发现显式 native 模式跳过 `_archive_integrity_entries()` 的签名入口，篡改或缺失签名的旧归档仍可被预览、解压和导入。红测实际观察到 SSE `complete`，不是仅靠源码推断。
- 生产仅移除该入口的 offline 条件，使所有模式复用同一独立验签器；未改变签名规则、引入旧运行时调用或删除其他功能。
- 新增有效真实签名 fixture 的预览/解压/实际导入，以及篡改、缺失签名在三个阶段拒绝、目标不发布、输入不变的行为测试。相邻五组 169 项通过，测试临时目录 `tmp/wes-static-review-next/native-mode-green1/`；回归测试位于 `tests/test_legacy_archive_signature.py`。
- 此修改发生在上述最终 wheel 之后，后续交付须重建包；WES 格式接入仍等待真实向量。只读接入审查为 `tmp/wes-static-review-next/integration-review.md`。

### 真实 WEC / WES2 向量与独立互通

- 仅获取证书自带的两条微软公开 CRL URL，使用 [Windows 正式 PKI 获取接口](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-cryptretrieveobjectbyurlw) 验证发行者签名、当前有效期与目标序列号，并核对缓存回读完全一致。不修改 Root/CA 信任库、原组件或时间。完整吊销策略的 cache-only WinVerifyTrust 复查中，两组件 TSA `dwError` / `chain_error` 均归零；前后报告分别保留。
- 原组件在隔离中生成 1、65536、65537、131089 字节四组 WEC，逐组真实加密/解密返回原文，并生成 WES2 简单清单与含旧签名对的四 sidecar 账号 ZIP。全部为公开公式数据，未读取微信用户数据、刷新租约或调用禁止路径；原生状态为 `BUILD_ACTIVE` / EXPORT。
- 独立 WEC proof 解密四组逐字节匹配公式原文/原生原文/摘要，使用各真实 header/salt 再加密的整个文件也逐字节相同；34 项独立篡改/结构负例拒绝。WES2 独立正向与三项负向结果对齐真实客户端；用户选定的到期后历史验证通过，严格当前时间策略相同条件拒绝。
- 本轮主体 `child-report.json` exit 0，但父流程最初因测试清理 `NCryptDeleteKey` 的 provider 不接受 `0x40` 参数而失败，原报告仍为失败。按 [官方 API](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptdeletekey) 及项目既有实现改为明确 flags=0，单次只删除该运行前不存在的唯一测试名称，两 provider 均独立回读不存在。自有两进程退出、八项 WFP 规则及子层已回收。该轮缺少异常之后的网络恢复 canary，不冒称本轮完成 4→0→4；前一次纯网络回合已有完整证据。
- 真实向量与报告：`tmp/wfp-oracle-next/run-f357699752f34a368106ddb0b7158fdf/{child-report,isolation-report,key-cleanup-followup}.json`、`vectors/independent-wec-proof.json`；WES 对照为 `tmp/wes-static-review-next/oracle-comparison.json`。WES1 仅静态规则与受控测试根，尚无真实旧 WES1 正向归档，不能混称其真实互通已通过。

### WEC/WES 最终实现、回归与新包

- `independent_wec.py` 复用既有头解析及 `native_core_export.py` 原子发布流程，在默认模式明确选择独立算法。聊天、朋友圈、联系人、记录与账号归档既有 API 接通显式内容密钥，不留任务密钥或生成的明文结果；单文件响应如实标记 WEC1。图形导入仍只接收 ZIP/目录，没有新增 WEC 图形入口。
- `independent_wes.py` 固定支持 `wcdb-prod-20260907-v240-6`，执行用户确认的历史签名时间策略。旧 ZIP 严格要求原签名对，附加 WES 时四文件齐全、规范清单字节相同、两套签名都有效；所有模式在预览和导入阶段均验证。额外修正两处原生单文件导出把 WES2 错标成 WES1 的响应。
- 真实公开 fixture 位于 `tests/fixtures/wec1/` 与 `tests/fixtures/legacy_wes/`，不含用户数据或私钥。两实现交叉审查无阻塞。最终全部导出/归档/导入相关 suite：544 passed、17 个原生专用项 skipped、33 subtests passed，27.25 秒；`tmp/wec-wes-export-regression.{log,xml}`。前一轮局部测试中新增缺密钥用例误用 folder 默认值，只修成明确 ZIP 请求后通过；不改生产以适配错误夹具。
- 最终 `tmp/remaining-functional-wec-wes-build/`：源码 sdist→显式以该 sdist 构建 wheel→新隔离安装目录。两包各 222 文件，218 个业务源码/资源和 README 与冻结源码逐字节一致，唯一二进制 `native/VoipEngine.dll`。wheel SHA-256 `78e1bbc2573849b476b7658dc691124e2768b6b421c0f93a7ff00630c560261d`；sdist SHA-256 `6a1e3f3cddf642a69a1ae03cd72fab05859ba5b659e07acf00949019ebff86d7`。
- 已安装包 290 passed、零跳过，79 个已加载业务模块全部来自新 wheel。实际 `python -m wechat_decrypt_tool.backend_entry` 默认 healthy/offline/decrypted；旧运行时/租约/遥测/外部 socket 探针无触发，自有后端回收。安装测试首次漏复制一个依赖测试模块，失败日志保留，仅修 tmp helper 后通过，未改变冻结生产源码。
- 用户明确“之前没保留过 zip 文件”。WES1 的真实历史归档验证无法从现有样本完成，记录为验收边界；没有等待用户输入的后台步骤，不为此伪造根签名或恢复租约。删除式清理、安装器构建与发行均未开始。最终报告 `tmp/remaining-functional-wec-wes-build/final-build-report.json`。
