/**
 * Turning published `graph-node` contributions into shapes the canvas can draw.
 *
 * Ported from `components/graph/pluginGraphNodes.ts`. The SHAPING is unchanged —
 * which anchors resolve, which edges survive, what a cap drops, and the
 * sentence that says so — and only the SOURCE moved.
 *
 * The compiled builder read the renderer's own contribution model
 * (`components/plugins/sockets/contributionModel`), a live registry of every
 * installed plugin's published rows. A guest holds no registry and must not:
 * a page that could enumerate every plugin's contributions would be a page that
 * could read a neighbour's manifest. So the rows arrive already resolved and
 * permission-checked, one flat list, from `bridge.sockets.list("graph-node")` —
 * see `host/sockets.ts` — and this module narrows them.
 *
 * Two invariants it exists to keep, both unchanged from the compiled copy:
 *
 * 1. **A plugin never displaces a lane.** The caller has already built every
 *    core node before this runs, and the only thing either cap can drop is a
 *    plugin's. A canvas with fifty plugin nodes asking for room still draws
 *    every lane it drew before the plugin was installed.
 * 2. **A plugin's edge always has the plugin's own node at one end.** The anchor
 *    supplies one endpoint and the payload names the other, so no arrangement of
 *    contributions can produce a line between two lanes. An edge between lanes
 *    reads as a git relationship, and a plugin asserting one would be
 *    indistinguishable from ADE's own topology.
 */

import type { PluginWebviewSocketEntry } from "../bridge";
import { PLUGIN_GRAPH_EDGE_KINDS, type PluginGraphEdgeKind } from "./graphTypes";

/** The `type` React Flow selects the plugin node renderer with. */
export const PLUGIN_GRAPH_NODE_TYPE = "plugin";

export const PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT = 24;
export const PLUGIN_GRAPH_NODES_TOTAL_LIMIT = 48;

/**
 * Edges one node may carry beyond its anchor. Four, because the node is a
 * glance — the ceiling `shared/plugins/sockets.ts` already enforces at parse.
 */
export const PLUGIN_GRAPH_NODE_EDGE_LIMIT = 4;

export type PluginBadgeTone = "neutral" | "accent" | "success" | "warning" | "destructive";

const TONES: readonly PluginBadgeTone[] = ["neutral", "accent", "success", "warning", "destructive"];

/** Who published a node, as the card's attribution line reads it. */
export type PluginSocketIdentity = {
  pluginId: string;
  displayName: string;
  accent: string | null;
  icon: string | null;
};

export type PluginGraphNodePayload = {
  label: string;
  detail?: string;
  tone: PluginBadgeTone;
  icon?: string;
  actionId?: string;
  edges?: Array<{ to: { kind: "lane" | "pr"; id: string }; kind: PluginGraphEdgeKind; label?: string }>;
};

/**
 * A resolved plugin node, ready to become a React Flow node.
 *
 * `anchorNodeId` is null only for a node published against the SURFACE rather
 * than an entity — the plugin's one free-floating shape. Every other entry hangs
 * off a lane card that is on the canvas right now, because an entry whose anchor
 * is collapsed or absent was dropped before it got here: a node hanging from
 * nothing is worse than no node.
 */
export type PluginGraphNodeEntry = {
  /** Stable identity for React and for tests. The host's own socket id. */
  key: string;
  /** React Flow node id. Namespaced so it can never collide with a lane id. */
  nodeId: string;
  pluginId: string;
  /** What `sockets.invoke` is called with when the node is pressed. */
  socketId: string;
  identity: PluginSocketIdentity;
  payload: PluginGraphNodePayload;
  /** The lane node this hangs from, or null for the free-floating one. */
  anchorNodeId: string | null;
  /** Extra edges whose target resolved to a node on the canvas. */
  edges: Array<{ toNodeId: string; kind: PluginGraphEdgeKind; label?: string }>;
};

export type PluginGraphOverlay = {
  entries: PluginGraphNodeEntry[];
  /**
   * Nodes a cap refused, and who asked for them.
   *
   * Carried rather than logged, because the two readers are a person and a
   * diagnostic: the canvas draws a muted line saying how many it withheld, and
   * `ade plugin doctor` says the same thing about the same plugin from the other
   * side. A drop that only reached a console line would be invisible to both.
   */
  droppedCount: number;
  droppedPluginIds: string[];
};

