# WT 8111 Neo 本地服务与原生采集开发记录

最后更新：2026-06-01

## 当前结论

雷达画面采集与识别功能暂时搁置。

目前项目主线先回到更稳的地图与 8111 数据二次开发：Web GUI 负责地图、态势显示与炮兵/测距工具；WinUI 3 本地控制台作为玩家手动启动的唯一入口；Rust portable 服务作为控制台托管的本地子进程，负责代理 8111 数据、托管 Web GUI，并为后续本地设置与联机同步能力预留入口。

雷达识别相关代码可以作为实验性原型保留，但暂时不作为当前版本的可交付功能继续推进。

## 已完成进度

### 8111 数据与文档

- 已探测 War Thunder `localhost:8111` 能提供的主要数据。
- 已建立英文 API 参考文档：
  - `WT_8111_API_REFERENCE.md`
- 已建立中文翻译版：
  - `WT_8111_API_REFERENCE.zh-CN.md`
- 后续更新 8111 API 文档时，需要同步维护多语言版本。

### Web GUI 地图功能

- 已建立 React + Vite + TypeScript 前端。
- Web GUI 当前定位为地图工作台，不再保留雷达采集控件。
- 已完成 8111 地图数据读取与展示：
  - `map_info.json`
  - `map_obj.json`
  - `map.img`
- 已实现地图对象列表、地图元数据、玩家位置状态。
- 已实现地图缩放、平移、重置视图。
- 已实现点击地图设置测距点。
- 已实现玩家到目标点的距离与方位计算。
- 已优化目标标记尺寸，避免遮挡地图阅读。
- 已将地图符号改为独立 overlay 渲染，符号在缩放地图时保持恒定视觉大小。
- 已修复缩放/移动时符号漂移问题。
- 已优化目标测距标记的视觉风格，使圈、编号和连线更简洁。

### 本地 portable 服务

- 已从 Tauri WebView 思路调整为 portable 本地服务 + 浏览器访问。
- Rust 服务基于 Axum。
- 本地服务监听：

```text
0.0.0.0:17711
```

- Web GUI 可通过以下方式访问：

```text
http://127.0.0.1:17711
http://<游戏主机局域网 IP>:17711
```

- 服务负责代理 War Thunder 官方 8111 端口，避免平板或其他局域网设备错误访问自身的 `localhost:8111`。
- 构建后的 Web 静态资源会嵌入 release exe。

### Web API 路由

当前 Web GUI 可用路由：

```text
GET  /api/health
GET  /api/wt/map_info.json
GET  /api/wt/map_obj.json
GET  /api/wt/map.img
GET  /api/wt/indicators
GET  /api/wt/state
GET  /api/wt/mission.json
GET  /api/wt/gamechat
GET  /api/wt/hudmsg
```

已移除浏览器侧雷达采集控制路由，不再公开：

```text
/api/native-capture/*
```

### WinUI 3 本地控制台原型

已将本地客户端 GUI 方向调整为 WinUI 3。旧的 Rust `native-windows-gui` 原型不再作为主流程使用，Rust 程序回到纯本地 HTTP 服务，WinUI 3 客户端作为独立的现代化本机控制台。

当前启动方式已调整为绑定式启动：玩家只需要启动 WinUI 3 控制台，控制台会自动检查 `127.0.0.1:17711`，如果本地服务未运行，则自动启动同目录下的 `wt-8111-neo.exe`。如果端口上已经存在服务，控制台会复用现有服务，不会强行重启。

项目位置：

```text
src-winui/
```

当前页面：

- Dashboard：服务说明、Web GUI 本机地址、打开浏览器、复制 URL。
- Sync：后续联机态势汇总设置入口。
- Capture：雷达识别暂停说明，不提供可操作采集入口。
- About：当前架构说明。

目前设计职责：

- 作为 portable 包的唯一手动启动入口。
- 自动启动并托管 Rust 本地服务进程。
- 关闭控制台时，结束由控制台自动启动的本地服务进程。
- 显示 Web GUI 本机地址。
- 打开默认浏览器访问 Web GUI。
- 后续保存 portable 配置到程序目录下：

```text
config/settings.json
```

- 预留后续联机态势汇总设置：
  - 是否启用上传。
  - 服务器地址。
  - 玩家名称。
  - 访问密码。
- 预留雷达采集设置：
  - 当前仅显示暂停状态。
  - 未来如恢复，应在 WinUI 3 本地客户端内操作，不放回 Web GUI。

注意：由于雷达识别功能当前暂停，本地控制台里的 Capture 页面只保留研究说明。

