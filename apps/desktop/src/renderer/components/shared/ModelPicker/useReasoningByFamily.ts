import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ProviderFamily } from "../../../../shared/modelRegistry";

const STORAGE_KEY = "ade.modelPicker.reasoningByFamily.v1";

type ReasoningMap = Partial<Record<ProviderFamily, string>>;

function readPersisted(): ReasoningMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ReasoningMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        out[key as ProviderFamily] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persist(map: ReasoningMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore — preference falls back to in-memory state.
  }
}

type ReasoningByFamilyState = {
  byFamily: ReasoningMap;
  rememberReasoning: (family: ProviderFamily, effort: string | null) => void;
};

const useReasoningByFamilyStore = create<ReasoningByFamilyState>((set, get) => ({
  byFamily: typeof window !== "undefined" ? readPersisted() : {},
  rememberReasoning: (family, effort) => {
    const current = get().byFamily;
    const next: ReasoningMap = { ...current };
    if (effort == null || effort.length === 0) {
      if (!(family in next)) return;
      delete next[family];
    } else {
      if (next[family] === effort) return;
      next[family] = effort;
    }
    set({ byFamily: next });
    persist(next);
  },
}));

export function useReasoningByFamily(): {
  byFamily: ReasoningMap;
  rememberReasoning: (family: ProviderFamily, effort: string | null) => void;
  getReasoningForFamily: (family: ProviderFamily) => string | null;
} {
  const slice = useReasoningByFamilyStore(
    useShallow((state) => ({
      byFamily: state.byFamily,
      rememberReasoning: state.rememberReasoning,
    })),
  );
  return {
    byFamily: slice.byFamily,
    rememberReasoning: slice.rememberReasoning,
    getReasoningForFamily: (family) => slice.byFamily[family] ?? null,
  };
}
