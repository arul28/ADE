/**
 * Pure layout maths for the CI / Checks DAG.
 *
 * React Flow positions nodes; it does not lay them out. This module owns every
 * coordinate the canvas draws, deliberately free of React and the DOM so the
 * layering, the crossing-reduction pass, and the critical-path marking can be
 * unit-tested without a renderer.
 *
 * The layering is computed from the EDGES, not from the service's `tier`. The
 * two normally agree, but `tier` is a per-workflow number: two workflows on the
 * same PR both start at tier 0, and honouring that blindly puts an unrelated
 * job in the same column as a root. `tier` is kept only as a stable tiebreaker
 * for the initial within-layer order.
 *
 * Nothing here guesses an edge. An edge whose endpoints are not both present is
 * dropped, and a node with no incoming edge is a root — which is the same rule
 * the graph service uses when it reads `needs:`.
 */

import type {
  PrPipelineState,
  PrWorkflowGraphEdge,
  PrWorkflowGraphNode,
} from "../../../../shared/types";

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Separator for `from`/`to` edge keys. A NUL cannot occur in a workflow job id,
 * so two different edges can never collide on one key.
 */
const EDGE_KEY_SEPARATOR = "\u0000";

/**
 * On a real run the graph is taller than it is wide, so `fitView` is height-
 * constrained and the horizontal budget is free. Widening the card therefore
 * costs no zoom at all and buys back the job name that used to truncate.
 */
export const CHECKS_NODE_WIDTH = 234;
/** Icon row + name + duration. */
export const CHECKS_NODE_BASE_HEIGHT = 48;
/** Matrix pip strip plus its one-line caption. */
export const CHECKS_NODE_LEGS_HEIGHT = 26;
/** Step-progress bar, shown only inside a job that is executing right now. */
export const CHECKS_NODE_PROGRESS_HEIGHT = 14;
/** Horizontal gap between layer columns — wide enough for a readable connector. */
export const CHECKS_COLUMN_GAP = 78;
/** Vertical gap between nodes inside a column. */
export const CHECKS_ROW_GAP = 14;
/**
 * Padding React Flow's `fitView` should leave around the graph. Every point of
 * padding is zoom taken off the labels, so this is the smallest gutter that
 * still keeps the outermost cards clear of the canvas border.
 */
export const CHECKS_FIT_VIEW_PADDING = 0.1;

/**
 * True when a node shows its step progress: only while it is executing, and
 * only when GitHub actually reported steps for it.
 */
export function checksNodeShowsProgress(
  node: Pick<PrWorkflowGraphNode, "state" | "steps">,
): boolean {
  return node.state === "running" && (node.steps?.length ?? 0) > 0;
}

