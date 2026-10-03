<p align="center">
    <img src="frontend/public/logo.png" alt="WeChatDataAnalysis" width="200" />
</p>

<div align="center">
    <h1>WeChatDataAnalysis</h1>
    <p>一个纯粹出于个人业余兴趣、娱乐与学习研究开发的项目</p>
    <p><b>⚠️ 声明：本项目为纯个人业余娱乐项目，仅供个人学习与娱乐，不涉及任何商业盈利、经济收益或收费服务。</b></p>
    <img src="https://img.shields.io/badge/Project-Personal%20Hobby-blue" alt="Personal Project" />
    <img src="https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white" alt="Windows" />
    <img src="https://img.shields.io/badge/Python-3.11+-3776AB?logo=Python&logoColor=white" alt="Python" />
    <img src="https://img.shields.io/badge/Vue.js-3.x-4FC08D?logo=Vue.js&logoColor=white" alt="Vue.js" />
    <img src="https://img.shields.io/badge/SQLite-Database-003B57?logo=SQLite&logoColor=white" alt="SQLite" />
</div>

## 项目说明

本项目为开发者个人的业余娱乐与技术探索项目，主要用于个人技术学习、代码实验与本地数据研究。项目无任何商业规划，不涉及其他经济商业方面的内容，亦不提供任何商业化服务。

## 运行与开发环境

### 1. 克隆项目

```bash
git clone https://github.com/gongyuanshen/WeChatDataAnalysis.git
cd WeChatDataAnalysis
```

### 2. 安装后端依赖

```bash
# 推荐使用 uv
uv sync --no-editable
```

### 3. 安装桌面端与前端依赖

```bash
# 桌面端
cd desktop
npm ci

# 前端
cd ../frontend
npm ci
cd ..
```

### 4. 启动服务

完整桌面开发模式：

```bash
cd desktop
npm run dev
```

或分别启动：

```bash
# 启动后端 API 服务
uv run --no-sync main.py

# 启动前端开发服务器
cd frontend
npm run dev
```

默认端口与访问地址：
- 前端界面: http://localhost:3000
- 后端 API: http://localhost:10392

## 桌面端打包（Windows）

本项目提供基于 Electron 的 Windows 桌面端安装包打包脚本：

```bash
cd desktop
npm ci
npm run dist
```

输出路径：`desktop/dist/WeChatDataAnalysis Setup <version>.exe`

## 安全说明

**重要提醒**:

1. **仅限个人使用**: 此工具仅用于个人本地学习与研究
2. **密钥安全**: 请妥善保管个人本地密钥，切勿泄露给第三方
3. **数据隐私**: 本地数据涉及个人隐私，请妥善保管并自行负责数据安全
4. **合法使用**: 请遵守相关法律法规，严禁用于任何违法、违规或侵犯他人隐私之行为

## 免责声明

请在充分理解以下内容，并自愿承担相应责任的前提下使用本项目：

1. **项目性质与严禁商用**

   本项目为个人出于业余兴趣、娱乐探索与技术学习而开发的非官方工具，纯属私人娱乐与学习研究，不涉及任何经济收益、商业运作或收费服务。本项目与微信、腾讯及其关联主体不存在任何隶属、授权、合作或认可关系，相关产品名称和商标归其权利人所有。

   **严禁商业牟利**：本项目绝不提供任何付费版或商业服务，严禁任何组织或个人将本项目代码、衍生功能或技术工具用于任何商业牟利、收费转售、恶意侵犯他人隐私或非法用途。

2. **合法使用**

   本项目仅可用于处理使用者本人合法持有、管理或已经取得明确授权访问的数据。使用者应遵守适用的法律法规、软件许可协议、平台规则和隐私保护义务。

3. **数据与备份**

   使用过程可能涉及本地数据库、密钥、媒体文件、微信进程和系统接口。开始前请备份重要数据、密钥及配置，并自行负责密钥保管、数据安全和隐私保护。

4. **兼容性与运行风险**

   客户端版本变化、系统环境更新、第三方组件及其他本地处理流程，可能导致功能失效、处理失败或不可预期结果。本项目不保证持续兼容性。

5. **责任范围**

   本项目按现状提供，不对功能的准确性、完整性、稳定性或持续可用性作出明示或默示保证。在适用法律允许的范围内，因使用、误用、版本不兼容、操作中断等产生的损失和后果，由使用者自行承担。

## 致谢

1. **[H3CoF6](https://github.com/H3CoF6)**
2. **[echotrace](https://github.com/ycccccccy/echotrace)**
3. **[WeFlow](https://github.com/hicccc77/WeFlow)**
4. **[wx_key](https://github.com/ycccccccy/wx_key)**
5. **[wechat-dump-rs](https://github.com/0xlane/wechat-dump-rs)**
6. **[oh-my-wechat](https://github.com/chclt/oh-my-wechat)**
7. **[vue3-wechat-tool](https://github.com/Ele-Cat/vue3-wechat-tool)**
8. **[wx-dat](https://github.com/waaaaashi/wx-dat)**
9. **[Ritsu](https://xhslink.com/m/7YJUsd1sgyF)**
10. **[recarto404](https://github.com/recarto404)**
11. **[xiaoshengbao](https://github.com/xiaoshengbao)**

## 贡献

欢迎提交 Issue 和 Pull Request 交流探讨。
