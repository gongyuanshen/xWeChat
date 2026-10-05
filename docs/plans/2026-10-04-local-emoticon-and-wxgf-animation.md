# 本地表情与 WXGF 动画实现计划

承接用户确认继续完成的两项剩余工作。沿用当前未提交工作区及现有媒体入口，源微信目录只读。

## 已定位的根因与设计

- `wxgf_codec.py` 的 `_WxAMConfig` 仅 8 字节，而随附库 `wxam_dec_wxam2pic_5` 在 RVA `0x8a9180` 读取 32 字节配置。完整动画走 mode 3；静态选择及动画元数据以随附库的实际代码与可控向量验证。
- 本地表情使用独立派生键 `MD5(decimal code + wxid + "EMOTICON").digest()`，其中 wxid 通过现有 `clean_wxid` 去除账号目录后缀；AES-128-CBC 的 IV 与 key 相同。整文件 PKCS#7 解密后，以 `emoticon.db` 的精确成员 offset/size 提取 Store 内容。现有 DAT 图片键不是此密钥。公开实现只是线索，必须通过真实缓存验证。
- 复用账号已验证的图片密钥身份与 seed/code 来源。缺少密钥、身份冲突、非法长度、错误填充、数据库损坏、摘要不符都显式失败。禁止猜算法、扫描魔数分包、丢帧、固定帧率或联网兜底。
- 路径定位仍返回真实 `Path`；读取入口增加可选 `expected_md5`，表情 GET、导出和显式资源物化传入消息身份。Store 切片发生在解码读取层，不写源文件、不把整个包当作单张表情。

## 执行与验证

- [x] WXGF：先增加失败测试，修正配置结构；恢复全部帧，验证源帧数、逐帧时长、循环和透明度。保留隔离子进程、取消、超时、错误传播与清理。文件：`wxgf_codec.py`、`test_wxgf_codec.py`、非私人受控向量。
- [x] 本地表情：先验证真实缓存的派生规则，再实现独立小模块及测试。精确定位 Persist / PersistStore 和月缓存，校验数据边界和内容身份；不复制公开实现中的静默错误处理。
- [x] 共用入口：先写 GET / ZIP 导出失败用例，再连接 `media_helpers.py`、`routers/chat_media.py`、`chat_export_service.py`；测试两个消息共享同一包时不会串内容、缓存缺失索引不能掩盖真实文件。
- [x] 真实验收：原始缓存只读，离线 GET、HTML / JSON 导出的真实内容与消息关联一致；动画各帧解码、时序、循环、透明度一致，损坏输入失败。记录本轮证据并由独立 agent 审查。

调查代码和私人验收材料仅留在被忽略的 `tmp/`，不纳入源码或发布。受控向量由本地 codec 将自制 GIF 编码生成，不含聊天内容。

## 明确授权后的最终验收（2026-10-04）

用户明确授权只读当前微信进程内存恢复 code，并授权本任务中同类必要请求。仅扫描一个微信主进程的 40 个内存区、3,784,704 字节；找到与既有账号 AES/XOR 同时匹配的候选后立即停止。没有注入、写进程、联网或输出密钥。真实 Store 成员的完整 MD5 再次通过。证据 `tmp/emoticon-container-next/code-recovery-report.json`。

先在隔离副本完成真实验收，再通过现有 `upsert_account_keys_in_store(..., raise_on_write_error=True)` 补齐当前账号日常密钥记录。保存前复核账号、源目录和派生配对，保存后逐字段确认只改变 `image_key_code` 与 `updated_at`；其他账号、数据库密钥和图片密钥未变。回退字段单独保留，证据 `tmp/emoticon-container-next/code-persistence-report.json`。没有修改微信源目录。

最终使用日常密钥记录重新执行 7 条真实消息用例，5 个表情 GET 成功（2 个月缓存、2 个透明多帧 Persist、1 个 PersistStore），另 2 个实际缺失文件为 404。5 个成功用例各生成 HTML/JSON，共 10 份 ZIP；所有表情内容、逐帧像素摘要、时长、循环、原 SQL 消息身份、JSON 媒体三元组、HTML 实际图片链接和 ZIP 内容清单均通过。消息与密文均来自现有真实账号，没有构造消息关系或替换成功返回。

GET、HTML、JSON 分别使用新的空资源缓存，跟踪器调用原始解码函数并断言每阶段确实读取相应加密容器。独立 CBC 解密及原 SQL 切片提供原始内容参照；WXGF 另以不调用图片转换函数的元数据 worker 核对源时间线。最终报告 `tmp/emoticon-end-to-end/authorized-20261004-204602/report.json`，日志 `tmp/emoticon-end-to-end/authorized-global-keys-final.log`。原微信缓存及消息数据库摘要不变；本轮验收期间日常密钥记录也保持不变。先前已授权补 code 的写入与验收阶段的不变检查分开记录。

最终运行命令明确传入 `--keys D:/output/account_keys.json`；命令、报告指向、验证统计及最终生产文件 SHA-256 汇总于 `tmp/emoticon-end-to-end/final-summary.json`，用以区分脚本默认的隔离密钥副本与本次实际使用的日常记录。

