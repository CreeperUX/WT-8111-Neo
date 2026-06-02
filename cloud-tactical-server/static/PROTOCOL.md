# WT 8111 Neo Cloud Tactical Server — WebSocket Protocol

> **Protocol Version:** 1  
> **Wire Format:** WebSocket binary frames, Protobuf-encoded `WsEnvelope`  
> **Schema Files:** `protos/envelope.proto`, `protos/observation.proto`, `protos/snapshot.proto`

---

## 1. Wire Format

Every WebSocket message (both directions) is a single Protobuf `WsEnvelope` message encoded as a binary frame.

```
WebSocket Binary Frame
  └── WsEnvelope (protobuf)
        ├── observation: ObservationFrame     // relay → server
        ├── snapshot: FusedSnapshot           // server → viewer
        ├── join_request: JoinRequest         // relay → server
        ├── join_response: JoinResponse       // server → relay
        ├── error: ErrorResponse              // bidirectional
        ├── ack: Ack                          // bidirectional
        ├── request_keyframe: RequestKeyframe // server → relay
        ├── ping: Ping                        // relay → server
        └── pong: Pong                        // server → relay
```

Text frames are **not** used in normal operation (v1).

---

## 2. Message Envelope

```protobuf
message WsEnvelope {
  oneof payload {
    ObservationFrame observation = 1;
    FusedSnapshot snapshot = 2;
    JoinRequest join_request = 3;
    JoinResponse join_response = 4;
    ErrorResponse error = 5;
    Ack ack = 6;
    RequestKeyframe request_keyframe = 7;
    Ping ping = 8;
    Pong pong = 9;
  }
}
```

### Handshake Messages

#### `JoinRequest` (relay → server)

Sent immediately after WebSocket connection opens. Must be the first message.

```protobuf
message JoinRequest {
  string room_id = 1;
  string password = 2;
  string client_id = 3;
  string player_name = 4;
  uint32 protocol_version = 5;   // must match server (currently 1)
}
```

#### `JoinResponse` (server → relay)

```protobuf
message JoinResponse {
  bool accepted = 1;
  string session_id = 2;              // server-assigned session
  uint32 server_protocol_version = 3;
  string error_message = 4;           // non-empty if !accepted
}
```

### Keepalive

#### `Ping` / `Pong`

```protobuf
message Ping { uint64 client_time_ms = 1; }
message Pong { uint64 client_time_ms = 1; uint64 server_time_ms = 2; }
```

Clients should send a `Ping` every 30 seconds. Server responds with `Pong`.

### Control Messages

#### `ErrorResponse`

```protobuf
message ErrorResponse {
  uint32 code = 1;      // HTTP-like status code
  string message = 2;   // Human-readable
}
```

#### `Ack`

```protobuf
message Ack { uint64 seq = 1; }
```

Used to acknowledge receipt of a specific `ObservationFrame.seq`. Server may request a keyframe replay if frames are lost.

#### `RequestKeyframe`

```protobuf
message RequestKeyframe { string reason = 1; }
```

Server sends this to request a full observation set (not delta) from the client.

---

## 3. Observation Upload (relay → server)

### `ObservationFrame`

Sent by relay clients at 1–2 Hz. Contains all currently observed map objects from War Thunder's `localhost:8111`.

```protobuf
message ObservationFrame {
  uint32 protocol_version = 1;       // must be 1
  string session_id = 2;
  string room_id = 3;
  string client_id = 4;              // unique per client instance
  string player_name = 5;
  uint64 seq = 6;                    // monotonically increasing frame counter
  uint64 observed_at_ms = 7;         // server-synced timestamp (client applies §9 clock sync)
  uint32 map_generation = 8;         // War Thunder map generation
  string map_id = 9;                 // optional, map identifier
  ObservedPlayer player = 10;        // self position
  repeated ObservedObject objects = 11;
  repeated uint32 removed_local_ids = 12;  // localIds removed this tick
  uint32 measurement_age_ms = 13;      // ms since 8111 sample was taken (client reports strictly factual value)
}
```

### `ObservedPlayer`

```protobuf
message ObservedPlayer {
  uint32 x_u16 = 1;      // 0..65535 normalized map X
  uint32 y_u16 = 2;      // 0..65535 normalized map Y
  int32 heading_i16 = 3; // heading in degrees * 100
}
```

