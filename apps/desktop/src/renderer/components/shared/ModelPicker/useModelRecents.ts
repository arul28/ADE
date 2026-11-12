import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { OpenProjectBinding } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";

// Recents belong to this client (`localStorage`), not to a machine: the same
// list on every project tab. A client that has never saved a list reads it
// once from the tab's copy, where older versions kept it, and then keeps it
// here. Nothing writes back to a machine.
const STORAGE_KEY = "ade.modelPicker.recents.v1";
const MAX_RECENTS = 10;

function hasPersisted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

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

function getImportApi(): ((pin: OpenProjectBinding) => Promise<{ recents: string[] }>) | null {
  if (typeof window === "undefined") return null;
  const getRecents = window.ade?.modelPicker?.getRecents;
  return typeof getRecents === "function" ? getRecents : null;
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
    set({ recents: next, hydrated: true });
    persistCache(next);
  },
  hydrateFromRemote: async () => {
    if (hasPersisted()) {
      set({ hydrated: true });
      return;
    }
    // The one-time import reads the old list from the tab's copy.
    const pin = useAppStore.getState().projectBinding;
    const getRecents = getImportApi();
    // No tab open or no bridge yet: stay unhydrated so a later mount imports.
    if (!pin || !getRecents) return;
    try {
      const result = await getRecents(pin);
      const imported = Array.isArray(result?.recents) ? result.recents.slice(0, MAX_RECENTS) : [];
      // A pick made while the import was in flight wins.
      if (hasPersisted()) {
        set({ hydrated: true });
        return;
      }
      set({ recents: imported, hydrated: true });
      persistCache(imported);
    } catch {
      set({ hydrated: true });
    }
  },
}));

type UseModelRecentsOptions = {
  hydrate?: boolean;
};

export function useModelRecents(options: UseModelRecentsOptions = {}): {
  recents: string[];
  recordUsage: (modelId: string) => void;
  recordRecent: (modelId: string) => void;
} {
  const hydrate = options.hydrate ?? true;
  const { recents, recordUsage, hydrateFromRemote, hydrated } = useRecentsStore(
    useShallow((state) => ({
      recents: state.recents,
      recordUsage: state.recordUsage,
      hydrateFromRemote: state.hydrateFromRemote,
      hydrated: state.hydrated,
    })),
  );

  useEffect(() => {
    if (!hydrate) return;
    if (hydrated) return;
    void hydrateFromRemote();
  }, [hydrate, hydrateFromRemote, hydrated]);

  return { recents, recordUsage, recordRecent: recordUsage };
}
