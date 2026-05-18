import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// Authoritative storage lives in the ade-cli main process so favorites sync
// across desktop, TUI, and iOS surfaces. We keep a localStorage cache so the
// initial render is instant while the RPC roundtrip completes in the
// background, and so the picker still works when the runtime isn't bound.
const STORAGE_KEY = "ade.modelPicker.favorites.v1";

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

function getRpcApi():
  | {
      getFavorites: () => Promise<{ favorites: string[] }>;
      toggleFavorite: (id: string) => Promise<{ favorites: string[]; isFavorite: boolean }>;
    }
  | null {
  if (typeof window === "undefined") return null;
  const ade = (window as unknown as { ade?: { modelPicker?: unknown } }).ade;
  const picker = ade?.modelPicker as
    | {
        getFavorites?: () => Promise<{ favorites: string[] }>;
        toggleFavorite?: (id: string) => Promise<{ favorites: string[]; isFavorite: boolean }>;
      }
    | undefined;
  if (!picker?.getFavorites || !picker.toggleFavorite) return null;
  return picker as {
    getFavorites: () => Promise<{ favorites: string[] }>;
    toggleFavorite: (id: string) => Promise<{ favorites: string[]; isFavorite: boolean }>;
  };
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
    set({ favorites: next });
    persist(next);
    const api = getRpcApi();
    if (!api) return;
    void api
      .toggleFavorite(id)
      .then((result) => {
        const authoritative = Array.isArray(result?.favorites) ? result.favorites : null;
        if (!authoritative) return;
        set({ favorites: authoritative });
        persist(authoritative);
      })
      .catch(() => {
        // Keep the optimistic update on RPC failure — we'll reconcile on next hydrate.
      });
  },
  isFavorite: (modelId: string) => get().favorites.includes(modelId),
  hydrateFromRemote: async () => {
    const api = getRpcApi();
    if (!api) {
      set({ hydrated: true });
      return;
    }
    try {
      const result = await api.getFavorites();
      const authoritative = Array.isArray(result?.favorites) ? result.favorites : [];
      set({ favorites: authoritative, hydrated: true });
      persist(authoritative);
    } catch {
      set({ hydrated: true });
    }
  },
}));

let hydrationStarted = false;

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
    if (hydrationStarted || hydrated) return;
    hydrationStarted = true;
    void hydrateFromRemote();
  }, [hydrateFromRemote, hydrated]);

  return { favorites, toggleFavorite, isFavorite };
}
