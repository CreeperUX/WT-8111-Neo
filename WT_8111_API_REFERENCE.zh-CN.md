# War Thunder 8111 端口 API 参考

最后检查日期：2026-05-31

## 语言版本

- English: `WT_8111_API_REFERENCE.md`
- 简体中文：`WT_8111_API_REFERENCE.zh-CN.md`

维护规则：以后更新这份 API 参考时，必须在同一次变更中同步更新所有语言版本，确保端点行为、字段名、示例和开发说明保持一致。

本文档记录 War Thunder 本地 HTTP 遥测服务 `http://localhost:8111` 当前可提供的数据。它将作为 WT 8111 Neo Web 客户端、现代化战术地图、仪表盘和炮兵/地图工具设计时的项目参考。

## 1. 概览

War Thunder 在游戏运行时会在本机 `8111` 端口暴露一个 HTTP 服务。这个服务提供：

- 游戏自带的战术地图网页。
- 车辆/飞机仪表数据。
- 可用时的飞行/物理状态数据。
- 地图元信息和地图图片。
- 玩家、目标、基地、占领区、机场等战术地图对象。
- 任务目标状态。
- HUD 事件、伤害消息和聊天消息的增量数据。

该服务适合被浏览器客户端读取。当前响应头包含：

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: origin, content-type, accept
```

这也解释了早期原型为什么可以由浏览器直接请求 `http://localhost:8111`。当前 WT 8111 Neo 架构已经改为使用本地 Rust 服务：Web 客户端请求项目自己的 `17711` 服务，由该服务在游戏主机上代理 War Thunder 的 `8111` 端点。这样可以避免平板或其他局域网设备把 `localhost:8111` 错误解析为设备自身。

## 2. 端点汇总

| 端点 | 方法 | 类型 | 用途 | 当前状态 |
| --- | --- | --- | --- | --- |
| `/` | GET | `text/html` | War Thunder 自带战术地图页面 | 可用 |
| `/indicators` | GET | `application/json` | 车辆/飞机仪表、乘员、弹药状态 | 可用 |
| `/state` | GET | `application/json` | 飞行模型和物理状态 | 可用，但陆战模式常见 `valid:false` |
| `/map_info.json` | GET | `application/json` | 地图范围、网格、generation、HUD 类型 | 可用 |
| `/map_obj.json` | GET | `application/json` | 战术地图对象数组 | 可用 |
| `/map.img` | GET | `image/png` 或 `image/jpeg` | 当前战术地图图片 | 可用 |
| `/map.img?gen=<id>` | GET | `image/png` 或 `image/jpeg` | 指定 generation 的地图图片 | 可用 |
| `/mission.json` | GET | `application/json` | 任务状态和任务目标 | 可用 |
| `/gamechat?lastId=<id>` | GET | `application/json` | 游戏聊天增量记录 | 可用 |
| `/hudmsg?lastEvt=<id>&lastDmg=<id>` | GET | `application/json` | HUD 事件和伤害增量记录 | 可用 |
| `/loc/map/primary_objectives?fmt=js` | GET | `application/javascript` | 自带页面本地化字符串 | 可用 |
| `/loc/map/secondary_objectives?fmt=js` | GET | `application/javascript` | 自带页面本地化字符串 | 可用 |

已观察到的非端点：

| 路径 | 结果 |
| --- | --- |
| `/map_info` | 404 |
| `/map_obj` | 404 |
| `/state.json` | 404 |
| `/indicators.json` | 404 |
| `/map` | 404 |

## 3. `/indicators`

### 用途

提供仪表和车辆状态数据。目前在陆战载具下，这是最稳定、最有用的端点。

### 已观察到的陆战载具示例

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

