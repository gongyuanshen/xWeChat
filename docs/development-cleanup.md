# 二次开发底座清理与验收记录

**目标**：保留公开业务能力和项目固定的原生运行时，移除演示、商业推广和不可执行交互。保留 WxCDN，将连接、额度、已有兑换码操作放入媒体设置。不修改公开后端接口、数据库结构或原生校验。

## 一、 执行记录

- **原始基线**：Commit `767f1a721f8f4fe91cf07856104aeca25e53091d`，1328 个源码文件。逐文件 SHA-256 记录于本机 `.work/cleanup/source-sha256.json`，原始源码完整打包至 `.work/cleanup/original-source.zip`，Git 基线可完整恢复源码。
- **开发分支**：`cleanup/development-base`。在指定目录原地开发；基于独立分支管理改动，不创建冗余副本。
- **环境规格**：Windows 11 build 22631，Node 24.21.0，npm 11.19.0，uv 0.12.19。项目严格按照 `.python-version` 锁定 Python 3.11.16，未升级框架或第三方依赖。
- **依赖管理**：依赖安装使用项目内缓存，避免全局目录写权限冲突。未修改锁文件或擅自升级依赖包版本。
- **入口修复**（Commit `2b3e7fa`）：复现并修复原有开发入口错误——非 editable 安装后 `main.py` 导入 site-packages 副本；修复后源码启动优先导入本仓库 `src` 并输出来源，冻结包保留原加载方式。对应测试 `tests/test_main_source_import.py` 通过。
- **阶段 1：移除不可执行演示交互**（Commit `60f6925`）：删除侧边栏“高级功能演示”入口及演示弹窗、聊天右键“修改文字”、添加消息占位、朋友圈发布推广入口及其专属弹窗。保留共用复制、消息信息、引用定位和真实同步调用。定向测试 `tests/test_chat_edit_message_time_frontend.py` 4 项全部通过。
- **阶段 2：以简洁设置替代套餐推广窗口**（Commit `84822f5`）：删除原 `PlanWindow.vue` 套餐窗口、套餐动画及 `__pwMock` 等演示钩子；在现有“聊天与媒体”设置中增加内嵌的普通文本/按钮/输入框 `MediaDownloadSettings.vue`，复用 `useCdnPlanStore`，支持状态显示、额度查询、刷新、连接与兑换；兑换提交期间防重复提交。
- **阶段 3：清理专属资源与依赖**（Commit `5c286fe`）：清理高级演示和套餐独占的样式（`wxcdn-card.css` 等）、脚本（`glimm.js`, `master.js`, `renderers.js` 等）、图片资源，精简 `package.json` 专属依赖。保留年度总结等仍需使用的依赖。
- **阶段 2/3 强化与审查修复**（Commit `3697c50`）：
  1. `frontend/stores/cdnPlan.js`：新增 `pendingRedemptions` 防穿透锁，防止用户在兑换在途时切换账号或关闭对话框绕过提交锁导致的重复兑换；支持解析服务端 `lastError`。
  2. `frontend/components/MediaDownloadSettings.vue`：引入 `busy` 状态判断，兑换结束后自动触发状态刷新。
  3. `frontend/components/SidebarRail.vue`：补齐清理推广样式时遗漏的公共导航图标与激活高亮样式。
  4. 测试：`frontend/tests/cdn-plan.test.js` 与 `frontend/tests/promotion-cleanup.test.mjs` 新增专项测试并通过。
- **阶段 4：完整回归与工程验证**：
  1. **前端自动化测试**：Node 测试（`node --test tests/*.test.mjs`）共 74 项通过；Vitest 专项测试（`vitest run tests/cdn-plan.test.js`）共 9 项通过。合计 83 项前端测试无一失败。
  2. **前端静态生成构建**（`npm run generate`）：预渲染 34 个路由全部成功，产物输出至 `.output/public`。
  3. **桌面端自动化测试**（`node --test desktop/tests/*.test.cjs`）：共 253 项测试，251 项通过，2 项未通过（`sns-wasm-runtime` 缺少 Electron 可执行文件与 macOS Release Pin 校验）。经与原版基线（`desktop-baseline.log`）严格比对，两项均为既有环境特性，底座清理带来 **0 新增回归**。
  4. **原生运行时策略**：缺少本地解密库时，`main.py` 明确抛出 `NativeCoreComponentMissingError`，彻底暴露问题，拒绝静默兜底伪造成功。

## 二、 构建资源体积对比

相同构建方式（`npm run generate`）下清理前后的体积对比：

| 指标 | 原始基线 | 清理后 | 变化量 | 变化百分比 |
|---|---|---|---|---|
| **总静态资源** | 93,035,936 bytes (88.73 MB) | 91,812,171 bytes (87.56 MB) | -1,223,765 bytes (-1.17 MB) | -1.32% |
| **JavaScript** | 3,120,670 bytes (2.98 MB) | 2,837,937 bytes (2.71 MB) | -282,733 bytes (-276.1 KB) | -9.06% |
| **CSS 样式** | 916,792 bytes (895.3 KB) | 870,570 bytes (850.2 KB) | -46,222 bytes (-45.1 KB) | -5.04% |

专属推广脚本（`wxcdn-card` 渲染器 401 行、动画控制器、演示样式等）彻底移除，前端包体积显著缩减。

## 三、 验收依据与状态声明

依据计划书规范，对各项能力分类记录：

| 类别 | 状态 | 详细说明 |
|---|---|---|
| **界面清理** | **已通过** | 侧边栏、聊天右键、朋友圈发布等推广/演示入口已彻底移除，无任何死链或未处理异常。 |
| **共用功能** | **已通过** | 复制文本、消息信息、引用定位、媒体操作等共用功能均已验证保留。 |
| **工程构建链路** | **已通过** | 开发模式启动正常，静态预渲染 34 个路由全部成功，依赖关系干净。 |
| **媒体服务设置** | **已通过** | 连接状态、额度展示、重试/刷新与防重复兑换逻辑完备，状态不串账号。 |
| **原生与解密** | **工程检查通过** | 源码引导与运行时检查通过。真实微信解密与实机数据库读取待连接实际微信数据库验收。 |
| **本地语义检索** | **工程检查通过** | 逻辑链路完整保留，未改写回退逻辑。实机模型加载与检索待下载本地模型后验收。 |
| **外部 CDN 补图** | **工程检查通过** | 真实兑换码未被自动消费，真实原图下载待用户指定测试兑换码验证。 |

## 四、 本地开发与启动说明

1. **环境准备**：
   - Windows 11 x64
   - Python 3.11.16（通过 uv 管理：`uv sync --no-editable`）
   - Node.js 24+ & npm 11+
2. **启动顺序**：
   ```powershell
   # 1. 根目录准备 Python 依赖
   uv sync --no-editable

   # 2. desktop 目录安装依赖
   cd desktop
   npm ci

   # 3. frontend 目录安装依赖
   cd ../frontend
   npm ci

   # 4. 启动桌面端开发模式（会自动协同启动前端与 Python 后端）
   cd ../desktop
   npm run dev
   ```
3. **独立测试命令**：
   ```powershell
   # 前端测试
   cd frontend
   npm test

   # 桌面测试
   cd desktop
   node --test tests/*.test.cjs

   # 后端入口及定向测试
   cd ..
   .\.venv\Scripts\python.exe -m pytest tests/test_chat_edit_message_time_frontend.py tests/test_main_source_import.py -v
   ```
