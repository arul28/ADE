/**
 * ADE's own shapes, copied down from `apps/desktop/src/shared/types/**`.
 *
 * A guest cannot import the app's types: the page is built separately from the
 * binary it runs inside, and nothing crosses the bridge but JSON. So the shapes
 * the graph actually reads live here, verbatim from the source of truth, with
 * everything the canvas never touches left behind.
 *
 * The rule for editing this file: a field is copied only when something in
 * `src/` reads it. A partial copy is honest — it says what the page depends on —
 * and a full mirror would silently rot the day the app adds a field the graph
 * has no opinion about.
 */

/* ── Lanes ──────────────────────────────────────────────────────────────── */

export type LaneType = "primary" | "worktree" | "attached";

export type LaneIcon = "star" | "flag" | "bolt" | "shield" | "tag" | null;

export type LaneStatus = {
  dirty: boolean;
  ahead: number;
  behind: number;
  /** Commits the remote is ahead of local. 0 = in sync, -1 = no upstream. */
  remoteBehind: number;
  rebaseInProgress: boolean;
  headBranchRef?: string | null;
};

/** The lane's primary issue, on whichever tracker owns it. */
export type LaneIssueRef = {
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
};

export type LaneSummary = {
  id: string;
  name: string;
  description?: string | null;
  laneType: LaneType;
  baseRef: string;
  branchRef: string;
  worktreePath: string;
  attachedRootPath?: string | null;
  parentLaneId: string | null;
  childCount: number;
  stackDepth: number;
  parentStatus: LaneStatus | null;
  isEditProtected: boolean;
  status: LaneStatus;
  color: string | null;
  icon: LaneIcon | null;
  tags: string[];
  folder?: string | null;
  createdAt: string;
  archivedAt?: string | null;
  /** Drawn as a badge on the lane card when the host reports one. */
  primaryIssue?: LaneIssueRef | null;
};

export type AutoRebaseLaneState = "autoRebased" | "rebasePending" | "rebaseConflict" | "rebaseFailed";

export type AutoRebaseLaneStatus = {
  laneId: string;
  parentLaneId: string | null;
  parentHeadSha: string | null;
  state: AutoRebaseLaneState;
  updatedAt: string;
  conflictCount: number;
  message: string | null;
};

/* ── Graph state ────────────────────────────────────────────────────────── */

export type GraphViewMode = "stack" | "risk" | "activity" | "all";

export type GraphNodePosition = { x: number; y: number };

export type GraphStatusFilter = "conflict" | "at-risk" | "clean" | "unknown";

export type GraphFilterState = {
  status: GraphStatusFilter[];
  laneTypes: LaneType[];
  tags: string[];
  hidePrimary: boolean;
  hideAttached: boolean;
  hideArchived: boolean;
  rootLaneId: string | null;
  search: string;
};

export type GraphLayoutSnapshot = {
  nodePositions: Record<string, GraphNodePosition>;
  collapsedLaneIds: string[];
  viewMode: GraphViewMode;
  filters: GraphFilterState;
  updatedAt: string;
};

export type GraphPersistedState = { lastViewMode: GraphViewMode };

/* ── Git ────────────────────────────────────────────────────────────────── */

export type GitSyncMode = "merge" | "rebase";
export type GitRecommendedAction = "none" | "pull" | "push" | "force_push_lease";
export type GitUpstreamState = "none" | "tracking" | "missing";

export type GitUpstreamSyncStatus = {
  hasUpstream: boolean;
  upstreamState: GitUpstreamState;
  upstreamRef: string | null;
  ahead: number;
  behind: number;
  diverged: boolean;
  recommendedAction: GitRecommendedAction;
};

export type OperationRecord = {
  id: string;
  laneId: string | null;
  laneName: string | null;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "succeeded" | "failed" | "canceled";
};

/* ── Conflicts ──────────────────────────────────────────────────────────── */

export type ConflictRiskLevel = "none" | "low" | "medium" | "high";

export type ConflictStatusValue =
  | "merge-ready"
  | "behind-base"
  | "conflict-predicted"
  | "conflict-active"
  | "unknown";

export type ConflictStatus = {
  laneId: string;
  status: ConflictStatusValue;
  overlappingFileCount: number;
  peerConflictCount: number;
  lastPredictedAt: string | null;
};

export type RiskMatrixEntry = {
  laneAId: string;
  laneBId: string;
  riskLevel: ConflictRiskLevel;
  overlapCount: number;
  hasConflict: boolean;
  computedAt: string | null;
  stale: boolean;
};

