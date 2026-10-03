# 微信图片与文件附件发送

实现与核验日期：2026-10-02（Asia/Singapore）。

## 使用与接口

Windows 桌面版聊天输入区的“图片”和“文件”均支持原生多选，也可以连续打开选择器追加。图片与文件共存于同一个待发送列表，每项可单独移除；附件区显示图片缩略图、名称、大小和目标会话。JPG/JPEG/PNG 从文件入口选中后同样使用图片预览和既有图片发送接口。

点击“发送附件（N）”按列表顺序逐项发送，不混发文字。每次明确成功后将该项移出待发送列表，下一项开始前等待 1 秒，遵守现有后端会话冷却。任意失败都停止本批次，保留当前及后续附件并显示错误；再次点击仅发送剩余项。现有 3 秒同内容防重仍生效，不跳过也不自动重试被限流的项目。

取消选择或整批选择中的任一读取错误保留原列表，不部分追加。切换账号/会话后不能向新目标发送或追加原列表，运行中的队列在下一项前停止；即使切走再切回也须重新点击发送。已经提交的当前项仍等待其结果，不能撤回它。关闭输入组件后不会继续发送后续项。

发送结果不确定或网络响应丢失时，当前项显示待核对提示，禁止直接重发、追加和移除该待核对项。人工“确认发送”仅清除对应项；人工“允许重试”仅解除其核对状态，二者均不会自动恢复队列。未提交的其他项仍可单独移除。文字仍单独发送，不随附件批次发送或清空。

`wechatDesktop.chooseImage()` / `chooseFile()` 对应既有 `dialog:chooseImage` / `dialog:chooseFile`，仅允许主窗口调用。取消返回 `{canceled:true}`；单选和多选统一返回 `{canceled:false,attachments:[...]}`。每个附件包含 `path、name、sizeBytes、kind`；`kind=image` 另带 `previewDataUrl`。原生层逐项校验并顺序构建预览，任一项失败直接抛出整批错误。选择器路径来自原生对话框；粘贴文件路径由 preload 从真实 `File` 提取，不提供 renderer 任意路径字符串读取接口。旧进程仍返回单附件格式时，前端明确提示重启，不隐式兼容旧格式。

新增 `POST /api/chat/send/file`：

```json
{"account":"当前账号","username":"filehelper","display_name":"文件传输助手","file_path":"G:\\资料\\报告.pdf"}
```

确认后的响应字段：`success、session、file_name、file_size_bytes、duration_ms、timestamp`。`success` 必须显式提供；表示本机微信出现相符的新文件卡片，不代表服务器送达或接收方已下载。`account` 延续既有语义：不会切换或核验微信当前登录账号。

文件入口验证绝对路径、存在、普通文件、可读，使用 `hashlib.file_digest` 流式 SHA-256；磁盘扫描在线程中执行。三种发送复用单飞锁、会话冷却和各自消息类型的内容防重命名空间。JPG/JPEG/PNG 直接调用文件 API 会明确要求改用图片 API。其余扩展名无白名单，软件不添加大小上限；客户端限制原样暴露。

错误沿用全局 `{code, detail}` 格式，包括 `WECHAT_FILE_PATH_INVALID`、`WECHAT_FILE_NOT_FOUND`、`WECHAT_FILE_UNREADABLE`、`WECHAT_FILE_SEND_UNSUPPORTED`、`WECHAT_FILE_BUTTON_NOT_FOUND`、`WECHAT_FILE_DIALOG_NOT_FOUND`、`WECHAT_FILE_DRAFT_UNCONFIRMED` 及既有草稿/会话变化/限流/未确认错误。异常记录调用阶段和是否已尝试提交；提交后错误统一保留为 `WECHAT_SEND_UNCONFIRMED`，前后端均不自动重试。

## 前一轮单文件真机观察与回执规则

测试使用当前 Windows 微信 4.x Qt 客户端，API 直接调用仓库源码 FastAPI 应用和真实桥接，没有替换桥接依赖。用户授权向“文件传输助手”发送一次 `.work/wechat-file-send-20261002.txt`（139 字节，仅测试说明）。

