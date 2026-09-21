import type { BuiltInBrowserRemoteRequest } from "../../shared/types/builtInBrowserRemote";

/**
 * Handoff for `ade browser open` while the Browser pane is unmounted.
 *
 * Work listens for forwarded opens even when Git (or another tool) is showing,
 * so it can switch the pane. The live runtime event is not replayed, and the
 * pane is what navigates and acks — so the triggering request has to wait here
 * until `ChatBuiltInBrowserPanel` mounts and claims it.
 *
 * Keyed by pin so a personal-chat pane on another machine cannot drain a
 * Studio open, and filtered on take so a panel that is not this request's
 * chat/lane leaves it for the one that is. A queue, not a single slot: two
 * opens before the pane mounts must both survive. Holds expire after a short
 * handoff window so a chat that never opens cannot replay timed-out URLs
 * hours later, and each pin plus the global map are capped.
 */
type HeldRemoteBrowserOpen = {
  request: BuiltInBrowserRemoteRequest;
  heldAtMs: number;
};

const holds = new Map<string, HeldRemoteBrowserOpen[]>();
const handledIds = new Set<string>();
const HANDLED_CAP = 32;
/** Long enough to mount the pane; shorter than a CLI that has already given up. */
export const REMOTE_BROWSER_OPEN_HOLD_TTL_MS = 30_000;
const PER_PIN_HOLD_CAP = 8;
const GLOBAL_HOLD_CAP = 32;

let clockMs: number | null = null;

function nowMs(): number {
  return clockMs ?? Date.now();
}

/** Test seam — freeze insertion/expiry time without wall-clock sleeps. */
export function setRemoteBrowserOpenClockForTests(ms: number | null): void {
  clockMs = ms;
}

function pinKeyFor(pin: { key: string } | null | undefined): string {
  return pin?.key ?? "bound";
}

function forgetOldestHandled(): void {
  if (handledIds.size <= HANDLED_CAP) return;
  const oldest = handledIds.values().next().value;
  if (oldest) handledIds.delete(oldest);
}

function isFresh(held: HeldRemoteBrowserOpen, now: number): boolean {
  return now - held.heldAtMs <= REMOTE_BROWSER_OPEN_HOLD_TTL_MS;
}

function globalHoldCount(): number {
  let count = 0;
  for (const queue of holds.values()) count += queue.length;
  return count;
}

function dropOldestHold(): void {
  let oldestKey: string | null = null;
  let oldestIndex = -1;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, queue] of holds) {
    queue.forEach((held, index) => {
      if (held.heldAtMs < oldestAt) {
        oldestAt = held.heldAtMs;
        oldestKey = key;
        oldestIndex = index;
      }
    });
  }
  if (oldestKey == null || oldestIndex < 0) return;
  const queue = holds.get(oldestKey);
  if (!queue) return;
  queue.splice(oldestIndex, 1);
  if (queue.length > 0) holds.set(oldestKey, queue);
  else holds.delete(oldestKey);
}

function pruneExpiredHolds(now: number = nowMs()): void {
  for (const [key, queue] of holds) {
    const fresh = queue.filter((held) => isFresh(held, now));
    if (fresh.length > 0) holds.set(key, fresh);
    else holds.delete(key);
  }
}

export function remoteBrowserOpenMatchesOwner(
  request: BuiltInBrowserRemoteRequest,
  owner: { sessionId?: string | null; laneId?: string | null },
): boolean {
  if (request.chatSessionId) {
    if (!owner.sessionId || request.chatSessionId !== owner.sessionId) return false;
  }
  if (request.laneId && owner.laneId && request.laneId !== owner.laneId) return false;
  return true;
}

export function holdRemoteBrowserOpen(
  pin: { key: string } | null | undefined,
  request: BuiltInBrowserRemoteRequest,
): void {
  pruneExpiredHolds();
  if (handledIds.has(request.requestId)) return;
  const key = pinKeyFor(pin);
  const queue = holds.get(key) ?? [];
  if (queue.some((held) => held.request.requestId === request.requestId)) {
    holds.set(key, queue);
    return;
  }
  queue.push({ request, heldAtMs: nowMs() });
  while (queue.length > PER_PIN_HOLD_CAP) queue.shift();
  holds.set(key, queue);
  while (globalHoldCount() > GLOBAL_HOLD_CAP) dropOldestHold();
}

/**
 * Claim the next held open for this pane. Returns null when nothing is waiting,
 * when another pane already handled the head, or when the hold names a
 * different chat/lane than this panel.
 */
export function takeHeldRemoteBrowserOpen(
  pin: { key: string } | null | undefined,
  owner: { sessionId?: string | null; laneId?: string | null },
): BuiltInBrowserRemoteRequest | null {
  pruneExpiredHolds();
  const key = pinKeyFor(pin);
  const queue = holds.get(key);
  if (!queue?.length) return null;
  const idx = queue.findIndex((held) => (
    !handledIds.has(held.request.requestId) && remoteBrowserOpenMatchesOwner(held.request, owner)
  ));
  if (idx < 0) {
    const leftover = queue.filter((held) => !handledIds.has(held.request.requestId));
    if (leftover.length > 0) holds.set(key, leftover);
    else holds.delete(key);
    return null;
  }
  const [held] = queue.splice(idx, 1);
  if (queue.length > 0) holds.set(key, queue);
  else holds.delete(key);
  return held?.request ?? null;
}

export function markRemoteBrowserOpenHandled(requestId: string): void {
  handledIds.add(requestId);
  forgetOldestHandled();
}

/** Drop a hold the live listener already acted on, so a remount does not replay it. */
export function consumeMatchingRemoteBrowserOpen(
  pin: { key: string } | null | undefined,
  requestId: string,
): void {
  const key = pinKeyFor(pin);
  const queue = holds.get(key);
  if (!queue) return;
  const next = queue.filter((held) => held.request.requestId !== requestId);
  if (next.length > 0) holds.set(key, next);
  else holds.delete(key);
}

export function wasRemoteBrowserOpenHandled(requestId: string): boolean {
  return handledIds.has(requestId);
}

/** Test seam: drops queued state so one test cannot leak into the next. */
export function resetRemoteBrowserOpensForTests(): void {
  holds.clear();
  handledIds.clear();
  clockMs = null;
}
