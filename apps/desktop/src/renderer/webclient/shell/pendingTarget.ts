import type { DeeplinkTarget } from "../../../shared/deeplinks";
import { createLinkStash } from "./linkStash";

// The link a visitor arrived with, held across sign-in and the welcome page.
//
// It lives in localStorage with a short TTL (`linkStash.ts` says why), so an
// abandoned link never hijacks a later, unrelated visit.

const PENDING_TARGET_KEY = "ade-web:pending-target";
export const PENDING_TARGET_TTL_MS = 10 * 60_000;

const stash = createLinkStash<DeeplinkTarget>({
  key: PENDING_TARGET_KEY,
  ttlMs: PENDING_TARGET_TTL_MS,
  parse: (value) => (value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string" ? (value as DeeplinkTarget) : null),
});

export function stashPendingTarget(target: DeeplinkTarget | null, nowMs = Date.now()): void {
  try {
    // Links stashed before the move to localStorage must not resurface later.
    sessionStorage.removeItem(PENDING_TARGET_KEY);
  } catch {
    // A private browser may deny session storage.
  }
  if (target) stash.write(target, nowMs);
  else stash.remove();
}

export function readPendingTarget(nowMs = Date.now()): DeeplinkTarget | null {
  return stash.read(nowMs);
}
