import { useEffect, useState } from "react";
import type { SessionDeltaSummary } from "../../../shared/types";

const deltaCache = new Map<string, SessionDeltaSummary | null>();
const MAX_CACHED_SESSION_DELTAS = 128;

function touchDeltaCacheEntry(sessionId: string, value: SessionDeltaSummary | null): void {
  if (deltaCache.has(sessionId)) {
    deltaCache.delete(sessionId);
  }
  deltaCache.set(sessionId, value);
  while (deltaCache.size > MAX_CACHED_SESSION_DELTAS) {
    const oldestKey = deltaCache.keys().next().value;
    if (!oldestKey) break;
    deltaCache.delete(oldestKey);
  }
}

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
      const cached = deltaCache.get(sessionId) ?? null;
      touchDeltaCacheEntry(sessionId, cached);
      setDelta(cached);
      return;
    }

    let cancelled = false;
    window.ade.sessions
      .getDelta(sessionId)
      .then((result) => {
        if (cancelled) return;
        touchDeltaCacheEntry(sessionId, result);
        setDelta(result);
      })
      .catch(() => {
        // Cache the miss so we don't re-fetch on every render
        if (!cancelled) touchDeltaCacheEntry(sessionId, null);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled]);

  return delta;
}
