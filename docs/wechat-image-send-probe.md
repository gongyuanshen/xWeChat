# 图片发送首期：真机入口验证记录

检查日期：2026-10-01（Asia/Singapore）。

## 结果

已验证原生选图入口及图片草稿状态，并接入桌面选图、预览、独立图片 API 和 Qt UIA 发送流程。
自动化测试覆盖单次提交和结果不确定时的明确提示。用户已于 2026-10-01 通过项目桌面程序向文件传输助手发送桌面 PNG，并提供微信右侧 17:16 新图片的截图，确认本次真实发送成功。
当前 UIA 仍无法自动证明图片方向；前端提供人工确认流程，不能将这次人工验收视为未来每次发送的自动成功依据。

初次探测时，Windows 微信版本为 4.1.15.13，与仓库文字发送适配文档中的版本一致。
主窗口已恢复并通过现有桥接逻辑激活。窗口截图显示已登录的“文件传输助手”聊天。
现有代码的最后一次只读探测结果为：

```json
{
  "running": true,
  "window_found": true,
  "locked": false,
  "chat_input_found": false
}
```

UI Automation 只枚举到以下两层：

```text
WindowControl: mmui::MainWindow
└─ PaneControl: MMUIRenderSubWindowHW
```

没有读取到 `chat_message_page`、`chat_input_field`、搜索输入框或附件按钮。
当时无法据真实控件实现图片选择、发送及回执。此阻塞在用户重新打开微信后的复查中解除，见后文。

## 已完成的区别性检查

- 核实微信版本、主窗口、前台状态和已登录界面，排除本次检查处于隐藏窗口或未登录界面的情况。
- 分别使用显式 UIA 线程初始化和普通主线程查询，结果相同。
- 核实安装的 `uiautomation==2.0.29` 的控件枚举使用 `RawViewWalker`，并非 Control View 过滤掉聊天控件。
- 通过官方 `AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, ...)` 查询，返回 `S_OK`；随后 UIA 控件树仍只有外层窗口和渲染区域。接口调用成功不等于聊天控件可用。
- 临时订阅 UIA 焦点事件后重新查询，控件树未改变；订阅已移除。
- 只读检查系统屏幕阅读器标志为关闭；没有修改系统辅助功能设置。该标志本身不足以证明根因。
- 最后通过现有 `WeChatBridge.probe_status()` 与 `WeChatQtUI.locate_input()` 复核上述结果。

以上初次探测未选择图片、写入草稿或点击发送。

## 尚未确定的事项

初次微信进程为何未暴露聊天辅助功能控件，根因尚未确定。以上结果不能推出 Windows 无法自动发送图片。
恢复控件访问并验证选图后的草稿流程后，实施继续进行。

## 官方依据

