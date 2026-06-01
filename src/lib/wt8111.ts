export const WT_BASE_URL = "/api/wt";

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

export interface WTPollSnapshot {
  ok: boolean;
  indicators?: WTIndicators;
  state?: WTState;
  mapInfo?: WTMapInfo;
  mapObjects?: WTMapObject[];
  mission?: WTMission;
  chat?: WTChatRecord[];
  hud?: WTHudMessages;
  error?: string;
  updatedAt: number;
}

export interface WTMapPollSnapshot {
  ok: boolean;
  mapInfo?: WTMapInfo;
  mapObjects?: WTMapObject[];
  error?: string;
  updatedAt: number;
}

export interface WTPollCursor {
  lastChatId: number;
  lastEvtId: number;
  lastDmgId: number;
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${WT_BASE_URL}${path}`, {
    method: "GET",
    signal,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    return null as T;
  }

  return JSON.parse(text) as T;
}

export async function pollWT8111Map(signal?: AbortSignal): Promise<WTMapPollSnapshot> {
  try {
    const [mapInfo, mapObjects] = await Promise.all([
      fetchJson<WTMapInfo>("/map_info.json", signal),
      fetchJson<WTMapObject[]>("/map_obj.json", signal)
    ]);

    return {
      ok: true,
      mapInfo,
      mapObjects: Array.isArray(mapObjects) ? mapObjects : [],
      updatedAt: Date.now()
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown 8111 map error",
      updatedAt: Date.now()
    };
  }
}

export async function pollWT8111(
  cursor: WTPollCursor,
  signal?: AbortSignal
): Promise<WTPollSnapshot> {
  try {
    const [indicators, state, mapInfo, mapObjects, mission, chat, hud] =
      await Promise.all([
        fetchJson<WTIndicators>("/indicators", signal),
        fetchJson<WTState>("/state", signal),
        fetchJson<WTMapInfo>("/map_info.json", signal),
        fetchJson<WTMapObject[]>("/map_obj.json", signal),
        fetchJson<WTMission>("/mission.json", signal),
        fetchJson<WTChatRecord[]>(`/gamechat?lastId=${cursor.lastChatId}`, signal),
        fetchJson<WTHudMessages>(
          `/hudmsg?lastEvt=${cursor.lastEvtId}&lastDmg=${cursor.lastDmgId}`,
          signal
        )
      ]);

    return {
      ok: true,
      indicators,
      state,
      mapInfo,
      mapObjects: Array.isArray(mapObjects) ? mapObjects : [],
      mission,
      chat: Array.isArray(chat) ? chat : [],
      hud: hud ?? { events: [], damage: [] },
      updatedAt: Date.now()
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown 8111 error",
      updatedAt: Date.now()
    };
  }
}

export function getMapImageUrl(mapInfo?: WTMapInfo): string {
  const generation = mapInfo?.map_generation ?? 0;
  return `${WT_BASE_URL}/map.img?gen=${generation}`;
}

export function findPlayer(objects: WTMapObject[] = []): WTMapObject | undefined {
  return objects.find((object) => object.icon === "Player");
}

export function objectToWorld(
  object: Pick<WTMapObject, "x" | "y">,
  mapInfo?: WTMapInfo
): [number, number] | undefined {
  if (
    typeof object.x !== "number" ||
    typeof object.y !== "number" ||
    !mapInfo?.map_min ||
    !mapInfo.map_max
  ) {
    return undefined;
  }

  const [minX, minY] = mapInfo.map_min;
  const [maxX, maxY] = mapInfo.map_max;
  return [minX + object.x * (maxX - minX), minY + object.y * (maxY - minY)];
}

export function distanceBetween(
  source: Pick<WTMapObject, "x" | "y">,
  target: Pick<WTMapObject, "x" | "y">,
  mapInfo?: WTMapInfo
): number | undefined {
  if (
    typeof source.x !== "number" ||
    typeof source.y !== "number" ||
    typeof target.x !== "number" ||
    typeof target.y !== "number" ||
    !mapInfo?.map_min ||
    !mapInfo.map_max
  ) {
    return undefined;
  }

  const width = mapInfo.map_max[0] - mapInfo.map_min[0];
  const height = mapInfo.map_max[1] - mapInfo.map_min[1];
  const dx = (target.x - source.x) * width;
  const dy = (target.y - source.y) * height;
  return Math.hypot(dx, dy);
}

export function bearingBetween(
  source: Pick<WTMapObject, "x" | "y">,
  target: Pick<WTMapObject, "x" | "y">
): number | undefined {
  if (
    typeof source.x !== "number" ||
    typeof source.y !== "number" ||
    typeof target.x !== "number" ||
    typeof target.y !== "number"
  ) {
    return undefined;
  }

  const dx = target.x - source.x;
  const dy = target.y - source.y;
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}
