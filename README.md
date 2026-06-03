# WT 8111 Neo

[简体中文](README.zh-CN.md)

WT 8111 Neo is a local companion tool for War Thunder's `localhost:8111`
telemetry service. The current focus is a modern tactical map workbench for
map reading, object overlays, ranging, and future artillery/map utilities.

The project is still an early development prototype.

## Current Status

- Web tactical map workbench built with React, Vite, and TypeScript.
- Rust local HTTP service built with Axum.
- WinUI 3 local control console for Windows.
- Cloud Tactical Server v0.2.0 includes a WinUI-style room-management WebGUI at
  `http://<cloud-server>:17712/`, with buttons that open the selected room in
  the local/LAN tactical map Web GUI.
- The WinUI console is the only app players need to start manually.
- The Rust service serves the built Web GUI and proxies War Thunder's local
  `8111` endpoints to LAN devices through `17711`.
- Browser-side radar capture controls have been removed from the Web GUI.
- Visual radar recognition is paused and documented as an experimental direction.

## Runtime Model

```text
War Thunder on gaming PC
  -> localhost:8111
  -> WT8111Neo.Control.exe
      -> starts/manages wt-8111-neo.exe
          -> HTTP service on 0.0.0.0:17711
              -> /api/wt/* proxy
              -> static Web GUI
  -> browser on PC / tablet / LAN device
```

Daily usage:

1. Start `WT8111Neo.Control.exe`.
2. Use the Dashboard button to open the Web GUI in a browser.
3. On another LAN device, open `http://<gaming-pc-ip>:17711`.

## Web Tactical Map Workbench

The current Web GUI map workbench includes quick fire mission and artillery map
plotting helpers:

- The map object list shows all available targets instead of truncating to the
  first few objects.
- The object list has a three-dot filter menu for ground, air, objective, spawn,
  and other object classes.
- Object sorting prioritizes likely squadmates, then sorts by distance from the
  current source or player position.
- Every map object has its own show/hide toggle.
- A fire mission can have only one active source and one active target.
- Units can be assigned as the source or target directly from the object list.
- Left-clicking a unit on the map opens a menu to assign that unit as source or
  target.
- Left-clicking empty map space opens an attack-position menu that can set that
  location as the target, with `Cancel` available to close the menu.
- `Track POI` can bind the target to `point_of_interest` and keep it tracking as
  8111 data refreshes.
- Active source and target units are highlighted on both the map and object
  list.
- Map symbols use affiliation-colored fills with dark internal linework for
  better readability over War Thunder map imagery.
- The page layout centers the map and right-side task panels as a single
  workspace and keeps the main content constrained to the viewport height to
  avoid default vertical page scrolling.

## Development Requirements

- Node.js and npm.
- Rust toolchain.
- .NET SDK 8.
- Windows App SDK / WinUI 3 build support.
- Windows 10 19041 or newer for the WinUI control client.

## Build

Build the Web GUI, Rust service, and WinUI control console:

```powershell
npm.cmd run control:build
```

The release control console is synchronized to the top-level client folder:

```text
WT8111Neo-Client/
```

That output directory should contain both:

```text
WT8111Neo.Control.exe
wt-8111-neo.exe
```

Use `WT8111Neo-Client/WT8111Neo.Control.exe` as the normal local client
launcher. The deeper `src-winui/bin/...` build output remains an internal build
artifact.

## Development Commands

Run the Web GUI dev server:

```powershell
npm.cmd run dev
```

Build only the Web GUI:

```powershell
npm.cmd run build
```

Build the Web GUI and Rust local service:

```powershell
npm.cmd run service:build
```

## Ports

- `8111`: War Thunder official local telemetry endpoint.
- `17711`: WT 8111 Neo local service and LAN-facing Web GUI.
- `5173`: Vite development server.

## Documentation

- [Current Architecture zh-CN](CURRENT_ARCHITECTURE.zh-CN.md)
- [War Thunder 8111 API Reference](WT_8111_API_REFERENCE.md)
- [War Thunder 8111 API Reference zh-CN](WT_8111_API_REFERENCE.zh-CN.md)
- [Native Capture / Local Service Development Notes zh-CN](NATIVE_CAPTURE_PIPELINE.zh-CN.md)
- [Client Cloud Tactical Adaptation zh-CN](CLIENT_CLOUD_ADAPTATION.zh-CN.md)
- [Cloud Tactical Server zh-CN](CLOUD_TACTICAL_SERVER.zh-CN.md)
- [Cloud Tactical Server WebGUI](cloud-tactical-server/docs/WEBGUI.md)

When the API reference is updated, update both language versions in the same
change.

## Safety Boundaries

- No War Thunder memory reading.
- No process injection.
- No process hook as the first approach.
- Current Web GUI consumes only data exposed by War Thunder's local `8111`
  service through the local proxy.
- Any future screen-analysis work should process only pixels already visible to
  the player and remain controlled from the local WinUI client.