父进程旧 client/broker/integrity 入口、隐式下载及网络调用探针均为 0，仅放行 Windows Python 标准库自身 socketpair 的精确初始化调用。此检查不宣称是子进程的操作系统级网络沙箱。此前验收脚本曾把程序生成的 `media_path_index.db` 误列入微信输入，导致不变检查失败；已根据 `MediaPathIndex` 的实际写入路径归为可变输出，原始失败报告保留。WXGF 元数据和 JPEG 单帧检查的验收脚本修正同样保留运行日志，未放宽生产解码校验。

同时修复图片密钥生命周期缺陷：显式内存扫描未返回 code 时，只有同账号、同源目录、同派生 wxid、旧新密钥一致且重新派生匹配，才保留已有 code。无效 code 在保存前报错；身份或密钥变化不沿用；缺失 code 不会凭空补齐，也未引入自动内存回退。新增真实临时存储测试先复现 6 个失败，再通过；最终本地表情、WXGF、密钥流程关联 89 passed，日志 `tmp/local-emoticon-authorized-final-20261004.log`。独立审查通过，新增保留用例独立复验为 14 passed。

## 前序证据与验证边界

- 最终媒体关联 13 个测试文件：155 passed，日志 `tmp/local-emoticon-final-media-20261004.log`。包含受控月缓存 WXGF 与同一消息 extern MD5 绑定、消息库版本变化后冲突暴露、旧单帧缓存不会遮蔽原动画、显式物化结果和 ZIP 内容回读。
- 真实容器：生产读取器与独立解密结果逐字一致的 Persist 86 个、Store 成员 24 个；另 12 个缺少数据库和消息身份关联的 WXGF 明确拒绝。证据 `tmp/emoticon-container-next/real-container-proof.json`，成功时间 20:08:05；不将未关联文件算作可供消息使用的成功结果。
- WXGF 解码：91 份真实输入通过，含 44 个动画、47 个静态图；动画共 2295 帧，单动画 2–257 帧，其中 21 个含透明信息。生产 worker 校验输入元数据与输出逐帧时长、循环、帧数；透明像素另有受控向量验证。证据 `tmp/wxgf-animation-next/real-validation.json`。有损 WXGF 不承诺还原编码前 RGB 的逐像素值。
- 前序真实月缓存独立 CBC 解密结果与消息 extern MD5 完全一致；当时全链受缺少 code 阻断，现已按上述授权完成。原失败日志保留于 `tmp/emoticon-end-to-end/`。
- 前序 kvcomm `.statistic` 候选消失，旧记录缺少 code；具体清理者及机制尚未确认。`tmp/emoticon-container-next/continuation-status.json` 记录的是授权前状态，当时全局记录未改动。最终恢复及明确写入以本页上节为准。
- 自动审批曾因缺少明确授权拒绝内存读取，当时未执行，也未绕过。随后用户明确授权，才执行限定只读扫描。
- 全仓原始结果：3811 passed、19 skipped、13 failed、273 subtests passed，耗时 810.29 秒；日志 `tmp/local-emoticon-full-regression-20261004.log`。其中 3 个视频测试因本次命令未设置已有 FFmpeg 路径失败；使用 `desktop/node_modules/ffmpeg-static/ffmpeg.exe` 后，原样三个相关测试文件为 28 passed、9 subtests passed，日志 `tmp/local-emoticon-video-env-check-20261004.log`。
- 另 10 项失败与既有沙箱 DPAPI `WinError 2` / 持久缓存错误一致。使用合成数据和新临时目录的原样三个测试文件在宿主上下文为 52 passed、4 subtests passed，日志 `tmp/local-emoticon-dpapi-host-check-20261004.log`；本次补验不读取微信内存或已有用户凭据。补验没有修改生产或测试代码，不能把分环境结果改写为一次全仓全绿。
- 最终独立审查未发现必须修复项，核对了账号与消息身份、容器切片、缓存优先级、错误传播和动画元数据。最终 155 项媒体回归包括全仓收集后追加的月缓存集成用例，不将该用例计入更早收集的全仓结果。
- 范围沿用前序计划：当前默认 Windows x64 Python 后端；不扩大到安装发行、frozen worker 或显式 native 历史实现。

全仓结果发生在最后的 code 保留修复之前；最终小范围变更以 89 项受影响测试和真实复验为证据，不把较早全仓执行称为最终源码全仓全绿。

## 一手来源

- CN-Grace/Wechat-Emoticon-Parser，commit `da620718f7800e1a9cfd4d3335c2301b78fcb8d1`，本地密钥派生与 CBC 线索；不采用其魔数扫描分包规则。
- MustangYM/SovietExtension，commit `a0e7533ff39b14fc135445c4c79d838544b97fdc`，`MessageMediaActions.mm` 的 mode 3 / 32 字节配置线索；Windows ABI 另由随附 DLL 静态代码确认。
- 本机 `VoipEngine.dll` SHA-256 `5fef396573ea80e3c92bdc4be1e4ac04f099aa805b74d7f046ff01d16323537e`；受控 GIF → WXGF 及动画解码探针在 `tmp/wxgf-encoder-next/`、`tmp/wxgf-animation-next/`。
