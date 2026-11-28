import { useEffect, useSyncExternalStore } from "react";
import type { CloudModelCatalog } from "../../shared/accountCloudLaunches";
import { isAdeAvailable } from "../lib/adeAvailability";
import { BRAND } from "../../shared/brand";

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

/** ADE Web reads the account server itself; the desktop asks its main process, which holds the account sign-in. */
function catalogReader(): (() => Promise<CloudModelCatalog | null>) | null {
  if (typeof window === "undefined") return null;
  const web = window.ade?.cloudLaunches?.models;
  if (isAdeAvailable(web)) return web;
  const desktop = window.ade?.cloud?.modelCatalog;
  return isAdeAvailable(desktop) ? desktop : null;
}

async function load(): Promise<void> {
  const read = catalogReader();
  if (!read || state.loading) return;
  set({ ...state, loading: true, error: null });
  try {
    const catalog = await read();
    if (!catalog) throw new Error(`${BRAND.CLOUD_NAME} didn't list its models.`);
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
    // Each time a reader turns on, so a list that failed (signed out, offline) is asked for again.
    if (enabled && !state.catalog && !state.loading) void load();
  }, [enabled]);
  return { ...snapshot, retry: () => void load() };
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
  const first = catalog.providers.find((entry) => entry.remoteSignIn === "device" || entry.remoteSignIn === "url_paste")
    ?? catalog.providers[0];
  // The default only when the list has it: the picker shows and sends the same model.
  const modelId = (first?.models.some((model) => model.id === first.defaultModelId) ? first.defaultModelId : null)
    ?? first?.models[0]?.id
    ?? null;
  return first && modelId ? { provider: first.provider, modelId } : null;
}
