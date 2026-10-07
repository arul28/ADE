import { useEffect, useMemo, useState } from "react";
import {
  nextScheduledWakeDeadlineMs,
  nextTurnStallDeadlineMs,
  type TurnStallInput,
} from "../../shared/sessionStatusPresentation";

/**
 * "Now" for the turn-stall rule. A silent turn becomes stalled five minutes
 * after its last output with no new data at all, so the caller re-renders
 * exactly at the next such deadline instead of polling. A scheduled wake that
 * never starts turns overdue the same way, so its deadline counts too. The
 * value also moves whenever `sessions` changes identity.
 */
export function useTurnStallClock(
  sessions: readonly (TurnStallInput & { nextWakeAt?: string | null })[],
): number {
  const [epoch, setEpoch] = useState(0);
  const nowMs = useMemo(() => {
    void epoch;
    void sessions;
    return Date.now();
  }, [epoch, sessions]);
  useEffect(() => {
    const deadlines = [nextTurnStallDeadlineMs(sessions, nowMs), nextScheduledWakeDeadlineMs(sessions, nowMs)]
      .filter((value): value is number => value != null);
    if (deadlines.length === 0) return undefined;
    const deadline = Math.min(...deadlines);
    const timer = window.setTimeout(() => setEpoch((value) => value + 1), Math.max(250, deadline - Date.now() + 50));
    return () => window.clearTimeout(timer);
  }, [sessions, nowMs]);
  return nowMs;
}
