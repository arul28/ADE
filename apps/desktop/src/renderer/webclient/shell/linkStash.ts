// One value the web app holds across a sign-in round trip, in localStorage
// with the time it was saved. It is localStorage, not sessionStorage, because
// some browsers end the sign-in round trip in a different session-storage
// namespace. A short TTL keeps an abandoned value from acting on a later,
// unrelated visit. A browser that denies storage loses the value, and the app
// opens as usual.

type Stored = { value: unknown; savedAtMs: number };

export type LinkStash<T> = {
  write(value: T, nowMs?: number): void;
  /** The kept value, if it is fresh and still parses; anything else is removed. */
  read(nowMs?: number): T | null;
  remove(): void;
};

/** `legacyField` names the field an older build wrote the value under, so a link saved just before a deploy still restores. */
export function createLinkStash<T>({ key, ttlMs, parse, legacyField }: { key: string; ttlMs: number; parse: (value: unknown) => T | null; legacyField?: string }): LinkStash<T> {
  const remove = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage denied: nothing is kept.
    }
  };
  return {
    write(value, nowMs = Date.now()) {
      try {
        const stored: Stored = { value, savedAtMs: nowMs };
        localStorage.setItem(key, JSON.stringify(stored));
      } catch {
        // Storage denied: the value is lost.
      }
    },
    read(nowMs = Date.now()) {
      let raw: string | null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        return null;
      }
      if (!raw) return null;
      let value: T | null = null;
      try {
        const stored = JSON.parse(raw) as (Partial<Stored> & Record<string, unknown>) | null;
        const savedAtMs = typeof stored?.savedAtMs === "number" ? stored.savedAtMs : Number.NaN;
        const age = nowMs - savedAtMs;
        if (Number.isFinite(age) && age >= 0 && age <= ttlMs) value = parse(stored?.value ?? (legacyField ? stored?.[legacyField] : undefined));
      } catch {
        value = null;
      }
      if (value === null) remove();
      return value;
    },
    remove,
  };
}
