# WT 8111 Neo 云端态势服务开发记录

最后更新：2026-06-01

## 1. 目标

本文件记录后续云端态势服务的基础想法与开发要求，供服务端团队并行开发使用。

云端态势服务的核心目标是：接收多个玩家本机 relay 上传的 War Thunder 8111 观测数据，在云端完成目标归一化、目标指纹识别、多源航迹融合、目标消失后的兴趣区域预测，并向 Web GUI 提供统一的单一态势图。

当前 Web GUI 已经具备本机地图显示、目标列表、敌方目标 3 秒航迹、15 秒兴趣区域预测等原型能力。后续应逐步将这些状态型计算迁移到云端服务，Web GUI 只负责轻量渲染和交互。

## 2. 总体架构

```text
Player PC A
  War Thunder localhost:8111
    -> WT 8111 Neo local relay
        -> observation upload

Player PC B
  War Thunder localhost:8111
    -> WT 8111 Neo local relay
        -> observation upload

Cloud Tactical Server
  -> authentication / room management
  -> observation ingest
  -> time normalization
  -> target fingerprinting
  -> multi-source track fusion
  -> hostile track history
  -> predicted interest regions
  -> fused tactical snapshot output

Web GUI / LAN device / tablet
  -> subscribe fused tactical snapshot
  -> render map, tracks, ROI, target list
```

## 3. 职责边界

### 本机 relay

- 从 War Thunder `localhost:8111` 读取官方本地遥测数据。
- 只读取游戏公开暴露的 8111 数据，不读内存、不注入、不 hook。
- 将原始 8111 数据转换为云端协议需要的观测帧。
- 尽量不要直接上传完整原始 JSON。
- 负责本机时间戳、玩家身份、房间信息、地图代号/地图 generation 等基础元数据。
- 网络异常时应本地降级运行，不影响本机 Web GUI 基础地图功能。

### 云端态势服务

- 管理房间、客户端、认证、权限。
- 接收多个本机 relay 上传的观测帧。
- 对观测目标做归一化、分类、指纹识别。
- 为目标分配稳定的云端 `trackId`。
- 对多客户端观测进行航迹融合。
- 保留敌方目标最近 3 秒航迹。
- 当敌方目标消失后，基于航迹速度进行运动学预测，保留 15 秒兴趣区域。
- 输出统一态势快照，供 Web GUI 订阅。
- 不依赖任何游戏内存读取或注入行为。

### Web GUI

- 不再负责重型目标识别、航迹关联和 ROI 预测。
- 通过 HTTP/WebSocket/SSE 获取云端融合后的轻量态势快照。
- 负责地图绘制、目标列表、过滤、交互选择、距离/方位显示。
- 后续目标是让 Web GUI 只消费 `FusedSnapshot`，而不是直接处理原始 `map_obj.json`。

## 4. Docker 部署要求

服务端应优先按 Docker 部署设计，方便独立管理、升级和回滚。

建议目标形态：

```text
cloud-tactical-server/
  Dockerfile
  docker-compose.yml
  config/
    server.example.yaml
  migrations/
  src/
  README.md
```

基础要求：

- 提供 `Dockerfile`。
- 提供 `docker-compose.yml` 示例。
- 服务配置通过环境变量和配置文件注入。
- 不将密钥写入镜像。
- 日志输出到 stdout/stderr，便于 Docker 日志采集。
- 支持健康检查接口，例如 `GET /healthz`。
- 支持版本信息接口，例如 `GET /version`。
- 服务端口、数据库地址、Redis 地址、JWT 密钥、房间策略等应可配置。

推荐 compose 组件：

```text
cloud-tactical-server
redis               optional, for room state / pubsub
postgres            optional, for accounts / audit / persistent sessions
reverse-proxy       optional, e.g. Caddy / Nginx / Traefik
```

第一阶段可以先使用内存态房间和航迹状态，待协议稳定后再接入 Redis/PostgreSQL。

## 5. 通信模型

不建议使用“每个目标一个 JSON 请求”或“持续上传完整 `map_obj.json`”。

推荐：

- 使用长连接。
- 一个 tick 上传一个观测帧。
- 一个观测帧包含当前客户端本次观测到的全部相关目标。
- 静态地图信息只在变化时上传。
- 动态目标使用 keyframe + delta 方案。
- 协议优先考虑二进制封装，减少包体和重复字段。

候选传输方式：

- 第一阶段：WebSocket binary。
- 后续可评估：WebTransport / QUIC。

候选编码方式：

- 推荐：Protobuf。
- 可选：MessagePack / CBOR。
- 暂不推荐第一阶段使用 FlatBuffers / Cap'n Proto，除非团队已有成熟经验。

## 6. 上传观测帧

本机 relay 上传的是 observation，不是最终态势。

建议第一版逻辑帧：

```ts
interface ObservationFrame {
  protocolVersion: number;
  sessionId: string;
  roomId: string;
  clientId: string;
  playerName?: string;
  seq: number;
  observedAtMs: number;
  mapGeneration: number;
  mapId?: string;
  player?: ObservedPlayer;
  objects: ObservedObject[];
  removedLocalIds?: number[];
}

interface ObservedPlayer {
  xU16: number;
  yU16: number;
  headingI16?: number;
}

interface ObservedObject {
  localId: number;
  labelId: number;
  classId: number;
  affiliation: number;
  xU16: number;
  yU16: number;
  headingI16?: number;
  colorId?: number;
  flags: number;
}
```

说明：

- 坐标采用 `0..65535` 量化，而不是 JSON 浮点数。
- `labelId`、`classId`、`colorId` 应来自会话字典，避免重复传字符串。
- `localId` 由本机 relay 对本机观测目标分配，只保证客户端本地稳定。
- 云端负责将多个 `localId` 融合成统一 `trackId`。
- `observedAtMs` 必须来自本机采样时间，不应使用云端接收时间替代。

