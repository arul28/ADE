import { useEffect, useState } from "react";
import type { SessionDeltaSummary } from "../../../shared/types";

const deltaCache = new Map<string, SessionDeltaSummary>();

export function useSessionDelta(sessionId: string | null, enabled: boolean) {
  const [delta, setDelta] = useState<SessionDeltaSummary | null>(
    sessionId ? deltaCache.get(sessionId) ?? null : null,
  );

  useEffect(() => {
    if (!sessionId || !enabled) {
      setDelta(null);
      return;
    }

    const cached = deltaCache.get(sessionId);
    if (cached) {
      setDelta(cached);
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
        // ignore - delta not available
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled]);

  return delta;
}
