import "@xyflow/react/dist/style.css";
import React from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  MarkerType,
  MiniMap,
  Node,
  NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  useReactFlow
} from "@xyflow/react";
import { AlertTriangle, ArrowUpRight, Filter, Flag, GitBranch, Layers3, Plus, Search, Shield, Sparkles, Star, Tag, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type {
  BatchAssessmentResult,
  ConflictStatus,
  ConflictProposal,
  ConflictProposalPreview,
  GraphFilterState,
  GraphLayoutPreset,
  GraphLayoutSnapshot,
  GraphPersistedState,
  GraphStatusFilter,
  GraphViewMode,
  GitSyncMode,
  LaneIcon,
  LaneSummary,
  MergeMethod,
  MergeSimulationResult,
  PackSummary,
  PrCheck,
  PrReview,
  PrReviewStatus,
  PrState,
  PrStatus,
  PrSummary
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";

type GraphNodeData = {
  lane: LaneSummary;
  status: ConflictStatus["status"] | "unknown";
  activeSessions: number;
  collapsedChildCount: number;
  dimmed: boolean;
  activityBucket: "min" | "low" | "medium" | "high";
  viewMode: GraphViewMode;
  lastActivityAt: string | null;
  highlight: boolean;
  restackFailed: boolean;
  restackPulse: boolean;
  mergeInProgress: boolean;
  mergeDisappearing: boolean;
};

type GraphPrOverlay = {
  prId: string;
  laneId: string;
  baseLaneId: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  checksStatus: PrStatus["checksStatus"];
  reviewStatus: PrReviewStatus;
  lastSyncedAt: string | null;
  mergeInProgress: boolean;
};

type GraphEdgeData = {
  edgeType: "topology" | "stack" | "risk";
  riskLevel?: "none" | "low" | "medium" | "high";
  overlapCount?: number;
  stale?: boolean;
  dimmed?: boolean;
  highlight?: boolean;
  pr?: GraphPrOverlay;
};

type BatchStepStatus = "pending" | "running" | "done" | "failed" | "skipped";
type BatchStep = {
  laneId: string;
  laneName: string;
  status: BatchStepStatus;
  error?: string;
};

type BatchProgress = { completedPairs: number; totalPairs: number };

type GraphTextPromptState = {
  title: string;
  message?: string;
  placeholder?: string;
  value: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

type PrDialogState = {
  laneId: string;
  baseLaneId: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
  loadingDraft: boolean;
  creating: boolean;
  existingPr: PrSummary | null;
  loadingDetails: boolean;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  mergeMethod: MergeMethod;
  merging: boolean;
  error: string | null;
};

type ConflictPanelState = {
  laneAId: string;
  laneBId: string;
  loading: boolean;
  result: MergeSimulationResult | null;
  error: string | null;
  applyLaneId: string;
  preview: ConflictProposalPreview | null;
  preparing: boolean;
  proposal: ConflictProposal | null;
  proposing: boolean;
  applyMode: "unstaged" | "staged" | "commit";
  commitMessage: string;
  applying: boolean;
};

type IntegrationDialogState = {
  laneIds: string[];
  name: string;
  busy: boolean;
  step: string | null;
  error: string | null;
};

const VIEW_MODES: GraphViewMode[] = ["stack", "risk", "activity", "all"];
const ICON_OPTIONS: Array<{ key: LaneIcon; label: string; icon: React.ReactNode }> = [
  { key: null, label: "None", icon: <span className="text-xs">○</span> },
  { key: "star", label: "Star", icon: <Star className="h-3.5 w-3.5" /> },
  { key: "flag", label: "Flag", icon: <Flag className="h-3.5 w-3.5" /> },
  { key: "bolt", label: "Bolt", icon: <Zap className="h-3.5 w-3.5" /> },
  { key: "shield", label: "Shield", icon: <Shield className="h-3.5 w-3.5" /> },
  { key: "tag", label: "Tag", icon: <Tag className="h-3.5 w-3.5" /> }
];
const COLOR_PALETTE = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#9333ea", "#1f2937", "#f8fafc"];
const DEFAULT_PRESET = "__default__";
const BATCH_OPERATION_LABELS: Record<string, string> = {
  restack: "Rebase",
  push: "Push",
  fetch: "Fetch",
  archive: "Archive",
  delete: "Delete",
  sync: "Pull"
};

function batchOperationLabel(operation: string): string {
  return BATCH_OPERATION_LABELS[operation] ?? operation;
}

function edgePairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  if (setA.size !== b.length) return false;
  for (const id of b) {
    if (!setA.has(id)) return false;
  }
  return true;
}

function toRelativeTime(iso: string | null): string {
  if (!iso) return "No recent activity";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "No recent activity";
  const delta = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "active just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function buildDefaultFilter(): GraphFilterState {
  return {
    status: [],
    laneTypes: [],
    tags: [],
    hidePrimary: false,
    hideAttached: false,
    hideArchived: true,
    rootLaneId: null,
    search: ""
  };
}

function createSnapshot(viewMode: GraphViewMode): GraphLayoutSnapshot {
  return {
    nodePositions: {},
    collapsedLaneIds: [],
    viewMode,
    filters: buildDefaultFilter(),
    updatedAt: new Date().toISOString()
  };
}

function createDefaultState(): GraphPersistedState {
  const basePreset: GraphLayoutPreset = {
    name: DEFAULT_PRESET,
    byViewMode: {
      stack: createSnapshot("stack"),
      risk: createSnapshot("risk"),
      activity: createSnapshot("activity"),
      all: createSnapshot("all")
    },
    updatedAt: new Date().toISOString()
  };
  return {
    presets: [basePreset],
    activePreset: DEFAULT_PRESET
  };
}

function ensureGraphState(state: GraphPersistedState | null | undefined): GraphPersistedState {
  if (!state || !Array.isArray(state.presets) || state.presets.length === 0) {
    return createDefaultState();
  }
  const validPreset = state.presets.find((preset) => preset.name === state.activePreset) ?? state.presets[0]!;
  const normalizeSnapshot = (viewMode: GraphViewMode): GraphLayoutSnapshot => {
    const existing = validPreset.byViewMode?.[viewMode];
    if (!existing) return createSnapshot(viewMode);
    return {
      nodePositions: existing.nodePositions ?? {},
      collapsedLaneIds: existing.collapsedLaneIds ?? [],
      viewMode,
      filters: existing.filters ?? buildDefaultFilter(),
      updatedAt: existing.updatedAt ?? new Date().toISOString()
    };
  };
  return {
    activePreset: validPreset.name,
    presets: state.presets.map((preset) => ({
      name: preset.name,
      updatedAt: preset.updatedAt ?? new Date().toISOString(),
      byViewMode: {
        stack: preset.byViewMode?.stack ? { ...normalizeSnapshot("stack"), ...preset.byViewMode.stack, viewMode: "stack" } : createSnapshot("stack"),
        risk: preset.byViewMode?.risk ? { ...normalizeSnapshot("risk"), ...preset.byViewMode.risk, viewMode: "risk" } : createSnapshot("risk"),
        activity: preset.byViewMode?.activity ? { ...normalizeSnapshot("activity"), ...preset.byViewMode.activity, viewMode: "activity" } : createSnapshot("activity"),
        all: preset.byViewMode?.all ? { ...normalizeSnapshot("all"), ...preset.byViewMode.all, viewMode: "all" } : createSnapshot("all")
      }
    }))
  };
}

function laneStatusGroup(status: ConflictStatus["status"] | undefined): GraphStatusFilter {
  if (status === "conflict-active" || status === "conflict-predicted") return "conflict";
  if (status === "behind-base") return "at-risk";
  if (status === "merge-ready") return "clean";
  return "unknown";
}

function riskStrokeColor(level: GraphEdgeData["riskLevel"]): string {
  if (level === "high") return "#dc2626";
  if (level === "medium") return "#f59e0b";
  if (level === "low") return "#16a34a";
  return "#6b7280";
}

function prOverlayColor(pr: GraphPrOverlay): string {
  if (pr.state === "draft") return "#a855f7";
  if (pr.checksStatus === "failing") return "#dc2626";
  if (pr.reviewStatus === "changes_requested") return "#f59e0b";
  if (pr.checksStatus === "passing") return "#16a34a";
  if (pr.checksStatus === "pending") return "#38bdf8";
  return "#6b7280";
}

function prCiDotColor(pr: GraphPrOverlay): string {
  if (pr.checksStatus === "failing") return "#dc2626";
  if (pr.checksStatus === "passing") return "#16a34a";
  if (pr.checksStatus === "pending") return "#f59e0b";
  return "#6b7280";
}

function iconGlyph(icon: LaneIcon): React.ReactNode {
  if (icon === "star") return <Star className="h-3.5 w-3.5" />;
  if (icon === "flag") return <Flag className="h-3.5 w-3.5" />;
  if (icon === "bolt") return <Zap className="h-3.5 w-3.5" />;
  if (icon === "shield") return <Shield className="h-3.5 w-3.5" />;
  if (icon === "tag") return <Tag className="h-3.5 w-3.5" />;
  return null;
}

function nodeDimensions(lane: LaneSummary, bucket: GraphNodeData["activityBucket"], mode: GraphViewMode): { width: number; height: number } {
  if (mode === "activity") {
    if (bucket === "min") return { width: 100, height: 50 };
    if (bucket === "low") return { width: 130, height: 65 };
    if (bucket === "high") return { width: 200, height: 100 };
    return { width: 160, height: 80 };
  }
  if (lane.laneType === "primary") return { width: 200, height: 100 };
  return { width: 160, height: 80 };
}

function buildTreeDepth(lanes: LaneSummary[]): Map<string, number> {
  const byId = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const cache = new Map<string, number>();
  const visit = (laneId: string): number => {
    const existing = cache.get(laneId);
    if (existing != null) return existing;
    const lane = byId.get(laneId);
    if (!lane || !lane.parentLaneId || !byId.has(lane.parentLaneId)) {
      cache.set(laneId, 0);
      return 0;
    }
    const depth = visit(lane.parentLaneId) + 1;
    cache.set(laneId, depth);
    return depth;
  };
  for (const lane of lanes) visit(lane.id);
  return cache;
}

function computeAutoLayout(
  lanes: LaneSummary[],
  viewMode: GraphViewMode,
  activityScoreByLaneId: Record<string, number>
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (lanes.length === 0) return positions;

  if (viewMode === "stack") {
    const depthMap = buildTreeDepth(lanes);
    const lanesByDepth = new Map<number, LaneSummary[]>();
    for (const lane of lanes) {
      const depth = depthMap.get(lane.id) ?? 0;
      const list = lanesByDepth.get(depth) ?? [];
      list.push(lane);
      lanesByDepth.set(depth, list);
    }
    for (const [depth, levelLanes] of lanesByDepth.entries()) {
      levelLanes.sort((a, b) => a.name.localeCompare(b.name));
      levelLanes.forEach((lane, index) => {
        positions[lane.id] = { x: index * 220, y: depth * 170 };
      });
    }
    return positions;
  }

  if (viewMode === "risk") {
    const radius = Math.max(180, lanes.length * 24);
    const centerX = 380;
    const centerY = 260;
    lanes.forEach((lane, index) => {
      const angle = (index / lanes.length) * Math.PI * 2;
      positions[lane.id] = {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      };
    });
    return positions;
  }

  if (viewMode === "activity") {
    const sorted = [...lanes].sort((a, b) => (activityScoreByLaneId[b.id] ?? 0) - (activityScoreByLaneId[a.id] ?? 0));
    const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
    sorted.forEach((lane, index) => {
      positions[lane.id] = {
        x: (index % cols) * 230,
        y: Math.floor(index / cols) * 180
      };
    });
    return positions;
  }

  const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0]!;
  positions[primary.id] = { x: 420, y: 240 };
  const rest = lanes.filter((lane) => lane.id !== primary.id);
  const radius = Math.max(180, rest.length * 22);
  rest.forEach((lane, index) => {
    const angle = (index / Math.max(1, rest.length)) * Math.PI * 2;
    positions[lane.id] = {
      x: 420 + Math.cos(angle) * radius,
      y: 240 + Math.sin(angle) * radius
    };
  });
  return positions;
}

function collectDescendants(lanes: LaneSummary[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const lane of lanes) {
    if (!lane.parentLaneId) continue;
    const list = childrenByParent.get(lane.parentLaneId) ?? [];
    list.push(lane.id);
    childrenByParent.set(lane.parentLaneId, list);
  }
  const out = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

function GraphLaneNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const lane = data.lane;
  const dimensions = nodeDimensions(lane, data.activityBucket, data.viewMode);
  const statusColor =
    data.status === "conflict-active" || data.status === "conflict-predicted"
      ? "text-red-300"
      : data.status === "behind-base"
        ? "text-amber-300"
        : data.status === "merge-ready"
          ? "text-emerald-300"
          : "text-muted-fg";

  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-card/90 px-2 py-1.5 text-[11px] shadow-sm transition-all duration-150",
        lane.laneType === "attached" ? "border-dashed text-muted-fg" : "border-border text-fg",
        lane.laneType === "primary" && "border-[3px] border-accent",
        selected && "ring-2 ring-accent",
        data.dimmed && "opacity-20 scale-50",
        data.highlight && "scale-[1.02] shadow-[0_2px_8px_rgba(0,0,0,0.2)]",
        data.activityBucket === "high" && "shadow-[0_0_18px_rgba(34,197,94,0.2)]",
        data.restackFailed && "border-red-500 ring-1 ring-red-500/80",
        data.restackPulse && "ade-node-failed-pulse",
        data.mergeInProgress && "ade-node-merging",
        data.mergeDisappearing && "ade-node-disappear"
      )}
      style={{
        width: dimensions.width,
        minHeight: dimensions.height,
        borderColor: lane.color ?? undefined
      }}
    >
      <div className="flex items-center gap-1">
        {iconGlyph(lane.icon)}
        <span className="truncate font-semibold">{lane.name}</span>
      </div>
      <div className="truncate text-[10px] text-muted-fg">{lane.branchRef}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Chip className="px-1 py-0 text-[10px]">{lane.status.dirty ? "dirty" : "clean"}</Chip>
        <Chip className="px-1 py-0 text-[10px]">{lane.status.ahead}↑/{lane.status.behind}↓</Chip>
        <Chip className={cn("px-1 py-0 text-[10px]", statusColor)}>{data.status}</Chip>
        {data.mergeInProgress ? <Chip className="px-1 py-0 text-[10px] text-accent">merging</Chip> : null}
        {data.activeSessions > 0 ? <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" title="Active sessions" /> : null}
      </div>
      {lane.tags.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {lane.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded border border-border px-1 text-[10px] text-muted-fg">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {data.collapsedChildCount > 0 ? (
        <div className="mt-1 inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1 text-[10px]">
          <Layers3 className="h-3 w-3" />
          {data.collapsedChildCount} children
        </div>
      ) : null}
      <Handle
        id="target"
        type="target"
        position={Position.Top}
        style={{ width: 8, height: 8, opacity: 0, pointerEvents: "none", border: 0, background: "transparent" }}
      />
      <Handle
        id="source"
        type="source"
        position={Position.Bottom}
        style={{ width: 8, height: 8, opacity: 0, pointerEvents: "none", border: 0, background: "transparent" }}
      />
      <div className="pointer-events-none absolute inset-0 rounded-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:shadow-[0_2px_8px_rgba(0,0,0,0.2)]" />
    </div>
  );
}

