import { useEffect, useMemo, useState } from "react";
import {
  decodeCloudWsSnapshot,
  fetchCloudTacticalVersion,
  joinCloudTacticalRoom,
  readCloudTacticalConfig,
  resolveCloudWebSocketUrl,
  type CloudFusedSnapshot,
  type CloudTacticalConfig,
  type CloudViewerStatus
} from "../lib/cloudTactical";

export interface CloudTacticalViewerState {
  config: CloudTacticalConfig;
  status: CloudViewerStatus;
  snapshot?: CloudFusedSnapshot;
  error?: string;
  updatedAt: number;
}

export function useCloudTacticalViewer(): CloudTacticalViewerState {
  const config = useMemo(() => readCloudTacticalConfig(), []);
  const [state, setState] = useState<CloudTacticalViewerState>({
    config,
    status: config.viewerEnabled ? "joining" : "disabled",
    updatedAt: 0
  });

  useEffect(() => {
    if (!config.viewerEnabled) {
      return;
    }

    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let attempt = 0;

    async function connect() {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 5000);

      try {
        setState((previous) => ({
          ...previous,
          status: attempt === 0 ? "joining" : "reconnecting",
          error: undefined
        }));

        await fetchCloudTacticalVersion(config.serverUrl, controller.signal);
        const join = await joinCloudTacticalRoom(config, controller.signal);
        if (disposed) {
          return;
        }

        setState((previous) => ({
          ...previous,
          status: "connecting",
          error: undefined
        }));

        socket = new WebSocket(resolveCloudWebSocketUrl(config.serverUrl, join.viewer_url));
        socket.binaryType = "arraybuffer";

        socket.onopen = () => {
          attempt = 0;
          setState((previous) => ({
            ...previous,
            status: "connected",
            error: undefined
          }));
        };

        socket.onmessage = (event) => {
          if (!(event.data instanceof ArrayBuffer)) {
            return;
          }

          try {
            const snapshot = decodeCloudWsSnapshot(event.data);
            if (!snapshot) {
              return;
            }

            setState((previous) => ({
              ...previous,
              status: "connected",
              snapshot,
              error: undefined,
              updatedAt: Date.now()
            }));
          } catch (error) {
            setState((previous) => ({
              ...previous,
              status: "error",
              error: error instanceof Error ? error.message : "Cloud snapshot decode failed"
            }));
          }
        };

        socket.onerror = () => {
          setState((previous) => ({
            ...previous,
            status: "error",
            error: "Cloud viewer WebSocket error"
          }));
        };

        socket.onclose = () => {
          if (disposed) {
            return;
          }

          attempt += 1;
          const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
          setState((previous) => ({
            ...previous,
            status: "reconnecting",
            error: `Cloud viewer disconnected; retrying in ${Math.round(delay / 1000)}s`
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
          error: error instanceof Error ? error.message : "Cloud viewer join failed"
        }));
        reconnectTimer = window.setTimeout(connect, delay);
      } finally {
        window.clearTimeout(timeout);
      }
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [config]);

  return state;
}
