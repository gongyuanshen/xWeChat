# 品牌检索与统一记录（2026-10-07）

当前产品名为 `xwechat`，图标源为 `frontend/public/logo.png`。此前只更新部分界面与构建产品名，遗漏桌面 npm 包名、子窗口默认值、导出署名和其它展示入口，导致公众号小窗口仍出现旧名字与 Electron 默认图标。

本次统一了桌面应用与包元数据、主窗口和所有子窗口图标、页面标题、年报中的 canvas/SVG 品牌、导出署名与项目链接、后端 API/日志、MCP 显示名称和官网演示。公众号文章原生标题为空，文章正文和网页自身标题保持原有内容。导入头像占位改用当前图标，移除已无调用的历史 `frontend/public/Contact.png`。

图标通过 `desktop/scripts/build-icon.cjs` 从唯一源图生成桌面 PNG/ICO、浏览器 favicon 和官网 logo；静态 UI 重新生成后同步到 `desktop/resources/ui`。旧安装包和编译二进制不会通过文本替换改写，本次不发布安装包。

以下残留有实际用途，保留并单独核对：

- `wechat-data-analysis-desktop`：历史持久数据目录及对应回归测试、开发验收工具。选择规则见 [桌面品牌与持久数据目录](desktop-brand-profile.md)，不会迁移、改名或删除账号与设置。
- `wechat_data_analysis` / `wechat_data_analysis_archive`：已识别的导入格式标识，不是产品显示名称。
- `wechat_decrypt_tool`、`wechatDesktop`、`wechat.*`：Python 模块、桌面 IPC、MCP 工具接口，保持调用契约。
- README、官网致谢与 `html_export/sources.json`、CSS/JS 头部的旧项目名：真实上游来源与资源 provenance，不作为当前产品品牌展示。
- 官网历史截图：保留原始素材，通过展示层裁去旧应用侧栏；聊天发送者头像和微信自身图标仍代表原有数据，不替换成项目图标。

验证区分源码测试、静态构建、隔离窗口/官网展示检查与真实账号验收；本次不声称完成安装包验收或真实公众号联网验收。
