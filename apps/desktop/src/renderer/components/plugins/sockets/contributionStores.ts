/**
 * The module-level caches every socket surface selects from.
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
 * caller passes `active: true`, because Work and Lanes stay mounted behind other
 * tabs and a hidden surface must cost nothing. And a hidden surface's change
 * subscription does not refetch — it marks the data stale and the next reveal
 * picks it up, which is the same freshness without the churn.
 *
 * ## Why this is not inside `useSurfaceContributions`
 *
 * It was, until a plain function needed the same snapshot. `pluginActionDispatch`
 * decides where a `{navigate}` goes, and "does this plugin own a pane in the Work
 * rail?" is answered by exactly the contributions the rail itself renders. That
 * dispatcher is not a component and must not become one, and importing it from
 * the hook module while the hook module imports the dispatcher is a cycle. The
 * stores have no React in them, so they move here and both sides import down.
 */

import { subscribeToPluginChanges } from "../../../lib/pluginRuntimeBridge";
import type { PluginSurfaceId } from "../../../../shared/plugins/sockets";
import {
  clearPluginManifestCache,
  loadPluginSocketSources,
  pluginSocketsAvailable,
  readSurfaceContributionRows,
  type PluginContributionRow,
  type PluginSocketSource,
} from "./contributionBridge";
import {
  buildContributionSet,
  pluginChangeAffects,
  surfaceContributionEntityKinds,
  EMPTY_CONTRIBUTION_SET,
  type SurfaceContributionSet,
} from "./contributionModel";

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

export type SourcesSnapshot = {
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

  /**
   * Called by every visible surface; collapses into one read.
   *
   * A read that could not reach the host leaves `stale` SET, so the next render
   * of any visible surface asks again. That is the whole repair for menu rows
   * that stayed dead after a cold launch: the plugin host lives in the daemon
   * and is not bound for the first stretch of a launch, and this store used to
   * bank that first refusal as a successful "no plugins", clear `stale`, and
   * never ask again — leaving recovery to whatever unrelated plugin event
   * happened along next. Only an answer the host actually gave settles it.
   */
  ensureLoaded(): void {
    this.listenForChanges();
    if (!this.stale || this.inflight) return;
    if (!pluginSocketsAvailable()) {
      // The namespace itself is missing. That is a fact about the BUILD (the
      // hosted web client, an older host), not a runtime that has yet to bind,
      // so it settles — nothing is coming later to change it.
      this.stale = false;
      this.set({ status: "ready", sources: [] });
      return;
    }
    this.set({ ...this.getSnapshot(), status: "loading" });
    this.inflight = loadPluginSocketSources()
      .then((load) => {
        if (!load.ok) {
          // Left stale on purpose. `status` still goes to `ready` so a surface
          // renders its empty state rather than a spinner that never stops.
          this.set({ status: "ready", sources: this.getSnapshot().sources });
          return;
        }
        this.stale = false;
        this.set({ status: "ready", sources: load.sources });
      })
      .catch(() => {
        this.set({ status: "ready", sources: this.getSnapshot().sources });
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

export const sourcesStore = new SourcesStore();

export type RowsSnapshot = {
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

  /**
   * One reveal, one load — but two reads, because a surface has two kinds of
   * row: the entities it lists, and the tab itself.
   *
   * `surfaceContributionEntityKinds` decides which, and dedupes the three
   * surfaces that already ARE `surface`. The reads are concurrent and land as a
   * single snapshot, so the store still has exactly one inflight promise and a
   * surface with a hundred rows still costs one reveal, not one per row.
   *
   * A failing read yields no rows rather than rejecting the pair: a host too old
   * to answer for one entity kind must not blank the kind it does answer for.
   */
  ensureLoaded(): void {
    this.listenForChanges();
    if (!this.stale || this.inflight) return;
    this.stale = false;
    this.inflight = Promise.all(
      surfaceContributionEntityKinds(this.surface).map((entityKind) =>
        readSurfaceContributionRows(this.surface, entityKind).catch(() => [] as PluginContributionRow[])),
    )
      .then((results) => {
        this.set({ status: "ready", rows: results.flat() });
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

export function rowsStoreFor(surface: PluginSurfaceId): RowsStore {
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

export function derivedSetFor(
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
