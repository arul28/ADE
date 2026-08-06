import { useEffect, useRef, useState } from "react";

/** Long enough to register, short enough that nobody waits for it. */
const ALL_CLEAR_BEAT_MS = 1_800;

/**
 * The all-clear moment: when the last thing that wanted a human clears, the
 * section says so for a beat before settling.
 *
 * It fires on the TRANSITION, never on arrival — mounting into an already-quiet
 * account is not an achievement, and celebrating it every time the popover
 * opens would make the beat mean nothing. It also never fires from an unknown
 * baseline, so the first render after a snapshot lands is silent.
 */
export function useAllClearBeat(needsYouCount: number, active = true): boolean {
  const previous = useRef<number | null>(null);
  const [beating, setBeating] = useState(false);

  useEffect(() => {
    const before = previous.current;
    previous.current = needsYouCount;
    if (!active) return;
    if (before === null || before === 0 || needsYouCount !== 0) return;
    setBeating(true);
    const timer = window.setTimeout(() => setBeating(false), ALL_CLEAR_BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [active, needsYouCount]);

  // A surface that goes away mid-beat should not come back still celebrating.
  useEffect(() => {
    if (!active) setBeating(false);
  }, [active]);

  return beating;
}
