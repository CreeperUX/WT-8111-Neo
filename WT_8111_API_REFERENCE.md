# War Thunder 8111 Port API Reference

Last checked: 2026-05-31

## Language Versions

- English: `WT_8111_API_REFERENCE.md`
- Simplified Chinese: `WT_8111_API_REFERENCE.zh-CN.md`

Maintenance rule: when this API reference is updated, all language versions must
be updated in the same change so endpoint behavior, field names, examples, and
development notes stay aligned.

This document records the data currently available from War Thunder's local
HTTP telemetry service on `http://localhost:8111`. It is intended as the
project reference for designing the WT 8111 Neo web client, modern tactical map,
dashboard, and artillery/map tools.

## 1. Overview

War Thunder exposes a local HTTP service on port `8111` while the game is
running. The service provides:

- A built-in tactical map web page.
- Vehicle/aircraft indicator data.
- Flight/physics state data when available.
- Map metadata and map image.
- Tactical map objects such as player, targets, bases, zones, and airfields.
- Mission objective state.
- Incremental HUD event, damage, and chat messages.

The service is read-friendly for browser clients. Current response headers
include:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: origin, content-type, accept
```

This also explains why early prototypes could call `http://localhost:8111`
directly from a browser. The current WT 8111 Neo architecture uses a local Rust
service instead: Web clients call the project service on `17711`, and that
service proxies War Thunder's `8111` endpoints from the gaming PC. This keeps
LAN devices from accidentally resolving `localhost:8111` to themselves.

## 2. Endpoint Summary

| Endpoint | Method | Type | Purpose | Current status |
| --- | --- | --- | --- | --- |
| `/` | GET | `text/html` | Built-in War Thunder tactical map page | Available |
| `/indicators` | GET | `application/json` | Vehicle/aircraft instruments and crew/ammo state | Available |
| `/state` | GET | `application/json` | Flight model and physics state | Available, often `valid:false` in ground mode |
| `/map_info.json` | GET | `application/json` | Map bounds, grid, generation, HUD type | Available |
| `/map_obj.json` | GET | `application/json` | Tactical map object array | Available |
| `/map.img` | GET | `image/png` or `image/jpeg` | Current tactical map image | Available |
| `/map.img?gen=<id>` | GET | `image/png` or `image/jpeg` | Map image for a generation value | Available |
| `/mission.json` | GET | `application/json` | Mission status and objectives | Available |
| `/gamechat?lastId=<id>` | GET | `application/json` | Incremental game chat records | Available |
| `/hudmsg?lastEvt=<id>&lastDmg=<id>` | GET | `application/json` | Incremental HUD event and damage records | Available |
| `/loc/map/primary_objectives?fmt=js` | GET | `application/javascript` | Built-in localization string | Available |
| `/loc/map/secondary_objectives?fmt=js` | GET | `application/javascript` | Built-in localization string | Available |

Observed non-endpoints:

| Path | Result |
| --- | --- |
| `/map_info` | 404 |
| `/map_obj` | 404 |
| `/state.json` | 404 |
| `/indicators.json` | 404 |
| `/map` | 404 |

## 3. `/indicators`

### Purpose

Provides instrument and vehicle status data. This is currently the most reliable
endpoint for ground vehicles.

### Observed Ground Vehicle Sample

```json
{
  "valid": true,
  "army": "tank",
  "type": "tankModels/ussr_t_80bvm",
  "stabilizer": 1.0,
  "gear": 1.0,
  "gear_neutral": 1.0,
  "speed": 0.0,
  "has_speed_warning": 0.0,
  "rpm": 1500.0,
  "driving_direction_mode": 0.0,
  "cruise_control": 0.0,
  "lws": -1.0,
  "ircm": -1.0,
  "roll_indicators_is_available": 0.0,
  "first_stage_ammo": 25.0,
  "crew_total": 3.0,
  "crew_current": 3.0,
  "crew_distance": 1.0,
  "gunner_state": 0.0,
  "driver_state": 0.0
}
```