### 已观察到的字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `valid` | boolean | 仪表数据是否可用。 |
| `army` | string | 示例：`tank`。 |
| `type` | string | 内部载具模型路径。示例：`tankModels/ussr_t_80bvm`。 |
| `stabilizer` | number | 稳定器状态。观察到 `1.0` 表示可用/开启。 |
| `gear` | number | 当前档位数值。 |
| `gear_neutral` | number | 空档状态。 |
| `speed` | number | 当前载具速度。 |
| `has_speed_warning` | number | 速度警告标记。 |
| `rpm` | number | 发动机转速。 |
| `driving_direction_mode` | number | 陆战载具驾驶方向模式。 |
| `cruise_control` | number | 巡航控制状态/数值。 |
| `lws` | number | 激光告警系统状态。观察到 `-1.0` 表示不可用。 |
| `ircm` | number | 红外干扰系统状态。观察到 `-1.0` 表示不可用。 |
| `roll_indicators_is_available` | number | 横滚指示器是否可用。 |
| `first_stage_ammo` | number | 一级弹药架弹药数量。 |
| `crew_total` | number | 总乘员数。 |
| `crew_current` | number | 当前存活乘员数。 |
| `crew_distance` | number | 乘员相关状态，具体语义仍需验证。 |
| `gunner_state` | number | 炮手状态。 |
| `driver_state` | number | 驾驶员状态。 |

### 自带页面中已知的 Indicator 字段族

War Thunder 自带页面包含大量可能出现的 indicator 字段，尤其面向飞机：

- 运动和操纵：`speed`、`speed_01`、`speed_02`、`pedals`、`stick_elevator`、`stick_ailerons`、`vario`。
- 高度和姿态：`altitude_hour`、`altitude_min`、`altitude_10k`、`aviahorizon_roll`、`aviahorizon_pitch`、`bank`、`turn`、`compass`。
- 发动机：`rpm`、`rpm1`、`rpm2`、`rpm3`、`manifold_pressure`、`oil_pressure`、`oil_temperature`、`water_temperature`、`carb_temperature`。
- 燃油：`fuel`、`fuel1`、`fuel2`、`fuel_pressure`、`fuel_consume`。
- 飞机系统：`gears`、`flaps`、`trimmer`、`radiator`、`supercharger`、`prop_pitch`。
- 武器：`weapon1`、`weapon2`、`weapon3`、`ammo_counter`、`ammo_counter1` 到 `ammo_counter7`。

只有当前载具/场景中存在的字段才会返回。UI 应该把缺失字段视为“不可用”，不要当作 `0`。

## 4. `/state`

### 用途

提供更详细的飞行/物理状态。在当前陆战载具观测中，返回为：

```json
{
  "valid": false
}
```

### 自带页面中已知的 State 字段族

自带页面预期可能出现以下字段：

| 字段 | 含义 |
| --- | --- |
| `H, m` | 高度，单位米 |
| `TAS, km/h` | 真空速 |
| `IAS, km/h` | 指示空速 |
| `M` | 马赫数 |
| `AoA, deg` | 迎角 |
| `AoS, deg` | 侧滑角 |
| `Ny` | 垂直过载 |
| `Vy, m/s` | 垂直速度 |
| `Wx, deg/s` | X 轴角速度 |
| `Mfuel, kg` | 燃油质量 |
| `aileron, %` | 副翼位置 |
| `elevator, %` | 升降舵位置 |
| `rudder, %` | 方向舵位置 |
| `flaps, %` | 襟翼位置 |
| `gear, %` | 起落架位置 |
| `airbrake, %` | 减速板位置 |

发动机相关字段可能按发动机编号出现：

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

同样的字段模式可能重复到发动机 `2`、`3` 和 `4`。

## 5. `/map_info.json`

### 用途

提供地图坐标和网格元信息。这个端点对地图渲染和炮兵工具非常关键。

### 已观察到的示例

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

### 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `valid` | boolean | 地图元信息是否可用。 |
| `grid_size` | `[number, number]` | 网格显示/缩放数据，具体语义仍需验证。 |
| `grid_steps` | `[number, number]` | 网格线之间的世界坐标距离。 |
| `grid_zero` | `[number, number]` | 世界坐标中的网格原点/偏移。对坐标换算有用。 |
| `hud_type` | number | HUD/地图模式类型。 |
| `map_generation` | number | 当它变化时，应重新加载地图图片。 |
| `map_min` | `[number, number]` | 地图最小世界坐标。 |
| `map_max` | `[number, number]` | 地图最大世界坐标。 |

