/**
 * Where the CTO page last resolved the project's CTO home, for surfaces
 * outside the page (the capture gesture, History's CTO sessions). They read
 * this rather than resolving on their own, so they cannot disagree with the
 * page about where the CTO is.
 */

import type { OpenProjectBinding } from "../../shared/types";

export type CtoHomeResolution =
  | { status: "resolved"; pin: OpenProjectBinding | null; machineName: string; online: boolean }
  | { status: "unreachable"; machineName: string };

const resolutionByScope = new Map<string, CtoHomeResolution>();
const resolutionListeners = new Set<(scopeKey: string) => void>();

/**
 * Remember what the CTO page resolved, keyed by the project tab's state key.
 * The capture gesture host reads it rather than resolving on its own, so it
 * cannot disagree with the page about where the CTO is.
 */
export function rememberCtoHomeResolution(scopeKey: string | null, resolution: CtoHomeResolution | null): void {
  if (!scopeKey) return;
  if (resolution) resolutionByScope.set(scopeKey, resolution);
  else resolutionByScope.delete(scopeKey);
  if (resolution) for (const listener of resolutionListeners) listener(scopeKey);
}

/**
 * The CTO page's resolution for a project tab, waiting for it when the page has
 * not resolved one yet (it is resolving because the caller just opened it).
 * Null when nothing arrives in time; the caller must not guess a machine then.
 */
export function waitForCtoHomeResolution(
  scopeKey: string | null,
  timeoutMs: number,
): Promise<CtoHomeResolution | null> {
  const existing = cachedCtoHomeResolution(scopeKey);
  if (existing || !scopeKey) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const listener = (changed: string) => {
      if (changed !== scopeKey) return;
      cleanup();
      resolve(cachedCtoHomeResolution(scopeKey));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      resolutionListeners.delete(listener);
    };
    resolutionListeners.add(listener);
  });
}

export function cachedCtoHomeResolution(scopeKey: string | null): CtoHomeResolution | null {
  if (!scopeKey) return null;
  return resolutionByScope.get(scopeKey) ?? null;
}
