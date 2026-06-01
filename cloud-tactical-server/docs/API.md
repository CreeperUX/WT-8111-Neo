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
    "viewer_count": 1
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

## Connection Flow

### Relay Client (Game Host)

A **relay** uploads observation data from War Thunder's `localhost:8111`.

```
1. POST /api/rooms                  (create room)
2. POST /api/rooms/{id}/join        (verify password)
3. WS  /ws/rooms/{id}/relay         (open WebSocket)
4. Send WsEnvelope{JoinRequest}     (protocol handshake)
5. Receive WsEnvelope{JoinResponse} (accepted=true)
6. Stream WsEnvelope{Observation}   (upload at 1-2 Hz)
7. Send WsEnvelope{Ping}            (keepalive every 30s)
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
