# WT 8111 Neo 客户端服务端适配说明

> 当前开发基线：`origin/codex/cloud-tactical-server`

## 方向锚定

- 航迹融合、丢失目标预测、空中 ROI 椭圆由 Cloud Tactical Server 负责。
- 客户端 GUI 不再维护本地 hostile track history，也不在本地外推 ROI。
- Web GUI 的 viewer 角色通过 `/api/rooms/{room_id}/join` 校验房间，再连接 `/ws/rooms/{room_id}/viewer` 接收 `WsEnvelope{FusedSnapshot}`。
- 本机 8111 地图仍作为地图底图、玩家位置和无服务端快照时的 demo 回退。

## 当前 Demo 接入

Web GUI 支持用查询参数启用云端 viewer：

```text
?cloud=1&server=http://127.0.0.1:17712&room=alpha-squad
```

可选参数：

- `password`：房间密码，不写则使用空密码。
- `player`：viewer 展示身份，当前版本只保留配置字段。

启用后：

- 地图对象优先显示服务端 `FusedSnapshot.tracks`。
- 空战面板显示服务端连接状态、房间、序号、更新时间和 summary。
- `interest_regions` 以服务端提供的椭圆中心、锚点、半长轴、半短轴和航向直接渲染。

## 后续适配

- 将 WinUI 控制台设置页扩展为服务端房间配置入口，避免浏览器 URL 长期携带密码。
- 在本地 relay/service 层实现 `JoinRequest`、`ObservationFrame` 上传和 NTP-style `Ping/Pong` 时钟同步。
- 空战 GUI 继续围绕 cloud tracks/ROI 强化筛选、告警和航迹列表；陆战 GUI 保留火力计算和地图对象工作流。