export const EMPTY_PLUGIN_GRAPH_OVERLAY: PluginGraphOverlay = {
  entries: [],
  droppedCount: 0,
  droppedPluginIds: [],
};

/** Namespaced so a plugin can never claim a lane id, whatever it publishes. */
export function pluginGraphNodeId(pluginId: string, entityKind: string, entityId: string): string {
  return `plugin-node:${pluginId}:${entityKind}:${entityId}`;
}

export function isPluginGraphNodeId(nodeId: string): boolean {
  return nodeId.startsWith("plugin-node:");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tone(value: unknown): PluginBadgeTone {
  return TONES.find((candidate) => candidate === value) ?? "neutral";
}

function edgeKind(value: unknown): PluginGraphEdgeKind | null {
  return PLUGIN_GRAPH_EDGE_KINDS.find((candidate) => candidate === value) ?? null;
}

/**
 * One host row, read into the payload and the identity the card draws.
 *
 * Tolerant per field, the way the manifest parser is: a row missing a label is
 * not a node and is dropped, a malformed `edges` degrades to an anchor-only node
 * rather than deleting it, and a tone this build does not know reads `neutral`.
 * The host has already validated what it published; this narrows what arrives
 * over a bridge whose values are `unknown` by type.
 */
function readRow(entry: PluginWebviewSocketEntry): {
  payload: PluginGraphNodePayload;
  identity: PluginSocketIdentity;
  entityKind: string;
  entityId: string;
  order: number;
} | null {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const label = text(data.label) ?? text(entry.label);
  if (!label) return null;
  const pluginId = text(entry.pluginId);
  if (!pluginId) return null;

  const edges: PluginGraphNodePayload["edges"] = [];
  if (Array.isArray(data.edges)) {
    for (const raw of data.edges) {
      if (edges.length >= PLUGIN_GRAPH_NODE_EDGE_LIMIT) break;
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const kind = edgeKind(row.kind);
      const to = row.to && typeof row.to === "object" ? (row.to as Record<string, unknown>) : null;
      const targetKind = to?.kind === "lane" || to?.kind === "pr" ? to.kind : null;
      const targetId = text(to?.id);
      if (!kind || !targetKind || !targetId) continue;
      const edgeLabel = text(row.label);
      edges.push({ to: { kind: targetKind, id: targetId }, kind, ...(edgeLabel ? { label: edgeLabel } : {}) });
    }
  }

  return {
    payload: {
      label,
      ...(text(data.detail) ? { detail: text(data.detail)! } : {}),
      tone: tone(data.tone),
      ...(text(data.icon) ?? text(entry.icon) ? { icon: (text(data.icon) ?? text(entry.icon))! } : {}),
      ...(text(data.actionId) ? { actionId: text(data.actionId)! } : {}),
      ...(edges.length > 0 ? { edges } : {}),
    },
    identity: {
      pluginId,
      displayName: text(data.pluginName) ?? pluginId,
      accent: text(data.accent),
      icon: text(data.pluginIcon),
    },
    // A row published against the surface rather than an entity is the plugin's
    // one free-floating shape. Absent means surface, because that is the only
    // anchor a host can always supply.
    entityKind: text(data.entityKind) ?? "surface",
    entityId: text(data.entityId) ?? "lanes",
    order: typeof data.order === "number" && Number.isFinite(data.order)
      ? data.order
      : Number.MAX_SAFE_INTEGER,
  };
}

export type PluginGraphOverlayInput = {
  /** What `bridge.sockets.list("graph-node")` answered, verbatim. */
  entries: readonly PluginWebviewSocketEntry[];
  /** Lane node ids currently on the canvas. An anchor outside this is dropped. */
  laneNodeIds: ReadonlySet<string>;
  /**
   * PR number (as a string, the id a `pr` entity is keyed by) → the lane node
   * drawing that PR.
   *
   * The canvas has no PR node — a PR is an overlay ON a lane card — so an edge
   * pointing at a PR resolves through here to the lane that shows it. A PR whose
   * lane is off-canvas resolves to nothing and that edge drops.
   */
  laneNodeIdByPrId: ReadonlyMap<string, string>;
  perPluginLimit?: number;
  totalLimit?: number;
};

/**
 * Every plugin node the canvas should draw, in the host's own order.
 *
 * The order is `comparePluginContributions`' rule, kept verbatim: declared
 * order, then plugin id, then the row's own id. Two machines holding the same
 * rows in different arrival order must draw them the same way, or the caps would
 * keep different nodes on each.
 */
export function buildPluginGraphOverlay(input: PluginGraphOverlayInput): PluginGraphOverlay {
  const {
    entries: rawEntries,
    laneNodeIds,
    laneNodeIdByPrId,
    perPluginLimit = PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT,
    totalLimit = PLUGIN_GRAPH_NODES_TOTAL_LIMIT,
  } = input;
  if (rawEntries.length === 0) return EMPTY_PLUGIN_GRAPH_OVERLAY;

  const resolveTarget = (kind: "lane" | "pr", id: string): string | null => {
    if (kind === "lane") return laneNodeIds.has(id) ? id : null;
    return laneNodeIdByPrId.get(id) ?? null;
  };

  const rows = rawEntries
    .map((entry) => {
      const read = readRow(entry);
      return read ? { entry, ...read } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  rows.sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    const byPlugin = left.identity.pluginId.localeCompare(right.identity.pluginId);
    return byPlugin !== 0 ? byPlugin : left.entry.socketId.localeCompare(right.entry.socketId);
  });

  const entries: PluginGraphNodeEntry[] = [];
  const perPlugin = new Map<string, number>();
  const droppedPluginIds: string[] = [];
  let droppedCount = 0;

  const refuse = (pluginId: string): void => {
    droppedCount += 1;
    if (!droppedPluginIds.includes(pluginId)) droppedPluginIds.push(pluginId);
  };

  for (const row of rows) {
    const pluginId = row.identity.pluginId;

    let anchorNodeId: string | null;
    if (row.entityKind === "surface") {
      anchorNodeId = null;
    } else if (row.entityKind === "lane") {
      if (!laneNodeIds.has(row.entityId)) continue;
      anchorNodeId = row.entityId;
    } else {
      // Only two anchors ever arrive, because the `lanes` surface reads only
      // `lane` and `surface` rows. Everything else — a session, a file, an
      // automation, and a PR — has no shape on this canvas to hang from. Skipped
      // silently rather than counted as a refusal: nothing was withheld for want
      // of room, so telling the author their node hit a cap would be a lie.
      //
      // A PR is still reachable, as an edge TARGET rather than as an anchor.
      continue;
    }

    // Counted only once the anchor resolved, so a plugin whose lane is merely
    // collapsed does not spend its allowance on a node nobody could have seen.
    const used = perPlugin.get(pluginId) ?? 0;
    if (used >= perPluginLimit || entries.length >= totalLimit) {
      refuse(pluginId);
      continue;
    }
    perPlugin.set(pluginId, used + 1);

    const nodeId = pluginGraphNodeId(pluginId, row.entityKind, row.entityId);
    const edges: PluginGraphNodeEntry["edges"] = [];
    for (const edge of row.payload.edges ?? []) {
      const toNodeId = resolveTarget(edge.to.kind, edge.to.id);
      // An unresolvable target is dropped and the node still draws. A plugin
      // publishing against a lane the user has since deleted should lose a line,
      // not its whole annotation.
      if (!toNodeId) continue;
      // The anchor already draws this one; a second line over the same pair
      // would just thicken it.
      if (toNodeId === anchorNodeId) continue;
      edges.push({ toNodeId, kind: edge.kind, ...(edge.label ? { label: edge.label } : {}) });
    }

    entries.push({
      key: row.entry.socketId,
      nodeId,
      pluginId,
      socketId: row.entry.socketId,
      identity: row.identity,
      payload: row.payload,
      anchorNodeId,
      edges,
    });
  }

  return { entries, droppedCount, droppedPluginIds };
}

/**
 * The sentence the canvas shows when a cap withheld something.
 *
 * Written here beside the rule it describes, so the number in the copy and the
 * number in the cap cannot drift. Empty string when nothing was dropped — a
 * caller renders nothing rather than an encouraging "0 hidden".
 */
export function describePluginGraphOverflow(overlay: PluginGraphOverlay): string {
  if (overlay.droppedCount === 0) return "";
  const nodes = overlay.droppedCount === 1 ? "1 plugin node" : `${overlay.droppedCount} plugin nodes`;
  const who = overlay.droppedPluginIds.join(", ");
  return `${nodes} hidden to keep the graph readable (${who})`;
}
