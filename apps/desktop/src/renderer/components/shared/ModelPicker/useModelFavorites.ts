import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { OpenProjectBinding } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";

// Favorites belong to this client (`localStorage`), not to a machine: the
// same list on every project tab. A client that has never saved a list reads
// it once from the tab's copy, where older versions kept it, and then keeps it
// here. Nothing writes back to a machine.
const STORAGE_KEY = "ade.modelPicker.favorites.v1";

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
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    set({ favorites: next, hydrated: true });
    persist(next);
  },
  isFavorite: (modelId: string) => get().favorites.includes(modelId),
  hydrateFromRemote: async () => {
    if (hasPersisted()) {
      set({ hydrated: true });
      return;
    }
    // The one-time import reads the old list from the tab's copy.
    const pin = useAppStore.getState().projectBinding;
    const getFavorites = getImportApi();
    // No tab open or no bridge yet: stay unhydrated so a later mount imports.
    if (!pin || !getFavorites) return;
    try {
      const result = await getFavorites(pin);
      const imported = Array.isArray(result?.favorites) ? result.favorites : [];
      // A toggle made while the import was in flight wins.
      if (hasPersisted()) {
        set({ hydrated: true });
        return;
      }
      set({ favorites: imported, hydrated: true });
      persist(imported);
    } catch {
      set({ hydrated: true });
    }
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
