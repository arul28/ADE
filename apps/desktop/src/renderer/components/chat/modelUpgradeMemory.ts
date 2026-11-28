import type { ModelUpgrade } from "../../../shared/modelSuccessors";
import { captureError } from "../../../shared/sentry/capture";

/**
 * Newer-version suggestions the person turned down (ADE-300), per client like
 * the remembered model they are about. One entry per pair: closing "Fable 5.2
 * is out" on Fable 5.1 hides that pair everywhere, and a later Fable 5.3 is
 * offered again. Picking the older version by hand turns its pair down too.
 *
 * A small external store: the snapshot is the list itself, replaced on every
 * change, so `useSyncExternalStore` re-renders exactly when it changes.
 */
const DISMISSED_KEY = "ade.chat.dismissedModelUpgrades.v1";
const DISMISSED_MAX = 64;
const EMPTY: readonly string[] = [];

let dismissed: readonly string[] | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  // Another window turned one down.
  window.addEventListener("storage", (event) => {
    if (event.key !== DISMISSED_KEY && event.key !== null) return;
    dismissed = null;
    for (const listener of listeners) listener();
  });
}

export function modelUpgradePairKey(upgrade: Pick<ModelUpgrade, "fromModelId" | "toModelId">): string {
  return `${upgrade.fromModelId}>${upgrade.toModelId}`;
}

function readStored(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : EMPTY;
  } catch (error) {
    // Unreadable: every suggestion shows again, which the person can close.
    captureError(error, { handled: true, fingerprint: ["model-upgrade-dismissals", "read"] });
    return EMPTY;
  }
}

/** The pairs turned down, newest first. The same array until it changes. */
export function readDismissedModelUpgrades(): readonly string[] {
  dismissed ??= readStored();
  return dismissed;
}

export function dismissModelUpgrade(upgrade: ModelUpgrade): void {
  const key = modelUpgradePairKey(upgrade);
  // Merged with what is stored now, not only this window's copy: another
  // window may have written since, and its `storage` event may not be here yet.
  // This window's own entries stay too (a write that storage refused).
  const merged = [...new Set([...readStored(), ...readDismissedModelUpgrades()])];
  dismissed = [key, ...merged.filter((entry) => entry !== key)].slice(0, DISMISSED_MAX);
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  } catch (error) {
    // Not saved: the choice holds for this window's life.
    captureError(error, { handled: true, fingerprint: ["model-upgrade-dismissals", "write"] });
  }
  for (const listener of listeners) listener();
}

export function subscribeModelUpgradeDismissals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