1. 先选入测试文件核对草稿。ValuePattern 和 TextPattern 均为一个 U+FFFC 对象，嵌入子对象数为 0；没有新增确认弹窗。只清除了本次探测产生的草稿，未点击发送。
2. 首次 API 调用在原生对话框阶段返回 `WECHAT_FILE_DIALOG_NOT_FOUND`，日志 `submitted=False`，没有发送。现场控件的“打开”按钮为 `ButtonControl`，以往观察为 `SplitButtonControl`，均为 `AutomationId=1`。现已统一按所属对话框、编号及这两种已观察类型定位；不是失败后切换路径重试。失败用例先复现，再修正并回归。
3. 取消本次失败留下的空对话框后再次调用同一 API，点击发送一次。微信右侧出现测试文件卡片，输入框清空。本次发送发生在 02:06，授权已使用，未再次发送。
4. 这次用于发现文件卡片属性的运行仍返回待确认；随后实现最终回执解析并只读验证它能匹配该真实文件卡片。最终 `success=true` 的完整路径有自动化测试覆盖，但没有为取得 HTTP 200 再发送第二份文件。

实际文件消息为 `ListItemControl` / `mmui::ChatBubbleItemView`，上传时的 Name：

```text
文件
进度: 10%
wechat-file-send-20261002.txt
139B
上传中
```

完成后的同一 RuntimeId 对应 Name：

```text
文件
wechat-file-send-20261002.txt
139B
微信电脑版
```

同次只读观察的普通文本消息为 `mmui::ChatTextItemView`，与文件卡片不同。最终判定要求：准确目标会话、草稿清空、恰好一个此前不存在的文件卡片、精确文件名及已观察到的完成格式。发送前快照包含未完成的旧消息，避免把旧上传完成误认成本次发送。上传中、未知格式、失败状态、同名旧卡片、普通文本以及多条同名新卡片都不能确认成功。

沿用 10 秒 UI 操作截止时间。大文件在此期限内未上传完成时进入人工核对流程；不取消微信上传、不自动重试，也不把未完成上传标记成功。只有单次定位后的发送按钮点击；原有剪贴板和旧客户端按键路径不用于文件发送。

## 前一轮单文件验证