## 暂停的雷达识别方向

### 已尝试内容

- 浏览器 `getDisplayMedia` 画面采集。
- Web canvas 中提取雷达 ROI。
- SDR/HDR 模式开关。
- 尝试将 HDR/SDR 输入统一转换为 SDR 工作图像。
- 基于亮度与色度阈值进行雷达点识别。
- Rust 原生侧使用 Windows Graphics Capture 的原型：
  - SDR 使用 `RGBA8`。
  - HDR 尝试使用 `RGBA16F`。
  - ROI 裁剪。
  - 低分辨率工作图像。
  - 点位检测。

### 暂停原因

- 浏览器采集路径对 HDR 信号不可控，通常只能拿到系统/浏览器合成后的 SDR-like 图像。
- HDR 到 SDR 的转换效果仍需要更严谨的色彩管理与真实样本校准。
- 仅靠画面阈值检测容易受游戏 UI、亮度、背景、压缩、HDR 映射影响。
- 继续推进会占用较多时间，但当前项目更需要先稳定地图、8111 代理、portable 服务与后续联机架构。

### 保留原则

- 不读取游戏内存。
- 不注入 War Thunder 进程。
- 不使用进程 hook 作为第一方案。
- 仅分析玩家屏幕上已经可见的信息。
- 后续如果恢复该方向，优先把采集控制保留在本地 UI，不放回 Web GUI。

## 当前架构

```text
War Thunder on gaming PC
  -> localhost:8111
  -> WinUI 3 local control client
      -> starts/manages wt-8111-neo.exe
          -> HTTP service on 0.0.0.0:17711
              -> /api/wt/* proxy
              -> static Web GUI
      -> config/settings.json
  -> browser on PC / tablet / LAN device
```

关键边界：

- Web GUI 只做浏览器端显示与交互。
- Rust 本地程序负责游戏主机上的服务。
- WinUI 3 本地客户端负责启动/关闭本地服务、配置、后续采集控制与后续联机通信设置。
- 局域网设备只访问 `17711`，不直接访问 War Thunder `8111`。
- 敏感配置不放在 Web GUI。

## 技术栈

- Web GUI：React + Vite + TypeScript
- 地图图标：SVG overlay + React
- 本地服务：Rust + Axum
- 静态资源嵌入：`rust-embed`
- 8111 代理：`reqwest`
- 本地控制台：WinUI 3 + C#
- 原生采集实验：Windows Graphics Capture

## 端口

- `17711`：WT 8111 Neo 本地服务端口
- `8111`：War Thunder 官方本地遥测端口
- `5173`：开发期 Vite 端口

## 构建与验证记录

已通过：

```text
npm.cmd run build
npm.cmd run control:build
```

当前 WinUI release 输出目录：

```text
C:\Users\Creep\Documents\WT 8111 Neo\src-winui\bin\x64\Release\net8.0-windows10.0.22621.0\win-x64\
```

该目录中应同时存在 `WT8111Neo.Control.exe` 与 `wt-8111-neo.exe`。玩家日常只启动 `WT8111Neo.Control.exe`。

曾遇到的问题与调整：

- 旧 exe 运行时会导致 release 构建无法覆盖目标文件。
- `native-windows-gui` 使用 `GetWindowSubclass` 时出现过入口点解析错误。
- 为避免继续投入旧 GUI 原型，已将本地客户端方向改为 WinUI 3。
- Rust 服务已拆回纯 HTTP 服务进程。

## 下一阶段建议

优先级从高到低：

1. 稳定 Web 地图工作台。
2. 完善地图对象分类、过滤、图层开关。
3. 增强炮兵地图工具：
   - 多测距点。
   - 方位/距离复制。
   - 网格坐标显示。
   - 标记管理。
4. 设计后续联机态势汇总协议。
5. 设计本地设置文件格式与安全策略。
6. 等地图与联机基础稳定后，再评估是否恢复雷达识别方向。

## Portable 目标形态

```text
WT 8111 Neo/
  WT8111Neo.Control.exe
  wt-8111-neo.exe
  config/
    settings.json
  logs/
```

玩家日常只需要启动 `WT8111Neo.Control.exe`。`wt-8111-neo.exe` 需要随控制台放在同一目录下，但不需要玩家单独手动启动。

正式分发前需要补充：

- 日志目录。
- 版本号展示。
- 防火墙说明。
- 局域网访问说明。
- 配置迁移策略。
- 如进入联机功能，访问密码不应长期以明文方式保存。
