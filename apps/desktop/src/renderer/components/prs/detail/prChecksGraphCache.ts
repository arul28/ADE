/**
 * Module-scoped cache for `prs.getWorkflowGraph`, plus in-flight de-duplication.
 *
 * ## Why this exists
 *
 * The CI tab is unmounted the moment the user looks at Overview, so every visit
 * used to re-run the graph fetch. That fetch is not cheap: on the service side
 * `getWorkflowGraph` re-reads the Actions runs page, the per-run jobs, the
 * combined status and the check-runs page for the same head SHA the detail
 * pane's own 5-second loop already polled. Tab-hopping was therefore paying a
 * full extra round of GitHub reads for data the pane had in memory, and paying
 * a 2–3 second layout flash for it.
 *
 * The graph's *shape* — nodes and `needs:` edges — is a property of the workflow
 * YAML at a head SHA. It does not change while that SHA is the head. Live state
 * is layered back on by `hydrateWorkflowGraph` from the checks the pane already
 * polls, so a cached graph is not a stale graph: it is the same edges with
 * current state. Caching the shape and re-hydrating it is what lets a re-open
 * cost zero GitHub requests and still show live durations.
 *
 * ## What is deliberately NOT cached
 *
 * A rejection. A failed read that got cached as "there is no graph here" is the
 * 2026-08-17 failure mode in miniature: an unreadable answer wearing the costume
 * of an empty one. Rejections are handed back to the caller so it can arm the
 * poll governor and say so on screen, and the next attempt starts from nothing.
 *
 * An *uncharted* success (no graph, or `source: "none"`) is cached, but only
 * briefly. The service swallows GitHub failures internally and can answer
 * `source: "none"` when the real reason is that GitHub was unreachable, so
 * freezing that answer for the full TTL would hide a recovery. A charted graph
 * gets the long TTL because it cannot be wrong in that way.
 */

import type { PrWorkflowGraph } from "../../../../shared/types";

/** A charted graph is a property of the head SHA; it is safe to hold. */
export const CHECKS_GRAPH_CHARTED_TTL_MS = 5 * 60_000;
/**
 * An uncharted answer may be an unreachable GitHub in disguise (the service
 * folds its own read failures into `source: "none"`), so it expires fast enough
 * that a recovered GitHub is noticed on the next visit.
 */
export const CHECKS_GRAPH_UNCHARTED_TTL_MS = 45_000;
/** Enough for a session's worth of PR-hopping; keeps the map from growing. */
export const CHECKS_GRAPH_CACHE_MAX_ENTRIES = 24;

export type ChecksGraphCacheEntry = {
  /** `null` means "this runtime answered, and there is no graph". */
  graph: PrWorkflowGraph | null;
  storedAtMs: number;
  expiresAtMs: number;
};

const cache = new Map<string, ChecksGraphCacheEntry>();

/**
 * Cache key. The head SHA is part of it because a push produces a genuinely
 * different pipeline; when the caller has no SHA yet the key degrades to the PR
 * id, and the entry is replaced once a SHA arrives.
 */
export function checksGraphCacheKey(prId: string, headSha: string | null | undefined): string {
  return `${prId}@${headSha ?? ""}`;
}

/** True when a graph has real dependency structure to draw. */
export function isChartedGraph(graph: PrWorkflowGraph | null | undefined): boolean {
  return Boolean(graph && graph.source !== "none" && graph.nodes.length > 0 && graph.edges.length > 0);
}

export function readChecksGraphCache(
  key: string,
  now: number = Date.now(),
): ChecksGraphCacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= now) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function writeChecksGraphCache(
  key: string,
  graph: PrWorkflowGraph | null,
  now: number = Date.now(),
): ChecksGraphCacheEntry {
  const ttl = isChartedGraph(graph) ? CHECKS_GRAPH_CHARTED_TTL_MS : CHECKS_GRAPH_UNCHARTED_TTL_MS;
  const entry: ChecksGraphCacheEntry = { graph, storedAtMs: now, expiresAtMs: now + ttl };
  // Re-insert so the map's insertion order is a true LRU-by-write.
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CHECKS_GRAPH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return entry;
}

export function invalidateChecksGraphCache(key?: string): void {
  if (key == null) cache.clear();
  else cache.delete(key);
}

const inFlight = new Map<string, Promise<PrWorkflowGraph | null>>();

/**
 * Run `fetcher` at most once per key at a time.
 *
 * Two mounts of the CI tab in the same tick — a re-render race, React's
 * development double-effect, or the user bouncing between tabs — must cost one
 * GitHub read, not two. A rejection is shared with every waiter and then
 * forgotten, so the next attempt is a real attempt.
 */
export function fetchChecksGraphOnce(
  key: string,
  fetcher: () => Promise<PrWorkflowGraph | null>,
): Promise<PrWorkflowGraph | null> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = fetcher().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Test seam. Production code never needs this. */
export function resetChecksGraphCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Should an already-resolved graph be re-fetched now that Actions runs exist?
 *
 * Only when the answer we hold charted nothing AND CI has since reported — i.e.
 * the graph was built before the first run existed. A charted graph is never
 * re-fetched on this signal: its edges cannot change under a fixed head SHA, and
 * re-asking would put a second full round of GitHub reads on the hottest path in
 * the app for no new information.
 */
export function shouldRefetchOnFirstActionRun(args: {
  graph: PrWorkflowGraph | null;
  hasActionRuns: boolean;
}): boolean {
  return args.hasActionRuns && !isChartedGraph(args.graph);
}