## 7. 云端下发快照

Web GUI 消费云端融合后的 `FusedSnapshot`。

建议第一版逻辑结构：

```ts
interface FusedSnapshot {
  protocolVersion: number;
  roomId: string;
  seq: number;
  serverTimeMs: number;
  mapGeneration: number;
  tracks: FusedTrack[];
  interestRegions: InterestRegion[];
  summary: TacticalSummary;
}

interface FusedTrack {
  trackId: string;
  labelId: number;
  classId: number;
  affiliation: number;
  xU16: number;
  yU16: number;
  headingI16?: number;
  vxI16?: number;
  vyI16?: number;
  confidenceU8: number;
  lastSeenMsAgo: number;
  sourceCount: number;
  flags: number;
}

interface InterestRegion {
  trackId: string;
  xU16: number;
  yU16: number;
  radiusU16: number;
  expiresInMs: number;
  confidenceU8: number;
}

interface TacticalSummary {
  totalTracks: number;
  hostileTracks: number;
  friendlyTracks: number;
  staleTracks: number;
  interestRegions: number;
}
```

## 8. 目标指纹与航迹要求

目标指纹用于把不同 tick、不同客户端看到的目标关联起来。第一阶段可以使用：

- 阵营。
- 对象 label/type/icon。
- 对象分类：air / ground / objective / spawn / other。
- 颜色签名。
- 最近位置。
- 最近速度。
- 观测来源。

敌方目标显示规则：

- 目标可见时，保留最近 3 秒航迹。
- 目标消失后，基于最后航迹速度外推位置。
- 消失目标兴趣区域保留 15 秒。
- ROI 半径应随丢失时间增加。
- ROI 置信度应随丢失时间降低。
- 目标重新出现并成功关联后，应回到正常航迹状态。

云端应避免仅依赖数组 index 作为身份依据。War Thunder `map_obj.json` 的数组顺序不能作为稳定身份。

## 9. 频率建议

第一阶段建议：

```text
local relay reads 8111 map data: 2 Hz
local relay uploads observation: 1-2 Hz
cloud fusion tick: 2 Hz
Web GUI receives fused snapshot: 1-2 Hz
mission/chat/hud auxiliary data: 0.5-1 Hz or event driven
```

后续可以针对不同数据分层：

- 地图目标：1-2 Hz。
- 航迹/ROI：跟随 fusion tick。
- 聊天/HUD：事件驱动或低频。
- 地图静态元数据：仅 generation 变化时同步。

## 10. 安全与权限

服务端必须支持：

- TLS 部署。
- 房间隔离。
- 客户端认证。
- 访问令牌过期与刷新。
- 基础速率限制。
- 无效协议版本拒绝。
- 房间密码或邀请 token。
- 日志中不输出明文密钥。

需要明确：

- 不允许云端要求客户端读取 War Thunder 内存。
- 不允许云端要求客户端注入或 hook 游戏进程。
- 上传数据应限定在 8111 公开遥测、本机玩家配置和用户明确允许的数据范围内。

## 11. 推荐接口

HTTP：

```text
GET  /healthz
GET  /version
POST /api/rooms
GET  /api/rooms/{roomId}
POST /api/rooms/{roomId}/join
```

WebSocket：

```text
WS /ws/rooms/{roomId}/relay
WS /ws/rooms/{roomId}/viewer
```

relay 连接：

- 客户端上传 `ObservationFrame`。
- 服务端返回 ack、协议错误、重发 keyframe 请求。

viewer 连接：

- 服务端下发 `FusedSnapshot` 或 `FusedDelta`。
- Web GUI 不应直接订阅所有 relay 原始数据。

## 12. 开发阶段建议

### 阶段 1：协议与 Docker 骨架

- 建立服务端项目。
- 建立 Dockerfile 和 compose。
- 定义 Protobuf schema。
- 建立 WebSocket relay/viewer 双通道。
- 实现房间内广播假数据快照。

### 阶段 2：单客户端观测上传

- 本机 relay 上传 observation。
- 云端解析并转成 fused snapshot。
- Web GUI 从云端 snapshot 渲染地图。
- 不做多源融合，只验证链路。

### 阶段 3：目标指纹与单源航迹

- 云端分配 `trackId`。
- 实现 3 秒航迹。
- 实现 15 秒 ROI。
- Web GUI 移除本地航迹计算，改为消费云端结果。

### 阶段 4：多源融合

- 多客户端观测同一目标合并为一个 `trackId`。
- 引入置信度。
- 引入来源数量和最近观测时间。
- 处理时间偏移和断线重连。

### 阶段 5：生产化

- 认证。
- 房间权限。
- 日志与指标。
- Redis/PostgreSQL 持久化。
- 反向代理 TLS。
- 压测和异常恢复。

## 13. 待确认问题

- 第一版服务端语言和框架。
- 是否使用 Protobuf 作为第一版协议。
- 房间身份模型：匿名房间、账号体系，还是一次性邀请 token。
- 云端是否保存历史态势，保存多久。
- 多客户端时间同步策略。
- 地图 ID 如何从 8111 数据可靠推断。
- 是否允许 viewer 只读连接不上传 observation。
- 是否需要公网部署，还是先局域网 Docker 部署。

## 14. 当前建议

第一版不要追求复杂分布式架构。建议先实现：

```text
Dockerized service
  -> in-memory rooms
  -> WebSocket binary
  -> Protobuf schema
  -> observation upload
  -> fused snapshot broadcast
  -> single-source track + ROI
```

等协议、Web GUI 和本机 relay 跑通后，再加入 Redis/PostgreSQL、多源融合、账号权限和生产部署细节。
