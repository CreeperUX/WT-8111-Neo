import {
  Activity,
  Crosshair,
  Eraser,
  Eye,
  EyeOff,
  Focus,
  LocateFixed,
  MapPinned,
  MoreHorizontal,
  MousePointer2,
  Plane,
  RadioTower,
  RotateCcw,
  Ruler,
  Shield,
  Target,
  Waypoints,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useWT8111Map } from "./hooks/useWT8111Map";
import {
  bearingBetween,
  distanceBetween,
  findPlayer,
  getMapImageUrl,
  objectToWorld,
  type WTMapInfo,
  type WTMapObject
} from "./lib/wt8111";

interface MapMarker {
  id: number;
  label: string;
  x: number;
  y: number;
}

type FirePointRef =
  | { kind: "player" }
  | { kind: "marker"; markerId: number; label: string }
  | {
      kind: "object";
      objectIndex: number;
      icon?: string;
      type?: string;
      label: string;
      colorSignature?: string;
      initialX?: number;
      initialY?: number;
      lastX?: number;
      lastY?: number;
    }
  | { kind: "poi" };

interface FirePoint {
  ref: FirePointRef;
  label: string;
  x: number;
  y: number;
  color: string;
  objectIndex?: number;
  objectKey?: string;
}

interface TrackSample {
  x: number;
  y: number;
  at: number;
}

interface TargetObservation {
  fingerprint: string;
  label: string;
  x: number;
  y: number;
  objectKey: string;
  color: string;
}

interface HostileTrack {
  id: string;
  fingerprint: string;
  label: string;
  color: string;
  firstSeenAt: number;
  lastSeenAt: number;
  objectKey?: string;
  samples: TrackSample[];
  velocityX: number;
  velocityY: number;
}

interface MapView {
  zoom: number;
  panX: number;
  panY: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originPanX: number;
  originPanY: number;
  moved: boolean;
}

type MapSelection =
  | {
      kind: "object";
      object: WTMapObject;
      index: number;
      x: number;
      y: number;
    }
  | {
      kind: "point";
      x: number;
      y: number;
    };

type Affiliation = "friend" | "hostile" | "neutral" | "unknown";
type WorkbenchMode = "ground" | "air";
type SymbolKind =
  | "aircraft"
  | "armor"
  | "airDefense"
  | "artillery"
  | "installation"
  | "objective"
  | "respawn"
  | "waypoint"
  | "player"
  | "unknown";

type ObjectFilter = "all" | "ground" | "air" | "objective" | "spawn" | "other";

const objectFilterOptions: { value: Exclude<ObjectFilter, "all">; label: string }[] = [
  { value: "ground", label: "Ground" },
  { value: "air", label: "Air" },
  { value: "objective", label: "Objective" },
  { value: "spawn", label: "Spawn" },
  { value: "other", label: "Other" }
];

const affiliationTheme: Record<
  Affiliation,
  { stroke: string; fill: string; ink: string; label: string }
> = {
  friend: {
    stroke: "#31dfff",
    fill: "rgba(49, 223, 255, 0.58)",
    ink: "#061014",
    label: "Friend"
  },
  hostile: {
    stroke: "#ff6358",
    fill: "rgba(255, 99, 88, 0.58)",
    ink: "#130706",
    label: "Hostile"
  },
  neutral: {
    stroke: "#93e979",
    fill: "rgba(147, 233, 121, 0.54)",
    ink: "#081207",
    label: "Neutral"
  },
  unknown: {
    stroke: "#ffd25f",
    fill: "rgba(255, 210, 95, 0.6)",
    ink: "#151006",
    label: "Unknown"
  }
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const HOSTILE_TRACK_HISTORY_MS = 3000;
const HOSTILE_ROI_RETENTION_MS = 15000;
const EMPTY_MAP_OBJECTS: WTMapObject[] = [];
const GRID_LINES = Array.from({ length: 9 }, (_, index) => index / 8);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampMapView(view: MapView): MapView {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  const minPan = 1 - zoom;

  return {
    zoom,
    panX: clamp(view.panX, minPan, 0),
    panY: clamp(view.panY, minPan, 0)
  };
}

function zoomAround(view: MapView, nextZoom: number, anchorX = 0.5, anchorY = 0.5): MapView {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const mapX = (anchorX - view.panX) / view.zoom;
  const mapY = (anchorY - view.panY) / view.zoom;

  return clampMapView({
    zoom,
    panX: anchorX - mapX * zoom,
    panY: anchorY - mapY * zoom
  });
}

function mapToScreenPoint(
  point: Pick<WTMapObject, "x" | "y"> | Pick<MapMarker, "x" | "y"> | undefined,
  view: MapView
) {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    return undefined;
  }

  return {
    x: view.panX + point.x * view.zoom,
    y: view.panY + point.y * view.zoom
  };
}

function pointDistanceSquared(
  left: Pick<WTMapObject, "x" | "y">,
  right: Pick<WTMapObject, "x" | "y">
) {
  if (!hasMapPoint(left) || !hasMapPoint(right)) {
    return Number.POSITIVE_INFINITY;
  }

  const leftX = left.x ?? 0;
  const leftY = left.y ?? 0;
  const rightX = right.x ?? 0;
  const rightY = right.y ?? 0;

  return (leftX - rightX) ** 2 + (leftY - rightY) ** 2;
}

function formatNumber(value: number | undefined, digits = 0) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }

  return value.toFixed(digits);
}

function formatWorldPoint(
  marker: Pick<WTMapObject, "x" | "y"> | Pick<MapMarker, "x" | "y"> | undefined,
  mapInfo?: WTMapInfo
) {
  if (!marker || typeof marker.x !== "number" || typeof marker.y !== "number") {
    return "--";
  }

  const world = objectToWorld(marker, mapInfo);
  if (!world) {
    return "--";
  }

  return `${world[0].toFixed(0)}, ${world[1].toFixed(0)}`;
}

function objectColor(object: WTMapObject) {
  return affiliationTheme[inferAffiliation(object)].stroke;
}

function objectLabel(object: WTMapObject) {
  return object.icon ?? object.type ?? "object";
}

function objectColorSignature(object: WTMapObject) {
  const rgb = object["color[]"];
  if (rgb) {
    return rgb.join(",");
  }

  return object.color?.toLowerCase() ?? "";
}

function objectKey(object: WTMapObject, index: number) {
  return [index, object.icon ?? "", object.type ?? ""].join(":");
}

function objectVisibilityKey(object: WTMapObject, index: number) {
  return objectKey(object, index);
}

function targetFingerprint(object: WTMapObject) {
  return [
    inferAffiliation(object),
    objectLabel(object).toLowerCase(),
    objectColorSignature(object),
    classifyObject(object)
  ].join("|");
}

function markerRef(marker: MapMarker): FirePointRef {
  return { kind: "marker", markerId: marker.id, label: marker.label };
}

function objectRef(
  object: WTMapObject,
  index: number,
  previous?: Extract<FirePointRef, { kind: "object" }>
): FirePointRef {
  return {
    kind: "object",
    objectIndex: index,
    icon: object.icon,
    type: object.type,
    label: objectLabel(object),
    colorSignature: objectColorSignature(object),
    initialX: previous?.initialX ?? object.x,
    initialY: previous?.initialY ?? object.y,
    lastX: object.x,
    lastY: object.y
  };
}

function firePointRefKey(ref?: FirePointRef) {
  if (!ref) {
    return "";
  }

  if (ref.kind === "player" || ref.kind === "poi") {
    return ref.kind;
  }

  if (ref.kind === "marker") {
    return `marker:${ref.markerId}`;
  }

  return [
    "object",
    ref.objectIndex,
    ref.icon ?? "",
    ref.type ?? "",
    ref.colorSignature ?? "",
    typeof ref.initialX === "number" ? ref.initialX.toFixed(6) : "x",
    typeof ref.initialY === "number" ? ref.initialY.toFixed(6) : "y",
    typeof ref.lastX === "number" ? ref.lastX.toFixed(6) : "x",
    typeof ref.lastY === "number" ? ref.lastY.toFixed(6) : "y"
  ].join(":");
}

