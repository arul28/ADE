import type {
  ConflictProposal,
  ConflictProposalPreview,
  ConflictStatus,
  GitUpstreamSyncStatus,
  AutoRebaseLaneStatus,
  GraphViewMode,
  LaneSummary,
  MergeMethod,
  MergeSimulationResult,
  PrCheck,
  PrComment,
  PrReview,
  PrReviewStatus,
  PrState,
  PrStatus,
  PrWithConflicts
} from "../../../shared/types";
import type { PrActivityState } from "../prs/shared/prVisuals";

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
};

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
  edgeType: "topology" | "stack" | "risk" | "integration" | "proposal";
  riskLevel?: "none" | "low" | "medium" | "high";
  overlapCount?: number;
  stale?: boolean;
  dimmed?: boolean;
  highlight?: boolean;
  proposalConflict?: boolean;
  pr?: GraphPrOverlay;
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

export type PrDialogState = {
  laneId: string;
  baseLaneId: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
  loadingDraft: boolean;
  creating: boolean;
  existingPr: PrWithConflicts | null;
  loadingDetails: boolean;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  mergeMethod: MergeMethod;
  merging: boolean;
  error: string | null;
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

export type IntegrationDialogState = {
  laneIds: string[];
  targetLaneId: string | null;
  name: string;
  busy: boolean;
  step: string | null;
  error: string | null;
};
