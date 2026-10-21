/**
 * One small JSON value in this renderer's localStorage, the way onboarding
 * keeps its per-computer state (progress, suggestions, postponed suggestions,
 * seen "What's new" pages): read once and kept until it changes, written best
 * effort, and announced to this window (`event`) and to other windows (the
 * browser's `storage` event).
 *
 * `parse` gets the stored JSON (undefined when there is none or it does not
 * parse) and returns a valid value; it is where each store checks its shape.
 */

export type LocalStore<T> = {
  readonly key: string;
  /** The current value: the stored one, re-read after another window changed it. */
  get(): T;
  /** Stores `next` (only for this session when storage is unavailable) and tells subscribers. */
  set(next: T): void;
  /** Tells subscribers something that depends on the value changed, with nothing to store. */
  notify(): void;
  /** Calls `listener` when the value changes, in this window or another one. */
  subscribe(listener: () => void): () => void;
};

export function createLocalStore<T>({
  key,
  event,
  parse,
}: {
  key: string;
  event: string;
  parse: (stored: unknown) => T;
}): LocalStore<T> {
  let snapshot: { value: T } | null = null;
  let watchingOtherWindows = false;

  const read = (): T => {
    let stored: unknown;
    try {
      const text = window.localStorage.getItem(key);
      stored = text == null ? undefined : JSON.parse(text);
    } catch {
      stored = undefined;
    }
    return parse(stored);
  };

  // Another window wrote: drop the copy, even with no subscriber to tell.
  const onStorage = (storageEvent: StorageEvent) => {
    if (storageEvent.key === key || storageEvent.key === null) snapshot = null;
  };

  return {
    key,
    get() {
      if (!watchingOtherWindows) {
        watchingOtherWindows = true;
        window.addEventListener("storage", onStorage);
      }
      snapshot ??= { value: read() };
      return snapshot.value;
    },
    set(next) {
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage unavailable: the value holds for this session only.
      }
      snapshot = { value: next };
      window.dispatchEvent(new Event(event));
    },
    notify() {
      window.dispatchEvent(new Event(event));
    },
    subscribe(listener) {
      const onOtherWindow = (storageEvent: StorageEvent) => {
        if (storageEvent.key !== key && storageEvent.key !== null) return;
        snapshot = null;
        listener();
      };
      window.addEventListener(event, listener);
      window.addEventListener("storage", onOtherWindow);
      return () => {
        window.removeEventListener(event, listener);
        window.removeEventListener("storage", onOtherWindow);
      };
    },
  };
}

/** The stored value as an object's own fields, or null when it is not a plain object. */
export function storedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
