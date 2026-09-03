/**
 * The canvas's own node and edge shapes.
 *
 * Ported from `components/graph/graphTypes.ts`. Three things changed and
 * nothing else: the app's `shared/types` import became `./types`, the
 * `PluginGraphEdgeKind` union is declared here rather than pulled from
 * `shared/plugins/sockets` (a guest cannot import it), and the two node fields
 * that reached into the renderer — `agents` and `onOpenAgent`, which drew a
 * lane's live session roster from `useLaneAgents` — are gone. See PARITY.md.
 */

import type {
  AutoRebaseLaneStatus,
  ConflictProposal,
  ConflictProposalPreview,
  ConflictStatus,
  GitUpstreamSyncStatus,
  GraphViewMode,
  LaneSummary,
  MergeSimulationResult,
  PrReviewStatus,
  PrState,
  PrStatus,
} from "./types";
import type { PluginGraphNodeEntry } from "./pluginGraphNodes";

/** What a plugin's line asserts. Verbatim from `shared/plugins/sockets.ts`. */
export const PLUGIN_GRAPH_EDGE_KINDS = ["link", "tracks", "blocks", "depends"] as const;
export type PluginGraphEdgeKind = (typeof PLUGIN_GRAPH_EDGE_KINDS)[number];

/** A PR overlay's own activity reading. Verbatim from `prs/shared/prVisuals`. */
export type PrActivityState = "active" | "idle" | "stale";

export type GraphNodeData = {
  lane: LaneSummary;
  status: ConflictStatus["status"] | "unknown";
  remoteSync: GitUpstreamSyncStatus | null;
  autoRebaseStatus: AutoRebaseLaneStatus | null;
  activeSessions: number;
  collapsedChildCount: number;
  /** Steps from the workspace primary lane along parent links (0 = primary). */
  hierarchyDepth: number;
  /** Immediate parent lane name when parent exists in the workspace. */
  parentLaneName: string | null;
  dimmed: boolean;
  activityBucket: "min" | "low" | "medium" | "high";
  viewMode: GraphViewMode;
  lastActivityAt: string | null;
  environment: { env: string; color: string | null } | null;
  highlight: boolean;
  rebaseFailed: boolean;
  rebasePulse: boolean;
  mergeInProgress: boolean;
  mergeDisappearing: boolean;
  isIntegration: boolean;
  focusGlow: boolean;
  isVirtualProposal: boolean;
  integrationSources: Array<{ laneId: string; laneName: string }>;
  pr: GraphPrOverlay | null;
  proposalOutcome?: "clean" | "conflict" | "blocked";
  proposalId?: string;
  /**
   * Set only on a node a plugin contributed. Its presence is what makes the node
   * synthetic — see `isSyntheticGraphNode`.
   *
   * A plugin node carries a synthetic `lane` for the same reason a virtual
   * proposal does: every handler on this canvas is typed `Node<GraphNodeData>`,
   * and a second data shape would fork thirty call sites to express "this one
   * has no branch". The synthetic lane is never read by the plugin renderer, and
   * no handler that would act on a real lane is reached with one — the guards
   * refuse a synthetic node before any of them.
   */
  pluginNode?: PluginGraphNodeEntry;
  /** Invokes the plugin node's socket. Absent when the entry declares none. */
  onPressPluginNode?: () => void;
};

/**
 * Nodes that are not lanes: virtual integration proposals and plugin nodes.
 *
 * One predicate rather than a widening `isVirtualProposal` check at each guard.
 * Every one of them exists to answer the same question — may this node be
 * dragged, reparented, dropped onto, or opened as a lane — and the answer for
 * both kinds is no.
 */
export function isSyntheticGraphNode(data: GraphNodeData): boolean {
  return data.isVirtualProposal || data.pluginNode !== undefined;
}

export type RebasePublishOutcome =
  | { status: "done"; message?: string }
  | { status: "skipped"; message: string };

export type GraphPrOverlay = {
  prId: string;
  laneId: string;
  baseLaneId: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  checksStatus: PrStatus["checksStatus"];
  /** Rollup explanation for a non-obvious `checksStatus`. */
  checksReason: string | null;
  reviewStatus: PrReviewStatus;
  lastSyncedAt: string | null;
  lastActivityAt: string | null;
  mergeInProgress: boolean;
  isMergeable: boolean | null;
  mergeConflicts: boolean | null;
  behindBaseBy: number | null;
  reviewCount: number;
  approvedCount: number;
  changeRequestCount: number;
  commentCount: number;
  pendingCheckCount: number;
  activityState: PrActivityState;
  detailLoaded: boolean;
};

export type GraphEdgeData = {
  edgeType: "topology" | "stack" | "risk" | "integration" | "proposal" | "plugin";
  riskLevel?: "none" | "low" | "medium" | "high";
  overlapCount?: number;
  stale?: boolean;
  dimmed?: boolean;
  highlight?: boolean;
  proposalConflict?: boolean;
  pr?: GraphPrOverlay;
  /**
   * `edgeType: "plugin"` only: what the plugin's line asserts, and whose it is.
   *
   * Both are carried on the edge rather than looked up from the node it leaves,
   * because `RiskEdge` draws from edge data alone and reaching back into the
   * node store to colour a line would make every edge re-render on any node
   * change.
   */
  pluginEdgeKind?: PluginGraphEdgeKind;
  pluginEdgeLabel?: string;
  pluginAccent?: string | null;
};

export type BatchStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type BatchStep = {
  laneId: string;
  laneName: string;
  status: BatchStepStatus;
  error?: string;
};

export type BatchProgress = { completedPairs: number; totalPairs: number };

export type GraphTextPromptState = {
  title: string;
  message?: string;
  placeholder?: string;
  value: string;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

export type ConflictPanelState = {
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
