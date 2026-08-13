import React from "react";

import { showToast } from "../../app/toast/toastStore";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { subscribeToPluginChanges } from "../../../lib/pluginRuntimeBridge";
import {
  hasPluginActionComposerRequest,
  readPluginActionComposerEdit,
  readPluginActionNavigation,
} from "../../../../shared/plugins/sdk";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import {
  pluginSocketInvokeTimeoutMs,
  type PluginContribution,
  type PluginSocketKind,
  type PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import {
  clearPluginManifestCache,
  invokePluginSocketAction,
  pluginSocketsAvailable,
  readPluginSocketSources,
  readSurfaceContributionRows,
  type PluginContributionRow,
  type PluginSocketSource,
} from "./contributionBridge";
import { applyPluginComposerEdit } from "./composerTarget";
import {
  buildContributionSet,
  pluginChangeAffects,
  pluginContextMemoKey,
  pluginViewerRegistrations,
  selectContributions,
  SURFACE_ENTITY_KIND,
  EMPTY_CONTRIBUTION_SET,
  type PluginViewerRegistration,
  type SurfaceContributionSet,
} from "./contributionModel";

/**
 * One read per surface, joined in memory.
 *
 * Sockets sit on rows, and rows are the one place in this app where a careless
 * `useEffect` costs real money — a per-row fetch on the Lanes tab is a hundred
 * IPC round trips on a tab that is permanently mounted. So the data lives in two
 * module-level stores and the components only ever select from them:
 *
 * - **Installed plugins and their manifests** are global. Six surfaces share one
 *   read, refreshed when the host says an install changed.
 * - **Dynamic `plugin_contributions` rows** are per surface, read when that
 *   surface first becomes visible.
 *
 * Two perf laws are structural here rather than advisory. Nothing loads until a
 * hook passes `active: true`, because Work and Lanes stay mounted behind other
 * tabs and a hidden surface must cost nothing. And a hidden surface's change
 * subscription does not refetch — it marks the data stale and the next reveal
 * picks it up, which is the same freshness without the churn.
 */

type Listener = () => void;

class Store<T> {
  private listeners = new Set<Listener>();

  protected snapshot: T;

  constructor(initial: T) {
    this.snapshot = initial;
  }

  getSnapshot = (): T => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected set(next: T): void {
    if (Object.is(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

type SourcesSnapshot = {
  status: "idle" | "loading" | "ready";
  sources: readonly PluginSocketSource[];
};

const EMPTY_SOURCES: SourcesSnapshot = { status: "idle", sources: [] };

class SourcesStore extends Store<SourcesSnapshot> {
  private inflight: Promise<void> | null = null;

  private stale = true;

  private unsubscribe: (() => void) | null = null;

  constructor() {
    super(EMPTY_SOURCES);
  }

  /** Called by every visible surface; collapses into one read. */
  ensureLoaded(): void {
    this.listenForChanges();
    if (!this.stale || this.inflight) return;
    if (!pluginSocketsAvailable()) {
      this.stale = false;
      this.set({ status: "ready", sources: [] });
      return;
    }
    this.stale = false;
    this.set({ ...this.getSnapshot(), status: "loading" });
    this.inflight = readPluginSocketSources()
      .then((sources) => {
        this.set({ status: "ready", sources });
      })
      .catch(() => {
        this.set({ status: "ready", sources: [] });
      })
      .finally(() => {
        this.inflight = null;
      });
  }

  private listenForChanges(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToPluginChanges((event) => {
      if (!pluginChangeAffects("sources", event.kind)) return;
      // `status` is child-process health, which moves several times per plugin
      // start and cannot change a manifest. Anything else can, including a
      // kind this build has not learned about yet.
      if (event.kind !== "status") clearPluginManifestCache();
      this.stale = true;
      // Deliberately does NOT refetch here. A visible surface re-runs
      // `ensureLoaded` on its next render; a hidden one picks it up on reveal.
      // Plugin events are machine-wide, so an install with two projects open
      // arrives twice — marking stale is idempotent, a refetch would not be.
      this.set({ ...this.getSnapshot(), status: "idle" });
    });
  }
}

const sourcesStore = new SourcesStore();

type RowsSnapshot = {
  status: "idle" | "loading" | "ready";
  rows: readonly PluginContributionRow[];
};

const EMPTY_ROWS: RowsSnapshot = { status: "idle", rows: [] };

class RowsStore extends Store<RowsSnapshot> {
  private inflight: Promise<void> | null = null;

  private stale = true;

  private unsubscribe: (() => void) | null = null;

  constructor(private readonly surface: PluginSurfaceId) {
    super(EMPTY_ROWS);
  }

  ensureLoaded(): void {
    this.listenForChanges();
    if (!this.stale || this.inflight) return;
    this.stale = false;
    this.inflight = readSurfaceContributionRows(this.surface, SURFACE_ENTITY_KIND[this.surface])
      .then((rows) => {
        this.set({ status: "ready", rows });
      })
      .catch(() => {
        this.set({ status: "ready", rows: [] });
      })
      .finally(() => {
        this.inflight = null;
      });
  }

  private listenForChanges(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeToPluginChanges((event) => {
      if (!pluginChangeAffects("contributions", event.kind)) return;
      this.stale = true;
      this.set({ ...this.getSnapshot(), status: "idle" });
    });
  }
}

const rowsStores = new Map<PluginSurfaceId, RowsStore>();

function rowsStoreFor(surface: PluginSurfaceId): RowsStore {
  const existing = rowsStores.get(surface);
  if (existing) return existing;
  const created = new RowsStore(surface);
  rowsStores.set(surface, created);
  return created;
}

/**
 * Derived sets, memoized per surface on the identity of their two inputs.
 *
 * Two hundred rows on one surface call this; they must all get the *same*
 * object, or every row memo downstream breaks and the virtualized list rebuilds
 * on each render.
 */
const derivedSets = new Map<
  PluginSurfaceId,
  { sources: readonly PluginSocketSource[]; rows: readonly PluginContributionRow[]; set: SurfaceContributionSet }
>();

function derivedSetFor(
  surface: PluginSurfaceId,
  sources: readonly PluginSocketSource[],
  rows: readonly PluginContributionRow[],
): SurfaceContributionSet {
  const cached = derivedSets.get(surface);
  if (cached && cached.sources === sources && cached.rows === rows) return cached.set;
  const set = sources.length === 0 ? EMPTY_CONTRIBUTION_SET : buildContributionSet(sources, rows, surface);
  derivedSets.set(surface, { sources, rows, set });
  return set;
}

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
 * `context` narrows dynamic rows to a single entity; omit it on toolbars, chips
 * and empty states, which have no subject.
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
 */
export function usePluginSocketInvoke(): (
  pluginId: string,
  actionId: string,
  context: PluginSurfaceContext,
  options?: { socket?: PluginSocketKind },
) => Promise<void> {
  return React.useCallback((pluginId, actionId, context, options) => (
    invokePluginSocketAction(
      pluginId,
      actionId,
      { context },
      { timeoutMs: pluginSocketInvokeTimeoutMs(options?.socket) },
    )
      .then((result) => {
        // Applied before navigation, which may take the composer off screen:
        // an action that writes a draft and then opens its own panel should do
        // both, in the order the plugin can predict.
        const edit = readPluginActionComposerEdit(result);
        if (edit) applyPluginComposerEdit(edit, { context, pluginId, actionId });
        else if (hasPluginActionComposerRequest(result)) {
          // The plugin asked and this client refused: a non-string verb, an
          // empty insert, or text over PLUGIN_COMPOSER_TEXT_MAX_BYTES.
          console.warn("[plugin composer] ignored a malformed composer edit", pluginId, actionId);
        }
        // An action may ask to be followed: "I filed the issue, here it is."
        // Routed through the ordinary navigation target rather than a direct
        // `navigate`, so it passes the same installed-and-enabled gate a
        // `plugin` deeplink does and lands on the same addressable URL.
        const navigation = readPluginActionNavigation(result);
        if (!navigation) return;
        navigateToAppTarget({
          kind: "plugin",
          pluginId,
          panelId: navigation.panelId,
          context: navigation.context ?? null,
        });
      })
      .catch((cause: unknown) => {
        showToast({
          title: "Plugin action failed",
          message: cause instanceof Error ? cause.message : `${pluginId} couldn’t run ${actionId}.`,
          tone: "error",
        });
      })
  ), []);
}
