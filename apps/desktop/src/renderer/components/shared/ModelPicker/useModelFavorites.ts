import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

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
    // ignore — favorites are convenience state.
  }
}

type FavoritesState = {
  favorites: string[];
  toggleFavorite: (modelId: string) => void;
  isFavorite: (modelId: string) => boolean;
};

const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: typeof window !== "undefined" ? readPersisted() : [],
  toggleFavorite: (modelId: string) => {
    const id = modelId.trim();
    if (!id) return;
    const current = get().favorites;
    const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    set({ favorites: next });
    persist(next);
  },
  isFavorite: (modelId: string) => get().favorites.includes(modelId),
}));

export function useModelFavorites(): {
  favorites: string[];
  toggleFavorite: (modelId: string) => void;
  isFavorite: (modelId: string) => boolean;
} {
  return useFavoritesStore(
    useShallow((state) => ({
      favorites: state.favorites,
      toggleFavorite: state.toggleFavorite,
      isFavorite: state.isFavorite,
    })),
  );
}
