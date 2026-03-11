// @refresh reset — GraphInner has 100+ hooks; force clean remount on HMR.
import "@xyflow/react/dist/style.css";
import React from "react";
import {
  Background,
  BackgroundVariant,
  Edge,
  MarkerType,
  MiniMap,
  Node,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow
} from "@xyflow/react";
import {
  Warning,
  ArrowSquareOut,
  Funnel,
  Plus,
  MagnifyingGlass,
  CheckCircle,
  ClockCounterClockwise,
  ChatText,
  CaretDown,
  Minus,
} from "@phosphor-icons/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  BatchAssessmentResult,
  ConflictStatus,
  EnvironmentMapping,
  GraphLayoutSnapshot,
  GraphStatusFilter,
  GraphViewMode,
  GitSyncMode,
  GitUpstreamSyncStatus,
  AutoRebaseLaneStatus,
  LaneIcon,
  LaneSummary,
  MergeMethod,
  MergeSimulationResult,
  PrCheck,
  PrComment,
  PrReview,
  PrStatus,
  PrWithConflicts,
  IntegrationProposal
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import {
  buildIntegrationSourcesByLaneId,
  isIntegrationLaneFromMetadata,
} from "../../lib/integrationLanes";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { RiskMatrix } from "./shared/RiskMatrix";
import type {
  GraphNodeData,
  GraphEdgeData,
  GraphPrOverlay,
  BatchStep,
  BatchProgress,
  GraphTextPromptState,
  PrDialogState,
  ConflictPanelState,
  IntegrationDialogState,
  RebasePublishOutcome
} from "./graphTypes";
import {
  VIEW_MODES,
  VIEW_MODE_META,
  ICON_OPTIONS,
  COLOR_PALETTE,
  activeGraphFilterCount,
  batchOperationLabel,
  edgePairKey,
  proposalSourceLaneIds,
  proposalSteps,
  proposalLaneSummaries,
  proposalPairwiseResults,
  laneSummaryConflictsWith,
  sameIdSet,
  toRelativeTime,
  laneStatusGroup,
  nodeDimensions,
  branchNameFromRef,
  globToRegExp,
  collectDescendants
} from "./graphHelpers";
import {
  buildDefaultFilter,
  createSnapshot,
  createGraphPreferences,
  createSessionState,
  normalizeGraphPreferences,
  computeAutoLayout
} from "./graphLayout";
import { GraphLaneNode } from "./graphNodes/LaneNode";
import { GraphProposalNode } from "./graphNodes/ProposalNode";
import { ConflictPanel as GraphConflictPanel } from "./graphDialogs/ConflictPanel";
import { RiskEdge } from "./graphEdges/RiskEdge";
import { ConfirmDialog, useConfirmDialog } from "../shared/InlineDialogs";
import { PrDetailPane } from "../prs/detail/PrDetailPane";
import { buildGraphPrOverlay } from "./graphPrData";
import { getPrChecksBadge, getPrReviewsBadge, InlinePrBadge } from "../prs/shared/prVisuals";

const nodeTypes = { lane: GraphLaneNode, proposal: GraphProposalNode };
const edgeTypes = { custom: RiskEdge };
const MERGE_SUCCESS_ANIMATION_MS = 1200;

