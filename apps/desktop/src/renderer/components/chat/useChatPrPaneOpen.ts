import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { patchChatCompanionUiState, readChatCompanionUiState } from "./chatCompanionUiState";

export type UseChatPrPaneOpen = {
  prPaneOpen: boolean;
  setPrPaneOpen: Dispatch<SetStateAction<boolean>>;
};

/**
 * Owns the floating PR pane's open/closed state, shared by the ADE chat
 * surface (AgentChatPane) and the CLI session surface (WorkViewArea).
 *
 * The pane never auto-opens — only an explicit user toggle moves it. Once
 * opened it stays open until the user closes it.
 *
 * `persistKey` (the surface's per-chat companion-state key) makes that
 * open/closed state per chat AND durable across restarts: without it the pane
 * is bare component state, so every chat switch and every app launch reopens
 * from "closed" regardless of what the user left open.
 */
export function useChatPrPaneOpen(persistKey: string | null): UseChatPrPaneOpen {
  const [prPaneOpen, setPrPaneOpen] = useState(
    () => (persistKey ? readChatCompanionUiState(persistKey).prPaneOpen : false),
  );
  // Which key the current `prPaneOpen` was hydrated from.
  const hydratedPersistKeyRef = useRef<string | null>(persistKey);
  // Set by the hydrate effect and consumed by the persist effect below. Both
  // effects belong to the same fiber and run in declaration order within one
  // passive-effect flush, so on the commit where `persistKey` changes the
  // persist effect still closes over the OUTGOING chat's `prPaneOpen`. Marking
  // the hydration here — rather than relying on the key ref, which the hydrate
  // effect has already advanced by then — makes the persist effect skip exactly
  // that one stale flush instead of writing chat A's value into chat B's record.
  const pendingHydrationKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (hydratedPersistKeyRef.current === persistKey) return;
    hydratedPersistKeyRef.current = persistKey;
    pendingHydrationKeyRef.current = persistKey;
    setPrPaneOpen(persistKey ? readChatCompanionUiState(persistKey).prPaneOpen : false);
  }, [persistKey]);

  // Every transition persists — the toolbar toggle and the ✕ both land here.
  // The patch merges inside the store, so the chat shell's drawer fields on
  // the same record survive.
  useEffect(() => {
    if (!persistKey || hydratedPersistKeyRef.current !== persistKey) return;
    if (pendingHydrationKeyRef.current === persistKey) {
      // Stale flush from the key change. If hydration changed the value, the
      // corrective render re-runs this effect with the real one; if it didn't,
      // storage already agrees and there is nothing to write either way.
      pendingHydrationKeyRef.current = null;
      return;
    }
    if (readChatCompanionUiState(persistKey).prPaneOpen === prPaneOpen) return;
    patchChatCompanionUiState(persistKey, { prPaneOpen });
  }, [persistKey, prPaneOpen]);

  return { prPaneOpen, setPrPaneOpen };
}