### Observed Fields

| Field | Type | Notes |
| --- | --- | --- |
| `valid` | boolean | Whether indicator data is usable. |
| `army` | string | Example: `tank`. |
| `type` | string | Internal vehicle model path. Example: `tankModels/ussr_t_80bvm`. |
| `stabilizer` | number | Stabilizer state. Observed `1.0` when available/on. |
| `gear` | number | Current gear value. |
| `gear_neutral` | number | Neutral gear state. |
| `speed` | number | Current vehicle speed. |
| `has_speed_warning` | number | Speed warning flag. |
| `rpm` | number | Engine RPM. |
| `driving_direction_mode` | number | Ground vehicle driving direction mode. |
| `cruise_control` | number | Cruise control state/value. |
| `lws` | number | Laser warning system state. Observed `-1.0` when unavailable. |
| `ircm` | number | IRCM state. Observed `-1.0` when unavailable. |
| `roll_indicators_is_available` | number | Roll indicator availability. |
| `first_stage_ammo` | number | First-stage ammo count. |
| `crew_total` | number | Total crew count. |
| `crew_current` | number | Current alive crew count. |
| `crew_distance` | number | Crew-related state; exact semantics need validation. |
| `gunner_state` | number | Gunner state. |
| `driver_state` | number | Driver state. |

### Known Indicator Field Families From Built-In Page

The built-in page contains a broad list of possible indicator fields, especially
for aircraft:

- Movement and controls: `speed`, `speed_01`, `speed_02`, `pedals`,
  `stick_elevator`, `stick_ailerons`, `vario`.
- Altitude and attitude: `altitude_hour`, `altitude_min`, `altitude_10k`,
  `aviahorizon_roll`, `aviahorizon_pitch`, `bank`, `turn`, `compass`.
- Engine: `rpm`, `rpm1`, `rpm2`, `rpm3`, `manifold_pressure`,
  `oil_pressure`, `oil_temperature`, `water_temperature`, `carb_temperature`.
- Fuel: `fuel`, `fuel1`, `fuel2`, `fuel_pressure`, `fuel_consume`.
- Aircraft systems: `gears`, `flaps`, `trimmer`, `radiator`,
  `supercharger`, `prop_pitch`.
- Weapons: `weapon1`, `weapon2`, `weapon3`, `ammo_counter`,
  `ammo_counter1` through `ammo_counter7`.

Only fields present in the current vehicle/session are returned. The UI should
treat missing fields as unavailable, not as zero.

## 4. `/state`

### Purpose

Provides detailed flight/physics state. In current ground vehicle observations,
it returned:

```json
{
  "valid": false
}
```

### Known State Field Families From Built-In Page

The built-in page expects possible fields such as:

| Field | Meaning |
| --- | --- |
| `H, m` | Altitude in meters |
| `TAS, km/h` | True airspeed |
| `IAS, km/h` | Indicated airspeed |
| `M` | Mach number |
| `AoA, deg` | Angle of attack |
| `AoS, deg` | Angle of sideslip |
| `Ny` | Vertical load factor |
| `Vy, m/s` | Vertical speed |
| `Wx, deg/s` | Angular velocity X |
| `Mfuel, kg` | Fuel mass |
| `aileron, %` | Aileron position |
| `elevator, %` | Elevator position |
| `rudder, %` | Rudder position |
| `flaps, %` | Flap position |
| `gear, %` | Landing gear position |
| `airbrake, %` | Airbrake position |

Engine-specific fields may appear per engine:

- `throttle 1, %`
- `RPM throttle 1, %`
- `mixture 1, %`
- `radiator 1, %`
- `compressor stage 1`
- `magneto 1`
- `feathered 1`
- `power 1, hp`
- `RPM 1`
- `manifold pressure 1, atm`
- `water temp 1, C`
- `oil temp 1, C`
- `pitch 1, deg`
- `thrust 1, kgs`
- `efficiency 1, %`