- [Qt 5.15 Windows 无障碍查询处理器](https://github.com/qt/qtbase/blob/5.15/src/plugins/platforms/windows/uiautomation/qwindowsuiaaccessibility.cpp#L68-L85)
- [Microsoft AccessibleObjectFromWindow](https://learn.microsoft.com/en-us/windows/win32/api/oleacc/nf-oleacc-accessibleobjectfromwindow)
- [Microsoft WM_GETOBJECT](https://learn.microsoft.com/en-us/windows/win32/winauto/wm-getobject)
- [Microsoft AddFocusChangedEventHandler](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation-addfocuschangedeventhandler)

## 用户重新打开微信后的复查

2026-10-01，用户报告已打开微信并手动发送了一张图片，随后重新检查。
本次微信进程和主窗口句柄与前次不同；不能据此断言前次缺失控件的根因。

- 已读到 `chat_message_page`、`chat_input_field` 和准确标题“文件传输助手”。
- 附件按钮位于 `tool_bar_accessible.chatinput_toolbar_left_view`，名称为“发送文件”，类为 `mmui::XButton`。
- 已通过单次 UIA 定位点击打开微信拥有的原生文件选择对话框，窗口类为 `#32770`，标题为“选择文件”。
- 文件名输入框为 `EditControl`，`AutomationId=1148`；取消按钮为 `ButtonControl`，`AutomationId=2`。
- 对话框已取消，未选择文件。后续操作必须复核前台和窗口 owner，不能把任意前台窗口当成微信对话框。
- 已读到用户手动发送的图片消息，类型为 `ListItemControl`，名称“图片”，类为 `mmui::ChatBubbleReferItemView`；它没有暴露发送者、文件路径或图片内容属性。
- 空输入框的 ValuePattern 和 TextPattern 均可读，文本长度和嵌入对象数量均为零。

用户随后授权向“文件传输助手”发送指定绿色边框测试图一次。
已在准确目标会话通过微信文件选择框选入该图；打开控件为 `SplitButtonControl`、`AutomationId=1`。
选择完成后，输入框 ValuePattern 和 TextPattern 都是一个 U+FFFC 对象字符，嵌入子对象数量为零。
没有额外图片确认弹窗，也没有自动提交。探测结束移除了草稿，未点击发送；这次发送授权尚未使用。

## 实现及回执边界

- 桌面原生对话框单选 JPG/JPEG/PNG，预览不向浏览器暴露任意文件读取入口。
- `POST /api/chat/send/image` 校验本地绝对路径、文件读取、扩展名与实际格式一致，并完整解码图片。
- 图片和文字共用发送锁及会话冷却时间；图片按内容指纹防重复。
- Qt UIA 先要求微信草稿为空，复核准确会话及前台窗口，选择文件后要求恰好一个图片对象，最后只点击一次发送。
- 发送后检查图片草稿清空且消息列表恰好新增一个图片元素；缺失控件、草稿冲突或结果不确定均明确报错，不自动重试。
- 当前 UIA 不提供该图片的发送者、原始内容或服务端送达信息；图片元素的位置也覆盖整个消息行，无法据此判断方向。因此即使观察到草稿清空及一个新图片，仍返回 `WECHAT_SEND_UNCONFIRMED`，要求人工核对，不构造成功回执。完整自动回执验收尚未通过。
- 会话 `account` 字段延续现有文字接口语义，不负责切换或确认微信当前登录账号。

## 用户真机验收

重启使用本次源码的桌面程序，选择“文件传输助手”，点击“图片”选择一张明确的 JPG/PNG，
核对预览和目标后点击“发送图片”。微信出现对应的新出站图片才算真实发送通过。
若失败，保留所选图片并展示具体错误；结果不确定时先检查微信，避免重复提交。
当前版本发送后可能在微信正确出现图片，同时软件提示无法确认发送方向；请反馈微信是否出现对应的右侧新图片。
本次未重建安装版 EXE，旧安装程序不包含上述改动。

### 待确认状态的处理

`WECHAT_SEND_UNCONFIRMED` 在项目界面显示黄色“图片发送结果待核对”，原始错误代码和原因保留在“查看原因”中。
待核对时保留图片，并禁用直接重发和替换图片。用户点击“已在微信确认发送”后，仅清除本地预览并刷新原会话；不改写后端回执。
若用户确认未发送，点击“已核对未发送，允许重试”只恢复发送按钮，不自动发送。
切换会话后不能确认或解锁原会话图片；普通选图、文件、草稿等失败继续显示原始错误。
相关前端测试 48 项通过，覆盖人工确认不重发、目标切换、失败保留图片及原有文字发送。

## 项目软件首次试发后的修复

用户已在项目软件选中桌面 PNG，点击发送后遇到 `WECHAT_IMAGE_DIALOG_NOT_FOUND`，
此时微信文件选择框已出现，但尚未填入文件名。重新检查确认控件类型和编号匹配现有实现。
原实现只等待顶层对话框出现，随后立即检查内部控件，会将尚未初始化完成误报为控件缺失。
已改为在原有发送超时内等待文件名框与打开按钮可用，保持窗口归属检查及单次点击。
两个延迟加载回归场景和既有 Qt 测试共 38 项通过；实际项目适配器也已到达可填写文件名的步骤，
验证在填写前主动停止并取消对话框，未发送。完整桌面程序的再次发送由用户验证。
