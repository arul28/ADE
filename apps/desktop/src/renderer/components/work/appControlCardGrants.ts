import { useCallback, useSyncExternalStore } from "react";
import type { FloatingPlayerChoice } from "../shared/FloatingPlayer";
import { normalizeMacDesktopMiniPlayerChoice } from "./macDesktopMiniPlayerChoice";

/**
 * Which chats may float the lane's App Control player because their agent is
 * driving the app. The same rule as `macDesktopCardGrants`: the brain's
 * automatic offer (`floating-app-control`, auto) reaches the Work page only for
 * the chat in front, and the page grants that chat on that lane. Keyed by lane
 * AND chat, in memory: it says "this chat's agent is working there now".
 * × on the player revokes it.
 */

const GRANT_CAP = 64;
const grants = new Map<string, number>();
const listeners = new Set<() => void>();

function keyFor(laneId: string, chatSessionId: string): string {
  return `${laneId}\u0000${chatSessionId}`;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function grantAppControlCardForChat(
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

export function revokeAppControlCardForChat(laneId: string | null, chatSessionId: string | null): void {
  if (!laneId || !chatSessionId) return;
  if (grants.delete(keyFor(laneId, chatSessionId))) notify();
}

export function appControlCardGrantedAt(laneId: string | null, chatSessionId: string | null): number | null {
  if (!laneId || !chatSessionId) return null;
  return grants.get(keyFor(laneId, chatSessionId)) ?? null;
}

export function useAppControlCardGrant(laneId: string | null, chatSessionId: string | null): number | null {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const snapshot = useCallback(
    () => appControlCardGrantedAt(laneId, chatSessionId),
    [chatSessionId, laneId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The `workSurfaceKey` surface name the player notes while it is on screen, so
 * `ade app-control show --floating` answers "shown" only for a player you can see.
 */
export const APP_CONTROL_CARD_ON_SCREEN_KEY = "floating-app-control";

/** Test seam. */
export function resetAppControlCardGrantsForTests(): void {
  grants.clear();
  notify();
}

/* ── Where the player sits, kept across restarts ─────────────────────── */

export const APP_CONTROL_MINI_PLAYER_STORAGE_KEY = "ade.appControl.floatingPlayer.v1";

export function readAppControlMiniPlayerChoice(): FloatingPlayerChoice | null {
  try {
    const raw = window.localStorage.getItem(APP_CONTROL_MINI_PLAYER_STORAGE_KEY);
    return raw ? normalizeMacDesktopMiniPlayerChoice(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeAppControlMiniPlayerChoice(choice: FloatingPlayerChoice): void {
  const normalized = normalizeMacDesktopMiniPlayerChoice(choice);
  try {
    if (normalized) {
      window.localStorage.setItem(APP_CONTROL_MINI_PLAYER_STORAGE_KEY, JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(APP_CONTROL_MINI_PLAYER_STORAGE_KEY);
    }
  } catch {
    // Not remembered; the player still moves for this session.
  }
}
