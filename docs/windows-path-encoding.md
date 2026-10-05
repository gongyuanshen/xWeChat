# Windows 路径编码约定

中文路径必须在首次选择、保存配置、升级回填和迁移数据后保持原字符串。

- Electron 配置与 `output-location.path` 使用 UTF-8；PowerShell 读取时必须显式指定 `-Encoding UTF8`。
- 含中文的 Windows PowerShell 5.1 脚本源码保留 UTF-8 BOM。配置文件使用无 BOM 的 UTF-8，两者用途不同。
- 不通过猜测编码、忽略解码错误或更改用户系统代码页来修复路径。

## 验证

在 Windows 上执行 `npm ci --ignore-scripts`（工作目录为 `desktop`），然后执行：

```powershell
node --test tests/desktop-settings.test.cjs tests/output-dir.test.cjs
```

源码测试覆盖中文、空格和特殊符号路径的配置保存与再次读取。数据目录的迁移和恢复默认目录也应验证原始路径字符串及文件内容。

## 历史安装器问题

安装包与免安装压缩包已暂停后续发行，NSIS 安装器、专用测试与工作流已移除。以下记录用于保留已知问题背景，不代表当前仍提供安装器。

2.3 和 2.4 曾包含相同的编码缺陷：首次选择中文目录可正确保存，但安装器再次读取时产生乱码。因此回归验证必须覆盖再次读取，不能只检查首次选择成功。
