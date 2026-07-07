type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type LocalState = {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
};

export function createLocalState(getProjectId: () => string | null): LocalState {
  function storage(): StorageLike | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  }

  function storageKey(key: string): string {
    return `ade-web:${getProjectId() ?? "global"}:${key}`;
  }

  return {
    get<T>(key: string, fallback: T): T {
      const store = storage();
      if (!store) return fallback;
      try {
        const raw = store.getItem(storageKey(key));
        return raw === null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    set<T>(key: string, value: T): void {
      const store = storage();
      if (!store) return;
      try {
        store.setItem(storageKey(key), JSON.stringify(value));
      } catch {
        // Browser storage can be unavailable or full. Local fallbacks should not
        // block the renderer from booting.
      }
    },
    remove(key: string): void {
      const store = storage();
      if (!store) return;
      try {
        store.removeItem(storageKey(key));
      } catch {
        // See set(): storage failures are non-fatal for the web adapter.
      }
    },
  };
}
