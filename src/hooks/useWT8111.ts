import { useEffect, useRef, useState } from "react";
import {
  pollWT8111,
  type WTPollCursor,
  type WTPollSnapshot
} from "../lib/wt8111";

const POLL_INTERVAL_MS = 250;

const initialCursor: WTPollCursor = {
  lastChatId: 0,
  lastEvtId: 0,
  lastDmgId: 0
};

export function useWT8111() {
  const [snapshot, setSnapshot] = useState<WTPollSnapshot>({
    ok: false,
    updatedAt: 0
  });
  const cursorRef = useRef<WTPollCursor>({ ...initialCursor });

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

    async function tick() {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 1800);

      try {
        const next = await pollWT8111(cursorRef.current, controller.signal);
        if (disposed) {
          return;
        }

        if (next.chat?.length) {
          cursorRef.current.lastChatId = next.chat[next.chat.length - 1].id;
        }

        if (next.hud?.events.length) {
          cursorRef.current.lastEvtId = next.hud.events[next.hud.events.length - 1].id;
        }

        if (next.hud?.damage.length) {
          cursorRef.current.lastDmgId = next.hud.damage[next.hud.damage.length - 1].id;
        }

        setSnapshot((previous) => ({
          ...previous,
          ...next,
          chat: [...(previous.chat ?? []), ...(next.chat ?? [])].slice(-60),
          hud: {
            events: [
              ...(previous.hud?.events ?? []),
              ...(next.hud?.events ?? [])
            ].slice(-60),
            damage: [
              ...(previous.hud?.damage ?? []),
              ...(next.hud?.damage ?? [])
            ].slice(-60)
          }
        }));
      } catch {
        if (!disposed) {
          setSnapshot((previous) => ({
            ...previous,
            ok: false,
            error: "8111 request timed out",
            updatedAt: Date.now()
          }));
        }
      } finally {
        window.clearTimeout(timeout);
        if (!disposed) {
          timer = window.setTimeout(tick, POLL_INTERVAL_MS);
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
  }, []);

  return snapshot;
}