### `ObservedObject`

```protobuf
message ObservedObject {
  uint32 local_id = 1;      // client-local stable ID
  uint32 label_id = 2;      // session dictionary index for icon/type
  uint32 class_id = 3;      // 0=air 1=ground 2=objective 3=spawn 4=other
  uint32 affiliation = 4;   // 0=friend 1=hostile 2=neutral 3=unknown
  uint32 x_u16 = 5;         // 0..65535 normalized X
  uint32 y_u16 = 6;         // 0..65535 normalized Y
  int32 heading_i16 = 7;    // heading * 100 (optional)
  uint32 color_id = 8;      // session dictionary index for color
  uint32 flags = 9;         // bit flags (bit0=blink, etc.)
}
```

---

## 4. Fused Snapshot (server → viewer)

### `FusedSnapshot`

Broadcast to all viewers in a room at ~2 Hz. Contains the server's fused tactical picture.

```protobuf
message FusedSnapshot {
  uint32 protocol_version = 1;
  string room_id = 2;
  uint64 seq = 3;                       // server monotonic frame counter
  uint64 server_time_ms = 4;
  uint32 map_generation = 5;
  repeated FusedTrack tracks = 6;
  repeated InterestRegion interest_regions = 7;
  TacticalSummary summary = 8;
}
```

### `FusedTrack`

A unified target track. Multiple relay clients observing the same target from `localhost:8111` are merged into one track. See §12 Multi-Client Fusion for details on the weighted merging strategy.

```protobuf
message FusedTrack {
  string track_id = 1;           // server-assigned stable ID (e.g. "trk_00000001")
  uint32 label_id = 2;
  uint32 class_id = 3;
  uint32 affiliation = 4;
  uint32 x_u16 = 5;              // current position
  uint32 y_u16 = 6;
  int32 heading_i16 = 7;         // heading * 100
  int32 vx_i16 = 8;              // velocity X (quantized)
  int32 vy_i16 = 9;              // velocity Y (quantized)
  uint32 confidence_u8 = 10;     // 0..255, 255 = fully confirmed
  uint32 last_seen_ms_ago = 11;  // ms since last observation
  uint32 source_count = 12;      // number of relay clients observing this track
  uint32 flags = 13;
  uint32 total_age_ms = 14;      // age of most recent observation (measurement + transit)
  uint32 contributing_clients = 15; // unique clients in last 2s window (deduplicated)
}
```

### `InterestRegion`

Elliptical predicted area of interest for a target that has disappeared from observation.

**Only generated for aircraft (class_id=0).** Ground vehicles (tanks, SPAA, etc.) do
not benefit from velocity-based ellipse prediction due to their low speed and limited
maneuverability — they simply fade out as regular stale tracks.

The ellipse center is offset ahead of the anchor point along the velocity direction.
The major axis aligns with the target's last known heading, and grows faster (velocity-dependent).
The minor axis is perpendicular and grows slower (time-dependent).

```protobuf
message InterestRegion {
  string track_id = 1;            // associated track
  uint32 center_x_u16 = 2;        // ellipse center X (velocity-predicted)
  uint32 center_y_u16 = 3;        // ellipse center Y
  uint32 anchor_x_u16 = 4;        // last known position X (for reference line)
  uint32 anchor_y_u16 = 5;        // last known position Y
  uint32 radius_major_u16 = 6;    // semi-major axis (along heading, grows fast)
  uint32 radius_minor_u16 = 7;    // semi-minor axis (perpendicular, grows slow)
  int32 heading_i16 = 8;          // major axis direction (deg × 100, 0 = north)
  uint32 expires_in_ms = 9;       // remaining lifetime
  uint32 confidence_u8 = 10;      // decays over time (255 → 20 over 15s)
}
```

**Rendering hint:** Draw an ellipse centered at `(center_x, center_y)`, rotated by `heading/100` degrees, with semi-axes `(radius_major, radius_minor)`. Optionally draw a line from `(anchor_x, anchor_y)` to `(center_x, center_y)` to show the target's last-known displacement.

**Growth model:**
- `radius_major` = 200 + speed_bonus + time_growth (max 5000)
  - speed_bonus ≈ speed × elapsed × 800
