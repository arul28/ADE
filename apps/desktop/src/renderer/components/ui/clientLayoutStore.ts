/**
 * Pane sizes and tiling trees, kept by this client in `localStorage`.
 *
 * A layout belongs to the person at this window, not to a machine: the same
 * repository on two computers shows the same panes. The entries are scoped by
 * the repository (its account address, or the checkout path when it has no
 * remote), so two repositories never share a layout id.
 *
 * A layout this client has never saved is read once from the tab's copy, where
 * older versions kept it, and then kept here. Nothing writes back to a machine.
 *
 * Callers pass the binding of the surface that owns the layout. A delayed save
 * must not read the active tab at write time: by then another repository can
 * be in front.
 */
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { OpenProjectBinding } from "../../../shared/types";

export type ClientLayoutKind = "dock" | "tiling";

const STORAGE_PREFIX: Record<ClientLayoutKind, string> = {
  dock: "ade.layout.dock.v1",
  tiling: "ade.layout.tiling.v1",
};

/** The repository scope of the open tab, stable across its copies. Null with no tab. */
function layoutScope(binding: OpenProjectBinding | null): string | null {
  if (!binding) return null;
  return accountRepoScopeKey(binding.gitOriginUrl ?? null) ?? `path:${binding.rootPath}`;
}

function storageKey(kind: ClientLayoutKind, scope: string, layoutId: string): string {
  return `${STORAGE_PREFIX[kind]}|${scope}|${layoutId}`;
}

function readStored(key: string): { found: boolean; value: unknown } {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return { found: false, value: null };
    return { found: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { found: false, value: null };
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the layout lives for this session only.
  }
}

/** One import per key and window, so a remount does not read the machine again. */
const importsInFlight = new Map<string, Promise<unknown>>();

function importFromCopy(
  kind: ClientLayoutKind,
  layoutId: string,
  pin: OpenProjectBinding,
): Promise<unknown> {
  const api = kind === "dock" ? window.ade?.layout : window.ade?.tilingTree;
  if (!api?.get) return Promise.resolve(null);
  return Promise.resolve(api.get(layoutId, pin)).catch(() => null);
}

/**
 * The saved layout for `layoutId` in the repository of `binding`, or null.
 * Reads this client's copy; a layout it has never saved comes once from that
 * copy.
 */
export function readClientLayout(
  kind: ClientLayoutKind,
  layoutId: string,
  binding: OpenProjectBinding | null,
): Promise<unknown> {
  const scope = layoutScope(binding);
  if (!scope || !binding) return Promise.resolve(null);
  const key = storageKey(kind, scope, layoutId);
  const stored = readStored(key);
  if (stored.found) return Promise.resolve(stored.value);
  const existing = importsInFlight.get(key);
  if (existing) return existing;
  const request = importFromCopy(kind, layoutId, binding).then((value) => {
    // A save that happened while the import was in flight wins.
    if (!readStored(key).found) writeStored(key, value ?? null);
    return readStored(key).value;
  }).finally(() => {
    importsInFlight.delete(key);
  });
  importsInFlight.set(key, request);
  return request;
}

/** Saves the layout for `layoutId` in the repository of `binding`, on this client only. */
export function writeClientLayout(
  kind: ClientLayoutKind,
  layoutId: string,
  value: unknown,
  binding: OpenProjectBinding | null,
): void {
  const scope = layoutScope(binding);
  if (!scope) return;
  writeStored(storageKey(kind, scope, layoutId), value);
}
