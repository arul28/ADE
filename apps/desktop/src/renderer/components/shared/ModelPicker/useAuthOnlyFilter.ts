import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// "Only models I can use". Off by default, so the picker lists every model
// ADE offers and a signed-out one is still selectable. A new key (the old one
// was `ade.modelPicker.authOnly.v1`, on by default) resets everyone once.
const STORAGE_KEY = "ade.modelPicker.onlyUsable.v1";

function readPersisted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
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
  authOnly: typeof window !== "undefined" ? readPersisted() : false,
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
