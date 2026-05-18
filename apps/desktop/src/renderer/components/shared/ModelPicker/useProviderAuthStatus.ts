import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useEffect } from "react";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import type { AuthStatus } from "./ModelPickerRail";

type AuthStatusMap = Partial<Record<ProviderFamily, AuthStatus>>;

type ProviderAuthStore = {
  status: AuthStatusMap;
  loaded: boolean;
  inFlight: Promise<void> | null;
  setStatus: (status: AuthStatusMap) => void;
  setInFlight: (promise: Promise<void> | null) => void;
};

const useProviderAuthStore = create<ProviderAuthStore>((set) => ({
  status: {},
  loaded: false,
  inFlight: null,
  setStatus: (status) => set({ status, loaded: true, inFlight: null }),
  setInFlight: (promise) => set({ inFlight: promise }),
}));

function familiesFromStatus(status: {
  availableProviders?: { claude?: unknown; codex?: unknown; cursor?: unknown; droid?: unknown };
  opencodeProviders?: Array<{ id: string; connected: boolean }>;
}): AuthStatusMap {
  const out: AuthStatusMap = {};
  const claude = status.availableProviders?.claude;
  const claudeOk =
    typeof claude === "boolean"
      ? claude
      : Boolean(claude && typeof claude === "object" && (claude as { runtimeAvailable?: boolean }).runtimeAvailable);
  out.anthropic = claudeOk ? "ok" : "unauthed";
  out.openai = status.availableProviders?.codex === true ? "ok" : "unauthed";
  out.cursor = status.availableProviders?.cursor === true ? "ok" : "unauthed";
  out.factory = status.availableProviders?.droid === true ? "ok" : "unauthed";

  const opencodeAny =
    Array.isArray(status.opencodeProviders) && status.opencodeProviders.some((p) => p.connected);
  if (opencodeAny) out.opencode = "ok";

  return out;
}

async function fetchStatus(): Promise<void> {
  const store = useProviderAuthStore.getState();
  if (store.inFlight) return store.inFlight;
  const ade = (window as unknown as { ade?: { ai?: { getStatus?: (args?: unknown) => Promise<unknown> } } }).ade;
  const getStatus = ade?.ai?.getStatus;
  if (typeof getStatus !== "function") {
    store.setStatus({});
    return;
  }
  const promise = (async () => {
    try {
      const raw = (await getStatus()) as Parameters<typeof familiesFromStatus>[0];
      useProviderAuthStore.getState().setStatus(familiesFromStatus(raw ?? {}));
    } catch {
      useProviderAuthStore.getState().setStatus({});
    }
  })();
  store.setInFlight(promise);
  return promise;
}

export function useProviderAuthStatus(): {
  status: AuthStatusMap;
  loaded: boolean;
} {
  const slice = useProviderAuthStore(
    useShallow((state) => ({ status: state.status, loaded: state.loaded })),
  );
  // Refetch on every mount — picker mounts on popover open, so the user
  // signing into a provider in Settings then reopening the picker gets fresh
  // status without polling. Concurrent calls are dedup'd via `inFlight`.
  useEffect(() => {
    void fetchStatus();
  }, []);
  return slice;
}
