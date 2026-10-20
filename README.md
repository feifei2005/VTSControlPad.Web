# VTS Control Pad（WebView2 重写版）

VTube Studio 控制面板。连上 VTube Studio 官方 WebSocket API，集中管理**热键**、**表情**和 **Live2D 参数**。

> **原作者 / Original author**：本项目的原型 **VTSControlPad** 由 [xiaoye97](https://github.com/xiaoye97) 开发（源码未公开，仅通过 itch.io 分发）。
> **本仓库**由 [feifei2005](https://github.com/feifei2005) **重写**：换成 **Go 宿主 + WebView2** 的纯 Web 技术栈，界面与协议全部重新实现，不再依赖 Unity 运行时。

---

## 为什么重写

原版基于 Unity，即使界面全静止也在跑完整的渲染循环，空载就会持续占用 CPU。重写后：

| | 原版（Unity） | 本版（WebView2） |
|---|---|---|
| 界面渲染 | Unity 渲染循环，常驻帧率 60fps | Chromium 静态页面，**无动画无过渡**，静止时几乎 0 CPU |
| 参数注入频率 | 跟随渲染帧发送（60 / 120fps） | 固定在 **约 30Hz**，且只发送已开启的项 |
| 模型状态轮询 | 0.5s | **1s** |
| 分发体积 | Unity 运行时依赖 | 单个 exe，约 4 MB |

## 功能

- **UDP 47779 端口自动发现**：自动找到本机运行的 VTube Studio 实例，无需手填地址
- **连接鉴权**：走官方 `AuthenticationRequest` 流程，token 保存在本地，下次启动免弹窗
- **热键**：列出当前模型的全部热键并一键触发
- **表情**：列出全部表情，开关状态实时同步
- **Live2D 参数**：列出模型全部可注入参数（默认参数 + 自定义参数），拖动滑块即可实时注入
- **多语言**：中文 / English
- **自适应布局**：列表按列自动换行，窗口拖宽就多排几列，拖窄自动减少
- **开关用颜色表达**：不占位置，整块染蓝即为已开启
- 断线自动重连（最多 5 次），连接状态四色指示灯

## 运行

要求 Windows 10/11，且已安装 **Microsoft Edge WebView2 Runtime**（Win10 1803+ / Win11 一般已预装，否则从[官网](https://developer.microsoft.com/microsoft-edge/webview2/)安装 Evergreen 版本）。

1. 启动 VTube Studio，在 **设置 → 插件 → 开启 API**（端口默认 8001）
2. 运行 `VTSControlPad.exe`
3. 首次连接时 VTS 会弹出授权窗口，点击「允许」即可

## 从源码构建

需要 Go（启用 CGO）和一个 mingw-w64 的 gcc（[WinLibs](https://winlibs.com/) 或 MSYS2 都行），把它放进 PATH：

```bash
go build -ldflags "-H=windowsgui -s -w" -o VTSControlPad.exe .
```

`-H=windowsgui` 去掉控制台窗口，`-s -w` 去掉调试信息。WebView2 加载器由 `webview.h` 内置实现，因此**不需要额外分发 `WebView2Loader.dll`**。

运行时加 `-debug` 可打开开发者工具（F12），加 `-discover-timeout` 可调整 UDP 发现的等待时长。

## 目录结构

```text
main.go        窗口创建、JS 绑定、把 web/ 打包进单文件
discovery.go   UDP 47779 端口发现（浏览器沙箱拿不到 UDP，必须由宿主做）
settings.go    本地设置与 token 持久化（等价于原版的 PlayerPrefs）
web/index.html 页面骨架
web/app.css    样式（刻意不含任何 transition / animation）
web/i18n.js    中英词条
web/vts.js     VTube Studio WebSocket API 的最小实现
web/app.js     界面逻辑：连接、三块列表、参数注入、多语言
```

设置与日志写在 `%APPDATA%\VTSControlPad.Web\`。

## 许可证

**GNU General Public License v3.0**，见 [LICENSE](LICENSE)。

```text
Copyright (C) 2026 feifei2005
```

原版 VTSControlPad 的著作权归 xiaoye97 所有；本仓库是独立重新实现，仅沿用其功能设计与协议行为。

---

## English

VTS Control Pad — a control panel for VTube Studio (hotkeys, expressions and Live2D parameters), talking to the official VTube Studio WebSocket API.

**This repository is a rewrite by [feifei2005](https://github.com/feifei2005)** of the original **VTSControlPad** by [xiaoye97](https://github.com/xiaoye97) (closed source, distributed via itch.io). The Unity runtime has been replaced by a Go host embedding WebView2, so the UI is plain HTML/CSS/JS. The UI is intentionally static (no transitions or animations) and parameters are injected at a fixed ~30 Hz instead of once per rendered frame, which removes the idle CPU cost of the Unity build.

Requires Windows 10/11 with the Edge WebView2 Runtime. Start VTube Studio with the API enabled (default port 8001), run the exe, and accept the authorization prompt on first launch.

Build with Go (CGO) + a mingw-w64 gcc on PATH:

```bash
go build -ldflags "-H=windowsgui -s -w" -o VTSControlPad.exe .
```

Licensed under the **GNU General Public License v3.0**.
