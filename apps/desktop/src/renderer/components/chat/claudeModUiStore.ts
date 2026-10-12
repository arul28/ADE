import { useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
  type ClaudePluginUiSnapshot,
} from "../../../shared/claudePluginUi";
import { showToast } from "../app/toast/toastStore";

/**
 * What Claude mods draw per chat, as last reported by the chat's host.
 *
 * The host is the only writer. A read on open fills this store, and every
 * `session_meta_updated` event of the open chat that carries `claudePluginUi`
 * replaces its snapshot whole. Nothing is stored past this window.
 *
 * The hook holds its own event subscription. The chat pane's handler stops
 * while another page (Settings) covers the pane, and a snapshot missed then
 * would leave an old band on screen.
 */
const bySession = new Map<string, ClaudePluginUiSnapshot>();
/** Bumped on every write, so a read that started before a live update cannot overwrite it. */
const writeVersion = new Map<string, number>();
const listeners = new Set<() => void>();

/** Stores a snapshot. Returns false for one that is older than what the store holds. */
function setClaudeModUi(sessionId: string, snapshot: ClaudePluginUiSnapshot): boolean {
  const current = bySession.get(sessionId);
  // Pushes of one Claude process arrive in order; a late older one is dropped.
  if (current && current.generation === snapshot.generation && current.revision >= snapshot.revision) return false;
  // Generation 0 is the empty snapshot: the host has nothing for this chat.
  if (snapshot.generation === 0 && !current) return false;
  if (snapshot.generation === 0) bySession.delete(sessionId);
  else bySession.set(sessionId, snapshot);
  writeVersion.set(sessionId, (writeVersion.get(sessionId) ?? 0) + 1);
  for (const listener of listeners) listener();
  return true;
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
 */
export function useClaudeModUi(
  sessionId: string,
  pin: OpenProjectBinding | null | undefined,
): ClaudePluginUiSnapshot {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => bySession.get(sessionId) ?? EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
    () => EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT,
  );
  const pinKey = pin?.key ?? null;
  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.ade?.agentChat;
    const unsubscribe = api?.onEvent?.((envelope) => {
      // Only the chat on screen: another chat's toast here would name no chat.
      if (envelope.sessionId !== sessionId || envelope.event.type !== "session_meta_updated") return;
      const pushed = envelope.event.claudePluginUi;
      if (!pushed || !setClaudeModUi(sessionId, pushed)) return;
      // The host sends a toast only with the publish that raised it. One id
      // per mod and chat: a newer toast replaces it, as in Claude Code.
      const toast = pushed.toast;
      if (toast) {
        showToast({
          id: `claude-mod:${sessionId}:${toast.plugin}`,
          title: toast.plugin,
          message: toast.text,
          durationMs: toast.timeoutMs,
        });
      }
    }, pin ?? null);
    refreshClaudeModUi(sessionId, pin);
    return unsubscribe;
    // The pin object is rebuilt on most renders; its key names the machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pinKey]);
  return snapshot;
}
