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

## 当前开发状态

**暂停安装包和免安装压缩包的后续发行。** 当前先完善可独立维护的聊天数据读取与导出底层，完成真实数据验证后再恢复发行。

仓库保留源码开发与运行方式，已移除安装程序、免安装版的构建及发行链路。开发环境、启动命令、当前原生组件限制与本地文件排除规则见 [Windows 源码开发说明](docs/development-windows.md)。

独立数据链路是唯一实现，无需设置模式环境变量：可从已登录的 Windows 微信通过源码扫描获取并验证数据库密钥，解密稳定副本、读取聊天快照，导出 TXT／JSON／Excel／HTML 目录或 ZIP，以及重新导入独立账号 ZIP。新 ZIP 使用 SHA-256 内容校验，不提供签名或来源认证；旧 `manifest.wce`／`signature.wce` 账号 ZIP 可通过固定公钥独立验签后导入。HTML 展示资源随源码提供。本地 Persist／PersistStore／月缓存表情已支持账号绑定解密与消息身份校验；Windows Python 后端通过隔离进程调用 `VoipEngine.dll` 还原 WXGF 静态图片和完整动画，包括逐帧时长、循环及透明度。

2026-10-04 按用户要求删除旧模式。此次只做代码清理与静态检查，未运行清理后的功能测试、构建或真实微信验收；下文已有验收结果均为此次删除前的基线，不能代替删除后的验证。

表情可由用户手动下载并重试，保存前校验原始 MD5 和全部图片帧，成功后使用本地资源。默认离线模式下，有 MD5 的聊天表情直接请求本地接口；缺失、密钥或身份错误明确返回，远程地址仅供显式下载。真实加密缓存已完成本地读取及 HTML／JSON 导出回读验证。桌面无法解码的视频会明确提示，并提供“生成本地预览”按钮；仅在点击后本地生成 H.264 副本，支持取消，原视频与导出内容保持不变。

Windows 在线快照固定各库已提交的 WAL 前缀，允许其后的正常追加，再完成页面认证与 SQLite 完整性检查。修复后通过本机微信 4.1.15.13 的 600 秒真实发送观察：19 次定时检查、14 个已发布代次、47 条新增消息。保证范围是逐库提交边界，不是跨库全局事务，也不代表任意写入负载均已验证；锁竞争、格式、认证或源身份异常仍明确停止。

现有导出 API 可显式提供独立的 32 字节内容密钥，生成 WEC1 加密文件；本地文件解密函数与真实旧组件样本逐字节互通。旧账号 ZIP 的 WES1／WES2 附加签名按签名生成时的有效期验证，允许历史归档日后导入，同时验证原有签名、内容摘要及身份绑定。WES2 属于设备自签，不证明外部来源身份；WES1 暂无真实正向旧归档，仅完成固定构建格式恢复与受控验证。图形导入入口仍接收解密后的 ZIP 或目录。

旧模式移除范围见[删除计划](docs/plans/2026-10-04-remove-legacy-mode.md)，此前实现与真实验收边界见[功能记录](docs/plans/2026-10-04-remaining-functional-acceptance.md)。安装器发行仍暂停。此前期限后测试覆盖 Python 时间为 2027／2030 的独立链路，没有修改 Windows 系统时间，因此不能据此承诺本地解码 DLL 内部永久有效。

默认模式不加载旧 client／broker，不自动切换到旧 Hook；整批验证快照与手动开启的30秒持续检查已接入聊天页，失败停止并保留上次成功快照。账号删除会等待刷新退出，其他读取/导出仍活跃时明确拒绝；可清理所有所属快照。第三阶段实现与分层验证见[当前计划](docs/plans/2026-10-04-independent-default-and-exports.md)。

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
