import { getMapImageUrl, type WTMapInfo, type WTMapObject } from "./wt8111";

const U16_MAX = 65535;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
export const CLOUD_TACTICAL_PROTOCOL_VERSION = 1;

export type CloudViewerStatus =
  | "disabled"
  | "joining"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type CloudRelayStatus =
  | "disabled"
  | "joining"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface CloudTacticalConfig {
  enabled: boolean;
  viewerEnabled: boolean;
  relayEnabled: boolean;
  serverUrl: string;
  roomId?: string;
  password?: string;
  playerName?: string;
}

export interface CloudTacticalJoin {
  ok: boolean;
  room_id: string;
  relay_url: string;
  viewer_url: string;
}

export interface CloudMapImageUploadResult {
  ok: boolean;
  accepted: boolean;
  room_id: string;
  bytes: number;
  content_type: string;
  map_generation: number;
  uploaded_secs_ago: number;
}

export interface CloudTacticalVersion {
  service: string;
  version: string;
  protocol_version: number;
}

export interface CloudCreateRoomInput {
  room_id?: string;
  password?: string;
  player_name?: string;
}

export interface CloudFusedTrack {
  trackId: string;
  labelId: number;
  classId: number;
  affiliation: number;
  xU16: number;
  yU16: number;
  headingI16: number;
  vxI16: number;
  vyI16: number;
  confidenceU8: number;
  lastSeenMsAgo: number;
  sourceCount: number;
  flags: number;
  totalAgeMs: number;
  contributingClients: number;
}

export interface CloudInterestRegion {
  trackId: string;
  centerXU16: number;
  centerYU16: number;
  anchorXU16: number;
  anchorYU16: number;
  radiusMajorU16: number;
  radiusMinorU16: number;
  headingI16: number;
  expiresInMs: number;
  confidenceU8: number;
}

export interface CloudTacticalSummary {
  totalTracks: number;
  hostileTracks: number;
  friendlyTracks: number;
  staleTracks: number;
  interestRegions: number;
}

export interface CloudFusedSnapshot {
  protocolVersion: number;
  roomId: string;
  seq: number;
  serverTimeMs: number;
  mapGeneration: number;
  tracks: CloudFusedTrack[];
  interestRegions: CloudInterestRegion[];
  summary?: CloudTacticalSummary;
}

export interface CloudInterestOverlay {
  trackId: string;
  center: { x: number; y: number };
  anchor: { x: number; y: number };
  radiusMajor: number;
  radiusMinor: number;
  headingDeg: number;
  expiresInMs: number;
  confidenceU8: number;
}

export interface CloudJoinResponse {
  accepted: boolean;
  sessionId: string;
  serverProtocolVersion: number;
  errorMessage: string;
  serverTimeMs: number;
}

export interface CloudPong {
  clientTimeMs: number;
  serverTimeMs: number;
}

export type CloudWsControlMessage =
  | { kind: "joinResponse"; value: CloudJoinResponse }
  | { kind: "pong"; value: CloudPong }
  | { kind: "error"; code: number; message: string }
  | { kind: "ack"; seq: number }
  | { kind: "requestKeyframe"; reason: string };

export interface CloudObservationEnvelopeInput {
  sessionId: string;
  roomId: string;
  clientId: string;
  playerName?: string;
  seq: number;
  observedAtMs: number;
  measurementAgeMs: number;
  mapInfo?: WTMapInfo;
  mapObjects: WTMapObject[];
  localIds?: Map<string, number>;
}

class ProtoReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done() {
    return this.offset >= this.bytes.length;
  }

  readTag() {
    if (this.done) {
      return undefined;
    }

    const key = Number(this.readVarintBigInt());
    return {
      field: key >>> 3,
      wire: key & 7
    };
  }

  readVarintNumber() {
    return Number(this.readVarintBigInt());
  }

  readVarintBigInt() {
    let result = 0n;
    let shift = 0n;

    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }

      shift += 7n;
      if (shift > 70n) {
        throw new Error("Invalid protobuf varint");
      }
    }

    throw new Error("Unexpected end of protobuf varint");
  }

  readLengthDelimited() {
    const length = this.readVarintNumber();
    const end = this.offset + length;
    if (length < 0 || end > this.bytes.length) {
      throw new Error("Invalid protobuf length-delimited field");
    }

    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  readString() {
    return decoder.decode(this.readLengthDelimited());
  }

  skip(wire: number) {
    switch (wire) {
      case 0:
        this.readVarintBigInt();
        return;
      case 1:
        this.offset += 8;
        break;
      case 2:
        this.readLengthDelimited();
        return;
      case 5:
        this.offset += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wire}`);
    }

    if (this.offset > this.bytes.length) {
      throw new Error("Unexpected end of protobuf field");
    }
  }
}

function asUint8Array(payload: ArrayBuffer | Uint8Array) {
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
}

function toInt32(value: bigint) {
  const low32 = Number(value & 0xffffffffn);
  return low32 >= 0x80000000 ? low32 - 0x100000000 : low32;
}

function readStringField(reader: ProtoReader, wire: number) {
  if (wire !== 2) {
    reader.skip(wire);
    return "";
  }

  return reader.readString();
}

function readUintField(reader: ProtoReader, wire: number) {
  if (wire !== 0) {
    reader.skip(wire);
    return 0;
  }

  return reader.readVarintNumber();
}

function readInt32Field(reader: ProtoReader, wire: number) {
  if (wire !== 0) {
    reader.skip(wire);
    return 0;
  }

  return toInt32(reader.readVarintBigInt());
}

function writeVarint(value: number | bigint): number[] {
  let next = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.trunc(value)));
  const bytes: number[] = [];

  while (next >= 0x80n) {
    bytes.push(Number((next & 0x7fn) | 0x80n));
    next >>= 7n;
  }

  bytes.push(Number(next));
  return bytes;
}

function writeInt32(value: number) {
  return writeVarint(BigInt.asUintN(32, BigInt(Math.trunc(value))));
}

function writeTag(field: number, wire: number) {
  return writeVarint((field << 3) | wire);
}

function writeUintField(field: number, value: number | bigint) {
  if (typeof value === "number" && (!Number.isFinite(value) || value === 0)) {
    return [];
  }

  if (typeof value === "bigint" && value === 0n) {
    return [];
  }

  return [...writeTag(field, 0), ...writeVarint(value)];
}

function writeInt32Field(field: number, value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return [];
  }

  return [...writeTag(field, 0), ...writeInt32(value)];
}

function writeStringField(field: number, value?: string) {
  if (!value) {
    return [];
  }

  const encoded = encoder.encode(value);
  return [...writeTag(field, 2), ...writeVarint(encoded.length), ...encoded];
}

function writeMessageField(field: number, bytes: Uint8Array | number[]) {
  if (bytes.length === 0) {
    return [];
  }

  return [...writeTag(field, 2), ...writeVarint(bytes.length), ...bytes];
}

function concatBytes(chunks: Array<number[] | Uint8Array>) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

function decodeFusedTrack(bytes: Uint8Array): CloudFusedTrack {
  const reader = new ProtoReader(bytes);
  const track: CloudFusedTrack = {
    trackId: "",
    labelId: 0,
    classId: 4,
    affiliation: 3,
    xU16: 0,
    yU16: 0,
    headingI16: 0,
    vxI16: 0,
    vyI16: 0,
    confidenceU8: 0,
    lastSeenMsAgo: 0,
    sourceCount: 0,
    flags: 0,
    totalAgeMs: 0,
    contributingClients: 0
  };

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    switch (tag.field) {
      case 1:
        track.trackId = readStringField(reader, tag.wire);
        break;
      case 2:
        track.labelId = readUintField(reader, tag.wire);
        break;
      case 3:
        track.classId = readUintField(reader, tag.wire);
        break;
      case 4:
        track.affiliation = readUintField(reader, tag.wire);
        break;
      case 5:
        track.xU16 = readUintField(reader, tag.wire);
        break;
      case 6:
        track.yU16 = readUintField(reader, tag.wire);
        break;
      case 7:
        track.headingI16 = readInt32Field(reader, tag.wire);
        break;
      case 8:
        track.vxI16 = readInt32Field(reader, tag.wire);
        break;
      case 9:
        track.vyI16 = readInt32Field(reader, tag.wire);
        break;
      case 10:
        track.confidenceU8 = readUintField(reader, tag.wire);
        break;
      case 11:
        track.lastSeenMsAgo = readUintField(reader, tag.wire);
        break;
      case 12:
        track.sourceCount = readUintField(reader, tag.wire);
        break;
      case 13:
        track.flags = readUintField(reader, tag.wire);
        break;
      case 14:
        track.totalAgeMs = readUintField(reader, tag.wire);
        break;
      case 15:
        track.contributingClients = readUintField(reader, tag.wire);
        break;
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return track;
}

function decodeJoinResponse(bytes: Uint8Array): CloudJoinResponse {
  const reader = new ProtoReader(bytes);
  const response: CloudJoinResponse = {
    accepted: false,
    sessionId: "",
    serverProtocolVersion: 0,
    errorMessage: "",
    serverTimeMs: 0
  };

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    switch (tag.field) {
      case 1:
        response.accepted = readUintField(reader, tag.wire) !== 0;
        break;
      case 2:
        response.sessionId = readStringField(reader, tag.wire);
        break;
      case 3:
        response.serverProtocolVersion = readUintField(reader, tag.wire);
        break;
      case 4:
        response.errorMessage = readStringField(reader, tag.wire);
        break;
      case 5:
        response.serverTimeMs = readUintField(reader, tag.wire);
        break;
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return response;
}

function decodeErrorResponse(bytes: Uint8Array) {
  const reader = new ProtoReader(bytes);
  const response = { code: 0, message: "" };

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    switch (tag.field) {
      case 1:
        response.code = readUintField(reader, tag.wire);
        break;
      case 2:
        response.message = readStringField(reader, tag.wire);
        break;
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return response;
}

function decodeAck(bytes: Uint8Array) {
  const reader = new ProtoReader(bytes);
  let seq = 0;

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    if (tag.field === 1) {
      seq = readUintField(reader, tag.wire);
    } else {
      reader.skip(tag.wire);
    }
  }

  return seq;
}

function decodeRequestKeyframe(bytes: Uint8Array) {
  const reader = new ProtoReader(bytes);
  let reason = "";

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    if (tag.field === 1) {
      reason = readStringField(reader, tag.wire);
    } else {
      reader.skip(tag.wire);
    }
  }

  return reason;
}

function decodePong(bytes: Uint8Array): CloudPong {
  const reader = new ProtoReader(bytes);
  const pong: CloudPong = {
    clientTimeMs: 0,
    serverTimeMs: 0
  };

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    switch (tag.field) {
      case 1:
        pong.clientTimeMs = readUintField(reader, tag.wire);
        break;
      case 2:
        pong.serverTimeMs = readUintField(reader, tag.wire);
        break;
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return pong;
}

function decodeInterestRegion(bytes: Uint8Array): CloudInterestRegion {
  const reader = new ProtoReader(bytes);
  const region: CloudInterestRegion = {
    trackId: "",
    centerXU16: 0,
    centerYU16: 0,
    anchorXU16: 0,
    anchorYU16: 0,
    radiusMajorU16: 0,
    radiusMinorU16: 0,
    headingI16: 0,
    expiresInMs: 0,
    confidenceU8: 0
  };

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    switch (tag.field) {
      case 1:
        region.trackId = readStringField(reader, tag.wire);
        break;
      case 2:
        region.centerXU16 = readUintField(reader, tag.wire);
        break;
      case 3:
        region.centerYU16 = readUintField(reader, tag.wire);
        break;
      case 4:
        region.anchorXU16 = readUintField(reader, tag.wire);
        break;
      case 5:
        region.anchorYU16 = readUintField(reader, tag.wire);
        break;
      case 6:
        region.radiusMajorU16 = readUintField(reader, tag.wire);
        break;
      case 7:
        region.radiusMinorU16 = readUintField(reader, tag.wire);
        break;
      case 8:
        region.headingI16 = readInt32Field(reader, tag.wire);
        break;
      case 9:
        region.expiresInMs = readUintField(reader, tag.wire);
        break;
      case 10:
        region.confidenceU8 = readUintField(reader, tag.wire);
        break;
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return region;
}

function decodeTacticalSummary(bytes: Uint8Array): CloudTacticalSummary {
  const reader = new ProtoReader(bytes);
  const summary: CloudTacticalSummary = {
    totalTracks: 0,
    hostileTracks: 0,
    friendlyTracks: 0,
    staleTracks: 0,
    interestRegions: 0
  };

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    switch (tag.field) {
      case 1:
        summary.totalTracks = readUintField(reader, tag.wire);
        break;
      case 2:
        summary.hostileTracks = readUintField(reader, tag.wire);
        break;
      case 3:
        summary.friendlyTracks = readUintField(reader, tag.wire);
        break;
      case 4:
        summary.staleTracks = readUintField(reader, tag.wire);
        break;
      case 5:
        summary.interestRegions = readUintField(reader, tag.wire);
        break;
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return summary;
}

function decodeFusedSnapshot(bytes: Uint8Array): CloudFusedSnapshot {
  const reader = new ProtoReader(bytes);
  const snapshot: CloudFusedSnapshot = {
    protocolVersion: 0,
    roomId: "",
    seq: 0,
    serverTimeMs: 0,
    mapGeneration: 0,
    tracks: [],
    interestRegions: []
  };

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    switch (tag.field) {
      case 1:
        snapshot.protocolVersion = readUintField(reader, tag.wire);
        break;
      case 2:
        snapshot.roomId = readStringField(reader, tag.wire);
        break;
      case 3:
        snapshot.seq = readUintField(reader, tag.wire);
        break;
      case 4:
        snapshot.serverTimeMs = readUintField(reader, tag.wire);
        break;
      case 5:
        snapshot.mapGeneration = readUintField(reader, tag.wire);
        break;
      case 6:
        if (tag.wire === 2) {
          snapshot.tracks.push(decodeFusedTrack(reader.readLengthDelimited()));
        } else {
          reader.skip(tag.wire);
        }
        break;
      case 7:
        if (tag.wire === 2) {
          snapshot.interestRegions.push(decodeInterestRegion(reader.readLengthDelimited()));
        } else {
          reader.skip(tag.wire);
        }
        break;
      case 8:
        if (tag.wire === 2) {
          snapshot.summary = decodeTacticalSummary(reader.readLengthDelimited());
        } else {
          reader.skip(tag.wire);
        }
        break;
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return snapshot;
}

export function decodeCloudWsSnapshot(payload: ArrayBuffer | Uint8Array): CloudFusedSnapshot | undefined {
  const reader = new ProtoReader(asUint8Array(payload));

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    if (tag.field === 2 && tag.wire === 2) {
      return decodeFusedSnapshot(reader.readLengthDelimited());
    }

    reader.skip(tag.wire);
  }

  return undefined;
}

export function decodeCloudWsControlMessage(
  payload: ArrayBuffer | Uint8Array
): CloudWsControlMessage | undefined {
  const reader = new ProtoReader(asUint8Array(payload));

  while (!reader.done) {
    const tag = reader.readTag();
    if (!tag) {
      break;
    }

    if (tag.wire !== 2) {
      reader.skip(tag.wire);
      continue;
    }

    const value = reader.readLengthDelimited();
    switch (tag.field) {
      case 4:
        return { kind: "joinResponse", value: decodeJoinResponse(value) };
      case 5: {
        const error = decodeErrorResponse(value);
        return { kind: "error", code: error.code, message: error.message };
      }
      case 6:
        return { kind: "ack", seq: decodeAck(value) };
      case 7:
        return { kind: "requestKeyframe", reason: decodeRequestKeyframe(value) };
      case 9:
        return { kind: "pong", value: decodePong(value) };
      default:
        break;
    }
  }

  return undefined;
}

function unitFromU16(value: number) {
  return Math.min(1, Math.max(0, value / U16_MAX));
}

function classLabel(classId: number) {
  switch (classId) {
    case 0:
      return "Aircraft";
    case 1:
      return "Ground";
    case 2:
      return "Objective";
    case 3:
      return "Respawn";
    default:
      return "Unknown";
  }
}

function classIcon(classId: number) {
  switch (classId) {
    case 0:
      return "Aircraft";
    case 1:
      return "ground_model";
    case 2:
      return "capture_zone";
    case 3:
      return "respawn_base";
    default:
      return "unknown";
  }
}

function affiliationName(affiliation: number) {
  switch (affiliation) {
    case 0:
      return "friend";
    case 1:
      return "hostile";
    case 2:
      return "neutral";
    default:
      return "unknown";
  }
}

function affiliationColor(affiliation: number) {
  switch (affiliation) {
    case 0:
      return "#2f7cff";
    case 1:
      return "#ff6358";
    case 2:
      return "#62d96b";
    default:
      return "#ffd25f";
  }
}

function quantizeUnit(value: number | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.round(Math.min(1, Math.max(0, value)) * U16_MAX);
}

function objectText(object: WTMapObject) {
  return `${object.icon ?? ""} ${object.type ?? ""}`.toLowerCase();
}

function inferObjectClassId(object: WTMapObject) {
  const text = objectText(object);
  const icon = (object.icon ?? "").toLowerCase();

  if (icon === "player") {
    return 0;
  }

  if (
    text.includes("aircraft") ||
    text.includes("fighter") ||
    text.includes("bomber") ||
    text.includes("helicopter") ||
    text.includes("plane") ||
    text.includes("drone")
  ) {
    return 0;
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
    return 1;
  }

  if (
    text.includes("capture") ||
    text.includes("point_of_interest") ||
    text.includes("point of interest") ||
    text.includes("bombing") ||
    text.includes("defending") ||
    text.includes("waypoint")
  ) {
    return 2;
  }

  if (text.includes("respawn") || text.includes("airfield")) {
    return 3;
  }

  return 4;
}

function inferObjectAffiliation(object: WTMapObject) {
  if (
    object.cloudAffiliation === "friend" ||
    object.cloudAffiliation === "hostile" ||
    object.cloudAffiliation === "neutral" ||
    object.cloudAffiliation === "unknown"
  ) {
    return ["friend", "hostile", "neutral", "unknown"].indexOf(object.cloudAffiliation);
  }

  if (object.icon === "Player") {
    return 0;
  }

  const rgb = object["color[]"];
  if (rgb) {
    const [red, green, blue] = rgb;
    if (red > 180 && green < 90 && blue < 90) {
      return 1;
    }

    if (green > 150 && red < 150) {
      return 2;
    }

    if (blue > 150 && red < 150) {
      return 0;
    }
  }

  const color = object.color?.toLowerCase() ?? "";
  if (color.includes("fa0") || color.includes("f00") || color.includes("red")) {
    return 1;
  }

  return 3;
}

function headingI16FromObject(object: WTMapObject) {
  if (typeof object.dx !== "number" || typeof object.dy !== "number") {
    return 0;
  }

  return Math.round((((Math.atan2(object.dx, -object.dy) * 180) / Math.PI + 360) % 360) * 100);
}

function objectSignature(object: WTMapObject) {
  const rgb = object["color[]"]?.join(",") ?? object.color ?? "";
  return [
    object.icon ?? "",
    object.type ?? "",
    rgb,
    typeof object.x === "number" ? object.x.toFixed(4) : "x",
    typeof object.y === "number" ? object.y.toFixed(4) : "y"
  ].join("|");
}

export function cloudLocalObjectKey(object: WTMapObject) {
  return objectSignature(object);
}

function headingVector(headingI16: number) {
  const headingRad = ((headingI16 / 100) * Math.PI) / 180;
  return {
    dx: Math.sin(headingRad),
    dy: -Math.cos(headingRad)
  };
}

export function cloudSnapshotToMapObjects(snapshot?: CloudFusedSnapshot): WTMapObject[] {
  if (!snapshot) {
    return [];
  }

  return snapshot.tracks.map((track) => {
    const heading = headingVector(track.headingI16);
    const label = `${classLabel(track.classId)} ${track.trackId || `#${track.labelId}`}`;

    return {
      icon: classIcon(track.classId),
      type: classLabel(track.classId),
      color: affiliationColor(track.affiliation),
      x: unitFromU16(track.xU16),
      y: unitFromU16(track.yU16),
      dx: heading.dx,
      dy: heading.dy,
      blink: track.flags & 1,
      cloudTrackId: track.trackId,
      cloudLabel: label,
      cloudClassId: track.classId,
      cloudAffiliation: affiliationName(track.affiliation),
      cloudConfidenceU8: track.confidenceU8,
      cloudLastSeenMsAgo: track.lastSeenMsAgo,
      cloudSourceCount: track.sourceCount,
      cloudTotalAgeMs: track.totalAgeMs,
      cloudContributingClients: track.contributingClients,
      cloudFlags: track.flags,
      cloudSnapshotSeq: snapshot.seq
    };
  });
}

function encodeObservedPlayer(object: WTMapObject) {
  return concatBytes([
    writeUintField(1, quantizeUnit(object.x)),
    writeUintField(2, quantizeUnit(object.y)),
    writeInt32Field(3, headingI16FromObject(object))
  ]);
}

function encodeObservedObject(object: WTMapObject, localId: number, labelId: number) {
  return concatBytes([
    writeUintField(1, localId),
    writeUintField(2, labelId),
    writeUintField(3, inferObjectClassId(object)),
    writeUintField(4, inferObjectAffiliation(object)),
    writeUintField(5, quantizeUnit(object.x)),
    writeUintField(6, quantizeUnit(object.y)),
    writeInt32Field(7, headingI16FromObject(object)),
    writeUintField(8, 0),
    writeUintField(9, Number(object.blink ?? 0) ? 1 : 0)
  ]);
}

function encodeObservationFrame(input: CloudObservationEnvelopeInput) {
  const player = input.mapObjects.find((object) => object.icon === "Player");
  const labelIds = new Map<string, number>();
  let nextLabelId = 1;

  function labelIdFor(object: WTMapObject) {
    const label = `${object.icon ?? ""}|${object.type ?? ""}`;
    const existing = labelIds.get(label);
    if (existing) {
      return existing;
    }

    const next = nextLabelId++;
    labelIds.set(label, next);
    return next;
  }

  const observedObjects = input.mapObjects
    .filter((object) => object.icon !== "Player")
    .filter((object) => typeof object.x === "number" && typeof object.y === "number")
    .map((object, index) => {
      const localId = input.localIds?.get(objectSignature(object)) ?? index + 1;
      return encodeObservedObject(object, localId, labelIdFor(object));
    });

  return concatBytes([
    writeUintField(1, CLOUD_TACTICAL_PROTOCOL_VERSION),
    writeStringField(2, input.sessionId),
    writeStringField(3, input.roomId),
    writeStringField(4, input.clientId),
    writeStringField(5, input.playerName),
    writeUintField(6, input.seq),
    writeUintField(7, input.observedAtMs),
    writeUintField(8, input.mapInfo?.map_generation ?? 0),
    writeMessageField(10, player ? encodeObservedPlayer(player) : []),
    ...observedObjects.map((object) => writeMessageField(11, object)),
    writeUintField(13, input.measurementAgeMs)
  ]);
}

export function encodeCloudJoinRequestEnvelope(config: CloudTacticalConfig, clientId: string) {
  const joinRequest = concatBytes([
    writeStringField(1, config.roomId),
    writeStringField(2, config.password),
    writeStringField(3, clientId),
    writeStringField(4, config.playerName),
    writeUintField(5, CLOUD_TACTICAL_PROTOCOL_VERSION)
  ]);

  return concatBytes([writeMessageField(3, joinRequest)]);
}

export function encodeCloudPingEnvelope(clientTimeMs = Date.now()) {
  const ping = concatBytes([writeUintField(1, clientTimeMs)]);
  return concatBytes([writeMessageField(8, ping)]);
}

export function encodeCloudObservationEnvelope(input: CloudObservationEnvelopeInput) {
  const observation = encodeObservationFrame(input);
  return concatBytes([writeMessageField(1, observation)]);
}

export function normalizeCloudInterestRegions(
  snapshot?: CloudFusedSnapshot
): CloudInterestOverlay[] {
  if (!snapshot) {
    return [];
  }

  return snapshot.interestRegions.map((region) => ({
    trackId: region.trackId,
    center: {
      x: unitFromU16(region.centerXU16),
      y: unitFromU16(region.centerYU16)
    },
    anchor: {
      x: unitFromU16(region.anchorXU16),
      y: unitFromU16(region.anchorYU16)
    },
    radiusMajor: unitFromU16(region.radiusMajorU16),
    radiusMinor: unitFromU16(region.radiusMinorU16),
    headingDeg: region.headingI16 / 100,
    expiresInMs: region.expiresInMs,
    confidenceU8: region.confidenceU8
  }));
}

export function readCloudTacticalConfig(): CloudTacticalConfig {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("cloudRoom") ?? params.get("room") ?? undefined;
  const enabledParam = params.get("cloud");
  const relayParam = params.get("cloudRelay") ?? params.get("relay");
  const viewerParam = params.get("cloudViewer") ?? params.get("viewer");
  const enabled =
    enabledParam === "1" ||
    enabledParam === "true" ||
    enabledParam === "viewer" ||
    enabledParam === "relay" ||
    enabledParam === "both" ||
    Boolean(roomId);
  const relayEnabled =
    relayParam === "1" ||
    relayParam === "true" ||
    enabledParam === "relay" ||
    enabledParam === "both";
  const viewerDisabled = viewerParam === "0" || viewerParam === "false";
  const viewerEnabled =
    !viewerDisabled &&
    (viewerParam === "1" ||
      viewerParam === "true" ||
      enabledParam === "viewer" ||
      enabledParam === "both" ||
      enabledParam === "1" ||
      enabledParam === "true" ||
      (enabled && enabledParam !== "relay"));

  return {
    enabled,
    viewerEnabled,
    relayEnabled,
    serverUrl: params.get("cloudServer") ?? params.get("server") ?? "http://127.0.0.1:17712",
    roomId,
    password: params.get("cloudPassword") ?? params.get("password") ?? undefined,
    playerName: params.get("cloudPlayer") ?? params.get("player") ?? undefined
  };
}

export async function joinCloudTacticalRoom(
  config: CloudTacticalConfig,
  signal?: AbortSignal
): Promise<CloudTacticalJoin> {
  if (!config.roomId) {
    throw new Error("Cloud room is not configured");
  }

  const baseUrl = config.serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(config.roomId)}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password: config.password ?? ""
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(await readCloudError(response, `Cloud room join failed with ${response.status}`));
  }

  return (await response.json()) as CloudTacticalJoin;
}

export async function createCloudTacticalRoom(
  config: CloudTacticalConfig,
  signal?: AbortSignal
): Promise<CloudTacticalJoin | undefined> {
  if (!config.roomId) {
    throw new Error("Cloud room is not configured");
  }

  const baseUrl = config.serverUrl.replace(/\/+$/, "");
  const body: CloudCreateRoomInput = {
    room_id: config.roomId,
    password: config.password ?? "",
    player_name: config.playerName
  };
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });

  if (response.status === 409) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(await readCloudError(response, `Cloud room create failed with ${response.status}`));
  }

  return (await response.json()) as CloudTacticalJoin;
}

export async function ensureCloudTacticalRoom(
  config: CloudTacticalConfig,
  signal?: AbortSignal
): Promise<CloudTacticalJoin> {
  await createCloudTacticalRoom(config, signal);
  return joinCloudTacticalRoom(config, signal);
}

export async function fetchCloudTacticalVersion(
  serverUrl: string,
  signal?: AbortSignal
): Promise<CloudTacticalVersion> {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/version`, {
    method: "GET",
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    throw new Error(await readCloudError(response, `Cloud version check failed with ${response.status}`));
  }

  const version = (await response.json()) as CloudTacticalVersion;
  if (version.protocol_version !== CLOUD_TACTICAL_PROTOCOL_VERSION) {
    throw new Error(
      `Cloud protocol mismatch: client v${CLOUD_TACTICAL_PROTOCOL_VERSION}, server v${version.protocol_version}`
    );
  }

  return version;
}

export async function uploadCloudMapImageOnce(
  config: CloudTacticalConfig,
  clientId: string,
  mapInfo?: WTMapInfo,
  signal?: AbortSignal
): Promise<CloudMapImageUploadResult | undefined> {
  if (!config.roomId || !mapInfo) {
    return undefined;
  }

  const localResponse = await fetch(getMapImageUrl(mapInfo), {
    method: "GET",
    cache: "no-store",
    signal
  });

  if (!localResponse.ok) {
    throw new Error(`Local map image fetch failed with ${localResponse.status}`);
  }

  const blob = await localResponse.blob();
  if (blob.size === 0) {
    throw new Error("Local map image is empty");
  }

  const contentType = blob.type || localResponse.headers.get("Content-Type") || "application/octet-stream";
  const baseUrl = config.serverUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(config.roomId)}/map-image`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-WT8111-Client-ID": clientId,
      "X-WT8111-Room-Password": config.password ?? "",
      "X-WT8111-Map-Generation": String(mapInfo.map_generation ?? 0)
    },
    body: blob,
    signal
  });

  if (!response.ok) {
    throw new Error(await readCloudError(response, `Cloud map image upload failed with ${response.status}`));
  }

  return (await response.json()) as CloudMapImageUploadResult;
}

export function resolveCloudWebSocketUrl(serverUrl: string, path: string) {
  const url = new URL(path, `${serverUrl.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function getCloudRoomMapImageUrl(serverUrl: string, roomId: string, mapGeneration = 0) {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  return `${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/map-image?gen=${mapGeneration}`;
}

async function readCloudError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error ? body.error : fallback;
  } catch {
    return fallback;
  }
}