The same pattern can repeat for engines `2`, `3`, and `4`.

## 5. `/map_info.json`

### Purpose

Provides map coordinate and grid metadata. This endpoint is essential for map
rendering and artillery tools.

### Observed Sample

```json
{
  "grid_size": [1600.0, 1600.0],
  "grid_steps": [225.0, 225.0],
  "grid_zero": [1519.449951171875, 2497.25],
  "hud_type": 1,
  "map_generation": 1,
  "map_max": [4096.0, 4096.0],
  "map_min": [0.0, 0.0],
  "valid": true
}
```

### Fields

| Field | Type | Notes |
| --- | --- | --- |
| `valid` | boolean | Whether map metadata is usable. |
| `grid_size` | `[number, number]` | Grid display/scale data. Exact semantics need validation. |
| `grid_steps` | `[number, number]` | World-space distance between grid lines. |
| `grid_zero` | `[number, number]` | World-space grid origin/offset. Useful for coordinate conversion. |
| `hud_type` | number | HUD/map mode type. |
| `map_generation` | number | Changes when the map image should be reloaded. |
| `map_min` | `[number, number]` | Minimum world coordinate. |
| `map_max` | `[number, number]` | Maximum world coordinate. |

### Coordinate Model

`/map_obj.json` object coordinates use normalized `x/y` values from `0` to `1`.
The built-in page draws objects as:

```text
screen_x = canvas_width  * object.x
screen_y = canvas_height * object.y
```

For converting normalized object coordinates to world coordinates:

```text
world_x = map_min[0] + object.x * (map_max[0] - map_min[0])
world_y = map_min[1] + object.y * (map_max[1] - map_min[1])
```

For converting world coordinates back to normalized map coordinates:

```text
x = (world_x - map_min[0]) / (map_max[0] - map_min[0])
y = (world_y - map_min[1]) / (map_max[1] - map_min[1])
```

For distance estimation in map/world units:

```text
dx = (target.x - source.x) * (map_max[0] - map_min[0])
dy = (target.y - source.y) * (map_max[1] - map_min[1])
distance = sqrt(dx * dx + dy * dy)
```

For bearing in screen/map coordinates, verify orientation against in-game compass
before finalizing artillery calculations:

```text
bearing_rad = atan2(dx, -dy)
bearing_deg = (bearing_rad * 180 / PI + 360) % 360
```

The built-in player arrow uses `dx/dy` and computes heading as:

```text
heading = atan2(item.dx, -item.dy)
```

## 6. `/map_obj.json`

### Purpose

Provides tactical map objects. This powers player position, visible enemies,
bases, capture zones, waypoints, airfields, and other map markers.

### Observed Sample

```json
[
  {
    "type": "ground_model",
    "color": "#faC81E",
    "color[]": [250, 200, 30],
    "blink": 0,
    "icon": "Player",
    "icon_bg": "none",
    "x": 0.421074,
    "y": 0.563430,
    "dx": 0.939689,
    "dy": -0.342029
  },
  {
    "type": "ground_model",
    "color": "#fa0C00",
    "color[]": [250, 12, 0],
    "blink": 0,
    "icon": "MediumTank",
    "icon_bg": "none",
    "x": 0.518198,
    "y": 0.559460
  }
]
```

Current observation contained 8 objects:

- 1 player object.
- 7 enemy `MediumTank` objects.

### Common Fields

| Field | Type | Notes |
| --- | --- | --- |
| `type` | string | Object type. Example: `ground_model`, `airfield`, respawn types. |
| `icon` | string | Symbol identity. Example: `Player`, `MediumTank`. |
| `icon_bg` | string | Icon background style. Example: `none`. |
| `color` | string | Display color as CSS hex. |
| `color[]` | `[number, number, number]` | RGB color array. |
| `blink` | number | `0` no blink, `1` normal blink, `2` heavy blink. |
| `x` | number | Normalized map X, range usually `0..1`. |
| `y` | number | Normalized map Y, range usually `0..1`. |
| `dx` | number | Direction vector X, present for player/rotated objects. |
| `dy` | number | Direction vector Y, present for player/rotated objects. |