function sameFirePointRef(left?: FirePointRef, right?: FirePointRef) {
  if (!left || !right) {
    return false;
  }

  return firePointRefKey(left) === firePointRefKey(right);
}

function shortFirePointLabel(label: string) {
  return label.length > 22 ? `${label.slice(0, 21)}...` : label;
}

function inferAffiliation(object: WTMapObject): Affiliation {
  if (object.icon === "Player") {
    return "friend";
  }

  const rgb = object["color[]"];
  if (rgb) {
    const [red, green, blue] = rgb;
    if (red > 180 && green < 90 && blue < 90) {
      return "hostile";
    }

    if (green > 150 && red < 150) {
      return "neutral";
    }

    if (blue > 150 && red < 150) {
      return "friend";
    }
  }

  const color = object.color?.toLowerCase() ?? "";
  if (color.includes("fa0") || color.includes("f00") || color.includes("red")) {
    return "hostile";
  }

  return "unknown";
}

function inferSymbolKind(object: WTMapObject): SymbolKind {
  const icon = (object.icon ?? "").toLowerCase();
  const type = (object.type ?? "").toLowerCase();
  const text = `${icon} ${type}`;

  if (icon === "player") {
    return "player";
  }

  if (text.includes("airdefence") || text.includes("airdefense") || text.includes("spaa")) {
    return "airDefense";
  }

  if (
    text.includes("aircraft") ||
    text.includes("fighter") ||
    text.includes("bomber") ||
    text.includes("helicopter") ||
    text.includes("plane") ||
    text.includes("drone")
  ) {
    return "aircraft";
  }

  if (text.includes("artillery") || text.includes("howitzer") || text.includes("mortar")) {
    return "artillery";
  }

  if (text.includes("tank") || text.includes("ground_model") || text.includes("armored")) {
    return "armor";
  }

  if (text.includes("capture") || text.includes("bombing") || text.includes("defending")) {
    return "objective";
  }

  if (text.includes("respawn")) {
    return "respawn";
  }

  if (text.includes("waypoint")) {
    return "waypoint";
  }

  if (text.includes("structure") || text.includes("airfield")) {
    return "installation";
  }

  return "unknown";
}

function isPointOfInterestObject(object: WTMapObject) {
  const text = `${object.icon ?? ""} ${object.type ?? ""}`.toLowerCase();
  return (
    text.includes("point_of_interest") ||
    text.includes("point of interest") ||
    text.includes("poi")
  );
}

function classifyObject(object: WTMapObject): Exclude<ObjectFilter, "all"> {
  const icon = (object.icon ?? "").toLowerCase();
  const type = (object.type ?? "").toLowerCase();
  const text = `${icon} ${type}`;

  if (text.includes("respawn")) {
    return "spawn";
  }

  if (
    text.includes("capture") ||
    text.includes("point_of_interest") ||
    text.includes("bombing") ||
    text.includes("defending") ||
    text.includes("waypoint")
  ) {
    return "objective";
  }

  if (
    text.includes("aircraft") ||
    text.includes("fighter") ||
    text.includes("bomber") ||
    text.includes("helicopter") ||
    text.includes("plane") ||
    text.includes("drone")
  ) {
    return "air";
  }

  if (
    text.includes("ground") ||
    text.includes("tank") ||
    text.includes("armored") ||
    text.includes("airdefence") ||
    text.includes("airdefense") ||
    text.includes("spaa") ||
    text.includes("artillery") ||
    text.includes("mortar") ||
    text.includes("howitzer")
  ) {
    return "ground";
  }

  return "other";
}

function objectMatchesFilters(object: WTMapObject, filters: Set<Exclude<ObjectFilter, "all">>) {
  return filters.has(classifyObject(object));
}

function formatActiveFilters(filters: Set<Exclude<ObjectFilter, "all">>) {
  if (filters.size === objectFilterOptions.length) {
    return "All classes";
  }

  if (filters.size === 0) {
    return "No classes";
  }

  return objectFilterOptions
    .filter((option) => filters.has(option.value))
    .map((option) => option.label)
    .join(", ");
}

function isLikelySquadmate(object: WTMapObject) {
  const rgb = object["color[]"];
  if (rgb) {
    const [red, green, blue] = rgb;
    if (red > 220 && green > 160 && green < 230 && blue < 80) {
      return true;
    }
  }

  return object.color?.toLowerCase() === "#fac81e";
}

function hasMapPoint(point: Pick<WTMapObject, "x" | "y"> | Pick<MapMarker, "x" | "y">) {
  return typeof point.x === "number" && typeof point.y === "number";
}

function sortObjectsByTacticalPriority(
  objects: WTMapObject[],
  mapInfo: WTMapInfo | undefined,
  distanceOrigin: FirePoint | undefined
) {
  return objects
    .map((object, index) => ({
      object,
      index,
      key: objectVisibilityKey(object, index),
      squadPriority: isLikelySquadmate(object) ? 0 : 1,
      distance: distanceOrigin
        ? distanceBetween(distanceOrigin, object, mapInfo) ?? Number.POSITIVE_INFINITY
        : Number.POSITIVE_INFINITY
    }))
    .sort((left, right) => {
      if (left.squadPriority !== right.squadPriority) {
        return left.squadPriority - right.squadPriority;
      }

      if (left.distance !== right.distance) {
        return left.distance - right.distance;
      }

      return left.index - right.index;
    });
}

function collectHostileObservations(objects: WTMapObject[]): TargetObservation[] {
  return objects
    .map((object, index) => ({ object, index }))
    .filter(({ object }) => inferAffiliation(object) === "hostile" && hasMapPoint(object))
    .map(({ object, index }) => ({
      fingerprint: targetFingerprint(object),
      label: objectLabel(object),
      x: object.x ?? 0,
      y: object.y ?? 0,
      objectKey: objectVisibilityKey(object, index),
      color: objectColor(object)
    }));
}

function predictTrackPoint(track: HostileTrack, at: number): TrackSample {
  const last = track.samples[track.samples.length - 1];
  if (!last) {
    return { x: 0, y: 0, at };
  }

  const elapsedSeconds = Math.max(0, (at - track.lastSeenAt) / 1000);
  return {
    x: clamp(last.x + track.velocityX * elapsedSeconds, 0, 1),
    y: clamp(last.y + track.velocityY * elapsedSeconds, 0, 1),
    at
  };
}

function deriveVelocity(samples: TrackSample[], fallback: Pick<HostileTrack, "velocityX" | "velocityY">) {
  const last = samples[samples.length - 1];
  const first = samples.find((sample) => last && last.at - sample.at >= 250) ?? samples[0];
  if (!first || !last || first.at === last.at) {
    return fallback;
  }

  const elapsedSeconds = (last.at - first.at) / 1000;
  return {
    velocityX: (last.x - first.x) / elapsedSeconds,
    velocityY: (last.y - first.y) / elapsedSeconds
  };
}

function appendTrackSample(track: HostileTrack, observation: TargetObservation, observedAt: number): HostileTrack {
  const sample = { x: observation.x, y: observation.y, at: observedAt };
  const previousSamples =
    track.samples[track.samples.length - 1]?.at === observedAt
      ? track.samples.slice(0, -1)
      : track.samples;
  const samples = [...previousSamples, sample].filter(
    (item) => observedAt - item.at <= HOSTILE_TRACK_HISTORY_MS
  );
  const velocity = deriveVelocity(samples, track);

  return {
    ...track,
    fingerprint: observation.fingerprint,
    label: observation.label,
    color: observation.color,
    lastSeenAt: observedAt,
    objectKey: observation.objectKey,
    samples,
    velocityX: velocity.velocityX,
    velocityY: velocity.velocityY
  };
}

