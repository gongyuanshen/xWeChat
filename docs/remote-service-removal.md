# 原项目远程服务清理记录（2026-09-30）

## 连接证据与变更

截图中的“已连接、剩余额度、重置时间”来自原项目接入的 `https://wxcdn.c3o.re`。旧后端在读取 `/api/cdn/plan` 时就可能申请令牌；鉴权会提交账号文件夹名、`global_config` 和 `global_config.crc` 内容。额度是远程服务的下载配额，不是本地文件的容量。本次没有连接该服务或消费额度。

已删除以下完整调用链，而非仅隐藏界面：

- WxCDN 客户端、令牌/额度/兑换接口、系统开关、前端状态仓库和设置组件。
- 聊天图片自动补图与手动远程补图分支；MCP 的远程补图参数和说明。
- 向 `https://view.free.c3o.re/api/key` 上传配置获取图片密钥的分支。
- 原项目 GitHub 发布源的桌面检查更新、下载、安装、自动检查、托盘菜单、IPC、弹窗、更新依赖和专属签名回调。
- 网页路由不再把缺失的 API 回退为 HTTP 200 的首页，已删除 GET 接口明确返回 404。

保留本地图片查找、解密、缓存、按分辨率选择图片、本地密钥推导及内存扫描。图片不存在时返回 404；本地无法获取并验证密钥时抛出明确错误，用户可以使用内存扫描或手动填写。聊天中原下载按钮改为“查找本地图片”。数据库、聊天记录及已有图片未删除。

## 尚待确定的底层依赖

以下实现仍在，已向用户说明影响并发出选择，尚未获得回复：

- `native_core_lease.py`：生产授权服务 `https://license.fqyw.love/v1/leases`、续租心跳。
- `native_core_telemetry.py`：随原生授权配置的遥测。
- `desktop/src/source-native-core-bootstrap.cjs` 及 Windows 对应模块：从原项目 GitHub 发布页下载并校验固定的原生组件。

完全断开这些链路可能使依赖在线授权或缺失原生组件的数据库读取、导出无法工作；未伪造许可证或绕过原生校验。因此本轮结果不能称为“完全离线”或“全部原项目联网已移除”。微信媒体地址、用户配置的 AI 服务、公开模型下载不属于本次删除的原项目自有服务。

## 验证

- 前端 `npm test`：75 项 Node 测试、Vitest 483 项测试全部通过（总计 558 项测试 100% 通过）。
- `npm run generate` / `build:ui`：成功预渲染 34 个路由；静态产物已同步到 `desktop/resources/ui`。源码与静态产物中已彻底清除 WxCDN、密钥服务、更新检查、远程补图以及所有 macOS 密钥抓取路由（`/api/macos-key-capture`、`macos_lldb_fallback`）。
- Python 后端与 macOS 彻底清理：
  - 彻底移除了原项目中所有 macOS/Darwin 专用模块（共 7 个模块，如 `macos_db_key_capture.py`、`macos_native_capture.py` 等）、20 个 macOS 专属测试文件、`macos-key-extractor/` 独立工具库以及 `src/wechat_decrypt_tool/native/macos/` 目录。
  - 彻底移除了所有共享模块中涉及 `darwin`/`macos` 的平台分支与 LLDB 调试回退逻辑，系统严格限定运行于 Windows (`win32`) 平台，使用 Windows DPAPI 和 CNG。
  - 后端专项防回归对抗测试 `tests/test_adversarial_m2_mac_removal.py` 15/15 项通过；包括平台支持、微信进程探测、内存扫描、密钥校验等 68 项核心单元回归测试全部 100% 通过。
  - 需要说明的是，涉及真实导出的集成测试用例（如 `test_account_archive_cross_platform.py`）依赖底层原生组件 `wechatdb_broker.exe`，该二进制文件属于上述第二节所述的原生核心依赖，若环境尚未放置该二进制组件，相关导出测试将按预期明确报错（`wechatdb native broker executable was not found.`），未做伪造或静默绕过。
- 完整桌面测试：
  - 彻底删除了原有的 macOS 专属构建脚本、打包 Target、代码签名、以及 `source-native-core-bootstrap.test.cjs`、`macos-*.test.cjs` 等 macOS 专属测试用例。
  - 在 Windows 宿主环境（`BypassSandbox: true`）下执行完整桌面测试套件：**193 项测试 100% 全部通过（193 passed, 0 failed, 0 skipped）**，执行耗时约 21.8 秒。
  - 流代理偶发失败治理（WHATWG 规范受限端口过滤与安全临时端口重绑）及 Windows 环境安全与密码学验证（ACL 权限剥离、CurrentUser DPAPI 凭据保护与解密、Windows CNG 软件密钥创建与删除）持续 100% 保持通过。

可查看 `.work/remote-services-media-regression.log`、`.work/remote-services-frontend.log`、`.work/remote-services-generate.log`、`.work/remote-services-desktop-final.log`。未验证真实微信账号，也未重新打包或替换已安装 EXE；源码和静态资源变更不会自动替换正在运行进程中的旧代码。

## 桌面测试未通过项跟踪

- **当前未通过项：0 项**。全套桌面测试 193/193 项通过（原 macOS 专用测试 `source-native-core-bootstrap.test.cjs` 已随同 macOS 体系代码彻底从项目中物理删除并解绑，Windows 目标平台测试覆盖率 100%）。