function GraphInner() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const reactFlow = useReactFlow<Node<GraphNodeData>, Edge<GraphEdgeData>>();
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const lanesKey = React.useMemo(() => lanes.map((l) => l.id).join(","), [lanes]);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [environmentMappings, setEnvironmentMappings] = React.useState<EnvironmentMapping[]>([]);
  const [prs, setPrs] = React.useState<PrWithConflicts[]>([]);
  const [prInsightById, setPrInsightById] = React.useState<Record<string, {
    status: PrStatus | null;
    checks: PrCheck[];
    reviews: PrReview[];
    comments: PrComment[];
    lastActivityAt: string | null;
  }>>({});
  const [syncByLaneId, setSyncByLaneId] = React.useState<Record<string, GitUpstreamSyncStatus | null>>({});
  const [autoRebaseByLaneId, setAutoRebaseByLaneId] = React.useState<Record<string, AutoRebaseLaneStatus | null>>({});
  const syncRefreshInFlightRef = React.useRef(false);
  const syncRefreshQueuedRef = React.useRef(false);
  const autoRebaseRefreshInFlightRef = React.useRef(false);
  const autoRebaseRefreshQueuedRef = React.useRef(false);
  const activityRefreshInFlightRef = React.useRef(false);
  const activityRefreshQueuedRef = React.useRef(false);
  const activityRefreshTimerRef = React.useRef<number | null>(null);
  const graphConfirm = useConfirmDialog();
  const lanesRef = React.useRef(lanes);

  React.useEffect(() => {
    lanesRef.current = lanes;
  }, [lanes]);

  const reportGraphIssue = React.useCallback((message: string, error?: unknown) => {
    if (error) console.warn(`[Graph] ${message}`, error);
    setErrorBanner((prev) => prev ?? message);
  }, []);

  const refreshEnvironmentMappings = React.useCallback(async () => {
    try {
      const snapshot = await window.ade.projectConfig.get();
      setEnvironmentMappings(snapshot.effective.environments ?? []);
    } catch {
      setEnvironmentMappings([]);
    }
  }, []);

  const refreshPrs = React.useCallback(async () => {
    const next = await window.ade.prs.listWithConflicts();
    setPrs(next);
  }, []);

  const refreshLaneSyncStatuses = React.useCallback(async () => {
    if (syncRefreshInFlightRef.current) {
      syncRefreshQueuedRef.current = true;
      return;
    }
    syncRefreshInFlightRef.current = true;
    try {
      const laneList = lanesRef.current;
      if (laneList.length === 0) {
        setSyncByLaneId({});
        return;
      }
      const next: Record<string, GitUpstreamSyncStatus | null> = {};
      const chunkSize = 4;
      for (let i = 0; i < laneList.length; i += chunkSize) {
        const chunk = laneList.slice(i, i + chunkSize);
        const results = await Promise.all(
          chunk.map(async (lane) => {
            try {
              const status = await window.ade.git.getSyncStatus({ laneId: lane.id });
              return [lane.id, status] as const;
            } catch {
              return [lane.id, null] as const;
            }
          })
        );
        for (const [laneId, status] of results) {
          next[laneId] = status;
        }
      }
      setSyncByLaneId(next);
    } finally {
      syncRefreshInFlightRef.current = false;
      if (syncRefreshQueuedRef.current) {
        syncRefreshQueuedRef.current = false;
        void refreshLaneSyncStatuses();
      }
    }
  }, []);

  const refreshAutoRebaseStatuses = React.useCallback(async () => {
    if (autoRebaseRefreshInFlightRef.current) {
      autoRebaseRefreshQueuedRef.current = true;
      return;
    }
    autoRebaseRefreshInFlightRef.current = true;
    try {
      const laneList = lanesRef.current;
      if (laneList.length === 0) {
        setAutoRebaseByLaneId({});
        return;
      }
      try {
        const statuses = await window.ade.lanes.listAutoRebaseStatuses();
        const next: Record<string, AutoRebaseLaneStatus | null> = {};
        for (const lane of laneList) next[lane.id] = null;
        for (const status of statuses) next[status.laneId] = status;
        setAutoRebaseByLaneId(next);
      } catch {
        setAutoRebaseByLaneId({});
      }
    } finally {
      autoRebaseRefreshInFlightRef.current = false;
      if (autoRebaseRefreshQueuedRef.current) {
        autoRebaseRefreshQueuedRef.current = false;
        void refreshAutoRebaseStatuses();
      }
    }
  }, []);

  const [viewMode, setViewMode] = React.useState<GraphViewMode>("all");
  const [sessionState, setSessionState] = React.useState(createSessionState);
  const [loadedGraphPreferences, setLoadedGraphPreferences] = React.useState(false);
  const [nodes, setNodes] = React.useState<Array<Node<GraphNodeData>>>([]);
  const [edges, setEdges] = React.useState<Array<Edge<GraphEdgeData>>>([]);
  const [batch, setBatch] = React.useState<BatchAssessmentResult | null>(null);
  const [batchProgress, setBatchProgress] = React.useState<BatchProgress | null>(null);
  const [loadingTopology, setLoadingTopology] = React.useState(true);
  const [loadingRisk, setLoadingRisk] = React.useState(true);
  const [errorBanner, setErrorBanner] = React.useState<string | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{ laneId: string; x: number; y: number } | null>(null);
  const [selectedLaneIds, setSelectedLaneIds] = React.useState<string[]>([]);
  const [batchStatus, setBatchStatus] = React.useState<{
    operation: string;
    steps: BatchStep[];
    activeIndex: number;
    summary: string | null;
  } | null>(null);
  const [appearanceEditor, setAppearanceEditor] = React.useState<{
    laneId: string;
    x: number;
    y: number;
    color: string | null;
    icon: LaneIcon;
    tags: string[];
    newTag: string;
  } | null>(null);
  const [reparentDialog, setReparentDialog] = React.useState<{
    laneIds: string[];
    targetLaneId: string;
    overlapFiles: string[];
    preview: MergeSimulationResult | null;
    previewBusy: boolean;
    actionMode: "integrate" | "reparent" | "pr";
    integratePlan: {
      sourceLaneId: string;
      laneId: string;
      baseRef: string;
      mode: GitSyncMode;
      summary: string;
      detail: string;
    } | null;
  } | null>(null);
  const [undoToast, setUndoToast] = React.useState<{
    message: string;
    undoAction: () => Promise<void>;
  } | null>(null);
  const [activityScoreByLaneId, setActivityScoreByLaneId] = React.useState<Record<string, number>>({});
  const [activeSessionsByLaneId, setActiveSessionsByLaneId] = React.useState<Record<string, number>>({});
  const [lastActivityByLaneId, setLastActivityByLaneId] = React.useState<Record<string, string>>({});
  const [mergeInProgressByLaneId, setMergeInProgressByLaneId] = React.useState<Record<string, boolean>>({});
  const [mergeDisappearingAtByLaneId, setMergeDisappearingAtByLaneId] = React.useState<Record<string, number>>({});
  const [prDialog, setPrDialog] = React.useState<PrDialogState | null>(null);
  const [graphPrActionBusy, setGraphPrActionBusy] = React.useState<string | null>(null);
  const [conflictPanel, setConflictPanel] = React.useState<ConflictPanelState | null>(null);
  const [showRiskMatrix, setShowRiskMatrix] = React.useState(false);
  const [integrationDialog, setIntegrationDialog] = React.useState<IntegrationDialogState | null>(null);
  const [integrationProposals, setIntegrationProposals] = React.useState<IntegrationProposal[]>([]);
  const [focusLaneId, setFocusLaneId] = React.useState<string | null>(null);
  const [edgeHover, setEdgeHover] = React.useState<{ x: number; y: number; label: string } | null>(null);
  const [dragTrail, setDragTrail] = React.useState<{ laneId: string; from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const [dropPreview, setDropPreview] = React.useState<{
    draggedLaneIds: string[];
    targetLaneId: string;
    tone: "safe" | "warn" | "blocked";
    message: string;
    detail: string;
  } | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = React.useState<string | null>(null);
  const [edgeSimulation, setEdgeSimulation] = React.useState<{
    laneAId: string;
    laneBId: string;
    loading: boolean;
    result: MergeSimulationResult | null;
    error: string | null;
  } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = React.useState<string | null>(null);
  const [nodeTooltip, setNodeTooltip] = React.useState<{ x: number; y: number; laneId: string } | null>(null);
  const [nodeTooltipPack, setNodeTooltipPack] = React.useState<{
    deterministicUpdatedAt: string;
    narrativeUpdatedAt: string | null;
  } | null>(null);
  const [rebaseFailedLaneId, setRebaseFailedLaneId] = React.useState<string | null>(null);
  const [rebaseFailedPulse, setRebaseFailedPulse] = React.useState(false);
  const [textPrompt, setTextPrompt] = React.useState<GraphTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = React.useState<string | null>(null);
  const [singleActionsOpen, setSingleActionsOpen] = React.useState(false);
  const [batchActionsOpen, setBatchActionsOpen] = React.useState(false);

  React.useEffect(() => {
    void refreshEnvironmentMappings();
  }, [project?.rootPath, refreshEnvironmentMappings]);

  const riskRefreshTimerRef = React.useRef<number | null>(null);
  const dragOriginRef = React.useRef<Map<string, { x: number; y: number }>>(new Map());
  const dropPreviewTimerRef = React.useRef<number | null>(null);
  const nodeHoverTimerRef = React.useRef<number | null>(null);
  const lastFitViewKeyRef = React.useRef<string>("");
  const nodeDragActiveRef = React.useRef(false);
  const filtersPanelRef = React.useRef<HTMLDivElement | null>(null);
  const singleActionsRef = React.useRef<HTMLDivElement | null>(null);
  const batchActionsRef = React.useRef<HTMLDivElement | null>(null);
  const [showFiltersPanel, setShowFiltersPanel] = React.useState(false);

  const activeSnapshot = React.useMemo(
    () => sessionState[viewMode] ?? createSnapshot(viewMode),
    [sessionState, viewMode]
  );
  const filters = activeSnapshot.filters ?? buildDefaultFilter();

  const environmentByLaneId = React.useMemo(() => {
    const compiled = environmentMappings
      .map((mapping) => ({
        ...mapping,
        branchRegex: globToRegExp(mapping.branch)
      }))
      .filter((mapping) => mapping.branch.trim().length && mapping.env.trim().length);

    const out: Record<string, { env: string; color: string | null }> = {};
    for (const lane of lanes) {
      const branch = branchNameFromRef(lane.branchRef);
      const match = compiled.find((mapping) => mapping.branchRegex.test(branch));
      if (!match) continue;
      out[lane.id] = { env: match.env, color: match.color ?? null };
    }
    return out;
  }, [environmentMappings, lanes]);

  const requestTextInput = React.useCallback(
    (args: {
      title: string;
      message?: string;
      defaultValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      validate?: (value: string) => string | null;
    }): Promise<string | null> => {
      return new Promise((resolve) => {
        setTextPromptError(null);
        setTextPrompt({
          title: args.title,
          message: args.message,
          placeholder: args.placeholder,
          value: args.defaultValue ?? "",
          confirmLabel: args.confirmLabel ?? "Confirm",
          validate: args.validate,
          resolve
        });
      });
    },
    []
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

  const statusByLane = React.useMemo(() => {
    const map = new Map<string, ConflictStatus["status"]>();
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
        stale: entry.stale
      });
    }
    return map;
  }, [batch]);

  const overlapFilesByPair = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const overlap of batch?.overlaps ?? []) {
      map.set(edgePairKey(overlap.laneAId, overlap.laneBId), overlap.files);
    }
    return map;
  }, [batch]);

  const collapsedLaneIds = React.useMemo(() => new Set(activeSnapshot.collapsedLaneIds), [activeSnapshot.collapsedLaneIds]);

  const hiddenByCollapse = React.useMemo(() => {
    const hidden = new Set<string>();
    for (const laneId of collapsedLaneIds) {
      const descendants = collectDescendants(lanes, laneId);
      for (const id of descendants) hidden.add(id);
    }
    return hidden;
  }, [collapsedLaneIds, lanes]);

  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane] as const)), [lanes]);
  const primaryLaneId = React.useMemo(() => lanes.find((lane) => lane.laneType === "primary")?.id ?? null, [lanes]);
  const laneIdByBranchRef = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      const rawRef = lane.branchRef;
      const normalized = branchNameFromRef(lane.branchRef);
      map.set(rawRef, lane.id);
      map.set(normalized, lane.id);
      map.set(`refs/heads/${normalized}`, lane.id);
    }
    return map;
  }, [lanes]);
  const prByLaneId = React.useMemo(() => new Map(prs.map((pr) => [pr.laneId, pr] as const)), [prs]);
  const resolvePrBaseLaneId = React.useCallback((lane: LaneSummary, baseBranch: string) => {
    return laneIdByBranchRef.get(baseBranch) ?? laneIdByBranchRef.get(branchNameFromRef(baseBranch)) ?? lane.parentLaneId ?? primaryLaneId;
  }, [laneIdByBranchRef, primaryLaneId]);
  React.useEffect(() => {
    let cancelled = false;

    if (prs.length === 0) {
      setPrInsightById({});
      return;
    }

    const loadInsights = async () => {
      const next: Record<string, { status: PrStatus | null; checks: PrCheck[]; reviews: PrReview[]; comments: PrComment[]; lastActivityAt: string | null }> = {};
      const chunkSize = 4;
      for (let index = 0; index < prs.length; index += chunkSize) {
        const chunk = prs.slice(index, index + chunkSize);
        const results = await Promise.all(
          chunk.map(async (pr) => {
            try {
              const [status, checks, reviews, comments] = await Promise.all([
                window.ade.prs.getStatus(pr.id).catch(() => null),
                window.ade.prs.getChecks(pr.id).catch(() => [] as PrCheck[]),
                window.ade.prs.getReviews(pr.id).catch(() => [] as PrReview[]),
                window.ade.prs.getComments(pr.id).catch(() => [] as PrComment[])
              ]);
              const activityTimestamps = [
                pr.updatedAt,
                pr.lastSyncedAt,
                ...checks.flatMap((check) => [check.startedAt, check.completedAt]),
                ...reviews.map((review) => review.submittedAt),
                ...comments.flatMap((comment) => [comment.createdAt, comment.updatedAt])
              ]
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, ts: Date.parse(value) }))
                .filter((entry) => Number.isFinite(entry.ts))
                .sort((a, b) => b.ts - a.ts);
              return [pr.id, { status, checks, reviews, comments, lastActivityAt: activityTimestamps[0]?.value ?? pr.updatedAt }] as const;
            } catch {
              return [pr.id, { status: null, checks: [] as PrCheck[], reviews: [] as PrReview[], comments: [] as PrComment[], lastActivityAt: pr.updatedAt }] as const;
            }
          })
        );
        for (const [prId, insight] of results) next[prId] = insight;
      }
      if (!cancelled) setPrInsightById(next);
    };

    void loadInsights();

    return () => {
      cancelled = true;
    };
  }, [prs]);

  const prOverlayByPair = React.useMemo(() => {
    const map = new Map<string, GraphPrOverlay>();
    for (const pr of prs) {
      const lane = laneById.get(pr.laneId);
      if (!lane) continue;
      const baseLaneId = resolvePrBaseLaneId(lane, pr.baseBranch);
      if (!baseLaneId) continue;
      map.set(edgePairKey(baseLaneId, pr.laneId), buildGraphPrOverlay({
        pr,
        baseLaneId,
        detail: prInsightById[pr.id],
        mergeInProgress: Boolean(mergeInProgressByLaneId[pr.laneId])
      }));
    }
    return map;
  }, [laneById, mergeInProgressByLaneId, prInsightById, prs, resolvePrBaseLaneId]);
  const prOverlayByLaneId = React.useMemo(() => {
    const map = new Map<string, GraphPrOverlay>();
    for (const overlay of prOverlayByPair.values()) {
      map.set(overlay.laneId, overlay);
    }
    return map;
  }, [prOverlayByPair]);
  const selectedLane = React.useMemo(
    () => (selectedLaneIds.length === 1 ? laneById.get(selectedLaneIds[0]!) ?? null : null),
    [laneById, selectedLaneIds]
  );
  const selectedLanePr = React.useMemo(
    () => (selectedLane ? prByLaneId.get(selectedLane.id) ?? null : null),
    [prByLaneId, selectedLane]
  );
  const getBaseLaneIdForLane = React.useCallback(
    (laneId: string): string | null => {
      const lane = laneById.get(laneId);
      if (!lane) return null;
      return resolvePrBaseLaneId(lane, lane.baseRef);
    },
    [laneById, resolvePrBaseLaneId]
  );

  // Map integration lane id → source lane ids from proposals
  const integrationSourcesByLaneId = React.useMemo(() => {
    return buildIntegrationSourcesByLaneId(integrationProposals, laneById);
  }, [integrationProposals, laneById]);

  const connectedToHoveredNode = React.useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const connected = new Set<string>([hoveredNodeId]);

    if (viewMode === "stack" || viewMode === "all") {
      const primary = lanes.find((lane) => lane.laneType === "primary");
      if (primary?.id === hoveredNodeId) {
        for (const lane of lanes) connected.add(lane.id);
      } else if (primary && hoveredNodeId !== primary.id) {
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
        if (source.laneId === hoveredNodeId) {
          connected.add(integrationLaneId);
        }
      }
    }

    return connected;
  }, [hoveredNodeId, integrationSourcesByLaneId, lanes, riskByPair, viewMode]);

  const laneMatchesFilters = React.useCallback(
    (lane: LaneSummary): boolean => {
      if (filters.hidePrimary && lane.laneType === "primary") return false;
      if (filters.hideAttached && lane.laneType === "attached") return false;
      if (filters.hideArchived && lane.archivedAt) return false;
      if (filters.laneTypes.length > 0 && !filters.laneTypes.includes(lane.laneType)) return false;
      if (filters.status.length > 0 && !filters.status.includes(laneStatusGroup(statusByLane.get(lane.id)))) return false;
      if (filters.tags.length > 0 && !filters.tags.some((tag) => lane.tags.includes(tag))) return false;
      if (filters.rootLaneId) {
        const descendants = collectDescendants(lanes, filters.rootLaneId);
        if (!descendants.has(lane.id) && lane.id !== filters.rootLaneId) return false;
      }
      if (filters.search.trim().length > 0) {
        const needle = filters.search.trim().toLowerCase();
        const hay = `${lane.name} ${lane.branchRef} ${lane.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    },
    [filters, lanes, statusByLane]
  );

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

  const updateGraphSnapshot = React.useCallback(
    (updater: (snapshot: GraphLayoutSnapshot) => GraphLayoutSnapshot) => {
      setSessionState((prev) => {
        const nextSnapshot = updater(prev[viewMode] ?? createSnapshot(viewMode));
        return {
          ...prev,
          [viewMode]: { ...nextSnapshot, updatedAt: new Date().toISOString(), viewMode }
        };
      });
    },
    [viewMode]
  );

  const refreshRiskBatch = React.useCallback(async () => {
    try {
      const next = await window.ade.conflicts.getBatchAssessment();
      setBatch(next);
      setBatchProgress(next.progress ?? null);
    } catch {
      // best effort
    } finally {
      setLoadingRisk(false);
    }
  }, []);

  const refreshGraphPrSurface = React.useCallback(async () => {
    await refreshPrs();
    await Promise.allSettled([refreshRiskBatch(), refreshLanes()]);
  }, [refreshLanes, refreshPrs, refreshRiskBatch]);

  const refreshIntegrationProposals = React.useCallback(async () => {
    try {
      const proposals = await window.ade.prs.listProposals();
      setIntegrationProposals(proposals);
    } catch (err) {
      console.warn("[Graph] Failed to load integration proposals:", err);
    }
  }, []);

  const refreshActivity = React.useCallback(async () => {
    try {
      const [sessions, operations] = await Promise.all([
        window.ade.sessions.list({ limit: 500 }),
        window.ade.history.listOperations({ limit: 500 })
      ]);
      const now = Date.now();
      const activeByLane: Record<string, number> = {};
      const scoreByLane: Record<string, number> = {};
      const latestActivityByLane: Record<string, number> = {};

      const markActivity = (laneId: string, ts: number) => {
        if (!Number.isFinite(ts)) return;
        latestActivityByLane[laneId] = Math.max(latestActivityByLane[laneId] ?? 0, ts);
      };

      for (const session of sessions) {
        const startedAt = Date.parse(session.startedAt);
        const endedAt = session.endedAt ? Date.parse(session.endedAt) : null;
        if (session.status === "running") {
          activeByLane[session.laneId] = (activeByLane[session.laneId] ?? 0) + 1;
          scoreByLane[session.laneId] = (scoreByLane[session.laneId] ?? 0) + 50;
          markActivity(session.laneId, startedAt);
        } else if (endedAt != null && now - endedAt <= 60 * 60_000) {
          scoreByLane[session.laneId] = (scoreByLane[session.laneId] ?? 0) + 20;
          markActivity(session.laneId, endedAt);
        } else if (!Number.isNaN(startedAt) && now - startedAt <= 60 * 60_000) {
          scoreByLane[session.laneId] = (scoreByLane[session.laneId] ?? 0) + 10;
          markActivity(session.laneId, startedAt);
        }
      }
      for (const operation of operations) {
        if (operation.kind !== "git_commit") continue;
        const startedAt = Date.parse(operation.startedAt);
        if (Number.isNaN(startedAt) || now - startedAt > 24 * 60 * 60_000) continue;
        if (!operation.laneId) continue;
        scoreByLane[operation.laneId] = (scoreByLane[operation.laneId] ?? 0) + 10;
        markActivity(operation.laneId, startedAt);
      }
      setActiveSessionsByLaneId(activeByLane);
      setActivityScoreByLaneId(scoreByLane);
      const asIso: Record<string, string> = {};
      for (const [laneId, ts] of Object.entries(latestActivityByLane)) {
        if (!ts) continue;
        asIso[laneId] = new Date(ts).toISOString();
      }
      setLastActivityByLaneId(asIso);
    } catch {
      // ignore
    }
  }, []);

  const scheduleRefreshActivity = React.useCallback((delayMs = 700) => {
    if (activityRefreshTimerRef.current != null) return;
    activityRefreshTimerRef.current = window.setTimeout(() => {
      activityRefreshTimerRef.current = null;
      if (activityRefreshInFlightRef.current) {
        activityRefreshQueuedRef.current = true;
        return;
      }
      activityRefreshInFlightRef.current = true;
      void refreshActivity()
        .catch(() => {})
        .finally(() => {
          activityRefreshInFlightRef.current = false;
          if (activityRefreshQueuedRef.current) {
            activityRefreshQueuedRef.current = false;
            scheduleRefreshActivity(220);
          }
        });
    }, delayMs);
  }, [refreshActivity]);

  React.useEffect(() => {
    if (!project?.rootPath) return;
    let cancelled = false;
    setLoadingTopology(true);
    setLoadedGraphPreferences(false);
    setSessionState(createSessionState());
    setViewMode("all");
    setSelectedLaneIds([]);
    setShowFiltersPanel(false);

    void refreshLanes()
      .catch((err) => {
        console.warn("[Graph] refreshLanes failed:", err);
        reportGraphIssue("The graph could not load the latest lanes.", err);
      })
      .finally(() => {
        if (!cancelled) setLoadingTopology(false);
      });
    void refreshRiskBatch();
    scheduleRefreshActivity(0);
    void refreshLaneSyncStatuses();
    void refreshAutoRebaseStatuses();

    return () => {
      cancelled = true;
    };
  }, [project?.rootPath, refreshAutoRebaseStatuses, refreshLaneSyncStatuses, refreshLanes, refreshRiskBatch, reportGraphIssue, scheduleRefreshActivity]);

  React.useEffect(() => {
    let cancelled = false;
    void refreshPrs().catch((err) => console.warn("[Graph] listWithConflicts PRs failed:", err));
    let unsub = () => {};
    try {
      unsub = window.ade.prs.onEvent((event) => {
        if (event.type !== "prs-updated") return;
        if (cancelled) return;
        void refreshPrs().catch((err) => console.warn("[Graph] prs-updated refresh failed:", err));
      });
    } catch (error) {
      reportGraphIssue("Live PR updates are unavailable in the graph.", error);
    }

    return () => {
      cancelled = true;
      try {
        unsub();
      } catch {
        // noop
      }
    };
  }, [refreshPrs, reportGraphIssue]);

  React.useEffect(() => {
    void refreshIntegrationProposals();
  }, [lanesKey, refreshIntegrationProposals]);

  React.useEffect(() => {
    let unsub = () => {};
    try {
      unsub = window.ade.prs.onEvent((event) => {
        if (
          event.type === "integration-step"
          || event.type === "integration-state"
          || event.type === "proposal-stale"
        ) {
          void refreshIntegrationProposals();
        }
      });
    } catch (error) {
      reportGraphIssue("Integration proposal updates are unavailable in the graph.", error);
    }
    return () => {
      try {
        unsub();
      } catch {
        // noop
      }
    };
  }, [refreshIntegrationProposals, reportGraphIssue]);

  React.useEffect(() => {
    if (!project?.rootPath) return;
    const rootPath = project.rootPath;
    let cancelled = false;
    void window.ade.graphState
      .get(rootPath)
      .then((state) => {
        if (cancelled) return;
        const normalized = normalizeGraphPreferences(state);
        setViewMode(normalized.preferences.lastViewMode);
        if (normalized.migrated) {
          void window.ade.graphState.set(rootPath, normalized.preferences).catch(() => {});
        }
      })
      .catch((err) => {
        console.warn("[Graph] Failed to load graph state:", err);
        if (cancelled) return;
        setViewMode(createGraphPreferences().lastViewMode);
      })
      .finally(() => {
        if (!cancelled) setLoadedGraphPreferences(true);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.rootPath]);

  React.useEffect(() => {
    if (!project?.rootPath || !loadedGraphPreferences) return;
    void window.ade.graphState.set(project.rootPath, createGraphPreferences(viewMode)).catch(() => {});
  }, [loadedGraphPreferences, project?.rootPath, viewMode]);

  React.useEffect(() => {
    if (!undoToast) return;
    const timer = window.setTimeout(() => setUndoToast(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [undoToast]);

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
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [mergeDisappearingAtByLaneId]);

  // E3: Handle ?focusLane= query param
  React.useEffect(() => {
    const focusParam = searchParams.get("focusLane");
    if (!focusParam || !loadedGraphPreferences || lanes.length === 0) return;
    const targetLane = lanes.find((lane) => lane.id === focusParam);
    if (!targetLane) return;
    setFocusLaneId(focusParam);
    // Center on the focused node
    let glowTimer: number | undefined;
    const timer = window.setTimeout(() => {
      const targetNode = nodes.find((node) => node.id === focusParam);
      if (targetNode) {
        void reactFlow.fitView({ nodes: [targetNode], duration: 500, padding: 0.4 });
      }
      // Clear the param after initial focus
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("focusLane");
        return next;
      }, { replace: true });
      // Clear glow after 4 seconds
      glowTimer = window.setTimeout(() => setFocusLaneId(null), 4000);
    }, 300);
    return () => {
      window.clearTimeout(timer);
      if (glowTimer !== undefined) window.clearTimeout(glowTimer);
    };
  }, [searchParams, loadedGraphPreferences, lanes, nodes, reactFlow, setSearchParams]);

  // E3b: Handle ?focusProposal= query param
  React.useEffect(() => {
    const focusParam = searchParams.get("focusProposal");
    if (!focusParam || !loadedGraphPreferences || nodes.length === 0) return;
    const proposalNodeId = `proposal:${focusParam}`;
    const targetNode = nodes.find((node) => node.id === proposalNodeId);
    if (!targetNode) return;
    setFocusLaneId(proposalNodeId);
    // Center on the focused proposal node
    const timer = window.setTimeout(() => {
      void reactFlow.fitView({ nodes: [targetNode], duration: 500, padding: 0.4 });
      // Clear the param after initial focus
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("focusProposal");
        return next;
      }, { replace: true });
      // Clear glow after 4 seconds
      const glowTimer = window.setTimeout(() => setFocusLaneId(null), 4000);
      return () => window.clearTimeout(glowTimer);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchParams, loadedGraphPreferences, nodes, reactFlow, setSearchParams]);

  React.useEffect(() => {
    const laneId = nodeTooltip?.laneId ?? null;
    if (!laneId) {
      setNodeTooltipPack(null);
      return;
    }
    // Pack metadata removed in W6. Keep freshness indicators available using
    // current timestamp snapshot while unified memory health tooling matures.
    setNodeTooltipPack({
      deterministicUpdatedAt: new Date().toISOString(),
      narrativeUpdatedAt: null
    });
    return;
  }, [nodeTooltip?.laneId]);

  React.useEffect(() => {
    if (!batchStatus?.summary) return;
    const hasFailure = batchStatus.steps.some((step) => step.status === "failed" || step.status === "skipped");
    if (hasFailure) return;
    const timer = window.setTimeout(() => setBatchStatus(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [batchStatus]);

  React.useEffect(() => {
    return () => {
      if (dropPreviewTimerRef.current != null) {
        window.clearTimeout(dropPreviewTimerRef.current);
      }
      if (nodeHoverTimerRef.current != null) {
        window.clearTimeout(nodeHoverTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!showFiltersPanel && !singleActionsOpen && !batchActionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof globalThis.Node)) {
        setShowFiltersPanel(false);
        setSingleActionsOpen(false);
        setBatchActionsOpen(false);
        return;
      }
      if (
        filtersPanelRef.current?.contains(target)
        || singleActionsRef.current?.contains(target)
        || batchActionsRef.current?.contains(target)
      ) {
        return;
      }
      setShowFiltersPanel(false);
      setSingleActionsOpen(false);
      setBatchActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowFiltersPanel(false);
        setSingleActionsOpen(false);
        setBatchActionsOpen(false);
      }
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

  React.useEffect(() => {
    let unsubConflict = () => {};
    let unsubPtyData = () => {};
    let unsubPtyExit = () => {};
    let unsubAutoRebase = () => {};
    try {
      unsubConflict = window.ade.conflicts.onEvent((event) => {
        if (event.type === "prediction-progress") {
          setBatchProgress({ completedPairs: event.completedPairs, totalPairs: event.totalPairs });
          if (riskRefreshTimerRef.current != null) {
            window.clearTimeout(riskRefreshTimerRef.current);
          }
          riskRefreshTimerRef.current = window.setTimeout(() => {
            void refreshRiskBatch();
          }, 450);
          return;
        }
        if (event.type === "prediction-complete") {
          setBatchProgress({ completedPairs: event.completedPairs, totalPairs: event.totalPairs });
          void refreshRiskBatch();
        }
      });
    } catch (error) {
      reportGraphIssue("Conflict prediction live updates are unavailable in the graph.", error);
    }
    try {
      unsubPtyData = window.ade.pty.onData(() => {
        scheduleRefreshActivity(650);
      });
      unsubPtyExit = window.ade.pty.onExit(() => {
        scheduleRefreshActivity(220);
      });
    } catch (error) {
      reportGraphIssue("Activity updates are unavailable in the graph.", error);
    }
    try {
      unsubAutoRebase = window.ade.lanes.onAutoRebaseEvent((event) => {
        if (event.type !== "auto-rebase-updated") return;
        const next: Record<string, AutoRebaseLaneStatus | null> = {};
        for (const lane of lanesRef.current) next[lane.id] = null;
        for (const status of event.statuses) next[status.laneId] = status;
        setAutoRebaseByLaneId(next);
      });
    } catch (error) {
      reportGraphIssue("Auto-rebase live updates are unavailable in the graph.", error);
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshLanes().catch((err) => console.warn("[Graph] periodic refreshLanes failed:", err));
      scheduleRefreshActivity(320);
    }, 12_000);
    const syncInterval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshLaneSyncStatuses();
      void refreshAutoRebaseStatuses();
    }, 25_000);
    const onFocus = () => {
      void refreshLaneSyncStatuses();
      void refreshAutoRebaseStatuses();
      scheduleRefreshActivity(0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void refreshLaneSyncStatuses();
      void refreshAutoRebaseStatuses();
      scheduleRefreshActivity(0);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      try {
        unsubConflict();
        unsubPtyData();
        unsubPtyExit();
        unsubAutoRebase();
      } catch {
        // noop
      }
      window.clearInterval(interval);
      window.clearInterval(syncInterval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (riskRefreshTimerRef.current != null) {
        window.clearTimeout(riskRefreshTimerRef.current);
      }
      if (activityRefreshTimerRef.current != null) {
        window.clearTimeout(activityRefreshTimerRef.current);
      }
    };
  }, [refreshLaneSyncStatuses, refreshLanes, refreshRiskBatch, refreshAutoRebaseStatuses, reportGraphIssue, scheduleRefreshActivity]);

  const baseGraph = React.useMemo(() => {
    if (!loadedGraphPreferences) {
      return {
        nodes: [] as Array<Node<GraphNodeData>>,
        edges: [] as Array<Edge<GraphEdgeData>>,
        visibleNodeIds: new Set<string>(),
      };
    }

    const autoPositions = computeAutoLayout(lanes, viewMode, activityScoreByLaneId, environmentByLaneId);
    const savedPositions = activeSnapshot.nodePositions;
    const positions = Object.keys(savedPositions).length > 0 ? { ...autoPositions, ...savedPositions } : autoPositions;
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
          lane: appearanceEditor?.laneId === lane.id
            ? { ...lane, color: appearanceEditor.color, icon: appearanceEditor.icon, tags: appearanceEditor.tags }
            : lane,
          status: statusByLane.get(lane.id) ?? "unknown",
          remoteSync: syncByLaneId[lane.id] ?? null,
          autoRebaseStatus: autoRebaseByLaneId[lane.id] ?? null,
          activeSessions: activeSessionsByLaneId[lane.id] ?? 0,
          collapsedChildCount,
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
          pr: prOverlayByLaneId.get(lane.id) ?? null
        },
        selected: false,
        draggable: true
      });
    }

    for (const [proposalIndex, proposal] of integrationProposals.entries()) {
      const hasRealIntegrationLane = Boolean(proposal.integrationLaneId && laneById.has(proposal.integrationLaneId));
      if (proposal.status !== "proposed" || hasRealIntegrationLane) continue;
      const sourceLaneIds = proposalSourceLaneIds(proposal).filter((laneId) => laneById.has(laneId));
      if (sourceLaneIds.length === 0) continue;
      const normalizedProposalId =
        typeof proposal.proposalId === "string" && proposal.proposalId.trim().length > 0
          ? proposal.proposalId.trim()
          : null;
      const fallbackProposalKey = `legacy-${proposalIndex + 1}-${proposal.createdAt ?? "unknown"}`.replace(/[^a-zA-Z0-9_-]/g, "-");
      const proposalKey = normalizedProposalId ?? fallbackProposalKey;
      const shortProposalId = (normalizedProposalId ?? fallbackProposalKey).slice(0, 12);
      const sourcePositions = sourceLaneIds
        .map((laneId) => positions[laneId])
        .filter((pos): pos is { x: number; y: number } => Boolean(pos));
      const anchor =
        sourcePositions.length > 0
          ? {
              x: sourcePositions.reduce((sum, pos) => sum + pos.x, 0) / sourcePositions.length,
              y: sourcePositions.reduce((sum, pos) => sum + pos.y, 0) / sourcePositions.length
            }
          : { x: 0, y: 0 };

      const nodeId = `proposal:${proposalKey}`;
      const pos = positions[nodeId] ?? { x: anchor.x, y: anchor.y + 180 };
      const proposalTitle = proposal.title?.trim() || `Integration proposal ${shortProposalId}`;
      const proposalLane: LaneSummary = {
        id: nodeId,
        name: proposalTitle,
        description: `Virtual proposal ${shortProposalId}`,
        laneType: "attached",
        baseRef: proposal.baseBranch,
        branchRef: proposal.integrationLaneName?.trim() || `proposal/${proposalKey}`,
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
        tags: ["proposal"],
        createdAt: proposal.createdAt,
        archivedAt: null
      };
      if (sourceLaneIds.some((laneId) => laneVisibleById.get(laneId))) visibleNodeIds.add(nodeId);
      nextNodes.push({
        id: nodeId,
        type: "proposal",
        position: pos,
        data: {
          lane: proposalLane,
          status: "unknown",
          remoteSync: null,
          autoRebaseStatus: null,
          activeSessions: 0,
          collapsedChildCount: 0,
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
          proposalId: normalizedProposalId ?? undefined
        },
        selected: false,
        draggable: false
      });
      virtualProposalNodes.push({ nodeId, proposal, sourceLaneIds });
    }

    const nextEdges: Array<Edge<GraphEdgeData>> = [];
    const primaryLane = lanes.find((lane) => lane.laneType === "primary") ?? null;
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
      return pairwiseResults.some((pairwise) =>
        (pairwise?.laneAId === sourceLaneId || pairwise?.laneBId === sourceLaneId) && pairwise.outcome === "conflict"
      );
    };

    if (viewMode === "all" || viewMode === "risk") {
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
          selected: false
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
          selected: false
        });
      }
    }

    if (viewMode === "all" || viewMode === "risk") {
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
            ...(pr ? { pr } : {})
          },
          selected: false
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
          selected: false
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
            proposalConflict: laneHasProposalConflict(proposalNode.proposal, sourceLaneId)
          },
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: true,
          selected: false
        });
      }
    }

    return { nodes: nextNodes, edges: nextEdges, visibleNodeIds };
  }, [
    activityBucketByLaneId,
    activeSessionsByLaneId,
    activeSnapshot.nodePositions,
    appearanceEditor,
    autoRebaseByLaneId,
    collapsedLaneIds,
    environmentByLaneId,
    hiddenByCollapse,
    integrationProposals,
    integrationSourcesByLaneId,
    laneById,
    laneMatchesFilters,
    lanes,
    lastActivityByLaneId,
    loadedGraphPreferences,
    prOverlayByPair,
    prOverlayByLaneId,
    riskByPair,
    statusByLane,
    syncByLaneId,
    viewMode,
    activityScoreByLaneId
  ]);

  React.useEffect(() => {
    if (!loadedGraphPreferences) return;
    if (nodeDragActiveRef.current) return;
    const edgeVisualState = (edgeId: string, source: string, target: string) => {
      const connectedToNodeHover = hoveredNodeId ? source === hoveredNodeId || target === hoveredNodeId : false;
      const highlightedByEdge = hoveredEdgeId ? hoveredEdgeId === edgeId : false;
      return {
        highlight: hoveredEdgeId ? highlightedByEdge : connectedToNodeHover,
        dimmed: hoveredEdgeId
          ? hoveredEdgeId !== edgeId
          : hoveredNodeId
            ? !connectedToNodeHover
            : false
      };
    };

    setNodes(baseGraph.nodes.map((node) => {
      const connectedToHover = hoveredNodeId ? connectedToHoveredNode.has(node.id) : false;
      const dimmedByHover = Boolean(hoveredNodeId) && !connectedToHover;
      return {
        ...node,
        data: {
          ...node.data,
          dimmed: !baseGraph.visibleNodeIds.has(node.id) || dimmedByHover,
          highlight: Boolean(hoveredNodeId) && connectedToHover,
          rebaseFailed: !node.data.isVirtualProposal && rebaseFailedLaneId === node.id,
          rebasePulse: !node.data.isVirtualProposal && rebaseFailedLaneId === node.id && rebaseFailedPulse,
          mergeInProgress: !node.data.isVirtualProposal && Boolean(mergeInProgressByLaneId[node.id]),
          mergeDisappearing: !node.data.isVirtualProposal && Boolean(mergeDisappearingAtByLaneId[node.id]),
          focusGlow: focusLaneId === node.id
        },
        selected: selectedLaneIds.includes(node.id)
      };
    }));

    setEdges(baseGraph.edges.map((edge) => {
      const visual = edgeVisualState(edge.id, edge.source, edge.target);
      return {
        ...edge,
        data: { ...(edge.data as GraphEdgeData), ...visual },
        selected: visual.highlight
      };
    }));
  }, [
    baseGraph,
    connectedToHoveredNode,
    focusLaneId,
    hoveredEdgeId,
    hoveredNodeId,
    loadedGraphPreferences,
    mergeDisappearingAtByLaneId,
    mergeInProgressByLaneId,
    rebaseFailedLaneId,
    rebaseFailedPulse,
    selectedLaneIds
  ]);

  const onNodesChange = React.useCallback((changes: Parameters<typeof applyNodeChanges<Node<GraphNodeData>>>[0]) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
  }, []);

  const onEdgesChange = React.useCallback((changes: Parameters<typeof applyEdgeChanges<Edge<GraphEdgeData>>>[0]) => {
    setEdges((prev) => applyEdgeChanges(changes, prev));
  }, []);

  const saveNodePositions = React.useCallback(
    (nextNodes: Array<Node<GraphNodeData>>) => {
      const nodePositions: GraphLayoutSnapshot["nodePositions"] = {};
      for (const node of nextNodes) {
        nodePositions[node.id] = { x: node.position.x, y: node.position.y };
      }
      updateGraphSnapshot((snapshot) => ({
        ...snapshot,
        nodePositions
      }));
    },
    [updateGraphSnapshot]
  );

  const findDropTarget = React.useCallback(
    (node: Node<GraphNodeData>): Node<GraphNodeData> | null => {
      if (node.data.isVirtualProposal) return null;
      const targetCandidates = nodes.filter(
        (candidate) => candidate.id !== node.id && !candidate.data.isVirtualProposal && !hiddenByCollapse.has(candidate.id)
      );
      const nodeDims = nodeDimensions(node.data.lane, node.data.activityBucket, viewMode);
      const nodeCenter = { x: node.position.x + nodeDims.width / 2, y: node.position.y + nodeDims.height / 2 };
      for (const candidate of targetCandidates) {
        const dims = nodeDimensions(candidate.data.lane, candidate.data.activityBucket, viewMode);
        if (
          nodeCenter.x >= candidate.position.x &&
          nodeCenter.x <= candidate.position.x + dims.width &&
          nodeCenter.y >= candidate.position.y &&
          nodeCenter.y <= candidate.position.y + dims.height
        ) {
          return candidate;
        }
      }
      return null;
    },
    [hiddenByCollapse, nodes, viewMode]
  );

  const getDropIntegratePlan = React.useCallback(
    (sourceLaneId: string, targetLaneId: string) => {
      const source = laneById.get(sourceLaneId);
      const target = laneById.get(targetLaneId);
      if (!source || !target) return null;

      const sourceDescendants = collectDescendants(lanes, source.id);
      if (sourceDescendants.has(target.id)) {
        return {
          sourceLaneId: source.id,
          laneId: target.id,
          baseRef: source.branchRef,
          mode: "rebase" as GitSyncMode,
          summary: `Rebase '${target.name}' onto '${source.name}'`,
          detail: `Bring ${source.branchRef} into ${target.name} with rebase.`
        };
      }
      return {
        sourceLaneId: source.id,
        laneId: target.id,
        baseRef: source.branchRef,
        mode: "merge" as GitSyncMode,
        summary: `Merge '${source.name}' into '${target.name}'`,
        detail: `Bring ${source.branchRef} into ${target.name} with merge.`
      };
    },
    [laneById, lanes]
  );

  const onNodeDragStart = React.useCallback((_event: React.MouseEvent, node: Node<GraphNodeData>) => {
    if (node.data.isVirtualProposal) return;
    nodeDragActiveRef.current = true;
    dragOriginRef.current.set(node.id, { x: node.position.x, y: node.position.y });
    if (dropPreviewTimerRef.current != null) {
      window.clearTimeout(dropPreviewTimerRef.current);
      dropPreviewTimerRef.current = null;
    }
    setDropPreview(null);
    // Clear hover state so the dimming effect doesn't persist through the drag.
    setHoveredNodeId(null);
    setHoveredEdgeId(null);
    setEdgeHover(null);
    if (nodeHoverTimerRef.current != null) {
      window.clearTimeout(nodeHoverTimerRef.current);
      nodeHoverTimerRef.current = null;
    }
    setNodeTooltip(null);
    setDragTrail({ laneId: node.id, from: { x: node.position.x, y: node.position.y }, to: { x: node.position.x, y: node.position.y } });
  }, []);

  const onNodeDrag = React.useCallback(
    (_event: React.MouseEvent, node: Node<GraphNodeData>) => {
      if (node.data.isVirtualProposal) return;
      const origin = dragOriginRef.current.get(node.id);
      if (!origin) return;
      setDragTrail({ laneId: node.id, from: origin, to: { x: node.position.x, y: node.position.y } });

      const target = findDropTarget(node);
      if (!target) {
        if (dropPreviewTimerRef.current != null) {
          window.clearTimeout(dropPreviewTimerRef.current);
          dropPreviewTimerRef.current = null;
        }
        setDropPreview(null);
        return;
      }

      const draggedLaneIds = selectedLaneIds.includes(node.id) && selectedLaneIds.length > 1 ? selectedLaneIds : [node.id];
      let nextPreview:
        | {
            draggedLaneIds: string[];
            targetLaneId: string;
            tone: "safe" | "warn" | "blocked";
            message: string;
            detail: string;
          }
        | null = null;
      const wouldCycle = draggedLaneIds.some((laneId) => {
        if (laneId === target.id) return true;
        return collectDescendants(lanes, laneId).has(target.id);
      });
      if (wouldCycle) {
        nextPreview = {
          draggedLaneIds,
          targetLaneId: target.id,
          tone: "blocked",
          message: "Cannot change parent (cycle detected).",
          detail: "Pick a lane that is not inside the dragged lane's descendant chain."
        };
      } else {
        let overlapCount = 0;
        for (const laneId of draggedLaneIds) {
          if (laneId === target.id) continue;
          const overlapFiles = overlapFilesByPair.get(edgePairKey(laneId, target.id)) ?? [];
          overlapCount = Math.max(overlapCount, overlapFiles.length);
        }
        if (draggedLaneIds.length === 1) {
          const plan = getDropIntegratePlan(draggedLaneIds[0]!, target.id);
          if (!plan) {
            nextPreview = {
              draggedLaneIds,
              targetLaneId: target.id,
              tone: "warn",
              message: "Drop action unavailable for this lane pair.",
              detail: "Try again after lane topology refresh."
            };
          } else if (overlapCount > 0) {
            nextPreview = {
              draggedLaneIds,
              targetLaneId: target.id,
              tone: "warn",
              message: `${plan.summary} (⚠ ${overlapCount} overlapping files).`,
              detail: `${plan.detail} Use Reparent when you want to change stack hierarchy instead of integrating commits.`
            };
          } else {
            nextPreview = {
              draggedLaneIds,
              targetLaneId: target.id,
              tone: "safe",
              message: plan.summary,
              detail: `${plan.detail} Use Reparent when you want to change stack hierarchy instead of integrating commits.`
            };
          }
        } else if (overlapCount > 0) {
          nextPreview = {
            draggedLaneIds,
            targetLaneId: target.id,
            tone: "warn",
            message: `Reparent ${draggedLaneIds.length} lanes under ${target.data.lane.name} (⚠ ${overlapCount} overlapping files).`,
            detail: "Multi-lane drop updates stack parent + base ref and rebases in dependency order."
          };
        } else {
          nextPreview = {
            draggedLaneIds,
            targetLaneId: target.id,
            tone: "safe",
            message: `Reparent ${draggedLaneIds.length} lanes under ${target.data.lane.name}.`,
            detail: "Multi-lane drop updates stack parent + base ref and rebases in dependency order."
          };
        }
      }

      if (dropPreviewTimerRef.current != null) {
        window.clearTimeout(dropPreviewTimerRef.current);
      }
      dropPreviewTimerRef.current = window.setTimeout(() => {
        setDropPreview(nextPreview);
      }, 200);
    },
    [findDropTarget, getDropIntegratePlan, lanes, overlapFilesByPair, selectedLaneIds]
  );

  const openReparentDialog = React.useCallback(
    (draggedLaneId: string, targetLaneId: string, laneIds: string[]) => {
      const lane = laneById.get(draggedLaneId);
      const target = laneById.get(targetLaneId);
      if (!lane || !target) return;
      if (lane.id === target.id) return;

      const wouldCycle = laneIds.some((laneId) => {
        if (laneId === targetLaneId) return true;
        return collectDescendants(lanes, laneId).has(targetLaneId);
      });
      if (wouldCycle) {
        setErrorBanner("Cannot reparent — would create cycle.");
        return;
      }

      const overlapFiles = Array.from(
        laneIds.reduce((acc, laneId) => {
          for (const file of overlapFilesByPair.get(edgePairKey(laneId, targetLaneId)) ?? []) {
            acc.add(file);
          }
          return acc;
        }, new Set<string>())
      ).sort((a, b) => a.localeCompare(b));
      const integratePlan = laneIds.length === 1 ? getDropIntegratePlan(laneIds[0]!, targetLaneId) : null;
      setReparentDialog({
        laneIds,
        targetLaneId,
        overlapFiles,
        preview: null,
        previewBusy: false,
        actionMode: integratePlan ? "integrate" : "reparent",
        integratePlan
      });
    },
    [getDropIntegratePlan, laneById, lanes, overlapFilesByPair]
  );

  const openPrDialogForLane = React.useCallback(
    (laneId: string, baseLaneId: string) => {
      const lane = laneById.get(laneId);
      const baseLane = laneById.get(baseLaneId);
      if (!lane || !baseLane) return;

      const existing = prByLaneId.get(laneId) ?? null;
      const baseBranch = baseLane.branchRef;

      setPrDialog({
        laneId,
        baseLaneId,
        baseBranch,
        title: existing?.title ?? "",
        body: "",
        draft: existing?.state === "draft",
        loadingDraft: !existing,
        creating: false,
        existingPr: existing,
        loadingDetails: Boolean(existing),
        status: null,
        checks: [],
        reviews: [],
        comments: [],
        mergeMethod: "squash",
        merging: false,
        error: null
      });

      if (!existing) {
        void window.ade.prs
          .draftDescription({ laneId })
          .then((draft) => {
            setPrDialog((prev) => (prev && prev.laneId === laneId ? { ...prev, title: draft.title, body: draft.body, loadingDraft: false } : prev));
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            setPrDialog((prev) => (prev && prev.laneId === laneId ? { ...prev, loadingDraft: false, error: message } : prev));
          });
        return;
      }

      void Promise.all([
        window.ade.prs.getStatus(existing.id),
        window.ade.prs.getChecks(existing.id),
        window.ade.prs.getReviews(existing.id),
        window.ade.prs.getComments(existing.id)
      ])
        .then(([status, checks, reviews, comments]) => {
          setPrDialog((prev) =>
            prev && prev.laneId === laneId
              ? { ...prev, loadingDetails: false, status, checks, reviews, comments }
              : prev
          );
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setPrDialog((prev) => (prev && prev.laneId === laneId ? { ...prev, loadingDetails: false, error: message } : prev));
        });
    },
    [laneById, prByLaneId]
  );

  const runGraphPrReview = React.useCallback(
    async (pr: PrWithConflicts, event: "APPROVE" | "REQUEST_CHANGES") => {
      setGraphPrActionBusy(event);
      try {
        let body: string | undefined;
        if (event === "REQUEST_CHANGES") {
          const requested = await requestTextInput({
            title: "Request Changes",
            message: "Optional review note to include with the change request.",
            placeholder: "Changes requested because...",
            confirmLabel: "Submit review"
          });
          if (requested === null) return;
          body = requested.trim() || undefined;
        }
        await window.ade.prs.submitReview({ prId: pr.id, event, body });
        await refreshGraphPrSurface();
      } catch (error) {
        setErrorBanner(error instanceof Error ? error.message : String(error));
      } finally {
        setGraphPrActionBusy(null);
      }
    },
    [refreshGraphPrSurface, requestTextInput]
  );

  const runGraphPrMerge = React.useCallback(
    async (pr: PrWithConflicts, method: MergeMethod) => {
      setGraphPrActionBusy("merge");
      setMergeInProgressByLaneId((prev) => ({ ...prev, [pr.laneId]: true }));
      try {
        const result = await window.ade.prs.land({ prId: pr.id, method });
        if (!result.success) {
          throw new Error(result.error || "Merge failed");
        }
        setMergeDisappearingAtByLaneId((prev) => ({ ...prev, [pr.laneId]: Date.now() }));
        await refreshGraphPrSurface();
        setPrDialog(null);
      } catch (error) {
        setMergeInProgressByLaneId((prev) => ({ ...prev, [pr.laneId]: false }));
        setErrorBanner(error instanceof Error ? error.message : String(error));
      } finally {
        setGraphPrActionBusy(null);
      }
    },
    [refreshGraphPrSurface]
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
        applying: false
      });

      void window.ade.conflicts
        .simulateMerge({ laneAId, laneBId })
        .then((result) => {
          setConflictPanel((prev) =>
            prev && prev.laneAId === laneAId && prev.laneBId === laneBId
              ? { ...prev, loading: false, result }
              : prev
          );
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setConflictPanel((prev) =>
            prev && prev.laneAId === laneAId && prev.laneBId === laneBId
              ? { ...prev, loading: false, error: message }
              : prev
          );
        });
    },
    [laneById]
  );

  const openExistingPrDetail = React.useCallback(
    (pr: GraphPrOverlay) => {
      openPrDialogForLane(pr.laneId, pr.baseLaneId);
    },
    [openPrDialogForLane]
  );

  const buildGraphOverlayForLane = React.useCallback(
    (laneId: string, lanePr?: PrWithConflicts | null): GraphPrOverlay | null => {
      const lane = laneById.get(laneId);
      const pr = lanePr ?? prByLaneId.get(laneId) ?? null;
      if (!lane || !pr) return null;
      const baseLaneId = resolvePrBaseLaneId(lane, lane.baseRef);
      if (!baseLaneId) return null;
      return prOverlayByLaneId.get(lane.id) ?? {
        prId: pr.id,
        laneId: lane.id,
        baseLaneId,
        number: pr.githubPrNumber,
        title: pr.title,
        url: pr.githubUrl,
        state: pr.state,
        checksStatus: pr.checksStatus,
        reviewStatus: pr.reviewStatus,
        lastSyncedAt: pr.lastSyncedAt ?? null,
        lastActivityAt: pr.updatedAt,
        mergeInProgress: Boolean(mergeInProgressByLaneId[lane.id]),
        isMergeable: null,
        mergeConflicts: null,
        behindBaseBy: null,
        reviewCount: 0,
        approvedCount: 0,
        changeRequestCount: 0,
        commentCount: 0,
        pendingCheckCount: 0,
        activityState: "idle"
      };
    },
    [laneById, mergeInProgressByLaneId, prByLaneId, prOverlayByLaneId, resolvePrBaseLaneId]
  );

  const refreshPrDialogDetail = React.useCallback(async () => {
    if (!prDialog?.existingPr) {
      await refreshPrs();
      return;
    }
    const refreshedPrs = await window.ade.prs.listWithConflicts();
    setPrs(refreshedPrs);
    const refreshed = refreshedPrs.find((entry) => entry.id === prDialog.existingPr?.id) ?? null;
    if (!refreshed) {
      setPrDialog(null);
      return;
    }
    const [status, checks, reviews, comments] = await Promise.all([
      window.ade.prs.getStatus(refreshed.id).catch(() => null),
      window.ade.prs.getChecks(refreshed.id).catch(() => [] as PrCheck[]),
      window.ade.prs.getReviews(refreshed.id).catch(() => [] as PrReview[]),
      window.ade.prs.getComments(refreshed.id).catch(() => [] as PrComment[])
    ]);
    setPrDialog((prev) => (
      prev && prev.existingPr?.id === refreshed.id
        ? { ...prev, existingPr: refreshed, status, checks, reviews, comments, loadingDetails: false }
        : prev
    ));
  }, [prDialog, refreshPrs]);

  const onNodeDragStop = React.useCallback(
    (_event: React.MouseEvent, node: Node<GraphNodeData>) => {
      if (node.data.isVirtualProposal) return;
      nodeDragActiveRef.current = false;
      const origin = dragOriginRef.current.get(node.id);
      setDragTrail(null);
      if (dropPreviewTimerRef.current != null) {
        window.clearTimeout(dropPreviewTimerRef.current);
        dropPreviewTimerRef.current = null;
      }
      setDropPreview(null);
      // Clear hover state so the node-rebuild effect doesn't dim non-connected nodes.
      setHoveredNodeId(null);
      setHoveredEdgeId(null);
      setEdgeHover(null);
      if (nodeHoverTimerRef.current != null) {
        window.clearTimeout(nodeHoverTimerRef.current);
        nodeHoverTimerRef.current = null;
      }
      setNodeTooltip(null);
      dragOriginRef.current.delete(node.id);
      const latestNodes = reactFlow.getNodes();
      saveNodePositions(latestNodes.map((existing) => (existing.id === node.id ? { ...existing, position: node.position } : existing)));

      const target = findDropTarget(node);
      if (!target) return;

      if (origin) {
        const dx = node.position.x - origin.x;
        const dy = node.position.y - origin.y;
        const moved = Math.sqrt(dx * dx + dy * dy);
        if (moved < 5) return;
      }

      const selectedIds = selectedLaneIds.includes(node.id) && selectedLaneIds.length > 1 ? selectedLaneIds : [node.id];
      if (selectedIds.length === 1 && laneById.get(target.id)?.laneType === "primary") {
        openPrDialogForLane(node.id, target.id);
        return;
      }
      openReparentDialog(node.id, target.id, selectedIds);
    },
    [findDropTarget, laneById, openPrDialogForLane, openReparentDialog, reactFlow, saveNodePositions, selectedLaneIds]
  );

  const applyReparent = React.useCallback(async () => {
    if (!reparentDialog) return;
    if (reparentDialog.actionMode === "integrate") {
      const plan = reparentDialog.integratePlan;
      if (!plan) return;
      try {
        await window.ade.git.sync({
          laneId: plan.laneId,
          mode: plan.mode,
          baseRef: plan.baseRef
        });
        setReparentDialog(null);
        await refreshLanes().catch(() => {});
      } catch (error) {
        setErrorBanner(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (reparentDialog.actionMode === "pr") {
      const laneId = reparentDialog.laneIds[0];
      if (!laneId) return;
      openPrDialogForLane(laneId, reparentDialog.targetLaneId);
      setReparentDialog(null);
      return;
    }

    const target = laneById.get(reparentDialog.targetLaneId);
    if (!target) return;

    const orderedLaneIds = [...reparentDialog.laneIds].sort((a, b) => {
      const laneA = laneById.get(a);
      const laneB = laneById.get(b);
      return (laneA?.stackDepth ?? 0) - (laneB?.stackDepth ?? 0);
    });

    const completed: Array<{ laneId: string; previousParentLaneId: string | null }> = [];
    for (const laneId of orderedLaneIds) {
      try {
        const result = await window.ade.lanes.reparent({ laneId, newParentLaneId: target.id });
        completed.push({ laneId, previousParentLaneId: result.previousParentLaneId });
      } catch (error) {
        for (const rollback of completed.reverse()) {
          if (!rollback.previousParentLaneId) continue;
          try {
            await window.ade.lanes.reparent({ laneId: rollback.laneId, newParentLaneId: rollback.previousParentLaneId });
          } catch {
            // best effort rollback
          }
        }
        setErrorBanner(error instanceof Error ? error.message : String(error));
        setReparentDialog(null);
        await refreshLanes().catch(() => {});
        return;
      }
    }

    setUndoToast({
      message: `Reparented ${orderedLaneIds.length === 1 ? `'${laneById.get(orderedLaneIds[0]!)?.name ?? orderedLaneIds[0]}'` : `${orderedLaneIds.length} lanes`} under '${target.name}'`,
      undoAction: async () => {
        for (const rollback of completed.reverse()) {
          if (!rollback.previousParentLaneId) continue;
          await window.ade.lanes.reparent({ laneId: rollback.laneId, newParentLaneId: rollback.previousParentLaneId });
        }
        await refreshLanes();
      }
    });
    setReparentDialog(null);
    await refreshLanes().catch(() => {});
  }, [laneById, openPrDialogForLane, refreshLanes, reparentDialog]);

  const runPullFromUpstream = React.useCallback(
    async (laneId: string, mode: GitSyncMode = "rebase") => {
      const latest = await window.ade.git.getSyncStatus({ laneId }).catch(() => null);
      const lane = laneById.get(laneId) ?? null;
      const targetBaseRef = latest?.hasUpstream && latest.upstreamRef
        ? latest.upstreamRef
        : (lane?.baseRef ?? undefined);
      await window.ade.git.sync({ laneId, mode, baseRef: targetBaseRef });
    },
    [laneById]
  );

  const runLaneRebase = React.useCallback(async (laneId: string, recursive: boolean): Promise<void> => {
    const result = await window.ade.lanes.rebaseStart({
      laneId,
      scope: recursive ? "lane_and_descendants" : "lane_only",
      pushMode: "none",
      actor: "user"
    });
    if (result.run.state === "failed" || result.run.error) {
      throw new Error(result.run.error ?? "Rebase failed.");
    }
  }, []);

  const runRebaseAndPublishLane = React.useCallback(
    async (laneId: string, args?: { confirmPublish?: boolean; recursive?: boolean }): Promise<RebasePublishOutcome> => {
      const lane = laneById.get(laneId);
      if (!lane) {
        return { status: "skipped", message: "lane not found" };
      }
      if (!lane.parentLaneId) {
        return { status: "skipped", message: "no parent lane" };
      }

      await runLaneRebase(laneId, Boolean(args?.recursive));

      await window.ade.git.fetch({ laneId }).catch(() => {});
      const sync = await window.ade.git.getSyncStatus({ laneId });

      const confirmPublish = Boolean(args?.confirmPublish);
      if (!sync.hasUpstream) {
        if (confirmPublish) {
          const ok = await graphConfirm.confirmAsync({
            title: "Publish Lane",
            message: `Publish lane '${lane.name}' to origin/${lane.branchRef}?`,
            confirmLabel: "PUBLISH",
          });
          if (!ok) return { status: "skipped", message: "publish skipped" };
        }
        await window.ade.git.push({ laneId });
        return { status: "done", message: "published new remote branch" };
      }

      if (sync.diverged && sync.ahead > 0) {
        if (confirmPublish) {
          const ok = await graphConfirm.confirmAsync({
            title: "Force Push",
            message: `Lane '${lane.name}' diverged from remote (${sync.ahead} local ahead, ${sync.behind} remote ahead). Force push with lease now?`,
            confirmLabel: "FORCE PUSH",
            danger: true,
          });
          if (!ok) return { status: "skipped", message: "force push skipped" };
        }
        await window.ade.git.push({ laneId, forceWithLease: true });
        return { status: "done", message: "force-pushed with lease" };
      }

      if (sync.ahead > 0) {
        if (confirmPublish) {
          const ok = await graphConfirm.confirmAsync({
            title: "Push Commits",
            message: `Push ${sync.ahead} commit${sync.ahead === 1 ? "" : "s"} for lane '${lane.name}' now?`,
            confirmLabel: "PUSH",
          });
          if (!ok) return { status: "skipped", message: "push skipped" };
        }
        await window.ade.git.push({ laneId });
        return { status: "done", message: "pushed updates" };
      }

      if (sync.behind > 0) {
        return { status: "skipped", message: `behind remote by ${sync.behind} commit${sync.behind === 1 ? "" : "s"}` };
      }

      return { status: "done", message: "rebased and already pushed" };
    },
    [laneById, graphConfirm, runLaneRebase]
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
        status: "pending" as const
      }));
      setBatchStatus({
        operation,
        steps,
        activeIndex: 0,
        summary: null
      });

      const descendantsCache = new Map<string, Set<string>>();
      for (const laneId of selectedLaneIds) descendantsCache.set(laneId, collectDescendants(lanes, laneId));
      const blocked = new Set<string>();
      const ordered = isRebaseLike
        ? [...selectedLaneIds].sort((a, b) => (laneById.get(a)?.stackDepth ?? 0) - (laneById.get(b)?.stackDepth ?? 0))
        : [...selectedLaneIds];

      let failedCount = 0;
      let doneCount = 0;
      let skippedCount = 0;
      for (let index = 0; index < ordered.length; index += 1) {
        const laneId = ordered[index]!;
        setBatchStatus((prev) => {
          if (!prev) return prev;
          const nextSteps = [...prev.steps];
          const stepIndex = nextSteps.findIndex((step) => step.laneId === laneId);
          if (stepIndex >= 0) nextSteps[stepIndex] = { ...nextSteps[stepIndex]!, status: "running" as const };
          return { ...prev, steps: nextSteps, activeIndex: index };
        });

        if (blocked.has(laneId)) {
          skippedCount += 1;
          setBatchStatus((prev) => {
            if (!prev) return prev;
            const nextSteps = prev.steps.map((step) => step.laneId === laneId ? { ...step, status: "skipped" as const, error: "blocked by parent failure" } : step);
            return { ...prev, steps: nextSteps };
          });
          continue;
        }

        try {
          let skippedReason: string | null = null;
          if (operation === "rebase") {
            await runLaneRebase(laneId, false);
          } else if (operation === "rebase_publish") {
            const outcome = await runRebaseAndPublishLane(laneId, { confirmPublish: true, recursive: false });
            if (outcome.status === "skipped") {
              skippedReason = outcome.message;
            }
          } else if (operation === "push") {
            await window.ade.git.push({ laneId });
          } else if (operation === "fetch") {
            await window.ade.git.fetch({ laneId });
          } else if (operation === "archive") {
            await window.ade.lanes.archive({ laneId });
          } else {
            await window.ade.lanes.delete({ laneId, force: true, deleteBranch: false });
          }
          if (skippedReason) {
            skippedCount += 1;
            setBatchStatus((prev) => {
              if (!prev) return prev;
              const nextSteps = prev.steps.map((step) =>
                step.laneId === laneId ? { ...step, status: "skipped" as const, error: skippedReason } : step
              );
              return { ...prev, steps: nextSteps };
            });
          } else {
            doneCount += 1;
            setBatchStatus((prev) => {
              if (!prev) return prev;
              const nextSteps = prev.steps.map((step) => step.laneId === laneId ? { ...step, status: "done" as const } : step);
              return { ...prev, steps: nextSteps };
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const missingLane = /lane not found|no longer exists/i.test(message);
          if (missingLane) {
            skippedCount += 1;
            setBatchStatus((prev) => {
              if (!prev) return prev;
              const nextSteps = prev.steps.map((step) =>
                step.laneId === laneId ? { ...step, status: "skipped" as const, error: "no longer exists" } : step
              );
              return { ...prev, steps: nextSteps };
            });
            continue;
          }

          failedCount += 1;
          setBatchStatus((prev) => {
            if (!prev) return prev;
            const nextSteps = prev.steps.map((step) =>
              step.laneId === laneId ? { ...step, status: "failed" as const, error: message } : step
            );
            return { ...prev, steps: nextSteps };
          });
          if (isRebaseLike) {
            const descendants = descendantsCache.get(laneId);
            for (const childId of descendants ?? []) blocked.add(childId);
            setRebaseFailedLaneId(laneId);
            setRebaseFailedPulse(true);
            window.setTimeout(() => setRebaseFailedPulse(false), 1650);
            const label = operation === "rebase_publish" ? "Rebase + push" : "Rebase";
            setErrorBanner(`${label} paused: conflict on '${laneById.get(laneId)?.name ?? laneId}'. ${doneCount}/${ordered.length} lanes completed.`);
          }
        }
      }

      setBatchStatus((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          summary: `${doneCount}/${ordered.length} done, ${failedCount} failed${skippedCount > 0 ? `, ${skippedCount} skipped` : ""}`
        };
      });
      await refreshLanes().catch(() => {});
      await refreshLaneSyncStatuses().catch(() => {});
    },
    [laneById, lanes, refreshLaneSyncStatuses, refreshLanes, runLaneRebase, runRebaseAndPublishLane, selectedLaneIds]
  );

  const openCreateIntegrationDialog = React.useCallback(() => {
    setIntegrationDialog({
      laneIds: [...selectedLaneIds],
      targetLaneId: (() => {
        const baseLaneIds = selectedLaneIds
          .map((laneId) => getBaseLaneIdForLane(laneId) ?? primaryLaneId)
          .filter((laneId): laneId is string => Boolean(laneId));
        if (baseLaneIds.length === 0) return primaryLaneId;
        return baseLaneIds.every((laneId) => laneId === baseLaneIds[0]) ? baseLaneIds[0]! : primaryLaneId;
      })(),
      name: `Integration ${new Date().toISOString().slice(0, 10)} (${selectedLaneIds.length})`,
      busy: false,
      step: null,
      error: null
    });
  }, [getBaseLaneIdForLane, primaryLaneId, selectedLaneIds]);

  const openContextForSelected = React.useCallback(() => {
    if (selectedLaneIds.length !== 1) return;
    const laneId = selectedLaneIds[0]!;
    setContextMenu({ laneId, x: 240, y: 200 });
  }, [selectedLaneIds]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        openContextForSelected();
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      if (selectedLaneIds.length !== 1) return;
      const currentId = selectedLaneIds[0]!;
      const current = laneById.get(currentId);
      if (!current) return;

      let nextLane: LaneSummary | null = null;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        if (current.parentLaneId) nextLane = laneById.get(current.parentLaneId) ?? null;
      } else {
        nextLane = lanes.find((lane) => lane.parentLaneId === current.id) ?? null;
      }
      if (!nextLane) return;
      event.preventDefault();
      setSelectedLaneIds([nextLane.id]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [laneById, lanes, openContextForSelected, selectedLaneIds]);

  const runLaneAction = React.useCallback(
    async (
      laneId: string,
      action: string,
      options?: { appearanceAnchor?: { x: number; y: number } }
    ) => {
      const lane = laneById.get(laneId);
      if (!lane) return;

      try {
        let shouldRefreshSync = false;
        const lanePr = prByLaneId.get(lane.id) ?? null;
        const baseLaneId = resolvePrBaseLaneId(lane, lane.baseRef);
        if (action === "open-lane") {
          navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single`);
        } else if (action === "open-folder") {
          await window.ade.lanes.openFolder({ laneId: lane.id });
        } else if (action === "view-pr") {
          const overlay = buildGraphOverlayForLane(lane.id, lanePr);
          if (!overlay) return;
          openExistingPrDetail(overlay);
        } else if (action === "create-pr") {
          if (!baseLaneId) return;
          openPrDialogForLane(lane.id, baseLaneId);
        } else if (action === "merge-pr") {
          if (!lanePr) return;
          await runGraphPrMerge(lanePr, "squash");
        } else if (action === "approve-pr") {
          if (!lanePr) return;
          await runGraphPrReview(lanePr, "APPROVE");
        } else if (action === "request-pr-changes") {
          if (!lanePr) return;
          await runGraphPrReview(lanePr, "REQUEST_CHANGES");
        } else if (action === "create-child") {
          const name = await requestTextInput({
            title: "Child lane name",
            validate: (value) => (value ? null : "Lane name is required")
          });
          if (!name) return;
          await window.ade.lanes.createChild({ parentLaneId: lane.id, name });
          await refreshLanes();
        } else if (action === "archive") {
          await window.ade.lanes.archive({ laneId: lane.id });
          await refreshLanes();
        } else if (action === "delete") {
          const confirmText = await requestTextInput({
            title: `Type delete ${lane.name} to confirm`,
            validate: (value) => (value ? null : "Confirmation text is required")
          });
          if (confirmText?.trim().toLowerCase() !== `delete ${lane.name}`.toLowerCase()) return;
          await window.ade.lanes.delete({ laneId: lane.id, force: true, deleteBranch: false });
          await refreshLanes();
        } else if (action === "rebase") {
          await runLaneRebase(lane.id, false);
          await refreshLanes();
          shouldRefreshSync = true;
        } else if (action === "rebase-publish") {
          const outcome = await runRebaseAndPublishLane(lane.id, { confirmPublish: true, recursive: false });
          if (outcome.status === "skipped") {
            setErrorBanner(`Rebase + push skipped for '${lane.name}': ${outcome.message}`);
          }
          await refreshLanes();
          shouldRefreshSync = true;
        } else if (action === "push") {
          await window.ade.git.push({ laneId: lane.id });
          shouldRefreshSync = true;
        } else if (action === "fetch") {
          await window.ade.git.fetch({ laneId: lane.id });
          shouldRefreshSync = true;
        } else if (action === "sync") {
          await runPullFromUpstream(lane.id, "rebase");
          await refreshLanes();
          shouldRefreshSync = true;
        } else if (action === "reparent") {
          const options = lanes.filter((entry) => entry.id !== lane.id).map((entry) => `${entry.id}:${entry.name}`).join("\n");
          const picked = await requestTextInput({
            title: "Enter target lane id",
            message: options || "No candidate lanes available.",
            validate: (value) => (value ? null : "Lane id is required")
          });
          if (!picked) return;
          const targetId = picked.trim();
          if (!laneById.has(targetId)) throw new Error("Unknown target lane id");
          openReparentDialog(lane.id, targetId, [lane.id]);
        } else if (action === "rename") {
          const name = await requestTextInput({
            title: "New lane name",
            defaultValue: lane.name,
            validate: (value) => (value ? null : "Lane name is required")
          });
          if (!name) return;
          await window.ade.lanes.rename({ laneId: lane.id, name });
          await refreshLanes();
        } else if (action === "customize") {
          const fallbackAnchor = {
            x: Math.max(24, window.innerWidth - 380),
            y: Math.max(24, window.innerHeight - 360)
          };
          const anchor = options?.appearanceAnchor ?? fallbackAnchor;
          setAppearanceEditor({
            laneId: lane.id,
            x: anchor.x,
            y: anchor.y,
            color: lane.color,
            icon: lane.icon,
            tags: [...lane.tags],
            newTag: ""
          });
        } else if (action === "collapse") {
          updateGraphSnapshot((snapshot) => ({
            ...snapshot,
            collapsedLaneIds: Array.from(new Set([...snapshot.collapsedLaneIds, lane.id]))
          }));
        } else if (action === "expand") {
          updateGraphSnapshot((snapshot) => ({
            ...snapshot,
            collapsedLaneIds: snapshot.collapsedLaneIds.filter((id) => id !== lane.id)
          }));
        }
        if (shouldRefreshSync) {
          await refreshLaneSyncStatuses().catch(() => {});
        }
      } catch (error) {
        setErrorBanner(error instanceof Error ? error.message : String(error));
      }
    },
    [
      buildGraphOverlayForLane,
      laneById,
      lanes,
      navigate,
      openExistingPrDetail,
      openReparentDialog,
      openPrDialogForLane,
      prByLaneId,
      refreshLaneSyncStatuses,
      refreshLanes,
      resolvePrBaseLaneId,
      requestTextInput,
      runGraphPrMerge,
      runGraphPrReview,
      runPullFromUpstream,
      runLaneRebase,
      runRebaseAndPublishLane,
      updateGraphSnapshot
    ]
  );

  const applyContextAction = React.useCallback(
    async (action: string) => {
      if (!contextMenu) return;
      try {
        await runLaneAction(contextMenu.laneId, action, {
          appearanceAnchor: { x: contextMenu.x + 20, y: contextMenu.y }
        });
      } finally {
        setContextMenu(null);
      }
    },
    [contextMenu, runLaneAction]
  );

  const lanesForLegend = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      if (!lane.color) continue;
      map.set(lane.color, lane.name);
    }
    return Array.from(map.entries()).slice(0, 8);
  }, [lanes]);

  const environmentLegendEntries = React.useMemo(() => {
    const compiled = environmentMappings
      .map((mapping) => ({
        env: mapping.env?.trim() ?? "",
        branch: mapping.branch?.trim() ?? "",
        color: mapping.color ?? null,
        branchRegex: globToRegExp(mapping.branch ?? "")
      }))
      .filter((mapping) => mapping.env.length > 0 && mapping.branch.length > 0);

    return compiled
      .map((mapping) => ({
        env: mapping.env,
        branch: mapping.branch,
        color: mapping.color,
        matchCount: lanes.filter((lane) => mapping.branchRegex.test(branchNameFromRef(lane.branchRef))).length
      }))
      .sort((a, b) => a.env.localeCompare(b.env) || a.branch.localeCompare(b.branch))
      .slice(0, 10);
  }, [environmentMappings, lanes]);

  const availableTags = React.useMemo(() => {
    const tags = new Set<string>();
    for (const lane of lanes) {
      for (const tag of lane.tags) {
        if (tag.trim()) tags.add(tag.trim());
      }
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b)).slice(0, 14);
  }, [lanes]);

  const rootLaneOptions = React.useMemo(
    () => lanes.filter((lane) => !lane.parentLaneId).sort((a, b) => a.name.localeCompare(b.name)),
    [lanes]
  );

  const statusLegendEntries = React.useMemo(() => ([
    { label: "Needs push", tone: "text-emerald-300", detail: "Local commits are ready to publish." },
    { label: "Needs pull", tone: "text-sky-300", detail: "Remote has commits this lane does not have yet." },
    { label: "Diverged", tone: "text-red-300", detail: "Local and remote both changed and need reconciliation." },
    { label: "Behind base", tone: "text-amber-300", detail: "The lane is behind its parent or target base branch." }
  ]), []);

  const matchingSearchNodes = React.useMemo(() => {
    const needle = filters.search.trim().toLowerCase();
    if (!needle) return [];
    return nodes.filter((node) => {
      const lane = node.data.lane;
      const hay = `${lane.name} ${lane.branchRef} ${lane.tags.join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [filters.search, nodes]);

  const focusSearchResults = React.useCallback(() => {
    if (matchingSearchNodes.length === 0) return;
    void reactFlow.fitView({ nodes: matchingSearchNodes, duration: 320, padding: 0.25 });
  }, [matchingSearchNodes, reactFlow]);

  const resetView = React.useCallback(() => {
    setShowFiltersPanel(false);
    updateGraphSnapshot(() => createSnapshot(viewMode));
    window.setTimeout(() => {
      void reactFlow.fitView({ duration: 500, padding: 0.2 });
    }, 0);
  }, [reactFlow, updateGraphSnapshot, viewMode]);

  React.useEffect(() => {
    if (!loadedGraphPreferences) return;
    const fitKey = `${viewMode}:${nodes.length}:${edges.length}:${activeSnapshot.updatedAt}`;
    if (lastFitViewKeyRef.current === fitKey) return;
    lastFitViewKeyRef.current = fitKey;
    const timer = window.setTimeout(() => {
      void reactFlow.fitView({ duration: 500, padding: 0.2 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSnapshot.updatedAt, edges.length, loadedGraphPreferences, nodes.length, reactFlow, viewMode]);

  const hoveredTooltipLane = nodeTooltip ? laneById.get(nodeTooltip.laneId) ?? null : null;
  const activeViewMeta = VIEW_MODE_META[viewMode];
  const filtersActiveCount = activeGraphFilterCount(filters);
  const dragTrailScreen = React.useMemo(() => {
    if (!dragTrail) return null;
    const viewport = reactFlow.getViewport();
    const x1 = dragTrail.from.x * viewport.zoom + viewport.x;
    const y1 = dragTrail.from.y * viewport.zoom + viewport.y;
    const x2 = dragTrail.to.x * viewport.zoom + viewport.x;
    const y2 = dragTrail.to.y * viewport.zoom + viewport.y;
    return { x1, y1, x2, y2 };
  }, [dragTrail, reactFlow]);
  const selectedLaneOverlay = React.useMemo(
    () => (selectedLane ? buildGraphOverlayForLane(selectedLane.id, selectedLanePr) : null),
    [buildGraphOverlayForLane, selectedLane, selectedLanePr]
  );
  const selectedLaneSyncSummary = React.useMemo(() => {
    if (!selectedLane) return null;
    const remoteSync = syncByLaneId[selectedLane.id] ?? null;
    const autoRebase = autoRebaseByLaneId[selectedLane.id] ?? null;
    if (remoteSync?.diverged) return { label: "Diverged", tone: "text-red-300" };
    if (autoRebase?.state === "rebaseConflict") return { label: "Rebase conflict", tone: "text-red-300" };
    if (autoRebase?.state === "rebasePending") return { label: "Rebase pending", tone: "text-amber-300" };
    if (remoteSync && ((remoteSync.hasUpstream === false) || remoteSync.ahead > 0)) {
      return { label: remoteSync.hasUpstream === false ? "Publish lane" : "Needs push", tone: "text-emerald-300" };
    }
    if (remoteSync?.hasUpstream && remoteSync.recommendedAction === "pull") return { label: "Needs pull", tone: "text-sky-300" };
    if (selectedLane.status.behind > 0 || statusByLane.get(selectedLane.id) === "behind-base") return { label: "Behind base", tone: "text-amber-300" };
    if (autoRebase?.state === "autoRebased") return { label: "Auto-rebased", tone: "text-emerald-300" };
    return { label: "In sync", tone: "text-muted-fg" };
  }, [autoRebaseByLaneId, selectedLane, statusByLane, syncByLaneId]);
  const selectedLaneEnvironment = selectedLane ? environmentByLaneId[selectedLane.id] ?? null : null;
  const selectedLaneCanCreatePr = Boolean(selectedLane && selectedLane.laneType !== "primary" && getBaseLaneIdForLane(selectedLane.id));
  const singleLaneActionItems = React.useMemo(() => {
    if (!selectedLane) return [];
    const isPrimary = selectedLane.laneType === "primary";
    const prIsOpen = Boolean(selectedLanePr && selectedLanePr.state === "open");
    return [
      { key: "merge-pr", label: "Merge PR", disabled: !prIsOpen || graphPrActionBusy !== null },
      { key: "approve-pr", label: "Approve PR", disabled: !prIsOpen || graphPrActionBusy !== null },
      { key: "request-pr-changes", label: "Request changes", disabled: !prIsOpen || graphPrActionBusy !== null },
      { key: "rebase", label: "Rebase", disabled: !selectedLane.parentLaneId },
      { key: "rebase-publish", label: "Rebase + push", disabled: !selectedLane.parentLaneId },
      { key: "push", label: "Push", disabled: false },
      { key: "fetch", label: "Fetch", disabled: false },
      { key: "rename", label: "Rename", disabled: false },
      { key: "customize", label: "Customize appearance", disabled: false },
      { key: "archive", label: "Archive", disabled: isPrimary },
      { key: "delete", label: "Delete", disabled: isPrimary, danger: true },
    ];
  }, [graphPrActionBusy, selectedLane, selectedLanePr]);
  const batchActionItems = React.useMemo(() => ([
    { key: "rebase" as const, label: "Rebase" },
    { key: "rebase_publish" as const, label: "Rebase + push" },
    { key: "push" as const, label: "Push" },
    { key: "fetch" as const, label: "Fetch" },
    { key: "archive" as const, label: "Archive" },
    { key: "delete" as const, label: "Delete", danger: true },
  ]), []);
  const truncatedBannerTopClass = "top-[82px]";
  const errorBannerTopClass = batch?.truncated ? "top-[128px]" : "top-[82px]";
  const edgeSimulationTopClass = "top-[82px]";

  if (loadingTopology) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute inset-0">
          <div className="h-full w-full bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] [opacity:0.3]" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg border border-border/10 bg-card/90 backdrop-blur-sm shadow-card px-4 py-3 text-sm text-muted-fg">
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

  const allNodesHidden = baseGraph.nodes.length > 0 && baseGraph.visibleNodeIds.size === 0;

  return (
    <div className="relative h-full w-full">
      <ConfirmDialog state={graphConfirm.state} onClose={graphConfirm.close} />
      <div className="absolute inset-0 h-full w-full bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] [opacity:0.3]" />

      <div className="absolute left-0 right-0 top-0 z-20 border-b border-border/10 bg-bg/95 px-3 py-2 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg bg-surface-recessed p-0.5">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
                  viewMode === mode ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg"
                )}
                onClick={() => setViewMode(mode)}
              >
                {VIEW_MODE_META[mode].label}
              </button>
            ))}
          </div>

          <div className="relative ml-2">
            <MagnifyingGlass size={14} weight="regular" className="pointer-events-none absolute left-2 top-1.5 text-muted-fg" />
            <input
              value={filters.search}
              onChange={(event) => {
                const value = event.target.value;
                updateGraphSnapshot((snapshot) => ({
                  ...snapshot,
                  filters: { ...snapshot.filters, search: value }
                }));
              }}
              placeholder="Filter lanes or tags"
              className="h-7 w-[220px] rounded-lg border border-border/15 bg-surface-recessed pl-7 pr-2 text-xs text-fg outline-none placeholder:text-muted-fg/50"
            />
          </div>

          {filters.search.trim().length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={matchingSearchNodes.length === 0}
              onClick={focusSearchResults}
            >
              Focus Results
            </Button>
          ) : null}

          <div className="relative ml-auto" ref={filtersPanelRef}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => setShowFiltersPanel((prev) => !prev)}
            >
              <Funnel size={14} weight="regular" />
              Filters
              {filtersActiveCount > 0 ? (
                <span className="rounded-full bg-accent px-1.5 py-0 text-[10px] text-accent-fg">{filtersActiveCount}</span>
              ) : null}
            </Button>
            {showFiltersPanel ? (
              <div className="absolute right-0 top-8 z-40 w-[360px] rounded border border-border/10 bg-card/95 backdrop-blur-sm p-2 text-xs shadow-float">
                <div className="mb-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-fg">Status</div>
                  <div className="flex flex-wrap gap-1">
                    {(["conflict", "at-risk", "clean", "unknown"] as GraphStatusFilter[]).map((status) => (
                      <Chip
                        key={status}
                        role="button"
                        onClick={() =>
                          updateGraphSnapshot((snapshot) => ({
                            ...snapshot,
                            filters: {
                              ...snapshot.filters,
                              status: snapshot.filters.status.includes(status)
                                ? snapshot.filters.status.filter((entry) => entry !== status)
                                : [...snapshot.filters.status, status]
                            }
                          }))
                        }
                        className={cn(
                          "cursor-pointer",
                          filters.status.includes(status) &&
                            (status === "conflict"
                              ? "bg-red-500/30 text-red-200"
                              : status === "at-risk"
                                ? "bg-amber-500/30 text-amber-200"
                                : status === "clean"
                                  ? "bg-emerald-500/25 text-emerald-200"
                                  : "bg-muted text-fg")
                        )}
                      >
                        {status}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="mb-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-fg">Lane Type</div>
                  <div className="flex flex-wrap gap-1">
                    {(["worktree", "attached", "primary"] as LaneSummary["laneType"][]).map((laneType) => (
                      <Chip
                        key={laneType}
                        role="button"
                        onClick={() =>
                          updateGraphSnapshot((snapshot) => ({
                            ...snapshot,
                            filters: {
                              ...snapshot.filters,
                              laneTypes: snapshot.filters.laneTypes.includes(laneType)
                                ? snapshot.filters.laneTypes.filter((entry) => entry !== laneType)
                                : [...snapshot.filters.laneTypes, laneType]
                            }
                          }))
                        }
                        className={cn("cursor-pointer", filters.laneTypes.includes(laneType) && "bg-accent/30 text-accent-fg")}
                      >
                        {laneType}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="mb-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-fg">Visibility</div>
                  <div className="flex flex-wrap gap-1">
                    <Chip
                      role="button"
                      onClick={() =>
                        updateGraphSnapshot((snapshot) => ({
                          ...snapshot,
                          filters: {
                            ...snapshot.filters,
                            hidePrimary: !snapshot.filters.hidePrimary
                          }
                        }))
                      }
                      className={cn("cursor-pointer", filters.hidePrimary && "bg-muted text-fg")}
                    >
                      hide primary
                    </Chip>
                    <Chip
                      role="button"
                      onClick={() =>
                        updateGraphSnapshot((snapshot) => ({
                          ...snapshot,
                          filters: {
                            ...snapshot.filters,
                            hideAttached: !snapshot.filters.hideAttached
                          }
                        }))
                      }
                      className={cn("cursor-pointer", filters.hideAttached && "bg-muted text-fg")}
                    >
                      hide attached
                    </Chip>
                    <Chip
                      role="button"
                      onClick={() =>
                        updateGraphSnapshot((snapshot) => ({
                          ...snapshot,
                          filters: {
                            ...snapshot.filters,
                            hideArchived: !snapshot.filters.hideArchived
                          }
                        }))
                      }
                        className={cn("cursor-pointer", filters.hideArchived && "bg-muted text-fg")}
                    >
                      hide archived
                    </Chip>
                  </div>
                </div>
                <div className="mt-3 flex justify-between gap-2 border-t border-border/10 pt-3">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={resetView}>
                    Reset View
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setShowFiltersPanel(false)}>
                    Close
                  </Button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-muted-fg">
                    Root stack
                    <select
                      value={filters.rootLaneId ?? ""}
                      onChange={(event) =>
                        updateGraphSnapshot((snapshot) => ({
                          ...snapshot,
                          filters: {
                            ...snapshot.filters,
                            rootLaneId: event.target.value || null
                          }
                        }))
                      }
                      className="h-7 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs normal-case text-fg"
                    >
                      <option value="">all stacks</option>
                      {rootLaneOptions.map((lane) => (
                        <option key={lane.id} value={lane.id}>
                          {lane.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wider text-muted-fg">
                    Tag
                    <select
                      value={filters.tags[0] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        updateGraphSnapshot((snapshot) => ({
                          ...snapshot,
                          filters: {
                            ...snapshot.filters,
                            tags: value ? [value] : []
                          }
                        }));
                      }}
                      className="h-7 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs normal-case text-fg"
                    >
                      <option value="">all tags</option>
                      {availableTags.map((tag) => (
                        <option key={tag} value={tag}>
                          {tag}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : null}
          </div>

          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={resetView}>
            Reset View
          </Button>

          <Button
            size="sm"
            variant={showRiskMatrix ? "primary" : "outline"}
            className="ml-2 h-8 px-2 text-[11px]"
            onClick={() => setShowRiskMatrix((prev) => !prev)}
          >
            Pair Matrix
          </Button>
        </div>
        <div className="mt-1 text-[11px] text-muted-fg">{activeViewMeta.helper}</div>
      </div>

      <div className="absolute inset-0 pt-[74px]">
        <ReactFlow<Node<GraphNodeData>, Edge<GraphEdgeData>>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(_event, node) => {
            if (node.data.isVirtualProposal) {
              setSelectedLaneIds([]);
              setNodes((prev) => prev.map((entry) => ({ ...entry, selected: entry.id === node.id })));
              if (node.data.proposalId) {
                navigate(`/prs?tab=integration&proposalId=${encodeURIComponent(node.data.proposalId)}`);
              }
              return;
            }
            setSelectedLaneIds([node.id]);
            setNodes((prev) => prev.map((entry) => ({ ...entry, selected: entry.id === node.id })));
            if (collapsedLaneIds.has(node.id)) {
              updateGraphSnapshot((snapshot) => ({
                ...snapshot,
                collapsedLaneIds: snapshot.collapsedLaneIds.filter((entry) => entry !== node.id)
              }));
            }
          }}
          onNodeMouseEnter={(event, node) => {
            // Suppress hover highlights while a drag is active to prevent
            // stale hoveredNodeId from dimming nodes after drag ends.
            if (nodeDragActiveRef.current) return;
            if (node.data.isVirtualProposal) {
              setHoveredNodeId(null);
              setNodeTooltip(null);
              if (nodeHoverTimerRef.current != null) {
                window.clearTimeout(nodeHoverTimerRef.current);
                nodeHoverTimerRef.current = null;
              }
              return;
            }
            setHoveredNodeId(node.id);
            if (nodeHoverTimerRef.current != null) {
              window.clearTimeout(nodeHoverTimerRef.current);
            }
            nodeHoverTimerRef.current = window.setTimeout(() => {
              setNodeTooltip({ x: event.clientX + 12, y: event.clientY + 12, laneId: node.id });
            }, 400);
          }}
          onNodeMouseMove={(event, node) => {
            if (nodeDragActiveRef.current) return;
            if (node.data.isVirtualProposal) return;
            if (nodeTooltip?.laneId !== node.id) return;
            setNodeTooltip({ x: event.clientX + 12, y: event.clientY + 12, laneId: node.id });
          }}
          onNodeMouseLeave={() => {
            if (nodeDragActiveRef.current) return;
            setHoveredNodeId(null);
            if (nodeHoverTimerRef.current != null) {
              window.clearTimeout(nodeHoverTimerRef.current);
              nodeHoverTimerRef.current = null;
            }
            setNodeTooltip(null);
          }}
          onSelectionChange={(selection) => {
            const selected = selection.nodes.filter((node) => !node.data.isVirtualProposal).map((node) => node.id);
            setSelectedLaneIds((prev) => (sameIdSet(prev, selected) ? prev : selected));
          }}
          onNodeContextMenu={(event, node) => {
            if (node.data.isVirtualProposal) {
              event.preventDefault();
              setContextMenu(null);
              return;
            }
            event.preventDefault();
            setContextMenu({
              laneId: node.id,
              x: event.clientX,
              y: event.clientY
            });
          }}
          onNodeDoubleClick={(_event, node) => {
            if (node.data.isVirtualProposal) return;
            if (collapsedLaneIds.has(node.id)) {
              updateGraphSnapshot((snapshot) => ({
                ...snapshot,
                collapsedLaneIds: snapshot.collapsedLaneIds.filter((entry) => entry !== node.id)
              }));
              return;
            }
            navigate(`/lanes?laneId=${encodeURIComponent(node.id)}&focus=single`);
          }}
          onEdgeClick={(_event, edge) => {
            const prefix = edge.data?.edgeType ?? edge.id.split(":")[0];
            const laneAId = edge.source;
            const laneBId = edge.target;
            if (!laneAId || !laneBId) return;
            const data = edge.data;
            if (data?.pr) {
              setEdgeSimulation(null);
              setReparentDialog(null);
              setContextMenu(null);
              openExistingPrDetail(data.pr);
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
              setEdgeSimulation({
                laneAId,
                laneBId,
                loading: true,
                result: null,
                error: null
              });
              void window.ade.conflicts
                .simulateMerge({ laneAId, laneBId })
                .then((result) => {
                  setEdgeSimulation((prev) =>
                    prev && prev.laneAId === laneAId && prev.laneBId === laneBId
                      ? { ...prev, loading: false, result }
                      : prev
                  );
                })
                .catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  setEdgeSimulation((prev) =>
                    prev && prev.laneAId === laneAId && prev.laneBId === laneBId
                      ? { ...prev, loading: false, error: message }
                      : prev
                  );
                });
            }
          }}
          onEdgeMouseEnter={(_event, edge) => { if (!nodeDragActiveRef.current) setHoveredEdgeId(edge.id); }}
          onEdgeMouseMove={(event, edge) => {
            setHoveredEdgeId(edge.id);
            const data = edge.data;
            const laneAId = edge.source;
            const laneBId = edge.target;
            const pr = data?.pr ?? null;
            const prLines = pr
              ? [
                  `PR #${pr.number} · ${pr.state} · checks: ${pr.checksStatus} · reviews: ${pr.reviewStatus}`,
                  `${pr.reviewCount} reviews · ${pr.commentCount} comments${pr.behindBaseBy != null ? ` · behind ${pr.behindBaseBy}` : ""}`,
                  pr.title ? pr.title : null,
                  pr.lastActivityAt ? `activity ${toRelativeTime(pr.lastActivityAt)}` : null,
                  pr.lastSyncedAt ? `synced ${toRelativeTime(pr.lastSyncedAt)}` : null
                ].filter((line): line is string => Boolean(line && line.trim().length))
              : [];
            if (data?.edgeType === "risk") {
              const pair = laneAId && laneBId ? edgePairKey(laneAId, laneBId) : "";
              const overlapFiles = pair ? overlapFilesByPair.get(pair) ?? [] : [];
              const fileLines = overlapFiles.slice(0, 6).map((file) => `- ${file}`);
              const moreLine = overlapFiles.length > 6 ? `... +${overlapFiles.length - 6} more` : null;
              setEdgeHover({
                x: event.clientX + 12,
                y: event.clientY + 12,
                label: [
                  `${data.riskLevel ?? "unknown"} · ${overlapFiles.length} file${overlapFiles.length === 1 ? "" : "s"}${data.stale ? " · stale" : ""}`,
                  ...fileLines,
                  ...(moreLine ? [moreLine] : []),
                  ...(prLines.length ? ["", ...prLines] : [])
                ].join("\n")
              });
              return;
            }
            if (data?.edgeType === "stack" && laneAId && laneBId) {
              setEdgeHover({
                x: event.clientX + 12,
                y: event.clientY + 12,
                label: [
                  `${laneById.get(laneAId)?.name ?? laneAId} → ${laneById.get(laneBId)?.name ?? laneBId}`,
                  ...(prLines.length ? ["", ...prLines] : [])
                ].join("\n")
              });
              return;
            }
            if (data?.edgeType === "topology" && laneAId && laneBId) {
              setEdgeHover({
                x: event.clientX + 12,
                y: event.clientY + 12,
                label: [
                  `${laneById.get(laneAId)?.name ?? laneAId} → ${laneById.get(laneBId)?.name ?? laneBId}`,
                  ...(prLines.length ? ["", ...prLines] : [])
                ].join("\n")
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
            bgColor="color-mix(in srgb, var(--color-card) 92%, transparent)"
            maskColor="color-mix(in srgb, var(--color-bg) 72%, transparent)"
            nodeBorderRadius={6}
            nodeStrokeWidth={2}
            nodeColor={(node) => {
              const data = node.data as GraphNodeData | undefined;
              if (data?.isVirtualProposal) return "#A78BFA";
              return data?.environment?.color ?? data?.lane?.color ?? "var(--color-muted-fg)";
            }}
            nodeStrokeColor={(node) => (node.selected ? "var(--color-accent)" : "color-mix(in srgb, var(--color-border) 88%, transparent)")}
            style={{
              background: "color-mix(in srgb, var(--color-card) 92%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
              borderRadius: 14,
              boxShadow: "var(--shadow-card)"
            }}
          />
          <Panel position="bottom-left">
            <div className="flex flex-col gap-2">
              <div className="rounded-xl border border-border/10 bg-card/95 p-1 shadow-card backdrop-blur-sm">
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-fg transition-colors hover:bg-surface-recessed"
                    title="Zoom in"
                    onClick={() => reactFlow.zoomIn({ duration: 180 })}
                  >
                    <Plus size={14} weight="bold" />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-fg transition-colors hover:bg-surface-recessed"
                    title="Zoom out"
                    onClick={() => reactFlow.zoomOut({ duration: 180 })}
                  >
                    <Minus size={14} weight="bold" />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-fg transition-colors hover:bg-surface-recessed"
                    title="Fit graph"
                    onClick={() => void reactFlow.fitView({ duration: 500, padding: 0.2 })}
                  >
                    <ArrowSquareOut size={14} weight="regular" />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-fg transition-colors hover:bg-surface-recessed"
                    title="Reset view"
                    onClick={resetView}
                  >
                    <ClockCounterClockwise size={14} weight="regular" />
                  </button>
                </div>
              </div>
              {loadingRisk ? (
                <div className="rounded-lg bg-card/90 px-2 py-1 text-[11px] text-muted-fg">
                  Loading conflict data…
                </div>
              ) : batchProgress ? (
                <div className="rounded-lg bg-card/90 px-2 py-1 text-[11px] text-muted-fg">
                  Computing {batchProgress.completedPairs}/{batchProgress.totalPairs} pairs…
                </div>
              ) : null}
            </div>
          </Panel>
          {lanes.length === 1 && lanes[0]?.laneType === "primary" ? (
            <Panel position="bottom-center">
              <div className="rounded-lg bg-card/90 px-2 py-1 text-[11px] text-muted-fg">
                Create a worktree lane to see your topology.
              </div>
            </Panel>
          ) : null}
          {dropPreview ? (
            <Panel position="top-left">
              <div
                className={cn(
                  "ade-drop-preview-pop rounded border px-2 py-1 text-[11px]",
                  dropPreview.tone === "safe" && "border-emerald-600/70 bg-emerald-900/20 text-emerald-200",
                  dropPreview.tone === "warn" && "border-amber-600/70 bg-amber-900/20 text-amber-200",
                  dropPreview.tone === "blocked" && "border-red-700/70 bg-red-900/25 text-red-200"
                )}
              >
                <div className="font-semibold">{dropPreview.message}</div>
                <div className="mt-0.5 text-[10px] opacity-85">{dropPreview.detail}</div>
              </div>
            </Panel>
          ) : null}
          <Panel position="top-right">
            <div className="flex w-[280px] flex-col gap-2 text-[11px]">
              <div className="rounded-lg bg-card/92 p-3 shadow-card backdrop-blur-sm">
                <div className="mb-2 font-semibold text-fg">Environments</div>
                {environmentLegendEntries.length === 0 ? (
                  <div className="text-muted-fg">No environment mappings configured.</div>
                ) : (
                  <div className="space-y-2">
                    {environmentLegendEntries.map((entry) => (
                      <div key={`${entry.env}:${entry.branch}`} className="rounded-lg border border-border/10 bg-card/60 px-2 py-1.5">
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

              <div className="rounded-lg bg-card/92 p-3 shadow-card backdrop-blur-sm">
                <div className="mb-2 font-semibold text-fg">Status Key</div>
                <div className="space-y-2">
                  {statusLegendEntries.map((entry) => (
                    <div key={entry.label} className="rounded-lg border border-border/10 bg-card/60 px-2 py-1.5">
                      <div className={cn("font-medium", entry.tone)}>{entry.label}</div>
                      <div className="mt-0.5 text-[10px] text-muted-fg">{entry.detail}</div>
                    </div>
                  ))}
                </div>
              </div>

              {lanesForLegend.length === 0 ? (
                null
              ) : (
                <div className="rounded-lg bg-card/92 p-3 shadow-card backdrop-blur-sm">
                  <div className="mb-2 font-semibold text-fg">Custom Lane Colors</div>
                  <div className="space-y-1">
                    {lanesForLegend.map(([color, laneName]) => (
                      <div key={color} className="flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-full ring-1 ring-border/30" style={{ backgroundColor: color }} />
                        <span className="truncate text-muted-fg">{laneName}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </ReactFlow>
        {allNodesHidden ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-[74px]">
            <div className="pointer-events-auto rounded-lg border border-border/10 bg-card/90 backdrop-blur-sm shadow-card px-5 py-4 text-center">
              <Funnel size={24} weight="regular" className="mx-auto mb-2 text-muted-fg" />
              <div className="text-sm font-medium text-fg">No visible lanes</div>
              <div className="mt-1 text-xs text-muted-fg">All lanes are hidden by the current filters.</div>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 text-xs"
                onClick={() => {
                  updateGraphSnapshot((snapshot) => ({
                    ...snapshot,
                    filters: buildDefaultFilter()
                  }));
                }}
              >
                Reset Filters
              </Button>
            </div>
          </div>
        ) : null}
        {dragTrailScreen ? (
          <svg className="pointer-events-none absolute inset-x-0 bottom-0 top-[74px] z-10">
            <line
              x1={dragTrailScreen.x1}
              y1={dragTrailScreen.y1}
              x2={dragTrailScreen.x2}
              y2={dragTrailScreen.y2}
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray="4 4"
              opacity={0.6}
            />
          </svg>
        ) : null}
      </div>

      {contextMenu ? (
        <div
          className="fixed z-[90] min-w-[190px] rounded border border-border/10 bg-card/95 backdrop-blur-sm p-1 shadow-float"
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
            const sections: Array<{
              title: string;
              items: Array<{ key: string; label: string; disabled?: boolean; reason?: string; danger?: boolean }>;
            }> = [
              {
                title: "Navigate",
                items: [
                  { key: "open-lane", label: "Open Lane" },
                  { key: "open-folder", label: "Open Folder" },
                  { key: "view-pr", label: "Open PR", disabled: !hasPr, reason: "No linked PR for this lane." },
                  { key: "create-pr", label: hasPr ? "Open PR Workflow" : "Create PR", disabled: !canCreatePr, reason: "Primary lanes cannot open PRs." },
                ]
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
                    reason: "No child lanes to collapse."
                  }
                ]
              },
              {
                title: "Sync",
                items: [
                  { key: "rebase", label: "Rebase", disabled: !hasParent, reason: "Rebase is only available for child lanes." },
                  {
                    key: "rebase-publish",
                    label: "Rebase + Push",
                    disabled: !hasParent,
                    reason: "Rebase + push is only available for child lanes."
                  },
                  { key: "push", label: "Push" },
                  { key: "fetch", label: "Fetch" },
                  { key: "sync", label: "Pull From Upstream" },
                ]
              },
              {
                title: "Manage",
                items: [
                  { key: "rename", label: "Rename" },
                  { key: "customize", label: "Customize Appearance" },
                  { key: "archive", label: "Archive", disabled: isPrimary, reason: "Primary lane cannot be archived." },
                  { key: "delete", label: "Delete", disabled: isPrimary, reason: "Primary lane cannot be deleted.", danger: true },
                ]
              }
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
                            : "text-fg hover:bg-card/80"
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
        <div className="fixed z-[95] w-[340px] rounded border border-border/10 bg-card/95 backdrop-blur-sm p-3 shadow-float" style={{ left: appearanceEditor.x, top: appearanceEditor.y }}>
          <div className="mb-2 text-xs font-semibold text-fg">Customize Appearance</div>
          <div className="mb-2 text-xs text-muted-fg">Color</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {COLOR_PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                className={cn(
                  "h-5 w-5 rounded-full ring-1 ring-border/30",
                  appearanceEditor.color === color && "ring-2 ring-accent"
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
                  "inline-flex h-7 items-center gap-1 rounded border border-border/10 bg-card/60 px-2 text-xs",
                  appearanceEditor.icon === option.key && "bg-accent/20 ring-1 ring-accent"
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
              <span key={tag} className="inline-flex items-center gap-1 rounded border border-border/10 bg-card/60 px-1 text-xs text-fg">
                {tag}
                <button
                  type="button"
                  className="text-muted-fg"
                  onClick={() =>
                    setAppearanceEditor((prev) =>
                      prev
                        ? {
                            ...prev,
                            tags: prev.tags.filter((entry) => entry !== tag)
                          }
                        : prev
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="mb-3 flex items-center gap-1">
            <input
              value={appearanceEditor.newTag}
              onChange={(event) => setAppearanceEditor((prev) => (prev ? { ...prev, newTag: event.target.value } : prev))}
              className="h-7 flex-1 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs outline-none"
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
                })
              }
            >
              <Plus size={12} weight="regular" />
              Add
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAppearanceEditor(null)}>
              ×
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                const draft = appearanceEditor;
                if (!draft) return;
                await window.ade.lanes.updateAppearance({
                  laneId: draft.laneId,
                  color: draft.color,
                  icon: draft.icon,
                  tags: draft.tags
                });
                setAppearanceEditor(null);
                await refreshLanes();
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      ) : null}

      {reparentDialog ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(780px,100%)] rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-float">
            <div className="mb-2 text-sm font-semibold text-fg">Confirm Lane Drop</div>
            {reparentDialog.integratePlan || reparentDialog.laneIds.length === 1 ? (
              <div className="mb-2 inline-flex rounded-lg border border-border/10 bg-card/60 p-0.5 text-xs">
                {reparentDialog.integratePlan ? (
                  <button
                    type="button"
                    className={cn(
                      "rounded px-2 py-1",
                      reparentDialog.actionMode === "integrate" ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg"
                    )}
                    onClick={() => setReparentDialog((prev) => (prev ? { ...prev, actionMode: "integrate" } : prev))}
                  >
                    Integrate
                  </button>
                ) : null}
                <button
                  type="button"
                  className={cn(
                    "rounded px-2 py-1",
                    reparentDialog.actionMode === "reparent" ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg"
                  )}
                  onClick={() => setReparentDialog((prev) => (prev ? { ...prev, actionMode: "reparent" } : prev))}
                >
                  Reparent
                </button>
                {reparentDialog.laneIds.length === 1 ? (
                  <button
                    type="button"
                    className={cn(
                      "rounded px-2 py-1",
                      reparentDialog.actionMode === "pr" ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg"
                    )}
                    onClick={() => setReparentDialog((prev) => (prev ? { ...prev, actionMode: "pr" } : prev))}
                  >
                    PR
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="mb-2 rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">
              {reparentDialog.actionMode === "integrate"
                ? "Integrate keeps stack ancestry unchanged and brings source lane commits into the target lane."
                : reparentDialog.actionMode === "pr"
                  ? "PR opens the pull request workflow for the dragged lane, targeting the drop base."
                : "Reparent changes stack ancestry. ADE rebases selected lane commits onto the target parent branch."}
            </div>
            {reparentDialog.actionMode === "integrate" && reparentDialog.integratePlan ? (
              <div className="mb-2 rounded-lg border border-border/10 bg-card/60 p-2 text-xs">
                <div className="font-semibold text-fg">{reparentDialog.integratePlan.summary}</div>
                <div className="mt-1 text-muted-fg">{reparentDialog.integratePlan.detail}</div>
              </div>
            ) : (
              <>
                <div className="mb-2 text-xs text-muted-fg">
                  Target parent: <span className="text-fg">{laneById.get(reparentDialog.targetLaneId)?.name ?? reparentDialog.targetLaneId}</span>
                </div>
                <div className="mb-2 rounded-lg border border-border/10 bg-card/60 p-2 text-xs">
                  {reparentDialog.laneIds.length === 1 ? (
                    <div>
                      {laneById.get(reparentDialog.laneIds[0]!)?.name ?? reparentDialog.laneIds[0]} → {laneById.get(reparentDialog.targetLaneId)?.name ?? reparentDialog.targetLaneId}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {reparentDialog.laneIds.map((laneId) => (
                        <div key={laneId}>
                          {laneById.get(laneId)?.name ?? laneId} → {laneById.get(reparentDialog.targetLaneId)?.name ?? reparentDialog.targetLaneId}
                        </div>
                      ))}
                    </div>
                  )}
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
            <div className="mb-3 max-h-[180px] overflow-auto rounded-lg border border-border/10 bg-card/60 p-2 text-xs">
              {reparentDialog.overlapFiles.length === 0
                ? "No overlaps."
                : reparentDialog.overlapFiles.slice(0, 12).map((file) => <div key={file}>{file}</div>)}
            </div>
            <div className="mb-3 text-xs text-amber-300">
              {reparentDialog.actionMode === "integrate"
                ? "If merge/rebase conflicts occur, resolve them in the target lane."
                : reparentDialog.actionMode === "pr"
                  ? "This does not change lane ancestry. It opens a PR flow targeting the drop base."
                : "If conflicts occur during rebase, resolve them in the target lane context."}
              {reparentDialog.actionMode === "reparent" && laneById.get(reparentDialog.targetLaneId)?.laneType === "primary"
                ? " Target is Primary: lane will now be based directly on Primary."
                : ""}
            </div>
            {reparentDialog.preview ? (
              <div className="mb-3 rounded-lg border border-border/10 bg-card/60 p-2 text-xs">
                <div>Preview outcome: {reparentDialog.preview.outcome}</div>
                <div>
                  files changed: {reparentDialog.preview.diffStat.filesChanged} · conflicts: {reparentDialog.preview.conflictingFiles.length}
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
                    const previewLaneAId =
                      reparentDialog.actionMode === "integrate"
                        ? reparentDialog.integratePlan?.laneId
                        : reparentDialog.laneIds[0];
                    const previewLaneBId =
                      reparentDialog.actionMode === "integrate"
                        ? reparentDialog.integratePlan?.sourceLaneId
                        : reparentDialog.targetLaneId;
                    if (!previewLaneAId || !previewLaneBId) return;
                    setReparentDialog((prev) => (prev ? { ...prev, previewBusy: true } : prev));
                    const preview = await window.ade.conflicts.simulateMerge({
                      laneAId: previewLaneAId,
                      laneBId: previewLaneBId
                    });
                    setReparentDialog((prev) => (prev ? { ...prev, previewBusy: false, preview } : prev));
                  }}
                >
                  {reparentDialog.actionMode === "integrate" ? "Preview integrate" : "Preview rebase"}
                </Button>
              ) : null}
              <Button size="sm" variant="primary" onClick={() => void applyReparent()}>
                {reparentDialog.actionMode === "integrate"
                  ? "Confirm Integrate"
                  : reparentDialog.actionMode === "pr"
                    ? "Open PR Dialog"
                    : "Confirm Reparent"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {prDialog ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(980px,100%)] rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-float">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-fg">
                {prDialog.existingPr ? `PR #${prDialog.existingPr.githubPrNumber}` : "Create Pull Request"}
              </div>
              <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setPrDialog(null)}>
                ×
              </button>
            </div>
            <div className="mb-3 text-xs text-muted-fg">
              {laneById.get(prDialog.laneId)?.name ?? prDialog.laneId} → {laneById.get(prDialog.baseLaneId)?.name ?? prDialog.baseLaneId} (base:{" "}
              <span className="text-fg">{prDialog.baseBranch}</span>)
            </div>

            {prDialog.error ? (
              <div className="mb-3 rounded bg-red-900/30 p-2 text-xs text-red-200">
                {prDialog.error}
              </div>
            ) : null}

            {!prDialog.existingPr ? (
              <div className="space-y-3">
                {prDialog.loadingDraft ? (
                  <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">
                    <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
                    Drafting description from pack…
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <input
                    className="h-9 rounded border border-border/15 bg-surface-recessed px-3 text-sm md:col-span-2"
                    placeholder="PR title"
                    value={prDialog.title}
                    onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
                  />
                  <label className="inline-flex h-9 items-center gap-2 rounded border border-border/15 bg-surface-recessed px-3 text-xs text-muted-fg">
                    <input
                      type="checkbox"
                      checked={prDialog.draft}
                      onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, draft: e.target.checked } : prev))}
                    />
                    Draft PR
                  </label>
                </div>

                <textarea
                  className="min-h-[240px] w-full rounded border border-border/15 bg-surface-recessed px-3 py-2 text-xs"
                  value={prDialog.body}
                  onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, body: e.target.value } : prev))}
                  placeholder="PR description (markdown)"
                />

                <div className="flex flex-wrap justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPrDialog(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={prDialog.creating || prDialog.loadingDraft}
                    onClick={() => {
                      const laneId = prDialog.laneId;
                      setPrDialog((prev) => (prev ? { ...prev, loadingDraft: true, error: null } : prev));
                      window.ade.prs
                        .draftDescription({ laneId })
                        .then((draft) => {
                          setPrDialog((prev) =>
                            prev && prev.laneId === laneId ? { ...prev, title: draft.title, body: draft.body, loadingDraft: false } : prev
                          );
                        })
                        .catch((error) => {
                          const message = error instanceof Error ? error.message : String(error);
                          setPrDialog((prev) => (prev && prev.laneId === laneId ? { ...prev, loadingDraft: false, error: message } : prev));
                        });
                    }}
                  >
                    Refresh Draft
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={prDialog.creating || !prDialog.title.trim() || !prDialog.body.trim()}
                    onClick={() => {
                      const laneId = prDialog.laneId;
                      setPrDialog((prev) => (prev ? { ...prev, creating: true, error: null } : prev));
                      window.ade.prs
                        .createFromLane({
                          laneId,
                          title: prDialog.title,
                          body: prDialog.body,
                          draft: prDialog.draft,
                          baseBranch: prDialog.baseBranch
                        })
                        .then(async (created) => {
                          const refreshed = await window.ade.prs.listWithConflicts();
                          setPrs(refreshed);
                          const createdPr = refreshed.find((entry) => entry.id === created.id) ?? null;
                          const [status, checks, reviews, comments] = await Promise.all([
                            window.ade.prs.getStatus(created.id).catch(() => null),
                            window.ade.prs.getChecks(created.id).catch(() => [] as PrCheck[]),
                            window.ade.prs.getReviews(created.id).catch(() => [] as PrReview[]),
                            window.ade.prs.getComments(created.id).catch(() => [] as PrComment[])
                          ]);
                          setPrDialog((prev) =>
                            prev && prev.laneId === laneId
                              ? {
                                  ...prev,
                                  creating: false,
                                  existingPr: createdPr,
                                  loadingDetails: false,
                                  status,
                                  checks,
                                  reviews,
                                  comments
                                }
                              : prev
                          );
                        })
                        .catch((error) => {
                          const message = error instanceof Error ? error.message : String(error);
                          setPrDialog((prev) => (prev && prev.laneId === laneId ? { ...prev, creating: false, error: message } : prev));
                        });
                    }}
                  >
                    {prDialog.creating ? "Creating…" : "Create PR"}
                  </Button>
                </div>
              </div>
            ) : prDialog.existingPr ? (
              <div className="flex h-[min(82vh,900px)] min-h-[680px] flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/10 bg-card/60 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">Graph Actions</span>
                    <InlinePrBadge {...getPrChecksBadge(prDialog.existingPr.checksStatus)} />
                    <InlinePrBadge {...getPrReviewsBadge(prDialog.existingPr.reviewStatus)} />
                    {prDialog.status ? (
                      <span className="text-muted-fg">
                        mergeable <span className="text-fg">{prDialog.status.isMergeable ? "yes" : "no"}</span> · behind <span className="text-fg">{prDialog.status.behindBaseBy}</span>
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-fg">merge method</span>
                    {(["merge", "squash", "rebase"] as MergeMethod[]).map((method) => (
                      <button
                        key={method}
                        type="button"
                        className={cn(
                          "rounded border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide",
                          prDialog.mergeMethod === method
                            ? "border-accent bg-accent/20 text-accent"
                            : "border-border/20 bg-surface-recessed text-muted-fg hover:text-fg"
                        )}
                        onClick={() => setPrDialog((prev) => (prev ? { ...prev, mergeMethod: method } : prev))}
                      >
                        {method}
                      </button>
                    ))}
                    <Button size="sm" variant="outline" disabled={prDialog.loadingDetails} onClick={() => void refreshPrDialogDetail()}>
                      Refresh
                    </Button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/10 bg-card">
                  <PrDetailPane
                    pr={prDialog.existingPr}
                    status={prDialog.status}
                    checks={prDialog.checks}
                    reviews={prDialog.reviews}
                    comments={prDialog.comments}
                    detailBusy={prDialog.loadingDetails}
                    lanes={lanes}
                    mergeMethod={prDialog.mergeMethod}
                    onRefresh={refreshPrDialogDetail}
                    onNavigate={(path) => navigate(path)}
                    onTabChange={() => {}}
                    onShowInGraph={(laneId) => navigate(`/graph?focusLane=${encodeURIComponent(laneId)}`)}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {integrationDialog ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(780px,100%)] rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-float">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-fg">Create Integration Lane</div>
              <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setIntegrationDialog(null)}>
                ×
              </button>
            </div>

            {integrationDialog.error ? (
              <div className="mb-2 rounded bg-red-900/30 p-2 text-xs text-red-200">
                {integrationDialog.error}
              </div>
            ) : null}

            <div className="mb-2 text-xs text-muted-fg">
              This will create a new lane under the inferred base lane and merge the selected lanes into it, while keeping the source lanes in their current stack positions.
            </div>

            {integrationDialog.targetLaneId ? (
              <div className="mb-2 text-xs text-muted-fg">
                Base lane: <span className="font-semibold text-fg">{laneById.get(integrationDialog.targetLaneId)?.name ?? integrationDialog.targetLaneId}</span>
              </div>
            ) : null}

            <input
              className="mb-2 h-9 w-full rounded border border-border/15 bg-surface-recessed px-3 text-sm"
              value={integrationDialog.name}
              onChange={(e) => setIntegrationDialog((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              placeholder="Integration lane name"
              disabled={integrationDialog.busy}
            />

            <div className="mb-3 max-h-[160px] overflow-auto rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">
              {integrationDialog.laneIds.map((laneId) => (
                <div key={laneId} className="truncate">
                  {laneById.get(laneId)?.name ?? laneId}
                </div>
              ))}
            </div>

            {integrationDialog.step ? (
              <div className="mb-3 rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">{integrationDialog.step}</div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={integrationDialog.busy} onClick={() => setIntegrationDialog(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={integrationDialog.busy || !integrationDialog.name.trim() || !(integrationDialog.targetLaneId || primaryLaneId)}
                onClick={() => {
                  const draft = integrationDialog;
                  if (!draft) return;
                  const targetParentLaneId = draft.targetLaneId ?? primaryLaneId;
                  if (!targetParentLaneId) {
                    setIntegrationDialog((prev) => (prev ? { ...prev, error: "Base lane not found." } : prev));
                    return;
                  }
                  const ordered = [...draft.laneIds].filter((id) => id !== targetParentLaneId);
                  setIntegrationDialog((prev) => (prev ? { ...prev, busy: true, error: null, step: "Creating integration lane…" } : prev));
                  window.ade.lanes
                    .createChild({ parentLaneId: targetParentLaneId, name: draft.name.trim() })
                    .then(async (newLane) => {
                      for (const sourceLaneId of ordered) {
                        const source = laneById.get(sourceLaneId);
                        if (!source) continue;
                        setIntegrationDialog((prev) =>
                          prev ? { ...prev, step: `Merging ${source.name}…` } : prev
                        );
                        await window.ade.git.sync({
                          laneId: newLane.id,
                          mode: "merge",
                          baseRef: source.branchRef
                        });
                      }
                      setIntegrationDialog((prev) => (prev ? { ...prev, step: "Done." } : prev));
                      window.setTimeout(() => setIntegrationDialog(null), 300);
                      await refreshLanes();
                      await refreshIntegrationProposals();
                      setSelectedLaneIds([newLane.id]);
                      navigate(`/lanes?laneId=${encodeURIComponent(newLane.id)}&focus=single`);
                    })
                    .catch((error) => {
                      const message = error instanceof Error ? error.message : String(error);
                      setIntegrationDialog((prev) => (prev ? { ...prev, busy: false, error: message, step: null } : prev));
                    });
                }}
              >
                {integrationDialog.busy ? "Working…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedLane ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[60] flex justify-center">
          <div className="pointer-events-auto w-[min(1120px,calc(100%-24px))] rounded border border-border/10 bg-card/95 px-3 py-2 shadow-float backdrop-blur-sm">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-fg">{selectedLane.name}</div>
                <div className="mt-1 truncate text-[11px] text-muted-fg">{selectedLane.branchRef}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                  <Chip className={cn("px-1.5 py-0", selectedLane.status.dirty ? "text-amber-300" : "text-emerald-300")}>
                    {selectedLane.status.dirty ? "Dirty" : "Clean"}
                  </Chip>
                  {selectedLaneSyncSummary ? (
                    <Chip className={cn("px-1.5 py-0", selectedLaneSyncSummary.tone)}>
                      {selectedLaneSyncSummary.label}
                    </Chip>
                  ) : null}
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
                  onClick={() => navigate(`/lanes?laneId=${encodeURIComponent(selectedLane.id)}&focus=single`)}
                >
                  Open Lane
                </Button>
                <Button
                  size="sm"
                  variant={selectedLanePr ? "primary" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  disabled={!selectedLanePr && !selectedLaneCanCreatePr}
                  onClick={() => {
                    if (selectedLanePr && selectedLaneOverlay) {
                      openExistingPrDetail(selectedLaneOverlay);
                      return;
                    }
                    const baseLaneId = getBaseLaneIdForLane(selectedLane.id);
                    if (!baseLaneId) return;
                    openPrDialogForLane(selectedLane.id, baseLaneId);
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
                    <div className="absolute bottom-9 right-0 z-[70] w-[220px] rounded border border-border/10 bg-card/95 p-1 text-xs shadow-float backdrop-blur-sm">
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
                                : "text-fg hover:bg-card/80"
                          )}
                          disabled={item.disabled}
                          onClick={() => {
                            setSingleActionsOpen(false);
                            void runLaneAction(selectedLane.id, item.key, {
                              appearanceAnchor: {
                                x: Math.max(24, window.innerWidth - 380),
                                y: Math.max(24, window.innerHeight - 360)
                              }
                            });
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
          <div className="pointer-events-auto rounded border border-border/10 bg-card/95 backdrop-blur-sm px-3 py-2 shadow-float">
            <div className="mb-1 text-[11px] text-muted-fg">{selectedLaneIds.length} lanes selected</div>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="primary"
                className="h-7 px-2 text-[11px]"
                onClick={openCreateIntegrationDialog}
              >
                Create Integration Lane
              </Button>
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
                  <div className="absolute bottom-9 right-0 z-[70] w-[200px] rounded border border-border/10 bg-card/95 p-1 text-xs shadow-float backdrop-blur-sm">
                    {batchActionItems.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={cn(
                          "flex w-full items-center rounded px-2 py-1.5 text-left",
                          item.danger ? "text-red-200 hover:bg-red-900/20" : "text-fg hover:bg-card/80"
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
                  {batchOperationLabel(batchStatus.operation)} lane {Math.min(batchStatus.steps.length, batchStatus.activeIndex + 1)}/{batchStatus.steps.length}: {batchStatus.steps[batchStatus.activeIndex]?.laneName ?? "pending"}
                </div>
                <div className="mb-1 h-1.5 w-full rounded bg-muted">
                  <div
                    className="h-1.5 rounded bg-accent transition-all"
                    style={{ width: `${(batchStatus.steps.filter((step) => step.status === "done" || step.status === "failed" || step.status === "skipped").length / Math.max(1, batchStatus.steps.length)) * 100}%` }}
                  />
                </div>
                <div className="max-h-[90px] overflow-auto rounded border border-border/10 bg-card/60 p-1">
                  {batchStatus.steps.map((step) => (
                    <div key={step.laneId} className="flex items-center justify-between gap-2">
                      <span className="truncate">{step.laneName}</span>
                      <span className="text-right text-muted-fg">
                        {step.status === "running" ? "⟳ running" : step.status === "done" ? "✓ done" : step.status === "failed" ? "✗ failed" : step.status === "skipped" ? "⚠ skipped" : "⏳ pending"}
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
        <div className={cn("absolute left-3 right-3 z-[84] rounded bg-amber-900/25 px-3 py-2 text-xs text-amber-100", truncatedBannerTopClass)}>
          <div className="flex items-center justify-between gap-2">
            <div>
              Too many lanes for automatic risk assessment. Showing {batch.comparedLaneIds?.length ?? batch.maxAutoLanes ?? 15} of {batch.totalLanes ?? lanes.length} lanes.
            </div>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setShowFiltersPanel(true)}>
              Filter Lanes
            </Button>
          </div>
        </div>
      ) : null}

      {errorBanner ? (
        <div className={cn("absolute left-3 right-3 z-[85] rounded bg-red-900/35 px-3 py-2 text-xs text-red-100", errorBannerTopClass)}>
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5">
              <Warning size={14} weight="regular" />
              {errorBanner}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => {
                setErrorBanner(null);
                void refreshRiskBatch().catch(() => {});
              }}>
                Retry
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setErrorBanner(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {undoToast ? (
        <div className="absolute bottom-3 right-3 z-[90] rounded bg-card/95 px-3 py-2 text-xs shadow-float">
          <div className="mb-1">{undoToast.message}</div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setUndoToast(null)}>
              Close
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                void undoToast
                  .undoAction()
                  .catch((error) => setErrorBanner(error instanceof Error ? error.message : String(error)))
                  .finally(() => setUndoToast(null));
              }}
            >
              Undo
            </Button>
          </div>
        </div>
      ) : null}

      {edgeSimulation ? (
        <div className={cn("absolute right-3 z-[89] w-[360px] rounded border border-border/10 bg-card/95 p-3 text-xs shadow-float backdrop-blur-sm", edgeSimulationTopClass)}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="font-semibold text-fg">Merge Simulation</div>
            <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setEdgeSimulation(null)}>
              ×
            </button>
          </div>
          <div className="mb-2 text-muted-fg">
            {(laneById.get(edgeSimulation.laneAId)?.name ?? edgeSimulation.laneAId)} → {(laneById.get(edgeSimulation.laneBId)?.name ?? edgeSimulation.laneBId)}
          </div>
          {edgeSimulation.loading ? (
            <div className="rounded-lg border border-border/10 bg-card/60 p-3 text-muted-fg">
              <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
              <div>Running merge simulation…</div>
            </div>
          ) : edgeSimulation.error ? (
            <div className="rounded bg-red-900/30 p-2 text-red-200">
              <div className="font-medium">Simulation failed</div>
              <div className="mt-1 font-mono text-[11px]">{edgeSimulation.error}</div>
            </div>
          ) : edgeSimulation.result ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-border/10 bg-card/60 p-2">
                <div>Outcome: <span className="font-semibold text-fg">{edgeSimulation.result.outcome}</span></div>
                <div className="text-muted-fg">
                  files changed: {edgeSimulation.result.diffStat.filesChanged} · insertions: {edgeSimulation.result.diffStat.insertions} · deletions: {edgeSimulation.result.diffStat.deletions}
                </div>
              </div>
              <div className="max-h-[180px] overflow-auto rounded-lg border border-border/10 bg-card/60 p-2">
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
        <GraphConflictPanel
          conflictPanel={conflictPanel}
          setConflictPanel={setConflictPanel}
          laneById={laneById}
          overlapFilesByPair={overlapFilesByPair}
          refreshRiskBatch={refreshRiskBatch}
          refreshLanes={refreshLanes}
        />
      ) : null}

      {showRiskMatrix ? (
        <div
          className="absolute bottom-3 left-3 z-[88] rounded-lg border border-border/10 bg-card/95 p-3 shadow-float backdrop-blur-sm"
          style={{ right: conflictPanel ? 450 : 12 }}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-fg">Pair Matrix</div>
              <div className="text-[11px] text-muted-fg">
                Pairwise overlap and conflict risk across {lanes.length} lane{lanes.length === 1 ? "" : "s"}.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void refreshRiskBatch()}>
                Refresh
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setShowRiskMatrix(false)}>
                Close
              </Button>
            </div>
          </div>
          <div className="max-h-[340px] overflow-auto">
            <RiskMatrix
              lanes={lanes}
              entries={batch?.matrix ?? []}
              overlaps={batch?.overlaps ?? []}
              selectedPair={
                conflictPanel
                  ? { laneAId: conflictPanel.laneAId, laneBId: conflictPanel.laneBId }
                  : null
              }
              loading={loadingRisk}
              progress={batchProgress ? { completedPairs: batchProgress.completedPairs, totalPairs: batchProgress.totalPairs } : null}
              onSelectPair={(pair) => {
                openConflictPanelForEdge(pair.laneAId, pair.laneBId);
              }}
            />
          </div>
        </div>
      ) : null}

      {nodeTooltip && hoveredTooltipLane ? (
        <div
          className="pointer-events-none fixed z-[92] min-w-[240px] rounded border border-border/10 bg-card/95 backdrop-blur-sm px-2.5 py-2 text-[11px] shadow-float ade-tooltip-motion ade-tooltip-open"
          style={{ left: nodeTooltip.x, top: nodeTooltip.y }}
        >
          <div className="font-semibold text-fg">{hoveredTooltipLane.name}</div>
          <div className="truncate text-muted-fg">{hoveredTooltipLane.branchRef}</div>
          <div className="mt-1 text-muted-fg">dirty changes: {hoveredTooltipLane.status.dirty ? "yes" : "no"}</div>
          <div className="text-muted-fg">last activity: {toRelativeTime(lastActivityByLaneId[hoveredTooltipLane.id] ?? null)}</div>
          <div className="mt-1 text-muted-fg">
            pack deterministic: {nodeTooltipPack ? toRelativeTime(nodeTooltipPack.deterministicUpdatedAt) : "loading…"}
          </div>
          <div className="text-muted-fg">
            pack narrative: {nodeTooltipPack ? toRelativeTime(nodeTooltipPack.narrativeUpdatedAt) : "loading…"}
          </div>
        </div>
      ) : null}

      {textPrompt ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(460px,100%)] rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-float">
            <div className="text-sm font-semibold text-fg">{textPrompt.title}</div>
            {textPrompt.message ? (
              <div className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-lg border border-border/10 bg-card/60 px-2 py-1 text-[11px] text-muted-fg">
                {textPrompt.message}
              </div>
            ) : null}
            <input
              autoFocus
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
              className="mt-3 h-9 w-full rounded border border-border/15 bg-surface-recessed px-2 text-sm outline-none focus:ring-1 focus:ring-accent"
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
          className="pointer-events-none fixed z-[91] max-w-[420px] whitespace-pre-wrap rounded border border-border/10 bg-card/95 backdrop-blur-sm px-2 py-1 text-[11px] text-fg shadow-float"
          style={{ left: edgeHover.x, top: edgeHover.y }}
        >
          {edgeHover.label}
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceGraphPage() {
  return (
    <div className="h-full">
      <ReactFlowProvider>
        <GraphInner />
      </ReactFlowProvider>
    </div>
  );
}
