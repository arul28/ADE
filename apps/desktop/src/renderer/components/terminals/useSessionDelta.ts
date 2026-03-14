import { useEffect, useState } from "react";
import type { SessionDeltaSummary } from "../../../shared/types";

const deltaCache = new Map<string, SessionDeltaSummary | null>();

export function useSessionDelta(sessionId: string | null, enabled: boolean) {
  const [delta, setDelta] = useState<SessionDeltaSummary | null>(
    sessionId ? deltaCache.get(sessionId) ?? null : null,
  );

  useEffect(() => {
    if (!sessionId || !enabled) {
      setDelta(null);
      return;
    }

    if (deltaCache.has(sessionId)) {
      setDelta(deltaCache.get(sessionId) ?? null);
      return;
    }

    let cancelled = false;
    window.ade.sessions
      .getDelta(sessionId)
      .then((result) => {
        if (cancelled) return;
        deltaCache.set(sessionId, result);
        setDelta(result);
      })
      .catch(() => {
        // Cache the miss so we don't re-fetch on every render
        if (!cancelled) deltaCache.set(sessionId, null);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled]);

  return delta;
}
