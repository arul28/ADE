import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding, SessionDeltaSummary } from "../../../shared/types";

const deltaCache = new Map<string, SessionDeltaSummary | null>();
const deltaInFlight = new Map<string, Promise<SessionDeltaSummary | null>>();
const deltaQueue: Array<{
  sessionId: string;
  pin: OpenProjectBinding;
  resolve: (value: SessionDeltaSummary | null) => void;
}> = [];
const MAX_CACHED_SESSION_DELTAS = 128;
const MAX_CONCURRENT_SESSION_DELTA_REQUESTS = 4;
let activeDeltaRequests = 0;

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

function pumpDeltaQueue(): void {
  while (activeDeltaRequests < MAX_CONCURRENT_SESSION_DELTA_REQUESTS && deltaQueue.length > 0) {
    const next = deltaQueue.shift();
    if (!next) return;
    activeDeltaRequests += 1;
    window.ade.sessions
      .getDelta(next.sessionId, next.pin)
      .then((result) => {
        touchDeltaCacheEntry(next.sessionId, result);
        next.resolve(result);
      })
      .catch(() => {
        touchDeltaCacheEntry(next.sessionId, null);
        next.resolve(null);
      })
      .finally(() => {
        deltaInFlight.delete(next.sessionId);
        activeDeltaRequests = Math.max(0, activeDeltaRequests - 1);
        pumpDeltaQueue();
      });
  }
}

function fetchSessionDelta(sessionId: string, pin: OpenProjectBinding): Promise<SessionDeltaSummary | null> {
  if (deltaCache.has(sessionId)) {
    const cached = deltaCache.get(sessionId) ?? null;
    touchDeltaCacheEntry(sessionId, cached);
    return Promise.resolve(cached);
  }
  const existing = deltaInFlight.get(sessionId);
  if (existing) return existing;

  const request = new Promise<SessionDeltaSummary | null>((resolve) => {
    deltaQueue.push({ sessionId, pin, resolve });
    pumpDeltaQueue();
  });
  deltaInFlight.set(sessionId, request);
  return request;
}

/** The session's change summary, read from the session's machine (`pin`). No pin: no read. */
export function useSessionDelta(sessionId: string | null, enabled: boolean, pin: OpenProjectBinding | null) {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [delta, setDelta] = useState<SessionDeltaSummary | null>(
    sessionId ? deltaCache.get(sessionId) ?? null : null,
  );

  useEffect(() => {
    const deltaPin = pinRef.current;
    if (!sessionId || !enabled || !deltaPin) {
      setDelta(null);
      return;
    }

    let cancelled = false;
    fetchSessionDelta(sessionId, deltaPin)
      .then((result) => {
        if (cancelled) return;
        setDelta(result);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, pinKey]);

  return delta;
}
