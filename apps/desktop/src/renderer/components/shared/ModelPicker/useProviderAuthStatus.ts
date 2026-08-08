import { useShallow } from "zustand/react/shallow";
import { useEffect, useState } from "react";
import type { ProviderFamily } from "../../../../shared/modelRegistry";
import {
  AI_STATUS_CACHE_INVALIDATED_EVENT,
  AI_STATUS_CACHE_UPDATED_EVENT,
  getAiStatusCached,
  peekAiStatusCached,
  type AiStatusCacheInvalidatedEventDetail,
  type AiStatusCacheUpdatedEventDetail,
} from "../../../lib/aiDiscoveryCache";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";
import type { AuthStatus } from "./ModelPickerRail";

type AuthStatusMap = Partial<Record<ProviderFamily, AuthStatus>>;

type ProviderStatusSnapshot = {
  availableProviders?: { claude?: unknown; codex?: unknown; cursor?: unknown; droid?: unknown };
  providerConnections?: { pi?: { authAvailable?: boolean; runtimeAvailable?: boolean } };
  piInstallation?: { sdkAvailable?: boolean; cliAvailable?: boolean; availableModelIds?: string[] };
  opencodeProviders?: Array<{ id: string; connected: boolean }>;
  opencodeBinaryInstalled?: unknown;
};

type ProviderBinarySnapshot = {
  opencodeBinaryInstalled: boolean;
  binaryProbed: boolean;
};

const EMPTY_AUTH_STATUS: AuthStatusMap = {};
const UNKNOWN_BINARY: ProviderBinarySnapshot = {
  opencodeBinaryInstalled: false,
  binaryProbed: false,
};
const binaryProbeRequests = new Map<string, Promise<boolean | null>>();

