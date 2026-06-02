import type { WTMapObject } from "./wt8111";

const U16_MAX = 65535;
const decoder = new TextDecoder();

export type CloudViewerStatus =
  | "disabled"
  | "joining"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface CloudTacticalConfig {
  enabled: boolean;
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
    flags: 0
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
      default:
        reader.skip(tag.wire);
        break;
    }
  }

  return track;
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
      cloudFlags: track.flags,
      cloudSnapshotSeq: snapshot.seq
    };
  });
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
  const enabled =
    enabledParam === "1" ||
    enabledParam === "true" ||
    enabledParam === "viewer" ||
    Boolean(roomId);

  return {
    enabled,
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
    throw new Error(`Cloud room join failed with ${response.status}`);
  }

  return (await response.json()) as CloudTacticalJoin;
}

export function resolveCloudWebSocketUrl(serverUrl: string, path: string) {
  const url = new URL(path, `${serverUrl.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
