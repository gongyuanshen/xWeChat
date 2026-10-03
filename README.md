<p align="center">
  <img src="frontend/public/logo.png" alt="xwechat Logo" width="160" />
</p>

<div align="center">

# xwechat

**一个纯粹出于个人业余兴趣、娱乐探索与技术学习而开发的本地微信数据分析工具**

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20(x64)-0078D6?logo=windows&logoColor=white)](https://github.com/gongyuanshen/WeChatDataAnalysis)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Vue.js](https://img.shields.io/badge/Frontend-Nuxt%203%20%2F%20Vue%203-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![License](https://img.shields.io/badge/License-Personal%20Hobby%20Only-lightgrey)](#免责声明与严禁商用)

<br />

> ⚠️ **重要声明**：本项目为**个人业余娱乐与学习实验项目**，纯属自娱自乐与技术研究，**不涉及任何经济收益、商业运作或收费服务**。严禁将本项目用于任何商业牟利行为。

</div>

---

## 📖 项目简介与血缘说明

**xwechat** 是一个面向 Windows 平台的个人本地微信数据分析与交互实验工具。本项目纯粹源于个人对客户端架构、本地数据库处理以及端侧 AI 模型的学习研究兴趣，旨在提供一个轻量、纯本地、私密的聊天数据浏览与分析环境。

所有数据均在使用者本机解密与处理，不依赖任何第三方远程后端服务，充分保障个人数据隐私与安全。

### 🧬 项目衍生与技术来源
- **基础项目**：本项目是在 [LifeArchiveProject/WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)（微信4.x数据解密并生成年度总结）的基础上进行的**二次开发**。在此基础上净化了冗余代码，移除了商业化/收费引流机制与非 Windows 跨平台依赖，专注于打造一个简洁干净的纯 Windows 个人本地娱乐与学习版本。
- **AI 画像与意图洞察**：项目中的 **AI 聊天画像与意图洞察** 核心功能，是基于开源项目 [tswawa/WechatVibe](https://github.com/tswawa/WechatVibe)（微信聊天分析工具，支持本地 Laya 与 API 模型，提供意图识别、情绪感知、人物画像、群聊画像、好感度分析和 MBTI 聊天推测）进行深度集成与二次开发实现。

---

## ✨ 当前核心功能

> *注：当前版本已重构并聚焦于核心能力，界面展示图后续补充，以下为功能文字说明。*

### 1. 🗄️ 本地数据解密与会话管理
- **微信 4.x 数据读取**：支持 Windows 微信 4.x 本地数据库的自动化安全解密与结构化读取。
- **纯本地 SQLite 存储**：解密数据全部保存在本机隔离存储中，提供高性能的本地查询与离线缓存。
- **多账号与会话管理**：支持检测本机登录微信账号，浏览单聊、群聊、联系人及多媒体消息。

### 2. 🛡️ 消息查看与防撤回追踪 (Anti-Revoke)
- **多类型消息还原**：支持文字、表情、图片、语音、文件、链接卡片、系统消息等多种格式的原生样式渲染。
- **本地防撤回监听**：实时捕获并标记撤回消息，保留撤回前的内容与时间戳，避免错过关键信息。
- **消息搜索与定位**：支持按关键词、时间范围在本地会话中快速检索消息，并定位至上下文。

### 3. 🧠 AI 聊天画像与意图洞察 (Chat Insights)
> *注：本模块核心功能基于开源项目 [tswawa/WechatVibe](https://github.com/tswawa/WechatVibe) 进行深度集成与本地化适配。*
- **本地离线 Laya 模型**：支持在 CPU 端直接加载轻量级 Laya 分类模型，实现**零网络消耗、无需 API Key、完全离线**的情绪与意图识别。
- **云端大模型 API 模式**：兼容主流大模型接口，提供更细腻的长篇人物画像分析。
- **微观消息标签**：在单条消息旁显示紧凑的情绪与意图标签，并提供溯源依据展示。
- **深度多维画像仪表盘**：
  - **单聊画像**：自动生成人物摘要、交流风格、六维互动雷达、亲近倾向以及 MBTI 聊天推测。
  - **群聊分析**：支持全群聊天氛围统计与群成员专属画像。
- **智能标签复用**：已分析标签自动复用，杜绝重复计算与不必要开销。

### 4. 🤖 辅助总结与本地语义检索
- **智能长文与群聊总结**：按需对未读消息、长对话或特定主题生成精简摘要与待办提取。
- **语义关注提醒**：自定义关注关键词或语义意图，命中时触发桌面提醒。
- **向量语义检索**：支持集成轻量级嵌入模型，实现跨会话的语义关联检索，支持 CPU 与 GPU 自动回退。

### 5. 🔌 智能消息辅助发送 (WeChat Bridge)
- **Qt / UIA 桥接**：基于 Windows 原生 UI 自动化技术，实现桌面客户端内的消息辅助发送。
- **多媒体与附件直发**：支持直接在客户端内发送文字、选择图片及发送文件，无需手动切换窗口。

---

## 🛠️ 技术架构

- **桌面外壳**：Electron
- **前端界面**：Nuxt 3 + Vue 3 + TailwindCSS
- **后端服务**：FastAPI (Python 3.11+) + Uvicorn
- **包管理工具**：`uv` (Python) + `npm` (Node.js)
- **数据引擎**：SQLite 3 (本地加密与解密数据库)
- **端侧 AI 引擎**：ONNX Runtime / 本地 CPU 4 线程轻量推理

---

## 🚀 运行与开发环境

### 前置要求
- **操作系统**：Windows 10 / 11 64位
- **Python**：>= 3.11（推荐使用 [uv](https://github.com/astral-sh/uv) 管理依赖）
- **Node.js**：>= 18.x

### 1. 克隆代码仓库
```bash
git clone https://github.com/gongyuanshen/WeChatDataAnalysis.git
cd WeChatDataAnalysis
```

### 2. 安装后端环境
```bash
# 推荐使用 uv 同步后端虚拟环境与依赖
uv sync --no-editable
```

### 3. 安装桌面端与前端依赖
```bash
# 安装桌面端依赖
cd desktop
npm ci

# 安装前端依赖
cd ../frontend
npm ci
cd ..
```

### 4. 本地启动开发
```bash
# 方式一：一键启动完整桌面开发模式（推荐）
cd desktop
npm run dev

# 方式二：分别独立启动后端与前端
# 终端 1 (后端 FastAPI 服务, 默认端口 10392):
uv run --no-sync main.py

# 终端 2 (前端 Nuxt 服务, 默认端口 3000):
cd frontend
npm run dev
```

---

## 📦 桌面端打包发布 (Windows)

在项目根目录下通过 Electron Builder 生成独立的 Windows 安装包：

```bash
cd desktop
npm run dist
```
打包成功后，安装程序位于 `desktop/dist/` 目录（例如 `xwechat Setup <version>.exe`）。

---

## 🔒 数据安全与隐私守则

1. **绝对本地化**：本项目所有解密算法与业务数据均在使用者本机执行，**绝不包含任何静默上传、远程收集用户聊天记录或密钥的后门逻辑**。
2. **密钥与数据自负**：本地解密后的聊天记录包含高度敏感的个人隐私，请妥善保管个人数据库文件与配置文件，切勿泄露给第三方。
3. **合规合法**：本项目仅限使用者本人用于对自己合法持有的个人微信数据进行备份、浏览与娱乐研究，严禁用于任何窃取他人隐私、非法侵入计算机信息系统的违法犯罪行为。

---

## ⚖️ 免责声明与严禁商用

在使用本项目前，请仔细阅读并充分理解本声明：

1. **项目性质**：本项目为个人业余兴趣、娱乐探索与学术技术研究之产物，**非官方产品**，与微信、腾讯公司及其关联主体不存在任何隶属、合作、授权或认可关系。
2. **严禁商业化与经济盈利**：
   - 本项目完全开源免费，**从未授权任何机构、团队或个人进行付费售卖、付费代理、收取进群门槛费或提供商业化定制服务**。
   - 严禁任何人将本项目全部或部分代码用于商业牟利或经济变现。
3. **风险自负**：本项目按“现状”（As-Is）提供，不对软件的持续可用性、稳定性或微信版本兼容性作任何明示或暗示的担保。因环境变更、协议变动或个人不当使用导致的数据丢失、账号异常或其他损失，由使用者自行承担。

---

## 💖 致谢与开源基石

本项目离不开开源社区的先驱工作，在此特别感谢以下基石项目与技术分享者：

### 核心上游与功能基石
- **[LifeArchiveProject/WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)**：微信 4.x 数据解密与分析工具，本项目二次开发的底层基础项目。
- **[tswawa/WechatVibe](https://github.com/tswawa/WechatVibe)**：微信聊天分析工具，本项目 AI 聊天画像、情绪感知、意图识别与 MBTI 推测功能的直接来源与核心基石。

### 灵感与技术参考
- [H3CoF6](https://github.com/H3CoF6)
- [echotrace](https://github.com/ycccccccy/echotrace)
- [WeFlow](https://github.com/hicccc77/WeFlow)
- [wx_key](https://github.com/ycccccccy/wx_key)
- [wechat-dump-rs](https://github.com/0xlane/wechat-dump-rs)
- [oh-my-wechat](https://github.com/chclt/oh-my-wechat)
- [vue3-wechat-tool](https://github.com/Ele-Cat/vue3-wechat-tool)
- [wx-dat](https://github.com/waaaaashi/wx-dat)
- [Ritsu](https://xhslink.com/m/7YJUsd1sgyF)
- [recarto404](https://github.com/recarto404)
- [xiaoshengbao](https://github.com/xiaoshengbao)