- `radius_minor` = 200 + 150 × √elapsed (max 2000)
- `confidence` = 255 × (1 − elapsed / roi_ttl)

### `TacticalSummary`

```protobuf
message TacticalSummary {
  uint32 total_tracks = 1;
  uint32 hostile_tracks = 2;
  uint32 friendly_tracks = 3;
  uint32 stale_tracks = 4;      // tracks with active ROI prediction
  uint32 interest_regions = 5;
}
```

---

## 5. Coordinate System

- Map coordinates are **normalized to `0..65535`** (u16 range).
- `x=0, y=0` = map origin (top-left in game map coordinates).
- `x=65535, y=65535` = map extent.
- To convert to world coordinates, use `map_min` / `map_max` from War Thunder's `map_info.json`:
  ```
  world_x = map_min[0] + (x_u16 / 65535.0) * (map_max[0] - map_min[0])
  world_y = map_min[1] + (y_u16 / 65535.0) * (map_max[1] - map_min[1])
  ```

---

## 6. Object Classification

### `class_id`

| Value | Meaning |
|-------|---------|
| 0 | Air (aircraft, helicopter, drone) |
| 1 | Ground (tank, SPAA, armored vehicle) |
| 2 | Objective (capture point, bombing target) |
| 3 | Spawn (respawn point, airfield) |
| 4 | Other (structure, unknown) |

### `affiliation`

| Value | Meaning |
|-------|---------|
| 0 | Friend |
| 1 | Hostile |
| 2 | Neutral |
| 3 | Unknown |

### `flags` (bitfield)

| Bit | Meaning |
|-----|---------|
| 0 | Blink (flashing marker) |
| 1 | Has icon background |
| 2–7 | Reserved |

---

## 7. Message Flow Examples

### Relay Connection

```
Client                                   Server
  |                                         |
  |── WS Connect ──────────────────────────>|
  |<── WS Accepted ──────────────────────── |
  |                                         |
  |── WsEnvelope{JoinRequest} ────────────>|
  |     protocol_version: 1                 |
  |     room_id: "alpha-squad"              |
  |     password: "s3cret"                  |
  |     player_name: "Player1"              |
  |                                         |
  |<── WsEnvelope{JoinResponse} ─────────── |
  |     accepted: true                      |
  |     session_id: "uuid-..."              |
  |                                         |
  |── WsEnvelope{Observation} ────────────>|
  |     seq: 1, objects: [...]              |
  |                                         |
  |── WsEnvelope{Ping} ───────────────────>|
  |<── WsEnvelope{Pong} ─────────────────── |
  |                                         |
  |── WsEnvelope{Observation} ────────────>|
  |     seq: 2, objects: [...]              |
  |                                         |
  |── WS Close ───────────────────────────>|
```

### Viewer Connection

```
Client                                   Server
  |                                         |
  |── WS Connect ──────────────────────────>|
  |<── WS Accepted ──────────────────────── |
  |                                         |
  |<── WsEnvelope{FusedSnapshot} ────────── |
  |     tracks: 12, interest_regions: 3     |
  |                                         |
  |<── WsEnvelope{FusedSnapshot} ────────── |
  |     tracks: 14, interest_regions: 2     |
  |     (500ms later)                       |
  |                                         |
  |── WS Close ───────────────────────────>|
```

---

## 8. Data Rates

| Channel | Direction | Rate | Payload |
|---------|-----------|------|---------|
| relay → server | upload | 1–2 Hz | ObservationFrame (~50–500 bytes per target) |
| server → viewer | broadcast | 2 Hz | FusedSnapshot (proportional to track count) |
| Ping/Pong | bidirectional | ~0.03 Hz | ~16 bytes |

---

## 9. Clock Synchronization

Multi-client track fusion requires a common time reference. Each relay client **must** align its observation timestamps to the server clock.

### Procedure (NTP-style)

1. Client records local time `T1`, sends `Ping{client_time_ms: T1}`
2. Server responds with `Pong{client_time_ms: T1, server_time_ms: T2}`
3. Client records receive time `T3`
4. Client computes:
   - `RTT = T3 - T1`
   - `offset = T2 - (T1 + RTT / 2)`
   - `estimated_server_time = local_time + offset`
