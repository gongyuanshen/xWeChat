# Windows 源码构建与发布

GitHub 仓库用于存放源码、测试、构建配置和必要的公开资源；安装包与免安装压缩包发布到 [Releases](https://github.com/gongyuanshen/xWeChat/releases)。免安装版包含已编译程序和运行依赖，不是源码目录。

## 构建

使用 Windows x64、Python 3.11 或更新版本、uv，以及 Node.js 22.12 或更新版本的 x64 发行版。在项目根目录执行：

```powershell
npm --prefix frontend ci
npm --prefix desktop ci
npm --prefix desktop run dist
```

构建脚本会安装后端构建依赖、生成前端、打包后端 EXE，然后生成桌面安装包。默认命令等价于 `npm --prefix desktop run dist:win:unsigned`，无需购买应用签名证书或持有上游私钥。

产物位于：

- `desktop/dist/xwechat-<version>-Setup.exe`：安装程序。
- `desktop/dist/win-unpacked/`：免安装程序目录，入口为 `xwechat.exe`。分发时须保留完整目录及其资源。

使用者无需安装 Python、Node.js 或 uv。未签名安装包可能显示未知发布者提示。构建及安装流程为程序目录设置 Chromium 沙箱所需的读取执行权限，并拒绝沿目录链接传播权限。

## 原生组件

默认构建复用 `desktop/resources/native-core-source-windows.json` 固定的上游公开组件，并校验下载摘要、公开根证书和运行清单。首次准备依赖和原生组件需要联网。

当前清单对应上游 v2.4.0，项目在本机检查的截止时间为 **2026-10-22 22:44:48（UTC+8）**；构建及启动代码会拒绝过期清单。长期独立运行所需的期限依赖调整尚未完成。该日期来自组件清单及 JavaScript/Python 检查，尚未验证 DLL 内部是否独立实施相同的截止检查。

`desktop/resources/native-core-source-root.cer` 提取自按固定摘要验证的[上游安装包](https://github.com/LifeArchiveProject/WeChatDataAnalysis/releases/download/v2.4.0/WeChatDataAnalysis-2.4.0-Setup.exe)，仅包含公开证书，不包含私钥。

`dist:win` 保留上游签名发布流程，需要对应发布材料。普通本地构建使用默认 `dist` 命令。

## 源码提交边界

提交源码、测试、依赖锁文件、构建脚本、必要资源和公开证书。保留已有第三方声明。

以下内容只保留在本地，由 `.gitignore` 排除：

- `.env`、个人配置、聊天数据库、密钥及 `private/` 签名材料。
- `output/`、`data/`、`local_search_models/`、日志、缓存及临时验证文件。
- `.venv/`、`node_modules/`、生成的前端/后端资源及 `desktop/dist/` 安装产物。
- 本机验收报告与工具观测记录。

`.gitignore` 不会自动移除已经被 Git 跟踪的文件，提交前仍须核对暂存区。源码同步与重新构建 EXE 是两个步骤，已有 Release 附件不会随源码提交自动变化。
