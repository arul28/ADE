import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { OpenProjectBinding } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { captureError } from "../../../../shared/sentry/capture";

// Favorites belong to this client (`localStorage`), not to a machine: the
// same list on every project tab. Older versions kept the list on the tab's
// machine, so this client reads it once from there and merges it into its
// own list. Nothing writes back to a machine.
const STORAGE_KEY = "ade.modelPicker.favorites.v1";
/** Set once the machine's list was merged in; until then each start tries again. */
const IMPORTED_KEY = "ade.modelPicker.favorites.imported.v1";

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

/**
 * The machine's list with this client's own picks added after it. A model
 * removed here while the import ran stays removed.
 */
function mergeFavorites(imported: readonly string[], local: readonly string[], removed: ReadonlySet<string>): string[] {
  const merged = imported.filter((value) => typeof value === "string" && value.length > 0 && !removed.has(value));
  for (const value of local) if (!merged.includes(value)) merged.push(value);
  return merged;
}

let importInFlight: Promise<void> | null = null;
/** Models removed while the import runs; the merge must not add them back. */
const removedDuringImport = new Set<string>();

function readPersisted(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function persist(values: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // ignore — cache is convenience state.
  }
}

function getImportApi(): ((pin: OpenProjectBinding) => Promise<{ favorites: string[] }>) | null {
  if (typeof window === "undefined") return null;
  const getFavorites = window.ade?.modelPicker?.getFavorites;
  return typeof getFavorites === "function" ? getFavorites : null;
}

type FavoritesState = {
  favorites: string[];
  hydrated: boolean;
  toggleFavorite: (modelId: string) => void;
  isFavorite: (modelId: string) => boolean;
  hydrateFromRemote: () => Promise<void>;
};

const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: typeof window !== "undefined" ? readPersisted() : [],
  hydrated: false,
  toggleFavorite: (modelId: string) => {
    const id = modelId.trim();
    if (!id) return;
    const current = get().favorites;
    const removing = current.includes(id);
    const next = removing ? current.filter((entry) => entry !== id) : [...current, id];
    if (importInFlight) {
      if (removing) removedDuringImport.add(id);
      else removedDuringImport.delete(id);
    }
    set({ favorites: next });
    persist(next);
  },
  isFavorite: (modelId: string) => get().favorites.includes(modelId),
  hydrateFromRemote: async () => {
    if (importDone()) {
      set({ hydrated: true });
      return;
    }
    if (importInFlight) return importInFlight;
    // The one-time import reads the old list from the tab's copy.
    const pin = useAppStore.getState().projectBinding;
    const getFavorites = getImportApi();
    // No tab open or no bridge yet: stay unhydrated so a later mount imports.
    if (!pin || !getFavorites) return;
    importInFlight = (async () => {
      try {
        const result = await getFavorites(pin);
        const imported = Array.isArray(result?.favorites) ? result.favorites : [];
        // A toggle made while the import ran is kept: the lists merge, and a removal stays.
        const next = mergeFavorites(imported, get().favorites, removedDuringImport);
        set({ favorites: next, hydrated: true });
        persist(next);
        markImportDone();
      } catch (error) {
        // The list here stays as it is; the next start tries the import again.
        captureError(error, { fingerprint: ["model-picker", "favorites-import"], level: "warning", handled: true });
        set({ hydrated: true });
      } finally {
        importInFlight = null;
        removedDuringImport.clear();
      }
    })();
    return importInFlight;
  },
}));

export function useModelFavorites(): {
  favorites: string[];
  toggleFavorite: (modelId: string) => void;
  isFavorite: (modelId: string) => boolean;
} {
  const { favorites, toggleFavorite, isFavorite, hydrateFromRemote, hydrated } = useFavoritesStore(
    useShallow((state) => ({
      favorites: state.favorites,
      toggleFavorite: state.toggleFavorite,
      isFavorite: state.isFavorite,
      hydrateFromRemote: state.hydrateFromRemote,
      hydrated: state.hydrated,
    })),
  );

  useEffect(() => {
    if (hydrated) return;
    void hydrateFromRemote();
  }, [hydrateFromRemote, hydrated]);

  return { favorites, toggleFavorite, isFavorite };
}
