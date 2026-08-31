/**
 * Turning published `graph-node` contributions into shapes the canvas can draw.
 *
 * Pure, and deliberately so. Everything that decides WHICH plugin nodes appear,
 * where they hang, which edges resolve and which get dropped past the cap is
 * decided here, with no React and no React Flow, so the rules are testable
 * without mounting a 4,600-line page. `WorkspaceGraphPage` does the drawing and
 * nothing else.
 *
 * Two invariants this module exists to keep:
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

import {
  PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT,
  PLUGIN_GRAPH_NODES_TOTAL_LIMIT,
  comparePluginContributions,
  type PluginEntityContribution,
  type PluginGraphEdgeKind,
  type PluginGraphNodePayload,
} from "../../../shared/plugins/sockets";
import {
  contributionKey,
  type PluginSocketIdentity,
  type SurfaceContributionSet,
} from "../plugins/sockets/contributionModel";

/** The `type` React Flow selects the plugin node renderer with. */
export const PLUGIN_GRAPH_NODE_TYPE = "plugin";

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
  /** {@link contributionKey} — stable identity for React and for tests. */
  key: string;
  /** React Flow node id. Namespaced so it can never collide with a lane id. */
  nodeId: string;
  pluginId: string;
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

export type PluginGraphOverlayInput = {
  set: SurfaceContributionSet;
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
 * Reads `dynamicByEntity` directly rather than going through
 * `selectContributions`, because this is the one consumer that wants EVERY
 * entity's rows at once instead of one row's. The two rules that hook would have
 * applied are applied here instead and are the reason it can be skipped safely:
 * static contributions of this kind draw nothing at all (`DECLARATION_ONLY_SOCKETS`),
 * and the per-plugin ceiling below is stricter than the per-slot one.
 */
export function buildPluginGraphOverlay(input: PluginGraphOverlayInput): PluginGraphOverlay {
  const {
    set,
    laneNodeIds,
    laneNodeIdByPrId,
    perPluginLimit = PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT,
    totalLimit = PLUGIN_GRAPH_NODES_TOTAL_LIMIT,
  } = input;
  if (set.identities.size === 0) return EMPTY_PLUGIN_GRAPH_OVERLAY;

  const resolveTarget = (kind: "lane" | "pr", id: string): string | null => {
    if (kind === "lane") return laneNodeIds.has(id) ? id : null;
    return laneNodeIdByPrId.get(id) ?? null;
  };

  const rows: PluginEntityContribution[] = [];
  for (const forEntity of set.dynamicByEntity.values()) {
    for (const entry of forEntity) {
      if (entry.socket === "graph-node") rows.push(entry);
    }
  }
  // The host's own placement rule, not insertion order. `dynamicByEntity` is a
  // Map built in row order, so without this two machines holding the same rows
  // could draw them in different orders and the caps would then keep different
  // nodes on each.
  rows.sort(comparePluginContributions);

  const entries: PluginGraphNodeEntry[] = [];
  const perPlugin = new Map<string, number>();
  const droppedPluginIds: string[] = [];
  let droppedCount = 0;

  const refuse = (pluginId: string): void => {
    droppedCount += 1;
    if (!droppedPluginIds.includes(pluginId)) droppedPluginIds.push(pluginId);
  };

  for (const row of rows) {
    const identity = set.identities.get(row.pluginId);
    // An enabled plugin always has an identity in the set; a row without one
    // belongs to a plugin that is gone, and its node would be a ghost.
    if (!identity) continue;

    let anchorNodeId: string | null;
    if (row.entityKind === "surface") {
      anchorNodeId = null;
    } else if (row.entityKind === "lane") {
      if (!laneNodeIds.has(row.entityId)) continue;
      anchorNodeId = row.entityId;
    } else {
      // Only two anchors ever arrive, because the `lanes` surface reads only
      // `lane` and `surface` rows (`surfaceContributionEntityKinds`). Everything
      // else — a session, a file, an automation, and a PR — has no shape on this
      // canvas to hang from. Skipped silently rather than counted as a refusal:
      // nothing was withheld for want of room, so telling the author their node
      // hit a cap would be a lie.
      //
      // A PR is still reachable, as an edge TARGET rather than as an anchor: the
      // canvas draws a PR as an overlay on its lane card, and
      // `laneNodeIdByPrId` resolves it to that card.
      continue;
    }

    // Counted only once the anchor resolved, so a plugin whose lane is merely
    // collapsed does not spend its allowance on a node nobody could have seen.
    const used = perPlugin.get(row.pluginId) ?? 0;
    if (used >= perPluginLimit || entries.length >= totalLimit) {
      refuse(row.pluginId);
      continue;
    }
    perPlugin.set(row.pluginId, used + 1);

    const payload = row.payload as PluginGraphNodePayload;
    const nodeId = pluginGraphNodeId(row.pluginId, row.entityKind, row.entityId);
    const edges: PluginGraphNodeEntry["edges"] = [];
    for (const edge of payload.edges ?? []) {
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
      key: contributionKey(row),
      nodeId,
      pluginId: row.pluginId,
      identity,
      payload,
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
