import {
  Activity,
  Crosshair,
  Eraser,
  LocateFixed,
  MapPinned,
  MousePointer2,
  RadioTower,
  RotateCcw,
  Ruler,
  Target,
  Waypoints,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
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

type Affiliation = "friend" | "hostile" | "neutral" | "unknown";
type SymbolKind =
  | "armor"
  | "airDefense"
  | "artillery"
  | "installation"
  | "objective"
  | "respawn"
  | "waypoint"
  | "player"
  | "unknown";

const affiliationTheme: Record<
  Affiliation,
  { stroke: string; fill: string; label: string }
> = {
  friend: {
    stroke: "#48b9d6",
    fill: "rgba(72, 185, 214, 0.1)",
    label: "Friend"
  },
  hostile: {
    stroke: "#e85f55",
    fill: "rgba(232, 95, 85, 0.1)",
    label: "Hostile"
  },
  neutral: {
    stroke: "#85c977",
    fill: "rgba(133, 201, 119, 0.1)",
    label: "Neutral"
  },
  unknown: {
    stroke: "#e8c15f",
    fill: "rgba(232, 193, 95, 0.1)",
    label: "Unknown"
  }
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

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
    stroke: theme.stroke,
    strokeWidth: 0.0016,
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
  const stroke = affiliationTheme[affiliation].stroke;
  const iconProps = {
    fill: "none",
    stroke,
    strokeWidth: 0.0014,
    vectorEffect: "non-scaling-stroke" as const,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };

  if (kind === "player") {
    return (
      <polygon
        points={`0,${-height * 0.42} ${width * 0.17},${height * 0.28} ${-width * 0.17},${height * 0.28}`}
        fill={stroke}
        stroke="#050708"
        strokeWidth="0.0012"
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

  if (kind === "artillery") {
    return <circle cx="0" cy="0" r={height * 0.15} fill={stroke} />;
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

function NatoMapSymbol({
  object,
  index,
  view
}: {
  object: WTMapObject;
  index: number;
  view: MapView;
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
  const width = isPlayer ? 0.03 : 0.022;
  const height = isPlayer ? 0.021 : 0.015;
  const heading =
    typeof object.dx === "number" && typeof object.dy === "number"
      ? (Math.atan2(object.dx, -object.dy) * 180) / Math.PI
      : 0;

  return (
    <g
      key={`${objectLabel(object)}-${index}`}
      transform={`translate(${screen.x} ${screen.y})`}
      aria-label={`${affiliationTheme[affiliation].label} ${objectLabel(object)}`}
    >
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
}

function MapSurface({
  mapInfo,
  objects,
  markers,
  activeMarker,
  setActiveMarker
}: {
  mapInfo?: WTMapInfo;
  objects: WTMapObject[];
  markers: MapMarker[];
  activeMarker?: MapMarker;
  setActiveMarker: (marker: MapMarker) => void;
}) {
  const player = findPlayer(objects);
  const imageUrl = getMapImageUrl(mapInfo);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [view, setView] = useState<MapView>({ zoom: 1, panX: 0, panY: 0 });
  const playerScreen = mapToScreenPoint(player, view);
  const activeMarkerScreen = mapToScreenPoint(activeMarker, view);

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

  function placeMarker(clientX: number, clientY: number) {
    const point = stagePointToMapPoint(clientX, clientY);
    if (!point) {
      return;
    }

    setActiveMarker({
      id: Date.now(),
      label: "Target",
      x: point.x,
      y: point.y
    });
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
      placeMarker(event.clientX, event.clientY);
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
            {Array.from({ length: 9 }, (_, index) => index / 8).map((line) => (
              <g key={line}>
                <line x1={line} y1={0} x2={line} y2={1} className="grid-line" />
                <line x1={0} y1={line} x2={1} y2={line} className="grid-line" />
              </g>
            ))}
          </svg>
        </div>
        <svg className="symbol-overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
          {objects.map((object, index) => (
            <NatoMapSymbol
              key={`${objectLabel(object)}-${index}`}
              object={object}
              index={index}
              view={view}
            />
          ))}

          {playerScreen && activeMarkerScreen && (
            <line
              x1={playerScreen.x}
              y1={playerScreen.y}
              x2={activeMarkerScreen.x}
              y2={activeMarkerScreen.y}
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
              <g key={marker.id} transform={`translate(${screen.x} ${screen.y})`}>
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
      </div>
    </section>
  );
}

function ToolPanel({
  mapInfo,
  objects,
  markers,
  activeMarker,
  clearMarkers
}: {
  mapInfo?: WTMapInfo;
  objects: WTMapObject[];
  markers: MapMarker[];
  activeMarker?: MapMarker;
  clearMarkers: () => void;
}) {
  const player = findPlayer(objects);
  const range = player && activeMarker ? distanceBetween(player, activeMarker, mapInfo) : undefined;
  const bearing = player && activeMarker ? bearingBetween(player, activeMarker) : undefined;
  const targetObjects = objects.filter((object) => object.icon !== "Player");

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
          <span>Target</span>
          <strong>{formatWorldPoint(activeMarker, mapInfo)}</strong>
          <span>Player</span>
          <strong>{formatWorldPoint(player, mapInfo)}</strong>
        </div>
        <div className="tool-actions">
          <button className="icon-button" type="button" onClick={clearMarkers} title="Clear markers">
            <Eraser size={18} />
          </button>
          <span>{activeMarker ? "测距点已放置" : "点击地图放置测距点"}</span>
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
            <strong>{targetObjects.length}</strong>
            <span>Targets</span>
          </div>
          <div>
            <strong>{markers.length}</strong>
            <span>Markers</span>
          </div>
        </div>
        <div className="object-list">
          {objects.slice(0, 12).map((object, index) => (
            <div className="object-row" key={`${objectLabel(object)}-${index}`}>
              <span className="object-dot" style={{ background: objectColor(object) }} />
              <span>{objectLabel(object)}</span>
              <strong>
                {typeof object.x === "number" && typeof object.y === "number"
                  ? `${(object.x * 100).toFixed(1)}, ${(object.y * 100).toFixed(1)}`
                  : "--"}
              </strong>
            </div>
          ))}
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

export default function App() {
  const mapData = useWT8111Map();
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const activeMarker = markers[markers.length - 1];
  const objects = mapData.mapObjects ?? [];

  const statusText = mapData.ok ? "8111 Map Online" : "8111 Map Offline";
  const lastUpdate = mapData.updatedAt
    ? new Date(mapData.updatedAt).toLocaleTimeString()
    : "--";

  const player = useMemo(() => findPlayer(objects), [objects]);

  function addMarker(marker: MapMarker) {
    setMarkers((previous) => [...previous.slice(-3), marker]);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="eyebrow">WT 8111 Neo</div>
          <h1>Map Workbench</h1>
        </div>
        <div className="status-group">
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
          markers={markers}
          activeMarker={activeMarker}
          setActiveMarker={addMarker}
        />
        <ToolPanel
          mapInfo={mapData.mapInfo}
          objects={objects}
          markers={markers}
          activeMarker={activeMarker}
          clearMarkers={() => setMarkers([])}
        />
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
