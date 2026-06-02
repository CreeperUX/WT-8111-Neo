# WT 8111 Neo Cloud Tactical Server — Developer Documentation

> **Version:** 0.1.1
> **Protocol Version:** 1  
> **Language:** Rust 1.96 (edition 2021)  
> **Transport:** HTTP/1.1 REST + WebSocket binary (Protobuf)  
> **Default Port:** 17712  

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Quick Start](#2-quick-start)
3. [REST API Reference](#3-rest-api-reference)
4. [WebSocket Protocol](#4-websocket-protocol)
5. [Protobuf Schema Reference](#5-protobuf-schema-reference)
6. [Multi-Client Track Fusion](#6-multi-client-track-fusion)
7. [Client Integration Guide](#7-client-integration-guide)
8. [Server Configuration](#8-server-configuration)
9. [Deployment](#9-deployment)
10. [Source Code Map](#10-source-code-map)
11. [Security Model](#11-security-model)
12. [Documentation and Version Management](#12-documentation-and-version-management)

---

## 1. Architecture Overview

```
┌─────────────────┐     ┌──────────────────────────────────┐     ┌─────────────────┐
│   Game PC #1    │     │                                  │     │   C2 Console    │
│  (WT 8111 Neo   │────>│     Cloud Tactical Server        │────>│  (Web Browser)  │
│   Map Workbench)│     │                                  │     │                 │
│                 │     │  ┌──────────┐   ┌─────────────┐  │     │  FusedSnapshot  │
│  ObservationFrame    │  │  Relay    │   │   Fusion    │  │     │  (WebSocket)    │
│  (WebSocket)    │     │  │  Handler  │──>│   Engine    │  │     │                 │
└─────────────────┘     │  │          │   │  (EMA, 2Hz) │  │     └─────────────────┘
                        │  └──────────┘   └──────┬──────┘  │
┌─────────────────┐     │                        │         │     ┌─────────────────┐
│   Game PC #2    │     │               ┌────────▼──────┐  │     │   Tablet /      │
│  (WT 8111 Neo   │────>│               │    Viewer     │──┼────>│   Third-party   │
│   Map Workbench)│     │               │   Broadcaster │  │     │   Viewer        │
└─────────────────┘     │               └───────────────┘  │     └─────────────────┘
                        └──────────────────────────────────┘
      Relay Clients                Cloud Tactical Server              Viewers
 ws://.../{room}/relay                                            ws://.../{room}/viewer
 upload observation frames          receive fused snapshots
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **WebSocket + Protobuf** | Binary framing is 3–5× more compact than JSON, critical for low-bandwidth scenarios |
| **Server-side confidence** | Prevents cheating (clients can't inflate their own weight) and ensures fair comparison |
| **EMA fusion (not Kalman)** | All clients read the same 8111 data source — no heterogeneous sensor noise to model |
| **Per-room isolation** | Each room is an independent fusion engine; no cross-room data leakage |
| **Rust / axum** | Zero-cost abstractions, async I/O, no GC pauses, single binary deployment |

### Data Flow

1. **Relay clients** (game PCs) connect to `ws://server:17712/ws/rooms/{room_id}/relay`
2. Each sends `WsEnvelope { JoinRequest }` then streams `ObservationFrame` at 1–2 Hz
3. **Fusion engine** (per room) collects all observations into a tick buffer
4. Every **500ms** (2 Hz), a tick fires:
   - All buffered observations are processed
   - New observations are **associated** to existing tracks (spatial + type matching)
   - Matched tracks are updated via **EMA weighted fusion** (weight = `e^(-total_age/τ)`)
   - Unmatched observations create **new tracks**
   - Missing tracks enter **ROI prediction** (aircraft only) or expire
5. The resulting `FusedSnapshot` is **broadcast** to all viewer WebSocket connections

---

## 2. Quick Start

### Prerequisites

- **Docker** (recommended) or **Rust 1.96+** with protobuf-compiler
- Port 17712 accessible from relay clients and viewers

### Docker (Recommended)

```bash
# Clone and build
cd cloud-tactical-server
docker compose up -d --build

# Check status
curl http://localhost:17712/healthz
# → {"ok":true,"service":"cloud-tactical-server","uptime_secs":5,"rooms":0}
```

The Web GUI (C2 Console) is available at `http://localhost:17712`.

### Bare Metal

```bash
# Install protoc
apt-get install -y protobuf-compiler

# Build
cargo build --release

# Run
CONFIG_PATH=config/server.yaml ./target/release/cloud-tactical-server
```

### Configuration

Copy and edit `config/server.example.yaml`:

```yaml
host: "0.0.0.0"
port: 17712
fusion_interval_ms: 500       # 2 Hz tick rate
track_history_secs: 3.0       # track position history buffer
roi_ttl_secs: 15.0            # how long to predict after target disappears
max_rooms: 100                # server-wide room limit
max_clients_per_room: 32      # relay + viewer combined
max_map_image_bytes: 8388608  # per-room first map image upload limit
```

---

## 3. REST API Reference

**Base URL:** `http://<host>:17712`

### Health & Version

#### `GET /healthz`
```json
{ "ok": true, "service": "cloud-tactical-server", "uptime_secs": 3600, "rooms": 3 }
```

#### `GET /version`
```json
{ "service": "cloud-tactical-server", "version": "0.1.1", "protocol_version": 1 }
```

#### `GET /api/config`
```json
{ "fusion_interval_ms": 500, "max_rooms": 100, "max_clients_per_room": 32, ... }
```

### Room Management

#### `POST /api/rooms` — Create Room
```json
// Request
{ "room_id": "alpha-squad", "password": "s3cret" }

// Response 201
{ "room_id": "alpha-squad",
  "relay_url": "/ws/rooms/alpha-squad/relay",
  "viewer_url": "/ws/rooms/alpha-squad/viewer" }
```

#### `GET /api/rooms` — List Rooms
```json
[{
  "room_id": "alpha-squad",
  "has_password": true,
  "created_secs_ago": 42,
  "relay_count": 2,
  "viewer_count": 1
}]
```

#### `GET /api/rooms/{room_id}` — Room Detail
Same format as list item, plus `relay_url` and `viewer_url` fields.

#### `POST /api/rooms/{room_id}/join` — Verify Password
```json
// Request
{ "password": "s3cret" }

// Response 200
{ "ok": true, "room_id": "alpha-squad",
  "relay_url": "/ws/rooms/alpha-squad/relay",
  "viewer_url": "/ws/rooms/alpha-squad/viewer" }
```

### Error Format

All errors: `{ "ok": false, "error": "message" }`

| HTTP | Meaning |
|---|---|
| 400 | Bad request / invalid protobuf |
| 403 | Invalid password |
| 404 | Room not found |
| 409 | Room already exists |
| 503 | Server capacity reached (max 100 rooms) |

---

## 4. WebSocket Protocol

### 4.1 Wire Format

Every WebSocket message is a **single binary frame** containing a Protobuf-encoded `WsEnvelope`:

```protobuf
message WsEnvelope {
  oneof payload {
    ObservationFrame observation = 1;   // relay → server
    FusedSnapshot snapshot = 2;         // server → viewer
    JoinRequest join_request = 3;       // relay → server (first message)
    JoinResponse join_response = 4;     // server → relay
    ErrorResponse error = 5;            // bidirectional
    Ack ack = 6;                        // bidirectional (seq acknowledgment)
    RequestKeyframe request_keyframe = 7; // server → relay
    Ping ping = 8;                      // relay → server (keepalive)
    Pong pong = 9;                      // server → relay
  }
}
```

Text frames are not used in normal operation.

### 4.2 Relay Connection Flow

```
1. POST  /api/rooms              → create room (or get existing room_id)
2. POST  /api/rooms/{id}/join    → verify password (optional, if room has one)
3. WS    /ws/rooms/{id}/relay    → open WebSocket
4. Send  WsEnvelope { JoinRequest }  (includes password + protocol_version)
5. Recv  WsEnvelope { JoinResponse }  (server validates password here)
6. Loop:
     Send WsEnvelope { ObservationFrame }  at 1–2 Hz
     Send WsEnvelope { Ping }              every 30s
     Recv WsEnvelope { Pong }              → compute clock offset
```

**Password validation on relay:** The server validates the password inside the `JoinRequest` message (step 4). If the password is wrong, `JoinResponse.accepted = false` is returned and the connection is closed. The password check happens server-side, using a salted hash stored at room creation.

### 4.3 Viewer Connection Flow

```
1. GET   /api/rooms              → find room_id to monitor
2. WS    /ws/rooms/{id}/viewer?password={password}   → open WebSocket
3. Loop:
     Recv WsEnvelope { FusedSnapshot }  at ~2 Hz
```

**Password validation on viewer:** Pass the room password as a query parameter `?password=xxx`. The server validates it before upgrading to WebSocket. If wrong/missing, the connection is rejected with HTTP 403.

### 4.4 Clock Synchronization (NTP-style)

Required for relay clients. Viewer clients do not need clock sync.

```
Client                                 Server
  |                                      |
  |-- Ping { client_time_ms: T1 } ------>|
  |<-- Pong { client_time_ms: T1,       |
  |           server_time_ms: T2 } ------|
  |                                      |

T3 = local time when Pong received

RTT    = T3 - T1
offset = T2 - (T1 + RTT / 2)

estimated_server_time = local_time + offset
```

**Implementation notes:**
- Sample RTT/offset every 5–10 seconds
- Use **median filter** over last 5 samples to reject outliers
- On join, `JoinResponse.server_time_ms` provides an initial offset estimate
- Set `ObservationFrame.observed_at_ms = estimated_server_time` (not local time!)

**Expected precision:**

| Scenario | Typical RTT | Sync Accuracy |
|---|---|---|
| LAN | < 5 ms | ±5 ms |
| Same continent | 20–60 ms | ±15 ms |
| Trans-Pacific | 100–200 ms | ±50 ms |

### 4.5 Rate Limits

| Resource | Limit |
|---|---|
| Observation upload | 1–2 Hz recommended |
| Ping interval | 30s |
| Max rooms | 100 |
| Max clients per room | 32 (relay + viewer) |

---

## 5. Protobuf Schema Reference

### 5.1 File Layout

```
protos/
├── envelope.proto      # WsEnvelope + handshake + keepalive messages
├── observation.proto   # ObservationFrame (relay → server)
└── snapshot.proto      # FusedSnapshot (server → viewer)
```

Package: `wt8111`

### 5.2 ObservationFrame

```protobuf
message ObservationFrame {
  uint32 protocol_version = 1;       // must be 1
  string session_id = 2;             // from JoinResponse
  string room_id = 3;                // target room
  string client_id = 4;              // unique client instance ID
  string player_name = 5;            // display name
  uint64 seq = 6;                    // monotonic frame counter (used for gap detection)
  uint64 observed_at_ms = 7;         // server-synced timestamp (REQUIRED)
  uint32 map_generation = 8;         // War Thunder map generation number
  string map_id = 9;                 // map identifier (optional, for debugging)
  ObservedPlayer player = 10;        // self position
  repeated ObservedObject objects = 11;
  repeated uint32 removed_local_ids = 12;  // localIds that disappeared this tick
  uint32 measurement_age_ms = 13;    // IMPORTANT: ms since 8111 sample was taken
}

message ObservedPlayer {
  uint32 x_u16 = 1;      // 0..65535 normalized map X
  uint32 y_u16 = 2;      // 0..65535 normalized map Y
  int32 heading_i16 = 3; // heading × 100 (0 = north, clockwise)
}

message ObservedObject {
  uint32 local_id = 1;      // client-local stable ID (for removed_local_ids)
  uint32 label_id = 2;      // session dictionary index (vehicle icon/type)
  uint32 class_id = 3;      // 0=air 1=ground 2=objective 3=spawn 4=other
  uint32 affiliation = 4;   // 0=friend 1=hostile 2=neutral 3=unknown
  uint32 x_u16 = 5;        // 0..65535
  uint32 y_u16 = 6;
  int32 heading_i16 = 7;   // heading × 100 (optional)
  uint32 color_id = 8;     // session dictionary index (color)
  uint32 flags = 9;        // bit0=blink bit1=icon_bg
}
```

#### Critical Field: `measurement_age_ms`

This is the **ONLY** client-reported quality metric the server trusts. It must be the actual elapsed time between when the 8111 data was sampled and when the client packages the ObservationFrame. Do NOT set this to 0 or a constant — the server uses it to compute the EMA weight.

```
measurement_age_ms = (local_time_when_packaging - local_time_when_8111_was_sampled)
```

#### Critical Field: `observed_at_ms`

Must be set to the **server-synced time**, not the client's local wall clock. This is computed as:

```
observed_at_ms = local_time_now + clock_offset
```

where `clock_offset` is maintained via the NTP-style Ping/Pong exchange (§4.4).

### 5.3 FusedSnapshot

```protobuf
message FusedSnapshot {
  uint32 protocol_version = 1;
  string room_id = 2;
  uint64 seq = 3;                       // server monotonic frame counter
  uint64 server_time_ms = 4;            // server UNIX ms timestamp
  uint32 map_generation = 5;
  repeated FusedTrack tracks = 6;       // all active + stale tracks
  repeated InterestRegion interest_regions = 7;  // predicted areas (aircraft only)
  TacticalSummary summary = 8;
}

message FusedTrack {
  string track_id = 1;           // server-assigned: "trk_XXXXXXXX"
  uint32 label_id = 2;           // vehicle type (session dictionary)
  uint32 class_id = 3;           // 0=air 1=ground 2=objective 3=spawn 4=other
  uint32 affiliation = 4;        // 0=friend 1=hostile 2=neutral 3=unknown
  uint32 x_u16 = 5;             // EMA-fused position
  uint32 y_u16 = 6;
  int32 heading_i16 = 7;        // EMA-fused heading × 100
  int32 vx_i16 = 8;             // EMA-fused velocity (quantized)
  int32 vy_i16 = 9;
  uint32 confidence_u8 = 10;    // 0..255, EMA-accumulated confidence
  uint32 last_seen_ms_ago = 11; // ms since last observation
  uint32 source_count = 12;     // total relay clients that have observed
  uint32 flags = 13;            // forwarded from latest observation
  uint32 total_age_ms = 14;     // data age of latest observation (measurement + transit)
  uint32 contributing_clients = 15; // unique clients in last 2s (deduplicated)
}

message InterestRegion {
  string track_id = 1;            // parent track
  uint32 center_x_u16 = 2;        // velocity-predicted center
  uint32 center_y_u16 = 3;
  uint32 anchor_x_u16 = 4;        // last known position (for reference)
  uint32 anchor_y_u16 = 5;
  uint32 radius_major_u16 = 6;    // semi-major axis (along heading)
  uint32 radius_minor_u16 = 7;    // semi-minor axis (perpendicular)
  int32 heading_i16 = 8;          // major axis direction × 100
  uint32 expires_in_ms = 9;       // remaining lifetime
  uint32 confidence_u8 = 10;      // decays 255→20 over 15s
}

message TacticalSummary {
  uint32 total_tracks = 1;
  uint32 hostile_tracks = 2;
  uint32 friendly_tracks = 3;
  uint32 stale_tracks = 4;      // tracks with active ROI prediction
  uint32 interest_regions = 5;
}
```

#### Rendering InterestRegion

Only generated for **aircraft (class_id=0)**. Ground vehicles use the stale tracks list directly.

To render:
1. Draw an ellipse at `(center_x_u16, center_y_u16)`, rotated by `heading_i16 / 100` degrees
2. Semi-axes: `radius_major_u16` (along heading), `radius_minor_u16` (perpendicular)
3. Optionally draw a line from `(anchor_x_u16, anchor_y_u16)` to center
4. Opacity proportional to `confidence_u8 / 255`

### 5.4 Coordinate System

All coordinates are **normalized u16 (0–65535)**:

```
x=0, y=0       → map origin (top-left in game coordinates)
x=65535, y=65535 → map extent (bottom-right)

World coordinate conversion:
  world_x = map_min[0] + (x_u16 / 65535.0) * (map_max[0] - map_min[0])
  world_y = map_min[1] + (y_u16 / 65535.0) * (map_max[1] - map_min[1])
```

### 5.5 Object Classification

| class_id | Meaning | NATO Symbol |
|---|---|---|
| 0 | Air (aircraft, helicopter, drone) | Ellipse |
| 1 | Ground (tank, SPAA, armored) | Ellipse |
| 2 | Objective (capture point, bombing target) | Circle + cross |
| 3 | Spawn (respawn point, airfield) | Triangle |
| 4 | Other (structure, unknown) | Cross (X) |

| affiliation | Meaning | NATO Frame | Stroke Color |
|---|---|---|---|
| 0 | Friend | Rectangle | `#31dfff` (cyan) |
| 1 | Hostile | Diamond | `#ff6358` (red) |
| 2 | Neutral | Square | `#93e979` (green) |
| 3 | Unknown | Quatrefoil | `#ffd25f` (amber) |

---

## 6. Multi-Client Track Fusion

### 6.1 Core Premise: Same-Source, Not Heterogeneous

All relay clients read from the **same** `localhost:8111` data source. There is **no** radar vs. visual vs. scout quality difference. Multi-client fusion exists solely because of **timing differences**.

### 6.2 EMA Weight Formula

```python
total_age_ms = max(0, server_now_ms - observed_at_ms + measurement_age_ms)
alpha = exp(-total_age_ms / TAU)      # TAU = 1000ms
```

| total_age_ms | alpha | Meaning |
|---|---|---|
| 0 | 1.00 | Real-time |
| 100 | 0.90 | Typical LAN |
| 500 | 0.61 | Normal refresh delay |
| 1000 | 0.37 | Becoming unreliable |
| 3000 | 0.05 | Essentially stale |
| 5000 | 0.007 | Ignored |

### 6.3 Fusion Algorithm (EMA)

```
For each new observation matching an existing track:
  alpha = exp(-total_age_ms / 1000)

  track.x       = alpha * obj.x + (1-alpha) * track.x
  track.y       = alpha * obj.y + (1-alpha) * track.y
  track.heading = alpha * obj.heading + (1-alpha) * track.heading
  track.vx      = alpha * raw_vx + (1-alpha) * track.vx
  track.vy      = alpha * raw_vy + (1-alpha) * track.vy
  track.confidence = min(255, alpha*255 + (1-alpha)*track.confidence)

  # Attributes: only switch with fresh data
  if alpha > 0.6:
      track.label_id    = obj.label_id
      track.affiliation = obj.affiliation

  # Client deduplication (last 2s window)
  track.source_count = distinct(client_ids in last 2s)
```

### 6.4 Why Server-Side Confidence?

| Client reports confidence | Server computes confidence |
|---|---|
| Inconsistent across clients | Single formula, fair comparison |
| Client could cheat (always 1.0) | Based on objective timing facts |
| Client doesn't know its relative latency | Server has global perspective |
| Client doesn't know network RTT | Server tracks Ping/Pong |

### 6.5 Track Association

Two-level matching:

1. **Level 1 (exact):** Same `affiliation + class_id + label_id` AND within 2000 u16 units → instant match
2. **Level 2 (fuzzy):** Same `affiliation + class_id` AND within 800 u16 units → nearest-neighbor match

Unmatched observations create new tracks with `track_id = "trk_XXXXXXXX"`.

---

## 7. Client Integration Guide

### 7.1 Relay Client (Game PC)

The relay client runs on the same machine as War Thunder, reading `localhost:8111` data.

**Required implementation:**

```python
# Pseudocode for relay client integration

class RelayClient:
    def __init__(self, server_host, server_port, room_id, password):
        self.ws = websocket.create_connection(
            f"ws://{server_host}:{server_port}/ws/rooms/{room_id}/relay"
        )
        self.clock_offset = 0
        self.seq = 0
        self.last_8111_sample_time = 0  # local monotonic time

        # Step 1: Send JoinRequest (protobuf binary)
        self.send(JoinRequest(
            room_id=room_id,
            password=password,
            client_id=str(uuid4()),
            player_name="PlayerName",
            protocol_version=1
        ))

        # Step 2: Receive JoinResponse
        resp = self.recv()
        if not resp.accepted:
            raise Exception(resp.error_message)

        self.session_id = resp.session_id
        # Initial clock sync
        self.sync_clock()

    def sync_clock(self):
        """Ping/Pong NTP-style clock sync"""
        offsets = []
        for _ in range(5):
            t1 = time.monotonic_ms()
            self.send(Ping(client_time_ms=t1))
            pong = self.recv()
            t3 = time.monotonic_ms()
            rtt = t3 - t1
            offset = pong.server_time_ms - (t1 + rtt / 2)
            offsets.append(offset)
            time.sleep(1)

        # Median filter
        offsets.sort()
        self.clock_offset = offsets[len(offsets) // 2]

    def send_observation(self, wt8111_data, sample_time_local):
        """Called every 500ms with fresh 8111 data"""
        self.seq += 1
        now_local = time.monotonic_ms()
        measurement_age_ms = now_local - sample_time_local
        observed_at_ms = int(now_local + self.clock_offset)

        frame = ObservationFrame(
            protocol_version=1,
            session_id=self.session_id,
            room_id=self.room_id,
            client_id=self.client_id,
            player_name=self.player_name,
            seq=self.seq,
            observed_at_ms=observed_at_ms,
            measurement_age_ms=measurement_age_ms,  # CRITICAL!
            map_generation=wt8111_data.map_generation,
            player=ObservedPlayer(x=..., y=..., heading=...),
            objects=[ObservedObject(...) for obj in wt8111_data.objects],
            removed_local_ids=wt8111_data.removed_ids
        )
        self.send(frame)
```

**Key requirements:**
1. `measurement_age_ms` MUST be accurate — it directly affects fusion weight
2. `observed_at_ms` MUST be server-synced — do NOT send raw local time
3. Clock sync MUST run periodically (every 5–10s, median of last 5 samples)
4. Ping every 30s to keep connection alive and maintain clock sync

### 7.2 Viewer Client (Display)

The viewer is simpler — it just receives `FusedSnapshot` at 2 Hz:

```python
ws = websocket.create_connection(
    f"ws://{host}:17712/ws/rooms/{room_id}/viewer"
)

while True:
    envelope = WsEnvelope.FromString(ws.recv())
    snapshot = envelope.snapshot

    # Render tracks
    for track in snapshot.tracks:
        x, y = track.x_u16 / 65535.0, track.y_u16 / 65535.0
        color = AFFILIATION_COLORS[track.affiliation]
        nato_frame = NATO_FRAMES[track.affiliation]
        nato_icon = NATO_ICONS[track.class_id]
        draw_nato_symbol(x, y, nato_frame, nato_icon, color)

    # Render ROI ellipses (aircraft only)
    for roi in snapshot.interest_regions:
        draw_ellipse(roi.center_x, roi.center_y,
                     roi.radius_major, roi.radius_minor,
                     roi.heading / 100.0)

    # Top bar summary
    update_summary(snapshot.summary)
```

The built-in C2 Console at `http://<server>:17712` serves as a reference viewer implementation.

### 7.3 Protobuf Code Generation

Generate language-specific bindings from `protos/`:

```bash
# Python
protoc --python_out=. protos/*.proto

# JavaScript/TypeScript (with protobufjs)
pbjs -t static-module -w commonjs -o proto.js protos/*.proto
pbts -o proto.d.ts proto.js

# C# / Unity
protoc --csharp_out=. protos/*.proto

# Go
protoc --go_out=. protos/*.proto
```

---

## 8. Server Configuration

```yaml
# config/server.yaml

host: "0.0.0.0"               # Bind address
port: 17712                    # HTTP + WS port

# Fusion engine parameters
fusion_interval_ms: 500        # Tick interval (2 Hz)
track_history_secs: 3.0        # Position history buffer per track
roi_ttl_secs: 15.0             # How long to predict ROI after target disappears

# Server limits
max_rooms: 100                 # Hard cap on active rooms
max_clients_per_room: 32       # Relay + viewer connections per room
room_password_required: false  # Not enforced in v0.1

# Environment variables
# CONFIG_PATH — override config file location
# RUST_LOG    — logging level (default: cloud_tactical_server=debug,tower_http=info)
```

### Logging

```bash
# Debug everything
RUST_LOG=debug ./cloud-tactical-server

# Info only
RUST_LOG=cloud_tactical_server=info ./cloud-tactical-server

# JSON output (for log aggregation)
RUST_LOG=info ./cloud-tactical-server
# Add: tracing-subscriber json feature
```

---

## 9. Deployment

### Docker Compose (Production)

```yaml
# docker-compose.yml
services:
  cloud-tactical-server:
    build: .
    container_name: wt8111-tactical
    restart: unless-stopped
    ports:
      - "17712:17712"
    volumes:
      - ./config/server.yaml:/app/config/server.yaml:ro
```

```bash
# Build and start
docker compose up -d --build

# View logs
docker logs -f wt8111-tactical

# Restart after config change
docker compose restart

# Rebuild after code change
docker compose up -d --build
```

### Dockerfile (Multi-stage)

```dockerfile
# Stage 1: Build
FROM rust:1.96-slim-bookworm AS builder
RUN apt-get install -y protobuf-compiler
COPY . /app
RUN cargo build --release

# Stage 2: Runtime (~30MB)
FROM debian:bookworm-slim
COPY --from=builder /app/target/release/cloud-tactical-server /app/
COPY config/ /app/config/
COPY static/ /app/static/
EXPOSE 17712
ENTRYPOINT ["/app/cloud-tactical-server"]
```

### Binary Size

| Profile | Size | Notes |
|---|---|---|
| Debug | ~15 MB | With debug symbols |
| Release | ~1.7 MB | `lto=true`, `opt-level=s`, `strip=true`, `panic=abort` |

### Health Check

```bash
curl http://localhost:17712/healthz
# Expected: {"ok":true,...}
```

Docker health check: `curl -sf http://localhost:17712/healthz`

---

## 10. Source Code Map

```
cloud-tactical-server/
├── Cargo.toml              # Dependencies: axum 0.8, prost 0.13, tokio 1, tower-http 0.6
├── build.rs                # Compiles protos/ → generated protobuf bindings
├── Dockerfile              # Multi-stage: rust:1.96 → debian:bookworm-slim
├── docker-compose.yml      # Production deployment
│
├── protos/                 # Protobuf schema (THE contract between client & server)
│   ├── envelope.proto      #   WsEnvelope, JoinRequest/Response, Ping/Pong, Ack
│   ├── observation.proto   #   ObservationFrame, ObservedPlayer, ObservedObject
│   └── snapshot.proto      #   FusedSnapshot, FusedTrack, InterestRegion, TacticalSummary
│
├── config/
│   └── server.example.yaml # Default configuration
│
├── static/                 # C2 Console Web GUI (served by tower-http ServeDir)
│   ├── index.html          #   Main page
│   ├── css/style.css       #   Dark tactical theme (matches Map Workbench)
│   └── js/app.js           #   Canvas renderer, WebSocket client, NATO symbols
│
├── docs/
│   ├── API.md              # REST API reference
│   ├── PROTOCOL.md         # WebSocket protocol specification
│   └── DEVELOPER.md        # This file
│
└── src/
    ├── main.rs             # Entry point: config load, tracing init, server start
    ├── config.rs           # ServerConfig struct, YAML parsing
    ├── server.rs           # Axum router: HTTP endpoints + WebSocket upgrade + static files
    ├── relay.rs            # Relay WebSocket handler: JoinRequest → ObservationFrame
    ├── viewer.rs           # Viewer WebSocket handler: broadcast FusedSnapshot
    ├── rooms.rs            # RoomManager: room lifecycle, fusion loop spawner
    ├── fusion.rs           # FusionEngine: EMA track fusion, ROI prediction
    └── mod_pb.rs           # Generated protobuf re-export
```

### Key Source Files Explained

| File | Role |
|---|---|
| `main.rs` | Initializes tracing, loads config, binds TCP, starts axum |
| `server.rs` | Defines all routes: `/healthz`, `/api/*`, `/ws/*`, `ServeDir` for static files, CORS |
| `relay.rs` | Parses incoming `WsEnvelope` messages from relay clients, forwards `ObservationFrame` to room's `observation_tx` channel |
| `rooms.rs` | Creates rooms, spawns per-room fusion loops. Each loop: read from `observation_tx` → feed to `FusionEngine::tick()` → broadcast via `snapshot_tx` |
| `fusion.rs` | **Core engine.** `FusionEngine::tick()` processes all buffered observations: association → EMA update → ROI prediction → cleanup. This is where the multi-client fusion happens. |
| `viewer.rs` | Subscribes to `snapshot_tx`, converts `FusionResult` to protobuf `FusedSnapshot`, sends to viewer WebSocket |
| `mod_pb.rs` | `include!()` macro — imports prost-generated Rust types from build output |

### Data Flow Inside the Server

```
relay WebSocket                   rooms::run_fusion_loop                viewer WebSocket
      │                                    │                                 │
      │── WsEnvelope{Observation}          │                                 │
      │── parse_observation()              │                                 │
      │── obs_tx.send(parsed) ────────────>│                                 │
      │                                    │── fusion.push_observation(obs)  │
      │                                    │   (buffered, not processed yet) │
      │                                    │                                 │
      │                                    │── tokio::interval.tick() (500ms)│
      │                                    │── fusion.tick(now, now_ms)      │
      │                                    │   ├── for each obs:             │
      │                                    │   │   ├── match_track()         │
      │                                    │   │   ├── update_track() (EMA)  │
      │                                    │   │   └── create_track()        │
      │                                    │   └── predict_rois()            │
      │                                    │                                 │
      │                                    │── snap_tx.send(result) ────────>│
      │                                    │                                 │── build_snapshot()
      │                                    │                                 │── ws.send(binary)
```

---

## 11. Security Model

### Current State (v0.1)

| Feature | Status |
|---|---|
| Password hashing | Simple salted hash (NOT production-ready) |
| Transport encryption | None (plain HTTP/WS) |
| Relay auth | Password validated in JoinRequest; wrong → rejected + connection closed |
| Viewer auth | Password validated via `?password=` query param; wrong → HTTP 403 |
| Room capacity enforcement | Atomic counters; reject connections when `relay + viewer > max_clients_per_room` |
| Timestamp validation | `observed_at_ms` clamped to [server_now-60s, server_now+30s] |
| Authorization | Room password only; no per-client roles yet |
| Rate limiting | Room/client count caps only |

### Planned (v0.5+)

- bcrypt/argon2 password hashing
- TLS (via reverse proxy or built-in)
- JWT-based session tokens
- Rate limiting per connection
- Room admin vs. viewer role separation

### Timestamp Validation

The server validates incoming `observed_at_ms`:
- Must not be > 30s in the future (prevents clock skew attacks)
- Must not be > 60s in the past (prevents replay of stale data)
- Out-of-range values are clamped to current server time

---

## 12. Documentation and Version Management

### Current Release

| Item | Value |
|---|---|
| Service version | `0.1.1` |
| WebSocket/Protobuf protocol version | `1` |
| Release branch | `codex/cloud-tactical-server` |

v0.1.1 adds REST map image support for cloud room backgrounds:
- `PUT /api/rooms/{room_id}/map-image`
- `GET /api/rooms/{room_id}/map-image`
- `map_generation` and `has_map_image` in room list/detail JSON
- C2 Console map background rendering from the accepted room image

This is a service/API patch release. The WebSocket/Protobuf wire protocol remains `1` because the map image is transferred over REST and no existing protobuf field numbers or message shapes changed.

### Version Rules

- Update `cloud-tactical-server/Cargo.toml` for every service release; `GET /version` reports this package version through `env!("CARGO_PKG_VERSION")`.
- Keep `Cargo.lock` in sync with the package version before committing.
- Increment `protocol_version` only for breaking or incompatible WebSocket/Protobuf changes.
- REST-only additions may use patch releases as long as clients can ignore unknown JSON fields.
- Keep `docs/API.md` as the source REST contract and sync `static/API.md` when the served documentation must match.
- Keep `docs/DEVELOPER.md` and `static/DEVELOPER.md` aligned when operational or integration guidance changes.

---

## Appendix A: Complete Protobuf Schema

All `.proto` files are in the `protos/` directory. Use these as the **single source of truth** for wire format. The Markdown in sections 5.2–5.3 is a human-readable reference — always defer to the `.proto` files for exact field numbers and types.

## Appendix B: C2 Console (Reference Viewer)

A reference Web GUI is served at `http://<server>:17712`. Features:
- Room management (create, list, monitor)
- Server connection info display (IP, port, URLs)
- Real-time tactical map with NATO APP-6A symbols
- Track detail panel (click to select)
- Track list with affiliation/confidence
- ROI ellipse rendering for predicted aircraft positions
- 2 Hz real-time update via WebSocket
- Copy-to-clipboard for connection URLs and passwords

The C2 Console uses a manual Protobuf parser (pure JavaScript, no dependencies) — see `static/js/app.js` for a reference implementation of client-side protobuf decoding.

## Appendix C: Performance Characteristics

| Metric | Value |
|---|---|
| Fusion tick rate | 2 Hz (500ms) |
| Max tracks per room | Unlimited (memory-bound) |
| Per-track memory | ~200 bytes |
| ObservationFrame size | ~50 bytes/object (protobuf) |
| FusedSnapshot size | ~150 bytes/track (protobuf) |
| Binary size (release) | ~1.7 MB |
| Container image size | ~30 MB |
| Memory (idle/busy) | ~2 MB / ~10 MB (100 tracks, 1 room) |
| CPU (busy) | < 1% single core |
