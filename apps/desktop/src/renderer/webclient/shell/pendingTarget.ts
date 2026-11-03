import type { DeeplinkTarget } from "../../../shared/deeplinks";

// The link a visitor arrived with, held across sign-in and the welcome page.
//
// It lives in localStorage, not sessionStorage, for the same reason the OAuth
// stash does (`account/client.ts`): some browsers end the sign-in round trip in
// a different session-storage namespace, which dropped the link and landed the
// person on their last project instead. A short TTL keeps an abandoned link
// from hijacking a later, unrelated visit.

const PENDING_TARGET_KEY = "ade-web:pending-target";
export const PENDING_TARGET_TTL_MS = 10 * 60_000;

type StoredPendingTarget = { target: DeeplinkTarget; savedAtMs: number };

export function stashPendingTarget(target: DeeplinkTarget | null, nowMs = Date.now()): void {
  try {
    // Links stashed before the move to localStorage must not resurface later.
    sessionStorage.removeItem(PENDING_TARGET_KEY);
  } catch {
    // A private browser may deny session storage.
  }
  try {
    if (target) {
      const stored: StoredPendingTarget = { target, savedAtMs: nowMs };
      localStorage.setItem(PENDING_TARGET_KEY, JSON.stringify(stored));
    } else {
      localStorage.removeItem(PENDING_TARGET_KEY);
    }
  } catch {
    // A hardened browser may deny local storage; the in-memory copy still works.
  }
}

export function readPendingTarget(nowMs = Date.now()): DeeplinkTarget | null {
  try {
    const raw = localStorage.getItem(PENDING_TARGET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPendingTarget> | null;
    const savedAtMs = typeof parsed?.savedAtMs === "number" ? parsed.savedAtMs : NaN;
    const target = parsed?.target;
    const fresh = Number.isFinite(savedAtMs) && nowMs - savedAtMs >= 0 && nowMs - savedAtMs <= PENDING_TARGET_TTL_MS;
    if (!fresh || !target || typeof target !== "object" || typeof target.kind !== "string") {
      localStorage.removeItem(PENDING_TARGET_KEY);
      return null;
    }
    return target;
  } catch {
    return null;
  }
}
