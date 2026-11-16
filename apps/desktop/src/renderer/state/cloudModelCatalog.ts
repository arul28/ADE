import { useEffect, useSyncExternalStore } from "react";
import type { CloudCatalogProvider, CloudModelCatalog, CloudRemoteSignInKind } from "../../shared/accountCloudLaunches";
import { isAdeAvailable } from "../lib/adeAvailability";

/**
 * The model list for a chat on ADE Cloud before any computer exists
 * (`GET /cloud/models`), read once per page and kept; the same answer for
 * every account. Plus the person's last pick, so the next chat starts on it.
 */

type CatalogState = { catalog: CloudModelCatalog | null; error: string | null; loading: boolean };

let state: CatalogState = { catalog: null, error: null, loading: false };
const listeners = new Set<() => void>();

function set(next: CatalogState): void {
  state = next;
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  const api = typeof window !== "undefined" ? window.ade?.cloudLaunches : undefined;
  if (!api || !isAdeAvailable(api.models) || state.loading) return;
  set({ ...state, loading: true, error: null });
  try {
    const catalog = await api.models();
    set({ catalog, error: null, loading: false });
  } catch (error) {
    set({ ...state, error: error instanceof Error ? error.message : String(error), loading: false });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => state;

export function useCloudModelCatalog(enabled: boolean): CatalogState & { retry: () => void } {
  const snapshot = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (enabled && !state.catalog && !state.loading && !state.error) void load();
  }, [enabled]);
  return { ...snapshot, retry: () => void load() };
}

/**
 * How a provider signs in on a cloud computer. PR 1 names the field
 * `remoteSignIn`; an older server sent `signIn`.
 */
export function catalogSignInKind(provider: CloudCatalogProvider): CloudRemoteSignInKind {
  const record = provider as unknown as { remoteSignIn?: CloudRemoteSignInKind; signIn?: CloudRemoteSignInKind };
  return record.remoteSignIn ?? record.signIn ?? "device";
}

const LAST_MODEL_KEY = "ade.cloudChat.lastModel.v1";

export type CloudModelPick = { provider: string; modelId: string };

export function readLastCloudModel(): CloudModelPick | null {
  try {
    const raw = window.localStorage.getItem(LAST_MODEL_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<CloudModelPick>) : null;
    return parsed && typeof parsed.provider === "string" && typeof parsed.modelId === "string"
      ? { provider: parsed.provider, modelId: parsed.modelId }
      : null;
  } catch {
    return null;
  }
}

export function saveLastCloudModel(pick: CloudModelPick): void {
  try {
    window.localStorage.setItem(LAST_MODEL_KEY, JSON.stringify(pick));
  } catch {
    // This browser's copy only.
  }
}

/** The pick to start on: the last one while the list still has it, else the first provider's default. */
export function defaultCloudModel(catalog: CloudModelCatalog | null): CloudModelPick | null {
  if (!catalog) return null;
  const last = readLastCloudModel();
  if (last) {
    const provider = catalog.providers.find((entry) => entry.provider === last.provider);
    if (provider?.models.some((model) => model.id === last.modelId)) return last;
  }
  // Providers that sign in on the computer come first; a key or desktop sign-in needs a step before.
  const first = catalog.providers.find((entry) => catalogSignInKind(entry) === "device" || catalogSignInKind(entry) === "url_paste")
    ?? catalog.providers[0];
  // The default only when the list has it: the picker shows and sends the same model.
  const modelId = (first?.models.some((model) => model.id === first.defaultModelId) ? first.defaultModelId : null)
    ?? first?.models[0]?.id
    ?? null;
  return first && modelId ? { provider: first.provider, modelId } : null;
}
