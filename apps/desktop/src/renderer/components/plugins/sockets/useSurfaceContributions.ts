import React from "react";

import { showToast } from "../../app/toast/toastStore";
import { subscribeToPluginChanges } from "../../../lib/pluginRuntimeBridge";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import type {
  PluginContribution,
  PluginSocketKind,
  PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import {
  invokePluginSocketAction,
  pluginSocketsAvailable,
  readPluginSocketSources,
  readSurfaceContributionRows,
  type PluginContributionRow,
  type PluginSocketSource,
} from "./contributionBridge";
import {
  buildContributionSet,
  pluginChangeAffects,
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
  // Contexts are rebuilt from row data on every render, so the memo keys on the
  // entity identity rather than the object.
  const contextKey = context ? `${context.kind}:${entityIdOf(context)}` : "";
  return React.useMemo(
    () => selectContributions(set, socket, context),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contextKey stands in for `context`
    [set, socket, contextKey],
  );
}

function entityIdOf(context: PluginSurfaceContext): string {
  switch (context.kind) {
    case "pr":
      return String(context.number);
    case "lane":
    case "session":
      return context.id;
    case "file":
      return context.path;
    case "surface":
      return context.surface;
  }
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
 */
export function usePluginSocketInvoke(): (
  pluginId: string,
  actionId: string,
  context: PluginSurfaceContext,
) => void {
  return React.useCallback((pluginId, actionId, context) => {
    void invokePluginSocketAction(pluginId, actionId, { context }).catch((cause: unknown) => {
      showToast({
        title: "Plugin action failed",
        message: cause instanceof Error ? cause.message : `${pluginId} couldn’t run ${actionId}.`,
        tone: "error",
      });
    });
  }, []);
}

/** Test seam: drops every cached read so a suite starts from a cold host. */
export function resetPluginSocketCachesForTests(): void {
  rowsStores.clear();
  derivedSets.clear();
}