export type BatchOverlapEntry = {
  laneAId: string;
  laneBId: string;
  files: string[];
};

export type MergeSimulationResult = {
  outcome: "clean" | "conflict" | "error";
  mergedFiles: string[];
  conflictingFiles: Array<{ path: string; conflictMarkers: string }>;
  diffStat: { insertions: number; deletions: number; filesChanged: number };
  error?: string;
};

export type BatchAssessmentResult = {
  lanes: ConflictStatus[];
  matrix: RiskMatrixEntry[];
  overlaps: BatchOverlapEntry[];
  computedAt: string;
  progress?: { completedPairs: number; totalPairs: number };
  truncated?: boolean;
  maxAutoLanes?: number;
  totalLanes?: number;
  comparedLaneIds?: string[];
};

export type ConflictProposalStatus = "pending" | "ready" | "applied" | "reverted" | "failed";

export type ConflictProposal = {
  id: string;
  laneId: string;
  peerLaneId: string | null;
  confidence: number | null;
  explanation: string;
  status: ConflictProposalStatus;
  createdAt: string;
  updatedAt: string;
};

export type ConflictProposalPreviewFile = {
  path: string;
  markerPreview?: string | null;
  laneDiff?: string | null;
  peerDiff?: string | null;
};

export type ConflictProposalPreview = {
  laneId: string;
  peerLaneId: string | null;
  preparedAt: string;
  contextDigest: string;
  laneExportLite: string | null;
  peerLaneExportLite: string | null;
  conflictExportStandard: string | null;
  files: ConflictProposalPreviewFile[];
  stats: {
    fileCount: number;
    approxChars: number;
    laneExportChars: number;
    peerLaneExportChars: number;
    conflictExportChars: number;
  };
  warnings: string[];
  existingProposalId: string | null;
};

/* ── PRs ────────────────────────────────────────────────────────────────── */

export type PrState = "draft" | "open" | "merged" | "closed";
export type PrChecksStatus = "pending" | "passing" | "failing" | "none" | "not_run";
export type PrReviewStatus = "none" | "requested" | "approved" | "changes_requested";
export type MergeMethod = "merge" | "squash" | "rebase";

export type PrSummary = {
  id: string;
  laneId: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  githubUrl: string;
  title: string;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  checksStatus: PrChecksStatus;
  checksReason?: string | null;
  reviewStatus: PrReviewStatus;
  additions: number;
  deletions: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrWithConflicts = PrSummary;

export type PrStatus = {
  prId: string;
  state: PrState;
  checksStatus: PrChecksStatus;
  checksReason?: string | null;
  reviewStatus: PrReviewStatus;
  isMergeable: boolean;
  mergeConflicts: boolean;
  behindBaseBy: number | null;
};

export type PrCheck = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "skipped"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PrReview = {
  reviewer: string;
  reviewerAvatarUrl: string | null;
  state: "pending" | "approved" | "changes_requested" | "commented" | "dismissed";
  body: string | null;
  submittedAt: string | null;
};

export type PrComment = {
  id: string;
  author: string;
  authorAvatarUrl: string | null;
  body: string | null;
  source: "issue" | "review";
  url: string | null;
  path: string | null;
  line: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/* ── Integration proposals ──────────────────────────────────────────────── */

export type IntegrationOutcome = "clean" | "conflict" | "blocked";

export type IntegrationProposalStep = {
  laneId: string;
  laneName?: string;
  outcome: IntegrationOutcome;
};

export type IntegrationLaneSummary = {
  laneId: string;
  laneName?: string;
  outcome: IntegrationOutcome;
  conflictsWith?: string[];
};

export type IntegrationPairwiseResult = {
  laneAId: string;
  laneBId: string;
  outcome: "clean" | "conflict";
};

export type IntegrationProposal = {
  proposalId: string;
  sourceLaneIds: string[];
  baseBranch: string;
  pairwiseResults: IntegrationPairwiseResult[];
  laneSummaries: IntegrationLaneSummary[];
  steps: IntegrationProposalStep[];
  overallOutcome: IntegrationOutcome;
  createdAt: string;
  title?: string;
  integrationLaneName?: string;
  status: "proposed" | "committed";
  integrationLaneId?: string | null;
};

/* ── Project config ─────────────────────────────────────────────────────── */

export type EnvironmentMapping = {
  /** Branch pattern with a simple `*` glob, e.g. `release/*`. */
  branch: string;
  env: string;
  color?: string;
};

/** What `pageProjectConfig` answers — the one slice the graph reads. */
export type PageProjectConfig = {
  environments: EnvironmentMapping[];
};