5. Client sets `ObservationFrame.observed_at_ms = estimated_server_time`
6. Repeat every 5–10 seconds, use **median filter** over last 5 samples to reject outliers

### Join-time Sync

The `JoinResponse` includes `server_time_ms` for immediate initial offset estimation:

```protobuf
message JoinResponse {
  // ...
  uint64 server_time_ms = 5;  // server wall clock at join time
}
```

### Server Validation

Server validates each observation's timestamp:
- `observed_at_ms` must not be > 30 s in the future (clock skew guard)
- `observed_at_ms` must not be > 60 s in the past (stale data guard)
- Out-of-range timestamps are clamped to current server time

### Fusion Timing

The fusion engine uses `observed_at_ms` (server-synced) for:
- Track staleness — how long since last observation
- ROI prediction — velocity × elapsed time
- Track cleanup — expiry after ROI TTL

**Server receive time is not used for fusion timing** — only for protocol-level timeout detection.

### Precision Target

For 2 Hz fusion with international players:

| Scenario | Typical RTT | Expected Sync Accuracy |
|---|---|---|
| LAN | < 5 ms | ±5 ms |
| Same continent | 20–60 ms | ±15 ms |
| Trans-Pacific | 100–200 ms | ±50 ms (with median filter) |

±50 ms accuracy is sufficient for 500 ms fusion ticks.

---

## 10. Error Recovery

1. **Decode error:** Server sends `ErrorResponse(code=400)`, client should re-send with valid protobuf.
2. **Protocol mismatch:** Server rejects `JoinRequest` if `protocol_version != 1`.
3. **Frame loss:** Server may send `RequestKeyframe` if observation seq has gaps. Client should re-send full observation set.
4. **Connection drop:** Client should reconnect with exponential backoff (start 1s, max 30s). Session is not preserved across reconnects in v1.

---

## 11. Security Notes

- **v1:** Passwords are hashed with a simple salted hash. Not suitable for production.
- **v5+:** Will migrate to bcrypt/argon2 for password storage, add JWT auth, TLS, and rate limiting.
- Room passwords should **not** be hardcoded in Web GUI code.
- All sensitive configuration stays in the local WinUI control panel, not the browser.

---

## 12. Multi-Client Track Fusion

### 12.1 核心前提：同源，非异构

所有 relay 客户端都从 War Thunder 的 `localhost:8111` 读取同一份数据。**不存在雷达 vs 目视 vs 侦察机的传感器质量差异**——所有客户端的数据源完全相同，地图坐标系的精度也完全一致。

多客户端融合的**唯一原因**是时间差异：

```
[8111 数据刷新] ──measurement_age_ms──▶ [客户端打包] ──网络传输──▶ [服务端收到]
                         ↑                                    ↑
                   客户端自知                            服务端已知
                  (采样后过了多久)                      (now - observed_at_ms)
```

| 差异来源 | 成因 | 典型值 |
|---|---|---|
| **测量延迟** | 8111 刷新周期 + 客户端处理延迟 | 100–500ms |
| **网络延迟** | 不同客户端的 RTT | LAN 5ms / 同洲 20–60ms / 跨洋 100–200ms |
| **坐标"漂移"** | 两次采样的时间差导致目标已移动 | 取决于目标速度 × 时间差 |

所谓"坐标漂移"不是误差——是不同客户端在不同时刻采样了同一个移动目标。融合的本质是对不同时间点的观测做**时间加权平均**。

### 12.2 置信度公式

服务端根据客观事实统一计算每个观测的置信度，**客户端不自己报 confidence**（防止作弊、保证公平比较）：

```
total_age_ms = max(0, server_now_ms - observed_at_ms + measurement_age_ms)

α = exp(-total_age_ms / τ)

其中:
  server_now_ms        = 服务端当前 UNIX 毫秒
  observed_at_ms       = 客户端用 NTP 同步后的采样时刻 (服务端时间线)
  measurement_age_ms   = 客户端自报: 从 8111 采到数据到打包发送间隔了多久
  τ                    = 时间常数, 默认 1000ms
```

**曲线：**

