import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const STORAGE_KEY = "ade.modelPicker.authOnly.v1";

function readPersisted(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "false";
  } catch {
    return true;
  }
}

function persist(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    // ignore — preference falls back to in-memory state.
  }
}

type AuthOnlyState = {
  authOnly: boolean;
  toggleAuthOnly: () => void;
  setAuthOnly: (value: boolean) => void;
};

const useAuthOnlyStore = create<AuthOnlyState>((set, get) => ({
  authOnly: typeof window !== "undefined" ? readPersisted() : true,
  toggleAuthOnly: () => {
    const next = !get().authOnly;
    set({ authOnly: next });
    persist(next);
  },
  setAuthOnly: (value: boolean) => {
    if (get().authOnly === value) return;
    set({ authOnly: value });
    persist(value);
  },
}));

export function useAuthOnlyFilter(): {
  authOnly: boolean;
  toggleAuthOnly: () => void;
  setAuthOnly: (value: boolean) => void;
} {
  return useAuthOnlyStore(
    useShallow((state) => ({
      authOnly: state.authOnly,
      toggleAuthOnly: state.toggleAuthOnly,
      setAuthOnly: state.setAuthOnly,
    })),
  );
}
