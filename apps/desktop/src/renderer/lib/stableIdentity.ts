import { useRef } from "react";

/** Compare maps by key/value identity so derived values can retain identity across renders. */
export function sameMapContents<K, V>(previous: ReadonlyMap<K, V>, next: ReadonlyMap<K, V>): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const [key, value] of next) {
    if (!previous.has(key) || previous.get(key) !== value) return false;
  }
  return true;
}

/** Compare set contents so derived values can retain identity across renders. */
export function sameSetContents<T>(previous: ReadonlySet<T>, next: ReadonlySet<T>): boolean {
  if (previous === next) return true;
  if (previous.size !== next.size) return false;
  for (const value of next) if (!previous.has(value)) return false;
  return true;
}

/** Compare ordered key lists used by virtualized transcript rows. */
export function sameKeyList(previous: readonly string[], next: readonly string[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

/** Retain a derived value's identity while its relevant contents are unchanged. */
export function useStableIdentity<T>(next: T, isSame: (previous: T, next: T) => boolean): T {
  const ref = useRef(next);
  if (ref.current !== next && !isSame(ref.current, next)) {
    ref.current = next;
  }
  return ref.current;
}
