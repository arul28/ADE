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
 * opens before the pane mounts must both survive.
 */
const holds = new Map<string, BuiltInBrowserRemoteRequest[]>();
const handledIds = new Set<string>();
const HANDLED_CAP = 32;

function pinKeyFor(pin: { key: string } | null | undefined): string {
  return pin?.key ?? "bound";
}

function forgetOldestHandled(): void {
  if (handledIds.size <= HANDLED_CAP) return;
  const oldest = handledIds.values().next().value;
  if (oldest) handledIds.delete(oldest);
}

export function remoteBrowserOpenMatchesOwner(
  request: BuiltInBrowserRemoteRequest,
  owner: { sessionId?: string | null; laneId?: string | null },
): boolean {
  if (request.laneId && owner.laneId && request.laneId !== owner.laneId) return false;
  if (request.chatSessionId && owner.sessionId && request.chatSessionId !== owner.sessionId) return false;
  return true;
}

export function holdRemoteBrowserOpen(
  pin: { key: string } | null | undefined,
  request: BuiltInBrowserRemoteRequest,
): void {
  if (handledIds.has(request.requestId)) return;
  const key = pinKeyFor(pin);
  const queue = holds.get(key) ?? [];
  if (queue.some((held) => held.requestId === request.requestId)) {
    holds.set(key, queue);
    return;
  }
  queue.push(request);
  holds.set(key, queue);
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
  const key = pinKeyFor(pin);
  const queue = holds.get(key);
  if (!queue?.length) return null;
  const idx = queue.findIndex((held) => (
    !handledIds.has(held.requestId) && remoteBrowserOpenMatchesOwner(held, owner)
  ));
  if (idx < 0) {
    const leftover = queue.filter((held) => !handledIds.has(held.requestId));
    if (leftover.length > 0) holds.set(key, leftover);
    else holds.delete(key);
    return null;
  }
  const [held] = queue.splice(idx, 1);
  if (queue.length > 0) holds.set(key, queue);
  else holds.delete(key);
  return held ?? null;
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
  const next = queue.filter((held) => held.requestId !== requestId);
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
}
