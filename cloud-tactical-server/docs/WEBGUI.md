# WT 8111 Neo Cloud Tactical Server WebGUI

> Server version: 0.2.3

The cloud server now serves a room-management WebGUI at:

```text
http://<cloud-server>:17712/
http://<cloud-server>:17712/rooms
```

This page is a control console, not a replacement for the tactical map workbench.
It intentionally matches the local WinUI control console style: title bar, left
navigation, Fluent-like cards, system buttons, InfoBar status, and compact room
tables.

## Responsibilities

- Create public or password-protected rooms.
- Refresh and inspect active rooms.
- Copy Relay and Viewer WebSocket URLs.
- Generate a tactical-map launch URL for the selected room.
- Open the cloud-hosted tactical viewer map with room parameters already applied.

Player names are intentionally not part of this console. They belong to the
local client relay identity and observation payloads, not cloud room management.

## Tactical Map Launch

The default tactical map is hosted by the cloud server itself at `/map`, so
tablets and other devices can open it through the same `17712` server they used
for room management.

Default launch URL:

```text
http://<cloud-server>:17712/map?cloud=viewer&server=<cloud-server-origin>&room=<room-id>
```

The local WT 8111 Neo service on port `17711` still hosts the full local
workbench. To open that viewer from the cloud console instead, set the base URL
to the game PC address:

```text
http://<gaming-pc-ip>:17711
```

The selected base URL is stored in browser `localStorage` under
`wt8111.cloudTacticalMapBaseUrl`.

## Packaging Notes

The WebGUI is embedded into the Rust binary with:

```rust
include_str!("../webgui/index.html")
include_str!("../webgui/map.html")
```

Docker builds must copy `webgui/` before `cargo build`; otherwise the compile
will fail because the embedded HTML files are missing.