后端相关回归（304 项通过）：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_chat_send_api.py tests/test_chat_send_image_api.py tests/test_chat_send_file_api.py tests/test_chat_send_adversarial.py tests/test_wechat_image_bridge.py tests/test_wechat_file_bridge.py tests/test_wechat_qt_image_ui.py tests/test_wechat_qt_file_ui.py tests/test_wechat_ui_bridge.py tests/test_wechat_qt_ui.py tests/test_ui_bridge_adversarial.py tests/test_ui_bridge_challenger.py -q -p no:cacheprovider --basetemp .work\pytest-file-send-verification
```

桌面 picker 14 项通过；前端文件、图片及原输入区四套测试 68 项通过；`npm run build` 成功。前端测试需在 `frontend` 目录执行以加载现有 Vitest/Vue 配置。测试夹具补齐 `EnumWindows` 隔离，避免未找到窗口的测试枚举真实桌面。

另在隔离 Electron 验证页加载当前真实 `preload.cjs`、`chooseChatFile` 和 `MessageInputWorkspace.vue`，由 UIA 操作真实 Windows 文件对话框，选中同一个 139 字节测试文件。IPC 返回路径、文件名、大小和 `kind=file` 正确，附件区显示目标会话且“发送文件”按钮可用。移除附件、重新打开对话框并取消均通过，全程发送调用数为 0。此层使用明确标注的验证会话，不连接真实账号，不替代正式账号从界面到微信发送的完整端到端测试。

本地证据保存在 `.work/file-ui-validation/evidence.json`、`file-selected.png`、`file-canceled.png`；真实微信发送截图为 `.work/file-send-result.png`。验证专用 Electron/Vite 进程已结束，原应用进程未重启。

未重建安装版 EXE。已有桌面进程需要重新启动才能加载新增主进程 IPC 与 preload 方法；前端热更新本身不更新这两层。

## 本轮多附件验证

- 前端 `npm test` 全套通过：Node 测试 75 项、Vitest 550 项；其中附件与原输入区相关 83 项，覆盖混合追加/多选、单项删除、取消及异常保留、顺序与冷却、部分成功后失败、人工核对、切换账号/会话及卸载中断。`npm run build` 成功，仍有现有重复导入、Browserslist、CSS 和 chunk 大小提示。
- 桌面原生选择器定向测试 22 项通过。全桌面测试 215 项中 214 通过，`Windows smoke temp directory helper restricts inherited ACLs` 失败，独立运行该用例仍失败：`Get-Acl` 无法自动加载 `Microsoft.PowerShell.Security`。进一步用 Node 子进程单独导入该模块，复现 `System.Security.AccessControl.ObjectSecurity` 的 `AuditToString/AccessToString/Sddl/Access/Group/Owner/Path` 类型数据成员已存在错误；直接 PowerShell 导入通过。该测试及 ACL 脚本无本轮改动；未绕过或修改系统安全配置。日志为 `.work/multi-desktop-tests.log` 与 `.work/multi-desktop-acl-repro.log`。
- 审查补齐图片回执错误分类：已尝试提交的图片若再抛出其他 `WeChatBridgeError`，也统一成为 `WECHAT_SEND_UNCONFIRMED`，保留原异常链和防重记录，与文件路径一致。先复现错误码不正确，再进行最小修正。相关后端回归 305 项通过（7 个现有弃用提示），日志为 `.work/multi-backend-tests.log`；没有运行完整 Python 测试仓库。复核确认无剩余问题。
- 本轮没有新的真实微信发送授权，不进行外发，不把组件或模拟边界测试称为批量真实送达验证。
- 隔离 Electron 原生界面核验通过：真实图片入口选中 `logo.png`，再通过文件入口一次混选 139 字节测试文本与 `zip.png`，列表共 3 项且两张图片真实解码显示。逐项移除文本后保留两张图片，再取消原生选择仍保留两项；`sendCalls=0`，未连接账号或发送接口。验证使用当前组件、preload 和 picker。证据与截图位于 `.work/multi-attachment-ui-validation/evidence.json`、`three-attachments.png`、`canceled-preserved.png`。

本轮未增加依赖或后端批量接口，未提交代码、重启用户应用或重建 EXE。使用新原生多选返回格式前，需要重启源码桌面应用。

## 2026-10-02 图片后续文件未发送：根因与修复

用户 09:33 的真实操作暴露了前述模拟测试未覆盖的问题：Qt 图片适配器即使观察到草稿清空和新图片气泡，也固定抛出 `WECHAT_SEND_UNCONFIRMED`，没有可到达的成功返回。队列因此停在图片确认，文件接口未被调用。前一轮“无剩余问题”的结论仅来自当时有限的自动化审查，不能视作真实混合发送成功。

本次只读检查再次确认图片气泡没有发送者、方向或子控件，矩形跨整行，不能依据位置或单纯气泡新增判定成功。现复用已有实时消息读取器补充方向证据，不使用解密历史快照或归档作为回执：

- 图片接口把所选 `account`、目标 `username` 传到桥接层。实时连接及读取预检失败时，返回明确的 `WECHAT_IMAGE_RECEIPT_UNAVAILABLE`，不提交图片。
- 点击发送前同时刷新数据库消息 ID 和界面图片 ID 快照。要求目标会话准确、单张图片草稿提交后清空、恰好一个新增图片气泡，以及同一账号/目标实时记录中恰好一条新的出站图片且 `server_id` 非零，才返回成功并让原队列继续文件。
- 旧图片、旧上传完成、入站图片、未取得服务器编号或多个候选均不作为成功依据。提交后查询异常仍归为 `WECHAT_SEND_UNCONFIRMED`，保留防重记录、未发送附件，不自动重试。
- 修复审查发现的快照时序问题：选择文件期间收到的图片不再计入本次点击后的新增气泡。提交后的并发图片仍可能导致暂停；批次期间不要在其他设备向同一会话并发发送。回执不证明收件人已下载或已读，也不声称识别了跨设备并发消息的图片内容。

验证边界：

- 先将原先预期“固定未确认”的用例改为成功要求，实际复现旧代码失败，再接入真实 SQL 读取逻辑。新增路由→真实桥接→真实 Qt 适配器→真实 SQL 的组合回归，只隔离外部 Windows/UIA 和加密数据库传输，不模拟发送成功返回；覆盖图片确认后发送文件及读取失败后停队列。
- 新确认器在真实账号中只读运行，识别到用户刚才的出站图片记录，并验证该旧图片不会确认一次新的发送。未新增任何真实外发，未读取或发送截图中的 `1.key`。
- 前端全套 `npm test`：Node 75 项、Vitest 550 项通过；日志 `.work/image-receipt-frontend-tests.log`。
- 后端发送相关最终回归 324 项通过（7 个既有依赖弃用提示），结果记录于 `.work/image-receipt-final.log`。独立审查发现的快照问题已补失败用例后修复并复核关闭。
- 完整 Python 回归未完成：初次全套运行出现失败后终止，按失败上限重新运行。在未配置原生组件的独立测试环境，`tests/test_account_archive_cross_platform.py::TestAccountArchiveCrossPlatform` 下 `test_exported_account_zip_round_trips_into_new_data_directory`、`test_extracted_archive_root_and_account_directory_are_both_recognized`、`test_tampered_archive_is_rejected_without_replacing_existing_account` 均报 `wechatdb native broker executable was not found`，3 失败、1 通过后停止，日志 `.work/image-receipt-suite-blocked.log`。未绕过组件校验或修改这些用例。
- 初次测试还出现 `tests/test_admin_server_error_logging.py::TestAdminServerErrorLogging::test_get_log_file_returns_current_backend_log_path` 失败，原因是本次测试命令额外设置的 `WECHAT_TOOL_OUTPUT_DIR` 覆盖了该用例自己的数据目录。去除该命令级变量后，整个日志测试文件 6 项通过；未修改生产代码或该测试来规避。

### 用户真实验收

1. 完全退出并重新启动当前源码桌面应用，使后端加载修复；安装版 EXE 未重新打包。
2. 在“文件传输助手”选择一张小 PNG/JPG 和一个无敏感内容的小 TXT，确保原生微信输入框没有遗留草稿。
3. 只点一次发送，期间保持微信窗口可用、不切会话，也不从其他设备同时发送。
4. 预期微信先出现图片，再自动出现文件卡片；本应用附件列表清空，两项均只发送一次。
5. 如仍提示待确认或留有附件，不要连续重试；提供错误码和截图，先核对微信中实际已有的消息。

## 2026-10-02 Ctrl+V 粘贴图片和文件

根因是聊天输入框此前没有 `paste` 处理器，图片、文件仅能经原生选择器进入附件列表，文本框默认行为只接收文字。现在 Windows 桌面版可在聊天输入框粘贴截图、复制的图片文件和普通文件，也支持一次追加多个附件。粘贴后先显示待发送列表，点击“发送附件”才发送。纯文本（包括文本形式的文件路径）保留浏览器默认粘贴，不解析成附件。

实现复用既有附件校验、预览、队列、目标会话绑定和发送接口。`wechatDesktop.importChatAttachments(File[])` 在 preload 使用 Electron `webUtils.getPathForFile` 取得磁盘文件路径；没有路径的截图或虚拟文件读取实际 `ArrayBuffer`，通过 `chat:importAttachments` 交给主进程写入独立临时目录。PNG/JPEG 沿用图片预览与发送，其余扩展名沿用普通文件处理。没有新增依赖、后端发送接口、全局快捷键或剪贴板轮询。

读取、解码或会话变化直接显示错误，保留原附件与文字，不部分追加、不自动发送或重试。主进程校验调用窗口、路径与字节格式，并阻止虚拟文件名目录穿越。同名虚拟文件使用不同路径；失败批次清理本批临时文件。成功导入的虚拟附件保留至应用正常退出，避免移除或发送途中删掉文件；正常退出只清理本次进程创建的目录，不删除原始磁盘文件。异常终止可能留下系统临时文件。

验证结果：

- 新增粘贴测试先在旧组件复现 7 项失败，接入后 8 项通过；附件及原输入区相关 91 项通过。
- 前端完整 `npm test`：Node 75 项、Vitest 558 项通过；`npm run build` 成功。仍有既有重复导入、Browserslist、CSS 与 chunk 大小提示。日志：`.work/clipboard-frontend-tests.log`、`.work/clipboard-frontend-build.log`。
- 桌面 picker 与 preload 定向测试 28 项通过；三份 CJS 语法检查及 `git diff --check` 通过。完整桌面测试 221 项中 217 项通过，`desktop/tests/windows-real-database-smoke.test.cjs` 中以下 4 项失败，涉及本次运行环境的 ACL 模块、DPAPI 用户配置和 CNG 密钥访问能力；未修改或绕过这些测试：`Windows smoke temp directory helper restricts inherited ACLs`、`Windows smoke credential helper fingerprints the DPAPI credential independently of its lease`、`Windows smoke CNG helper deletes the exact random software key`、`Windows smoke CNG helper fails closed for a wrong-algorithm collision`。
- Electron 40 隔离验证使用当前真实 Vue 组件、preload、IPC 导入函数与图片解码器：无磁盘路径的 PNG 截图，以及两个真实磁盘 `File`（TXT、PNG）通过 `ClipboardEvent` 追加三项；缩略图解码、目标显示、文字保留、单项移除和临时目录清理均通过，源文件仍存在，`sendCalls=0`。证据：`.work/clipboard-ui-validation/evidence.json`；截图：`.work/clipboard-ui-validation/pasted-mixed.png`。真实操作系统剪贴板与键盘 Ctrl+V 未改写或测试；未进行真实微信外发。生产 `main.cjs` 注册与退出钩子经源码检查，隔离验证调用同一导入和清理实现。宿主 Electron 仍输出系统加密失败日志，但未发生页面或 preload 错误。

生效需要完整退出并重启源码桌面应用以加载主进程和 preload；本次未重新打包安装版 EXE。

## 2026-10-02 图片撤回后无法显示

用户已确认 Ctrl+V 图片和文件粘贴正常，随后报告撤回图片显示破图，文件卡片仍可见。定位到防撤回归档与普通消息解析的图片标识优先级不一致：普通路径优先采用 `packed_info_data` 中的本地资源标识，归档却先取 XML 中的另一标识，且非空 `extra_json` 阻止后续规范化消息更新图片标识。撤回后重建消息使用了错误标识，图片请求返回 404。

读取真实日志及归档副本核对，故障行的原始 packed 数据和对应的 2124 字节 PNG 缓存都仍存在；没有读取截图所示 `.key` 文件内容。修复集中在 `anti_revoke.py`：新归档优先采用 packed 标识；解析后的本地标识可以补入已有记录；初始化时根据保留的 packed 数据修正旧归档的派生 `imageMd5`。原始消息、packed 数据、消息身份及撤回证据保持不变，仅含 XML 的后续重放不会覆盖已经解析的本地标识。不增加图片地址重试或网络兜底。

新增测试先复现 3 项预期失败，修复后 5 项通过。防撤回、查询、搜索、撤回导出及图片缓存相关回归共 56 项通过，另有 8 个子用例通过；日志 `.work/anti-revoke-image-final.log`。真实故障归档与缓存的隔离副本，经当前格式化函数及图片媒体处理函数返回 200、`image/png`，字节与保留缓存一致。证据 `.work/anti-revoke-image-diagnosis/evidence.json`；验证未修改正在使用的数据库，也未执行新的微信发送或撤回。

另外 3 项 HTML 图片导出测试没有通过：`test_html_export_materializes_image_md5_from_packed_info_data`、`test_prefers_message_resource_md5_over_xml_md5`、`test_falls_back_to_secondary_md5_candidate`。初次失败为测试环境未配置原生 broker；指定已安装的 broker 后仍因 `Cannot create device identity: broker unavailable` 在启动时退出，见 `.work/anti-revoke-image-export.log`。未绕过原生组件，未运行完整 Python 测试仓库。

完整退出并重启源码桌面应用后，后端首次读取归档时会修正旧图片标识，重新打开会话即可使用保留缓存显示图片。未重新打包 EXE；没有保留原始数据或本地资源的历史图片不在本次已验证的恢复范围内。