### 坐标模型

`/map_obj.json` 中的对象坐标使用 `0` 到 `1` 的归一化 `x/y`。自带页面绘制对象时使用：

```text
screen_x = canvas_width  * object.x
screen_y = canvas_height * object.y
```

归一化对象坐标转换到世界坐标：

```text
world_x = map_min[0] + object.x * (map_max[0] - map_min[0])
world_y = map_min[1] + object.y * (map_max[1] - map_min[1])
```

世界坐标转换回归一化地图坐标：

```text
x = (world_x - map_min[0]) / (map_max[0] - map_min[0])
y = (world_y - map_min[1]) / (map_max[1] - map_min[1])
```

地图/世界单位下的距离估算：

```text
dx = (target.x - source.x) * (map_max[0] - map_min[0])
dy = (target.y - source.y) * (map_max[1] - map_min[1])
distance = sqrt(dx * dx + dy * dy)
```

屏幕/地图坐标中的方位角需要结合游戏内罗盘方向再次验证后，再用于炮兵计算：

```text
bearing_rad = atan2(dx, -dy)
bearing_deg = (bearing_rad * 180 / PI + 360) % 360
```

自带玩家箭头使用 `dx/dy`，航向计算方式为：

```text
heading = atan2(item.dx, -item.dy)
```

## 6. `/map_obj.json`

### 用途

提供战术地图对象。它驱动玩家位置、可见敌人、基地、占领区、航点、机场和其他地图标记。

### 已观察到的示例

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

当前观测包含 8 个对象：

- 1 个玩家对象。
- 7 个敌方 `MediumTank` 对象。

### 常见字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | 对象类型。示例：`ground_model`、`airfield`、重生点类型。 |
| `icon` | string | 图标身份。示例：`Player`、`MediumTank`。 |
| `icon_bg` | string | 图标背景样式。示例：`none`。 |
| `color` | string | CSS 十六进制显示颜色。 |
| `color[]` | `[number, number, number]` | RGB 颜色数组。 |
| `blink` | number | `0` 不闪烁，`1` 普通闪烁，`2` 强闪烁。 |
| `x` | number | 归一化地图 X，通常范围为 `0..1`。 |
| `y` | number | 归一化地图 Y，通常范围为 `0..1`。 |
| `dx` | number | 方向向量 X，玩家/旋转对象会出现。 |
| `dy` | number | 方向向量 Y，玩家/旋转对象会出现。 |

### 机场字段