function authStatusMapsEqual(left: AuthStatusMap, right: AuthStatusMap): boolean {
  const keys = new Set<ProviderFamily>([
    ...(Object.keys(left) as ProviderFamily[]),
    ...(Object.keys(right) as ProviderFamily[]),
  ]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

export function resetProviderAuthStatusForTests(): void {
  binaryProbeRequests.clear();
}

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

export function familiesFromStatus(
  status: ProviderStatusSnapshot,
  options?: { allowCliOnlyModels?: boolean },
): AuthStatusMap {
  const out: AuthStatusMap = {};
  out.anthropic = isClaudeOk(status.availableProviders?.claude) ? "ok" : "unauthed";
  out.openai = status.availableProviders?.codex === true ? "ok" : "unauthed";
  out.cursor = status.availableProviders?.cursor === true ? "ok" : "unauthed";
  out.factory = status.availableProviders?.droid === true ? "ok" : "unauthed";

  const opencodeAny =
    Array.isArray(status.opencodeProviders) && status.opencodeProviders.some((p) => p.connected);
  if (opencodeAny) out.opencode = "ok";
  const pi = status.providerConnections?.pi;
  const piSdkAvailable = status.piInstallation?.sdkAvailable === true;
  const piCliAvailable = status.piInstallation?.cliAvailable === true;
  const piRuntimeUsable = piSdkAvailable || (options?.allowCliOnlyModels === true && piCliAvailable);
  const piHasModels = (status.piInstallation?.availableModelIds?.length ?? 0) > 0;
  if (piRuntimeUsable && (pi?.runtimeAvailable === true || pi?.authAvailable === true || piHasModels)) {
    out.pi = "ok";
  } else if (status.piInstallation || pi) {
    out.pi = "unauthed";
  }

  return out;
}

export function opencodeBinaryInstalledFromStatus(status: { opencodeBinaryInstalled?: unknown }): boolean {
  return status.opencodeBinaryInstalled === true;
}

/**
 * Cheap synchronous-ish IPC call that only resolves whether the OpenCode
 * binary exists on PATH/known dirs. Returns in milliseconds — no server boot,
 * no probe. Used to flip the OpenCode-gated empty state without waiting on
 * the slow getStatus() roundtrip.
 */
function probeBinary(scopeKey: string): Promise<boolean | null> {
  const existing = binaryProbeRequests.get(scopeKey);
  if (existing) return existing;
  const check = window.ade?.ai?.isOpenCodeInstalled;
  if (typeof check !== "function") return Promise.resolve(null);
  let request: Promise<boolean | null>;
  request = check()
    .then((result) => result.installed === true)
    .catch(() => null)
    .finally(() => {
      if (binaryProbeRequests.get(scopeKey) === request) {
        binaryProbeRequests.delete(scopeKey);
      }
    });
  binaryProbeRequests.set(scopeKey, request);
  return request;
}

export function useProviderAuthStatus(options?: { loadStatus?: boolean; allowCliOnlyModels?: boolean }): {
  status: AuthStatusMap;
  opencodeBinaryInstalled: boolean;
  /** True once we have a definitive answer for opencodeBinaryInstalled (cheap probe done). */
  binaryProbed: boolean;
  loaded: boolean;
} {
  const { projectRoot, binaryScopeKey } = useAppStore(
    useShallow((state) => {
      const activeProjectRoot = selectActiveProjectRoot(state);
      return {
        projectRoot: activeProjectRoot,
        binaryScopeKey: `${state.projectBinding?.key ?? "local"}::${activeProjectRoot ?? "<no-project>"}`,
      };
    }),
  );
  const cachedStatus = peekAiStatusCached(projectRoot);
  const [status, setStatus] = useState<AuthStatusMap>(() => (
    cachedStatus ? familiesFromStatus(cachedStatus, options) : EMPTY_AUTH_STATUS
  ));
  const [loaded, setLoaded] = useState(cachedStatus != null);
  const [binary, setBinary] = useState<ProviderBinarySnapshot>(() => (
    typeof cachedStatus?.opencodeBinaryInstalled === "boolean"
      ? {
          opencodeBinaryInstalled: opencodeBinaryInstalledFromStatus(cachedStatus),
          binaryProbed: true,
        }
      : UNKNOWN_BINARY
  ));

  useEffect(() => {
    let active = true;
    const cached = peekAiStatusCached(projectRoot);
    setBinary(
      typeof cached?.opencodeBinaryInstalled === "boolean"
        ? {
            opencodeBinaryInstalled: opencodeBinaryInstalledFromStatus(cached),
            binaryProbed: true,
          }
        : UNKNOWN_BINARY,
    );
    void probeBinary(binaryScopeKey).then((installed) => {
      if (!active || installed == null) return;
      setBinary({ opencodeBinaryInstalled: installed, binaryProbed: true });
    });
    return () => {
      active = false;
    };
  }, [binaryScopeKey, projectRoot]);

  useEffect(() => {
    if (options?.loadStatus === false) return;
    let active = true;

    const applyStatus = (nextStatus: ProviderStatusSnapshot) => {
      if (!active) return;
      const nextAuthStatus = familiesFromStatus(nextStatus, options);
      setStatus((current) => authStatusMapsEqual(current, nextAuthStatus) ? current : nextAuthStatus);
      setLoaded(true);
      if (typeof nextStatus.opencodeBinaryInstalled === "boolean") {
        setBinary({
          opencodeBinaryInstalled: opencodeBinaryInstalledFromStatus(nextStatus),
          binaryProbed: true,
        });
      }
    };

    const cached = peekAiStatusCached(projectRoot);
    if (cached) {
      applyStatus(cached);
    } else {
      setStatus(EMPTY_AUTH_STATUS);
      setLoaded(false);
    }

    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<AiStatusCacheUpdatedEventDetail>).detail;
      if ((detail?.projectRoot ?? null) !== projectRoot) return;
      const updated = peekAiStatusCached(projectRoot);
      if (updated) applyStatus(updated);
    };
    const onInvalidated = (event: Event) => {
      const detail = (event as CustomEvent<AiStatusCacheInvalidatedEventDetail>).detail;
      if (detail && !detail.allProjects && detail.projectRoot !== projectRoot) return;
      setStatus(EMPTY_AUTH_STATUS);
      setLoaded(false);
    };
    window.addEventListener(AI_STATUS_CACHE_UPDATED_EVENT, onUpdated);
    window.addEventListener(AI_STATUS_CACHE_INVALIDATED_EVENT, onInvalidated);

    const bridge = window.ade?.ai?.getStatus;
    if (typeof bridge === "function") {
      void getAiStatusCached({ projectRoot }).then(applyStatus).catch(() => undefined);
    }

    return () => {
      active = false;
      window.removeEventListener(AI_STATUS_CACHE_UPDATED_EVENT, onUpdated);
      window.removeEventListener(AI_STATUS_CACHE_INVALIDATED_EVENT, onInvalidated);
    };
  }, [options?.allowCliOnlyModels, options?.loadStatus, projectRoot]);

  return {
    status,
    loaded,
    ...binary,
  };
}
