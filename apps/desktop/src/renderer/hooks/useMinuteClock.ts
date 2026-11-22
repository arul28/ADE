import { useEffect, useState } from "react";

/**
 * Re-render once a minute while a relative time is on screen. `active` false
 * stops the tick; turning it on reads the clock again at once.
 */
export function useMinuteClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [active]);
  return nowMs;
}
