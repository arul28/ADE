import { useEffect, useRef } from "react";

/**
 * Runs `task` now and then every `intervalMs`, but only while `active`. A run
 * never overlaps the previous one: the next wait starts when the last run
 * settles. A run that throws is swallowed here and the next one is still
 * scheduled, so a caller that must stop on error sets `active` to false itself.
 */
export function usePolling(task: () => Promise<void> | void, intervalMs: number, active: boolean): void {
  const taskRef = useRef(task);
  taskRef.current = task;
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    const run = async () => {
      try {
        await taskRef.current();
      } catch {
        // The caller decides what a failed run means; the next one is still scheduled.
      }
      if (!cancelled) timer = window.setTimeout(run, intervalMs);
    };
    void run();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [active, intervalMs]);
}