自带渲染器会单独处理 `type == "airfield"`，并预期以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sx` | number | 起点 X 归一化坐标。 |
| `sy` | number | 起点 Y 归一化坐标。 |
| `ex` | number | 终点 X 归一化坐标。 |
| `ey` | number | 终点 Y 归一化坐标。 |

### 自带页面中的已知图标处理

自带页面将部分图标映射到字体符号：

| `icon` | 含义/用途 |
| --- | --- |
| `Player` | 玩家箭头，通过 `x/y/dx/dy` 绘制。 |
| `Airdefence` | 防空标记。 |
| `Structure` | 建筑/结构标记。 |
| `waypoint` | 航点标记。 |
| `capture_zone` | 占领区标记。 |
| `bombing_point` | 轰炸点标记。 |
| `defending_point` | 防守点标记。 |
| `respawn_base_tank` | 坦克重生点标记。 |
| `respawn_base_fighter` | 战斗机重生点标记，使用 `dx/dy` 旋转。 |
| `respawn_base_bomber` | 轰炸机重生点标记，使用 `dx/dy` 旋转。 |
| `MediumTank` | 已观察到的敌方坦克标记。 |

未知图标可以使用文本、形状或通用图标作为降级显示。

## 7. `/map.img` 和 `/map.img?gen=<id>`

### 用途

返回战术地图底图。

### 已观察到的行为

- 早期采样返回 `image/png`。
- 后续采样返回 `image/jpeg`。
- 客户端不应假设固定图片格式。
- 自带页面会在 `map_info.map_generation` 变化时重新加载图片：

```text
/map.img?gen=<map_generation>
```

### 客户端建议

- 使用 `map.img?gen=${mapGeneration}` 加载地图图片。
- 当 `map_generation` 不变时复用现有图片。
- 地图对象覆盖层应独立于图片加载进行重绘。

## 8. `/mission.json`

### 用途

提供任务状态和任务目标列表。

### 已观察到的示例

```json
{
  "objectives": null,
  "status": "running"
}
```

### 预期任务目标模型

自带页面预期 `objectives` 在存在时为数组：

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

预期字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string | 任务目标文本。 |
| `status` | string | 示例：`in_progress`、`completed`、`failed`。 |
| `primary` | boolean | 主目标或次要目标。 |

## 9. `/gamechat?lastId=<id>`

### 用途

返回 `lastId` 之后的新聊天消息。

### 已观察到的空示例

```json
[]
```

### 预期记录模型

根据自带页面逻辑：

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

预期字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | number | 递增记录 id。下一次请求需要保存最新 id。 |
| `time` | number | 任务时间，单位秒。 |
| `mode` | string | 聊天模式，存在时返回。 |
| `sender` | string | 发送者名称。缺失时可能是系统消息。 |
| `msg` | string | 消息正文。 |
| `enemy` | boolean | 敌方消息样式标记。 |

## 10. `/hudmsg?lastEvt=<id>&lastDmg=<id>`

### 用途

返回给定 id 之后的新 HUD 事件和伤害消息。

### 已观察到的空示例

```json
{
  "events": [],
  "damage": []
}
```

### 预期响应模型

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

自带页面会这样更新下一次请求的 id：

```text
lastEvt = events[events.length - 1].id
lastDmg = damage[damage.length - 1].id
```

## 11. 轮询策略

建议的初始轮询频率：

| 数据 | 端点 | 建议频率 |
| --- | --- | --- |
| 载具仪表 | `/indicators` | 5-10 Hz |
| 地图对象 | `/map_obj.json` | 5-10 Hz |
| 地图元信息 | `/map_info.json` | 1 Hz |
| 任务目标 | `/mission.json` | 1 Hz |
| HUD 消息 | `/hudmsg?lastEvt=<id>&lastDmg=<id>` | 1-2 Hz |
| 游戏聊天 | `/gamechat?lastId=<id>` | 1-2 Hz |
| 地图图片 | `/map.img?gen=<id>` | 仅在 `map_generation` 变化时加载 |

实现注意事项：

- 使用请求超时，并把失败视为临时离线状态。
- 保留最后一次成功数据，避免 UI 闪烁。
- 不要假设每个端点在所有游戏模式下都有效。
- 缺失字段应显示为不可用，不要解释为 `0`。
- 优先使用响应中的 `valid` 标记。

## 12. 建议的 TypeScript 模型

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

## 13. WT 8111 Neo 功能映射

### 现代化仪表盘

使用：

- `/indicators`
- `/state`，当其有效时

候选组件：

- 载具名称/型号解析器。
- 速度和 RPM。
- 档位和空档状态。
- 稳定器状态。
- 巡航控制状态。
- 激光告警和红外干扰提示。
- 乘员状态。
- 一级弹药架弹药数量。
- 系统可用性警告。

### 战术地图

使用：

- `/map_info.json`
- `/map_obj.json`
- `/map.img?gen=<id>`

候选功能：

- 基于 Canvas 的现代地图渲染。
- 玩家朝向箭头。
- 按敌我属性和单位类型分组的轻量 NATO/APP-6 / MIL-STD-2525 风格符号。
- 占领区和基地。
- 机场线段渲染。
- 对象过滤器。
- 对象悬停检查器。
- 感知 `map_generation` 的地图图片重载。

当前 demo 的符号策略：

- 优先用外框形状/颜色表达敌我属性：友方矩形/青色，敌方菱形/红色，中立方形/绿色，未知四叶形/琥珀色。
- 使用简化内部图标表达对象类型：装甲椭圆、防空弧线、炮兵点、目标十字、设施方框、航点旗帜、重生三角、玩家朝向箭头。
- 敌我属性根据 War Thunder 对象颜色和已知图标推断。这只是视觉辅助，不是完整 APP-6 或 MIL-STD-2525 实现。
- 符号刻意保持较小、轻填充，避免遮挡游戏地图底图。

### 炮兵 / 地图工具

使用：

- `/map_info.json`
- `/map_obj.json`
- 用户创建的地图标记。

候选工具：

- 点击地图放置标记。
- 玩家到标记的距离。
- 标记到标记的距离。
- 玩家到标记的方位角。
- 网格坐标显示。
- 测距线覆盖层。
- 从可见地图对象生成目标列表。
- 临时火力任务保存。
- 手动修正备注。

需要重点验证：

- 每张地图的世界单位和游戏内米制距离之间的关系。
- 炮兵方位角中的 Y 轴方向。
- `grid_zero` 是否需要参与精确游戏网格标签计算。
- 陆战街机/历史/模拟和试驾中的行为差异。

### 事件流

使用：

- `/hudmsg?lastEvt=<id>&lastDmg=<id>`
- `/gamechat?lastId=<id>`

候选功能：

- 伤害/事件时间线。
- 重要事件高亮。
- 聊天覆盖面板。
- 按发送者/类型搜索和过滤。

### 视觉雷达捕获实验

这不是 `8111` 端点能力，而是一个独立的浏览器侧视觉实验模块，用于处理用户主动选择的屏幕/窗口画面。

当前项目状态：该方向已暂停。Web GUI 不再暴露雷达采集控件；如果未来恢复采集设置，也应放在本地 WinUI 控制台中，而不是放回面向局域网设备的 Web GUI。

管线：

- 用户通过浏览器 `getDisplayMedia` 明确选择屏幕或 War Thunder 窗口。
- 用户在捕获预览中手动框选雷达 ROI。
- 当前浏览器 `getDisplayMedia -> video -> canvas -> ImageData` 路径在本应用中暴露的是 8-bit 合成后的 SDR/sRGB-like 缓冲。
- SDR/HDR 仍作为玩家声明的输入源模式，用于后续校准，但浏览器路径不能对 `ImageData` 字节再做 PQ/BT.2020 解码。
- HDR 模式可以使用不同的识别阈值，但像素色彩转换应保留给未来真正能提供 HDR 样本和元数据的原生捕获路径。
- 雷达识别算法应消费统一的 SDR/sRGB 工作图像。

约束：

- 不读取内存，不注入进程，不做游戏自动化。
- 只处理玩家屏幕上已经可见的像素。
- 当前检测器只是轻量亮点/接触点原型，后续需要针对不同雷达模式校准。
- 不要把浏览器 Canvas 字节当作原始 HDR 信号数据处理。

## 14. 当前观测会话快照

最新观测会话返回：

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

观察到的对象组成：

```text
1 Player
7 MediumTank
```

## 15. 待确认问题

- 哪些游戏模式会让陆战载具的 `/state.valid` 变为 `true`？
- 所有陆战地图的世界单位到米的解释是否一致？
- `grid_zero` 应该如何用于官方网格标签？
- 敌方对象是否只包含游戏内地图本来就会显示的内容？
- `/map_obj.json` 是否包含隐藏或服务器侧实体？目前应按“只显示 War Thunder 本地暴露的内容”处理。
- POST 方法是否对某些端点有实际意义，还是只是通用响应头中声明？
- `hud_type` 是否会影响图标集或坐标变换？

## 16. 开发准则

- 把 `localhost:8111` 当作可选运行时依赖。War Thunder 关闭时，应用也应该能启动。
- 先构建小型 API client 层，再开发 UI 组件。
- 在开发者/调试面板中保留原始端点响应。
- 保留未知字段，不要在解析时丢弃。
- 地图层优先使用 Canvas，以避免高更新率下的 DOM 开销。
- 数据轮询和渲染逻辑分离。
- 炮兵计算应保持为可测试的纯函数。
- 开发过程中观察到的新字段，应持续记录到本文档和对应的其他语言版本中。
