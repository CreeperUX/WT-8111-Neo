import { useEffect, useMemo, useRef, useState } from "react";
import {
  decodeCloudWsControlMessage,
  cloudLocalObjectKey,
  encodeCloudJoinRequestEnvelope,
  encodeCloudObservationEnvelope,
  encodeCloudPingEnvelope,
  ensureCloudTacticalRoom,
  fetchCloudTacticalVersion,
  readCloudTacticalConfig,
  resolveCloudWebSocketUrl,
  uploadCloudMapImageOnce,
  type CloudRelayStatus,
  type CloudTacticalConfig
} from "../lib/cloudTactical";
import type { WTMapPollSnapshot } from "../lib/wt8111";

const RELAY_UPLOAD_INTERVAL_MS = 500;
const RELAY_PING_INTERVAL_MS = 7000;
const LOCAL_TRACK_MATCH_RADIUS = 0.045;

export interface CloudTacticalRelayState {
  config: CloudTacticalConfig;
  status: CloudRelayStatus;
  error?: string;
  uploadedSeq: number;
  lastUploadedAt: number;
  clockOffsetMs: number;
  mapImageStatus: "pending" | "accepted" | "ignored" | "error";
  mapImageUploadedAt: number;
  mapImageBytes: number;
  mapImageError?: string;
}

function makeClientId() {
  const key = "wt8111-cloud-relay-client-id";
  const existing = window.localStorage.getItem(key);
  if (existing) {
    return existing;
  }

  const id = window.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(key, id);
  return id;
}

function semanticObjectKey(object: { icon?: string; type?: string; color?: string; "color[]"?: [number, number, number] }) {
  return [
    object.icon ?? "",
    object.type ?? "",
    object["color[]"]?.join(",") ?? object.color ?? ""
  ].join("|");
}