function RiskEdge(props: EdgeProps<Edge<GraphEdgeData>>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data, selected } = props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: sourcePosition ?? Position.Bottom,
    targetPosition: targetPosition ?? Position.Top
  });
  const pr = data?.pr;
  const color =
    data?.edgeType === "risk"
      ? riskStrokeColor(data.riskLevel)
      : pr
        ? prOverlayColor(pr)
        : data?.edgeType === "stack"
          ? "#38bdf8"
          : "#6b7280";
  const width = pr && data?.edgeType !== "risk" ? 2.6 : data?.edgeType === "stack" ? 3 : 1.8;
  const dash = data?.edgeType === "risk" ? "5 3" : undefined;
  const effectiveWidth = (selected ? width + 1 : width) + (data?.highlight ? 0.5 : 0);
  const effectiveOpacity = data?.dimmed ? 0.16 : data?.highlight ? 1 : data?.stale ? 0.55 : 0.9;
  const badgeColor = pr ? prOverlayColor(pr) : "#6b7280";
  const dotColor = pr ? prCiDotColor(pr) : "#6b7280";
  const badgeText = pr ? `PR #${pr.number}` : "";
  const badgeWidth = Math.max(64, badgeText.length * 6 + 26);
  const badgeHeight = 18;
  return (
    <g>
      <path
        id={id}
        className="ade-edge-path"
        d={path}
        markerEnd={markerEnd}
        fill="none"
        stroke={color}
        strokeWidth={effectiveWidth}
        strokeDasharray={dash}
        opacity={effectiveOpacity}
      />
      {pr ? (
        <g transform={`translate(${labelX}, ${labelY})`} className={pr.mergeInProgress ? "ade-pr-badge-pulse" : undefined}>
          <rect
            x={-badgeWidth / 2}
            y={-badgeHeight / 2}
            width={badgeWidth}
            height={badgeHeight}
            rx={8}
            fill={badgeColor}
            fillOpacity={0.18}
            stroke={badgeColor}
            strokeOpacity={0.75}
            strokeWidth={1}
          />
          <circle
            cx={-badgeWidth / 2 + 10}
            cy={0}
            r={3}
            fill={dotColor}
            className={pr.checksStatus === "pending" ? "ade-pr-ci-pending" : undefined}
          />
          <text
            x={-badgeWidth / 2 + 18}
            y={3}
            fontSize={10}
            fill="var(--color-fg)"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace"
          >
            {badgeText}
          </text>
        </g>
      ) : null}
    </g>
  );
}

const nodeTypes = { lane: GraphLaneNode };
const edgeTypes = { custom: RiskEdge };