function createHostileTrack(observation: TargetObservation, observedAt: number, ordinal: number): HostileTrack {
  return {
    id: `${observation.fingerprint}:${observedAt}:${ordinal}`,
    fingerprint: observation.fingerprint,
    label: observation.label,
    color: observation.color,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    objectKey: observation.objectKey,
    samples: [{ x: observation.x, y: observation.y, at: observedAt }],
    velocityX: 0,
    velocityY: 0
  };
}

function matchHostileTrack(
  observation: TargetObservation,
  tracks: HostileTrack[],
  usedTrackIds: Set<string>,
  observedAt: number
) {
  const candidates = tracks
    .filter((track) => track.fingerprint === observation.fingerprint && !usedTrackIds.has(track.id))
    .map((track) => {
      const predicted = predictTrackPoint(track, observedAt);
      const distance = Math.hypot(observation.x - predicted.x, observation.y - predicted.y);
      const elapsedSeconds = Math.max(0, (observedAt - track.lastSeenAt) / 1000);
      const speed = Math.hypot(track.velocityX, track.velocityY);
      const gate = 0.025 + Math.min(0.06, speed * elapsedSeconds * 1.8);

      return { track, distance, gate };
    })
    .filter(({ distance, gate }) => distance <= gate)
    .sort((left, right) => left.distance - right.distance);

  return candidates[0]?.track;
}

function updateHostileTracks(
  previousTracks: HostileTrack[],
  objects: WTMapObject[],
  observedAt: number
): HostileTrack[] {
  const observations = collectHostileObservations(objects);
  const usedTrackIds = new Set<string>();
  const nextTracks = new Map<string, HostileTrack>();

  observations.forEach((observation, index) => {
    const match = matchHostileTrack(observation, previousTracks, usedTrackIds, observedAt);
    if (match) {
      usedTrackIds.add(match.id);
      nextTracks.set(match.id, appendTrackSample(match, observation, observedAt));
      return;
    }

    const created = createHostileTrack(observation, observedAt, index);
    usedTrackIds.add(created.id);
    nextTracks.set(created.id, created);
  });

  previousTracks.forEach((track) => {
    if (usedTrackIds.has(track.id) || observedAt - track.lastSeenAt > HOSTILE_ROI_RETENTION_MS) {
      return;
    }

    nextTracks.set(track.id, {
      ...track,
      samples: track.samples.filter((sample) => observedAt - sample.at <= HOSTILE_TRACK_HISTORY_MS)
    });
  });

  return Array.from(nextTracks.values());
}

function objectMatchesRefSignature(
  ref: Extract<FirePointRef, { kind: "object" }>,
  object: WTMapObject
) {
  if (object.icon !== ref.icon || object.type !== ref.type || !hasMapPoint(object)) {
    return false;
  }

  return !ref.colorSignature || objectColorSignature(object) === ref.colorSignature;
}

