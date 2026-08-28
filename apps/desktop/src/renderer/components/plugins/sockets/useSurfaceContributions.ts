import React from "react";

import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import {
  type PluginContribution,
  type PluginSocketKind,
  type PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import {
  derivedSetFor,
  rowsStoreFor,
  sourcesStore,
} from "./contributionStores";
import { runPluginSocketAction } from "./pluginActionDispatch";
import {
  pluginContextMemoKey,
  pluginViewerRegistrations,
  selectContributions,
  EMPTY_CONTRIBUTION_SET,
  type PluginViewerRegistration,
  type SurfaceContributionSet,
} from "./contributionModel";

/**
 * One read per surface, joined in memory — the hooks over the caches.
 *
 * The two module-level stores those reads land in live in `./contributionStores`,
 * which has no React in it so a plain dispatcher can read the same snapshot. What
 * is left here is the React half: subscribing a component to a store, memoizing
 * the derived set, and narrowing it to one socket for one entity.
 */

/** Everything contributed to a surface. `active` false keeps it inert and empty. */
export function usePluginSurfaceContributions(
  surface: PluginSurfaceId,
  active: boolean,
): SurfaceContributionSet {
  const rowsStore = rowsStoreFor(surface);
  const sources = React.useSyncExternalStore(sourcesStore.subscribe, sourcesStore.getSnapshot);
  const rows = React.useSyncExternalStore(rowsStore.subscribe, rowsStore.getSnapshot);

  React.useEffect(() => {
    if (!active) return;
    sourcesStore.ensureLoaded();
    rowsStore.ensureLoaded();
  }, [active, rowsStore, sources.status, rows.status]);

  return React.useMemo(
    () => (active ? derivedSetFor(surface, sources.sources, rows.rows) : EMPTY_CONTRIBUTION_SET),
    [active, rows.rows, sources.sources, surface],
  );
}

/**
 * The contributions one socket renders.
 *
 * **`surface` and `context` answer different questions, and reading them as one
 * is the misread this comment exists to prevent.** `surface` picks which
 * contribution SET to read — which manifest declarations are in scope, and which
 * dynamic rows got loaded. `context` picks which entity's rows *inside* that
 * set. So `surface: "work"` means "this kind is declared on the Work tab", never
 * "this contribution is filed against the Work tab".
 *
 * The consequence is in {@link selectContributions}: an entity context resolves
 * through `pluginContributionKeyForContext` to a real entity key, which
 * short-circuits the surface fallback entirely. A call passing a session context
 * reads `session`-keyed rows and *never* looks at `{entityKind: "surface"}` rows,
 * even though it named a surface one argument earlier.
 *
 * `context` narrows dynamic rows to a single entity; omit it on toolbars, chips
 * and empty states, which have no subject and therefore do take the surface
 * fallback.
 *
 * This is worth spelling out because the two shapes look identical at a glance —
 * a toolbar action and a chat-header action are the same call with a different
 * second argument — and a client that copied the wrong one would file a kind
 * against the tab instead of the chat. It would then render rows desktop ignores
 * and ignore the rows desktop renders, which is the cross-client divergence the
 * whole taxonomy exists to make impossible. `contributionModel.test.ts` pins the
 * behaviour under "chat-header-action is filed per session, not per surface".
 */
export function useSurfaceContributions<K extends PluginSocketKind>(
  surface: PluginSurfaceId,
  socket: K,
  options: { active?: boolean; context?: PluginSurfaceContext | null } = {},
): PluginContribution<K>[] {
  const active = options.active ?? true;
  const set = usePluginSurfaceContributions(surface, active);
  const context = options.context ?? null;
  const contextKey = pluginContextMemoKey(context);
  return React.useMemo(
    () => selectContributions(set, socket, context),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contextKey stands in for `context`
    [set, socket, contextKey],
  );
}

/** File-viewer registrations from every installed plugin. */
export function usePluginFileViewers(active = true): PluginViewerRegistration[] {
  const sources = React.useSyncExternalStore(sourcesStore.subscribe, sourcesStore.getSnapshot);

  React.useEffect(() => {
    if (!active) return;
    sourcesStore.ensureLoaded();
  }, [active, sources.status]);

  return React.useMemo(
    () => (sources.sources.length === 0 ? [] : pluginViewerRegistrations(sources.sources)),
    [sources.sources],
  );
}

/**
 * Dispatch a socket action with its typed context attached.
 *
 * Failures surface as a toast rather than a console line: a plugin button that
 * appears to do nothing is indistinguishable from a plugin that is broken, and
 * the person clicking it is the one who can act on the difference.
 *
 * The returned promise settles when the action and its response verbs are done,
 * so a caller that draws a busy state knows when to stop. It never rejects —
 * the toast is the error path — which is why callers may ignore it entirely.
 *
 * Naming the `socket` the click came from sets the round-trip budget for it: a
 * `composer-action` that records or transcribes runs for minutes by design,
 * while a button on a row keeps the 60s default. A caller that names nothing
 * gets the default, which is what every socket had before this existed.
 *
 * `timeoutMs` overrides that for a caller with no socket to name — a plugin
 * slash command invoked from the composer is the same long-running work
 * wearing a different affordance, and it would be a lie to call it a
 * `composer-action` just to inherit the budget. The host clamps whatever is
 * asked for; see `clampPluginInvokeTimeoutMs`.
 *
 * The dispatch itself lives in `./pluginActionDispatch`, because one caller is
 * not a component: the chat-card action bridge is a window listener, and it has
 * to honour the response verbs identically.
 */
export function usePluginSocketInvoke(): (
  pluginId: string,
  actionId: string,
  context: PluginSurfaceContext,
  options?: { socket?: PluginSocketKind; timeoutMs?: number },
) => Promise<void> {
  return React.useCallback(runPluginSocketAction, []);
}
