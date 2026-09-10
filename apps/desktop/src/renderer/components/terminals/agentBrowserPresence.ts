import { useCallback, useSyncExternalStore } from "react";
import type { BuiltInBrowserAgentPresence, BuiltInBrowserEventPayload } from "../../../shared/types";

/**
 * "Is this chat using the browser right now", for any surface that shows a chat.
 *
 * Three of them ask — the session card, the chat header, the Browser tool's tab
 * — and they live in different subtrees, mount and unmount constantly, and are
 * not all inside `NativeToolFeedsProvider`. So this is a module store with ONE
 * lazily-opened subscription shared by every reader, in the same shape as
 * `workTerminalShells`: the number of IPC subscriptions is a property of the
 * feature, not of how many badges happen to be on screen.
 *
 * The answer is derived in Electron main from the browser commands themselves
 * (`builtInBrowserPresence.ts`), never announced by the agent, and it expires
 * about twenty seconds after the last one. Nothing here polls: main pushes an
 * `agent-presence` event on both edges, and the one-shot seed below covers a
 * surface that mounted in the middle of a stretch.
 */

/** `chatSessionId` → when this stretch of browsing started. */
const sinceByChatSession = new Map<string, string>();
const listeners = new Set<() => void>();

let refCount = 0;
let detach: (() => void) | null = null;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function replace(presence: readonly BuiltInBrowserAgentPresence[]): void {
  // Whole-set replace, because that is what the event carries: a reader that
  // mounted between two changes must not have to reconcile a delta it missed.
  let changed = presence.length !== sinceByChatSession.size;
  const next = new Map<string, string>();
  for (const entry of presence) {
    if (!entry?.chatSessionId) continue;
    next.set(entry.chatSessionId, entry.since);
    if (sinceByChatSession.get(entry.chatSessionId) !== entry.since) changed = true;
  }
  if (!changed) return;
  sinceByChatSession.clear();
  for (const [chatSessionId, since] of next) sinceByChatSession.set(chatSessionId, since);
  emit();
}

/**
 * Opens the shared feed on the first reader and closes it after the last one.
 *
 * The seed is a single `getStatus` rather than a poll: it answers the one case
 * events cannot — a badge that mounted while an agent was already browsing (or
 * mid-recording, where presence is held and no event is due for minutes).
 */
function attach(listener: () => void): () => void {
  listeners.add(listener);
  refCount += 1;
  if (refCount === 1) {
    const browser = window.ade?.builtInBrowser;
    const stop = browser?.onEvent?.((event: BuiltInBrowserEventPayload) => {
      if (event.type !== "agent-presence") return;
      replace(event.presence);
    }) ?? null;
    detach = () => stop?.();
    void browser?.getStatus?.().then((status) => {
      // Only as a seed. An answer that raced past a newer event would undo it,
      // so it is dropped unless the store is still empty.
      if (sinceByChatSession.size === 0) replace(status?.agentPresence ?? []);
    }).catch(() => {
      // No browser on this build, or no runtime yet: nobody is browsing.
    });
  }
  return () => {
    listeners.delete(listener);
    refCount = Math.max(0, refCount - 1);
    if (refCount > 0) return;
    detach?.();
    detach = null;
    // Dropped rather than kept: with no reader there is nothing keeping it
    // current, and a stale badge is worse than a late one.
    if (sinceByChatSession.size) {
      sinceByChatSession.clear();
      emit();
    }
  };
}

function useAgentBrowserPresenceStore<T>(snapshot: () => T, serverSnapshot: () => T): T {
  const subscribe = useCallback((onStoreChange: () => void) => attach(onStoreChange), []);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * When this chat started using the browser, or `null` if it is not.
 *
 * A string rather than the entry, so `useSyncExternalStore` can compare
 * snapshots without a cache — returning a fresh object would re-render every
 * badge on every unrelated change.
 */
export function useAgentBrowserPresenceSince(chatSessionId: string | null | undefined): string | null {
  return useAgentBrowserPresenceStore(
    useCallback(
      () => (chatSessionId ? sinceByChatSession.get(chatSessionId) ?? null : null),
      [chatSessionId],
    ),
    () => null,
  );
}

/** Whether ANY chat is driving the browser — the Browser tab's live dot. */
export function useAnyAgentBrowserPresence(): boolean {
  return useAgentBrowserPresenceStore(
    useCallback(() => sinceByChatSession.size > 0, []),
    () => false,
  );
}

/** Tests only: publish a presence set without an Electron main behind it. */
export function setAgentBrowserPresenceForTest(
  presence: readonly BuiltInBrowserAgentPresence[],
): void {
  replace(presence);
}

/** Tests only: drop everything so suites cannot leak into each other. */
export function resetAgentBrowserPresenceForTest(): void {
  if (sinceByChatSession.size === 0) return;
  sinceByChatSession.clear();
  emit();
}