### Airfield Fields

The built-in renderer handles `type == "airfield"` separately and expects:

| Field | Type | Notes |
| --- | --- | --- |
| `sx` | number | Start X normalized coordinate. |
| `sy` | number | Start Y normalized coordinate. |
| `ex` | number | End X normalized coordinate. |
| `ey` | number | End Y normalized coordinate. |

### Known Icon Handling From Built-In Page

The built-in page maps some icons to font glyphs:

| `icon` | Meaning/usage |
| --- | --- |
| `Player` | Player arrow, drawn from `x/y/dx/dy`. |
| `Airdefence` | Air defense marker. |
| `Structure` | Structure marker. |
| `waypoint` | Waypoint marker. |
| `capture_zone` | Capture zone marker. |
| `bombing_point` | Bombing point marker. |
| `defending_point` | Defending point marker. |
| `respawn_base_tank` | Tank respawn marker. |
| `respawn_base_fighter` | Fighter respawn marker, rotated with `dx/dy`. |
| `respawn_base_bomber` | Bomber respawn marker, rotated with `dx/dy`. |
| `MediumTank` | Observed enemy tank marker. |

Unknown icons can be displayed with a fallback text/shape/icon.

## 7. `/map.img` and `/map.img?gen=<id>`

### Purpose

Returns the tactical map image used as the background for the map canvas.

### Observed Behavior

- Earlier sample returned `image/png`.
- Later sample returned `image/jpeg`.
- The client should not assume one fixed image format.
- The built-in page reloads the image when `map_info.map_generation` changes:

```text
/map.img?gen=<map_generation>
```

### Client Recommendation

- Load the map image with `map.img?gen=${mapGeneration}`.
- Reuse the existing image while `map_generation` remains unchanged.
- Redraw object overlays independently from image loading.

## 8. `/mission.json`

### Purpose

Provides mission status and objective list.

### Observed Sample

```json
{
  "objectives": null,
  "status": "running"
}
```

### Expected Objective Model

The built-in page expects `objectives` to be an array when present:

```json
{
  "objectives": [
    {
      "text": "Capture the point",
      "status": "in_progress",
      "primary": true
    }
  ],
  "status": "running"
}
```

Expected objective fields:

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string | Objective text. |
| `status` | string | Example: `in_progress`, `completed`, `failed`. |
| `primary` | boolean | Primary vs secondary objective. |

## 9. `/gamechat?lastId=<id>`

### Purpose

Returns game chat messages newer than `lastId`.

### Observed Empty Sample

```json
[]
```

### Expected Record Model

From the built-in page:

```json
{
  "id": 123,
  "time": 456.7,
  "mode": "Team",
  "sender": "PlayerName",
  "msg": "Message text",
  "enemy": false
}
```

Expected fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | number | Incremental record id. Store latest id for next request. |
| `time` | number | Mission time in seconds. |
| `mode` | string | Chat mode, when present. |
| `sender` | string | Sender name. If absent, message may be system text. |
| `msg` | string | Message body. |
| `enemy` | boolean | Enemy message styling flag. |

## 10. `/hudmsg?lastEvt=<id>&lastDmg=<id>`

### Purpose

Returns HUD event and damage messages newer than the provided ids.

### Observed Empty Sample

```json
{
  "events": [],
  "damage": []
}
```

### Expected Response Model

```json
{
  "events": [
    {
      "id": 1,
      "time": 12.3,
      "msg": "Event text"
    }
  ],
  "damage": [
    {
      "id": 2,
      "time": 13.4,
      "msg": "Damage text"
    }
  ]
}
```

The built-in page updates the next request ids as:

```text
lastEvt = events[events.length - 1].id
lastDmg = damage[damage.length - 1].id
```

