import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { OpenProjectBinding } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { captureError } from "../../../../shared/sentry/capture";

// Recents belong to this client (`localStorage`), not to a machine: the same
// list on every project tab. Older versions kept the list on the tab's
// machine, so this client reads it once from there and merges it after its
// own picks. Nothing writes back to a machine.
const STORAGE_KEY = "ade.modelPicker.recents.v1";
/** Set once the machine's list was merged in; until then each start tries again. */
const IMPORTED_KEY = "ade.modelPicker.recents.imported.v1";
const MAX_RECENTS = 10;

function importDone(): boolean {
  try {
    return window.localStorage.getItem(IMPORTED_KEY) != null;
  } catch {
    return false;
  }
}

function markImportDone(): void {
  try {
    window.localStorage.setItem(IMPORTED_KEY, "1");
  } catch {
    // Not saved: the next start merges the same list again, which changes nothing.
  }
}

/** This client's picks first (newest), then the machine's older ones. */
function mergeRecents(local: readonly string[], imported: readonly string[]): string[] {
  const merged: string[] = [];
  for (const value of [...local, ...imported]) {
    if (typeof value === "string" && value.length > 0 && !merged.includes(value)) merged.push(value);
  }
  return merged.slice(0, MAX_RECENTS);
}

let importInFlight: Promise<void> | null = null;

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
    set({ recents: next });
    persistCache(next);
  },
  hydrateFromRemote: async () => {
    if (importDone()) {
      set({ hydrated: true });
      return;
    }
    if (importInFlight) return importInFlight;
    // The one-time import reads the old list from the tab's copy.
    const pin = useAppStore.getState().projectBinding;
    const getRecents = getImportApi();
    // No tab open or no bridge yet: stay unhydrated so a later mount imports.
    if (!pin || !getRecents) return;
    importInFlight = (async () => {
      try {
        const result = await getRecents(pin);
        const imported = Array.isArray(result?.recents) ? result.recents : [];
        // A pick made while the import ran stays in front: the lists merge.
        const next = mergeRecents(get().recents, imported);
        set({ recents: next, hydrated: true });
        persistCache(next);
        markImportDone();
      } catch (error) {
        // The list here stays as it is; the next start tries the import again.
        captureError(error, { fingerprint: ["model-picker", "recents-import"], level: "warning", handled: true });
        set({ hydrated: true });
      } finally {
        importInFlight = null;
      }
    })();
    return importInFlight;
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