function GraphInner() {
  const navigate = useNavigate();
  const reactFlow = useReactFlow<Node<GraphNodeData>, Edge<GraphEdgeData>>();
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [prs, setPrs] = React.useState<PrSummary[]>([]);
  const [loadingPrs, setLoadingPrs] = React.useState(true);

  const refreshPrs = React.useCallback(async () => {
    const next = await window.ade.prs.refresh();
    setPrs(next);
  }, []);

  const [viewMode, setViewMode] = React.useState<GraphViewMode>("all");
  const [graphState, setGraphState] = React.useState<GraphPersistedState>(createDefaultState());
  const [loadedGraphState, setLoadedGraphState] = React.useState(false);
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
  const [conflictPanel, setConflictPanel] = React.useState<ConflictPanelState | null>(null);
  const [integrationDialog, setIntegrationDialog] = React.useState<IntegrationDialogState | null>(null);
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
  const [nodeTooltipPack, setNodeTooltipPack] = React.useState<PackSummary | null>(null);
  const [restackFailedLaneId, setRestackFailedLaneId] = React.useState<string | null>(null);
  const [restackFailedPulse, setRestackFailedPulse] = React.useState(false);
  const [textPrompt, setTextPrompt] = React.useState<GraphTextPromptState | null>(null);
  const [textPromptError, setTextPromptError] = React.useState<string | null>(null);

  const persistTimerRef = React.useRef<number | null>(null);
  const riskRefreshTimerRef = React.useRef<number | null>(null);
  const dragOriginRef = React.useRef<Map<string, { x: number; y: number }>>(new Map());
  const dropPreviewTimerRef = React.useRef<number | null>(null);
  const nodeHoverTimerRef = React.useRef<number | null>(null);
  const lastFitViewKeyRef = React.useRef<string>("");
  const nodeDragActiveRef = React.useRef(false);
  const filtersPanelRef = React.useRef<HTMLDivElement | null>(null);
  const [showFiltersPanel, setShowFiltersPanel] = React.useState(false);

  const preset = React.useMemo(() => {
    const ensured = ensureGraphState(graphState);
    return ensured.presets.find((entry) => entry.name === ensured.activePreset) ?? ensured.presets[0]!;
  }, [graphState]);

  const activeSnapshot = React.useMemo(() => preset.byViewMode[viewMode], [preset, viewMode]);
  const filters = activeSnapshot.filters;

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
  const laneIdByBranchRef = React.useMemo(() => new Map(lanes.map((lane) => [lane.branchRef, lane.id] as const)), [lanes]);
  const prByLaneId = React.useMemo(() => new Map(prs.map((pr) => [pr.laneId, pr] as const)), [prs]);
  const prOverlayByPair = React.useMemo(() => {
    const map = new Map<string, GraphPrOverlay>();
    for (const pr of prs) {
      const lane = laneById.get(pr.laneId);
      if (!lane) continue;
      const baseLaneId = laneIdByBranchRef.get(pr.baseBranch) ?? lane.parentLaneId ?? primaryLaneId;
      if (!baseLaneId) continue;
      map.set(edgePairKey(baseLaneId, pr.laneId), {
        prId: pr.id,
        laneId: pr.laneId,
        baseLaneId,
        number: pr.githubPrNumber,
        title: pr.title,
        url: pr.githubUrl,
        state: pr.state,
        checksStatus: pr.checksStatus,
        reviewStatus: pr.reviewStatus,
        lastSyncedAt: pr.lastSyncedAt ?? null,
        mergeInProgress: Boolean(mergeInProgressByLaneId[pr.laneId])
      });
    }
    return map;
  }, [laneById, laneIdByBranchRef, mergeInProgressByLaneId, primaryLaneId, prs]);

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

    return connected;
  }, [hoveredNodeId, lanes, riskByPair, viewMode]);

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
      setGraphState((prev) => {
        const ensured = ensureGraphState(prev);
        const nextPresets = ensured.presets.map((presetItem) => {
          if (presetItem.name !== ensured.activePreset) return presetItem;
          const currentSnapshot = presetItem.byViewMode[viewMode];
          const nextSnapshot = updater(currentSnapshot);
          return {
            ...presetItem,
            updatedAt: new Date().toISOString(),
            byViewMode: {
              ...presetItem.byViewMode,
              [viewMode]: { ...nextSnapshot, updatedAt: new Date().toISOString(), viewMode }
            }
          };
        });
        const nextState = { ...ensured, presets: nextPresets };
        if (persistTimerRef.current != null) {
          window.clearTimeout(persistTimerRef.current);
        }
        persistTimerRef.current = window.setTimeout(() => {
          if (project?.rootPath) {
            void window.ade.graphState.set(project.rootPath, nextState).catch(() => {});
          }
        }, 250);
        return nextState;
      });
    },
    [project?.rootPath, viewMode]
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

  React.useEffect(() => {
    setLoadingTopology(true);
    void refreshLanes()
      .catch(() => {})
      .finally(() => setLoadingTopology(false));
    void refreshRiskBatch();
    void refreshActivity();
  }, [refreshLanes, refreshRiskBatch, refreshActivity]);

  React.useEffect(() => {
    let cancelled = false;
    setLoadingPrs(true);
    window.ade.prs
      .listAll()
      .then((list) => {
        if (cancelled) return;
        setPrs(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingPrs(false);
      });

    const unsub = window.ade.prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      if (cancelled) return;
      setPrs(event.prs);
      setLoadingPrs(false);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  React.useEffect(() => {
    if (!project?.rootPath) return;
    setLoadedGraphState(false);
    void window.ade.graphState
      .get(project.rootPath)
      .then((state) => {
        setGraphState(ensureGraphState(state));
      })
      .catch(() => {
        setGraphState(createDefaultState());
      })
      .finally(() => {
        setLoadedGraphState(true);
      });
  }, [project?.rootPath]);

  React.useEffect(() => {
    if (!undoToast) return;
    const timer = window.setTimeout(() => setUndoToast(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [undoToast]);

  React.useEffect(() => {
    const laneId = nodeTooltip?.laneId ?? null;
    if (!laneId) {
      setNodeTooltipPack(null);
      return;
    }
    let cancelled = false;
    setNodeTooltipPack(null);
    window.ade.packs
      .getLanePack(laneId)
      .then((pack) => {
        if (!cancelled) setNodeTooltipPack(pack);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
    if (!showFiltersPanel) return;
    const onPointerDown = (event: PointerEvent) => {
      const panel = filtersPanelRef.current;
      if (!panel) return;
      const target = event.target;
      if (!(target instanceof globalThis.Node)) {
        setShowFiltersPanel(false);
        return;
      }
      if (panel.contains(target)) return;
      setShowFiltersPanel(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowFiltersPanel(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showFiltersPanel]);

  React.useEffect(() => {
    const unsubConflict = window.ade.conflicts.onEvent((event) => {
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
      setBatchProgress({ completedPairs: event.completedPairs, totalPairs: event.totalPairs });
      void refreshRiskBatch();
    });
    const unsubPtyData = window.ade.pty.onData(() => {
      void refreshActivity();
    });
    const unsubPtyExit = window.ade.pty.onExit(() => {
      void refreshActivity();
    });
    const interval = window.setInterval(() => {
      void refreshLanes().catch(() => {});
      void refreshActivity();
    }, 5000);

    return () => {
      unsubConflict();
      unsubPtyData();
      unsubPtyExit();
      window.clearInterval(interval);
      if (riskRefreshTimerRef.current != null) {
        window.clearTimeout(riskRefreshTimerRef.current);
      }
    };
  }, [refreshActivity, refreshLanes, refreshRiskBatch]);

  React.useEffect(() => {
    if (!loadedGraphState) return;
    if (nodeDragActiveRef.current) return;
    const autoPositions = computeAutoLayout(lanes, viewMode, activityScoreByLaneId);
    const savedPositions = activeSnapshot.nodePositions;
    const positions = Object.keys(savedPositions).length > 0 ? { ...autoPositions, ...savedPositions } : autoPositions;

    const nextNodes: Array<Node<GraphNodeData>> = [];
    for (const lane of lanes) {
      if (hiddenByCollapse.has(lane.id)) continue;
      const pos = positions[lane.id] ?? { x: 0, y: 0 };
      const visible = laneMatchesFilters(lane);
      const descendants = collectDescendants(lanes, lane.id);
      const collapsedChildCount = collapsedLaneIds.has(lane.id)
        ? descendants.size
        : 0;
      const connectedToHover = hoveredNodeId ? connectedToHoveredNode.has(lane.id) : false;
      const dimmedByHover = Boolean(hoveredNodeId) && !connectedToHover;
      nextNodes.push({
        id: lane.id,
        type: "lane",
        position: pos,
        data: {
          lane: appearanceEditor?.laneId === lane.id
            ? { ...lane, color: appearanceEditor.color, icon: appearanceEditor.icon, tags: appearanceEditor.tags }
            : lane,
          status: statusByLane.get(lane.id) ?? "unknown",
          activeSessions: activeSessionsByLaneId[lane.id] ?? 0,
          collapsedChildCount,
          dimmed: !visible || dimmedByHover,
          activityBucket: activityBucketByLaneId[lane.id] ?? "medium",
          viewMode,
          lastActivityAt: lastActivityByLaneId[lane.id] ?? null,
          highlight: Boolean(hoveredNodeId) && connectedToHover,
          restackFailed: restackFailedLaneId === lane.id,
          restackPulse: restackFailedLaneId === lane.id && restackFailedPulse,
          mergeInProgress: Boolean(mergeInProgressByLaneId[lane.id]),
          mergeDisappearing: Boolean(mergeDisappearingAtByLaneId[lane.id])
        },
        selected: selectedLaneIds.includes(lane.id),
        draggable: true
      });
    }
    setNodes(nextNodes);

    const nextEdges: Array<Edge<GraphEdgeData>> = [];
    const primaryLane = lanes.find((lane) => lane.laneType === "primary") ?? null;
    const riskPairsWithVisibleEdge = new Set<string>();
    if (viewMode === "all" || viewMode === "risk") {
      for (const [key, risk] of riskByPair.entries()) {
        if (risk.riskLevel === "none" && risk.overlapCount === 0) continue;
        const [laneAId, laneBId] = key.split("::");
        if (!laneAId || !laneBId) continue;
        if (hiddenByCollapse.has(laneAId) || hiddenByCollapse.has(laneBId)) continue;
        riskPairsWithVisibleEdge.add(key);
      }
    }
    const edgeVisualState = (edgeId: string, source: string, target: string) => {
      const connectedToNodeHover = hoveredNodeId ? source === hoveredNodeId || target === hoveredNodeId : false;
      const highlightedByEdge = hoveredEdgeId ? hoveredEdgeId === edgeId : false;
      const highlight = hoveredEdgeId ? highlightedByEdge : connectedToNodeHover;
      const dimmed = hoveredEdgeId
        ? hoveredEdgeId !== edgeId
        : hoveredNodeId
          ? !connectedToNodeHover
          : false;
      return { highlight, dimmed };
    };

    if (viewMode === "all" || viewMode === "stack") {
      for (const lane of lanes) {
        if (!primaryLane || lane.id === primaryLane.id) continue;
        const edgeId = `topology:${primaryLane.id}:${lane.id}`;
        const visual = edgeVisualState(edgeId, primaryLane.id, lane.id);
        const pair = edgePairKey(primaryLane.id, lane.id);
        const pr = prOverlayByPair.get(pair);
        nextEdges.push({
          id: edgeId,
          source: primaryLane.id,
          target: lane.id,
          sourceHandle: "source",
          targetHandle: "target",
          type: "custom",
          data: { edgeType: "topology", ...visual, ...(pr && !riskPairsWithVisibleEdge.has(pair) ? { pr } : {}) },
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: false,
          selected: visual.highlight
        });
      }
      for (const lane of lanes) {
        if (!lane.parentLaneId || !laneById.has(lane.parentLaneId)) continue;
        const edgeId = `stack:${lane.parentLaneId}:${lane.id}`;
        const visual = edgeVisualState(edgeId, lane.parentLaneId, lane.id);
        const pair = edgePairKey(lane.parentLaneId, lane.id);
        const pr = prOverlayByPair.get(pair);
        nextEdges.push({
          id: edgeId,
          source: lane.parentLaneId,
          target: lane.id,
          sourceHandle: "source",
          targetHandle: "target",
          type: "custom",
          data: { edgeType: "stack", ...visual, ...(pr && !riskPairsWithVisibleEdge.has(pair) ? { pr } : {}) },
          markerEnd: { type: MarkerType.ArrowClosed },
          selected: visual.highlight
        });
      }
    }

    if (viewMode === "all" || viewMode === "risk") {
      for (const [key, risk] of riskByPair.entries()) {
        if (risk.riskLevel === "none" && risk.overlapCount === 0) continue;
        const [laneAId, laneBId] = key.split("::");
        if (!laneAId || !laneBId) continue;
        if (hiddenByCollapse.has(laneAId) || hiddenByCollapse.has(laneBId)) continue;
        const edgeId = `risk:${laneAId}:${laneBId}`;
        const visual = edgeVisualState(edgeId, laneAId, laneBId);
        const pr = prOverlayByPair.get(key);
        nextEdges.push({
          id: edgeId,
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
            ...visual
          },
          selected: visual.highlight
        });
      }
    }

    setEdges(nextEdges);
  }, [
    activityBucketByLaneId,
    activeSessionsByLaneId,
    activeSnapshot.nodePositions,
    appearanceEditor,
    collapsedLaneIds,
    connectedToHoveredNode,
    hiddenByCollapse,
    hoveredNodeId,
    laneById,
    laneMatchesFilters,
    lanes,
    lastActivityByLaneId,
    loadedGraphState,
    restackFailedLaneId,
    restackFailedPulse,
    riskByPair,
    prOverlayByPair,
    selectedLaneIds,
    statusByLane,
    viewMode,
    hoveredEdgeId,
    activityScoreByLaneId,
    mergeDisappearingAtByLaneId,
    mergeInProgressByLaneId
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
      const targetCandidates = nodes.filter((candidate) => candidate.id !== node.id && !hiddenByCollapse.has(candidate.id));
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
      const targetDescendants = collectDescendants(lanes, target.id);
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
    nodeDragActiveRef.current = true;
    dragOriginRef.current.set(node.id, { x: node.position.x, y: node.position.y });
    if (dropPreviewTimerRef.current != null) {
      window.clearTimeout(dropPreviewTimerRef.current);
      dropPreviewTimerRef.current = null;
    }
    setDropPreview(null);
    setDragTrail({ laneId: node.id, from: { x: node.position.x, y: node.position.y }, to: { x: node.position.x, y: node.position.y } });
  }, []);

  const onNodeDrag = React.useCallback(
    (_event: React.MouseEvent, node: Node<GraphNodeData>) => {
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
        mergeMethod: "squash",
        merging: false,
        error: null
      });

      if (!existing) {
        void window.ade.prs
          .draftDescription(laneId)
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
        window.ade.prs.getReviews(existing.id)
      ])
        .then(([status, checks, reviews]) => {
          setPrDialog((prev) =>
            prev && prev.laneId === laneId
              ? { ...prev, loadingDetails: false, status, checks, reviews }
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

  const onNodeDragStop = React.useCallback(
    (_event: React.MouseEvent, node: Node<GraphNodeData>) => {
      nodeDragActiveRef.current = false;
      const origin = dragOriginRef.current.get(node.id);
      setDragTrail(null);
      if (dropPreviewTimerRef.current != null) {
        window.clearTimeout(dropPreviewTimerRef.current);
        dropPreviewTimerRef.current = null;
      }
      setDropPreview(null);
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

  const runBatchOperation = React.useCallback(
    async (operation: "restack" | "push" | "fetch" | "archive" | "delete") => {
      if (selectedLaneIds.length < 2) return;
      if (operation === "restack") {
        setRestackFailedLaneId(null);
        setRestackFailedPulse(false);
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
      const ordered = operation === "restack"
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
          if (operation === "restack") {
            const result = await window.ade.lanes.restack({ laneId, recursive: false });
            if (result.error) throw new Error(result.error);
          } else if (operation === "push") {
            await window.ade.git.push({ laneId });
          } else if (operation === "fetch") {
            await window.ade.git.fetch({ laneId });
          } else if (operation === "archive") {
            await window.ade.lanes.archive({ laneId });
          } else {
            await window.ade.lanes.delete({ laneId, force: true, deleteBranch: false });
          }
          doneCount += 1;
          setBatchStatus((prev) => {
            if (!prev) return prev;
            const nextSteps = prev.steps.map((step) => step.laneId === laneId ? { ...step, status: "done" as const } : step);
            return { ...prev, steps: nextSteps };
          });
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
          if (operation === "restack") {
            const descendants = descendantsCache.get(laneId);
            for (const childId of descendants ?? []) blocked.add(childId);
            setRestackFailedLaneId(laneId);
            setRestackFailedPulse(true);
            window.setTimeout(() => setRestackFailedPulse(false), 1650);
            setErrorBanner(`Rebase paused: conflict on '${laneById.get(laneId)?.name ?? laneId}'. ${doneCount}/${ordered.length} lanes rebased.`);
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
    },
    [laneById, lanes, refreshLanes, selectedLaneIds]
  );

  const openContextForSelected = React.useCallback(() => {
    if (selectedLaneIds.length !== 1) return;
    const laneId = selectedLaneIds[0]!;
    const node = nodes.find((entry) => entry.id === laneId);
    if (!node) return;
    setContextMenu({ laneId, x: 240, y: 200 });
  }, [nodes, selectedLaneIds]);

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
      setNodes((prev) => prev.map((node) => ({ ...node, selected: node.id === nextLane.id })));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [laneById, lanes, openContextForSelected, selectedLaneIds]);

  const applyContextAction = React.useCallback(
    async (action: string) => {
      if (!contextMenu) return;
      const lane = laneById.get(contextMenu.laneId);
      if (!lane) return;

      try {
        if (action === "open") {
          await window.ade.lanes.openFolder({ laneId: lane.id });
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
        } else if (action === "restack") {
          const result = await window.ade.lanes.restack({ laneId: lane.id, recursive: false });
          if (result.error) throw new Error(result.error);
          await refreshLanes();
        } else if (action === "push") {
          await window.ade.git.push({ laneId: lane.id });
        } else if (action === "fetch") {
          await window.ade.git.fetch({ laneId: lane.id });
        } else if (action === "sync") {
          await window.ade.git.sync({ laneId: lane.id, mode: "rebase" });
          await refreshLanes();
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
          setAppearanceEditor({
            laneId: lane.id,
            x: contextMenu.x + 20,
            y: contextMenu.y,
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
      } catch (error) {
        setErrorBanner(error instanceof Error ? error.message : String(error));
      } finally {
        setContextMenu(null);
      }
    },
    [contextMenu, laneById, lanes, openReparentDialog, refreshLanes, requestTextInput, updateGraphSnapshot]
  );

  const lanesForLegend = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of lanes) {
      if (!lane.color) continue;
      map.set(lane.color, lane.name);
    }
    return Array.from(map.entries()).slice(0, 8);
  }, [lanes]);

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

  const loadPreset = React.useCallback(
    (presetName: string) => {
      setGraphState((prev) => {
        const ensured = ensureGraphState(prev);
        if (!ensured.presets.some((presetItem) => presetItem.name === presetName)) return ensured;
        return { ...ensured, activePreset: presetName };
      });
    },
    []
  );

  const saveLayoutAsPreset = React.useCallback(async () => {
    const presetName = await requestTextInput({
      title: "Preset name",
      validate: (value) => (value ? null : "Preset name is required")
    });
    if (!presetName) return;
    setGraphState((prev) => {
      const ensured = ensureGraphState(prev);
      const existing = ensured.presets.find((entry) => entry.name === ensured.activePreset) ?? ensured.presets[0]!;
      const nextPreset: GraphLayoutPreset = {
        name: presetName,
        byViewMode: existing.byViewMode,
        updatedAt: new Date().toISOString()
      };
      return {
        ...ensured,
        activePreset: presetName,
        presets: [...ensured.presets.filter((entry) => entry.name !== presetName), nextPreset]
      };
    });
  }, [requestTextInput]);

  React.useEffect(() => {
    if (!loadedGraphState) return;
    const fitKey = `${viewMode}:${nodes.length}:${edges.length}:${activeSnapshot.updatedAt}`;
    if (lastFitViewKeyRef.current === fitKey) return;
    lastFitViewKeyRef.current = fitKey;
    const timer = window.setTimeout(() => {
      void reactFlow.fitView({ duration: 500, padding: 0.2 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSnapshot.updatedAt, edges.length, loadedGraphState, nodes.length, reactFlow, viewMode]);

  React.useEffect(() => {
    const needle = filters.search.trim().toLowerCase();
    if (!needle) return;
    const matching = nodes.filter((node) => {
      const lane = node.data.lane;
      const hay = `${lane.name} ${lane.branchRef} ${lane.tags.join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
    if (matching.length === 0) return;
    const timer = window.setTimeout(() => {
      void reactFlow.fitView({ nodes: matching, duration: 320, padding: 0.25 });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [filters.search, nodes, reactFlow]);

  const hoveredTooltipLane = nodeTooltip ? laneById.get(nodeTooltip.laneId) ?? null : null;
  const dragTrailScreen = React.useMemo(() => {
    if (!dragTrail) return null;
    const viewport = reactFlow.getViewport();
    const x1 = dragTrail.from.x * viewport.zoom + viewport.x;
    const y1 = dragTrail.from.y * viewport.zoom + viewport.y;
    const x2 = dragTrail.to.x * viewport.zoom + viewport.x;
    const y2 = dragTrail.to.y * viewport.zoom + viewport.y;
    return { x1, y1, x2, y2 };
  }, [dragTrail, reactFlow]);

  if (loadingTopology) {
    return (
      <div className="relative h-full w-full">
        <div className="absolute inset-0">
          <div className="h-full w-full bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] [opacity:0.3]" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded border border-border bg-card/90 px-4 py-3 text-sm text-muted-fg">
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
          <EmptyState title="No lanes yet" description="Create a lane to start." />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0 h-full w-full bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] [opacity:0.3]" />

      <div className="absolute left-0 right-0 top-0 z-20 border-b border-border bg-bg/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded border border-border bg-card/80 p-0.5">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={cn("rounded px-2 py-1 text-xs capitalize", viewMode === mode ? "bg-accent text-accent-fg" : "text-muted-fg hover:text-fg")}
                onClick={() => {
                  setViewMode(mode);
                  updateGraphSnapshot((snapshot) => ({ ...snapshot, viewMode: mode }));
                }}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="relative ml-2">
            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-fg" />
            <input
              value={filters.search}
              onChange={(event) => {
                const value = event.target.value;
                updateGraphSnapshot((snapshot) => ({
                  ...snapshot,
                  filters: { ...snapshot.filters, search: value }
                }));
              }}
              placeholder="Filter…"
              className="h-7 w-[220px] rounded border border-border bg-card/70 pl-7 pr-2 text-xs outline-none"
            />
          </div>

          <select
            className="h-7 rounded border border-border bg-card/70 px-2 text-xs"
            value={graphState.activePreset}
            onChange={(event) => loadPreset(event.target.value)}
          >
            {graphState.presets.map((presetItem) => (
              <option key={presetItem.name} value={presetItem.name}>
                {presetItem.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void saveLayoutAsPreset()}>
            Save Layout As…
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={async () => {
              if (graphState.activePreset === DEFAULT_PRESET) return;
              const nextName = await requestTextInput({
                title: "Rename preset",
                defaultValue: graphState.activePreset,
                validate: (value) => (value ? null : "Preset name is required")
              });
              if (!nextName) return;
              setGraphState((prev) => {
                const ensured = ensureGraphState(prev);
                return {
                  ...ensured,
                  activePreset: nextName,
                  presets: ensured.presets.map((entry) =>
                    entry.name === ensured.activePreset ? { ...entry, name: nextName, updatedAt: new Date().toISOString() } : entry
                  )
                };
              });
            }}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={graphState.activePreset === DEFAULT_PRESET}
            onClick={() => {
              if (graphState.activePreset === DEFAULT_PRESET) return;
              if (!window.confirm("Delete layout preset?")) return;
              setGraphState((prev) => {
                const ensured = ensureGraphState(prev);
                const filtered = ensured.presets.filter((entry) => entry.name !== ensured.activePreset);
                return {
                  ...ensured,
                  presets: filtered.length > 0 ? filtered : [createDefaultState().presets[0]!],
                  activePreset: DEFAULT_PRESET
                };
              });
            }}
          >
            Delete
          </Button>

          <div className="relative ml-auto" ref={filtersPanelRef}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              onClick={() => setShowFiltersPanel((prev) => !prev)}
            >
              <Filter className="h-3.5 w-3.5" />
              Filters
            </Button>
            {showFiltersPanel ? (
              <div className="absolute right-0 top-8 z-40 w-[360px] rounded border border-border bg-card/95 p-2 text-xs shadow-2xl">
                <div className="mb-2 rounded border border-border bg-bg/40 px-2 py-1 text-[11px] text-muted-fg">
                  Drag-drop integrates commits by default; use Reparent when you want to change stack hierarchy.
                </div>
                <div className="mb-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Status</div>
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
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Lane Type</div>
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
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-fg">Visibility</div>
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
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-fg">
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
                      className="h-7 rounded border border-border bg-card/70 px-2 text-xs normal-case text-fg"
                    >
                      <option value="">all stacks</option>
                      {rootLaneOptions.map((lane) => (
                        <option key={lane.id} value={lane.id}>
                          {lane.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-fg">
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
                      className="h-7 rounded border border-border bg-card/70 px-2 text-xs normal-case text-fg"
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
        </div>
      </div>

      <div className="absolute inset-0 pt-[52px]">
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
            setSelectedLaneIds([node.id]);
            setNodes((prev) => prev.map((entry) => ({ ...entry, selected: entry.id === node.id })));
            if (collapsedLaneIds.has(node.id)) {
              updateGraphSnapshot((snapshot) => ({
                ...snapshot,
                collapsedLaneIds: snapshot.collapsedLaneIds.filter((entry) => entry !== node.id)
              }));
              return;
            }
            navigate(`/lanes?laneId=${encodeURIComponent(node.id)}&focus=single`);
          }}
          onNodeMouseEnter={(event, node) => {
            setHoveredNodeId(node.id);
            if (nodeHoverTimerRef.current != null) {
              window.clearTimeout(nodeHoverTimerRef.current);
            }
            nodeHoverTimerRef.current = window.setTimeout(() => {
              setNodeTooltip({ x: event.clientX + 12, y: event.clientY + 12, laneId: node.id });
            }, 400);
          }}
          onNodeMouseMove={(event, node) => {
            if (nodeTooltip?.laneId !== node.id) return;
            setNodeTooltip({ x: event.clientX + 12, y: event.clientY + 12, laneId: node.id });
          }}
          onNodeMouseLeave={() => {
            setHoveredNodeId(null);
            if (nodeHoverTimerRef.current != null) {
              window.clearTimeout(nodeHoverTimerRef.current);
              nodeHoverTimerRef.current = null;
            }
            setNodeTooltip(null);
          }}
          onSelectionChange={(selection) => {
            const selected = selection.nodes.map((node) => node.id);
            setSelectedLaneIds((prev) => (sameIdSet(prev, selected) ? prev : selected));
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            setContextMenu({
              laneId: node.id,
              x: event.clientX,
              y: event.clientY
            });
          }}
          onNodeDoubleClick={(_event, node) => {
            if (!collapsedLaneIds.has(node.id)) return;
            updateGraphSnapshot((snapshot) => ({
              ...snapshot,
              collapsedLaneIds: snapshot.collapsedLaneIds.filter((entry) => entry !== node.id)
            }));
          }}
          onEdgeClick={(_event, edge) => {
            const [prefix, laneAId, laneBId] = edge.id.split(":");
            if (!laneAId || !laneBId) return;
            const data = edge.data;
            if (prefix === "risk") {
              setEdgeSimulation(null);
              setReparentDialog(null);
              setContextMenu(null);
              openConflictPanelForEdge(laneAId, laneBId);
              return;
            }

            if (data?.pr) {
              setEdgeSimulation(null);
              setReparentDialog(null);
              setContextMenu(null);
              openPrDialogForLane(data.pr.laneId, data.pr.baseLaneId);
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
          onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)}
          onEdgeMouseMove={(event, edge) => {
            setHoveredEdgeId(edge.id);
            const data = edge.data;
            const [_, laneAId, laneBId] = edge.id.split(":");
            const pr = data?.pr ?? null;
            const prLines = pr
              ? [
                  `PR #${pr.number} · ${pr.state} · checks: ${pr.checksStatus} · reviews: ${pr.reviewStatus}`,
                  pr.title ? pr.title : null,
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
          <MiniMap pannable zoomable />
          <Controls showInteractive={false}>
            <ControlButton title="Zoom to fit" onClick={() => void reactFlow.fitView({ duration: 500, padding: 0.2 })}>
              <ArrowUpRight className="h-4 w-4" />
            </ControlButton>
          </Controls>
          <Panel position="bottom-left">
            {loadingRisk ? (
              <div className="rounded border border-border bg-card/90 px-2 py-1 text-[11px] text-muted-fg">
                Loading risk data…
              </div>
            ) : batchProgress ? (
              <div className="rounded border border-border bg-card/90 px-2 py-1 text-[11px] text-muted-fg">
                Computing {batchProgress.completedPairs}/{batchProgress.totalPairs} pairs…
              </div>
            ) : null}
          </Panel>
          {lanes.length === 1 && lanes[0]?.laneType === "primary" ? (
            <Panel position="bottom-center">
              <div className="rounded border border-border bg-card/90 px-2 py-1 text-[11px] text-muted-fg">
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
            <div className="rounded border border-border bg-card/90 p-2 text-[11px]">
              <div className="mb-1 font-semibold text-fg">Environment Legend</div>
              {lanesForLegend.length === 0 ? (
                <div className="text-muted-fg">No custom node colors yet.</div>
              ) : (
                <div className="space-y-1">
                  {lanesForLegend.map(([color, laneName]) => (
                    <div key={color} className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full border border-border" style={{ backgroundColor: color }} />
                      <span className="truncate text-muted-fg">{laneName}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>
        </ReactFlow>
        {dragTrailScreen ? (
          <svg className="pointer-events-none absolute inset-x-0 bottom-0 top-[52px] z-10">
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
          className="fixed z-[90] min-w-[190px] rounded border border-border bg-card/95 p-1 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseLeave={() => setContextMenu(null)}
        >
          {(() => {
            const lane = laneById.get(contextMenu.laneId);
            const isPrimary = lane?.laneType === "primary";
            const hasParent = Boolean(lane?.parentLaneId);
            const hasChildren = (lane?.childCount ?? 0) > 0;
            const isCollapsed = collapsedLaneIds.has(contextMenu.laneId);
            const items: Array<{ key: string; label: string; disabled?: boolean; reason?: string }> = [
              { key: "open", label: "Open" },
              { key: "create-child", label: "Create Child" },
              { key: "archive", label: "Archive", disabled: isPrimary, reason: "Primary lane cannot be archived." },
              { key: "delete", label: "Delete", disabled: isPrimary, reason: "Primary lane cannot be deleted." },
              { key: "restack", label: "Rebase", disabled: !hasParent, reason: "Rebase is only available for child lanes." },
              { key: "push", label: "Push" },
              { key: "fetch", label: "Fetch" },
              { key: "sync", label: "Pull" },
              { key: "reparent", label: "Reparent", disabled: isPrimary, reason: "Primary lane cannot be reparented." },
              { key: "rename", label: "Rename" },
              { key: "customize", label: "Customize Appearance" },
              {
                key: isCollapsed ? "expand" : "collapse",
                label: isCollapsed ? "Expand Stack" : "Collapse Stack",
                disabled: !isCollapsed && !hasChildren,
                reason: "No child lanes to collapse."
              }
            ];
            return items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={cn(
                  "flex w-full items-center rounded px-2 py-1 text-left text-xs",
                  item.disabled ? "cursor-not-allowed text-muted-fg" : "text-fg hover:bg-muted/70"
                )}
                title={item.disabled ? item.reason : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  void applyContextAction(item.key);
                }}
              >
                {item.label}
              </button>
            ));
          })()}
        </div>
      ) : null}

      {appearanceEditor ? (
        <div className="fixed z-[95] w-[340px] rounded border border-border bg-card/95 p-3 shadow-2xl" style={{ left: appearanceEditor.x, top: appearanceEditor.y }}>
          <div className="mb-2 text-xs font-semibold text-fg">Customize Appearance</div>
          <div className="mb-2 text-xs text-muted-fg">Color</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {COLOR_PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                className={cn(
                  "h-5 w-5 rounded-full border border-border",
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
                  "inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-xs",
                  appearanceEditor.icon === option.key && "border-accent bg-accent/20"
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
              <span key={tag} className="inline-flex items-center gap-1 rounded border border-border px-1 text-xs text-fg">
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
              className="h-7 flex-1 rounded border border-border bg-bg px-2 text-xs outline-none"
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
              <Plus className="h-3 w-3" />
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
          <div className="w-[min(780px,100%)] rounded border border-border bg-card p-4 shadow-2xl">
            <div className="mb-2 text-sm font-semibold text-fg">Confirm Lane Drop</div>
            {reparentDialog.integratePlan || reparentDialog.laneIds.length === 1 ? (
              <div className="mb-2 inline-flex rounded border border-border bg-bg/40 p-0.5 text-xs">
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
            <div className="mb-2 rounded border border-border bg-bg/40 p-2 text-xs text-muted-fg">
              {reparentDialog.actionMode === "integrate"
                ? "Integrate keeps stack ancestry unchanged and brings source lane commits into the target lane."
                : reparentDialog.actionMode === "pr"
                  ? "PR opens the pull request workflow for the dragged lane, targeting the drop base."
                : "Reparent changes stack ancestry. ADE rebases selected lane commits onto the target parent branch."}
            </div>
            {reparentDialog.actionMode === "integrate" && reparentDialog.integratePlan ? (
              <div className="mb-2 rounded border border-border bg-bg/40 p-2 text-xs">
                <div className="font-semibold text-fg">{reparentDialog.integratePlan.summary}</div>
                <div className="mt-1 text-muted-fg">{reparentDialog.integratePlan.detail}</div>
              </div>
            ) : (
              <>
                <div className="mb-2 text-xs text-muted-fg">
                  Target parent: <span className="text-fg">{laneById.get(reparentDialog.targetLaneId)?.name ?? reparentDialog.targetLaneId}</span>
                </div>
                <div className="mb-2 rounded border border-border bg-bg/40 p-2 text-xs">
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
              <div className="mb-2 rounded border border-amber-600/60 bg-amber-900/20 p-2 text-xs text-amber-200">
                ⚠ {reparentDialog.overlapFiles.length} overlapping files detected.
              </div>
            ) : (
              <div className="mb-2 rounded border border-emerald-700/60 bg-emerald-900/20 p-2 text-xs text-emerald-200">
                No overlapping files detected.
              </div>
            )}
            <div className="mb-3 max-h-[180px] overflow-auto rounded border border-border bg-bg/40 p-2 text-xs">
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
              <div className="mb-3 rounded border border-border bg-bg/40 p-2 text-xs">
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
          <div className="w-[min(980px,100%)] rounded border border-border bg-card p-4 shadow-2xl">
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
              <div className="mb-3 rounded border border-red-700/70 bg-red-900/30 p-2 text-xs text-red-200">
                {prDialog.error}
              </div>
            ) : null}

            {!prDialog.existingPr ? (
              <div className="space-y-3">
                {prDialog.loadingDraft ? (
                  <div className="rounded border border-border bg-bg/40 p-2 text-xs text-muted-fg">
                    <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
                    Drafting description from pack…
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <input
                    className="h-9 rounded border border-border bg-bg px-3 text-sm md:col-span-2"
                    placeholder="PR title"
                    value={prDialog.title}
                    onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
                  />
                  <label className="inline-flex h-9 items-center gap-2 rounded border border-border bg-bg px-3 text-xs text-muted-fg">
                    <input
                      type="checkbox"
                      checked={prDialog.draft}
                      onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, draft: e.target.checked } : prev))}
                    />
                    Draft PR
                  </label>
                </div>

                <textarea
                  className="min-h-[240px] w-full rounded border border-border bg-bg px-3 py-2 text-xs"
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
                        .draftDescription(laneId)
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
                        .then((created) => {
                          void refreshPrs().catch(() => {});
                          setPrDialog((prev) =>
                            prev && prev.laneId === laneId
                              ? { ...prev, creating: false, existingPr: created, loadingDetails: true }
                              : prev
                          );
                          void Promise.all([
                            window.ade.prs.getStatus(created.id),
                            window.ade.prs.getChecks(created.id),
                            window.ade.prs.getReviews(created.id)
                          ])
                            .then(([status, checks, reviews]) => {
                              setPrDialog((prev) =>
                                prev && prev.laneId === laneId
                                  ? { ...prev, loadingDetails: false, status, checks, reviews }
                                  : prev
                              );
                            })
                            .catch(() => {});
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
            ) : (
              <div className="space-y-3">
                <div className="rounded border border-border bg-bg/40 p-2 text-xs">
                  <div className="font-semibold text-fg">{prDialog.existingPr.title}</div>
                  <div className="mt-1 text-muted-fg">
                    state: {prDialog.existingPr.state} · checks: {prDialog.existingPr.checksStatus} · reviews: {prDialog.existingPr.reviewStatus}
                    {prDialog.existingPr.lastSyncedAt ? ` · synced ${prDialog.existingPr.lastSyncedAt}` : ""}
                  </div>
                </div>

                {prDialog.loadingDetails ? (
                  <div className="rounded border border-border bg-bg/40 p-2 text-xs text-muted-fg">Loading PR status…</div>
                ) : prDialog.status ? (
                  <div className="rounded border border-border bg-bg/40 p-2 text-xs text-muted-fg">
                    <div>
                      mergeable: <span className="text-fg">{prDialog.status.isMergeable ? "yes" : "no"}</span> · conflicts:{" "}
                      <span className="text-fg">{prDialog.status.mergeConflicts ? "yes" : "no"}</span> · behind base:{" "}
                      <span className="text-fg">{prDialog.status.behindBaseBy}</span>
                    </div>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="rounded border border-border bg-bg/40 p-2 text-xs">
                    <div className="mb-1 font-semibold text-fg">Checks</div>
                    {prDialog.checks.length === 0 ? (
                      <div className="text-muted-fg">No checks.</div>
                    ) : (
                      prDialog.checks.slice(0, 12).map((check) => (
                        <div key={check.name} className="flex items-center justify-between gap-2">
                          <span className="truncate">{check.name}</span>
                          <span className="text-muted-fg">{check.conclusion ?? check.status}</span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="rounded border border-border bg-bg/40 p-2 text-xs">
                    <div className="mb-1 font-semibold text-fg">Reviews</div>
                    {prDialog.reviews.length === 0 ? (
                      <div className="text-muted-fg">No reviews.</div>
                    ) : (
                      prDialog.reviews.slice(0, 12).map((review, idx) => (
                        <div key={`${review.reviewer}:${idx}`} className="flex items-center justify-between gap-2">
                          <span className="truncate">{review.reviewer}</span>
                          <span className="text-muted-fg">{review.state}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={prDialog.mergeMethod}
                      onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, mergeMethod: e.target.value as MergeMethod } : prev))}
                      className="h-8 rounded border border-border bg-bg px-2 text-xs"
                    >
                      <option value="merge">merge</option>
                      <option value="squash">squash</option>
                      <option value="rebase">rebase</option>
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const prId = prDialog.existingPr?.id;
                        if (!prId) return;
                        void window.ade.prs.openInGitHub(prId).catch(() => {});
                      }}
                    >
                      Open in GitHub
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={prDialog.loadingDetails}
                      onClick={() => openPrDialogForLane(prDialog.laneId, prDialog.baseLaneId)}
                    >
                      Refresh
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => setPrDialog(null)}>
                      Close
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={prDialog.merging || !prDialog.existingPr}
                      onClick={() => {
                        const pr = prDialog.existingPr;
                        if (!pr) return;
                        const laneId = prDialog.laneId;
                        setPrDialog((prev) => (prev ? { ...prev, merging: true, error: null } : prev));
                        setMergeInProgressByLaneId((prev) => ({ ...prev, [laneId]: true }));
                        window.ade.prs
                          .land({ prId: pr.id, method: prDialog.mergeMethod })
                          .then((result) => {
                            void refreshPrs().catch(() => {});
                            if (!result.success) {
                              throw new Error(result.error || "Merge failed");
                            }
                            setMergeDisappearingAtByLaneId((prev) => ({ ...prev, [laneId]: Date.now() }));
                            window.setTimeout(() => {
                              void refreshLanes().catch(() => {});
                              void refreshRiskBatch().catch(() => {});
                            }, 650);
                            setPrDialog(null);
                          })
                          .catch((error) => {
                            const message = error instanceof Error ? error.message : String(error);
                            setMergeInProgressByLaneId((prev) => ({ ...prev, [laneId]: false }));
                            setPrDialog((prev) => (prev ? { ...prev, merging: false, error: message } : prev));
                          });
                      }}
                    >
                      {prDialog.merging ? "Merging…" : "Merge PR"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {integrationDialog ? (
        <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
          <div className="w-[min(780px,100%)] rounded border border-border bg-card p-4 shadow-2xl">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-fg">Create Integration Lane</div>
              <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setIntegrationDialog(null)}>
                ×
              </button>
            </div>

            {integrationDialog.error ? (
              <div className="mb-2 rounded border border-red-700/70 bg-red-900/30 p-2 text-xs text-red-200">
                {integrationDialog.error}
              </div>
            ) : null}

            <div className="mb-2 text-xs text-muted-fg">
              This will create a new lane branched from Primary and merge the selected lanes into it.
            </div>

            <input
              className="mb-2 h-9 w-full rounded border border-border bg-bg px-3 text-sm"
              value={integrationDialog.name}
              onChange={(e) => setIntegrationDialog((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              placeholder="Integration lane name"
              disabled={integrationDialog.busy}
            />

            <div className="mb-3 max-h-[160px] overflow-auto rounded border border-border bg-bg/40 p-2 text-xs text-muted-fg">
              {integrationDialog.laneIds.map((laneId) => (
                <div key={laneId} className="truncate">
                  {laneById.get(laneId)?.name ?? laneId}
                </div>
              ))}
            </div>

            {integrationDialog.step ? (
              <div className="mb-3 rounded border border-border bg-bg/40 p-2 text-xs text-muted-fg">{integrationDialog.step}</div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={integrationDialog.busy} onClick={() => setIntegrationDialog(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={integrationDialog.busy || !integrationDialog.name.trim() || !primaryLaneId}
                onClick={() => {
                  const draft = integrationDialog;
                  if (!draft) return;
                  const primaryId = primaryLaneId;
                  if (!primaryId) {
                    setIntegrationDialog((prev) => (prev ? { ...prev, error: "Primary lane not found." } : prev));
                    return;
                  }
                  const ordered = [...draft.laneIds].filter((id) => id !== primaryId);
                  setIntegrationDialog((prev) => (prev ? { ...prev, busy: true, error: null, step: "Creating integration lane…" } : prev));
                  window.ade.lanes
                    .createChild({ parentLaneId: primaryId, name: draft.name.trim() })
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

      {selectedLaneIds.length > 1 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[60] flex justify-center">
          <div className="pointer-events-auto rounded border border-border bg-card/95 px-3 py-2 shadow-xl">
            <div className="mb-1 text-[11px] text-muted-fg">{selectedLaneIds.length} lanes selected</div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void runBatchOperation("restack")}>
                Batch Rebase
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="h-7 px-2 text-[11px]"
                onClick={() =>
                  setIntegrationDialog({
                    laneIds: [...selectedLaneIds],
                    name: `Integration ${new Date().toISOString().slice(0, 10)} (${selectedLaneIds.length})`,
                    busy: false,
                    step: null,
                    error: null
                  })
                }
              >
                Integration Lane
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void runBatchOperation("push")}>
                Batch Push
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void runBatchOperation("fetch")}>
                Batch Fetch
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void runBatchOperation("archive")}>
                Batch Archive
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void runBatchOperation("delete")}>
                Batch Delete
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
                <div className="max-h-[90px] overflow-auto rounded border border-border bg-bg/50 p-1">
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
        <div className="absolute left-3 right-3 top-[60px] z-[84] rounded border border-amber-700 bg-amber-900/25 px-3 py-2 text-xs text-amber-100">
          <div className="flex items-center justify-between gap-2">
            <div>
              Too many lanes for automatic risk assessment. Showing {batch.comparedLaneIds?.length ?? batch.maxAutoLanes ?? 15} of {batch.totalLanes ?? lanes.length} lanes.
            </div>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => navigate("/conflicts")}>
              Select Lanes
            </Button>
          </div>
        </div>
      ) : null}

      {errorBanner ? (
        <div className={cn("absolute left-3 right-3 z-[85] rounded border border-red-700 bg-red-900/35 px-3 py-2 text-xs text-red-100", batch?.truncated ? "top-[106px]" : "top-[60px]")}>
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              {errorBanner}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => navigate("/conflicts")}>
                Open Conflicts Tab
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setErrorBanner(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {undoToast ? (
        <div className="absolute bottom-3 right-3 z-[90] rounded border border-border bg-card/95 px-3 py-2 text-xs shadow-xl">
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
        <div className="absolute right-3 top-[66px] z-[89] w-[360px] rounded border border-border bg-card/95 p-3 text-xs shadow-2xl">
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
            <div className="rounded border border-border bg-bg/40 p-3 text-muted-fg">
              <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
              <div>Running merge simulation…</div>
            </div>
          ) : edgeSimulation.error ? (
            <div className="rounded border border-red-700/70 bg-red-900/30 p-2 text-red-200">
              <div className="font-medium">Simulation failed</div>
              <div className="mt-1 font-mono text-[11px]">{edgeSimulation.error}</div>
            </div>
          ) : edgeSimulation.result ? (
            <div className="space-y-2">
              <div className="rounded border border-border bg-bg/40 p-2">
                <div>Outcome: <span className="font-semibold text-fg">{edgeSimulation.result.outcome}</span></div>
                <div className="text-muted-fg">
                  files changed: {edgeSimulation.result.diffStat.filesChanged} · insertions: {edgeSimulation.result.diffStat.insertions} · deletions: {edgeSimulation.result.diffStat.deletions}
                </div>
              </div>
              <div className="max-h-[180px] overflow-auto rounded border border-border bg-bg/40 p-2">
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
        <div className="absolute right-3 top-[66px] z-[89] w-[420px] rounded border border-border bg-card/95 p-3 text-xs shadow-2xl">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="font-semibold text-fg">Conflict Resolution</div>
            <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setConflictPanel(null)}>
              ×
            </button>
          </div>
          <div className="mb-2 text-muted-fg">
            {(laneById.get(conflictPanel.laneAId)?.name ?? conflictPanel.laneAId)} ↔ {(laneById.get(conflictPanel.laneBId)?.name ?? conflictPanel.laneBId)}
          </div>

          {conflictPanel.error ? (
            <div className="mb-2 rounded border border-red-700/70 bg-red-900/30 p-2 text-xs text-red-200">
              {conflictPanel.error}
            </div>
          ) : null}

          {conflictPanel.loading ? (
            <div className="mb-2 rounded border border-border bg-bg/40 p-2 text-muted-fg">
              <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
              <div>Running merge simulation…</div>
            </div>
          ) : conflictPanel.result ? (
            <div className="mb-2 rounded border border-border bg-bg/40 p-2 text-muted-fg">
              <div>
                outcome: <span className="font-semibold text-fg">{conflictPanel.result.outcome}</span>
              </div>
              <div>
                conflicts: <span className="text-fg">{conflictPanel.result.conflictingFiles.length}</span> · files changed:{" "}
                <span className="text-fg">{conflictPanel.result.diffStat.filesChanged}</span>
              </div>
            </div>
          ) : null}

          <div className="mb-2">
            <div className="mb-1 text-[11px] font-semibold text-fg">Overlapping Files</div>
            <div className="max-h-[120px] overflow-auto rounded border border-border bg-bg/40 p-2 text-[11px]">
              {(() => {
                const key = edgePairKey(conflictPanel.laneAId, conflictPanel.laneBId);
                const files = overlapFilesByPair.get(key) ?? [];
                if (files.length === 0) return <div className="text-muted-fg">No overlap file list.</div>;
                return files.slice(0, 30).map((file) => (
                  <div key={file} className="truncate" title={file}>
                    {file}
                  </div>
                ));
              })()}
            </div>
          </div>

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-fg">Apply to:</span>
	              <select
	                className="h-7 rounded border border-border bg-bg px-2 text-[11px]"
	                value={conflictPanel.applyLaneId}
	                onChange={(e) =>
	                  setConflictPanel((prev) =>
	                    prev
	                      ? { ...prev, applyLaneId: e.target.value, preview: null, proposal: null, error: null }
	                      : prev
	                  )}
	              >
                <option value={conflictPanel.laneAId}>{laneById.get(conflictPanel.laneAId)?.name ?? conflictPanel.laneAId}</option>
                <option value={conflictPanel.laneBId}>{laneById.get(conflictPanel.laneBId)?.name ?? conflictPanel.laneBId}</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => navigate("/conflicts")}>
                Open Conflicts Tab
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="h-7 px-2 text-[11px]"
                disabled={conflictPanel.preparing || conflictPanel.proposing}
                onClick={() => {
                  const panel = conflictPanel;
                  const laneId = panel.applyLaneId;
                  const peerLaneId = laneId === panel.laneAId ? panel.laneBId : panel.laneAId;

                  if (!panel.preview) {
                    setConflictPanel((prev) => (prev ? { ...prev, preparing: true, error: null, preview: null, proposal: null } : prev));
                    window.ade.conflicts
                      .prepareProposal({ laneId, peerLaneId })
                      .then((preview) => {
                        setConflictPanel((prev) => (prev ? { ...prev, preparing: false, preview } : prev));
                      })
                      .catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        setConflictPanel((prev) => (prev ? { ...prev, preparing: false, error: message } : prev));
                      });
                    return;
                  }

                  setConflictPanel((prev) => (prev ? { ...prev, proposing: true, error: null } : prev));
                  window.ade.conflicts
                    .requestProposal({ laneId, peerLaneId, contextDigest: panel.preview.contextDigest })
                    .then((proposal) => {
                      setConflictPanel((prev) => (prev ? { ...prev, proposing: false, proposal } : prev));
                    })
                    .catch((error) => {
                      const message = error instanceof Error ? error.message : String(error);
                      setConflictPanel((prev) => (prev ? { ...prev, proposing: false, error: message } : prev));
                    });
                }}
              >
                {conflictPanel.preparing
                  ? "Preparing…"
                  : conflictPanel.proposing
                    ? "Resolving…"
                    : conflictPanel.preview
                      ? "Send to AI"
                      : "Prepare AI"}
              </Button>
            </div>
          </div>

          {conflictPanel.preview ? (
            <div className="mb-2 rounded border border-border bg-bg/40 p-2 text-[11px] text-muted-fg">
              <div className="mb-1 font-semibold text-fg">AI preview</div>
              <div>
                files: <span className="text-fg">{conflictPanel.preview.stats.fileCount}</span> · approx chars:{" "}
                <span className="text-fg">{conflictPanel.preview.stats.approxChars.toLocaleString()}</span>
              </div>
              {conflictPanel.preview.warnings.length ? (
                <div className="mt-1 text-amber-200/90">
                  {conflictPanel.preview.warnings.slice(0, 2).join(" ")}
                </div>
              ) : null}
              {conflictPanel.preview.conflictPackExcerpt ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-muted-fg">conflict pack excerpt</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded border border-border bg-bg/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
                    {conflictPanel.preview.conflictPackExcerpt}
                  </pre>
                </details>
              ) : null}
              {conflictPanel.preview.files.length ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-muted-fg">included files</summary>
                  <div className="mt-1 space-y-2">
                    {conflictPanel.preview.files.slice(0, 6).map((f) => (
                      <details key={f.path} className="rounded border border-border bg-bg/60 p-2">
                        <summary className="cursor-pointer text-[11px] text-fg">{f.path}</summary>
                        {f.markerPreview ? (
                          <pre className="mt-2 max-h-28 overflow-auto rounded border border-border bg-bg/70 p-2 text-[10px] text-fg whitespace-pre-wrap">
                            {f.markerPreview}
                          </pre>
                        ) : null}
                        {f.laneDiff ? (
                          <pre className="mt-2 max-h-28 overflow-auto rounded border border-border bg-bg/70 p-2 text-[10px] text-fg whitespace-pre-wrap">
                            {f.laneDiff}
                          </pre>
                        ) : null}
                        {f.peerDiff ? (
                          <pre className="mt-2 max-h-28 overflow-auto rounded border border-border bg-bg/70 p-2 text-[10px] text-fg whitespace-pre-wrap">
                            {f.peerDiff}
                          </pre>
                        ) : null}
                      </details>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}

          {conflictPanel.proposal ? (
            <div className="space-y-2">
              <div className="rounded border border-border bg-bg/40 p-2 text-[11px] text-muted-fg">
                <div className="mb-1 font-semibold text-fg">Proposal</div>
                <div>status: <span className="text-fg">{conflictPanel.proposal.status}</span></div>
                {conflictPanel.proposal.confidence != null ? (
                  <div>confidence: <span className="text-fg">{Math.round(conflictPanel.proposal.confidence * 100)}%</span></div>
                ) : null}
                {conflictPanel.proposal.explanation ? (
                  <div className="mt-1 whitespace-pre-wrap">{conflictPanel.proposal.explanation}</div>
                ) : null}
              </div>

              <div className="rounded border border-border bg-bg/40 p-2">
                <div className="mb-1 text-[11px] font-semibold text-fg">Apply Mode</div>
                <div className="flex flex-wrap gap-2 text-[11px] text-muted-fg">
                  {(["unstaged", "staged", "commit"] as const).map((mode) => (
                    <label key={mode} className="inline-flex items-center gap-1">
                      <input
                        type="radio"
                        checked={conflictPanel.applyMode === mode}
                        onChange={() => setConflictPanel((prev) => (prev ? { ...prev, applyMode: mode } : prev))}
                      />
                      {mode}
                    </label>
                  ))}
                </div>
                {conflictPanel.applyMode === "commit" ? (
                  <input
                    className="mt-2 h-8 w-full rounded border border-border bg-bg px-2 text-[11px]"
                    placeholder="Commit message"
                    value={conflictPanel.commitMessage}
                    onChange={(e) => setConflictPanel((prev) => (prev ? { ...prev, commitMessage: e.target.value } : prev))}
                  />
                ) : null}
                <div className="mt-2 flex justify-end gap-2">
                  {conflictPanel.proposal.status === "applied" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => {
                        const panel = conflictPanel;
                        setConflictPanel((prev) => (prev ? { ...prev, applying: true, error: null } : prev));
                        window.ade.conflicts
                          .undoProposal({ laneId: panel.applyLaneId, proposalId: panel.proposal!.id })
                          .then((updated) => {
                            setConflictPanel((prev) => (prev ? { ...prev, applying: false, proposal: updated } : prev));
                            window.setTimeout(() => void refreshRiskBatch().catch(() => {}), 900);
                          })
                          .catch((error) => {
                            const message = error instanceof Error ? error.message : String(error);
                            setConflictPanel((prev) => (prev ? { ...prev, applying: false, error: message } : prev));
                          });
                      }}
                    >
                      Undo
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="primary"
                    className="h-7 px-2 text-[11px]"
                    disabled={conflictPanel.applying}
                    onClick={() => {
                      const panel = conflictPanel;
                      if (panel.applyMode === "commit" && !panel.commitMessage.trim()) {
                        setConflictPanel((prev) => (prev ? { ...prev, error: "Commit message is required for commit mode." } : prev));
                        return;
                      }
                      setConflictPanel((prev) => (prev ? { ...prev, applying: true, error: null } : prev));
                      window.ade.conflicts
                        .applyProposal({
                          laneId: panel.applyLaneId,
                          proposalId: panel.proposal!.id,
                          applyMode: panel.applyMode,
                          commitMessage: panel.applyMode === "commit" ? panel.commitMessage : undefined
                        })
                        .then((updated) => {
                          setConflictPanel((prev) => (prev ? { ...prev, applying: false, proposal: updated } : prev));
                          window.setTimeout(() => void refreshRiskBatch().catch(() => {}), 900);
                          void refreshLanes().catch(() => {});
                        })
                        .catch((error) => {
                          const message = error instanceof Error ? error.message : String(error);
                          setConflictPanel((prev) => (prev ? { ...prev, applying: false, error: message } : prev));
                        });
                    }}
                  >
                    {conflictPanel.applying ? "Applying…" : "Apply"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {nodeTooltip && hoveredTooltipLane ? (
        <div
          className="pointer-events-none fixed z-[92] min-w-[240px] rounded border border-border bg-card/95 px-2.5 py-2 text-[11px] shadow-xl ade-tooltip-motion ade-tooltip-open"
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
          <div className="w-[min(460px,100%)] rounded border border-border bg-card p-4 shadow-2xl">
            <div className="text-sm font-semibold text-fg">{textPrompt.title}</div>
            {textPrompt.message ? (
              <div className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg/40 px-2 py-1 text-[11px] text-muted-fg">
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
              className="mt-3 h-9 w-full rounded border border-border bg-bg px-2 text-sm outline-none focus:border-accent"
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
          className="pointer-events-none fixed z-[91] max-w-[420px] whitespace-pre-wrap rounded border border-border bg-card/95 px-2 py-1 text-[11px] text-fg shadow"
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
    <ReactFlowProvider>
      <GraphInner />
    </ReactFlowProvider>
  );
}