/** Height of one node, driven only by what the node actually renders. */
export function checksNodeHeight(
  node: Pick<PrWorkflowGraphNode, "legs"> & Partial<Pick<PrWorkflowGraphNode, "state" | "steps">>,
): number {
  return CHECKS_NODE_BASE_HEIGHT
    + (node.legs.length > 0 ? CHECKS_NODE_LEGS_HEIGHT : 0)
    + (checksNodeShowsProgress({ state: node.state ?? "unknown", steps: node.steps ?? [] })
      ? CHECKS_NODE_PROGRESS_HEIGHT
      : 0);
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type ChecksGraphLayoutNode = {
  node: PrWorkflowGraphNode;
  /** Top-left corner, in React Flow flow coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0-based dependency depth. Column index. */
  layer: number;
  /** Position inside the column, top to bottom. */
  indexInLayer: number;
  onCriticalPath: boolean;
};

export type ChecksGraphLayoutEdge = {
  /** Stable id: React Flow keys on it, so it must not depend on position. */
  id: string;
  from: string;
  to: string;
  /** Both endpoints are consecutive on the service's critical path. */
  onCriticalPath: boolean;
  /**
   * The downstream job is executing right now. Only these edges animate — a
   * moving line into a queued or finished job lies about what the machine does.
   */
  live: boolean;
  /** The downstream job has not started, so nothing has flowed down this edge. */
  pending: boolean;
};

export type ChecksGraphLayout = {
  nodes: ChecksGraphLayoutNode[];
  edges: ChecksGraphLayoutEdge[];
  /** Bounding box of the laid-out graph. */
  width: number;
  height: number;
  /** Number of columns. */
  layerCount: number;
};

export const EMPTY_CHECKS_GRAPH_LAYOUT: ChecksGraphLayout = {
  nodes: [], edges: [], width: 0, height: 0, layerCount: 0,
};

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

/**
 * Highest column index a reported tier may claim.
 *
 * Generous on purpose: a partially-resolved graph can legitimately report a
 * tier well above its own node count, and honouring that is what keeps those
 * jobs on screen. The ceiling only exists so a malformed `tier: 1e6` cannot ask
 * the layout to allocate a million empty columns.
 */
const MAX_CHECKS_GRAPH_LAYER = 512;

/**
 * A reported tier, forced into a usable column index.
 *
 * The truncation is the important half: the tier indexes an array, and a
 * fractional `1.5` indexes nothing — `byLayer[1.5]` is `undefined` and the push
 * throws mid-render, taking the PR detail pane with it.
 */
function clampTier(tier: number): number {
  if (!Number.isFinite(tier)) return 0;
  return Math.min(Math.max(0, Math.trunc(tier)), MAX_CHECKS_GRAPH_LAYER);
}

/**
 * Longest-path layering over a DAG.
 *
 * Uses Kahn's algorithm so a cycle — which `needs:` cannot legally express, but
 * a malformed or partially-resolved graph can still hand us — is *detected*
 * rather than looped on. Nodes left unresolved by the topological pass fall
 * back to their reported `tier`, which keeps them on screen instead of dropping
 * them.
 */
export function assignChecksGraphLayers(
  nodes: PrWorkflowGraphNode[],
  edges: PrWorkflowGraphEdge[],
): Map<string, number> {
  const ids = new Set(nodes.map((node) => node.jobId));
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    successors.set(node.jobId, []);
    inDegree.set(node.jobId, 0);
  }
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    const key = `${edge.from}${EDGE_KEY_SEPARATOR}${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    successors.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const layers = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if ((inDegree.get(node.jobId) ?? 0) === 0) {
      layers.set(node.jobId, 0);
      queue.push(node.jobId);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    const layer = layers.get(id) ?? 0;
    for (const next of successors.get(id) ?? []) {
      layers.set(next, Math.max(layers.get(next) ?? 0, layer + 1));
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  // Anything still holding an in-degree sits on a cycle. Keep it visible on its
  // reported tier rather than silently dropping a job from the pipeline.
  for (const node of nodes) {
    if (!layers.has(node.jobId) || (inDegree.get(node.jobId) ?? 0) > 0) {
      // The tier indexes a column array, so it has to be a whole number inside
      // the node count. `Number.isFinite` alone admits `1.5` (which indexes
      // nothing and throws mid-render) and `1e6` (which allocates a million
      // empty columns).
      layers.set(node.jobId, clampTier(node.tier));
    }
  }
  return layers;
}

/**
 * Median (barycentre) crossing reduction, two sweeps down and one back up.
 *
 * This is the cheap, standard Sugiyama ordering heuristic. It is not optimal —
 * optimal crossing minimisation is NP-hard — but on the shape a CI pipeline
 * actually has (a handful of fan-outs into a gate) it removes essentially every
 * avoidable crossing, and it is stable: equal keys keep their previous order,
 * so the graph does not reshuffle between renders.
 */
function orderWithinLayers(
  byLayer: string[][],
  neighboursUp: Map<string, string[]>,
  neighboursDown: Map<string, string[]>,
): void {
  const positionOf = (layer: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    layer.forEach((id, index) => map.set(id, index));
    return map;
  };

  const sweep = (layer: string[], reference: Map<string, number>, neighbours: Map<string, string[]>) => {
    const keys = new Map<string, number>();
    // Captured BEFORE the sort: reading positions out of the array being sorted
    // makes the tiebreaker depend on how far the sort has already got.
    const previous = positionOf(layer);
    layer.forEach((id, index) => {
      const positions = (neighbours.get(id) ?? [])
        .map((other) => reference.get(other))
        .filter((value): value is number => value != null)
        .sort((a, b) => a - b);
      // No neighbour on the reference layer → hold this node where it is.
      keys.set(id, positions.length === 0 ? index : median(positions));
    });
    layer.sort((left, right) => (keys.get(left)! - keys.get(right)!)
      || (previous.get(left)! - previous.get(right)!));
  };

  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 1; index < byLayer.length; index += 1) {
      sweep(byLayer[index]!, positionOf(byLayer[index - 1]!), neighboursUp);
    }
    for (let index = byLayer.length - 2; index >= 0; index -= 1) {
      sweep(byLayer[index]!, positionOf(byLayer[index + 1]!), neighboursDown);
    }
  }
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Consecutive pairs on the critical path, as `from\0to` keys. */
export function criticalPathEdgeKeys(criticalPath: string[]): Set<string> {
  const keys = new Set<string>();
  for (let index = 1; index < criticalPath.length; index += 1) {
    keys.add(`${criticalPath[index - 1]}${EDGE_KEY_SEPARATOR}${criticalPath[index]}`);
  }
  return keys;
}

function edgeFlags(state: PrPipelineState | undefined): { live: boolean; pending: boolean } {
  return {
    live: state === "running",
    pending: state === "queued" || state === "unknown" || state === undefined,
  };
}

/**
 * Lay the pipeline out left-to-right, one column per dependency depth.
 *
 * Columns are vertically centred against the tallest one, which is what makes a
 * two-job fan-out read as "these two run in parallel" rather than "these two are
 * top-aligned under something".
 */
export function layoutChecksGraph(
  nodes: PrWorkflowGraphNode[],
  edges: PrWorkflowGraphEdge[],
  criticalPath: string[] = [],
): ChecksGraphLayout {
  if (nodes.length === 0) return EMPTY_CHECKS_GRAPH_LAYOUT;

  const byId = new Map(nodes.map((node) => [node.jobId, node] as const));
  const layers = assignChecksGraphLayers(nodes, edges);

  // Deduped, like the layering pass does: `needs: [a, a]` would otherwise weight
  // the barycentre median twice toward the same neighbour and reorder rows.
  const seenEdges = new Set<string>();
  const usableEdges = edges.filter((edge) => {
    if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) return false;
    const key = `${edge.from} ${edge.to}`;
    if (seenEdges.has(key)) return false;
    seenEdges.add(key);
    return true;
  });
  const neighboursUp = new Map<string, string[]>();
  const neighboursDown = new Map<string, string[]>();
  for (const node of nodes) {
    neighboursUp.set(node.jobId, []);
    neighboursDown.set(node.jobId, []);
  }
  for (const edge of usableEdges) {
    neighboursUp.get(edge.to)!.push(edge.from);
    neighboursDown.get(edge.from)!.push(edge.to);
  }

  const layerCount = Math.max(...nodes.map((node) => layers.get(node.jobId) ?? 0)) + 1;
  const byLayer: string[][] = Array.from({ length: layerCount }, () => []);
  // Seed each column in a deterministic order: the service's tier first (it
  // carries the YAML's declaration order), then the node's own index.
  const seeded = nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => (
      (clampTier(left.node.tier) - clampTier(right.node.tier))
      || (left.index - right.index)
    ));
  for (const { node } of seeded) {
    byLayer[layers.get(node.jobId) ?? 0]!.push(node.jobId);
  }
  orderWithinLayers(byLayer, neighboursUp, neighboursDown);

  const columnHeights = byLayer.map((column) => column.reduce(
    (total, id, index) => total + checksNodeHeight(byId.get(id)!) + (index > 0 ? CHECKS_ROW_GAP : 0),
    0,
  ));
  const tallest = Math.max(0, ...columnHeights);

  const laidOut: ChecksGraphLayoutNode[] = [];
  const criticalNodes = new Set(criticalPath);
  byLayer.forEach((column, layer) => {
    let y = (tallest - (columnHeights[layer] ?? 0)) / 2;
    column.forEach((id, indexInLayer) => {
      const node = byId.get(id)!;
      const height = checksNodeHeight(node);
      laidOut.push({
        node,
        x: layer * (CHECKS_NODE_WIDTH + CHECKS_COLUMN_GAP),
        y,
        width: CHECKS_NODE_WIDTH,
        height,
        layer,
        indexInLayer,
        onCriticalPath: criticalNodes.has(id),
      });
      y += height + CHECKS_ROW_GAP;
    });
  });

  const criticalEdges = criticalPathEdgeKeys(criticalPath);
  const seen = new Set<string>();
  const layoutEdges: ChecksGraphLayoutEdge[] = [];
  for (const edge of usableEdges) {
    const key = `${edge.from}${EDGE_KEY_SEPARATOR}${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    layoutEdges.push({
      id: `${edge.from}→${edge.to}`,
      from: edge.from,
      to: edge.to,
      onCriticalPath: criticalEdges.has(key),
      ...edgeFlags(byId.get(edge.to)?.state),
    });
  }

  return {
    nodes: laidOut,
    edges: layoutEdges,
    width: layerCount * CHECKS_NODE_WIDTH + Math.max(0, layerCount - 1) * CHECKS_COLUMN_GAP,
    height: tallest,
    layerCount,
  };
}