function objectDistanceToRefAnchor(
  ref: Extract<FirePointRef, { kind: "object" }>,
  object: WTMapObject
) {
  if (!hasMapPoint(object)) {
    return Number.POSITIVE_INFINITY;
  }

  const anchors = [
    { x: ref.lastX, y: ref.lastY },
    { x: ref.initialX, y: ref.initialY }
  ].filter((anchor): anchor is { x: number; y: number } => (
    typeof anchor.x === "number" && typeof anchor.y === "number"
  ));

  if (anchors.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.min(
    ...anchors.map((anchor) => Math.hypot((object.x ?? 0) - anchor.x, (object.y ?? 0) - anchor.y))
  );
}

function objectRefHasAnchor(ref: Extract<FirePointRef, { kind: "object" }>) {
  return (
    (typeof ref.initialX === "number" && typeof ref.initialY === "number") ||
    (typeof ref.lastX === "number" && typeof ref.lastY === "number")
  );
}

function matchesObjectRef(ref: FirePointRef | undefined, object: WTMapObject, index: number) {
  if (!ref) {
    return false;
  }

  if (ref.kind === "poi") {
    return isPointOfInterestObject(object);
  }

  if (ref.kind !== "object") {
    return false;
  }

  if (ref.objectIndex === index && objectMatchesRefSignature(ref, object)) {
    return true;
  }

  if (!objectMatchesRefSignature(ref, object)) {
    return false;
  }

  if (
    typeof ref.initialX !== "number" &&
    typeof ref.initialY !== "number" &&
    typeof ref.lastX !== "number" &&
    typeof ref.lastY !== "number"
  ) {
    return true;
  }

  return objectDistanceToRefAnchor(ref, object) < 0.018;
}

function findObjectForRef(ref: Extract<FirePointRef, { kind: "object" }>, objects: WTMapObject[]) {
  const indexed = objects[ref.objectIndex];
  if (
    indexed &&
    objectMatchesRefSignature(ref, indexed) &&
    (!objectRefHasAnchor(ref) || objectDistanceToRefAnchor(ref, indexed) < 0.06)
  ) {
    return { object: indexed, index: ref.objectIndex };
  }

  const candidates = objects
    .map((object, index) => ({
      object,
      index,
      distance: objectDistanceToRefAnchor(ref, object)
    }))
    .filter(({ object }) => objectMatchesRefSignature(ref, object))
    .sort((left, right) => left.distance - right.distance);

  const closest = candidates[0];
  if (closest && (!objectRefHasAnchor(ref) || closest.distance < 0.06)) {
    return { object: closest.object, index: closest.index };
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveFirePoint(
  ref: FirePointRef | undefined,
  objects: WTMapObject[],
  markers: MapMarker[]
): FirePoint | undefined {
  if (!ref) {
    return undefined;
  }

  if (ref.kind === "marker") {
    const marker = markers.find((item) => item.id === ref.markerId);
    if (!marker || !hasMapPoint(marker)) {
      return undefined;
    }

    return {
      ref,
      label: marker.label,
      x: marker.x,
      y: marker.y,
      color: "#e7bf62"
    };
  }

  if (ref.kind === "poi") {
    const poi = objects.find((object) => isPointOfInterestObject(object) && hasMapPoint(object));
    if (!poi || typeof poi.x !== "number" || typeof poi.y !== "number") {
      return undefined;
    }

    return {
      ref,
      label: "point_of_interest",
      x: poi.x,
      y: poi.y,
      color: objectColor(poi)
    };
  }

  const match = ref.kind === "player" ? undefined : findObjectForRef(ref, objects);
  const object = ref.kind === "player" ? findPlayer(objects) : match?.object;
  if (!object || typeof object.x !== "number" || typeof object.y !== "number") {
    return undefined;
  }

  const resolvedRef = ref.kind === "object" && match ? objectRef(object, match.index, ref) : ref;

  return {
    ref: resolvedRef,
    label: ref.kind === "player" ? "Player" : ref.label,
    x: object.x,
    y: object.y,
    color: objectColor(object),
    objectIndex: ref.kind === "object" ? match?.index : undefined,
    objectKey: ref.kind === "object" && match ? objectVisibilityKey(object, match.index) : undefined
  };
}

function isObjectFirePoint(point: FirePoint | undefined, object: WTMapObject, index: number) {
  if (!point) {
    return false;
  }

  if (point.ref.kind === "player") {
    return object.icon === "Player";
  }

  if (point.ref.kind === "poi") {
    return isPointOfInterestObject(object);
  }

  if (point.ref.kind !== "object") {
    return false;
  }

  return point.objectIndex === index && objectMatchesRefSignature(point.ref, object);
}

function NatoFrame({
  affiliation,
  width,
  height
}: {
  affiliation: Affiliation;
  width: number;
  height: number;
}) {
  const theme = affiliationTheme[affiliation];
  const common = {
    fill: theme.fill,
    stroke: theme.ink,
    strokeWidth: 0.0022,
    vectorEffect: "non-scaling-stroke" as const
  };

  if (affiliation === "hostile") {
    return (
      <polygon
        points={`0,${-height * 0.75} ${width * 0.52},0 0,${height * 0.75} ${-width * 0.52},0`}
        {...common}
      />
    );
  }

  if (affiliation === "neutral") {
    return <rect x={-height / 2} y={-height / 2} width={height} height={height} {...common} />;
  }

  if (affiliation === "unknown") {
    const r = height * 0.34;
    return (
      <path
        d={[
          `M ${-r} ${-height * 0.5}`,
          `Q 0 ${-height * 0.75} ${r} ${-height * 0.5}`,
          `Q ${width * 0.5} ${-r} ${width * 0.5} 0`,
          `Q ${width * 0.5} ${r} ${r} ${height * 0.5}`,
          `Q 0 ${height * 0.75} ${-r} ${height * 0.5}`,
          `Q ${-width * 0.5} ${r} ${-width * 0.5} 0`,
          `Q ${-width * 0.5} ${-r} ${-r} ${-height * 0.5}`,
          "Z"
        ].join(" ")}
        {...common}
      />
    );
  }

  return <rect x={-width / 2} y={-height / 2} width={width} height={height} {...common} />;
}

function NatoIcon({
  kind,
  affiliation,
  width,
  height,
  heading
}: {
  kind: SymbolKind;
  affiliation: Affiliation;
  width: number;
  height: number;
  heading: number;
}) {
  const theme = affiliationTheme[affiliation];
  const stroke = theme.ink;
  const iconProps = {
    fill: "none",
    stroke,
    strokeWidth: 0.0024,
    vectorEffect: "non-scaling-stroke" as const,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  if (kind === "player") {
    return (
      <polygon
        points={`0,${-height * 0.42} ${width * 0.17},${height * 0.28} ${-width * 0.17},${height * 0.28}`}
        fill={theme.stroke}
        stroke={theme.ink}
        strokeWidth="0.0022"
        transform={`rotate(${heading})`}
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  if (kind === "armor") {
    return <ellipse cx="0" cy="0" rx={width * 0.18} ry={height * 0.19} {...iconProps} />;
  }

  if (kind === "airDefense") {
    return (
      <g {...iconProps}>
        <path d={`M ${-width * 0.2} ${height * 0.18} Q 0 ${-height * 0.35} ${width * 0.2} ${height * 0.18}`} />
        <line x1="0" y1={-height * 0.25} x2="0" y2={height * 0.22} />
      </g>
    );
  }

  if (kind === "aircraft") {
    return (
      <g {...iconProps} transform={`rotate(${heading})`}>
        <path d={`M 0 ${-height * 0.34} L ${width * 0.2} ${height * 0.2} L 0 ${height * 0.08} L ${-width * 0.2} ${height * 0.2} Z`} />
        <line x1="0" y1={height * 0.08} x2="0" y2={height * 0.32} />
      </g>
    );
  }

  if (kind === "artillery") {
    return (
      <circle
        cx="0"
        cy="0"
        r={height * 0.17}
        fill={theme.ink}
        stroke={theme.ink}
        strokeWidth="0.0016"
        vectorEffect="non-scaling-stroke"
      />
    );
  }

  if (kind === "installation") {
    return <rect x={-width * 0.14} y={-height * 0.18} width={width * 0.28} height={height * 0.36} {...iconProps} />;
  }

  if (kind === "objective") {
    return (
      <g {...iconProps}>
        <circle cx="0" cy="0" r={height * 0.2} />
        <line x1={-width * 0.2} y1="0" x2={width * 0.2} y2="0" />
        <line x1="0" y1={-height * 0.28} x2="0" y2={height * 0.28} />
      </g>
    );
  }

  if (kind === "respawn") {
    return <polygon points={`0,${-height * 0.28} ${width * 0.18},${height * 0.22} ${-width * 0.18},${height * 0.22}`} {...iconProps} />;
  }

  if (kind === "waypoint") {
    return (
      <g {...iconProps}>
        <line x1={-width * 0.08} y1={height * 0.28} x2={-width * 0.08} y2={-height * 0.28} />
        <path d={`M ${-width * 0.08} ${-height * 0.28} L ${width * 0.17} ${-height * 0.18} L ${-width * 0.08} ${-height * 0.06}`} />
      </g>
    );
  }

  return (
    <g {...iconProps}>
      <line x1={-width * 0.14} y1={-height * 0.18} x2={width * 0.14} y2={height * 0.18} />
      <line x1={width * 0.14} y1={-height * 0.18} x2={-width * 0.14} y2={height * 0.18} />
    </g>
  );
}

const NatoMapSymbol = memo(function NatoMapSymbol({
  object,
  index,
  view,
  isFireSource,
  isFireTarget
}: {
  object: WTMapObject;
  index: number;
  view: MapView;
  isFireSource?: boolean;
  isFireTarget?: boolean;
}) {
  if (typeof object.x !== "number" || typeof object.y !== "number") {
    return null;
  }

  const screen = mapToScreenPoint(object, view);
  if (!screen || screen.x < -0.08 || screen.x > 1.08 || screen.y < -0.08 || screen.y > 1.08) {
    return null;
  }

  const affiliation = inferAffiliation(object);
  const kind = inferSymbolKind(object);
  const isPlayer = kind === "player";
  const width = isPlayer ? 0.034 : 0.026;
  const height = isPlayer ? 0.025 : 0.019;
  const heading =
    typeof object.dx === "number" && typeof object.dy === "number"
      ? (Math.atan2(object.dx, -object.dy) * 180) / Math.PI
      : 0;
  const symbolClassName = [
    "map-symbol",
    isFireSource ? "fire-source-symbol" : "",
    isFireTarget ? "fire-target-symbol" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g
      key={`${objectLabel(object)}-${index}`}
      className={symbolClassName}
      transform={`translate(${screen.x} ${screen.y})`}
      aria-label={`${affiliationTheme[affiliation].label} ${objectLabel(object)}`}
    >
      {(isFireSource || isFireTarget) && (
        <>
          <circle
            r={isFireSource ? "0.027" : "0.024"}
            className={isFireSource ? "fire-source-ring" : "fire-target-ring"}
            vectorEffect="non-scaling-stroke"
          />
          <g className={isFireSource ? "fire-role-label source" : "fire-role-label target"}>
            <circle cx="0.024" cy="-0.024" r="0.01" vectorEffect="non-scaling-stroke" />
            <text x="0.024" y="-0.0205">
              {isFireSource ? "S" : "T"}
            </text>
          </g>
        </>
      )}
      <NatoFrame affiliation={affiliation} width={width} height={height} />
      <NatoIcon
        kind={kind}
        affiliation={affiliation}
        width={width}
        height={height}
        heading={heading}
      />
    </g>
  );
});

const HostileTrackOverlay = memo(function HostileTrackOverlay({
  track,
  view,
  now
}: {
  track: HostileTrack;
  view: MapView;
  now: number;
}) {
  const visibleSamples = track.samples
    .filter((sample) => now - sample.at <= HOSTILE_TRACK_HISTORY_MS)
    .flatMap((sample) => {
      const screen = mapToScreenPoint(sample, view);
      return screen ? [{ ...sample, screen }] : [];
    });
  const lastSample = track.samples[track.samples.length - 1];
  const isObserved = now - track.lastSeenAt <= 650;

  if (!lastSample) {
    return null;
  }

  if (isObserved) {
    const points = visibleSamples.map((sample) => `${sample.screen.x},${sample.screen.y}`).join(" ");
    return (
      <g className="hostile-track-layer" aria-label={`${track.label} hostile track`}>
        {visibleSamples.length > 1 && (
          <polyline className="hostile-track-line" points={points} vectorEffect="non-scaling-stroke" />
        )}
        {visibleSamples.map((sample, index) => (
          <circle
            key={`${track.id}-sample-${sample.at}-${index}`}
            cx={sample.screen.x}
            cy={sample.screen.y}
            r={index === visibleSamples.length - 1 ? "0.0042" : "0.0028"}
            className="hostile-track-dot"
            opacity={clamp(1 - (now - sample.at) / HOSTILE_TRACK_HISTORY_MS, 0.25, 1)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
    );
  }

  const predicted = predictTrackPoint(track, now);
  const predictedScreen = mapToScreenPoint(predicted, view);
  const lastScreen = mapToScreenPoint(lastSample, view);
  if (!predictedScreen) {
    return null;
  }

  const lostMs = now - track.lastSeenAt;
  const retentionRatio = clamp(lostMs / HOSTILE_ROI_RETENTION_MS, 0, 1);
  const uncertaintyRadius = 0.018 + retentionRatio * 0.045;
  const opacity = clamp(1 - retentionRatio, 0.18, 0.78);

  return (
    <g className="hostile-roi-layer" opacity={opacity} aria-label={`${track.label} predicted interest area`}>
      {lastScreen && (
        <line
          x1={lastScreen.x}
          y1={lastScreen.y}
          x2={predictedScreen.x}
          y2={predictedScreen.y}
          className="hostile-prediction-line"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <circle
        cx={predictedScreen.x}
        cy={predictedScreen.y}
        r={uncertaintyRadius}
        className="hostile-roi-ring"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={predictedScreen.x}
        cy={predictedScreen.y}
        r="0.004"
        className="hostile-roi-center"
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={predictedScreen.x}
        y={predictedScreen.y + uncertaintyRadius + 0.018}
        className="hostile-roi-label"
      >
        ROI {Math.max(0, Math.ceil((HOSTILE_ROI_RETENTION_MS - lostMs) / 1000))}s
      </text>
    </g>
  );
});

function MapSurface({
  mapInfo,
  objects,
  hostileTracks,
  trackNow,
  markers,
  activeMarker,
  sourcePoint,
  targetPoint,
  hiddenObjectKeys,
  setSourceRef,
  setTargetRef,
  setMapTarget
}: {
  mapInfo?: WTMapInfo;
  objects: WTMapObject[];
  hostileTracks: HostileTrack[];
  trackNow: number;
  markers: MapMarker[];
  activeMarker?: MapMarker;
  sourcePoint?: FirePoint;
  targetPoint?: FirePoint;
  hiddenObjectKeys: Set<string>;
  setSourceRef: (ref: FirePointRef) => void;
  setTargetRef: (ref: FirePointRef) => void;
  setMapTarget: (point: Pick<MapMarker, "x" | "y">) => void;
}) {
  const imageUrl = getMapImageUrl(mapInfo);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [view, setView] = useState<MapView>({ zoom: 1, panX: 0, panY: 0 });
  const [selection, setSelection] = useState<MapSelection | undefined>();
  const sourceScreen = mapToScreenPoint(sourcePoint, view);
  const targetScreen = mapToScreenPoint(targetPoint, view);
  const visibleObjects = useMemo(
    () =>
      objects
        .map((object, index) => ({ object, index, key: objectVisibilityKey(object, index) }))
        .filter(({ key }) => !hiddenObjectKeys.has(key)),
    [objects, hiddenObjectKeys]
  );

  function stagePointToMapPoint(clientX: number, clientY: number) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) {
      return undefined;
    }

    const stageX = (clientX - rect.left) / rect.width;
    const stageY = (clientY - rect.top) / rect.height;
    const x = (stageX - view.panX) / view.zoom;
    const y = (stageY - view.panY) / view.zoom;

    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return undefined;
    }

    return { x, y };
  }

  function findObjectAtPoint(point: { x: number; y: number }) {
    const hitRadius = 0.026 / view.zoom;
    const hitRadiusSquared = hitRadius * hitRadius;

    return visibleObjects
      .filter(
        ({ object }) =>
          hasMapPoint(object) &&
          pointDistanceSquared(object, point) <= hitRadiusSquared
      )
      .sort(
        (left, right) =>
          pointDistanceSquared(left.object, point) - pointDistanceSquared(right.object, point)
      )[0];
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originPanX: view.panX,
      originPanY: view.panY,
      moved: false
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect || view.zoom <= 1) {
      return;
    }

    const deltaX = (event.clientX - drag.startX) / rect.width;
    const deltaY = (event.clientY - drag.startY) / rect.height;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    drag.moved = drag.moved || moved;

    setView(
      clampMapView({
        zoom: view.zoom,
        panX: drag.originPanX + deltaX,
        panY: drag.originPanY + deltaY
      })
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    if (!drag.moved) {
      const point = stagePointToMapPoint(event.clientX, event.clientY);
      if (!point) {
        setSelection(undefined);
        return;
      }

      const hit = findObjectAtPoint(point);
      if (hit) {
        setSelection({
          kind: "object",
          object: hit.object,
          index: hit.index,
          x: point.x,
          y: point.y
        });
        return;
      }

      setSelection({
        kind: "point",
        x: point.x,
        y: point.y
      });
    }
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const anchorX = (event.clientX - rect.left) / rect.width;
    const anchorY = (event.clientY - rect.top) / rect.height;
    const direction = event.deltaY > 0 ? -1 : 1;

    setView((current) =>
      zoomAround(current, current.zoom + direction * ZOOM_STEP, anchorX, anchorY)
    );
  }

  function setZoom(nextZoom: number) {
    setView((current) => zoomAround(current, nextZoom));
  }

  return (
    <section className="map-workspace" aria-label="Map workspace">
      <div className="map-header">
        <div className="section-title">
          <MapPinned size={18} />
          Live Tactical Map
        </div>
        <div className="map-badges">
          <span>{mapInfo?.valid ? "MAP VALID" : "MAP WAIT"}</span>
          <span>GEN {mapInfo?.map_generation ?? "--"}</span>
          <span>{objects.length} OBJ</span>
        </div>
        <div className="zoom-controls" aria-label="Map zoom controls">
          <button
            className="map-control"
            type="button"
            title="Zoom out"
            onClick={() => setZoom(view.zoom - ZOOM_STEP)}
          >
            <ZoomOut size={16} />
          </button>
          <span>{Math.round(view.zoom * 100)}%</span>
          <button
            className="map-control"
            type="button"
            title="Zoom in"
            onClick={() => setZoom(view.zoom + ZOOM_STEP)}
          >
            <ZoomIn size={16} />
          </button>
          <button
            className="map-control"
            type="button"
            title="Reset view"
            onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="map-stage"
        role="button"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onWheel={handleWheel}
      >
        <div
          className="map-viewport"
          style={{
            transform: `translate(${view.panX * 100}%, ${view.panY * 100}%) scale(${view.zoom})`
          }}
        >
          <img className="map-image" src={imageUrl} alt="" draggable={false} />
          <svg className="map-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
            {GRID_LINES.map((line) => (
              <g key={line}>
                <line x1={line} y1={0} x2={line} y2={1} className="grid-line" />
                <line x1={0} y1={line} x2={1} y2={line} className="grid-line" />
              </g>
            ))}
          </svg>
        </div>
        <svg className="symbol-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
          {hostileTracks.map((track) => (
            <HostileTrackOverlay key={track.id} track={track} view={view} now={trackNow} />
          ))}

          {visibleObjects.map(({ object, index, key }) => (
            <NatoMapSymbol
              key={key}
              object={object}
              index={index}
              view={view}
              isFireSource={isObjectFirePoint(sourcePoint, object, index)}
              isFireTarget={isObjectFirePoint(targetPoint, object, index)}
            />
          ))}

          {sourceScreen && targetScreen && (
            <line
              x1={sourceScreen.x}
              y1={sourceScreen.y}
              x2={targetScreen.x}
              y2={targetScreen.y}
              className="range-line"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {markers.map((marker, index) => {
            const isActive = marker.id === activeMarker?.id;
            const screen = mapToScreenPoint(marker, view);
            if (!screen) {
              return null;
            }

            return (
              <g
                key={marker.id}
                className={sameFirePointRef(sourcePoint?.ref, markerRef(marker)) ? "fire-source-symbol" : undefined}
                transform={`translate(${screen.x} ${screen.y})`}
              >
                {(sameFirePointRef(sourcePoint?.ref, markerRef(marker)) ||
                  sameFirePointRef(targetPoint?.ref, markerRef(marker))) && (
                  <circle
                    r={sameFirePointRef(sourcePoint?.ref, markerRef(marker)) ? "0.023" : "0.021"}
                    className={
                      sameFirePointRef(sourcePoint?.ref, markerRef(marker))
                        ? "fire-source-ring"
                        : "fire-target-ring"
                    }
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                <circle
                  r={isActive ? "0.014" : "0.011"}
                  className={isActive ? "marker-ring active" : "marker-ring"}
                  vectorEffect="non-scaling-stroke"
                />
                <circle r="0.0035" className="marker-dot" vectorEffect="non-scaling-stroke" />
                <line x1="-0.021" x2="-0.008" y1="0" y2="0" className="marker-cross" />
                <line x1="0.008" x2="0.021" y1="0" y2="0" className="marker-cross" />
                <line x1="0" x2="0" y1="-0.021" y2="-0.008" className="marker-cross" />
                <line x1="0" x2="0" y1="0.008" y2="0.021" className="marker-cross" />
                <g className="marker-badge" transform="translate(0.022 -0.022)">
                  <rect x="-0.011" y="-0.01" width="0.022" height="0.02" rx="0.004" />
                  <text x="0" y="0.005">
                    {index + 1}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        {selection && (
          <div
            className="map-selection-menu"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            style={{
              left: `${clamp(view.panX + selection.x * view.zoom, 0.04, 0.84) * 100}%`,
              top: `${clamp(view.panY + selection.y * view.zoom, 0.05, 0.84) * 100}%`
            }}
          >
            <div className="selection-title">
              {selection.kind === "object" ? objectLabel(selection.object) : "Attack Position"}
            </div>
            {selection.kind === "point" && (
              <div className="selection-subtitle">{formatWorldPoint(selection, mapInfo)}</div>
            )}
            <div className="selection-actions">
              {selection.kind === "object" && (
                <button
                  type="button"
                  onClick={() => {
                    setSourceRef(objectRef(selection.object, selection.index));
                    setSelection(undefined);
                  }}
                >
                  Set Source
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (selection.kind === "object") {
                    setTargetRef(objectRef(selection.object, selection.index));
                  } else {
                    setMapTarget(selection);
                  }
                  setSelection(undefined);
                }}
              >
                Set Target
              </button>
              <button
                className="selection-cancel"
                type="button"
                onClick={() => setSelection(undefined)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ToolPanel({
  mapInfo,
  objects,
  markers,
  activeMarker,
  sourcePoint,
  targetPoint,
  objectFilters,
  hiddenObjectKeys,
  filterMenuOpen,
  setFilterMenuOpen,
  toggleObjectFilter,
  setAllObjectFilters,
  toggleObjectVisibility,
  setSourceRef,
  setTargetRef,
  clearMarkers
}: {
  mapInfo?: WTMapInfo;
  objects: WTMapObject[];
  markers: MapMarker[];
  activeMarker?: MapMarker;
  sourcePoint?: FirePoint;
  targetPoint?: FirePoint;
  objectFilters: Set<Exclude<ObjectFilter, "all">>;
  hiddenObjectKeys: Set<string>;
  filterMenuOpen: boolean;
  setFilterMenuOpen: (open: boolean) => void;
  toggleObjectFilter: (filter: Exclude<ObjectFilter, "all">) => void;
  setAllObjectFilters: (enabled: boolean) => void;
  toggleObjectVisibility: (key: string) => void;
  setSourceRef: (ref: FirePointRef) => void;
  setTargetRef: (ref: FirePointRef) => void;
  clearMarkers: () => void;
}) {
  const player = useMemo(() => findPlayer(objects), [objects]);
  const range = useMemo(
    () => (sourcePoint && targetPoint ? distanceBetween(sourcePoint, targetPoint, mapInfo) : undefined),
    [sourcePoint, targetPoint, mapInfo]
  );
  const bearing = useMemo(
    () => (sourcePoint && targetPoint ? bearingBetween(sourcePoint, targetPoint) : undefined),
    [sourcePoint, targetPoint]
  );
  const targetObjectCount = useMemo(
    () => objects.reduce((count, object) => count + (object.icon === "Player" ? 0 : 1), 0),
    [objects]
  );
  const visibleObjectCount = useMemo(
    () =>
      objects.reduce(
        (count, object, index) =>
          count + (hiddenObjectKeys.has(objectVisibilityKey(object, index)) ? 0 : 1),
        0
      ),
    [objects, hiddenObjectKeys]
  );
  const distanceOrigin = useMemo(
    () => sourcePoint ?? (player ? resolveFirePoint({ kind: "player" }, objects, markers) : undefined),
    [sourcePoint, player, objects, markers]
  );
  const sortedObjects = useMemo(
    () => sortObjectsByTacticalPriority(objects, mapInfo, distanceOrigin),
    [objects, mapInfo, distanceOrigin]
  );
  const filteredObjects = useMemo(
    () => sortedObjects.filter(({ object }) => objectMatchesFilters(object, objectFilters)),
    [sortedObjects, objectFilters]
  );
  const hasPointOfInterest = useMemo(
    () => objects.some((object) => isPointOfInterestObject(object) && hasMapPoint(object)),
    [objects]
  );

  return (
    <aside className="tool-panel">
      <section className="panel-block">
        <div className="section-title">
          <Ruler size={18} />
          Fire Mission
        </div>
        <div className="metric-grid">
          <span>Range</span>
          <strong>{range === undefined ? "--" : `${range.toFixed(0)} u`}</strong>
          <span>Bearing</span>
          <strong>{bearing === undefined ? "--" : `${bearing.toFixed(1)} deg`}</strong>
          <span>Source</span>
          <strong>{sourcePoint ? shortFirePointLabel(sourcePoint.label) : "--"}</strong>
          <span>Target</span>
          <strong>{targetPoint ? shortFirePointLabel(targetPoint.label) : "--"}</strong>
          <span>Source Pos</span>
          <strong>{formatWorldPoint(sourcePoint, mapInfo)}</strong>
          <span>Target Pos</span>
          <strong>{formatWorldPoint(targetPoint, mapInfo)}</strong>
        </div>
        <div className="tool-actions">
          <button className="icon-button" type="button" onClick={clearMarkers} title="Clear markers">
            <Eraser size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => {
              if (activeMarker) {
                setTargetRef(markerRef(activeMarker));
              }
            }}
            disabled={!activeMarker}
            title="Use latest marker as target"
          >
            <Target size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => setTargetRef({ kind: "poi" })}
            disabled={!hasPointOfInterest}
            title="Track point_of_interest as target"
          >
            <Focus size={18} />
          </button>
          <span>{activeMarker ? "Latest marker ready" : "Click a unit to select it"}</span>
        </div>
        <div className="quick-selects">
          <button
            className={sameFirePointRef(sourcePoint?.ref, { kind: "player" }) ? "choice-button selected" : "choice-button"}
            type="button"
            onClick={() => setSourceRef({ kind: "player" })}
            disabled={!player}
          >
            Player as source
          </button>
          <button
            className={sameFirePointRef(targetPoint?.ref, { kind: "poi" }) ? "choice-button selected" : "choice-button"}
            type="button"
            onClick={() => setTargetRef({ kind: "poi" })}
            disabled={!hasPointOfInterest}
          >
            Track POI
          </button>
        </div>
      </section>

      <section className="panel-block">
        <div className="section-title">
          <Crosshair size={18} />
          Map Objects
        </div>
        <div className="object-summary">
          <div>
            <strong>{objects.length}</strong>
            <span>Total</span>
          </div>
          <div>
            <strong>{targetObjectCount}</strong>
            <span>Targets</span>
          </div>
          <div>
            <strong>{markers.length}</strong>
            <span>Markers</span>
          </div>
          <div>
            <strong>{visibleObjectCount}</strong>
            <span>Shown</span>
          </div>
          <div>
            <strong>{filteredObjects.length}</strong>
            <span>Filtered</span>
          </div>
        </div>
        <div className="object-menu-bar">
          <span>{formatActiveFilters(objectFilters)}</span>
          <button
            className="icon-button compact"
            type="button"
            title="Object filters"
            onClick={() => setFilterMenuOpen(!filterMenuOpen)}
          >
            <MoreHorizontal size={18} />
          </button>
          {filterMenuOpen && (
            <div className="filter-menu">
              <div className="filter-menu-title">Display Classes</div>
              <label className="filter-option">
                <input
                  type="checkbox"
                  checked={objectFilters.size === objectFilterOptions.length}
                  onChange={(event) => setAllObjectFilters(event.currentTarget.checked)}
                />
                <span>All classes</span>
              </label>
              {objectFilterOptions.map((option) => (
                <label className="filter-option" key={option.value}>
                  <input
                    type="checkbox"
                    checked={objectFilters.has(option.value)}
                    onChange={() => toggleObjectFilter(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="object-list-head">
          <span>Unit</span>
          <span>Coord</span>
          <span>Show</span>
          <span>S/T</span>
        </div>
        {markers.length > 0 && (
          <div className="marker-list">
            {markers.map((marker, index) => (
              <div className="object-row marker-row" key={marker.id}>
                <span className="object-dot marker-dot-swatch" />
                <span>{marker.label} {index + 1}</span>
                <strong>{formatWorldPoint(marker, mapInfo)}</strong>
                <div className="object-actions">
                  <button
                    type="button"
                    className={
                      sameFirePointRef(sourcePoint?.ref, markerRef(marker))
                        ? "mini-action selected"
                        : "mini-action"
                    }
                    onClick={() => setSourceRef(markerRef(marker))}
                    title="Set marker as fire source"
                  >
                    S
                  </button>
                  <button
                    type="button"
                    className={
                      sameFirePointRef(targetPoint?.ref, markerRef(marker))
                        ? "mini-action selected"
                        : "mini-action"
                    }
                    onClick={() => setTargetRef(markerRef(marker))}
                    title="Set marker as target"
                  >
                    T
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="object-list">
          {filteredObjects.map(({ object, index, key }) => {
            const isVisible = !hiddenObjectKeys.has(key);
            const isSource = isObjectFirePoint(sourcePoint, object, index);
            const isTarget = isObjectFirePoint(targetPoint, object, index);
            const rowClassName = [
              "object-row",
              !isVisible ? "hidden-object" : "",
              isSource ? "selected-source-row" : "",
              isTarget ? "selected-target-row" : ""
            ]
              .filter(Boolean)
              .join(" ");

            return (
            <div className={rowClassName} key={key}>
              <span className="object-dot" style={{ background: objectColor(object) }} />
              <span>{objectLabel(object)}</span>
              <strong>
                {typeof object.x === "number" && typeof object.y === "number"
                  ? `${(object.x * 100).toFixed(1)}, ${(object.y * 100).toFixed(1)}`
                  : "--"}
              </strong>
              <button
                type="button"
                className={isVisible ? "visibility-button" : "visibility-button hidden"}
                onClick={() => toggleObjectVisibility(key)}
                title={isVisible ? "Hide object" : "Show object"}
              >
                {isVisible ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
              <div className="object-actions">
                <button
                  type="button"
                  className={isSource ? "mini-action selected source" : "mini-action"}
                  onClick={() => setSourceRef(objectRef(object, index))}
                  disabled={!hasMapPoint(object)}
                  title="Set as fire source"
                >
                  S
                </button>
                <button
                  type="button"
                  className={isTarget ? "mini-action selected target" : "mini-action"}
                  onClick={() => setTargetRef(objectRef(object, index))}
                  disabled={!hasMapPoint(object)}
                  title="Set as target"
                >
                  T
                </button>
              </div>
            </div>
            );
          })}
        </div>
      </section>

      <section className="panel-block">
        <div className="section-title">
          <Waypoints size={18} />
          Map Metadata
        </div>
        <div className="metric-grid">
          <span>Bounds</span>
          <strong>
            {mapInfo?.map_max ? `${formatNumber(mapInfo.map_max[0])} x ${formatNumber(mapInfo.map_max[1])}` : "--"}
          </strong>
          <span>Grid Step</span>
          <strong>
            {mapInfo?.grid_steps
              ? `${formatNumber(mapInfo.grid_steps[0])}, ${formatNumber(mapInfo.grid_steps[1])}`
              : "--"}
          </strong>
          <span>Grid Zero</span>
          <strong>
            {mapInfo?.grid_zero
              ? `${formatNumber(mapInfo.grid_zero[0])}, ${formatNumber(mapInfo.grid_zero[1])}`
              : "--"}
          </strong>
          <span>HUD Type</span>
          <strong>{formatNumber(mapInfo?.hud_type)}</strong>
        </div>
      </section>
    </aside>
  );
}

function AirTacticalPanel({
  mapInfo,
  objects,
  hiddenObjectKeys,
  toggleObjectVisibility
}: {
  mapInfo?: WTMapInfo;
  objects: WTMapObject[];
  hiddenObjectKeys: Set<string>;
  toggleObjectVisibility: (key: string) => void;
}) {
  const player = useMemo(() => findPlayer(objects), [objects]);
  const airObjects = useMemo(
    () =>
      sortObjectsByTacticalPriority(
        objects,
        mapInfo,
        player
          ? {
              ref: { kind: "player" },
              label: "Player",
              x: player.x ?? 0,
              y: player.y ?? 0,
              color: objectColor(player)
            }
          : undefined
      ).filter(({ object }) => classifyObject(object) === "air"),
    [objects, mapInfo, player]
  );
  const hostileAir = useMemo(
    () => airObjects.filter(({ object }) => inferAffiliation(object) === "hostile"),
    [airObjects]
  );
  const friendlyAir = useMemo(
    () => airObjects.filter(({ object }) => inferAffiliation(object) === "friend"),
    [airObjects]
  );
  const nearestHostile = hostileAir[0];
  const nearestHostileRange =
    player && nearestHostile
      ? distanceBetween(player, nearestHostile.object, mapInfo)
      : undefined;
  const nearestHostileBearing =
    player && nearestHostile ? bearingBetween(player, nearestHostile.object) : undefined;

  return (
    <aside className="tool-panel air-panel">
      <section className="panel-block">
        <div className="section-title">
          <Plane size={18} />
          Air Picture
        </div>
        <div className="object-summary air-summary">
          <div>
            <strong>{airObjects.length}</strong>
            <span>Air Tracks</span>
          </div>
          <div>
            <strong>{hostileAir.length}</strong>
            <span>Hostile</span>
          </div>
          <div>
            <strong>{friendlyAir.length}</strong>
            <span>Friendly</span>
          </div>
          <div>
            <strong>{nearestHostileRange === undefined ? "--" : nearestHostileRange.toFixed(0)}</strong>
            <span>Nearest Range</span>
          </div>
        </div>
        <div className="metric-grid">
          <span>Nearest Hostile</span>
          <strong>{nearestHostile ? objectLabel(nearestHostile.object) : "--"}</strong>
          <span>Bearing</span>
          <strong>{nearestHostileBearing === undefined ? "--" : `${nearestHostileBearing.toFixed(1)} deg`}</strong>
          <span>Player Pos</span>
          <strong>{formatWorldPoint(player, mapInfo)}</strong>
          <span>Fusion Mode</span>
          <strong>8111 local demo</strong>
        </div>
      </section>

      <section className="panel-block air-track-block">
        <div className="section-title">
          <Shield size={18} />
          Air Track Demo
        </div>
        <div className="air-track-head">
          <span>Track</span>
          <span>Side</span>
          <span>Range</span>
          <span>Show</span>
        </div>
        <div className="air-track-list">
          {airObjects.length === 0 && (
            <div className="empty-state">No aircraft-class objects in current 8111 map data.</div>
          )}
          {airObjects.map(({ object, index, key }) => {
            const affiliation = inferAffiliation(object);
            const range =
              player && hasMapPoint(object)
                ? distanceBetween(player, object, mapInfo)
                : undefined;
            const isVisible = !hiddenObjectKeys.has(key);

            return (
              <div className={`air-track-row ${affiliation}`} key={key}>
                <span className="object-dot" style={{ background: objectColor(object) }} />
                <span>{objectLabel(object)}</span>
                <strong>{affiliationTheme[affiliation].label}</strong>
                <strong>{range === undefined ? "--" : range.toFixed(0)}</strong>
                <button
                  type="button"
                  className={isVisible ? "visibility-button" : "visibility-button hidden"}
                  onClick={() => toggleObjectVisibility(objectVisibilityKey(object, index))}
                  title={isVisible ? "Hide track" : "Show track"}
                >
                  {isVisible ? <Eye size={15} /> : <EyeOff size={15} />}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel-block">
        <div className="section-title">
          <RadioTower size={18} />
          Cloud Path
        </div>
        <div className="split-notes">
          <div>
            <strong>Viewer</strong>
            <span>Next step: subscribe to cloud FusedSnapshot.</span>
          </div>
          <div>
            <strong>ROI</strong>
            <span>Render server ellipses for aircraft-only lost tracks.</span>
          </div>
        </div>
      </section>
    </aside>
  );
}

export default function App() {
  const mapData = useWT8111Map();
  const [mode, setMode] = useState<WorkbenchMode>("ground");
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [objectFilters, setObjectFilters] = useState<Set<Exclude<ObjectFilter, "all">>>(
    () => new Set(objectFilterOptions.map((option) => option.value))
  );
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [hiddenObjectKeys, setHiddenObjectKeys] = useState<Set<string>>(() => new Set());
  const [sourceRef, setSourceRef] = useState<FirePointRef>({ kind: "player" });
  const [targetRef, setTargetRef] = useState<FirePointRef | undefined>();
  const [hostileTracks, setHostileTracks] = useState<HostileTrack[]>([]);
  const [trackNow, setTrackNow] = useState(() => Date.now());
  const activeMarker = markers[markers.length - 1];
  const objects = mapData.ok ? mapData.mapObjects ?? EMPTY_MAP_OBJECTS : EMPTY_MAP_OBJECTS;

  const statusText = mapData.ok ? "8111 Map Online" : "8111 Map Offline";
  const lastUpdate = mapData.updatedAt
    ? new Date(mapData.updatedAt).toLocaleTimeString()
    : "--";

  const player = useMemo(() => findPlayer(objects), [objects]);
  const modeTitle = mode === "ground" ? "Ground Fire Workbench" : "Air Tactical Workbench";
  const sourcePoint = useMemo(
    () => resolveFirePoint(sourceRef, objects, markers),
    [sourceRef, objects, markers]
  );
  const targetPoint = useMemo(
    () => resolveFirePoint(targetRef, objects, markers),
    [targetRef, objects, markers]
  );

  useEffect(() => {
    if (sourceRef.kind === "object" && sourcePoint?.ref.kind === "object") {
      if (firePointRefKey(sourceRef) !== firePointRefKey(sourcePoint.ref)) {
        setSourceRef(sourcePoint.ref);
      }
    }
  }, [sourceRef, sourcePoint]);

  useEffect(() => {
    if (targetRef?.kind === "object" && targetPoint?.ref.kind === "object") {
      if (firePointRefKey(targetRef) !== firePointRefKey(targetPoint.ref)) {
        setTargetRef(targetPoint.ref);
      }
    }
  }, [targetRef, targetPoint]);

  useEffect(() => {
    if (!mapData.updatedAt) {
      return;
    }

    setTrackNow(mapData.updatedAt);
    setHostileTracks((previous) => updateHostileTracks(previous, objects, mapData.updatedAt));
  }, [objects, mapData.updatedAt]);

  function clearMarkers() {
    setMarkers([]);
    if (targetRef?.kind === "marker") {
      setTargetRef(undefined);
    }
    if (sourceRef.kind === "marker") {
      setSourceRef({ kind: "player" });
    }
  }

  function toggleObjectVisibility(key: string) {
    setHiddenObjectKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function toggleObjectFilter(filter: Exclude<ObjectFilter, "all">) {
    setObjectFilters((previous) => {
      const next = new Set(previous);
      if (next.has(filter)) {
        next.delete(filter);
      } else {
        next.add(filter);
      }

      return next;
    });
  }

  function setAllObjectFilters(enabled: boolean) {
    setObjectFilters(enabled ? new Set(objectFilterOptions.map((option) => option.value)) : new Set());
  }

  function setMapTarget(point: Pick<MapMarker, "x" | "y">) {
    const marker: MapMarker = {
      id: Date.now(),
      label: "Target",
      x: point.x,
      y: point.y
    };

    setMarkers((previous) => [...previous, marker]);
    setTargetRef(markerRef(marker));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="eyebrow">WT 8111 Neo</div>
          <h1>{modeTitle}</h1>
        </div>
        <div className="status-group">
          <div className="mode-switch" aria-label="GUI mode">
            <button
              type="button"
              className={mode === "ground" ? "active" : ""}
              onClick={() => setMode("ground")}
            >
              <Shield size={16} />
              Ground
            </button>
            <button
              type="button"
              className={mode === "air" ? "active" : ""}
              onClick={() => setMode("air")}
            >
              <Plane size={16} />
              Air
            </button>
          </div>
          <div className={`status-pill ${mapData.ok ? "online" : "offline"}`}>
            <Activity size={16} />
            {statusText}
          </div>
          <div className="status-pill neutral">
            <RadioTower size={16} />
            {lastUpdate}
          </div>
          <div className="status-pill neutral">
            <LocateFixed size={16} />
            {player ? "Player Locked" : "No Player"}
          </div>
        </div>
      </header>

      <section className="map-layout">
        <MapSurface
          mapInfo={mapData.mapInfo}
          objects={objects}
          hostileTracks={hostileTracks}
          trackNow={trackNow}
          markers={markers}
          activeMarker={activeMarker}
          sourcePoint={sourcePoint}
          targetPoint={targetPoint}
          hiddenObjectKeys={hiddenObjectKeys}
          setSourceRef={setSourceRef}
          setTargetRef={setTargetRef}
          setMapTarget={setMapTarget}
        />
        {mode === "ground" ? (
          <ToolPanel
            mapInfo={mapData.mapInfo}
            objects={objects}
            markers={markers}
            activeMarker={activeMarker}
            sourcePoint={sourcePoint}
            targetPoint={targetPoint}
            objectFilters={objectFilters}
            hiddenObjectKeys={hiddenObjectKeys}
            filterMenuOpen={filterMenuOpen}
            setFilterMenuOpen={setFilterMenuOpen}
            toggleObjectFilter={toggleObjectFilter}
            setAllObjectFilters={setAllObjectFilters}
            toggleObjectVisibility={toggleObjectVisibility}
            setSourceRef={setSourceRef}
            setTargetRef={setTargetRef}
            clearMarkers={clearMarkers}
          />
        ) : (
          <AirTacticalPanel
            mapInfo={mapData.mapInfo}
            objects={objects}
            hiddenObjectKeys={hiddenObjectKeys}
            toggleObjectVisibility={toggleObjectVisibility}
          />
        )}
      </section>

      {!mapData.ok && (
        <div className="offline-banner">
          <MousePointer2 size={16} />
          {mapData.error ?? "Waiting for War Thunder 8111 map data"}
        </div>
      )}
    </main>
  );
}
