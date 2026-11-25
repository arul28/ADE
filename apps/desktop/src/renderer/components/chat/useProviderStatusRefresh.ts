import { useEffect, useRef } from "react";
import type { AiProviderConnectionStatus, OpenProjectBinding } from "../../../shared/types";

/**
 * When the visible chat pane reads its provider status (the model list and
 * the sign-ins) again. A hidden pane reads nothing.
 *
 * - When it shows, when the chat's provider changes, and when a turn starts
 *   and ends (`turnActive`). It used to re-read every 5 s for the whole turn;
 *   the list rarely changes mid-turn, and a model a provider adds during a
 *   long turn shows at the turn's end. A status that says the chat's provider
 *   cannot run ("No Claude login was detected") is read past this window's
 *   cache when a turn ends: the turn that just ran on that provider proved it
 *   wrong, or the read is right. It also reads again when the chat moves to
 *   another machine (its pin key).
 * - When the chat's machine applied or changed its provider sign-ins (an ADE
 *   Cloud computer applies the account's sign-ins as ADE starts there, so a
 *   status read in that first half minute says "no login"). The event is the
 *   chat's machine's, by its pin; no timer, no poll.
 * - On a new connection to the chat's machine (`connectionMark`): it can be a
 *   brain that signed in to its providers after this pane last read its
 *   status (a wake, a new computer after a move), so it is read past this
 *   window's cache.
 *
 * The refresh and the pin are read through refs, so a model change or a pin
 * rebuilt with the same key does not resubscribe.
 */
export function useProviderStatusRefresh(input: {
  /** The pane shows. */
  isTileActive: boolean;
  turnActive: boolean;
  selectedSessionId: string | null;
  /** The chat's provider, and its status as this window last read it. */
  provider: string | null | undefined;
  providerStatus: AiProviderConnectionStatus | null | undefined;
  /** The chat's machine: its sign-in events come from it, and a new one (by key) reads again. */
  chatRuntimePin: OpenProjectBinding | null;
  /** The chat's connection to its machine (`useRemoteConnectionMark`); a new mark is a new connection. */
  connectionMark: string;
  refreshAvailableModels: (options?: { revalidate?: boolean }) => Promise<unknown>;
}): void {
  const {
    isTileActive,
    turnActive,
    selectedSessionId,
    provider,
    providerStatus,
    chatRuntimePin,
    connectionMark,
    refreshAvailableModels,
  } = input;
  const chatRuntimePinKey = chatRuntimePin?.key ?? null;
  const chatRuntimePinRef = useRef(chatRuntimePin);
  chatRuntimePinRef.current = chatRuntimePin;

  const blockedRef = useRef(false);
  blockedRef.current = providerStatus != null
    && (providerStatus.runtimeAvailable === false || Boolean(providerStatus.blocker));
  useEffect(() => {
    if (!isTileActive) return;
    void refreshAvailableModels(!turnActive && blockedRef.current ? { revalidate: true } : undefined);
  }, [chatRuntimePinKey, isTileActive, refreshAvailableModels, provider, turnActive]);

  const refreshRef = useRef(refreshAvailableModels);
  refreshRef.current = refreshAvailableModels;
  useEffect(() => {
    if (!isTileActive || !selectedSessionId) return undefined;
    const onChanged = window.ade?.providerLogins?.onChanged;
    if (typeof onChanged !== "function") return undefined;
    let off: (() => void) | undefined;
    try {
      off = onChanged(() => {
        void refreshRef.current({ revalidate: true });
      }, chatRuntimePinRef.current);
    } catch (error) {
      // A window that cannot reach that machine's events (ADE Web without a
      // route to it) reads the status on the other triggers instead.
      console.warn(
        "[chat] provider-login-events-unavailable; the chat's sign-in status refreshes on its other triggers",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
    return () => off?.();
  }, [chatRuntimePinKey, isTileActive, selectedSessionId]);

  const lastMarkRef = useRef(connectionMark);
  useEffect(() => {
    const previous = lastMarkRef.current;
    lastMarkRef.current = connectionMark;
    if (!connectionMark || previous === connectionMark || !isTileActive) return;
    void refreshRef.current({ revalidate: true });
  }, [connectionMark, isTileActive]);
}
