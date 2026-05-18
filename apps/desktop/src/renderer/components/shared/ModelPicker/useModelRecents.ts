import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const STORAGE_KEY = "ade.modelPicker.recents.v1";
const MAX_RECENTS = 10;
const PERSIST_DEBOUNCE_MS = 500;

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

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingValues: string[] | null = null;

function schedulePersist(values: string[]): void {
  pendingValues = values;
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const toWrite = pendingValues;
    pendingValues = null;
    if (toWrite == null) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toWrite));
    } catch {
      // ignore — recents are convenience state.
    }
  }, PERSIST_DEBOUNCE_MS);
}

type RecentsState = {
  recents: string[];
  recordUsage: (modelId: string) => void;
};

const useRecentsStore = create<RecentsState>((set, get) => ({
  recents: typeof window !== "undefined" ? readPersisted() : [],
  recordUsage: (modelId: string) => {
    const id = modelId.trim();
    if (!id) return;
    const current = get().recents;
    const filtered = current.filter((entry) => entry !== id);
    const next = [id, ...filtered].slice(0, MAX_RECENTS);
    set({ recents: next });
    schedulePersist(next);
  },
}));

export function useModelRecents(): {
  recents: string[];
  recordUsage: (modelId: string) => void;
  recordRecent: (modelId: string) => void;
} {
  return useRecentsStore(
    useShallow((state) => ({
      recents: state.recents,
      recordUsage: state.recordUsage,
      recordRecent: state.recordUsage,
    })),
  );
}
