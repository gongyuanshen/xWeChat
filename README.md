<p align="center">
  <img src="frontend/public/logo.png" alt="xwechat Logo" width="160" />
</p>

<div align="center">

# xwechat

**一个纯粹出于个人业余兴趣、娱乐探索与技术学习而开发的本地微信数据分析工具**

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011%20(x64)-0078D6?logo=windows&logoColor=white)](https://github.com/gongyuanshen/xWeChat)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.12+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Vue.js](https://img.shields.io/badge/Frontend-Nuxt%203%20%2F%20Vue%203-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![License](https://img.shields.io/badge/License-Personal%20Hobby%20Only-lightgrey)](#免责声明与严禁商用)

<br />

> ⚠️ **重要声明**：本项目为**个人业余娱乐与学习实验项目**，纯属自娱自乐与技术研究，**不涉及任何经济收益、商业运作或收费服务**。严禁将本项目用于任何商业牟利行为。

</div>

---

## 📖 项目简介与血缘说明

**xwechat** 是一个面向 Windows 平台的个人本地微信数据分析与交互实验工具。本项目纯粹源于个人对客户端架构、本地数据库处理以及端侧 AI 模型的学习研究兴趣，旨在提供一个轻量、纯本地、私密的聊天数据浏览与分析环境。

聊天数据库的解密与存储在本机进行。项目只保留独立数据链路，旧 client／broker 运行模式及其授权链已移除；WXGF 静态图片与动画复用本地解码库。使用 API 模型时，所选内容仍会发送到配置的模型服务。运行方式与格式边界见[源码开发说明](docs/development-windows.md)。

### 🧬 项目衍生与技术来源
- **基础项目**：本项目是在 [LifeArchiveProject/WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)（微信4.x数据解密并生成年度总结）的基础上进行的**二次开发**。
- **AI 画像与意图洞察**：项目中的 **AI 聊天画像与意图洞察** 核心功能，是基于开源项目 [tswawa/WechatVibe](https://github.com/tswawa/WechatVibe)（微信聊天分析工具，支持本地 Laya 与 API 模型，提供意图识别、情绪感知、人物画像、群聊画像、好感度分析和 MBTI 聊天推测）进行深度集成与二次开发实现。

---

## ✨ 当前核心功能

> *注：当前版本已重构并聚焦于核心能力，界面展示图后续补充，以下为功能文字说明。*
> 还在开发中

## ⚖️ 免责声明与严禁商用

在使用本项目前，请仔细阅读并充分理解本声明：

1. **项目性质**：本项目为个人业余兴趣、娱乐探索与学术技术研究之产物，**非官方产品**，与WeChat主公司及其关联主体不存在任何隶属、合作、授权或认可关系。
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
