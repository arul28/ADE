import { useCallback, useSyncExternalStore } from "react";

/**
 * Which chats may float the lane's Mac Desktop card because of their agent.
 *
 * The card shows a lane's desktop only to a chat that is a stream viewer or
 * holds the input lease. An agent in accessibility mode is neither: it drives
 * the display without taking the lease, and nothing is watching yet, so the
 * card never appeared for the very chat whose agent was working there.
 *
 * A grant is that missing link. `ade ui show floating-mac-desktop`, and the
 * brain's automatic offer when an agent drives the display, reach the Work page
 * only for the chat in front; the page grants that chat on that lane, and the
 * card may then start its decoder for it. Keyed by lane AND chat, so a grant
 * never authorizes another chat, or this chat on another lane.
 *
 * In memory on purpose: it says "this chat's agent is working there now", which
 * a restart does not carry. × on the card revokes it; the next agent action
 * grants it again unless the chat's preview is off.
 */

const GRANT_CAP = 64;

/** `grantedAt` by `laneId\0chatSessionId`, oldest first. */
const grants = new Map<string, number>();
const listeners = new Set<() => void>();

function keyFor(laneId: string, chatSessionId: string): string {
  return `${laneId}\u0000${chatSessionId}`;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function grantMacDesktopCardForChat(
  laneId: string | null,
  chatSessionId: string | null,
  at: number = Date.now(),
): boolean {
  if (!laneId || !chatSessionId) return false;
  const key = keyFor(laneId, chatSessionId);
  grants.delete(key);
  grants.set(key, at);
  while (grants.size > GRANT_CAP) {
    const oldest = grants.keys().next().value;
    if (oldest == null) break;
    grants.delete(oldest);
  }
  notify();
  return true;
}

export function revokeMacDesktopCardForChat(laneId: string | null, chatSessionId: string | null): void {
  if (!laneId || !chatSessionId) return;
  if (grants.delete(keyFor(laneId, chatSessionId))) notify();
}

/** When this chat was last granted the lane's card, or null for never. */
export function macDesktopCardGrantedAt(laneId: string | null, chatSessionId: string | null): number | null {
  if (!laneId || !chatSessionId) return null;
  return grants.get(keyFor(laneId, chatSessionId)) ?? null;
}

export function useMacDesktopCardGrant(laneId: string | null, chatSessionId: string | null): number | null {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const snapshot = useCallback(
    () => macDesktopCardGrantedAt(laneId, chatSessionId),
    [chatSessionId, laneId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The `workSurfaceKey` surface name the card notes while it shows the Mac
 * Desktop, so `ade ui show floating-mac-desktop` answers "shown" only for a
 * card on screen.
 */
export const MAC_DESKTOP_CARD_ON_SCREEN_KEY = "floating-mac-desktop";

/** Test seam: a grant from one test must not reach the next. */
export function resetMacDesktopCardGrantsForTests(): void {
  grants.clear();
  notify();
}
