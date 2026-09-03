/**
 * Lanes, proposals, PRs and plugin nodes → the React Flow model.
 *
 * Lifted out of `WorkspaceGraphPage`'s two big memos (`baseGraph` and
 * `graphWithPlugins`) into a pure function, unchanged in what it decides. It is
 * pure for the same reason `pluginGraphNodes.ts` is: everything about which node
 * exists, which edge survives and what a filter hides is testable without
 * mounting a canvas, and `WorkspaceGraph.tsx` is left doing the drawing.
 *
 * The ORDER is the guarantee that survived the move: every lane node exists,
 * positioned, before a single plugin node is considered, so no cap and no
 * failure in the overlay can cost the canvas one of the product's own nodes.
 */

import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";

import type {
  AutoRebaseLaneStatus,
  ConflictStatus,
  GitUpstreamSyncStatus,
  GraphFilterState,
  GraphLayoutSnapshot,
  GraphViewMode,
  IntegrationProposal,
  LaneSummary,
} from "./types";
import type { GraphEdgeData, GraphNodeData, GraphPrOverlay } from "./graphTypes";
import {
  collectDescendants,
  edgePairKey,
  laneSummaryConflictsWith,
  proposalLaneSummaries,
  proposalPairwiseResults,
  proposalSourceLaneIds,
  proposalSteps,
} from "./graphHelpers";
import { computeAutoLayout, laneHierarchyFromPrimary } from "./graphLayout";
import type { IntegrationLaneSource } from "./integrationLanes";
import { isIntegrationLaneFromMetadata } from "./integrationLanes";
import {
  PLUGIN_GRAPH_NODE_TYPE,
  type PluginGraphNodeEntry,
  type PluginGraphOverlay,
} from "./pluginGraphNodes";

/**
 * Where a plugin node sits relative to the lane it annotates.
 *
 * To the RIGHT and slightly below, because the auto layout stacks lanes
 * vertically and fans children downward — a node placed under its lane would
 * land on the lane's own children. The vertical step separates two plugins
 * annotating the same lane.
 */
const PLUGIN_NODE_OFFSET_X = 300;
const PLUGIN_NODE_OFFSET_Y = 24;
const PLUGIN_NODE_STACK_Y = 88;

/** Free-floating plugin nodes get their own column, left of every lane. */
const PLUGIN_FLOATING_ORIGIN_X = -320;
const PLUGIN_FLOATING_STEP_Y = 88;

export type GraphModel = {
  nodes: Array<Node<GraphNodeData>>;
  edges: Array<Edge<GraphEdgeData>>;
  visibleNodeIds: Set<string>;
};

export const EMPTY_GRAPH_MODEL: GraphModel = { nodes: [], edges: [], visibleNodeIds: new Set() };

export type BuildGraphModelInput = {
  lanes: LaneSummary[];
  viewMode: GraphViewMode;
  snapshot: GraphLayoutSnapshot;
  filters: GraphFilterState;
  laneMatchesFilters: (lane: LaneSummary) => boolean;
  statusByLane: Map<string, ConflictStatus["status"]>;
  riskByPair: Map<string, { riskLevel: "none" | "low" | "medium" | "high"; overlapCount: number; stale: boolean }>;
  syncByLaneId: Record<string, GitUpstreamSyncStatus | null>;
  autoRebaseByLaneId: Record<string, AutoRebaseLaneStatus | null>;
  activeSessionsByLaneId: Record<string, number>;
  activityScoreByLaneId: Record<string, number>;
  activityBucketByLaneId: Record<string, GraphNodeData["activityBucket"]>;
  lastActivityByLaneId: Record<string, string>;
  environmentByLaneId: Record<string, { env: string; color: string | null }>;
  integrationSourcesByLaneId: Map<string, IntegrationLaneSource[]>;
  integrationProposals: IntegrationProposal[];
  prOverlayByPair: Map<string, GraphPrOverlay>;
  prOverlayByLaneId: Map<string, GraphPrOverlay>;
  showOverviewRiskEdges: boolean;
  appearanceDraft: { laneId: string; color: string | null; icon: LaneSummary["icon"]; tags: string[] } | null;
  pluginOverlay: PluginGraphOverlay;
  onPressPluginNode: (entry: PluginGraphNodeEntry) => void;
};

/** The synthetic lane a non-lane node carries, so every handler stays one type. */
function syntheticLane(overrides: Partial<LaneSummary> & Pick<LaneSummary, "id" | "name">): LaneSummary {
  return {
    description: null,
    laneType: "attached",
    baseRef: "",
    branchRef: "",
    worktreePath: "",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: true,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "",
    archivedAt: null,
    ...overrides,
  };
}