## 11. Polling Strategy

Recommended initial polling frequencies:

| Data | Endpoint | Suggested rate |
| --- | --- | --- |
| Vehicle indicators | `/indicators` | 5-10 Hz |
| Map objects | `/map_obj.json` | 5-10 Hz |
| Map metadata | `/map_info.json` | 1 Hz |
| Mission objectives | `/mission.json` | 1 Hz |
| HUD messages | `/hudmsg?lastEvt=<id>&lastDmg=<id>` | 1-2 Hz |
| Game chat | `/gamechat?lastId=<id>` | 1-2 Hz |
| Map image | `/map.img?gen=<id>` | Only when `map_generation` changes |

Implementation notes:

- Use request timeouts and treat failures as temporary offline states.
- Keep the last successful data around for UI continuity.
- Do not assume every endpoint is valid in every game mode.
- Missing fields should be displayed as unavailable, not interpreted as `0`.
- Use `valid` flags where present.

## 12. Suggested TypeScript Models

```ts
export interface WTIndicators {
  valid: boolean;
  army?: string;
  type?: string;
  stabilizer?: number;
  gear?: number;
  gear_neutral?: number;
  speed?: number;
  has_speed_warning?: number;
  rpm?: number;
  driving_direction_mode?: number;
  cruise_control?: number;
  lws?: number;
  ircm?: number;
  roll_indicators_is_available?: number;
  first_stage_ammo?: number;
  crew_total?: number;
  crew_current?: number;
  crew_distance?: number;
  gunner_state?: number;
  driver_state?: number;
  [key: string]: unknown;
}

export interface WTState {
  valid: boolean;
  [key: string]: unknown;
}

export interface WTMapInfo {
  valid: boolean;
  grid_size?: [number, number];
  grid_steps?: [number, number];
  grid_zero?: [number, number];
  hud_type?: number;
  map_generation?: number;
  map_min?: [number, number];
  map_max?: [number, number];
}

export interface WTMapObject {
  type?: string;
  icon?: string;
  icon_bg?: string;
  color?: string;
  "color[]"?: [number, number, number];
  blink?: number;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  sx?: number;
  sy?: number;
  ex?: number;
  ey?: number;
  [key: string]: unknown;
}

export interface WTMissionObjective {
  text?: string;
  status?: string;
  primary?: boolean;
  [key: string]: unknown;
}

export interface WTMission {
  status?: string;
  objectives?: WTMissionObjective[] | null;
}

export interface WTChatRecord {
  id: number;
  time?: number;
  mode?: string;
  sender?: string;
  msg: string;
  enemy?: boolean;
}

export interface WTHudMessages {
  events: WTChatRecord[];
  damage: WTChatRecord[];
}
```

## 13. Feature Mapping For WT 8111 Neo

### Modern Dashboard

Use:

- `/indicators`
- `/state` when valid

Candidate widgets:

- Vehicle name/model resolver.
- Speed and RPM.
- Gear and neutral state.
- Stabilizer state.
- Cruise control state.
- Laser warning and IRCM indicators.
- Crew status.
- First-stage ammo count.
- System availability warnings.

### Tactical Map

Use:

- `/map_info.json`
- `/map_obj.json`
- `/map.img?gen=<id>`

Candidate features:

- Modern map rendering with Canvas.
- Player heading arrow.
- Lightweight NATO/APP-6 / MIL-STD-2525-inspired symbols grouped by affiliation
  and unit type.
- Capture zones and bases.
- Airfield line rendering.
- Object filters.
- Object hover inspector.
- Map generation-aware image reload.

Current symbol policy for the demo:

- Use affiliation frame shape/color first: friendly rectangle/cyan, hostile
  diamond/red, neutral square/green, unknown quatrefoil/amber.
- Use simplified inner icons for object type: armor oval, air defense arc,
  artillery dot, objective crosshair, installation box, waypoint flag, respawn
  triangle, player heading arrow.