export function useCloudTacticalRelay(mapData: WTMapPollSnapshot): CloudTacticalRelayState {
  const config = useMemo(() => readCloudTacticalConfig(), []);
  const clientId = useMemo(() => makeClientId(), []);
  const latestMapData = useRef(mapData);
  const [state, setState] = useState<CloudTacticalRelayState>({
    config,
    status: config.relayEnabled ? "joining" : "disabled",
    uploadedSeq: 0,
    lastUploadedAt: 0,
    clockOffsetMs: 0,
    mapImageStatus: config.relayEnabled ? "pending" : "ignored",
    mapImageUploadedAt: 0,
    mapImageBytes: 0
  });

  useEffect(() => {
    latestMapData.current = mapData;
  }, [mapData]);

  useEffect(() => {
    if (!config.relayEnabled) {
      return;
    }

    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let uploadTimer: number | undefined;
    let pingTimer: number | undefined;
    let attempt = 0;
    let seq = 0;
    let sessionId = "";
    let clockOffsetMs = 0;
    let uploadedMapGeneration: number | undefined;
    let mapImageUploadInFlight = false;
    let lastMapImageUploadAttemptAt = 0;
    let nextLocalId = 1;
    let localTracks: Array<{
      id: number;
      semanticKey: string;
      x: number;
      y: number;
      lastSeenSeq: number;
    }> = [];
    const pendingPings = new Map<number, number>();

    function stopTimers() {
      if (uploadTimer) {
        window.clearInterval(uploadTimer);
        uploadTimer = undefined;
      }
      if (pingTimer) {
        window.clearInterval(pingTimer);
        pingTimer = undefined;
      }
    }

    function sendPing() {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const clientTimeMs = Date.now();
      pendingPings.set(clientTimeMs, performance.now());
      socket.send(encodeCloudPingEnvelope(clientTimeMs));
    }

    async function uploadMapImageIfNeeded() {
      if (mapImageUploadInFlight || !sessionId) {
        return;
      }

      const snapshot = latestMapData.current;
      if (!snapshot.ok || !snapshot.mapInfo) {
        return;
      }

      const mapGeneration = snapshot.mapInfo.map_generation ?? 0;
      if (uploadedMapGeneration === mapGeneration) {
        return;
      }

      const now = Date.now();
      if (now - lastMapImageUploadAttemptAt < 5000) {
        return;
      }

      lastMapImageUploadAttemptAt = now;
      mapImageUploadInFlight = true;

      try {
        const result = await uploadCloudMapImageOnce(
          config,
          clientId,
          snapshot.mapInfo
        );
        if (!result || disposed) {
          return;
        }

        uploadedMapGeneration = result.map_generation;
        setState((previous) => ({
          ...previous,
          mapImageStatus: result.accepted ? "accepted" : "ignored",
          mapImageUploadedAt: Date.now(),
          mapImageBytes: result.bytes,
          mapImageError: undefined
        }));
      } catch (error) {
        if (!disposed) {
          setState((previous) => ({
            ...previous,
            mapImageStatus: "error",
            mapImageError: error instanceof Error ? error.message : "Cloud map image upload failed"
          }));
        }
      } finally {
        mapImageUploadInFlight = false;
      }
    }

    function uploadObservation() {
      if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) {
        return;
      }

      const snapshot = latestMapData.current;
      if (!snapshot.ok || !snapshot.mapObjects) {
        return;
      }

      void uploadMapImageIfNeeded();

      const now = Date.now();
      const frameLocalIds = new Map<string, number>();
      const usedTrackIds = new Set<number>();
      for (const object of snapshot.mapObjects) {
        if (
          object.icon === "Player" ||
          typeof object.x !== "number" ||
          typeof object.y !== "number"
        ) {
          continue;
        }

        const key = cloudLocalObjectKey(object);
        const semanticKey = semanticObjectKey(object);
        const match = localTracks
          .filter((track) => track.semanticKey === semanticKey && !usedTrackIds.has(track.id))
          .map((track) => ({
            track,
            distance: Math.hypot(track.x - object.x!, track.y - object.y!)
          }))
          .filter(({ distance }) => distance < LOCAL_TRACK_MATCH_RADIUS)
          .sort((left, right) => left.distance - right.distance)[0]?.track;

        const track = match ?? {
          id: nextLocalId++,
          semanticKey,
          x: object.x,
          y: object.y,
          lastSeenSeq: seq
        };

        track.x = object.x;
        track.y = object.y;
        track.lastSeenSeq = seq;
        usedTrackIds.add(track.id);
        frameLocalIds.set(key, track.id);

        if (!match) {
          localTracks.push(track);
        }
      }

      seq += 1;
      localTracks = localTracks.filter((track) => seq - track.lastSeenSeq < 20);
      socket.send(
        encodeCloudObservationEnvelope({
          sessionId,
          roomId: config.roomId ?? "",
          clientId,
          playerName: config.playerName,
          seq,
          observedAtMs: Math.round(now + clockOffsetMs),
          measurementAgeMs: snapshot.updatedAt ? Math.max(0, now - snapshot.updatedAt) : 0,
          mapInfo: snapshot.mapInfo,
          mapObjects: snapshot.mapObjects,
          localIds: frameLocalIds
        })
      );

      setState((previous) => ({
        ...previous,
        status: "connected",
        uploadedSeq: seq,
        lastUploadedAt: now,
        clockOffsetMs,
        error: undefined
      }));
    }

    async function connect() {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 5000);

      try {
        stopTimers();
        setState((previous) => ({
          ...previous,
          status: attempt === 0 ? "joining" : "reconnecting",
          error: undefined
        }));

        await fetchCloudTacticalVersion(config.serverUrl, controller.signal);
        const join = await ensureCloudTacticalRoom(config, controller.signal);
        if (disposed) {
          return;
        }

        setState((previous) => ({
          ...previous,
          status: "connecting",
          error: undefined
        }));

        socket = new WebSocket(resolveCloudWebSocketUrl(config.serverUrl, join.relay_url));
        socket.binaryType = "arraybuffer";

        socket.onopen = () => {
          socket?.send(encodeCloudJoinRequestEnvelope(config, clientId));
          sendPing();
        };

        socket.onmessage = (event) => {
          if (!(event.data instanceof ArrayBuffer)) {
            return;
          }

          const message = decodeCloudWsControlMessage(event.data);
          if (!message) {
            return;
          }

          if (message.kind === "joinResponse") {
            if (!message.value.accepted) {
              socket?.close();
              setState((previous) => ({
                ...previous,
                status: "error",
                error: message.value.errorMessage || "Cloud relay join rejected"
              }));
              return;
            }

            sessionId = message.value.sessionId;
            if (message.value.serverTimeMs) {
              clockOffsetMs = message.value.serverTimeMs - Date.now();
            }
            attempt = 0;
            uploadedMapGeneration = undefined;
            mapImageUploadInFlight = false;
            lastMapImageUploadAttemptAt = 0;
            setState((previous) => ({
              ...previous,
              status: "connected",
              clockOffsetMs,
              mapImageStatus: "pending",
              mapImageError: undefined,
              error: undefined
            }));
            void uploadMapImageIfNeeded();
            uploadObservation();
            uploadTimer = window.setInterval(uploadObservation, RELAY_UPLOAD_INTERVAL_MS);
            pingTimer = window.setInterval(sendPing, RELAY_PING_INTERVAL_MS);
            return;
          }

          if (message.kind === "pong") {
            const sentAt = pendingPings.get(message.value.clientTimeMs);
            pendingPings.delete(message.value.clientTimeMs);
            if (sentAt !== undefined) {
              const rtt = performance.now() - sentAt;
              clockOffsetMs = message.value.serverTimeMs - (message.value.clientTimeMs + rtt / 2);
              setState((previous) => ({
                ...previous,
                clockOffsetMs
              }));
            }
            return;
          }

          if (message.kind === "error") {
            setState((previous) => ({
              ...previous,
              status: "error",
              error: message.message || `Cloud relay error ${message.code}`
            }));
          }
        };

        socket.onerror = () => {
          setState((previous) => ({
            ...previous,
            status: "error",
            error: "Cloud relay WebSocket error"
          }));
        };

        socket.onclose = () => {
          stopTimers();
          sessionId = "";
          if (disposed) {
            return;
          }

          attempt += 1;
          const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
          setState((previous) => ({
            ...previous,
            status: "reconnecting",
            error: `Cloud relay disconnected; retrying in ${Math.round(delay / 1000)}s`
          }));
          reconnectTimer = window.setTimeout(connect, delay);
        };
      } catch (error) {
        if (disposed) {
          return;
        }

        attempt += 1;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        setState((previous) => ({
          ...previous,
          status: "reconnecting",
          error: error instanceof Error ? error.message : "Cloud relay join failed"
        }));
        reconnectTimer = window.setTimeout(connect, delay);
      } finally {
        window.clearTimeout(timeout);
      }
    }

    connect();

    return () => {
      disposed = true;
      stopTimers();
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [clientId, config]);

  return state;
}
