/**
 * ADE's Graph tab, inside a guest.
 *
 * Ported from `components/graph/WorkspaceGraphPage.tsx` (4,906 lines). The
 * canvas, the four view modes, the filters, the drag-to-reparent flow, the
 * context menu, the appearance editor, the conflict panel, the pair matrix and
 * the batch dock are the compiled page's, moved. What changed is the SEAM:
 *
 * - `useAppStore(s => s.lanes)` → `useGraphData` over the plugin's page actions,
 *   with `host.subscribe` supplying the "something moved" signal the store used
 *   to supply by re-rendering.
 * - every `window.ade.*` → one function in `host/actions.ts`.
 * - `navigate("/lanes?…")` → `openLink(laneDeeplink(id))`; the host decides what
 *   a lane link means on this client.
 * - `showToast` → `host/ui.ts` `toast`, ADE's own stack, above the guest.
 * - `useConfirmDialog` → `host/ui.ts` `confirm`, likewise.
 * - the two node/edge memos → `lib/buildGraphModel.ts`, pure and testable.
 *
 * PARITY.md records every behaviour that narrowed, and there are three: the PR
 * modal is a compact card rather than `PrDetailPane`, a rebase's progress comes
 * from the operation ledger rather than the pty stream a guest cannot have, and
 * the lane card no longer lists its running agents.
 */

import "@xyflow/react/dist/style.css";

import React from "react";
import type { Edge, Node } from "@xyflow/react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from "@xyflow/react";
import {
  ArrowSquareOut,
  CaretDown,
  ChatText,
  ClockCounterClockwise,
  Funnel,
  Minus,
  Plus,
  Warning,
} from "@phosphor-icons/react";
import { Button, Chip, EmptyState, cn } from "@ade-dev/ui";

import type { PluginWebviewContext } from "../bridge";
import * as actions from "../host/actions";
import type { PagePrDetail } from "../host/actions";
import { invokeSocketEntry } from "../host/sockets";
import { confirm as hostConfirm, openLink, openPath, pickLane, toast, writeClipboard } from "../host/ui";
import type {
  GitSyncMode,
  GraphFilterState,
  GraphLayoutSnapshot,
  GraphViewMode,
  LaneIcon,
  LaneSummary,
  MergeMethod,
  MergeSimulationResult,
  PrWithConflicts,
} from "../lib/types";
import type {
  BatchStep,
  ConflictPanelState,
  GraphEdgeData,
  GraphNodeData,
  GraphPrOverlay,
  GraphTextPromptState,
  RebasePublishOutcome,
} from "../lib/graphTypes";
import { isSyntheticGraphNode } from "../lib/graphTypes";
import {
  COLOR_PALETTE,
  ICON_OPTIONS,
  batchOperationLabel,
  branchNameFromRef,
  collectDescendants,
  edgePairKey,
  globToRegExp,
  laneStatusGroup,
  nodeDimensions,
  prChecksLabel,
  sameIdSet,
  toRelativeTime,
} from "../lib/graphHelpers";
import {
  buildDefaultFilter,
  coalesceGraphFilters,
  createGraphPreferences,
  createSessionState,
  createSnapshot,
  laneHierarchyFromPrimary,
  normalizeGraphPreferences,
} from "../lib/graphLayout";
import { buildGraphPrOverlay } from "../lib/graphPrData";
import { buildIntegrationSourcesByLaneId } from "../lib/integrationLanes";
import { laneMatchesFilter } from "../lib/laneFilter";
import { NO_CI_REASON } from "../lib/prVisuals";
import {
  EMPTY_PLUGIN_GRAPH_OVERLAY,
  PLUGIN_GRAPH_NODE_TYPE,
  buildPluginGraphOverlay,
  describePluginGraphOverflow,
  type PluginGraphNodeEntry,
} from "../lib/pluginGraphNodes";
import { EMPTY_GRAPH_MODEL, buildGraphModel } from "../lib/buildGraphModel";
import { useGraphData } from "../lib/useGraphData";
import { laneDeeplink } from "../lib/deeplinks";
import { GraphLaneNode } from "./graphNodes/LaneNode";
import { GraphPluginNode } from "./graphNodes/PluginNode";
import { GraphProposalNode } from "./graphNodes/ProposalNode";
import { RiskEdge } from "./graphEdges/RiskEdge";
import { ConflictPanel } from "./graphDialogs/ConflictPanel";
import { RiskMatrix } from "./shared/RiskMatrix";
import { GraphToolbar } from "./GraphToolbar";
import { PrCard } from "./PrCard";
import { LanePhoneList, buildPhoneRows } from "./LanePhoneList";

const nodeTypes = {
  lane: GraphLaneNode,
  proposal: GraphProposalNode,
  [PLUGIN_GRAPH_NODE_TYPE]: GraphPluginNode,
};
const edgeTypes = { custom: RiskEdge };

const MERGE_SUCCESS_ANIMATION_MS = 1200;

/** The widest viewport that gets the list instead of the canvas. */
const PHONE_MAX_WIDTH = 560;

/**
 * Whether this placement, at this width, is a phone sheet.
 *
 * Two conditions and both are required. The PLACEMENT says the host drew this
 * page in a sheet or a rail pane rather than as a full tab; the WIDTH says the
 * device is a phone rather than a narrow desktop pane a reader can widen. Either
 * alone is wrong: a desktop Work-rail pane is `pane` and should still get the
 * canvas, and a narrow desktop window is narrow but is not a sheet.
 */
export function isPhoneSheet(placement: string | undefined, width: number): boolean {
  return (placement === "pane" || placement === "drawer") && width <= PHONE_MAX_WIDTH;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error.trim() ? error : fallback;
}

