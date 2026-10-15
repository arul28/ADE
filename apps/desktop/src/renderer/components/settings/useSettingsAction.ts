import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A Settings action's state: which action is running and the last failure.
 *
 * `busy` is the key of the most recently started action still running (`null`
 * when idle), so one row can say "Installing…" on its own button while the
 * others stay disabled. Several actions can overlap; each run tracks its own
 * key, so one finishing never clears another's busy state. `run` clears the
 * last failure, records a new one, and resolves to the action's value or
 * `undefined` when it failed. A settle after unmount is dropped.
 */
export type SettingsAction = {
  busy: string | null;
  error: string | null;
  run: <T>(key: string, work: () => Promise<T>) => Promise<T | undefined>;
};

export function useSettingsAction(): SettingsAction {
  // One entry per running run, so two runs with the same key each clear only their own.
  const [running, setRunning] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async <T,>(key: string, work: () => Promise<T>): Promise<T | undefined> => {
    setRunning((current) => [...current, key]);
    setError(null);
    try {
      return await work();
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      if (mountedRef.current) {
        setRunning((current) => {
          const index = current.lastIndexOf(key);
          return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
        });
      }
    }
  }, []);

  return { busy: running.length ? running[running.length - 1] : null, error, run };
}