/**
 * Viewport height for the canvas. Big enough that the pipeline is legible
 * without pan on a normal PR, bounded so a 40-job monorepo run does not push
 * the log drawer off the bottom of the pane.
 *
 * The ceiling is the single biggest lever on how large the labels render: a run
 * with more jobs than fit is height-constrained, so `fitView` zoom is very
 * nearly `maxHeight / graphHeight`. 520 is what makes a ~22-job run readable at
 * first paint while still leaving the drawer and the rest of the tab on screen.
 */
export const CHECKS_CANVAS_MIN_HEIGHT = 220;
export const CHECKS_CANVAS_MAX_HEIGHT = 520;

export function checksCanvasHeight(layoutHeight: number): number {
  return Math.round(Math.min(
    CHECKS_CANVAS_MAX_HEIGHT,
    Math.max(CHECKS_CANVAS_MIN_HEIGHT, layoutHeight + 48),
  ));
}

/**
 * The skeleton's shape, derived from the checks we already have locally.
 *
 * The point of the skeleton is that it occupies roughly the space the real
 * graph will, so the graph's arrival is a fill rather than a relayout. It is a
 * shape estimate, never a claim about the pipeline: three columns is what a
 * typical `setup → fan-out → gate` workflow renders as.
 */
export function checksSkeletonShape(jobCount: number): number[] {
  const count = Math.max(1, Math.min(12, jobCount));
  if (count <= 2) return [count];
  if (count <= 4) return [1, count - 1];
  const middle = count - 2;
  return [1, Math.min(5, middle), 1];
}
