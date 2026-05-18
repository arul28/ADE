import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useEffect } from "react";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import type { AuthStatus } from "./ModelPickerRail";

type AuthStatusMap = Partial<Record<ProviderFamily, AuthStatus>>;

type ProviderAuthStore = {
  status: AuthStatusMap;
  opencodeBinaryInstalled: boolean;
  loaded: boolean;
  inFlight: Promise<void> | null;
  setStatus: (status: AuthStatusMap, opencodeBinaryInstalled: boolean) => void;
  setInFlight: (promise: Promise<void> | null) => void;
};

const useProviderAuthStore = create<ProviderAuthStore>((set) => ({
  status: {},
  opencodeBinaryInstalled: false,
  loaded: false,
  inFlight: null,
  setStatus: (status, opencodeBinaryInstalled) =>
    set({ status, opencodeBinaryInstalled, loaded: true, inFlight: null }),
  setInFlight: (promise) => set({ inFlight: promise }),
}));

// AiClaudeAvailability is an object with `binary.present` + `auth.ready` —
// historic callers also passed plain booleans, so accept both. We treat Claude
// as "ok" whenever auth.ready is true (binary may be bundled and present even
// when path discovery says otherwise), and fall back to binary.present so the
// rail dot is still informative when only the binary half is known.
function isClaudeOk(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") return false;
  const claude = value as {
    auth?: { ready?: boolean };
    binary?: { present?: boolean };
    runtimeAvailable?: boolean;
  };
  if (claude.auth?.ready === true) return true;
  if (claude.runtimeAvailable === true) return true;
  return false;
}

export function familiesFromStatus(status: {
  availableProviders?: { claude?: unknown; codex?: unknown; cursor?: unknown; droid?: unknown };
  opencodeProviders?: Array<{ id: string; connected: boolean }>;
}): AuthStatusMap {
  const out: AuthStatusMap = {};
  out.anthropic = isClaudeOk(status.availableProviders?.claude) ? "ok" : "unauthed";
  out.openai = status.availableProviders?.codex === true ? "ok" : "unauthed";
  out.cursor = status.availableProviders?.cursor === true ? "ok" : "unauthed";
  out.factory = status.availableProviders?.droid === true ? "ok" : "unauthed";

  const opencodeAny =
    Array.isArray(status.opencodeProviders) && status.opencodeProviders.some((p) => p.connected);
  if (opencodeAny) out.opencode = "ok";

  return out;
}

export function opencodeBinaryInstalledFromStatus(status: { opencodeBinaryInstalled?: unknown }): boolean {
  return status.opencodeBinaryInstalled === true;
}

async function fetchStatus(): Promise<void> {
  const store = useProviderAuthStore.getState();
  if (store.inFlight) return store.inFlight;
  const ade = (window as unknown as { ade?: { ai?: { getStatus?: (args?: unknown) => Promise<unknown> } } }).ade;
  const getStatus = ade?.ai?.getStatus;
  if (typeof getStatus !== "function") {
    store.setStatus({}, false);
    return;
  }
  const promise = (async () => {
    try {
      const raw = (await getStatus()) as Parameters<typeof familiesFromStatus>[0] & {
        opencodeBinaryInstalled?: unknown;
      };
      const safe = raw ?? {};
      useProviderAuthStore
        .getState()
        .setStatus(familiesFromStatus(safe), opencodeBinaryInstalledFromStatus(safe));
    } catch {
      useProviderAuthStore.getState().setStatus({}, false);
    }
  })();
  store.setInFlight(promise);
  return promise;
}

export function useProviderAuthStatus(): {
  status: AuthStatusMap;
  opencodeBinaryInstalled: boolean;
  loaded: boolean;
} {
  const slice = useProviderAuthStore(
    useShallow((state) => ({
      status: state.status,
      opencodeBinaryInstalled: state.opencodeBinaryInstalled,
      loaded: state.loaded,
    })),
  );
  // Refetch on every mount — picker mounts on popover open, so the user
  // signing into a provider in Settings then reopening the picker gets fresh
  // status without polling. Concurrent calls are dedup'd via `inFlight`.
  useEffect(() => {
    void fetchStatus();
  }, []);
  return slice;
}
