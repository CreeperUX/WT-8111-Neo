# WT 8111 Neo Cloud Tactical Server WebGUI

> Server version: 0.2.0

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
- Open the local/LAN tactical map WebGUI with cloud parameters already applied.

Player names are intentionally not part of this console. They belong to the
local client relay identity and observation payloads, not cloud room management.

## Tactical Map Launch

The actual tactical map is still the client WebGUI hosted by the local WT 8111
Neo service on port `17711`.

Default launch URL:

```text
http://127.0.0.1:17711?cloud=both&server=<cloud-server-origin>&room=<room-id>
```

For tablets or LAN devices, set the base URL in the cloud console to the game PC
address:

```text
http://<gaming-pc-ip>:17711
```

The selected base URL is stored in browser `localStorage` under
`wt8111.cloudWebGuiBaseUrl`.

## Packaging Notes

The WebGUI is embedded into the Rust binary with:

```rust
include_str!("../webgui/index.html")
```

Docker builds must copy `webgui/` before `cargo build`; otherwise the compile
will fail because the embedded HTML file is missing.
