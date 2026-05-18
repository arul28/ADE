import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const STORAGE_KEY = "ade.modelPicker.perSurfaceDefaults.v1";

function readPersisted(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== "string" || !key) continue;
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(values: Record<string, string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // ignore — defaults are convenience state.
  }
}

type PerSurfaceDefaultsState = {
  defaults: Record<string, string>;
  setDefault: (surfaceKey: string, modelId: string) => void;
  getDefault: (surfaceKey: string) => string | null;
};

const usePerSurfaceDefaultsStore = create<PerSurfaceDefaultsState>((set, get) => ({
  defaults: typeof window !== "undefined" ? readPersisted() : {},
  setDefault: (surfaceKey: string, modelId: string) => {
    const key = surfaceKey.trim();
    const id = modelId.trim();
    if (!key || !id) return;
    const current = get().defaults;
    if (current[key] === id) return;
    const next = { ...current, [key]: id };
    set({ defaults: next });
    persist(next);
  },
  getDefault: (surfaceKey: string) => {
    const value = get().defaults[surfaceKey.trim()];
    return value && value.length > 0 ? value : null;
  },
}));

export function usePerSurfaceModelDefaults(): {
  defaults: Record<string, string>;
  setDefault: (surfaceKey: string, modelId: string) => void;
  getDefault: (surfaceKey: string) => string | null;
} {
  return usePerSurfaceDefaultsStore(
    useShallow((state) => ({
      defaults: state.defaults,
      setDefault: state.setDefault,
      getDefault: state.getDefault,
    })),
  );
}