export function buildGraphModel(input: BuildGraphModelInput): GraphModel {
  const {
    lanes,
    viewMode,
    snapshot,
    laneMatchesFilters,
    statusByLane,
    riskByPair,
    syncByLaneId,
    autoRebaseByLaneId,
    activeSessionsByLaneId,
    activityScoreByLaneId,
    activityBucketByLaneId,
    lastActivityByLaneId,
    environmentByLaneId,
    integrationSourcesByLaneId,
    integrationProposals,
    prOverlayByPair,
    prOverlayByLaneId,
    showOverviewRiskEdges,
    appearanceDraft,
    pluginOverlay,
    onPressPluginNode,
  } = input;

  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const primaryHierarchyMeta = laneHierarchyFromPrimary(lanes);
  const collapsedLaneIds = new Set(snapshot.collapsedLaneIds);
  const hiddenByCollapse = new Set<string>();
  for (const laneId of collapsedLaneIds) {
    for (const id of collectDescendants(lanes, laneId)) hiddenByCollapse.add(id);
  }

  const autoPositions = computeAutoLayout(
    lanes,
    viewMode,
    activityScoreByLaneId,
    environmentByLaneId,
    primaryHierarchyMeta.depthByLaneId,
  );
  const savedPositions = snapshot.nodePositions;
  const positions = Object.keys(savedPositions).length > 0
    ? { ...autoPositions, ...savedPositions }
    : autoPositions;

  const nextNodes: Array<Node<GraphNodeData>> = [];
  const visibleNodeIds = new Set<string>();
  const virtualProposalNodes: Array<{ nodeId: string; proposal: IntegrationProposal; sourceLaneIds: string[] }> = [];
  const laneVisibleById = new Map<string, boolean>();

  for (const lane of lanes) {
    if (hiddenByCollapse.has(lane.id)) continue;
    const pos = positions[lane.id] ?? { x: 0, y: 0 };
    const descendants = collectDescendants(lanes, lane.id);
    const collapsedChildCount = collapsedLaneIds.has(lane.id) ? descendants.size : 0;
    const integrationSources = integrationSourcesByLaneId.get(lane.id) ?? [];
    const isVisible = laneMatchesFilters(lane);
    laneVisibleById.set(lane.id, isVisible);
    if (isVisible) visibleNodeIds.add(lane.id);

    nextNodes.push({
      id: lane.id,
      type: "lane",
      position: pos,
      data: {
        lane: appearanceDraft?.laneId === lane.id
          ? { ...lane, color: appearanceDraft.color, icon: appearanceDraft.icon, tags: appearanceDraft.tags }
          : lane,
        status: statusByLane.get(lane.id) ?? "unknown",
        remoteSync: syncByLaneId[lane.id] ?? null,
        autoRebaseStatus: autoRebaseByLaneId[lane.id] ?? null,
        activeSessions: activeSessionsByLaneId[lane.id] ?? 0,
        collapsedChildCount,
        hierarchyDepth: primaryHierarchyMeta.depthByLaneId.get(lane.id) ?? 0,
        parentLaneName: primaryHierarchyMeta.parentNameByLaneId.get(lane.id) ?? null,
        dimmed: false,
        activityBucket: activityBucketByLaneId[lane.id] ?? "medium",
        viewMode,
        lastActivityAt: lastActivityByLaneId[lane.id] ?? null,
        environment: environmentByLaneId[lane.id] ?? null,
        highlight: false,
        rebaseFailed: false,
        rebasePulse: false,
        mergeInProgress: false,
        mergeDisappearing: false,
        isIntegration: isIntegrationLaneFromMetadata(lane, integrationSourcesByLaneId),
        focusGlow: false,
        isVirtualProposal: false,
        integrationSources,
        pr: prOverlayByLaneId.get(lane.id) ?? null,
      },
      selected: false,
      draggable: true,
    });
  }

  for (const [proposalIndex, proposal] of integrationProposals.entries()) {
    const hasRealIntegrationLane = Boolean(proposal.integrationLaneId && laneById.has(proposal.integrationLaneId));
    if (proposal.status !== "proposed" || hasRealIntegrationLane) continue;
    const sourceLaneIds = proposalSourceLaneIds(proposal).filter((laneId) => laneById.has(laneId));
    if (sourceLaneIds.length === 0) continue;
    const normalizedProposalId = typeof proposal.proposalId === "string" && proposal.proposalId.trim().length > 0
      ? proposal.proposalId.trim()
      : null;
    const fallbackProposalKey = `legacy-${proposalIndex + 1}-${proposal.createdAt ?? "unknown"}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    );
    const proposalKey = normalizedProposalId ?? fallbackProposalKey;
    const shortProposalId = (normalizedProposalId ?? fallbackProposalKey).slice(0, 12);
    const sourcePositions = sourceLaneIds
      .map((laneId) => positions[laneId])
      .filter((pos): pos is { x: number; y: number } => Boolean(pos));
    const anchor = sourcePositions.length > 0
      ? {
        x: sourcePositions.reduce((sum, pos) => sum + pos.x, 0) / sourcePositions.length,
        y: sourcePositions.reduce((sum, pos) => sum + pos.y, 0) / sourcePositions.length,
      }
      : { x: 0, y: 0 };

    const nodeId = `proposal:${proposalKey}`;
    const pos = positions[nodeId] ?? { x: anchor.x, y: anchor.y + 180 };
    const proposalTitle = proposal.title?.trim() || `Integration proposal ${shortProposalId}`;
    if (sourceLaneIds.some((laneId) => laneVisibleById.get(laneId))) visibleNodeIds.add(nodeId);

    nextNodes.push({
      id: nodeId,
      type: "proposal",
      position: pos,
      data: {
        lane: syntheticLane({
          id: nodeId,
          name: proposalTitle,
          description: `Virtual proposal ${shortProposalId}`,
          baseRef: proposal.baseBranch,
          branchRef: proposal.integrationLaneName?.trim() || `proposal/${proposalKey}`,
          tags: ["proposal"],
          createdAt: proposal.createdAt,
        }),
        status: "unknown",
        remoteSync: null,
        autoRebaseStatus: null,
        activeSessions: 0,
        collapsedChildCount: 0,
        hierarchyDepth: 0,
        parentLaneName: null,
        dimmed: false,
        activityBucket: "medium",
        viewMode,
        lastActivityAt: proposal.createdAt ?? null,
        environment: null,
        highlight: false,
        rebaseFailed: false,
        rebasePulse: false,
        mergeInProgress: false,
        mergeDisappearing: false,
        isIntegration: true,
        focusGlow: false,
        isVirtualProposal: true,
        integrationSources: sourceLaneIds.map((laneId) => ({
          laneId,
          laneName: laneById.get(laneId)?.name ?? laneId,
        })),
        pr: null,
        proposalOutcome: proposal.overallOutcome,
        ...(normalizedProposalId ? { proposalId: normalizedProposalId } : {}),
      },
      selected: false,
      draggable: false,
    });
    virtualProposalNodes.push({ nodeId, proposal, sourceLaneIds });
  }

  const nextEdges: Array<Edge<GraphEdgeData>> = [];
  const primaryLane = primaryHierarchyMeta.primary;
  const riskPairsWithVisibleEdge = new Set<string>();
  const laneHasProposalConflict = (proposal: IntegrationProposal, sourceLaneId: string): boolean => {
    const steps = proposalSteps(proposal);
    const laneSummaries = proposalLaneSummaries(proposal);
    const pairwiseResults = proposalPairwiseResults(proposal);
    const step = steps.find((entry) => entry?.laneId === sourceLaneId);
    if (step && (step.outcome === "conflict" || step.outcome === "blocked")) return true;
    const laneSummary = laneSummaries.find((entry) => entry?.laneId === sourceLaneId);
    if (laneSummary) {
      if (laneSummary.outcome === "conflict" || laneSummary.outcome === "blocked") return true;
      if (laneSummaryConflictsWith(laneSummary).length > 0) return true;
    }
    return pairwiseResults.some(
      (pairwise) =>
        (pairwise?.laneAId === sourceLaneId || pairwise?.laneBId === sourceLaneId)
        && pairwise.outcome === "conflict",
    );
  };

  const riskEdgesVisible = viewMode === "risk" || (viewMode === "all" && showOverviewRiskEdges);

  if (riskEdgesVisible) {
    for (const [key, risk] of riskByPair.entries()) {
      if (risk.riskLevel === "none" && risk.overlapCount === 0) continue;
      const [laneAId, laneBId] = key.split("::");
      if (!laneAId || !laneBId) continue;
      if (hiddenByCollapse.has(laneAId) || hiddenByCollapse.has(laneBId)) continue;
      if (!visibleNodeIds.has(laneAId) || !visibleNodeIds.has(laneBId)) continue;
      riskPairsWithVisibleEdge.add(key);
    }
  }

  if (viewMode === "all" || viewMode === "stack") {
    for (const lane of lanes) {
      if (!primaryLane || lane.id === primaryLane.id) continue;
      // In Overview, stack edges already show the tree; skip redundant spokes.
      if (viewMode === "all" && lane.parentLaneId && visibleNodeIds.has(lane.parentLaneId)) continue;
      if (!visibleNodeIds.has(primaryLane.id) || !visibleNodeIds.has(lane.id)) continue;
      const pair = edgePairKey(primaryLane.id, lane.id);
      const pr = prOverlayByPair.get(pair);
      nextEdges.push({
        id: `topology:${primaryLane.id}:${lane.id}`,
        source: primaryLane.id,
        target: lane.id,
        sourceHandle: "source",
        targetHandle: "target",
        type: "custom",
        data: { edgeType: "topology", ...(pr && !riskPairsWithVisibleEdge.has(pair) ? { pr } : {}) },
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: false,
        selected: false,
      });
    }
    for (const lane of lanes) {
      if (!lane.parentLaneId || !laneById.has(lane.parentLaneId)) continue;
      if (!visibleNodeIds.has(lane.parentLaneId) || !visibleNodeIds.has(lane.id)) continue;
      const pair = edgePairKey(lane.parentLaneId, lane.id);
      const pr = prOverlayByPair.get(pair);
      nextEdges.push({
        id: `stack:${lane.parentLaneId}:${lane.id}`,
        source: lane.parentLaneId,
        target: lane.id,
        sourceHandle: "source",
        targetHandle: "target",
        type: "custom",
        data: { edgeType: "stack", ...(pr && !riskPairsWithVisibleEdge.has(pair) ? { pr } : {}) },
        markerEnd: { type: MarkerType.ArrowClosed },
        selected: false,
      });
    }
  }

  if (riskEdgesVisible) {
    for (const [key, risk] of riskByPair.entries()) {
      if (risk.riskLevel === "none" && risk.overlapCount === 0) continue;
      const [laneAId, laneBId] = key.split("::");
      if (!laneAId || !laneBId) continue;
      if (hiddenByCollapse.has(laneAId) || hiddenByCollapse.has(laneBId)) continue;
      if (!visibleNodeIds.has(laneAId) || !visibleNodeIds.has(laneBId)) continue;
      const pr = prOverlayByPair.get(key);
      nextEdges.push({
        id: `risk:${laneAId}:${laneBId}`,
        source: laneAId,
        target: laneBId,
        sourceHandle: "source",
        targetHandle: "target",
        type: "custom",
        data: {
          edgeType: "risk",
          riskLevel: risk.riskLevel,
          overlapCount: risk.overlapCount,
          stale: risk.stale,
          ...(pr ? { pr } : {}),
        },
        selected: false,
      });
    }
  }

  for (const [integrationLaneId, integrationSources] of integrationSourcesByLaneId.entries()) {
    if (hiddenByCollapse.has(integrationLaneId)) continue;
    if (!laneById.has(integrationLaneId)) continue;
    for (const source of integrationSources) {
      const sourceLaneId = source.laneId;
      if (hiddenByCollapse.has(sourceLaneId)) continue;
      if (!laneById.has(sourceLaneId)) continue;
      if (!visibleNodeIds.has(sourceLaneId) || !visibleNodeIds.has(integrationLaneId)) continue;
      nextEdges.push({
        id: `integration:${sourceLaneId}:${integrationLaneId}`,
        source: sourceLaneId,
        target: integrationLaneId,
        sourceHandle: "source",
        targetHandle: "target",
        type: "custom",
        data: { edgeType: "integration" },
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: true,
        selected: false,
      });
    }
  }

  for (const proposalNode of virtualProposalNodes) {
    for (const sourceLaneId of proposalNode.sourceLaneIds) {
      if (hiddenByCollapse.has(sourceLaneId)) continue;
      if (!laneById.has(sourceLaneId)) continue;
      if (!visibleNodeIds.has(sourceLaneId) || !visibleNodeIds.has(proposalNode.nodeId)) continue;
      nextEdges.push({
        id: `proposal:${sourceLaneId}:${proposalNode.nodeId}`,
        source: sourceLaneId,
        target: proposalNode.nodeId,
        sourceHandle: "source",
        targetHandle: "target",
        type: "custom",
        data: {
          edgeType: "proposal",
          proposalConflict: laneHasProposalConflict(proposalNode.proposal, sourceLaneId),
        },
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: true,
        selected: false,
      });
    }
  }

  if (pluginOverlay.entries.length === 0) {
    return { nodes: nextNodes, edges: nextEdges, visibleNodeIds };
  }

  // ── Plugin nodes, appended to a finished canvas ──────────────────────────
  const positionByNodeId = new Map<string, { x: number; y: number }>();
  for (const node of nextNodes) positionByNodeId.set(node.id, node.position);
  const perAnchor = new Map<string, number>();
  let floatingIndex = 0;

  for (const entry of pluginOverlay.entries) {
    const anchorPosition = entry.anchorNodeId ? positionByNodeId.get(entry.anchorNodeId) : null;
    const stackIndex = entry.anchorNodeId ? (perAnchor.get(entry.anchorNodeId) ?? 0) : floatingIndex;
    if (entry.anchorNodeId) perAnchor.set(entry.anchorNodeId, stackIndex + 1);
    else floatingIndex += 1;
    const derived = anchorPosition
      ? {
        x: anchorPosition.x + PLUGIN_NODE_OFFSET_X,
        y: anchorPosition.y + PLUGIN_NODE_OFFSET_Y + stackIndex * PLUGIN_NODE_STACK_Y,
      }
      : { x: PLUGIN_FLOATING_ORIGIN_X, y: stackIndex * PLUGIN_FLOATING_STEP_Y };
    // A saved position still wins, exactly as it does for a lane: the snapshot
    // is keyed by node id and a user who tidied the canvas before installing a
    // second plugin should not have their arrangement recomputed.
    const position = savedPositions[entry.nodeId] ?? derived;

    // Visible when its anchor is. A free-floating node has no anchor to inherit
    // from and is always visible: it is not about any one lane, so a lane filter
    // has no opinion about it.
    const visible = entry.anchorNodeId ? visibleNodeIds.has(entry.anchorNodeId) : true;
    if (visible) visibleNodeIds.add(entry.nodeId);

    nextNodes.push({
      id: entry.nodeId,
      type: PLUGIN_GRAPH_NODE_TYPE,
      position,
      data: {
        lane: syntheticLane({
          id: entry.nodeId,
          name: entry.payload.label,
          description: entry.identity.displayName,
          color: entry.identity.accent,
        }),
        status: "unknown",
        remoteSync: null,
        autoRebaseStatus: null,
        activeSessions: 0,
        collapsedChildCount: 0,
        hierarchyDepth: 0,
        parentLaneName: null,
        dimmed: false,
        activityBucket: "medium",
        viewMode,
        lastActivityAt: null,
        environment: null,
        highlight: false,
        rebaseFailed: false,
        rebasePulse: false,
        mergeInProgress: false,
        mergeDisappearing: false,
        isIntegration: false,
        focusGlow: false,
        isVirtualProposal: false,
        integrationSources: [],
        pr: null,
        pluginNode: entry,
        ...(entry.payload.actionId ? { onPressPluginNode: () => onPressPluginNode(entry) } : {}),
      },
      selected: false,
      // Not draggable, exactly like a virtual proposal. A drag on this canvas
      // means reparent-or-open-a-PR, and every one of those handlers refuses a
      // synthetic node — so a draggable plugin node would be a control that
      // moves and then silently does nothing.
      draggable: false,
    });

    const pluginEdge = (
      id: string,
      source: string,
      kind: (typeof entry.edges)[number]["kind"],
      label?: string,
    ): Edge<GraphEdgeData> => ({
      id,
      source,
      target: entry.nodeId,
      sourceHandle: "source",
      targetHandle: "target",
      type: "custom",
      data: {
        edgeType: "plugin",
        pluginEdgeKind: kind,
        pluginAccent: entry.identity.accent,
        ...(label ? { pluginEdgeLabel: label } : {}),
      },
      animated: false,
      selected: false,
    });

    // The anchor's own edge. Drawn only when both ends are visible, the same
    // rule every core edge above follows.
    if (entry.anchorNodeId && visible) {
      nextEdges.push(pluginEdge(`plugin:${entry.nodeId}:anchor`, entry.anchorNodeId, "link"));
    }
    for (const edge of entry.edges) {
      if (!visibleNodeIds.has(edge.toNodeId) || !visible) continue;
      nextEdges.push(
        pluginEdge(
          `plugin:${entry.nodeId}:${edge.toNodeId}`,
          edge.toNodeId,
          edge.kind,
          edge.label ?? (edge.kind === "link" ? undefined : edge.kind),
        ),
      );
    }
  }

  return { nodes: nextNodes, edges: nextEdges, visibleNodeIds };
}
