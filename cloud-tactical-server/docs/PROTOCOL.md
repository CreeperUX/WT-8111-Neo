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
  uint64 observed_at_ms = 7;         // client-side sampling timestamp
  uint32 map_generation = 8;         // War Thunder map generation
  string map_id = 9;                 // optional, map identifier
  ObservedPlayer player = 10;        // self position
  repeated ObservedObject objects = 11;
  repeated uint32 removed_local_ids = 12;  // localIds removed this tick
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

A unified target track. Multiple relay observations of the same target are merged into one track.

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

## 9. Error Recovery

1. **Decode error:** Server sends `ErrorResponse(code=400)`, client should re-send with valid protobuf.
2. **Protocol mismatch:** Server rejects `JoinRequest` if `protocol_version != 1`.
3. **Frame loss:** Server may send `RequestKeyframe` if observation seq has gaps. Client should re-send full observation set.
4. **Connection drop:** Client should reconnect with exponential backoff (start 1s, max 30s). Session is not preserved across reconnects in v1.

---

## 10. Security Notes

- **v1:** Passwords are hashed with a simple salted hash. Not suitable for production.
- **v5+:** Will migrate to bcrypt/argon2 for password storage, add JWT auth, TLS, and rate limiting.
- Room passwords should **not** be hardcoded in Web GUI code.
- All sensitive configuration stays in the local WinUI control panel, not the browser.
