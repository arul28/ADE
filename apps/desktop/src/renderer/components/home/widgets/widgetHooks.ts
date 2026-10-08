import { useEffect, useRef } from "react";

/**
 * Runs `task` now and then every `intervalMs`, but only while `active` (the
 * widget is on screen and the window is visible). A run never overlaps the
 * previous one: the next wait starts when the last run settles.
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
        // The widget shows its own error state; a failed run just waits for the next.
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

export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function relativeTimeShort(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