| total_age_ms | α (τ=1000ms) | 含义 |
|---|---|---|
| 0 | 1.00 | 实时 |
| 100 | 0.90 | 典型 LAN 场景 |
| 500 | 0.61 | 正常刷新延迟 |
| 1000 | 0.37 | 开始不可靠 |
| 3000 | 0.05 | 基本作废 |
| 5000 | 0.007 | 忽略 |

### 12.3 融合算法：指数移动平均 (EMA)

不使用完整 Kalman 滤波（同源传感器无需预测-更新闭环），使用 EMA 按时间权重融合：

```
对每个已匹配的 track，收到新观测 object 时：

  α = exp(-total_age_ms / τ)

  // 位置：新数据越新鲜, α 越高, 权重越大
  track.x = α × object.x + (1 - α) × track.x
  track.y = α × object.y + (1 - α) × track.y

  // 朝向/速度：同上 (仅当 heading 可用时)
  track.heading = α × object.heading + (1 - α) × track.heading

  // 属性 (类型/阵营)：仅当 α > 阈值时才可能切换
  //   高 α (新鲜数据) → 直接覆盖
  //   低 α (陈旧数据) → 保持现有值
  if α > 0.6: track.label_id = object.label_id
  if α > 0.6: track.affiliation = object.affiliation

  // 置信度：累积跟踪
  track.confidence_u8 = min(255, α × 255 + (1 - α) × track.confidence_u8)

  // 来源计数：去重统计
  track.source_count = 该 track 最近 2 秒内收到过观测的不同 client_id 数量

  // 时间戳
  track.last_observed_at_ms = server_now_ms
```

### 12.4 多客户端同时上报示例

```
Client A (LAN, RTT=3ms, 采样延迟=50ms)
  → total_age=53ms, α_A=0.95
  → report: x=32000, y=45000

Client B (同洲, RTT=40ms, 采样延迟=200ms)
  → total_age=240ms, α_B=0.79
  → report: x=32100, y=45100  (目标移动了)

Client C (跨洋, RTT=180ms, 采样延迟=500ms)
  → total_age=680ms, α_C=0.51
  → report: x=32250, y=45300  (目标移动更多)

融合 (假设 track 当前值 x=32050, y=45050):
  按收到顺序依次 EMA:

  收到 A: x = 0.95×32000 + 0.05×32050 = 32002
  收到 B: x = 0.79×32100 + 0.21×32002 = 32079
  收到 C: x = 0.51×32250 + 0.49×32079 = 32166

最终 x≈32166 — 新鲜数据 (A, B) 的贡献远大于延迟数据 (C)
```

### 12.5 为什么不让客户端报 confidence

| 客户端报 confidence | 服务端算 confidence |
|---|---|
| 各客户端计算方式不一致 | 统一公式，公平比较 |
| 客户端可能作弊 (全报 1.0) | 服务端基于客观时间事实 |
| 客户端不知道自己相对于其他 client 的延迟 | 服务端有全局视角 |
| 客户端不知道网络 RTT | 服务端有 Ping/Pong RTT |

客户端只报**可验证的事实**：`measurement_age_ms`（从 8111 采样过了多久才发出），服务端统一用 `total_age_ms` 算权重。

### 12.6 属性冲突处理

当多个客户端对同一目标报不同 `label_id` 或 `affiliation` 时：

- **不是传感器误差**——是 8111 数据本身在两次采样间变了（目标切换了类型/阵营）
- **策略：** 取最新鲜观测的值
  - `α > 0.6` → 直接覆盖 track 属性（数据足够新鲜，可信）
  - `α ≤ 0.6` → 保持现有值（数据太老，可能是过时信息）
- 如果属性持续不一致 → 记录 warning 日志，可能是 8111 端数据异常

### 12.7 数据流总览

```
                    ┌──────────────┐
 Client A ──Obs──▶  │              │
 (LAN, 低延迟)      │   Fusion     │
                    │   Engine     │──▶ FusedSnapshot ──▶ Viewers
 Client B ──Obs──▶  │  (EMA 融合)  │
 (同洲, 中延迟)     │              │
                    │ τ=1000ms     │
 Client C ──Obs──▶  │              │
 (跨洋, 高延迟)     └──────────────┘

所有客户端数据源相同 (8111), 差异仅在时间
→ total_age 决定 α
→ α 决定 state update 权重
→ 新鲜数据自然主导融合结果
```
