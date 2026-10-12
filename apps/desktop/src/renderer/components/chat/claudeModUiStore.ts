import { useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
  type ClaudePluginUiSnapshot,
} from "../../../shared/claudePluginUi";

/**
 * What Claude mods draw per chat, as last reported by the chat's host.
 *
 * The host is the only writer. A `get` call on open fills this store, and every
 * `session_meta_updated` event that carries `claudePluginUi` replaces the
 * chat's snapshot whole. Nothing is stored past this window.
 *
 * The hook holds its own event subscription. The chat pane's handler stops
 * while another page (Settings) covers the pane, and a snapshot missed then
 * would leave an old band on screen.
 */
const bySession = new Map<string, ClaudePluginUiSnapshot>();
/** Bumped on every write, so a read that started before a live update cannot overwrite it. */
const writeVersion = new Map<string, number>();
const listeners = new Set<() => void>();

function setClaudeModUi(sessionId: string, snapshot: ClaudePluginUiSnapshot): void {
  const current = bySession.get(sessionId);
  // Pushes of one Claude process arrive in order; a late older one is dropped.
  if (current && current.generation === snapshot.generation && current.revision >= snapshot.revision) return;
  if (snapshot.generation === 0 && !current) return;
  if (snapshot.generation === 0) bySession.delete(sessionId);
  else bySession.set(sessionId, snapshot);
  writeVersion.set(sessionId, (writeVersion.get(sessionId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

/** The API, when this client has it (an older preload or a mock may not). */
export function claudeModUiApi() {
  return typeof window === "undefined" ? undefined : window.ade?.agentChat?.claudePluginUi;
}

function refreshClaudeModUi(sessionId: string, pin: OpenProjectBinding | null | undefined): void {
  const api = claudeModUiApi();
  if (!api) return;
  const startedAt = writeVersion.get(sessionId) ?? 0;
  void api.get({ sessionId }, pin ?? null)
    .then((snapshot) => {
      if (snapshot && (writeVersion.get(sessionId) ?? 0) === startedAt) setClaudeModUi(sessionId, snapshot);
    })
    .catch(() => {
      // An older host has no mod UI actions; the chat simply shows none.
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Subscribes to one chat's mod UI and loads it when the chat opens.
 * Pass a null session to opt out (another provider, a draft, a subagent view).
 */
export function useClaudeModUi(
  sessionId: string | null | undefined,
  pin: OpenProjectBinding | null | undefined,
): ClaudePluginUiSnapshot {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (sessionId ? bySession.get(sessionId) : undefined) ?? EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
    () => EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
  );
  const pinKey = pin?.key ?? null;
  useEffect(() => {
    if (!sessionId) return;
    const api = typeof window === "undefined" ? undefined : window.ade?.agentChat;
    const unsubscribe = api?.onEvent?.((envelope) => {
      if (envelope.event.type !== "session_meta_updated" || !envelope.event.claudePluginUi) return;
      setClaudeModUi(envelope.sessionId, envelope.event.claudePluginUi);
    }, pin ?? null);
    refreshClaudeModUi(sessionId, pin);
    return unsubscribe;
    // The pin object is rebuilt on most renders; its key names the machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pinKey]);
  return snapshot;
}
