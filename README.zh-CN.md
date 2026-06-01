# WT 8111 Neo

[English](README.md)

WT 8111 Neo 是一个面向 War Thunder `localhost:8111` 本地遥测服务的辅助工具。当前重点是现代化战术地图工作台，用于地图阅读、目标覆盖层、测距，以及后续炮兵/地图工具。

项目目前仍处于早期开发原型阶段。

## 当前状态

- Web 战术地图工作台：React + Vite + TypeScript。
- Rust 本地 HTTP 服务：Axum。
- Windows 本地控制台：WinUI 3。
- 玩家日常只需要手动启动 WinUI 控制台。
- Rust 服务负责托管构建后的 Web GUI，并把 War Thunder 本机 `8111` 端点代理到局域网可访问的 `17711`。
- Web GUI 中已经移除浏览器侧雷达采集控件。
- 视觉雷达识别方向已暂停，保留为实验性方向记录。

## 运行模型

```text
War Thunder on gaming PC
  -> localhost:8111
  -> WT8111Neo.Control.exe
      -> starts/manages wt-8111-neo.exe
          -> HTTP service on 0.0.0.0:17711
              -> /api/wt/* proxy
              -> static Web GUI
  -> browser on PC / tablet / LAN device
```

日常使用：

1. 启动 `WT8111Neo.Control.exe`。
2. 在 Dashboard 中点击按钮，用浏览器打开 Web GUI。
3. 其他局域网设备访问 `http://<游戏主机 IP>:17711`。

## 开发环境

- Node.js 和 npm。
- Rust 工具链。
- .NET SDK 8。
- Windows App SDK / WinUI 3 构建支持。
- WinUI 控制台要求 Windows 10 19041 或更新版本。

## 构建

构建 Web GUI、Rust 服务和 WinUI 控制台：

```powershell
npm.cmd run control:build
```

Release 控制台输出目录：

```text
src-winui/bin/x64/Release/net8.0-windows10.0.22621.0/win-x64/
```

该目录中应同时存在：

```text
WT8111Neo.Control.exe
wt-8111-neo.exe
```

如果构建提示输出目录中的 `wt-8111-neo.exe` 正在运行，请先关闭当前运行的 WT 8111 Neo 控制台/服务，再重新构建。

## 开发命令

运行 Web GUI 开发服务器：

```powershell
npm.cmd run dev
```

只构建 Web GUI：

```powershell
npm.cmd run build
```

构建 Web GUI 和 Rust 本地服务：

```powershell
npm.cmd run service:build
```

## 端口

- `8111`：War Thunder 官方本地遥测端口。
- `17711`：WT 8111 Neo 本地服务和局域网 Web GUI 端口。
- `5173`：Vite 开发服务器端口。

## 文档

- [War Thunder 8111 API Reference](WT_8111_API_REFERENCE.md)
- [War Thunder 8111 API Reference zh-CN](WT_8111_API_REFERENCE.zh-CN.md)
- [本地服务与原生采集开发记录 zh-CN](NATIVE_CAPTURE_PIPELINE.zh-CN.md)

更新 API 参考时，需要在同一次变更中同步更新中英两个语言版本。

## 安全边界

- 不读取 War Thunder 内存。
- 不注入进程。
- 不把进程 hook 作为第一方案。
- 当前 Web GUI 只消费 War Thunder 通过本地 `8111` 服务暴露的数据，并通过本地代理访问。
- 未来若恢复画面分析方向，也应只处理玩家屏幕上已经可见的像素，并由本地 WinUI 控制台管理相关设置。
