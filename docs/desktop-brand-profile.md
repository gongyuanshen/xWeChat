# 桌面品牌与持久数据目录

桌面应用、npm 包和预加载品牌标记统一为 `xwechat`。`window.wechatDesktop` 是现有微信桌面 IPC 接口名称，保持不变。

Electron 默认使用包名决定 `userData`，而 `sessionData` 默认跟随 `userData`。为避免更名后账号、设置和浏览器存储看似重置，应用在获取单实例锁和 `ready` 之前显式固定这两个目录：

- 开发版始终使用 `appData/wechat-data-analysis-desktop`，保持原开发环境的数据隔离。
- 安装版在 `appData/xwechat` 已有持久状态时优先使用该目录。
- 安装版只有旧目录有持久状态时沿用旧目录。
- 全新安装版使用 `appData/xwechat`。

持久状态通过已有存储入口的目录项判断：配置文件 `desktop-settings.json` 或 `ai-notifications.json` 存在即算已有状态；`Local Storage` 或 `output` 目录必须含有条目，空目录不算已有状态。不读取账号数据库或配置内容；损坏配置仍交给现有配置解析流程暴露错误。目录不存在与读取失败分别处理，权限或其它读取错误直接抛出。

此流程不迁移、不改名、不删除任何既有目录。`WECHAT_TOOL_DATA_DIR` 和 `WECHAT_TOOL_OUTPUT_DIR` 的原有显式配置规则继续生效。旧包名只作为必要的历史存储路径和回归测试数据保留。

所有原生子窗口及其后代使用当前项目图标。公众号文章的原生标题保持为空；其它窗口初始标题为 `xwechat`，网页仍可正常更新标题。

参考：[Electron app 路径与名称 API](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path)、[原生子窗口创建规则](https://www.electronjs.org/docs/latest/api/window-open)。
