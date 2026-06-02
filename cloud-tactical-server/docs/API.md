# WT 8111 Neo Cloud Tactical Server — REST API

> **Version:** 0.1.0  
> **Protocol Version:** 1  
> **Base URL:** `http://<host>:17712`

## Overview

The Cloud Tactical Server provides room management and real-time tactical data fusion for WT 8111 Neo. All REST endpoints return JSON. WebSocket endpoints use Protobuf binary frames (see [PROTOCOL.md](PROTOCOL.md)).

## Endpoints

### Health & Version

#### `GET /healthz`

Health check. Returns server status, uptime, and active room count.

**Response 200:**
```json
{
  "ok": true,
  "service": "cloud-tactical-server",
  "uptime_secs": 3600,
  "rooms": 3
}
```

#### `GET /version`

Server version and protocol info.

**Response 200:**
```json
{
  "service": "cloud-tactical-server",
  "version": "0.1.0",
  "protocol_version": 1
}
```

---

### Room Management

#### `POST /api/rooms`

Create a new room.

**Request:**
```json
{
  "room_id": "alpha-squad",    // optional, auto-generated if omitted
  "password": "s3cret",        // optional, room is public if omitted
  "player_name": "Player1"     // optional
}
```

**Response 201:**
```json
{
  "room_id": "alpha-squad",
  "relay_url": "/ws/rooms/alpha-squad/relay",
  "viewer_url": "/ws/rooms/alpha-squad/viewer"
}
```

**Errors:** `409 Conflict` if room already exists, `503` if server room limit reached.

---

#### `GET /api/rooms`

List all active rooms. Does not expose passwords.

**Response 200:**
```json
[
  {
    "room_id": "alpha-squad",
    "has_password": true,
    "created_secs_ago": 42,
    "relay_count": 2,
    "viewer_count": 1,
    "map_generation": 128,
    "has_map_image": true
  }
]
```

---

#### `GET /api/rooms/{room_id}`

Get room details.

**Response 200:**
```json
{
  "room_id": "alpha-squad",
  "has_password": true,
  "created_secs_ago": 120,
  "relay_count": 2,
  "viewer_count": 3,
  "map_generation": 128,
  "has_map_image": true,
  "relay_url": "/ws/rooms/alpha-squad/relay",
  "viewer_url": "/ws/rooms/alpha-squad/viewer"
}
```

**Errors:** `404 Not Found` if room does not exist.

---

#### `POST /api/rooms/{room_id}/join`

Verify room access. Required before connecting to WebSocket.

**Request:**
```json
{
  "password": "s3cret"         // required if room has password
}
```

**Response 200:**
```json
{
  "ok": true,
  "room_id": "alpha-squad",
  "relay_url": "/ws/rooms/alpha-squad/relay",
  "viewer_url": "/ws/rooms/alpha-squad/viewer"
}
```

**Errors:** `403` if password is wrong, `404` if room not found.

---

#### `PUT /api/rooms/{room_id}/map-image`

Upload the room map background image. Relay clients may attempt this after joining; the server stores only the first valid image received for the room and ignores later uploads.

**Headers:**
```http
Content-Type: image/png
X-WT8111-Room-Password: s3cret
X-WT8111-Client-ID: relay-client-id
X-WT8111-Map-Generation: 128
```

**Body:** raw image bytes from War Thunder `map.img`.

**Response 201** when this upload wins:
```json
{
  "ok": true,
  "accepted": true,
  "room_id": "alpha-squad",
  "bytes": 323235,
  "content_type": "image/jpeg",
  "map_generation": 128,
  "uploaded_secs_ago": 0
}
```

**Response 200** for later uploads after the room already has a map image:
```json
{
  "ok": true,
  "accepted": false,
  "room_id": "alpha-squad",
  "bytes": 323235,
  "content_type": "image/jpeg",
  "map_generation": 128,
  "uploaded_secs_ago": 12
}
```

**Errors:** `400` for empty or non-image uploads, `403` for wrong password, `404` if room not found, `413` if over `max_map_image_bytes`.

---

#### `GET /api/rooms/{room_id}/map-image`

Fetch the stored room map background image.

**Response 200:** raw image bytes with `Content-Type` and `X-WT8111-Map-Generation` headers.

**Errors:** `404` if the room does not exist or no map image has been accepted yet.

---

## Connection Flow

### Relay Client (Game Host)

A **relay** uploads observation data from War Thunder's `localhost:8111`.

```
1. POST /api/rooms                  (create room)
2. POST /api/rooms/{id}/join        (verify password)
3. WS  /ws/rooms/{id}/relay         (open WebSocket)
4. Send WsEnvelope{JoinRequest}     (protocol handshake)
5. Receive WsEnvelope{JoinResponse} (accepted=true)
6. PUT  /api/rooms/{id}/map-image   (all relays may attempt; first image wins)
7. Stream WsEnvelope{Observation}   (upload at 1-2 Hz)
8. Send WsEnvelope{Ping}            (keepalive every 30s)
```

### Viewer Client (Web GUI / Tablet)

A **viewer** receives fused tactical snapshots.

```
1. GET  /api/rooms                  (find room)
2. POST /api/rooms/{id}/join        (verify password)
3. WS   /ws/rooms/{id}/viewer       (open WebSocket)
4. Stream WsEnvelope{FusedSnapshot} (receive at 2 Hz)
```

---

## Error Responses

All errors follow this format:

```json
{
  "ok": false,
  "error": "Human-readable error message"
}
```

| Code | Meaning |
|------|---------|
| 400 | Bad request / invalid protobuf |
| 403 | Invalid password |
| 404 | Room not found |
| 409 | Room already exists |
| 503 | Server capacity reached |

---

## Rate Limits

| Resource | Limit |
|----------|-------|
| Room creation | 100 active rooms max |
| Clients per room | 32 (relay + viewer combined) |
| Observation upload | 2 Hz recommended |
| Ping interval | 30s recommended |

---

## Versioning

- Protocol version negotiation happens during WebSocket handshake.
- Server advertises `protocol_version` in `/version` and `JoinResponse`.
- Clients must match the server's protocol version exactly (v1).
- Breaking protocol changes will increment the version number.
