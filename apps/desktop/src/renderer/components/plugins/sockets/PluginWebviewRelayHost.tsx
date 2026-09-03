import React from "react";

import { useRootAppStore } from "../../../state/appStore";
import { pluginWebviewRelayBridge } from "../../../lib/pluginRuntimeBridge";
import {
  sanitizePluginWebviewChatTurn,
  type PluginWebviewChatTurn,
  type PluginWebviewThemeSnapshot,
} from "../../../../shared/plugins/webviewBridge";
import { installPluginWebviewRelay } from "./pluginWebviewRelay";
import { applyPluginWebviewReload } from "./pluginWebviewReloadStore";
import { pluginWebviewThemeEqual, readPluginWebviewTheme } from "./pluginWebviewTheme";

/**
 * One chat event, read as a turn report a page may be handed — or nothing.
 *
 * Pure and exported so both producers read one mapping: this file publishes it
 * through the desktop relay, and the hosted web client's page host
 * (`webclient/plugins/WebPluginPageHost.tsx`) turns the same envelope into a
 * `chat` host frame. Two readings of "the turn failed" would drift, and the
 * drift would be invisible — one client drawing a launched issue as running
 * forever while the other draws it as broken.
 *
 * Exactly three event types produce a turn:
 *
 * - `status` with `turnStatus: "started"` — the turn began. The other three
 *   `turnStatus` values are deliberately dropped: `done` is the authoritative
 *   end of a turn and carries the same three outcomes, so reading both would
 *   publish every ending twice under two different turn ids.
 * - `done` — `completed` maps straight across; `failed` and `interrupted` both
 *   map to `failed`, because a page draws one error path and an interruption
 *   the reader caused is still not "Ready".
 * - `error` — `failed`, carrying the host's own sentence so the page can draw
 *   what ADE would rather than inventing "Something went wrong".
 *
 * A delta never produces one. The turn feed reports lifecycle position and the
 * failure sentence; the transcript is not a plugin's to read.
 */
export function pluginWebviewChatTurnFromEvent(envelope: unknown): PluginWebviewChatTurn | null {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const record = envelope as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) return null;
  const event = record.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const chatEvent = event as Record<string, unknown>;
  const turnId = typeof chatEvent.turnId === "string" && chatEvent.turnId.trim()
    ? chatEvent.turnId.trim()
    : undefined;

  // Every return goes through the shared sanitizer rather than building the
  // record by hand: the caps and the "no message unless failed" rule live
  // there, and a second place that decided them would be a second place to fix.
  const turn = (state: PluginWebviewChatTurn["state"], message?: unknown): PluginWebviewChatTurn | null =>
    sanitizePluginWebviewChatTurn({
      sessionId,
      state,
      ...(turnId ? { turnId } : {}),
      ...(typeof message === "string" && message ? { message } : {}),
    });

  switch (chatEvent.type) {
    case "status":
      return chatEvent.turnStatus === "started" ? turn("started") : null;
    case "done":
      if (chatEvent.status === "completed") return turn("completed");
      if (chatEvent.status === "failed" || chatEvent.status === "interrupted") return turn("failed");
      return null;
    case "error":
      return turn("failed", chatEvent.message);
    default:
      return null;
  }
}

/**
 * How many turn keys the dedupe remembers.
 *
 * A ceiling rather than a lifetime: a session that runs all day would otherwise
 * grow one key per turn per state forever, in a subscription that lives as long
 * as the window does. Comfortably above a batch launch's worth of sessions, so
 * the eviction that bounds it never reaches a turn still in flight.
 */
export const PLUGIN_WEBVIEW_CHAT_TURN_DEDUPE_MAX = 256;

/**
 * "Is this turn report new?" — one bounded, insertion-ordered memory.
 *
 * Providers re-emit a status: a resumed session replays its `started`, and more
 * than one code path can announce the same `done`. Published raw that is the
 * same fact arriving at a page twice, which a page that counts running turns
 * gets wrong. Keyed by session, turn and state together, so a genuinely new
 * state of the same turn still gets through.
 */
export function createPluginWebviewChatTurnDedupe(
  limit: number = PLUGIN_WEBVIEW_CHAT_TURN_DEDUPE_MAX,
): (turn: PluginWebviewChatTurn) => boolean {
  const seen = new Set<string>();
  return (turn) => {
    const key = `${turn.sessionId}:${turn.turnId ?? ""}:${turn.state}`;
    if (seen.has(key)) return false;
    seen.add(key);
    // Insertion order is the eviction order: `Set` iterates oldest first, so
    // the key dropped is the one least likely to still be re-emitted.
    while (seen.size > limit) {
      const oldest = seen.values().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
    return true;
  };
}

/**
 * Identity, and nothing else, out of one host event.
 *
 * The same rule the entity bus keeps and the same reader the hosted web client
 * uses: a frame carries ids so a page knows WHICH row moved, and carries no
 * title, status or body — a page that wants detail asks its own plugin for it.
 * An event naming nothing this reader recognises yields an empty list, which
 * the contract already defines as "this family moved, refetch it".
 */
export function readHostChangeIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ["runId", "laneId", "operationId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value) ids.push(value);
  }
  // A conflict prediction names the lanes it covered rather than one row.
  const laneIds = record.laneIds;
  if (Array.isArray(laneIds)) {
    for (const laneId of laneIds) {
      if (typeof laneId === "string" && laneId) ids.push(laneId);
    }
  }
  return [...new Set(ids)];
}

