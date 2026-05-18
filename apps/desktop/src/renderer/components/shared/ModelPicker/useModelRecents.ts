import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// Authoritative storage lives in the ade-cli main process so recents sync
// across desktop, TUI, and iOS surfaces. localStorage is a hot cache that
// keeps the picker responsive while the RPC roundtrip completes.
const STORAGE_KEY = "ade.modelPicker.recents.v1";
const MAX_RECENTS = 10;

function readPersisted(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function persistCache(values: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // ignore — cache is convenience state.
  }
}

function getRpcApi():
  | {
      getRecents: () => Promise<{ recents: string[] }>;
      pushRecent: (id: string) => Promise<{ recents: string[] }>;
    }
  | null {
  if (typeof window === "undefined") return null;
  const ade = (window as unknown as { ade?: { modelPicker?: unknown } }).ade;
  const picker = ade?.modelPicker as
    | {
        getRecents?: () => Promise<{ recents: string[] }>;
        pushRecent?: (id: string) => Promise<{ recents: string[] }>;
      }
    | undefined;
  if (!picker?.getRecents || !picker.pushRecent) return null;
  return picker as {
    getRecents: () => Promise<{ recents: string[] }>;
    pushRecent: (id: string) => Promise<{ recents: string[] }>;
  };
}

type RecentsState = {
  recents: string[];
  hydrated: boolean;
  recordUsage: (modelId: string) => void;
  hydrateFromRemote: () => Promise<void>;
};

const useRecentsStore = create<RecentsState>((set, get) => ({
  recents: typeof window !== "undefined" ? readPersisted() : [],
  hydrated: false,
  recordUsage: (modelId: string) => {
    const id = modelId.trim();
    if (!id) return;
    const current = get().recents;
    const filtered = current.filter((entry) => entry !== id);
    const next = [id, ...filtered].slice(0, MAX_RECENTS);
    set({ recents: next });
    persistCache(next);
    const api = getRpcApi();
    if (!api) return;
    void api
      .pushRecent(id)
      .then((result) => {
        const authoritative = Array.isArray(result?.recents) ? result.recents : null;
        if (!authoritative) return;
        set({ recents: authoritative });
        persistCache(authoritative);
      })
      .catch(() => {
        // Optimistic update is preserved; we'll reconcile on next hydrate.
      });
  },
  hydrateFromRemote: async () => {
    const api = getRpcApi();
    if (!api) {
      // RPC surface not yet bound — leave hydrated:false so we retry once it
      // becomes available, instead of permanently locking on stale local cache.
      return;
    }
    try {
      const result = await api.getRecents();
      const authoritative = Array.isArray(result?.recents) ? result.recents : [];
      set({ recents: authoritative, hydrated: true });
      persistCache(authoritative);
    } catch {
      set({ hydrated: true });
    }
  },
}));

export function useModelRecents(): {
  recents: string[];
  recordUsage: (modelId: string) => void;
  recordRecent: (modelId: string) => void;
} {
  const { recents, recordUsage, hydrateFromRemote, hydrated } = useRecentsStore(
    useShallow((state) => ({
      recents: state.recents,
      recordUsage: state.recordUsage,
      hydrateFromRemote: state.hydrateFromRemote,
      hydrated: state.hydrated,
    })),
  );

  useEffect(() => {
    if (hydrated) return;
    void hydrateFromRemote();
  }, [hydrateFromRemote, hydrated]);

  return { recents, recordUsage, recordRecent: recordUsage };
}