function GraphInner({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const reactFlow = useReactFlow<Node<GraphNodeData>, Edge<GraphEdgeData>>();
  const data = useGraphData(true);
  const {
    lanes,
    environments,
    prs,
    proposals,
    syncByLaneId,
    autoRebaseByLaneId,
    batch,
    operations,
    socketEntries,
    storedState,
    loadingTopology,
    loadingRisk,
    error: dataError,
  } = data;

  /* ── Persisted view preference ─────────────────────────────────────────── */

  const [viewMode, setViewMode] = React.useState<GraphViewMode>("all");
  const [loadedPreferences, setLoadedPreferences] = React.useState(false);
  const skipNextPersistRef = React.useRef(false);

  React.useEffect(() => {
    if (storedState === undefined) return;
    const normalized = normalizeGraphPreferences(storedState);
    skipNextPersistRef.current = true;
    setViewMode(normalized.preferences.lastViewMode);
    setLoadedPreferences(true);
    if (normalized.migrated) void actions.saveGraphState(normalized.preferences).catch(() => {});
  }, [storedState]);

  React.useEffect(() => {
    if (!loadedPreferences) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    void actions.saveGraphState(createGraphPreferences(viewMode)).catch(() => {});
  }, [loadedPreferences, viewMode]);

  /* ── Local canvas state ────────────────────────────────────────────────── */

  const [sessionState, setSessionState] = React.useState(createSessionState);
  const [nodes, setNodes] = React.useState<Array<Node<GraphNodeData>>>([]);
  const [edges, setEdges] = React.useState<Array<Edge<GraphEdgeData>>>([]);
  const [errorBanner, setErrorBanner] = React.useState<string | null>(null);
  const [selectedLaneIds, setSelectedLaneIds] = React.useState<string[]>([]);
  const [contextMenu, setContextMenu] = React.useState<{ laneId: string; x: number; y: number } | null>(null);
  const [showFiltersPanel, setShowFiltersPanel] = React.useState(false);
  const [showRiskMatrix, setShowRiskMatrix] = React.useState(false);
  const [showOverviewRiskEdges, setShowOverviewRiskEdges] = React.useState(false);
  const [singleActionsOpen, setSingleActionsOpen] = React.useState(false);
  const [batchActionsOpen, setBatchActionsOpen] = React.useState(false);
  const [focusLaneId, setFocusLaneId] = React.useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = React.useState<string | null>(null);
  const [nodeTooltip, setNodeTooltip] = React.useState<{ x: number; y: number; laneId: string } | null>(null);
  const [edgeHover, setEdgeHover] = React.useState<{ x: number; y: number; label: string } | null>(null);
  const [rebaseFailedLaneId, setRebaseFailedLaneId] = React.useState<string | null>(null);
  const [rebaseFailedPulse, setRebaseFailedPulse] = React.useState(false);
  const [mergeInProgressByLaneId, setMergeInProgressByLaneId] = React.useState<Record<string, boolean>>({});
  const [mergeDisappearingAtByLaneId, setMergeDisappearingAtByLaneId] = React.useState<Record<string, number>>({});
  const [textPrompt, setTextPrompt] = React.useState<GraphTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = React.useState<string | null>(null);
  const [undoToast, setUndoToast] = React.useState<{ message: string; undoAction: () => Promise<void> } | null>(null);
  const [undoPending, setUndoPending] = React.useState(false);
  const [conflictPanel, setConflictPanel] = React.useState<ConflictPanelState | null>(null);
  const [conflictOverlapFiles, setConflictOverlapFiles] = React.useState<Map<string, string[]>>(new Map());
  const [edgeSimulation, setEdgeSimulation] = React.useState<
    { laneAId: string; laneBId: string; loading: boolean; result: MergeSimulationResult | null; error: string | null }
    | null
  >(null);
  const [dropPreview, setDropPreview] = React.useState<
    { draggedLaneIds: string[]; targetLaneId: string; tone: "safe" | "warn" | "blocked"; message: string; detail: string }
    | null
  >(null);
  const [appearanceEditor, setAppearanceEditor] = React.useState<
    { laneId: string; x: number; y: number; color: string | null; icon: LaneIcon; tags: string[]; newTag: string }
    | null
  >(null);
  const [reparentDialog, setReparentDialog] = React.useState<
    {
      laneIds: string[];
      targetLaneId: string;
      overlapFiles: string[];
      preview: MergeSimulationResult | null;
      previewBusy: boolean;
      actionMode: "integrate" | "reparent" | "pr";
      integratePlan: { sourceLaneId: string; laneId: string; baseRef: string; mode: GitSyncMode; summary: string; detail: string } | null;
    }
    | null
  >(null);
  const [prCreate, setPrCreate] = React.useState<
    { laneId: string; baseLaneId: string; baseBranch: string; title: string; body: string; draft: boolean; creating: boolean; error: string | null }
    | null
  >(null);
  const [prCard, setPrCard] = React.useState<
    { pr: PrWithConflicts; detail: PagePrDetail | null; loading: boolean; error: string | null; mergeMethod: MergeMethod }
    | null
  >(null);
  const [prActionBusy, setPrActionBusy] = React.useState<string | null>(null);
  const [batchStatus, setBatchStatus] = React.useState<
    { operation: string; steps: BatchStep[]; activeIndex: number; summary: string | null } | null
  >(null);

  const nodesRef = React.useRef<Array<Node<GraphNodeData>>>([]);
  const nodeDragActiveRef = React.useRef(false);
  const dragOriginRef = React.useRef<Map<string, { x: number; y: number }>>(new Map());
  const dropPreviewTimerRef = React.useRef<number | null>(null);
  const nodeHoverTimerRef = React.useRef<number | null>(null);
  const lastFitViewKeyRef = React.useRef("");
  const handledFocusLaneRef = React.useRef<string | null>(null);
  const filtersPanelRef = React.useRef<HTMLDivElement>(null);
  const singleActionsRef = React.useRef<HTMLDivElement | null>(null);
  const batchActionsRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  React.useEffect(() => {
    if (viewMode !== "all") setShowOverviewRiskEdges(false);
  }, [viewMode]);

  React.useEffect(() => {
    if (dataError) setErrorBanner((prev) => prev ?? dataError);
  }, [dataError]);

  /* ── Snapshot + filters ────────────────────────────────────────────────── */

  const activeSnapshot = React.useMemo(
    () => sessionState[viewMode] ?? createSnapshot(viewMode),
    [sessionState, viewMode],
  );
  const filters = React.useMemo(() => coalesceGraphFilters(activeSnapshot.filters), [activeSnapshot.filters]);

  const updateGraphSnapshot = React.useCallback(
    (updater: (snapshot: GraphLayoutSnapshot) => GraphLayoutSnapshot) => {
      setSessionState((prev) => {
        const base = prev[viewMode] ?? createSnapshot(viewMode);
        const current: GraphLayoutSnapshot = { ...base, filters: coalesceGraphFilters(base.filters) };
        const nextSnapshot = updater(current);
        return {
          ...prev,
          [viewMode]: {
            ...nextSnapshot,
            filters: coalesceGraphFilters(nextSnapshot.filters),
            updatedAt: new Date().toISOString(),
            viewMode,
          },
        };
      });
    },
    [viewMode],
  );

  const updateFilters = React.useCallback(
    (updater: (current: GraphFilterState) => GraphFilterState) => {
      updateGraphSnapshot((snapshot) => ({ ...snapshot, filters: updater(snapshot.filters) }));
    },
    [updateGraphSnapshot],
  );

  /* ── Derived reads ─────────────────────────────────────────────────────── */

  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane] as const)), [lanes]);
  const primaryHierarchyMeta = React.useMemo(() => laneHierarchyFromPrimary(lanes), [lanes]);
  const primaryLaneId = primaryHierarchyMeta.primary?.id ?? null;

  const statusByLane = React.useMemo(() => {
    const map = new Map<string, GraphNodeData["status"]>();
    for (const entry of batch?.lanes ?? []) map.set(entry.laneId, entry.status);
    return map;
  }, [batch]);

  const riskByPair = React.useMemo(() => {
    const map = new Map<string, { riskLevel: "none" | "low" | "medium" | "high"; overlapCount: number; stale: boolean }>();
    for (const entry of batch?.matrix ?? []) {
      if (entry.laneAId === entry.laneBId) continue;
      map.set(edgePairKey(entry.laneAId, entry.laneBId), {
        riskLevel: entry.riskLevel,
        overlapCount: entry.overlapCount,
        stale: entry.stale,
      });
    }
    return map;
  }, [batch]);

  const overlapFilesByPair = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const overlap of batch?.overlaps ?? []) {
      map.set(edgePairKey(overlap.laneAId, overlap.laneBId), overlap.files);
    }
    // A per-lane `pageConflictOverlaps` read, when one has happened, is newer
    // than the batch it came with — the batch is a snapshot and the panel asked
    // on open — so it wins for the pairs it covers.
    for (const [key, files] of conflictOverlapFiles) map.set(key, files);
    return map;
  }, [batch, conflictOverlapFiles]);

  /**
   * Activity, from the operation ledger alone.
   *
   * The compiled page scored a lane from its SESSIONS (running = 50, ended
   * within the hour = 20) plus recent `git_commit` operations. There is no
   * session read on the page action surface, so the score is operations only:
   * a running operation counts as live work, and anything in the last day adds
   * weight. The bucket that decides node SIZE in Activity mode is unchanged.
   */
  const { activityScoreByLaneId, activeSessionsByLaneId, lastActivityByLaneId } = React.useMemo(() => {
    const now = Date.now();
    const score: Record<string, number> = {};
    const active: Record<string, number> = {};
    const latest: Record<string, number> = {};
    for (const operation of operations) {
      const laneId = operation.laneId;
      if (!laneId) continue;
      const startedAt = Date.parse(operation.startedAt);
      if (Number.isNaN(startedAt)) continue;
      if (operation.status === "running") {
        active[laneId] = (active[laneId] ?? 0) + 1;
        score[laneId] = (score[laneId] ?? 0) + 50;
      } else if (now - startedAt <= 24 * 60 * 60_000) {
        score[laneId] = (score[laneId] ?? 0) + 10;
      } else {
        continue;
      }
      latest[laneId] = Math.max(latest[laneId] ?? 0, startedAt);
    }
    const asIso: Record<string, string> = {};
    for (const [laneId, ts] of Object.entries(latest)) {
      if (ts) asIso[laneId] = new Date(ts).toISOString();
    }
    return { activityScoreByLaneId: score, activeSessionsByLaneId: active, lastActivityByLaneId: asIso };
  }, [operations]);

  const activityBucketByLaneId = React.useMemo(() => {
    const values = Object.values(activityScoreByLaneId).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const p25 = values[Math.floor(values.length * 0.25)] ?? 0;
    const p75 = values[Math.floor(values.length * 0.75)] ?? 0;
    const out: Record<string, GraphNodeData["activityBucket"]> = {};
    for (const lane of lanes) {
      const score = activityScoreByLaneId[lane.id] ?? 0;
      if (score <= 0) out[lane.id] = "min";
      else if (score < p25) out[lane.id] = "low";
      else if (score > p75) out[lane.id] = "high";
      else out[lane.id] = "medium";
    }
    return out;
  }, [activityScoreByLaneId, lanes]);

  const environmentByLaneId = React.useMemo(() => {
    const compiled = environments
      .map((mapping) => ({ ...mapping, branchRegex: globToRegExp(mapping.branch ?? "") }))
      .filter((mapping) => (mapping.branch ?? "").trim().length && (mapping.env ?? "").trim().length);
    const out: Record<string, { env: string; color: string | null }> = {};
    for (const lane of lanes) {
      const branch = branchNameFromRef(lane.branchRef);
      const match = compiled.find((mapping) => mapping.branchRegex.test(branch));
      if (!match) continue;
      out[lane.id] = { env: match.env, color: match.color ?? null };
    }
    return out;
  }, [environments, lanes]);

  const integrationSourcesByLaneId = React.useMemo(
    () => buildIntegrationSourcesByLaneId(proposals, laneById),
    [proposals, laneById],
  );

  const laneIdByBranchRef = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      const normalized = branchNameFromRef(lane.branchRef);
      map.set(lane.branchRef, lane.id);
      map.set(normalized, lane.id);
      map.set(`refs/heads/${normalized}`, lane.id);
    }
    return map;
  }, [lanes]);

  const resolvePrBaseLaneId = React.useCallback(
    (lane: LaneSummary, baseBranch: string) =>
      laneIdByBranchRef.get(baseBranch)
      ?? laneIdByBranchRef.get(branchNameFromRef(baseBranch))
      ?? lane.parentLaneId
      ?? primaryLaneId,
    [laneIdByBranchRef, primaryLaneId],
  );

  const prByLaneId = React.useMemo(() => new Map(prs.map((pr) => [pr.laneId, pr] as const)), [prs]);

  const prOverlayByPair = React.useMemo(() => {
    const map = new Map<string, GraphPrOverlay>();
    for (const pr of prs) {
      const lane = laneById.get(pr.laneId);
      if (!lane) continue;
      const baseLaneId = resolvePrBaseLaneId(lane, pr.baseBranch);
      if (!baseLaneId) continue;
      map.set(
        edgePairKey(baseLaneId, pr.laneId),
        buildGraphPrOverlay({ pr, baseLaneId, mergeInProgress: Boolean(mergeInProgressByLaneId[pr.laneId]) }),
      );
    }
    return map;
  }, [laneById, mergeInProgressByLaneId, prs, resolvePrBaseLaneId]);

  const prOverlayByLaneId = React.useMemo(() => {
    const map = new Map<string, GraphPrOverlay>();
    for (const overlay of prOverlayByPair.values()) map.set(overlay.laneId, overlay);
    return map;
  }, [prOverlayByPair]);

  const laneMatchesFilters = React.useCallback(
    (lane: LaneSummary): boolean => {
      if (filters.hidePrimary && lane.laneType === "primary") return false;
      if (filters.hideAttached && lane.laneType === "attached") return false;
      if (filters.hideArchived && lane.archivedAt) return false;
      if (filters.laneTypes.length > 0 && !filters.laneTypes.includes(lane.laneType)) return false;
      if (filters.status.length > 0 && !filters.status.includes(laneStatusGroup(statusByLane.get(lane.id)))) return false;
      if (filters.tags.length > 0 && !filters.tags.some((tag) => (lane.tags ?? []).includes(tag))) return false;
      if (filters.rootLaneId) {
        const descendants = collectDescendants(lanes, filters.rootLaneId);
        if (!descendants.has(lane.id) && lane.id !== filters.rootLaneId) return false;
      }
      if (!laneMatchesFilter(lane, false, filters.search)) return false;
      return true;
    },
    [filters, lanes, statusByLane],
  );

  /* ── Plugin nodes ──────────────────────────────────────────────────────── */

  const pressPluginNode = React.useCallback((entry: PluginGraphNodeEntry) => {
    void invokeSocketEntry(entry.socketId, {
      ...(entry.anchorNodeId ? { laneId: entry.anchorNodeId } : {}),
      ...(entry.payload.actionId ? { actionId: entry.payload.actionId } : {}),
    }).then((pressed) => {
      if (pressed) return;
      void toast({
        level: "warning",
        message: `${entry.identity.displayName} could not run that node.`,
      });
    });
  }, []);

  const pluginOverlay = React.useMemo(() => {
    if (socketEntries.length === 0) return EMPTY_PLUGIN_GRAPH_OVERLAY;
    const laneNodeIds = new Set(lanes.map((lane) => lane.id));
    const laneNodeIdByPrId = new Map<string, string>();
    for (const [laneId, overlay] of prOverlayByLaneId) {
      // A `pr` entity is keyed by its NUMBER as a string, so that is what a
      // plugin's edge names, not the internal PR id.
      if (laneNodeIds.has(laneId)) laneNodeIdByPrId.set(String(overlay.number), laneId);
    }
    return buildPluginGraphOverlay({ entries: socketEntries, laneNodeIds, laneNodeIdByPrId });
  }, [lanes, prOverlayByLaneId, socketEntries]);

  /* ── The model ─────────────────────────────────────────────────────────── */

  const model = React.useMemo(() => {
    if (!loadedPreferences) return EMPTY_GRAPH_MODEL;
    return buildGraphModel({
      lanes,
      viewMode,
      snapshot: activeSnapshot,
      filters,
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
      integrationProposals: proposals,
      prOverlayByPair,
      prOverlayByLaneId,
      showOverviewRiskEdges,
      appearanceDraft: appearanceEditor
        ? {
          laneId: appearanceEditor.laneId,
          color: appearanceEditor.color,
          icon: appearanceEditor.icon,
          tags: appearanceEditor.tags,
        }
        : null,
      pluginOverlay,
      onPressPluginNode: pressPluginNode,
    });
  }, [
    activeSnapshot,
    activityBucketByLaneId,
    activityScoreByLaneId,
    activeSessionsByLaneId,
    appearanceEditor,
    autoRebaseByLaneId,
    environmentByLaneId,
    filters,
    integrationSourcesByLaneId,
    laneMatchesFilters,
    lanes,
    lastActivityByLaneId,
    loadedPreferences,
    pluginOverlay,
    prOverlayByLaneId,
    prOverlayByPair,
    pressPluginNode,
    proposals,
    riskByPair,
    showOverviewRiskEdges,
    statusByLane,
    syncByLaneId,
    viewMode,
  ]);

  const connectedToHoveredNode = React.useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const connected = new Set<string>([hoveredNodeId]);
    if (viewMode === "stack" || viewMode === "all") {
      const primary = primaryHierarchyMeta.primary;
      if (primary?.id === hoveredNodeId) {
        for (const lane of lanes) connected.add(lane.id);
      } else if (primary) {
        connected.add(primary.id);
      }
      for (const lane of lanes) {
        if (lane.id === hoveredNodeId && lane.parentLaneId) connected.add(lane.parentLaneId);
        if (lane.parentLaneId === hoveredNodeId) connected.add(lane.id);
      }
    }
    if (viewMode === "risk" || viewMode === "all") {
      for (const [key, value] of riskByPair.entries()) {
        if (value.riskLevel === "none" && value.overlapCount === 0) continue;
        const [laneAId, laneBId] = key.split("::");
        if (!laneAId || !laneBId) continue;
        if (laneAId === hoveredNodeId) connected.add(laneBId);
        if (laneBId === hoveredNodeId) connected.add(laneAId);
      }
    }
    for (const [integrationLaneId, sources] of integrationSourcesByLaneId.entries()) {
      if (integrationLaneId === hoveredNodeId) {
        for (const source of sources) connected.add(source.laneId);
        continue;
      }
      for (const source of sources) {
        if (source.laneId === hoveredNodeId) connected.add(integrationLaneId);
      }
    }
    return connected;
  }, [hoveredNodeId, integrationSourcesByLaneId, lanes, primaryHierarchyMeta.primary, riskByPair, viewMode]);

  React.useEffect(() => {
    if (!loadedPreferences) return;
    if (nodeDragActiveRef.current) return;
    const edgeVisualState = (edgeId: string, source: string, target: string) => {
      const connectedToNodeHover = hoveredNodeId ? source === hoveredNodeId || target === hoveredNodeId : false;
      const highlightedByEdge = hoveredEdgeId ? hoveredEdgeId === edgeId : false;
      return {
        highlight: hoveredEdgeId ? highlightedByEdge : connectedToNodeHover,
        dimmed: hoveredEdgeId ? hoveredEdgeId !== edgeId : hoveredNodeId ? !connectedToNodeHover : false,
      };
    };

    setNodes(model.nodes.map((node) => {
      const connectedToHover = hoveredNodeId ? connectedToHoveredNode.has(node.id) : false;
      const dimmedByHover = Boolean(hoveredNodeId) && !connectedToHover;
      return {
        ...node,
        data: {
          ...node.data,
          dimmed: !model.visibleNodeIds.has(node.id) || dimmedByHover,
          highlight: Boolean(hoveredNodeId) && connectedToHover,
          rebaseFailed: !isSyntheticGraphNode(node.data) && rebaseFailedLaneId === node.id,
          rebasePulse: !isSyntheticGraphNode(node.data) && rebaseFailedLaneId === node.id && rebaseFailedPulse,
          mergeInProgress: !isSyntheticGraphNode(node.data) && Boolean(mergeInProgressByLaneId[node.id]),
          mergeDisappearing: !isSyntheticGraphNode(node.data) && Boolean(mergeDisappearingAtByLaneId[node.id]),
          focusGlow: focusLaneId === node.id,
        },
        selected: selectedLaneIds.includes(node.id),
      };
    }));

    setEdges(model.edges.map((edge) => {
      const visual = edgeVisualState(edge.id, edge.source, edge.target);
      return { ...edge, data: { ...(edge.data as GraphEdgeData), ...visual }, selected: visual.highlight };
    }));
  }, [
    connectedToHoveredNode,
    focusLaneId,
    hoveredEdgeId,
    hoveredNodeId,
    loadedPreferences,
    mergeDisappearingAtByLaneId,
    mergeInProgressByLaneId,
    model,
    rebaseFailedLaneId,
    rebaseFailedPulse,
    selectedLaneIds,
  ]);

  /* ── Focus a lane from the deeplink ────────────────────────────────────── */

  /**
   * The lane a `?ctx={"focusLane":…}` deeplink asked for.
   *
   * Read from the host's own injected context first — `pointer` is where a
   * plugin navigation's `ctx` lands — then from the subject, which is what a
   * socket-opened placement carries. The page's own query string is the last
   * resort and exists for the web client, where the guest is an iframe whose src
   * the host builds.
   */
  const requestedFocusLaneId = React.useMemo(() => {
    const pointer = context.pointer as Record<string, unknown> | undefined;
    const fromPointer = typeof pointer?.focusLane === "string" ? pointer.focusLane : null;
    if (fromPointer) return fromPointer;
    const subject = context.subject as { kind?: string; laneId?: unknown } | null;
    if (subject?.kind === "lane" && typeof subject.laneId === "string") return subject.laneId;
    if (typeof window === "undefined") return null;
    try {
      return new URL(window.location.href).searchParams.get("focusLane");
    } catch {
      return null;
    }
  }, [context.pointer, context.subject]);

  React.useEffect(() => {
    if (!requestedFocusLaneId) return;
    if (!loadedPreferences || lanes.length === 0) return;
    if (handledFocusLaneRef.current === requestedFocusLaneId) return;
    if (!lanes.some((lane) => lane.id === requestedFocusLaneId)) return;
    handledFocusLaneRef.current = requestedFocusLaneId;
    setSelectedLaneIds((prev) => (sameIdSet(prev, [requestedFocusLaneId]) ? prev : [requestedFocusLaneId]));
    setFocusLaneId(requestedFocusLaneId);
    const timer = window.setTimeout(() => {
      const targetNode = nodesRef.current.find((node) => node.id === requestedFocusLaneId);
      if (targetNode) void reactFlow.fitView({ nodes: [targetNode], duration: 500, padding: 0.4 });
    }, 0);
    const glowTimer = window.setTimeout(() => setFocusLaneId(null), 4000);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(glowTimer);
    };
  }, [lanes, loadedPreferences, reactFlow, requestedFocusLaneId]);

  React.useEffect(() => {
    if (!loadedPreferences) return;
    const fitKey = `${viewMode}:${nodes.length}:${edges.length}:${activeSnapshot.updatedAt}`;
    if (lastFitViewKeyRef.current === fitKey) return;
    lastFitViewKeyRef.current = fitKey;
    const timer = window.setTimeout(() => {
      void reactFlow.fitView({ duration: 500, padding: 0.2 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSnapshot.updatedAt, edges.length, loadedPreferences, nodes.length, reactFlow, viewMode]);

  React.useEffect(() => {
    const timers = Object.entries(mergeDisappearingAtByLaneId).map(([laneId, startedAt]) =>
      window.setTimeout(() => {
        setMergeDisappearingAtByLaneId((prev) => {
          if (!(laneId in prev)) return prev;
          const next = { ...prev };
          delete next[laneId];
          return next;
        });
        setMergeInProgressByLaneId((prev) => {
          if (!(laneId in prev)) return prev;
          const next = { ...prev };
          delete next[laneId];
          return next;
        });
      }, Math.max(0, MERGE_SUCCESS_ANIMATION_MS - (Date.now() - startedAt)))
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [mergeDisappearingAtByLaneId]);

  React.useEffect(() => {
    if (!undoToast || undoPending) return;
    const timer = window.setTimeout(() => setUndoToast(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [undoToast, undoPending]);

  React.useEffect(() => {
    if (!batchStatus?.summary) return;
    if (batchStatus.steps.some((step) => step.status === "failed" || step.status === "skipped")) return;
    const timer = window.setTimeout(() => setBatchStatus(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [batchStatus]);

  React.useEffect(() => {
    return () => {
      if (dropPreviewTimerRef.current != null) window.clearTimeout(dropPreviewTimerRef.current);
      if (nodeHoverTimerRef.current != null) window.clearTimeout(nodeHoverTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (!showFiltersPanel && !singleActionsOpen && !batchActionsOpen) return;
    const closeAll = () => {
      setShowFiltersPanel(false);
      setSingleActionsOpen(false);
      setBatchActionsOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof globalThis.Node)) {
        closeAll();
        return;
      }
      if (
        filtersPanelRef.current?.contains(target)
        || singleActionsRef.current?.contains(target)
        || batchActionsRef.current?.contains(target)
      ) return;
      closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAll();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [batchActionsOpen, showFiltersPanel, singleActionsOpen]);

  React.useEffect(() => {
    setSingleActionsOpen(false);
    if (selectedLaneIds.length < 2) setBatchActionsOpen(false);
  }, [selectedLaneIds]);

  /* ── Prompts ───────────────────────────────────────────────────────────── */

  const requestTextInput = React.useCallback(
    (args: {
      title: string;
      message?: string;
      defaultValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      validate?: (value: string) => string | null;
    }): Promise<string | null> =>
      new Promise((resolve) => {
        setTextPromptError(null);
        setTextPrompt({
          title: args.title,
          message: args.message,
          placeholder: args.placeholder,
          value: args.defaultValue ?? "",
          confirmLabel: args.confirmLabel ?? "Confirm",
          validate: args.validate,
          resolve,
        });
      }),
    [],
  );

  const cancelTextPrompt = React.useCallback(() => {
    setTextPrompt((prev) => {
      if (prev) prev.resolve(null);
      return null;
    });
    setTextPromptError(null);
  }, []);

  const submitTextPrompt = React.useCallback(() => {
    setTextPrompt((prev) => {
      if (!prev) return prev;
      const value = prev.value.trim();
      const validationError = prev.validate?.(value) ?? null;
      if (validationError) {
        setTextPromptError(validationError);
        return prev;
      }
      setTextPromptError(null);
      prev.resolve(value);
      return null;
    });
  }, []);

  /* ── Mutations ─────────────────────────────────────────────────────────── */

  /** Every mutation answers `{ok,message}`; this is the one place that reads it. */
  const settle = React.useCallback(
    (result: actions.PageActionResult, success?: string): boolean => {
      if (!result.ok) {
        setErrorBanner(result.message ?? "That did not work.");
        return false;
      }
      if (success) void toast({ level: "success", message: success });
      return true;
    },
    [],
  );

  const refreshAfterGit = React.useCallback(async () => {
    await Promise.allSettled([data.refreshLanes(), data.refreshSync(), data.refreshOperations()]);
  }, [data]);

  const runLaneRebase = React.useCallback(
    async (laneId: string, recursive: boolean): Promise<boolean> => {
      const result = await actions.rebaseStart(laneId, recursive);
      if (!result.ok) {
        setRebaseFailedLaneId(laneId);
        setRebaseFailedPulse(true);
        window.setTimeout(() => setRebaseFailedPulse(false), 1650);
      }
      return settle(result);
    },
    [settle],
  );

  const runRebaseAndPublishLane = React.useCallback(
    async (laneId: string, args?: { confirmPublish?: boolean; recursive?: boolean }): Promise<RebasePublishOutcome> => {
      const lane = laneById.get(laneId);
      if (!lane) return { status: "skipped", message: "lane not found" };
      if (!lane.parentLaneId) return { status: "skipped", message: "no parent lane" };

      if (!(await runLaneRebase(laneId, Boolean(args?.recursive)))) {
        return { status: "skipped", message: "rebase failed" };
      }

      await actions.gitFetch(laneId).catch(() => ({ ok: false }));
      const statuses = await actions.getSyncStatuses().catch(() => ({} as Record<string, never>));
      const sync = statuses[laneId] ?? null;
      const confirmPublish = Boolean(args?.confirmPublish);

      if (!sync || !sync.hasUpstream) {
        const missingRemote = sync?.upstreamState === "missing";
        if (confirmPublish) {
          const ok = await hostConfirm({
            title: missingRemote ? "Recreate remote branch" : "Publish lane",
            body: missingRemote
              ? `The remote branch for '${lane.name}' is missing. Recreate origin/${lane.branchRef}?`
              : `Publish lane '${lane.name}' to origin/${lane.branchRef}?`,
            confirmLabel: missingRemote ? "Recreate" : "Publish",
          });
          if (!ok) return { status: "skipped", message: "publish skipped" };
        }
        const pushed = await actions.gitPush(laneId);
        if (!pushed.ok) return { status: "skipped", message: pushed.message ?? "push refused" };
        return { status: "done", message: missingRemote ? "recreated remote branch" : "published new remote branch" };
      }

      if (sync.diverged && sync.ahead > 0) {
        if (confirmPublish) {
          const ok = await hostConfirm({
            title: "Force push",
            body: `Lane '${lane.name}' diverged from remote (${sync.ahead} local ahead, ${sync.behind} remote ahead). Force push with lease now?`,
            confirmLabel: "Force push",
            destructive: true,
          });
          if (!ok) return { status: "skipped", message: "force push skipped" };
        }
        const pushed = await actions.gitPush(laneId, true);
        if (!pushed.ok) return { status: "skipped", message: pushed.message ?? "push refused" };
        return { status: "done", message: "force-pushed with lease" };
      }

      if (sync.ahead > 0) {
        if (confirmPublish) {
          const ok = await hostConfirm({
            title: "Push commits",
            body: `Push ${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} for lane '${lane.name}' now?`,
            confirmLabel: "Push",
          });
          if (!ok) return { status: "skipped", message: "push skipped" };
        }
        const pushed = await actions.gitPush(laneId);
        if (!pushed.ok) return { status: "skipped", message: pushed.message ?? "push refused" };
        return { status: "done", message: "pushed updates" };
      }

      if (sync.behind > 0) {
        return { status: "skipped", message: `behind remote by ${sync.behind} commit${sync.behind === 1 ? "" : "s"}` };
      }
      return { status: "done", message: "rebased and already pushed" };
    },
    [laneById, runLaneRebase],
  );

  const openPrCard = React.useCallback(
    (pr: PrWithConflicts) => {
      setPrCard({ pr, detail: null, loading: true, error: null, mergeMethod: "squash" });
      void actions
        .getPrDetail(pr.id)
        .then((detail) => setPrCard((prev) => (prev && prev.pr.id === pr.id ? { ...prev, detail, loading: false } : prev)))
        .catch((err) =>
          setPrCard((prev) =>
            prev && prev.pr.id === pr.id
              ? { ...prev, loading: false, error: errorText(err, "Could not load this PR.") }
              : prev,
          )
        );
    },
    [],
  );

  const openPrCreate = React.useCallback(
    (laneId: string, baseLaneId: string) => {
      const lane = laneById.get(laneId);
      const baseLane = laneById.get(baseLaneId);
      if (!lane || !baseLane) return;
      const existing = prByLaneId.get(laneId) ?? null;
      if (existing) {
        openPrCard(existing);
        return;
      }
      setPrCreate({
        laneId,
        baseLaneId,
        baseBranch: baseLane.branchRef,
        title: lane.name,
        body: "",
        draft: false,
        creating: false,
        error: null,
      });
    },
    [laneById, openPrCard, prByLaneId],
  );

  const runSubmitReview = React.useCallback(
    async (pr: PrWithConflicts, event: "APPROVE" | "REQUEST_CHANGES") => {
      setPrActionBusy(event);
      try {
        let body: string | undefined;
        if (event === "REQUEST_CHANGES") {
          const requested = await requestTextInput({
            title: "Request changes",
            message: "Optional review note to include with the change request.",
            placeholder: "Changes requested because…",
            confirmLabel: "Submit review",
          });
          if (requested === null) return;
          body = requested.trim() || undefined;
        }
        const result = await actions.submitReview({ prId: pr.id, event, ...(body ? { body } : {}) });
        if (settle(result, event === "APPROVE" ? "Approved." : "Changes requested.")) {
          await data.refreshPrs();
          if (prCard?.pr.id === pr.id) openPrCard(pr);
        }
      } finally {
        setPrActionBusy(null);
      }
    },
    [data, openPrCard, prCard?.pr.id, requestTextInput, settle],
  );

  const runLandPr = React.useCallback(
    async (pr: PrWithConflicts, method: MergeMethod) => {
      setPrActionBusy("merge");
      setMergeInProgressByLaneId((prev) => ({ ...prev, [pr.laneId]: true }));
      try {
        const result = await actions.landPr(pr.id, method);
        if (!result.ok) {
          setMergeInProgressByLaneId((prev) => ({ ...prev, [pr.laneId]: false }));
          setErrorBanner(result.message ?? "Merge failed.");
          return;
        }
        setMergeDisappearingAtByLaneId((prev) => ({ ...prev, [pr.laneId]: Date.now() }));
        void toast({ level: "success", message: `Landed PR #${pr.githubPrNumber}.` });
        setPrCard(null);
        await Promise.allSettled([data.refreshPrs(), data.refreshLanes(), data.refreshRiskBatch()]);
      } finally {
        setPrActionBusy(null);
      }
    },
    [data],
  );

  const openConflictPanelForEdge = React.useCallback(
    (laneAId: string, laneBId: string) => {
      const laneA = laneById.get(laneAId);
      const laneB = laneById.get(laneBId);
      const applyLaneId = laneA && laneB && laneA.stackDepth !== laneB.stackDepth
        ? (laneA.stackDepth > laneB.stackDepth ? laneAId : laneBId)
        : laneAId;

      setConflictPanel({
        laneAId,
        laneBId,
        loading: true,
        result: null,
        error: null,
        applyLaneId,
        preview: null,
        preparing: false,
        proposal: null,
        proposing: false,
        applyMode: "unstaged",
        commitMessage: "",
        applying: false,
      });

      void actions.simulateMerge(laneAId, laneBId).then((result) => {
        setConflictPanel((prev) =>
          prev && prev.laneAId === laneAId && prev.laneBId === laneBId
            ? {
              ...prev,
              loading: false,
              ...(result.ok && result.result
                ? { result: result.result }
                : { error: result.message ?? "Could not simulate this merge." }),
            }
            : prev
        );
      });

      // The pair's overlapping files, fresher than the batch snapshot that
      // shipped with the risk edge the reader just clicked.
      void actions
        .getConflictOverlaps(laneAId)
        .then((overlaps) => {
          setConflictOverlapFiles((prev) => {
            const next = new Map(prev);
            for (const overlap of overlaps ?? []) {
              next.set(edgePairKey(overlap.laneAId, overlap.laneBId), overlap.files);
            }
            return next;
          });
        })
        .catch(() => {});
    },
    [laneById],
  );

  const runBatchOperation = React.useCallback(
    async (operation: "rebase" | "rebase_publish" | "push" | "fetch" | "archive" | "delete") => {
      if (selectedLaneIds.length < 2) return;
      const isRebaseLike = operation === "rebase" || operation === "rebase_publish";
      if (isRebaseLike) {
        setRebaseFailedLaneId(null);
        setRebaseFailedPulse(false);
      }
      const steps = selectedLaneIds.map((laneId) => ({
        laneId,
        laneName: laneById.get(laneId)?.name ?? laneId,
        status: "pending" as const,
      }));
      setBatchStatus({ operation, steps, activeIndex: 0, summary: null });

      const descendantsCache = new Map<string, Set<string>>();
      for (const laneId of selectedLaneIds) descendantsCache.set(laneId, collectDescendants(lanes, laneId));
      const blocked = new Set<string>();
      const ordered = isRebaseLike
        ? [...selectedLaneIds].sort((a, b) => (laneById.get(a)?.stackDepth ?? 0) - (laneById.get(b)?.stackDepth ?? 0))
        : [...selectedLaneIds];

      const mark = (laneId: string, status: BatchStep["status"], error?: string) => {
        setBatchStatus((prev) =>
          prev
            ? {
              ...prev,
              steps: prev.steps.map((step) =>
                step.laneId === laneId ? { ...step, status, ...(error ? { error } : {}) } : step
              ),
            }
            : prev
        );
      };

      let failedCount = 0;
      let doneCount = 0;
      let skippedCount = 0;
      for (let index = 0; index < ordered.length; index += 1) {
        const laneId = ordered[index]!;
        setBatchStatus((prev) => (prev ? { ...prev, activeIndex: index } : prev));
        mark(laneId, "running");

        if (blocked.has(laneId)) {
          skippedCount += 1;
          mark(laneId, "skipped", "blocked by parent failure");
          continue;
        }

        let result: actions.PageActionResult;
        let skippedReason: string | null = null;
        if (operation === "rebase") {
          result = await actions.rebaseStart(laneId, false);
        } else if (operation === "rebase_publish") {
          const outcome = await runRebaseAndPublishLane(laneId, { confirmPublish: true, recursive: false });
          skippedReason = outcome.status === "skipped" ? outcome.message : null;
          result = { ok: true };
        } else if (operation === "push") {
          result = await actions.gitPush(laneId);
        } else if (operation === "fetch") {
          result = await actions.gitFetch(laneId);
        } else if (operation === "archive") {
          result = await actions.archiveLane(laneId);
        } else {
          result = await actions.deleteLane(laneId, { force: true, deleteBranch: false });
        }

        if (!result.ok) {
          const message = result.message ?? "That did not work.";
          if (/lane not found|no longer exists/i.test(message)) {
            skippedCount += 1;
            mark(laneId, "skipped", "no longer exists");
            continue;
          }
          failedCount += 1;
          mark(laneId, "failed", message);
          if (isRebaseLike) {
            for (const childId of descendantsCache.get(laneId) ?? []) blocked.add(childId);
            setRebaseFailedLaneId(laneId);
            setRebaseFailedPulse(true);
            window.setTimeout(() => setRebaseFailedPulse(false), 1650);
            const label = operation === "rebase_publish" ? "Rebase + push" : "Rebase";
            setErrorBanner(
              `${label} paused: conflict on '${laneById.get(laneId)?.name ?? laneId}'. ${doneCount}/${ordered.length} lanes completed.`,
            );
          }
          continue;
        }

        if (skippedReason) {
          skippedCount += 1;
          mark(laneId, "skipped", skippedReason);
        } else {
          doneCount += 1;
          mark(laneId, "done");
        }
      }

      setBatchStatus((prev) =>
        prev
          ? {
            ...prev,
            summary: `${doneCount}/${ordered.length} done, ${failedCount} failed${skippedCount > 0 ? `, ${skippedCount} skipped` : ""}`,
          }
          : prev
      );
      await refreshAfterGit();
    },
    [laneById, lanes, refreshAfterGit, runRebaseAndPublishLane, selectedLaneIds],
  );

  const openReparentDialog = React.useCallback(
    (draggedLaneId: string, targetLaneId: string, laneIds: string[]) => {
      const lane = laneById.get(draggedLaneId);
      const target = laneById.get(targetLaneId);
      if (!lane || !target || lane.id === target.id) return;

      const wouldCycle = laneIds.some(
        (laneId) => laneId === targetLaneId || collectDescendants(lanes, laneId).has(targetLaneId),
      );
      if (wouldCycle) {
        setErrorBanner("Cannot reparent — would create cycle.");
        return;
      }

      const overlapFiles = Array.from(
        laneIds.reduce((acc, laneId) => {
          for (const file of overlapFilesByPair.get(edgePairKey(laneId, targetLaneId)) ?? []) acc.add(file);
          return acc;
        }, new Set<string>()),
      ).sort((a, b) => a.localeCompare(b));

      const source = laneIds.length === 1 ? laneById.get(laneIds[0]!) : null;
      const integratePlan = source
        ? collectDescendants(lanes, source.id).has(target.id)
          ? {
            sourceLaneId: source.id,
            laneId: target.id,
            baseRef: source.branchRef,
            mode: "rebase" as GitSyncMode,
            summary: `Rebase '${target.name}' onto '${source.name}'`,
            detail: `Bring ${source.branchRef} into ${target.name} with rebase.`,
          }
          : {
            sourceLaneId: source.id,
            laneId: target.id,
            baseRef: source.branchRef,
            mode: "merge" as GitSyncMode,
            summary: `Merge '${source.name}' into '${target.name}'`,
            detail: `Bring ${source.branchRef} into ${target.name} with merge.`,
          }
        : null;

      setReparentDialog({
        laneIds,
        targetLaneId,
        overlapFiles,
        preview: null,
        previewBusy: false,
        actionMode: integratePlan ? "integrate" : "reparent",
        integratePlan,
      });
    },
    [laneById, lanes, overlapFilesByPair],
  );

  const applyReparent = React.useCallback(async () => {
    if (!reparentDialog) return;

    if (reparentDialog.actionMode === "integrate") {
      const plan = reparentDialog.integratePlan;
      if (!plan) return;
      const result = await actions.gitSync({ laneId: plan.laneId, mode: plan.mode, baseRef: plan.baseRef });
      if (settle(result, `Synced ${laneById.get(plan.laneId)?.name ?? plan.laneId}`)) {
        setReparentDialog(null);
        await refreshAfterGit();
      }
      return;
    }

    if (reparentDialog.actionMode === "pr") {
      const laneId = reparentDialog.laneIds[0];
      if (!laneId) return;
      openPrCreate(laneId, reparentDialog.targetLaneId);
      setReparentDialog(null);
      return;
    }

    const target = laneById.get(reparentDialog.targetLaneId);
    if (!target) return;

    const orderedLaneIds = [...reparentDialog.laneIds].sort(
      (a, b) => (laneById.get(a)?.stackDepth ?? 0) - (laneById.get(b)?.stackDepth ?? 0),
    );

    const completed: Array<{ laneId: string; previousParentLaneId: string | null }> = [];
    for (const laneId of orderedLaneIds) {
      const result = await actions.reparentLane(laneId, target.id);
      if (!result.ok) {
        // Roll back what already moved, newest first, then say what failed.
        for (const rollback of [...completed].reverse()) {
          if (!rollback.previousParentLaneId) continue;
          await actions.reparentLane(rollback.laneId, rollback.previousParentLaneId).catch(() => {});
        }
        setErrorBanner(result.message ?? "Could not reparent that lane.");
        setReparentDialog(null);
        await data.refreshLanes();
        return;
      }
      completed.push({ laneId, previousParentLaneId: result.previousParentLaneId ?? null });
    }

    setUndoPending(false);
    setUndoToast({
      message: `Reparented ${
        orderedLaneIds.length === 1
          ? `'${laneById.get(orderedLaneIds[0]!)?.name ?? orderedLaneIds[0]}'`
          : `${orderedLaneIds.length} lanes`
      } under '${target.name}'`,
      undoAction: async () => {
        for (const rollback of [...completed].reverse()) {
          if (!rollback.previousParentLaneId) continue;
          await actions.reparentLane(rollback.laneId, rollback.previousParentLaneId);
        }
        await data.refreshLanes();
      },
    });
    setReparentDialog(null);
    await data.refreshLanes();
  }, [data, laneById, openPrCreate, refreshAfterGit, reparentDialog, settle]);

  /* ── The lane action table ─────────────────────────────────────────────── */

  const runLaneAction = React.useCallback(
    async (laneId: string, action: string, options?: { appearanceAnchor?: { x: number; y: number } }) => {
      const lane = laneById.get(laneId);
      if (!lane) return;
      const lanePr = prByLaneId.get(lane.id) ?? null;
      const baseLaneId = resolvePrBaseLaneId(lane, lane.baseRef);

      if (action === "open-lane") {
        await openLink(laneDeeplink(lane.id));
        return;
      }
      if (action === "open-folder") {
        // `ui.openPathInEditor` is the platform batch's verb; `host/ui.ts` falls
        // back to the `ade://file` deeplink on a host that has not got it yet.
        await openPath({ rootPath: lane.worktreePath, target: { path: lane.worktreePath } });
        return;
      }
      if (action === "copy-remote-path") {
        const copied = await writeClipboard(lane.worktreePath);
        void toast({
          level: copied ? "success" : "warning",
          message: copied ? "Copied the worktree path." : "This host has no clipboard.",
        });
        return;
      }
      if (action === "view-pr") {
        if (lanePr) openPrCard(lanePr);
        return;
      }
      if (action === "create-pr") {
        if (baseLaneId) openPrCreate(lane.id, baseLaneId);
        return;
      }
      if (action === "merge-pr") {
        if (lanePr) await runLandPr(lanePr, "squash");
        return;
      }
      if (action === "approve-pr") {
        if (lanePr) await runSubmitReview(lanePr, "APPROVE");
        return;
      }
      if (action === "request-pr-changes") {
        if (lanePr) await runSubmitReview(lanePr, "REQUEST_CHANGES");
        return;
      }
      if (action === "create-child") {
        const name = await requestTextInput({
          title: "Child lane name",
          validate: (value) => (value ? null : "Lane name is required"),
        });
        if (!name) return;
        if (settle(await actions.createChildLane(lane.id, name), `Created ${name}.`)) await data.refreshLanes();
        return;
      }
      if (action === "archive") {
        const ok = await hostConfirm({
          title: `Archive '${lane.name}'?`,
          body: "The lane's worktree is removed. The branch stays.",
          confirmLabel: "Archive",
        });
        if (!ok) return;
        if (settle(await actions.archiveLane(lane.id), `Archived ${lane.name}.`)) await data.refreshLanes();
        return;
      }
      if (action === "delete") {
        const ok = await hostConfirm({
          title: `Delete '${lane.name}'?`,
          body: "The worktree is removed. The branch is kept.",
          confirmLabel: "Delete",
          destructive: true,
        });
        if (!ok) return;
        if (settle(await actions.deleteLane(lane.id), `Deleted ${lane.name}.`)) await data.refreshLanes();
        return;
      }
      if (action === "rebase") {
        if (await runLaneRebase(lane.id, false)) {
          void toast({ level: "success", message: `Rebased ${lane.name}.` });
          await refreshAfterGit();
        }
        return;
      }
      if (action === "rebase-publish") {
        const outcome = await runRebaseAndPublishLane(lane.id, { confirmPublish: true, recursive: false });
        if (outcome.status === "skipped") {
          setErrorBanner(`Rebase + push skipped for '${lane.name}': ${outcome.message}`);
        } else {
          void toast({ level: "success", message: `Rebased & pushed ${lane.name}.` });
        }
        await refreshAfterGit();
        return;
      }
      if (action === "push") {
        if (settle(await actions.gitPush(lane.id), `Pushed ${lane.name}.`)) await refreshAfterGit();
        return;
      }
      if (action === "fetch") {
        if (settle(await actions.gitFetch(lane.id))) await refreshAfterGit();
        return;
      }
      if (action === "sync") {
        const sync = syncByLaneId[lane.id] ?? null;
        const baseRef = sync?.hasUpstream && sync.upstreamRef ? sync.upstreamRef : lane.baseRef;
        if (settle(await actions.gitSync({ laneId: lane.id, mode: "rebase", baseRef }), `Synced ${lane.name}.`)) {
          await refreshAfterGit();
        }
        return;
      }
      if (action === "reparent") {
        // ADE's own lane picker, over the guest. `ui.pickLane` is new in this
        // wave; on a host without it the compiled page's text prompt stands in,
        // which is exactly what that page did.
        const picked = await pickLane({ title: "Change parent", excludeLaneIds: [lane.id] });
        let targetId = picked;
        if (!targetId) {
          const options = lanes
            .filter((entry) => entry.id !== lane.id)
            .map((entry) => `${entry.id}:${entry.name}`)
            .join("\n");
          const typed = await requestTextInput({
            title: "Enter target lane id",
            message: options || "No candidate lanes available.",
            validate: (value) => (value ? null : "Lane id is required"),
          });
          if (!typed) return;
          targetId = typed.trim();
        }
        if (!laneById.has(targetId)) {
          setErrorBanner("Unknown target lane id.");
          return;
        }
        openReparentDialog(lane.id, targetId, [lane.id]);
        return;
      }
      if (action === "rename") {
        const name = await requestTextInput({
          title: "New lane name",
          defaultValue: lane.name,
          validate: (value) => (value ? null : "Lane name is required"),
        });
        if (!name) return;
        if (settle(await actions.renameLane(lane.id, name), `Renamed to ${name}.`)) await data.refreshLanes();
        return;
      }
      if (action === "customize") {
        const fallbackAnchor = {
          x: Math.max(24, window.innerWidth - 380),
          y: Math.max(24, window.innerHeight - 360),
        };
        const anchor = options?.appearanceAnchor ?? fallbackAnchor;
        setAppearanceEditor({
          laneId: lane.id,
          x: anchor.x,
          y: anchor.y,
          color: lane.color,
          icon: lane.icon,
          tags: [...(lane.tags ?? [])],
          newTag: "",
        });
        return;
      }
      if (action === "collapse") {
        updateGraphSnapshot((snapshot) => ({
          ...snapshot,
          collapsedLaneIds: Array.from(new Set([...snapshot.collapsedLaneIds, lane.id])),
        }));
        return;
      }
      if (action === "expand") {
        updateGraphSnapshot((snapshot) => ({
          ...snapshot,
          collapsedLaneIds: snapshot.collapsedLaneIds.filter((id) => id !== lane.id),
        }));
      }
    },
    [
      data,
      laneById,
      lanes,
      openPrCard,
      openPrCreate,
      openReparentDialog,
      prByLaneId,
      refreshAfterGit,
      requestTextInput,
      resolvePrBaseLaneId,
      runLandPr,
      runLaneRebase,
      runRebaseAndPublishLane,
      runSubmitReview,
      settle,
      syncByLaneId,
      updateGraphSnapshot,
    ],
  );

  const applyContextAction = React.useCallback(
    async (action: string) => {
      if (!contextMenu) return;
      try {
        await runLaneAction(contextMenu.laneId, action, {
          appearanceAnchor: { x: contextMenu.x + 20, y: contextMenu.y },
        });
      } finally {
        setContextMenu(null);
      }
    },
    [contextMenu, runLaneAction],
  );

  /* ── Drag to reparent ──────────────────────────────────────────────────── */

  const collapsedLaneIds = React.useMemo(
    () => new Set(activeSnapshot.collapsedLaneIds),
    [activeSnapshot.collapsedLaneIds],
  );
  const hiddenByCollapse = React.useMemo(() => {
    const hidden = new Set<string>();
    for (const laneId of collapsedLaneIds) {
      for (const id of collectDescendants(lanes, laneId)) hidden.add(id);
    }
    return hidden;
  }, [collapsedLaneIds, lanes]);

  const findDropTarget = React.useCallback(
    (node: Node<GraphNodeData>): Node<GraphNodeData> | null => {
      if (isSyntheticGraphNode(node.data)) return null;
      const candidates = nodes.filter(
        (candidate) =>
          candidate.id !== node.id
          && !isSyntheticGraphNode(candidate.data)
          && !hiddenByCollapse.has(candidate.id),
      );
      const dims = nodeDimensions(node.data.lane, node.data.activityBucket, viewMode);
      const center = { x: node.position.x + dims.width / 2, y: node.position.y + dims.height / 2 };
      for (const candidate of candidates) {
        const candidateDims = nodeDimensions(candidate.data.lane, candidate.data.activityBucket, viewMode);
        if (
          center.x >= candidate.position.x
          && center.x <= candidate.position.x + candidateDims.width
          && center.y >= candidate.position.y
          && center.y <= candidate.position.y + candidateDims.height
        ) return candidate;
      }
      return null;
    },
    [hiddenByCollapse, nodes, viewMode],
  );

  const saveNodePositions = React.useCallback(
    (nextNodes: Array<Node<GraphNodeData>>) => {
      const nodePositions: GraphLayoutSnapshot["nodePositions"] = {};
      for (const node of nextNodes) nodePositions[node.id] = { x: node.position.x, y: node.position.y };
      updateGraphSnapshot((snapshot) => ({ ...snapshot, nodePositions }));
    },
    [updateGraphSnapshot],
  );

  const clearHover = React.useCallback(() => {
    setHoveredNodeId(null);
    setHoveredEdgeId(null);
    setEdgeHover(null);
    if (nodeHoverTimerRef.current != null) {
      window.clearTimeout(nodeHoverTimerRef.current);
      nodeHoverTimerRef.current = null;
    }
    setNodeTooltip(null);
  }, []);

  /* ── Presentation helpers ──────────────────────────────────────────────── */

  const selectedLane = React.useMemo(
    () => (selectedLaneIds.length === 1 ? laneById.get(selectedLaneIds[0]!) ?? null : null),
    [laneById, selectedLaneIds],
  );
  const selectedLanePr = React.useMemo(
    () => (selectedLane ? prByLaneId.get(selectedLane.id) ?? null : null),
    [prByLaneId, selectedLane],
  );
  const selectedLaneOverlay = selectedLane ? prOverlayByLaneId.get(selectedLane.id) ?? null : null;
  const selectedLaneEnvironment = selectedLane ? environmentByLaneId[selectedLane.id] ?? null : null;
  const selectedLaneCanCreatePr = Boolean(
    selectedLane && selectedLane.laneType !== "primary" && resolvePrBaseLaneId(selectedLane, selectedLane.baseRef),
  );

  const availableTags = React.useMemo(() => {
    const tags = new Set<string>();
    for (const lane of lanes) {
      for (const tag of lane.tags ?? []) if (tag.trim()) tags.add(tag.trim());
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b)).slice(0, 14);
  }, [lanes]);

  const rootLaneOptions = React.useMemo(
    () => lanes.filter((lane) => !lane.parentLaneId).sort((a, b) => a.name.localeCompare(b.name)),
    [lanes],
  );

  const environmentLegendEntries = React.useMemo(() => {
    const compiled = environments
      .map((mapping) => ({
        env: mapping.env?.trim() ?? "",
        branch: mapping.branch?.trim() ?? "",
        color: mapping.color ?? null,
        branchRegex: globToRegExp(mapping.branch ?? ""),
      }))
      .filter((mapping) => mapping.env.length > 0 && mapping.branch.length > 0);
    return compiled
      .map((mapping) => ({
        env: mapping.env,
        branch: mapping.branch,
        color: mapping.color,
        matchCount: lanes.filter((lane) => mapping.branchRegex.test(branchNameFromRef(lane.branchRef))).length,
      }))
      .sort((a, b) => a.env.localeCompare(b.env) || a.branch.localeCompare(b.branch))
      .slice(0, 10);
  }, [environments, lanes]);

  const matchingSearchNodes = React.useMemo(() => {
    if (!filters.search.trim()) return [];
    return nodes.filter((node) => model.visibleNodeIds.has(node.id));
  }, [filters.search, model.visibleNodeIds, nodes]);

  const resetView = React.useCallback(() => {
    setShowFiltersPanel(false);
    updateGraphSnapshot(() => createSnapshot(viewMode));
    window.setTimeout(() => {
      void reactFlow.fitView({ duration: 500, padding: 0.2 });
    }, 0);
  }, [reactFlow, updateGraphSnapshot, viewMode]);

  const singleLaneActionItems = React.useMemo(() => {
    if (!selectedLane) return [];
    const isPrimary = selectedLane.laneType === "primary";
    const prIsOpen = Boolean(selectedLanePr && selectedLanePr.state === "open");
    return [
      { key: "merge-pr", label: "Merge PR", disabled: !prIsOpen || prActionBusy !== null },
      { key: "approve-pr", label: "Approve PR", disabled: !prIsOpen || prActionBusy !== null },
      { key: "request-pr-changes", label: "Request changes", disabled: !prIsOpen || prActionBusy !== null },
      { key: "rebase", label: "Rebase", disabled: !selectedLane.parentLaneId },
      { key: "rebase-publish", label: "Rebase + push", disabled: !selectedLane.parentLaneId },
      { key: "push", label: "Push", disabled: false },
      { key: "fetch", label: "Fetch", disabled: false },
      { key: "rename", label: "Rename", disabled: false },
      { key: "customize", label: "Customize appearance", disabled: false },
      { key: "archive", label: "Archive", disabled: isPrimary },
      { key: "delete", label: "Delete", disabled: isPrimary, danger: true },
    ];
  }, [prActionBusy, selectedLane, selectedLanePr]);

  const batchActionItems = React.useMemo(
    () => [
      { key: "rebase" as const, label: "Rebase" },
      { key: "rebase_publish" as const, label: "Rebase + push" },
      { key: "push" as const, label: "Push" },
      { key: "fetch" as const, label: "Fetch" },
      { key: "archive" as const, label: "Archive" },
      { key: "delete" as const, label: "Delete", danger: true },
    ],
    [],
  );

  const hoveredTooltipLane = nodeTooltip ? laneById.get(nodeTooltip.laneId) ?? null : null;
  const allNodesHidden = model.nodes.length > 0 && model.visibleNodeIds.size === 0;

  /* ── Render ────────────────────────────────────────────────────────────── */

  if (loadingTopology && lanes.length === 0) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute inset-0 h-full w-full bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] [opacity:0.3]" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl shadow-card px-4 py-3 text-sm text-muted-fg">
            <div className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
              Loading topology…
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (lanes.length === 0) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute inset-0 h-full w-full bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] [opacity:0.3]" />
        <div className="absolute inset-0 flex items-center justify-center">
          <EmptyState title="No lanes yet" description="Create lanes to see your workspace graph." />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full" data-ade-graph-view="canvas" data-ade-focused-lane={focusLaneId ?? ""}>
      <div className="absolute inset-0 h-full w-full bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] [opacity:0.3]" />

      <GraphToolbar
        viewMode={viewMode}
        onViewMode={setViewMode}
        filters={filters}
        onFilters={updateFilters}
        matchingCount={matchingSearchNodes.length}
        onFocusResults={() => {
          if (matchingSearchNodes.length === 0) return;
          void reactFlow.fitView({ nodes: matchingSearchNodes, duration: 320, padding: 0.25 });
        }}
        onResetView={resetView}
        showOverviewRiskEdges={showOverviewRiskEdges}
        onToggleOverviewRiskEdges={() => setShowOverviewRiskEdges((prev) => !prev)}
        showRiskMatrix={showRiskMatrix}
        onToggleRiskMatrix={() => {
          setShowRiskMatrix((prev) => {
            // Opening the matrix asks for the matrix, which is a narrower read
            // than the whole batch assessment behind it.
            if (!prev) void actions.getRiskMatrix().catch(() => {});
            return !prev;
          });
        }}
        rootLaneOptions={rootLaneOptions}
        availableTags={availableTags}
        overflowNote={describePluginGraphOverflow(pluginOverlay)}
        filtersPanelRef={filtersPanelRef}
        showFiltersPanel={showFiltersPanel}
        onToggleFiltersPanel={() => setShowFiltersPanel((prev) => !prev)}
      />

      <div className="absolute inset-0 pt-[74px]">
        <ReactFlow<Node<GraphNodeData>, Edge<GraphEdgeData>>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesConnectable={false}
          onNodesChange={(changes) => setNodes((prev) => applyNodeChanges(changes, prev))}
          onEdgesChange={(changes) => setEdges((prev) => applyEdgeChanges(changes, prev))}
          onNodeDragStart={(_event, node) => {
            if (isSyntheticGraphNode(node.data)) return;
            nodeDragActiveRef.current = true;
            dragOriginRef.current.set(node.id, { x: node.position.x, y: node.position.y });
            if (dropPreviewTimerRef.current != null) {
              window.clearTimeout(dropPreviewTimerRef.current);
              dropPreviewTimerRef.current = null;
            }
            setDropPreview(null);
            clearHover();
          }}
          onNodeDrag={(_event, node) => {
            if (isSyntheticGraphNode(node.data)) return;
            const target = findDropTarget(node);
            if (!target) {
              if (dropPreviewTimerRef.current != null) {
                window.clearTimeout(dropPreviewTimerRef.current);
                dropPreviewTimerRef.current = null;
              }
              setDropPreview(null);
              return;
            }
            const draggedLaneIds = selectedLaneIds.includes(node.id) && selectedLaneIds.length > 1
              ? selectedLaneIds
              : [node.id];
            const wouldCycle = draggedLaneIds.some(
              (laneId) => laneId === target.id || collectDescendants(lanes, laneId).has(target.id),
            );
            let overlapCount = 0;
            for (const laneId of draggedLaneIds) {
              if (laneId === target.id) continue;
              overlapCount = Math.max(
                overlapCount,
                (overlapFilesByPair.get(edgePairKey(laneId, target.id)) ?? []).length,
              );
            }
            const nextPreview = wouldCycle
              ? {
                draggedLaneIds,
                targetLaneId: target.id,
                tone: "blocked" as const,
                message: "Cannot change parent (cycle detected).",
                detail: "Pick a lane that is not inside the dragged lane's descendant chain.",
              }
              : {
                draggedLaneIds,
                targetLaneId: target.id,
                tone: overlapCount > 0 ? ("warn" as const) : ("safe" as const),
                message: draggedLaneIds.length === 1
                  ? `Drop '${laneById.get(draggedLaneIds[0]!)?.name ?? draggedLaneIds[0]}' onto '${target.data.lane.name}'${
                    overlapCount > 0 ? ` (⚠ ${overlapCount} overlapping files)` : ""
                  }.`
                  : `Reparent ${draggedLaneIds.length} lanes under ${target.data.lane.name}${
                    overlapCount > 0 ? ` (⚠ ${overlapCount} overlapping files)` : ""
                  }.`,
                detail: "Release to choose between integrating, reparenting, or opening a PR.",
              };
            if (dropPreviewTimerRef.current != null) window.clearTimeout(dropPreviewTimerRef.current);
            dropPreviewTimerRef.current = window.setTimeout(() => setDropPreview(nextPreview), 200);
          }}
          onNodeDragStop={(_event, node) => {
            if (isSyntheticGraphNode(node.data)) return;
            nodeDragActiveRef.current = false;
            const origin = dragOriginRef.current.get(node.id);
            if (dropPreviewTimerRef.current != null) {
              window.clearTimeout(dropPreviewTimerRef.current);
              dropPreviewTimerRef.current = null;
            }
            setDropPreview(null);
            clearHover();
            dragOriginRef.current.delete(node.id);
            const latestNodes = reactFlow.getNodes();
            saveNodePositions(
              latestNodes.map((existing) =>
                existing.id === node.id ? { ...existing, position: node.position } : existing
              ),
            );

            const target = findDropTarget(node);
            if (!target) return;
            if (origin) {
              const dx = node.position.x - origin.x;
              const dy = node.position.y - origin.y;
              if (Math.sqrt(dx * dx + dy * dy) < 5) return;
            }
            const selectedIds = selectedLaneIds.includes(node.id) && selectedLaneIds.length > 1
              ? selectedLaneIds
              : [node.id];
            if (selectedIds.length === 1 && laneById.get(target.id)?.laneType === "primary") {
              openPrCreate(node.id, target.id);
              return;
            }
            openReparentDialog(node.id, target.id, selectedIds);
          }}
          onNodeClick={(_event, node) => {
            // A plugin node selects visually and invokes; it is never a lane
            // selection, so `selectedLaneIds` — which every batch operation
            // reads — must not learn about it.
            if (node.data.pluginNode) {
              setSelectedLaneIds([]);
              setNodes((prev) => prev.map((entry) => ({ ...entry, selected: entry.id === node.id })));
              node.data.onPressPluginNode?.();
              return;
            }
            if (node.data.isVirtualProposal) {
              setSelectedLaneIds([]);
              setNodes((prev) => prev.map((entry) => ({ ...entry, selected: entry.id === node.id })));
              return;
            }
            setSelectedLaneIds([node.id]);
            setNodes((prev) => prev.map((entry) => ({ ...entry, selected: entry.id === node.id })));
            if (collapsedLaneIds.has(node.id)) {
              updateGraphSnapshot((snapshot) => ({
                ...snapshot,
                collapsedLaneIds: snapshot.collapsedLaneIds.filter((entry) => entry !== node.id),
              }));
            }
          }}
          onNodeMouseEnter={(event, node) => {
            if (nodeDragActiveRef.current) return;
            if (isSyntheticGraphNode(node.data)) {
              clearHover();
              return;
            }
            setHoveredNodeId(node.id);
            if (nodeHoverTimerRef.current != null) window.clearTimeout(nodeHoverTimerRef.current);
            nodeHoverTimerRef.current = window.setTimeout(() => {
              setNodeTooltip({ x: event.clientX + 12, y: event.clientY + 12, laneId: node.id });
            }, 400);
          }}
          onNodeMouseLeave={() => {
            if (nodeDragActiveRef.current) return;
            clearHover();
          }}
          onSelectionChange={(selection) => {
            const selected = selection.nodes.filter((node) => !isSyntheticGraphNode(node.data)).map((node) => node.id);
            setSelectedLaneIds((prev) => (sameIdSet(prev, selected) ? prev : selected));
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            if (isSyntheticGraphNode(node.data)) {
              setContextMenu(null);
              return;
            }
            setContextMenu({ laneId: node.id, x: event.clientX, y: event.clientY });
          }}
          onNodeDoubleClick={(_event, node) => {
            if (isSyntheticGraphNode(node.data)) return;
            if (collapsedLaneIds.has(node.id)) {
              updateGraphSnapshot((snapshot) => ({
                ...snapshot,
                collapsedLaneIds: snapshot.collapsedLaneIds.filter((entry) => entry !== node.id),
              }));
              return;
            }
            void openLink(laneDeeplink(node.id));
          }}
          onEdgeClick={(_event, edge) => {
            const prefix = edge.data?.edgeType ?? edge.id.split(":")[0];
            const laneAId = edge.source;
            const laneBId = edge.target;
            if (!laneAId || !laneBId) return;
            if (edge.data?.pr) {
              setEdgeSimulation(null);
              setReparentDialog(null);
              setContextMenu(null);
              const pr = prs.find((entry) => entry.id === edge.data?.pr?.prId) ?? null;
              if (pr) openPrCard(pr);
              return;
            }
            if (prefix === "risk") {
              setEdgeSimulation(null);
              setReparentDialog(null);
              setContextMenu(null);
              openConflictPanelForEdge(laneAId, laneBId);
              return;
            }
            if (prefix === "stack" || prefix === "topology") {
              setReparentDialog(null);
              setContextMenu(null);
              setEdgeSimulation({ laneAId, laneBId, loading: true, result: null, error: null });
              void actions.simulateMerge(laneAId, laneBId).then((result) => {
                setEdgeSimulation((prev) =>
                  prev && prev.laneAId === laneAId && prev.laneBId === laneBId
                    ? {
                      ...prev,
                      loading: false,
                      ...(result.ok && result.result
                        ? { result: result.result }
                        : { error: result.message ?? "Could not simulate this merge." }),
                    }
                    : prev
                );
              });
            }
          }}
          onEdgeMouseEnter={(_event, edge) => {
            if (!nodeDragActiveRef.current) setHoveredEdgeId(edge.id);
          }}
          onEdgeMouseMove={(event, edge) => {
            setHoveredEdgeId(edge.id);
            const edgeData = edge.data;
            const pr = edgeData?.pr ?? null;
            const prLines = pr
              ? [
                `PR #${pr.number} · ${pr.state} · checks: ${prChecksLabel(pr.checksStatus)} · reviews: ${pr.reviewStatus}`,
                pr.checksStatus === "not_run" ? pr.checksReason ?? NO_CI_REASON : null,
                `${pr.reviewCount} reviews · ${pr.commentCount} comments${
                  pr.behindBaseBy != null ? ` · behind ${pr.behindBaseBy}` : ""
                }`,
                pr.title ? pr.title : null,
                pr.lastActivityAt ? `activity ${toRelativeTime(pr.lastActivityAt)}` : null,
                pr.lastSyncedAt ? `synced ${toRelativeTime(pr.lastSyncedAt)}` : null,
              ].filter((line): line is string => Boolean(line && line.trim().length))
              : [];
            if (edgeData?.edgeType === "risk") {
              const overlapFiles = overlapFilesByPair.get(edgePairKey(edge.source, edge.target)) ?? [];
              const fileLines = overlapFiles.slice(0, 6).map((file) => `- ${file}`);
              const moreLine = overlapFiles.length > 6 ? `... +${overlapFiles.length - 6} more` : null;
              setEdgeHover({
                x: event.clientX + 12,
                y: event.clientY + 12,
                label: [
                  `${edgeData.riskLevel ?? "unknown"} · ${overlapFiles.length} file${
                    overlapFiles.length === 1 ? "" : "s"
                  }${edgeData.stale ? " · stale" : ""}`,
                  ...fileLines,
                  ...(moreLine ? [moreLine] : []),
                  ...(prLines.length ? ["", ...prLines] : []),
                ].join("\n"),
              });
              return;
            }
            if (edgeData?.edgeType === "stack" || edgeData?.edgeType === "topology") {
              setEdgeHover({
                x: event.clientX + 12,
                y: event.clientY + 12,
                label: [
                  `${laneById.get(edge.source)?.name ?? edge.source} → ${laneById.get(edge.target)?.name ?? edge.target}`,
                  ...(prLines.length ? ["", ...prLines] : []),
                ].join("\n"),
              });
              return;
            }
            setEdgeHover(null);
          }}
          onEdgeMouseLeave={() => {
            setEdgeHover(null);
            setHoveredEdgeId(null);
          }}
          fitView
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          multiSelectionKeyCode={["Shift"]}
          selectionOnDrag
          nodeDragThreshold={5}
          minZoom={0.25}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--color-border)" />
          <MiniMap
            pannable
            zoomable
            nodeBorderRadius={6}
            nodeStrokeWidth={2}
            nodeColor={(node) => {
              const nodeData = node.data as GraphNodeData | undefined;
              // The plugin's own accent, so the minimap tells two plugins'
              // annotations apart the same way the canvas does.
              if (nodeData?.pluginNode) return nodeData.pluginNode.identity.accent ?? "#8B8B94";
              if (nodeData?.isVirtualProposal) return "#A78BFA";
              return nodeData?.environment?.color ?? nodeData?.lane?.color ?? "var(--color-muted-fg)";
            }}
            nodeStrokeColor={(node) =>
              node.selected ? "var(--color-accent)" : "color-mix(in srgb, var(--color-border) 88%, transparent)"}
            style={{
              background: "color-mix(in srgb, var(--color-card) 92%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
              borderRadius: 14,
              boxShadow: "var(--shadow-card)",
            }}
          />
          <Panel position="bottom-left">
            <div className="flex flex-col gap-2">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-1 shadow-card">
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-xl text-fg transition-colors hover:bg-white/[0.02]"
                    title="Zoom in"
                    onClick={() => reactFlow.zoomIn({ duration: 180 })}
                  >
                    <Plus size={14} weight="bold" />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-xl text-fg transition-colors hover:bg-white/[0.02]"
                    title="Zoom out"
                    onClick={() => reactFlow.zoomOut({ duration: 180 })}
                  >
                    <Minus size={14} weight="bold" />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-xl text-fg transition-colors hover:bg-white/[0.02]"
                    title="Fit graph"
                    onClick={() => void reactFlow.fitView({ duration: 500, padding: 0.2 })}
                  >
                    <ArrowSquareOut size={14} weight="regular" />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-xl text-fg transition-colors hover:bg-white/[0.02]"
                    title="Reset view"
                    onClick={resetView}
                  >
                    <ClockCounterClockwise size={14} weight="regular" />
                  </button>
                </div>
              </div>
              {loadingRisk ? (
                <div className="rounded-xl bg-white/[0.03] backdrop-blur-xl px-2 py-1 text-[11px] text-muted-fg">
                  Loading conflict data…
                </div>
              ) : batch?.progress ? (
                <div className="rounded-xl bg-white/[0.03] backdrop-blur-xl px-2 py-1 text-[11px] text-muted-fg">
                  Computing {batch.progress.completedPairs}/{batch.progress.totalPairs} pairs…
                </div>
              ) : null}
            </div>
          </Panel>
          {dropPreview ? (
            <Panel position="top-left">
              <div
                className={cn(
                  "rounded-xl border px-2 py-1 text-[11px]",
                  dropPreview.tone === "safe" && "border-emerald-600/70 bg-emerald-900/20 text-emerald-200",
                  dropPreview.tone === "warn" && "border-amber-600/70 bg-amber-900/20 text-amber-200",
                  dropPreview.tone === "blocked" && "border-red-700/70 bg-red-900/25 text-red-200",
                )}
              >
                <div className="font-semibold">{dropPreview.message}</div>
                <div className="mt-0.5 text-[10px] opacity-85">{dropPreview.detail}</div>
              </div>
            </Panel>
          ) : null}
          <Panel position="top-right">
            <div className="flex w-[280px] flex-col gap-2 text-[11px]">
              <div className="rounded-xl bg-white/[0.03] backdrop-blur-xl p-3 shadow-card">
                <div className="mb-2 font-sans font-semibold text-fg">Environments</div>
                {environmentLegendEntries.length === 0 ? (
                  <div className="text-muted-fg">No environment mappings configured.</div>
                ) : (
                  <div className="space-y-2">
                    {environmentLegendEntries.map((entry) => (
                      <div
                        key={`${entry.env}:${entry.branch}`}
                        className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full ring-1 ring-border/30"
                            style={{ backgroundColor: entry.color ?? "var(--color-muted-fg)" }}
                          />
                          <span className="font-medium text-fg">{entry.env}</span>
                          <span className="ml-auto text-[10px] text-muted-fg">
                            {entry.matchCount} lane{entry.matchCount === 1 ? "" : "s"}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[10px] text-muted-fg">matches {entry.branch}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </ReactFlow>

        {allNodesHidden ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-[74px]">
            <div className="pointer-events-auto rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl shadow-card px-5 py-4 text-center">
              <Funnel size={24} weight="regular" className="mx-auto mb-2 text-muted-fg" />
              <div className="text-sm font-medium text-fg">No visible lanes</div>
              <div className="mt-1 text-xs text-muted-fg">All lanes are hidden by the current filters.</div>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 text-xs"
                onClick={() => updateFilters(() => buildDefaultFilter())}
              >
                Reset Filters
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {contextMenu ? (
        <div
          data-ade-graph-panel="context-menu"
          className="fixed z-[90] min-w-[190px] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-1 shadow-float"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseLeave={() => setContextMenu(null)}
        >
          {(() => {
            const lane = laneById.get(contextMenu.laneId);
            const isPrimary = lane?.laneType === "primary";
            const hasParent = Boolean(lane?.parentLaneId);
            const hasChildren = (lane?.childCount ?? 0) > 0;
            const isCollapsed = collapsedLaneIds.has(contextMenu.laneId);
            const hasPr = lane ? prByLaneId.has(lane.id) : false;
            const canCreatePr = Boolean(lane && lane.laneType !== "primary" && (lane.parentLaneId ?? primaryLaneId));
            const isRemote = context.project?.binding === "remote";
            const sections: Array<{
              title: string;
              items: Array<{ key: string; label: string; disabled?: boolean; reason?: string; danger?: boolean }>;
            }> = [
              {
                title: "Navigate",
                items: [
                  { key: "open-lane", label: "Open Lane" },
                  // A remote project has no folder on this machine to reveal, so
                  // it gets the path-copy variant — the compiled menu's own rule.
                  isRemote
                    ? { key: "copy-remote-path", label: "Copy Remote Path" }
                    : { key: "open-folder", label: "Open Folder" },
                  { key: "view-pr", label: "Open PR", disabled: !hasPr, reason: "No linked PR for this lane." },
                  {
                    key: "create-pr",
                    label: hasPr ? "Open PR Workflow" : "Create PR",
                    disabled: !canCreatePr,
                    reason: "Primary lanes cannot open PRs.",
                  },
                ],
              },
              {
                title: "Stack",
                items: [
                  { key: "create-child", label: "Create Child Lane" },
                  { key: "reparent", label: "Change Parent", disabled: isPrimary, reason: "Primary lane cannot be reparented." },
                  {
                    key: isCollapsed ? "expand" : "collapse",
                    label: isCollapsed ? "Expand Children" : "Collapse Children",
                    disabled: !isCollapsed && !hasChildren,
                    reason: "No child lanes to collapse.",
                  },
                ],
              },
              {
                title: "Sync",
                items: [
                  { key: "rebase", label: "Rebase", disabled: !hasParent, reason: "Rebase is only available for child lanes." },
                  {
                    key: "rebase-publish",
                    label: "Rebase + Push",
                    disabled: !hasParent,
                    reason: "Rebase + push is only available for child lanes.",
                  },
                  { key: "push", label: "Push" },
                  { key: "fetch", label: "Fetch" },
                  { key: "sync", label: "Pull From Upstream" },
                ],
              },
              {
                title: "Manage",
                items: [
                  { key: "rename", label: "Rename" },
                  { key: "customize", label: "Customize Appearance" },
                  { key: "archive", label: "Archive", disabled: isPrimary, reason: "Primary lane cannot be archived." },
                  {
                    key: "delete",
                    label: "Delete",
                    disabled: isPrimary,
                    reason: "Primary lane cannot be deleted.",
                    danger: true,
                  },
                ],
              },
            ];
            return sections.map((section) => (
              <div key={section.title} className="px-1 py-1">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-fg">
                  {section.title}
                </div>
                <div className="space-y-0.5">
                  {section.items.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={cn(
                        "flex w-full items-center rounded px-2 py-1 text-left text-xs",
                        item.disabled
                          ? "cursor-not-allowed text-muted-fg"
                          : item.danger
                            ? "text-red-200 hover:bg-red-900/20"
                            : "text-fg hover:bg-white/[0.04]",
                      )}
                      title={item.disabled ? item.reason : undefined}
                      onClick={() => {
                        if (item.disabled) return;
                        void applyContextAction(item.key);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ));
          })()}
        </div>
      ) : null}

      {appearanceEditor ? (
        <div
          data-ade-graph-panel="appearance"
          className="fixed z-[95] w-[340px] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-3 shadow-float"
          style={{ left: appearanceEditor.x, top: appearanceEditor.y }}
        >
          <div className="mb-2 text-xs font-sans font-semibold text-fg">Customize Appearance</div>
          <div className="mb-2 text-xs text-muted-fg">Color</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {COLOR_PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Colour ${color}`}
                className={cn(
                  "h-5 w-5 rounded-full ring-1 ring-border/30",
                  appearanceEditor.color === color && "ring-2 ring-accent",
                )}
                style={{ backgroundColor: color }}
                onClick={() => setAppearanceEditor((prev) => (prev ? { ...prev, color } : prev))}
              />
            ))}
          </div>
          <div className="mb-2 text-xs text-muted-fg">Icon</div>
          <div className="mb-3 flex flex-wrap gap-1">
            {ICON_OPTIONS.map((option) => (
              <button
                key={option.label}
                type="button"
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] px-2 text-xs",
                  appearanceEditor.icon === option.key && "bg-accent/20 ring-1 ring-accent",
                )}
                onClick={() => setAppearanceEditor((prev) => (prev ? { ...prev, icon: option.key } : prev))}
              >
                {option.icon}
                {option.label}
              </button>
            ))}
          </div>
          <div className="mb-2 text-xs text-muted-fg">Tags</div>
          <div className="mb-2 flex flex-wrap gap-1">
            {appearanceEditor.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] px-1 text-xs text-fg"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove ${tag}`}
                  className="text-muted-fg"
                  onClick={() =>
                    setAppearanceEditor((prev) =>
                      prev ? { ...prev, tags: prev.tags.filter((entry) => entry !== tag) } : prev
                    )}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="mb-3 flex items-center gap-1">
            <input
              aria-label="New tag"
              value={appearanceEditor.newTag}
              onChange={(event) => setAppearanceEditor((prev) => (prev ? { ...prev, newTag: event.target.value } : prev))}
              className="h-7 flex-1 rounded-xl border border-white/[0.08] bg-white/[0.02] px-2 text-xs outline-none"
              placeholder="new tag"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() =>
                setAppearanceEditor((prev) => {
                  if (!prev) return prev;
                  const nextTag = prev.newTag.trim();
                  if (!nextTag || prev.tags.includes(nextTag)) return prev;
                  return { ...prev, tags: [...prev.tags, nextTag], newTag: "" };
                })}
            >
              <Plus size={12} weight="regular" />
              Add
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAppearanceEditor(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                const draft = appearanceEditor;
                if (!draft) return;
                const result = await actions.updateLaneAppearance({
                  laneId: draft.laneId,
                  color: draft.color,
                  icon: draft.icon,
                  tags: draft.tags,
                });
                setAppearanceEditor(null);
                if (settle(result)) await data.refreshLanes();
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      ) : null}

      {reparentDialog ? (
        <div
          data-ade-graph-panel="reparent"
          className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4"
        >
          <div className="w-[min(780px,100%)] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-4 shadow-float">
            <div className="mb-2 text-sm font-sans font-semibold text-fg">Confirm Lane Drop</div>
            {reparentDialog.integratePlan || reparentDialog.laneIds.length === 1 ? (
              <div className="mb-2 inline-flex rounded-xl border border-white/[0.06] bg-white/[0.02] p-0.5 text-xs">
                {reparentDialog.integratePlan ? (
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1",
                      reparentDialog.actionMode === "integrate" ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg",
                    )}
                    onClick={() => setReparentDialog((prev) => (prev ? { ...prev, actionMode: "integrate" } : prev))}
                  >
                    Integrate
                  </button>
                ) : null}
                <button
                  type="button"
                  className={cn(
                    "rounded-md px-2 py-1",
                    reparentDialog.actionMode === "reparent" ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg",
                  )}
                  onClick={() => setReparentDialog((prev) => (prev ? { ...prev, actionMode: "reparent" } : prev))}
                >
                  Reparent
                </button>
                {reparentDialog.laneIds.length === 1 ? (
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-2 py-1",
                      reparentDialog.actionMode === "pr" ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg",
                    )}
                    onClick={() => setReparentDialog((prev) => (prev ? { ...prev, actionMode: "pr" } : prev))}
                  >
                    PR
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="mb-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 text-xs text-muted-fg">
              {reparentDialog.actionMode === "integrate"
                ? "Integrate keeps stack ancestry unchanged and brings source lane commits into the target lane."
                : reparentDialog.actionMode === "pr"
                  ? "PR opens the pull request workflow for the dragged lane, targeting the drop base."
                  : "Reparent changes stack ancestry. ADE rebases selected lane commits onto the target parent branch."}
            </div>
            {reparentDialog.actionMode === "integrate" && reparentDialog.integratePlan ? (
              <div className="mb-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 text-xs">
                <div className="font-sans font-semibold text-fg">{reparentDialog.integratePlan.summary}</div>
                <div className="mt-1 text-muted-fg">{reparentDialog.integratePlan.detail}</div>
              </div>
            ) : (
              <>
                <div className="mb-2 text-xs text-muted-fg">
                  Target parent:{" "}
                  <span className="text-fg">
                    {laneById.get(reparentDialog.targetLaneId)?.name ?? reparentDialog.targetLaneId}
                  </span>
                </div>
                <div className="mb-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 text-xs">
                  <div className="space-y-1">
                    {reparentDialog.laneIds.map((laneId) => (
                      <div key={laneId}>
                        {laneById.get(laneId)?.name ?? laneId} →{" "}
                        {laneById.get(reparentDialog.targetLaneId)?.name ?? reparentDialog.targetLaneId}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
            {reparentDialog.overlapFiles.length > 0 ? (
              <div className="mb-2 rounded bg-amber-900/20 p-2 text-xs text-amber-200">
                ⚠ {reparentDialog.overlapFiles.length} overlapping files detected.
              </div>
            ) : (
              <div className="mb-2 rounded bg-emerald-900/20 p-2 text-xs text-emerald-200">
                No overlapping files detected.
              </div>
            )}
            {reparentDialog.preview ? (
              <div className="mb-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 text-xs">
                <div>Preview outcome: {reparentDialog.preview.outcome}</div>
                <div>
                  files changed: {reparentDialog.preview.diffStat.filesChanged} · conflicts:{" "}
                  {reparentDialog.preview.conflictingFiles.length}
                </div>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setReparentDialog(null)}>
                Cancel
              </Button>
              {reparentDialog.actionMode !== "pr" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reparentDialog.previewBusy}
                  onClick={async () => {
                    const previewLaneAId = reparentDialog.actionMode === "integrate"
                      ? reparentDialog.integratePlan?.laneId
                      : reparentDialog.laneIds[0];
                    const previewLaneBId = reparentDialog.actionMode === "integrate"
                      ? reparentDialog.integratePlan?.sourceLaneId
                      : reparentDialog.targetLaneId;
                    if (!previewLaneAId || !previewLaneBId) return;
                    setReparentDialog((prev) => (prev ? { ...prev, previewBusy: true } : prev));
                    const result = await actions.simulateMerge(previewLaneAId, previewLaneBId);
                    setReparentDialog((prev) =>
                      prev ? { ...prev, previewBusy: false, preview: result.result ?? null } : prev
                    );
                  }}
                >
                  {reparentDialog.actionMode === "integrate" ? "Preview integrate" : "Preview rebase"}
                </Button>
              ) : null}
              <Button size="sm" variant="primary" onClick={() => void applyReparent()}>
                {reparentDialog.actionMode === "integrate"
                  ? "Confirm Integrate"
                  : reparentDialog.actionMode === "pr"
                    ? "Open PR"
                    : "Confirm Reparent"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {prCreate ? (
        <div
          data-ade-graph-panel="pr-create"
          className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4"
        >
          <div className="w-[min(720px,100%)] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-4 shadow-float">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-sans font-semibold text-fg">Create Pull Request</div>
              <button type="button" aria-label="Close" className="text-muted-fg hover:text-fg" onClick={() => setPrCreate(null)}>
                ×
              </button>
            </div>
            <div className="mb-3 text-xs text-muted-fg">
              {laneById.get(prCreate.laneId)?.name ?? prCreate.laneId} →{" "}
              {laneById.get(prCreate.baseLaneId)?.name ?? prCreate.baseLaneId} (base:{" "}
              <span className="text-fg">{prCreate.baseBranch}</span>)
            </div>
            {prCreate.error ? (
              <div className="mb-3 rounded bg-red-900/30 p-2 text-xs text-red-200">{prCreate.error}</div>
            ) : null}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <input
                aria-label="PR title"
                className="h-9 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 text-sm md:col-span-2"
                placeholder="PR title"
                value={prCreate.title}
                onChange={(e) => setPrCreate((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
              />
              <label className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 text-xs text-muted-fg">
                <input
                  type="checkbox"
                  checked={prCreate.draft}
                  onChange={(e) => setPrCreate((prev) => (prev ? { ...prev, draft: e.target.checked } : prev))}
                />
                Draft PR
              </label>
            </div>
            <textarea
              aria-label="PR description"
              className="mt-2 min-h-[200px] w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs"
              value={prCreate.body}
              onChange={(e) => setPrCreate((prev) => (prev ? { ...prev, body: e.target.value } : prev))}
              placeholder="PR description (markdown)"
            />
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPrCreate(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={prCreate.creating || !prCreate.title.trim() || !prCreate.body.trim()}
                onClick={async () => {
                  const draft = prCreate;
                  setPrCreate((prev) => (prev ? { ...prev, creating: true, error: null } : prev));
                  const result = await actions.createPr({
                    laneId: draft.laneId,
                    title: draft.title,
                    body: draft.body,
                    draft: draft.draft,
                    baseBranch: draft.baseBranch,
                  });
                  if (!result.ok) {
                    setPrCreate((prev) =>
                      prev ? { ...prev, creating: false, error: result.message ?? "Could not open the PR." } : prev
                    );
                    return;
                  }
                  setPrCreate(null);
                  void toast({ level: "success", message: "Opened the pull request." });
                  await data.refreshPrs();
                }}
              >
                {prCreate.creating ? "Creating…" : "Create PR"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {prCard ? (
        <PrCard
          pr={prCard.pr}
          detail={prCard.detail}
          loading={prCard.loading}
          busy={prActionBusy}
          error={prCard.error}
          mergeMethod={prCard.mergeMethod}
          onMergeMethodChange={(method) => setPrCard((prev) => (prev ? { ...prev, mergeMethod: method } : prev))}
          onSubmitReview={(event) => void runSubmitReview(prCard.pr, event)}
          onLand={() => void runLandPr(prCard.pr, prCard.mergeMethod)}
          onRefresh={() => openPrCard(prCard.pr)}
          onOpenLink={(url) => void openLink(url)}
          onClose={() => setPrCard(null)}
        />
      ) : null}

      {selectedLane ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[60] flex justify-center">
          <div
            data-ade-graph-panel="selected-lane"
            className="pointer-events-auto w-[min(1120px,calc(100%-24px))] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl px-3 py-2 shadow-float"
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-sans font-semibold text-fg">{selectedLane.name}</div>
                <div className="mt-1 truncate text-[11px] text-muted-fg">{selectedLane.branchRef}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                  <Chip className={cn("px-1.5 py-0", selectedLane.status.dirty ? "text-amber-300" : "text-emerald-300")}>
                    {selectedLane.status.dirty ? "Dirty" : "Clean"}
                  </Chip>
                  {selectedLaneOverlay ? (
                    <Chip className="px-1.5 py-0 text-sky-300" title={selectedLaneOverlay.title}>
                      PR #{selectedLaneOverlay.number}
                    </Chip>
                  ) : (
                    <Chip className="px-1.5 py-0 text-muted-fg">No PR</Chip>
                  )}
                  {selectedLaneEnvironment ? (
                    <Chip
                      className="px-1.5 py-0"
                      style={{ color: selectedLaneEnvironment.color ?? "var(--color-muted-fg)" }}
                    >
                      {selectedLaneEnvironment.env}
                    </Chip>
                  ) : null}
                  <span className="text-muted-fg">
                    activity {toRelativeTime(lastActivityByLaneId[selectedLane.id] ?? null)}
                  </span>
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => void openLink(laneDeeplink(selectedLane.id))}
                >
                  Open Lane
                </Button>
                <Button
                  size="sm"
                  variant={selectedLanePr ? "primary" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  disabled={!selectedLanePr && !selectedLaneCanCreatePr}
                  onClick={() => {
                    if (selectedLanePr) {
                      openPrCard(selectedLanePr);
                      return;
                    }
                    const baseLaneId = resolvePrBaseLaneId(selectedLane, selectedLane.baseRef);
                    if (baseLaneId) openPrCreate(selectedLane.id, baseLaneId);
                  }}
                >
                  <ChatText size={12} weight="bold" />
                  {selectedLanePr ? "Open PR" : "Create PR"}
                </Button>
                <div className="relative" ref={singleActionsRef}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setSingleActionsOpen((prev) => !prev)}
                  >
                    More Actions
                    <CaretDown size={12} weight="bold" />
                  </Button>
                  {singleActionsOpen ? (
                    <div className="absolute bottom-9 right-0 z-[70] w-[220px] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-1 text-xs shadow-float">
                      {singleLaneActionItems.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          className={cn(
                            "flex w-full items-center rounded px-2 py-1.5 text-left",
                            item.disabled
                              ? "cursor-not-allowed text-muted-fg"
                              : item.danger
                                ? "text-red-200 hover:bg-red-900/20"
                                : "text-fg hover:bg-white/[0.04]",
                          )}
                          disabled={item.disabled}
                          onClick={() => {
                            setSingleActionsOpen(false);
                            void runLaneAction(selectedLane.id, item.key);
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {selectedLaneIds.length > 1 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[60] flex justify-center">
          <div
            data-ade-graph-panel="batch"
            className="pointer-events-auto rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl px-3 py-2 shadow-float"
          >
            <div className="mb-1 text-[11px] text-muted-fg">{selectedLaneIds.length} lanes selected</div>
            <div className="flex flex-wrap items-center gap-1">
              <div className="relative" ref={batchActionsRef}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setBatchActionsOpen((prev) => !prev)}
                >
                  Batch Actions
                  <CaretDown size={12} weight="bold" />
                </Button>
                {batchActionsOpen ? (
                  <div className="absolute bottom-9 right-0 z-[70] w-[200px] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-1 text-xs shadow-float">
                    {batchActionItems.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={cn(
                          "flex w-full items-center rounded px-2 py-1.5 text-left",
                          item.danger ? "text-red-200 hover:bg-red-900/20" : "text-fg hover:bg-white/[0.04]",
                        )}
                        onClick={() => {
                          setBatchActionsOpen(false);
                          void runBatchOperation(item.key);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => setSelectedLaneIds([])}
              >
                Clear Selection
              </Button>
            </div>
            {batchStatus ? (
              <div className="mt-2 text-[11px]">
                <div className="mb-1 text-muted-fg">
                  {batchOperationLabel(batchStatus.operation)} lane{" "}
                  {Math.min(batchStatus.steps.length, batchStatus.activeIndex + 1)}/{batchStatus.steps.length}:{" "}
                  {batchStatus.steps[batchStatus.activeIndex]?.laneName ?? "pending"}
                </div>
                <div className="mb-1 h-1.5 w-full rounded-md bg-white/[0.06]">
                  <div
                    className="h-1.5 rounded bg-accent transition-all"
                    style={{
                      width: `${
                        (batchStatus.steps.filter((step) =>
                          step.status === "done" || step.status === "failed" || step.status === "skipped"
                        ).length / Math.max(1, batchStatus.steps.length)) * 100
                      }%`,
                    }}
                  />
                </div>
                <div className="max-h-[90px] overflow-auto rounded-xl border border-white/[0.06] bg-white/[0.02] p-1">
                  {batchStatus.steps.map((step) => (
                    <div key={step.laneId} className="flex items-center justify-between gap-2">
                      <span className="truncate">{step.laneName}</span>
                      <span className="text-right text-muted-fg">
                        {step.status === "running"
                          ? "⟳ running"
                          : step.status === "done"
                            ? "✓ done"
                            : step.status === "failed"
                              ? "✗ failed"
                              : step.status === "skipped"
                                ? "⚠ skipped"
                                : "⏳ pending"}
                        {step.error ? ` · ${step.error}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
                {batchStatus.summary ? <div className="mt-1 text-muted-fg">{batchStatus.summary}</div> : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {batch?.truncated ? (
        <div className="absolute left-3 right-3 top-[82px] z-[84] rounded bg-amber-900/25 px-3 py-2 text-xs text-amber-100">
          <div className="flex items-center justify-between gap-2">
            <div>
              Too many lanes for automatic risk assessment. Showing{" "}
              {batch.comparedLaneIds?.length ?? batch.maxAutoLanes ?? 15} of {batch.totalLanes ?? lanes.length} lanes.
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setShowFiltersPanel(true)}
            >
              Filter Lanes
            </Button>
          </div>
        </div>
      ) : null}

      {errorBanner ? (
        <div
          data-ade-graph-panel="error"
          className={cn(
            "absolute left-3 right-3 z-[85] rounded bg-red-900/35 px-3 py-2 text-xs text-red-100",
            batch?.truncated ? "top-[128px]" : "top-[82px]",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5">
              <Warning size={14} weight="regular" />
              {errorBanner}
            </div>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setErrorBanner(null);
                  data.setError(null);
                  void data.refreshRiskBatch();
                }}
              >
                Retry
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setErrorBanner(null);
                  data.setError(null);
                }}
              >
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {undoToast ? (
        <div className="absolute bottom-3 right-3 z-[90] rounded bg-white/[0.03] backdrop-blur-xl px-3 py-2 text-xs shadow-float">
          <div className="mb-1">{undoToast.message}</div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setUndoToast(null)}>
              Close
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="h-6 px-2 text-[11px]"
              disabled={undoPending}
              onClick={() => {
                if (undoPending) return;
                setUndoPending(true);
                void undoToast
                  .undoAction()
                  .catch((err) => setErrorBanner(errorText(err, "Could not undo that.")))
                  .finally(() => {
                    setUndoPending(false);
                    setUndoToast(null);
                  });
              }}
            >
              {undoPending ? "Undoing" : "Undo"}
            </Button>
          </div>
        </div>
      ) : null}

      {edgeSimulation ? (
        <div
          data-ade-graph-panel="merge-simulation"
          className="absolute right-3 top-[82px] z-[89] w-[360px] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-3 text-xs shadow-float"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="font-sans font-semibold text-fg">Merge Simulation</div>
            <button type="button" aria-label="Close" className="text-muted-fg hover:text-fg" onClick={() => setEdgeSimulation(null)}>
              ×
            </button>
          </div>
          <div className="mb-2 text-muted-fg">
            {laneById.get(edgeSimulation.laneAId)?.name ?? edgeSimulation.laneAId} →{" "}
            {laneById.get(edgeSimulation.laneBId)?.name ?? edgeSimulation.laneBId}
          </div>
          {edgeSimulation.loading ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-muted-fg">
              <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
              <div>Running merge simulation…</div>
            </div>
          ) : edgeSimulation.error ? (
            <div className="rounded-md bg-red-900/30 p-2 text-red-200">
              <div className="font-medium">Simulation failed</div>
              <div className="mt-1 font-mono text-[11px]">{edgeSimulation.error}</div>
            </div>
          ) : edgeSimulation.result ? (
            <div className="space-y-2">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
                <div>
                  Outcome: <span className="font-sans font-semibold text-fg">{edgeSimulation.result.outcome}</span>
                </div>
                <div className="text-muted-fg">
                  files changed: {edgeSimulation.result.diffStat.filesChanged} · insertions:{" "}
                  {edgeSimulation.result.diffStat.insertions} · deletions: {edgeSimulation.result.diffStat.deletions}
                </div>
              </div>
              <div className="max-h-[180px] overflow-auto rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
                {edgeSimulation.result.conflictingFiles.length === 0 ? (
                  <div className="text-muted-fg">No conflicting files.</div>
                ) : (
                  edgeSimulation.result.conflictingFiles.map((file) => (
                    <div key={file.path} className="truncate text-[11px] text-fg" title={file.path}>
                      {file.path}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {conflictPanel ? (
        <ConflictPanel
          conflictPanel={conflictPanel}
          setConflictPanel={setConflictPanel}
          laneById={laneById}
          overlapFilesByPair={overlapFilesByPair}
          refreshRiskBatch={data.refreshRiskBatch}
          refreshLanes={data.refreshLanes}
        />
      ) : null}

      {showRiskMatrix ? (
        <div
          data-ade-graph-panel="risk-matrix"
          className="absolute bottom-3 left-3 z-[88] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-3 shadow-float"
          style={{ right: conflictPanel ? 450 : 12 }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-sans font-semibold text-fg">Pair Matrix</div>
              <div className="text-[11px] text-muted-fg">
                Pairwise overlap and conflict risk across {lanes.length} lane{lanes.length === 1 ? "" : "s"}.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => void data.refreshRiskBatch()}
              >
                Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => setShowRiskMatrix(false)}
              >
                Close
              </Button>
            </div>
          </div>
          <div className="max-h-[340px] overflow-auto">
            <RiskMatrix
              lanes={lanes}
              entries={batch?.matrix ?? []}
              overlaps={batch?.overlaps ?? []}
              selectedPair={conflictPanel ? { laneAId: conflictPanel.laneAId, laneBId: conflictPanel.laneBId } : null}
              loading={loadingRisk}
              progress={batch?.progress ?? null}
              onSelectPair={(pair) => openConflictPanelForEdge(pair.laneAId, pair.laneBId)}
            />
          </div>
        </div>
      ) : null}

      {nodeTooltip && hoveredTooltipLane ? (
        <div
          className="pointer-events-none fixed z-[92] min-w-[240px] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl px-2.5 py-2 text-[11px] shadow-float ade-tooltip-motion ade-tooltip-open"
          style={{ left: nodeTooltip.x, top: nodeTooltip.y }}
        >
          <div className="font-sans font-semibold text-fg">{hoveredTooltipLane.name}</div>
          <div className="truncate text-muted-fg">{hoveredTooltipLane.branchRef}</div>
          <div className="mt-1 text-muted-fg">dirty changes: {hoveredTooltipLane.status.dirty ? "yes" : "no"}</div>
          <div className="text-muted-fg">
            last activity: {toRelativeTime(lastActivityByLaneId[hoveredTooltipLane.id] ?? null)}
          </div>
        </div>
      ) : null}

      {textPrompt ? (
        <div
          data-ade-graph-panel="prompt"
          className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4"
        >
          <div className="w-[min(460px,100%)] rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-4 shadow-float">
            <div className="text-sm font-sans font-semibold text-fg">{textPrompt.title}</div>
            {textPrompt.message ? (
              <div className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[11px] text-muted-fg">
                {textPrompt.message}
              </div>
            ) : null}
            <input
              autoFocus
              aria-label={textPrompt.title}
              value={textPrompt.value}
              onChange={(event) => {
                const nextValue = event.target.value;
                setTextPrompt((prev) => (prev ? { ...prev, value: nextValue } : prev));
                if (textPromptError) setTextPromptError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelTextPrompt();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  submitTextPrompt();
                }
              }}
              placeholder={textPrompt.placeholder}
              className="mt-3 h-9 w-full rounded-xl border border-white/[0.08] bg-white/[0.02] px-2 text-sm outline-none focus:ring-1 focus:ring-accent"
            />
            {textPromptError ? <div className="mt-2 text-xs text-red-300">{textPromptError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={cancelTextPrompt}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={submitTextPrompt}>
                {textPrompt.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {edgeHover ? (
        <div
          className="pointer-events-none fixed z-[91] max-w-[420px] whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl px-2 py-1 text-[11px] text-fg shadow-float"
          style={{ left: edgeHover.x, top: edgeHover.y }}
        >
          {edgeHover.label}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The phone sheet's list, over the same reads.
 *
 * A separate component only so React Flow's provider is never mounted on this
 * route — the whole reason the phone path exists.
 */
function GraphPhone({ context: _context }: { context: PluginWebviewContext }): React.ReactElement {
  const data = useGraphData(true);
  const statusByLane = React.useMemo(() => {
    const map = new Map<string, GraphNodeData["status"]>();
    for (const entry of data.batch?.lanes ?? []) map.set(entry.laneId, entry.status);
    return map;
  }, [data.batch]);

  const prOverlayByLaneId = React.useMemo(() => {
    const map = new Map<string, GraphPrOverlay>();
    const laneById = new Map(data.lanes.map((lane) => [lane.id, lane] as const));
    for (const pr of data.prs) {
      const lane = laneById.get(pr.laneId);
      if (!lane) continue;
      map.set(pr.laneId, buildGraphPrOverlay({ pr, baseLaneId: lane.parentLaneId ?? "", mergeInProgress: false }));
    }
    return map;
  }, [data.lanes, data.prs]);

  const lastActivityByLaneId = React.useMemo(() => {
    const latest: Record<string, number> = {};
    for (const operation of data.operations) {
      if (!operation.laneId) continue;
      const startedAt = Date.parse(operation.startedAt);
      if (Number.isNaN(startedAt)) continue;
      latest[operation.laneId] = Math.max(latest[operation.laneId] ?? 0, startedAt);
    }
    const asIso: Record<string, string> = {};
    for (const [laneId, ts] of Object.entries(latest)) asIso[laneId] = new Date(ts).toISOString();
    return asIso;
  }, [data.operations]);

  const rows = React.useMemo(
    () =>
      buildPhoneRows(
        data.lanes.filter((lane) => !lane.archivedAt),
        (lane) => ({
          status: statusByLane.get(lane.id) ?? "unknown",
          remoteSync: data.syncByLaneId[lane.id] ?? null,
          autoRebase: data.autoRebaseByLaneId[lane.id] ?? null,
          pr: prOverlayByLaneId.get(lane.id) ?? null,
          lastActivityAt: lastActivityByLaneId[lane.id] ?? null,
        }),
      ),
    [data.autoRebaseByLaneId, data.lanes, data.syncByLaneId, lastActivityByLaneId, prOverlayByLaneId, statusByLane],
  );

  return <LanePhoneList rows={rows} onOpenLane={(laneId) => void openLink(laneDeeplink(laneId))} />;
}

export function WorkspaceGraph({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const [phone, setPhone] = React.useState(() =>
    isPhoneSheet(context.placement, typeof window === "undefined" ? 1024 : window.innerWidth)
  );

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setPhone(isPhoneSheet(context.placement, window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [context.placement]);

  if (phone) return <GraphPhone context={context} />;

  return (
    <div className="h-full">
      <ReactFlowProvider>
        <GraphInner context={context} />
      </ReactFlowProvider>
    </div>
  );
}