- Infer affiliation from War Thunder object colors and known icons. This is a
  visual aid, not a full APP-6 or MIL-STD-2525 implementation.
- Keep symbols intentionally small and lightly filled so they do not obscure the
  in-game map image.

### Artillery / Map Tools

Use:

- `/map_info.json`
- `/map_obj.json`
- User-created map markers.

Candidate tools:

- Click-to-place marker.
- Player-to-marker distance.
- Marker-to-marker distance.
- Bearing from player to marker.
- Grid coordinate display.
- Ranging line overlay.
- Target list from visible map objects.
- Saved temporary fire missions.
- Manual correction notes.

Important validation needed:

- Confirm map world units vs in-game meters for each map type.
- Confirm Y-axis orientation for artillery bearing.
- Confirm whether `grid_zero` is needed for exact in-game grid labels.
- Confirm behavior across ground arcade/realistic/simulator and test drive.

### Event Feed

Use:

- `/hudmsg?lastEvt=<id>&lastDmg=<id>`
- `/gamechat?lastId=<id>`

Candidate features:

- Damage/event timeline.
- Important event highlighting.
- Chat overlay panel.
- Search/filter by sender/type.

### Visual Radar Capture Experiment

This is not an `8111` endpoint feature. It is a separate browser-side visual
experiment for user-selected screen/window capture.

Current project status: this direction is paused. The Web GUI no longer exposes
radar capture controls, and any future capture settings should live in the
local WinUI control client rather than the LAN-facing Web GUI.

Pipeline:

- User explicitly selects a screen or War Thunder window via browser
  `getDisplayMedia`.
- User manually marks a radar ROI in the captured preview.
- The browser `getDisplayMedia -> video -> canvas -> ImageData` path currently
  exposes an 8-bit composited SDR/sRGB-like buffer in this app.
- SDR/HDR is still exposed as a user-declared source mode for calibration, but
  the browser path must not apply PQ/BT.2020 decoding to `ImageData` bytes.
- HDR mode can use different recognition thresholds, but pixel color conversion
  should be reserved for a future native HDR capture path that provides real HDR
  samples and metadata.
- Radar recognition should consume one normalized SDR/sRGB working image.

Constraints:

- No memory reading, process injection, or game automation.
- Only pixels already visible to the player are processed.
- The current detector is a lightweight bright/contact point prototype and needs
  per-radar-mode calibration.
- Do not treat browser canvas bytes as raw HDR signal data.

## 14. Current Observed Session Snapshot

The latest observed session returned:

```text
Vehicle: tankModels/ussr_t_80bvm
Army: tank
Speed: 0
RPM: 1500
Gear: 1
First-stage ammo: 25
Crew: 3 / 3
Map valid: true
Map generation: 1
Map objects: 8
Player map position: x=0.421074, y=0.563430
Player direction: dx=0.939689, dy=-0.342029
```

Observed object composition:

```text
1 Player
7 MediumTank
```

## 15. Open Questions

- Which game modes expose `/state.valid=true` for ground vehicles, if any?
- Do all ground maps use the same world-unit-to-meter interpretation?
- How exactly should `grid_zero` be used for official grid labels?
- Are enemy objects only visible when the in-game map would show them?
- Does `/map_obj.json` include hidden or server-side-only entities? It should be
  treated as displaying only what War Thunder exposes locally.
- Are POST methods meaningful for any endpoint, or only advertised by generic
  headers?
- Does `hud_type` affect icon sets or coordinate transforms?

## 16. Development Guidelines

- Treat `localhost:8111` as an optional runtime dependency. The app should boot
  even when War Thunder is closed.
- Build a small API client layer first, then UI components.
- Keep raw endpoint responses available in a developer/debug panel.
- Preserve unknown fields instead of stripping them.
- Prefer Canvas for the map layer to avoid DOM overhead at higher update rates.
- Separate data polling from rendering.
- Keep artillery calculations testable as pure functions.
- Record new observed fields in this document as development continues.