/**
 * The window's end of the plugin-page relay, mounted once in `AppShell`.
 *
 * It draws nothing. Three long-lived subscriptions live here because all three
 * belong to the WINDOW rather than to any one guest, and a guest is the wrong
 * place for every one of them:
 *
 * 1. **The UI relay.** Main asks this window to move a piece of ADE's own UI on
 *    a page's behalf. One listener for every guest, because the request carries
 *    the `guestKey` and the registry turns that into the surface that owns it.
 * 2. **The theme.** Published on mount and on every change, once for the window.
 *    A guest cannot read the host's stylesheet, and per-guest publishing would
 *    send the same palette N times for one toggle of one switch.
 * 3. **Hot reload.** Main tells every window a plugin's bytes moved; the store
 *    turns that into a new key and every guest of that plugin recreates itself,
 *    wherever it is drawn.
 *
 * A fourth belongs to the window for the same reason:
 *
 * 4. **Chat turn state.** A page that launched an agent has no other way to
 *    learn that the turn it started finished or died — the session exists
 *    either way, so the identity-only entity feed says nothing. The chat event
 *    stream is one window-wide subscription regardless of how many guests are
 *    open, and the relay fans one turn out to whichever of them asked for
 *    `chat`.
 *
 * A host with no relay members — a packaged app from before the page tier —
 * mounts this and does nothing, which is the honest degradation: plugin pages
 * still draw, and the verbs that move ADE's UI are refused by a main process
 * that never sends a request in the first place.
 */
export function PluginWebviewRelayHost() {
  const theme = useRootAppStore((state) => state.theme);
  const pluginTheme = useRootAppStore((state) => state.pluginThemeId);

  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    if (!relay) return;
    return installPluginWebviewRelay(relay);
  }, []);

  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    if (!relay) return;
    return relay.onReload((payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const record = payload as Record<string, unknown>;
      if (typeof record.pluginId !== "string" || !record.pluginId) return;
      applyPluginWebviewReload({
        pluginId: record.pluginId,
        version: typeof record.version === "string" ? record.version : "",
        revision: typeof record.revision === "number" ? record.revision : 0,
      });
    });
  }, []);

  // Chat turn state, for a page that launched an agent. Event-driven end to
  // end: one subscription to the stream the app's own chat surfaces read, no
  // poll and no timer, and nothing published for a session that never moves.
  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    // Both probed at runtime rather than trusted from the type: a packaged app
    // from before the chat host kind publishes no `publishChatTurn`, and the
    // subscription must then not be opened at all rather than throw on the
    // first event of the session.
    const publishChatTurn = relay?.publishChatTurn;
    const onEvent = window.ade?.agentChat?.onEvent;
    if (!relay || typeof publishChatTurn !== "function" || typeof onEvent !== "function") return;
    const isNewTurn = createPluginWebviewChatTurnDedupe();
    return onEvent((envelope) => {
      const turn = pluginWebviewChatTurnFromEvent(envelope);
      if (!turn || !isNewTurn(turn)) return;
      publishChatTurn.call(relay, turn);
    });
  }, []);

  // Operations, conflicts and review runs, for a History, Graph or Review page.
  //
  // The window publishes these for the same reason it publishes chat turns: the
  // entity bus in main is fed by the daemon and knows nothing about any of the
  // three, while this renderer already holds a live subscription to each. The
  // frames carry identity only — a page that hears its family moved refetches
  // through its own plugin's handler, under the ordinary gates.
  //
  // Operations are the one with no event channel of its own: the History
  // surface reads them on demand, and what announces a NEW one is a rebase,
  // which is the write that creates the row. So that frame names no ids and
  // says so, which is the bus's own documented signal for "refetch the family".
  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    const publishHostChange = relay?.publishHostChange;
    if (!relay || typeof publishHostChange !== "function") return;
    const publish = (kind: string, ids: string[]): void => {
      publishHostChange.call(relay, { kind, ids });
    };
    const stops: Array<() => void> = [];
    const conflicts = window.ade?.conflicts?.onEvent;
    if (typeof conflicts === "function") {
      stops.push(conflicts((event) => publish("conflict", readHostChangeIds(event))));
    }
    const review = window.ade?.review?.onEvent;
    if (typeof review === "function") {
      stops.push(review((event) => publish("review", readHostChangeIds(event))));
    }
    const rebase = window.ade?.lanes?.rebaseSubscribe;
    if (typeof rebase === "function") {
      stops.push(rebase(() => publish("operation", [])));
    }
    return () => {
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // One failed unsubscribe must not strand the others.
        }
      }
    };
  }, []);

  // The last snapshot actually sent, so a re-render that changed nothing does
  // not push the palette at every open guest again.
  const published = React.useRef<PluginWebviewThemeSnapshot | null>(null);
  React.useEffect(() => {
    const relay = pluginWebviewRelayBridge();
    if (!relay) return;
    // A frame late on purpose. `App` writes `data-theme` in its own effect, and
    // a computed style read in the same commit would return the palette that is
    // on its way out — which a page would then hold until the next change.
    const timer = requestAnimationFrame(() => {
      const snapshot = readPluginWebviewTheme(theme);
      if (pluginWebviewThemeEqual(published.current, snapshot)) return;
      published.current = snapshot;
      relay.publishTheme(snapshot);
    });
    return () => cancelAnimationFrame(timer);
    // `pluginTheme` is in the list because a `theme` plugin rewrites the very
    // custom properties this reads without touching `theme`: applying one would
    // otherwise leave every plugin page on the palette ADE shipped.
  }, [theme, pluginTheme]);

  return null;
}

export default PluginWebviewRelayHost;
