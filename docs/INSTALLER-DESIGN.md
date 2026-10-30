# Windows 安装界面

公开安装包使用独立的 Eve 安装前端：统一绘制文字、卡片、选项、按钮和进度，不再把位图背景与多套原生文字控件拼接。应用安装继续由 electron-builder 的 NSIS 包执行，安装前端通过静默参数传递安装范围与路径。

## 交互

- 默认“仅为我”，也可选择“所有用户”。范围选择同步更新安装路径。
- 路径可直接编辑，支持重置；相对路径、系统目录、磁盘根目录、网络路径和过长路径在开始前拦截。
- 主按钮、范围选择支持鼠标、Tab、空格和 Enter；读屏可获取按钮动作和选中状态。路径栏 Enter 可开始安装。
- 安装运行时显示渐变流动进度与真实耗时。该进度表示安装仍在运行，不提供估算百分比。
- 系统关闭界面动画时，流动效果改为静态状态。安装结束立即停止绘制定时器。
- 文件写入结束后核对 `Eve.exe` 和安装目录的 `build-info.json`；构建编号不匹配时保留失败状态，允许重试。
- “所有用户”由系统确认后执行，安装前端保持普通用户权限。取消系统确认时回到配置页。

## 视觉与运行环境

设计令牌在 `desktop/installer/modern/theme.json`：颜色、文字层级、圆角、主要布局和动画周期集中管理。默认采用浅灰背景、白色卡片、深灰文字和单一蓝色强调色，正文与按钮文字对比度检查不低于 4.5:1。窗口按启动显示器 DPI 缩放，并处理跨显示器 DPI 变化。

前端用 Windows .NET Framework 编译为小型独立可执行文件，不需要为安装界面启动 Electron 或下载额外网页运行时。构建需要 Windows .NET Framework 编译器；运行环境为具备 .NET Framework 4.8 的 Windows 10/11 x64。本轮在当前 Windows 主机测试，干净虚拟机与所有用户的实际提权安装仍需独立验证。卸载确认、进度与完成页复用同一前端，实际移除应用文件后才显示完成；保留用户数据目录。取消卸载不改变现有安装。静默卸载继续由现有 NSIS 引擎执行。

## 打包与验证

```powershell
npm --prefix desktop run dist:win
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/test-installer-ui.ps1 -PackageDir desktop/release -OutDir docs/verification/installer-current
```

构建先产生静默安装引擎，再封装统一界面，最后重新生成 blockmap、更新摘要、SHA-256 和 `installer-build.json`，避免沿用内层安装包的旧校验值。

界面脚本操作真实窗口。其失败、重试与完成测试使用明确标记的本地进程夹具，避免覆盖用户安装；这部分测试不等于实际安装生命周期验证。安装包内容可另用 `electron-smoke.mjs` 的 `EVE_SMOKE_PACKAGED_DIR` 指向指定 `win-unpacked` 目录验证。
