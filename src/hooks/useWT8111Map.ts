import { useEffect, useState } from "react";
import { pollWT8111Map, type WTMapPollSnapshot } from "../lib/wt8111";

const MAP_POLL_INTERVAL_MS = 500;

export function useWT8111Map(enabled = true) {
  const [snapshot, setSnapshot] = useState<WTMapPollSnapshot>({
    ok: false,
    updatedAt: 0
  });

  useEffect(() => {
    if (!enabled) {
      setSnapshot({
        ok: false,
        error: "Local 8111 polling disabled",
        updatedAt: 0
      });
      return;
    }

    let disposed = false;
    let timer: number | undefined;

    async function tick() {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 1500);

      try {
        const next = await pollWT8111Map(controller.signal);
        if (!disposed) {
          setSnapshot((previous) => ({
            ...previous,
            ...next
          }));
        }
      } catch {
        if (!disposed) {
          setSnapshot((previous) => ({
            ...previous,
            ok: false,
            error: "8111 map request timed out",
            updatedAt: Date.now()
          }));
        }
      } finally {
        window.clearTimeout(timeout);
        if (!disposed) {
          timer = window.setTimeout(tick, MAP_POLL_INTERVAL_MS);
        }
      }
    }

    tick();

    return () => {
      disposed = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [enabled]);

  return snapshot;
}
