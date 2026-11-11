import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One owner for a message that clears itself. Setting a new value cancels the
 * previous timer, so an older message cannot erase a newer one, and unmounting
 * stops the timer instead of a later `setState`.
 */
export function useAutoDismiss<T>(clearedValue: T, holdMs: number): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(clearedValue);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const set = useCallback((next: T) => {
    clearTimer();
    setValue(next);
    if (next === clearedValue) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setValue(clearedValue);
    }, holdMs);
  }, [clearTimer, clearedValue, holdMs]);

  return [value, set];
}
