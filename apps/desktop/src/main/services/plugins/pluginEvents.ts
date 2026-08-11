/**
 * Plugin change notifications — the daemon half of `window.ade.plugins.onChanged`.
 *
 * ## Why a module-level bus
 *
 * The plugin host is a machine-scoped singleton (D2) but the event buffer that
 * carries notifications to clients is per project runtime. The producers — the
 * install service, a child supervisor, a project's data store — are constructed
 * at three different depths inside the host, and threading a callback down to
 * each of them would mean editing the host's constructor for every new producer.
 * A module-level bus matches the host's own lifetime and lets a producer emit
 * without knowing which projects are currently open.
 *
 * ## The subscription contract
 *
 * Each project runtime subscribes once at bootstrap and republishes what it
 * hears into its own `eventBuffer` as a **`runtime`-category event with
 * `payload.type === "plugin_changed"`**, alongside the payload fields of
 * {@link PluginChangeEvent}. That rides the existing `runtime/event` RPC
 * notification, so:
 *
 * - Clients subscribe with the ordinary runtime-events subscription and filter
 *   on `payload.type`. No new category, no new transport, and no change to the
 *   forwarding filter in `multiProjectRpcServer.ts` — the `category` union there
 *   is closed and consumed by clients that would drop an unknown value, so a
 *   fifth category would be a breaking wire change to buy nothing. Lane events
 *   (`lane_head_changed`, `lane_rebase_event`, …) already use this shape.
 * - **A plugin event is machine-wide, so every open project reports it.** A
 *   client watching two projects sees an install twice. That is correct — an
 *   install genuinely changed the state of both — and consumers must treat
 *   these as idempotent "something changed, refetch" hints rather than a
 *   counted stream.
 *
 * ## What consumers must NOT assume
 *
 * The event carries identity, never content: `{pluginId, kind}` and at most the
 * `collection`/`panelId` that moved. It is a cache-invalidation hint, so a
 * consumer refetches through the normal read actions (`plugin.getPanel`,
 * `plugin.getCollection`, `plugin.list`). Payloads deliberately carry no rows —
 * a fan-out of plugin data to every open project is exactly the cost the
 * budgets exist to prevent.
 */

import type { PluginRuntimeStatus } from "../../../shared/plugins/sdk";

/**
 * What moved.
 *
 * The first four match `renderer/lib/pluginRuntimeBridge.ts`'s
 * `PluginChangeEvent` exactly so the preload layer can forward them verbatim.
 * `contributions` is additive for the socket surfaces; a client compiled
 * against the four-member union should treat an unrecognized kind as a generic
 * "refetch everything for this plugin" rather than dropping it.
 */
export type PluginChangeKind = "installs" | "panels" | "collections" | "contributions" | "status";

export type PluginChangeEvent = {
  kind: PluginChangeKind;
  /** Absent only for a change that is not attributable to one plugin. */
  pluginId?: string;
  /** Set when `kind` is `collections`. */
  collection?: string;
  /** Set when `kind` is `panels`. */
  panelId?: string;
  /** Set when `kind` is `status`. */
  status?: PluginRuntimeStatus;
};

/** The `payload.type` every republished plugin event carries. */
export const PLUGIN_CHANGED_EVENT_TYPE = "plugin_changed";

const listeners = new Set<(event: PluginChangeEvent) => void>();

/**
 * Publish a change. Never throws: a producer is usually mid-write when it calls
 * this, and a listener's failure must not roll back the write that succeeded.
 */
export function emitPluginChange(event: PluginChangeEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A broken subscriber loses its notification, not the caller's write.
    }
  }
}

/** Subscribe; call the returned function to detach (project scopes do, on dispose). */
export function subscribeToPluginChanges(listener: (event: PluginChangeEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. Production code has no reason to drop other scopes' subscribers. */
export function resetPluginChangeListenersForTests(): void {
  listeners.clear();
}
