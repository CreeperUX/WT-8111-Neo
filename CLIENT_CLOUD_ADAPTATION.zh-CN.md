# WT 8111 Neo 客户端服务端适配说明

> 当前开发基线：`origin/codex/cloud-tactical-server` / `65ec9b7`
> 本次适配以 `cloud-tactical-server/docs/DEVELOPER.md`、`cloud-tactical-server/docs/API.md`、
> `cloud-tactical-server/docs/PROTOCOL.md` 和 `cloud-tactical-server/protos/*.proto` 为准。

## 方向锚定

- 航迹融合、丢失目标预测、空中 ROI 椭圆由 Cloud Tactical Server 负责。
- 客户端 GUI 不再维护本地 hostile track history，也不在本地外推 ROI。
- Web GUI 的 viewer 角色通过 `/api/rooms/{room_id}/join` 校验房间，再连接 `/ws/rooms/{room_id}/viewer` 接收 `WsEnvelope{FusedSnapshot}`。
- Web GUI 连接前先读取 `/version`，要求服务端 `protocol_version` 与客户端协议版本 `1` 一致。
- 本机 8111 地图仍作为地图底图、玩家位置和无服务端快照时的 demo 回退。

## 当前 Demo 接入

Web GUI 支持用查询参数启用云端 viewer：

```text
?cloud=1&server=http://127.0.0.1:17712&room=alpha-squad
```

也可以显式区分模式：

```text
?cloud=viewer&server=http://127.0.0.1:17712&room=alpha-squad
?cloud=relay&server=http://127.0.0.1:17712&room=alpha-squad
?cloud=both&server=http://127.0.0.1:17712&room=alpha-squad
```

可选参数：

- `password`：房间密码，不写则使用空密码。
- `player`：viewer 展示身份，当前版本只保留配置字段。
- `cloudRelay=1` / `relay=1`：在 viewer 之外启用本机浏览器 relay 上传。

启用后：

- 地图对象优先显示服务端 `FusedSnapshot.tracks`。
- 空战面板显示服务端连接状态、房间、序号、更新时间和 summary。
- `interest_regions` 以服务端提供的椭圆中心、锚点、半长轴、半短轴和航向直接渲染。
- 连接到协议不匹配或旧版本服务端时，viewer 会在建立 WebSocket 前报出协议版本错误。
- relay 模式会通过本地 `/api/wt/map_info.json` 和 `/api/wt/map_obj.json` 采样 8111 数据，发送 `JoinRequest`、`Ping/Pong` 和 `ObservationFrame`。
- `ObservationFrame.measurement_age_ms` 使用本地 8111 采样更新时间到打包发送时的实际间隔；`observed_at_ms` 使用 Ping/Pong 估算的服务端时间线。

## 服务端 v1 协议对齐

- REST：
  - `GET /version`：返回 `service`、`version`、`protocol_version`。
  - `POST /api/rooms/{room_id}/join`：校验房间密码，返回 `relay_url` 和 `viewer_url`。
- WebSocket viewer：
  - 路径：`/ws/rooms/{room_id}/viewer`。
  - 帧格式：二进制 Protobuf `WsEnvelope`。
  - 客户端只消费 `payload.snapshot`，即 `FusedSnapshot`。
- `FusedSnapshot`：
  - `tracks` 使用 `class_id`、`affiliation`、`x_u16/y_u16`、`heading_i16`、`confidence_u8`、`source_count` 和 `flags` 渲染为地图对象。
  - 服务端新增的 `total_age_ms` 和 `contributing_clients` 已被客户端解码并透传到地图对象元数据。
  - `interest_regions` 使用 `center_*`、`anchor_*`、`radius_major_u16`、`radius_minor_u16` 和 `heading_i16` 渲染空中目标消失后的椭圆 ROI。
  - 坐标按 `0..65535` 归一化到 Web GUI 地图坐标。
- Relay：
  - 浏览器 relay 连接 `/ws/rooms/{room_id}/relay` 后首先发送 `WsEnvelope{JoinRequest}`。
  - 加入成功后以 500ms 周期上传 `WsEnvelope{ObservationFrame}`，并以约 7s 周期发送 `Ping` 维持时钟同步。
  - 本机 `local_id` 由客户端按对象签名维护，保证同一浏览器会话内尽量稳定。

## 后续适配

- WinUI 控制台设置页已经补充 Room ID；后续需要把该本地配置注入 Web GUI 启动 URL 或下沉到 Rust service relay。
- 将当前浏览器 relay 逻辑下沉到本地 Rust service，使用户无需保持 Web GUI 页面打开也能上传 observation。
- 空战 GUI 继续围绕 cloud tracks/ROI 强化筛选、告警和航迹列表；陆战 GUI 保留火力计算和地图对象工作流。
