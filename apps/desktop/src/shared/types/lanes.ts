import type { AgentChatSessionSummary } from "./chat";
import type { LaneEnvInitProgress } from "./config";
import type { ConflictOverlap, ConflictStatus } from "./conflicts";
import type {
  DiffChanges,
  GitCommitSummary,
  GitConflictState,
  GitStashSummary,
  GitUpstreamSyncStatus,
} from "./git";
import type { TerminalSessionSummary } from "./sessions";

// ---------------------------------------------------------------------------
// Lane types
// ---------------------------------------------------------------------------

export type LaneType = "primary" | "worktree" | "attached";

export type LaneStatus = {
  dirty: boolean;
  ahead: number;
  behind: number;
  /** Commits the remote tracking branch is ahead of local (0 = in sync, -1 = no upstream) */
  remoteBehind: number;
  /** true when the worktree is stuck in an interrupted rebase (rebase-merge / rebase-apply dir exists) */
  rebaseInProgress: boolean;
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
};

export type LaneRuntimeBucket = "running" | "awaiting-input" | "ended" | "none";

export type LaneRuntimeSummary = {
  bucket: LaneRuntimeBucket;
  runningCount: number;
  awaitingInputCount: number;
  endedCount: number;
  sessionCount: number;
};

export type LaneStateSnapshotSummary = {
  laneId: string;
  agentSummary: Record<string, unknown> | null;
  missionSummary: Record<string, unknown> | null;
  updatedAt: string | null;
};

export type LaneListSnapshot = {
  lane: LaneSummary;
  runtime: LaneRuntimeSummary;
  rebaseSuggestion: RebaseSuggestion | null;
  autoRebaseStatus: AutoRebaseLaneStatus | null;
  conflictStatus: ConflictStatus | null;
  stateSnapshot: LaneStateSnapshotSummary | null;
  adoptableAttached: boolean;
};

export type LaneDetailPayload = {
  lane: LaneSummary;
  runtime: LaneRuntimeSummary;
  stackChain: StackChainItem[];
  children: LaneSummary[];
  stateSnapshot: LaneStateSnapshotSummary | null;
  rebaseSuggestion: RebaseSuggestion | null;
  autoRebaseStatus: AutoRebaseLaneStatus | null;
  conflictStatus: ConflictStatus | null;
  overlaps: ConflictOverlap[];
  syncStatus: GitUpstreamSyncStatus | null;
  conflictState: GitConflictState | null;
  recentCommits: GitCommitSummary[];
  diffChanges: DiffChanges | null;
  stashes: GitStashSummary[];
  envInitProgress: LaneEnvInitProgress | null;
  sessions: TerminalSessionSummary[];
  chatSessions: AgentChatSessionSummary[];
};

export type LaneIcon = "star" | "flag" | "bolt" | "shield" | "tag" | null;

export type ListLanesArgs = {
  includeArchived?: boolean;
  includeStatus?: boolean;
};

export type CreateLaneArgs = {
  name: string;
  description?: string;
  parentLaneId?: string;
  baseBranch?: string;
};

export type CreateChildLaneArgs = {
  parentLaneId: string;
  name: string;
  description?: string;
  folder?: string;
};

export type CreateLaneFromUnstagedArgs = {
  sourceLaneId: string;
  name: string;
};

export type ImportBranchLaneArgs = {
  branchRef: string;
  name?: string;
  description?: string;
  parentLaneId?: string | null;
};

export type AttachLaneArgs = {
  name: string;
  attachedPath: string;
  description?: string;
};

export type AdoptAttachedLaneArgs = {
  laneId: string;
};

export type RenameLaneArgs = {
  laneId: string;
  name: string;
};

export type ReparentLaneArgs = {
  laneId: string;
  newParentLaneId: string;
};

export type ReparentLaneResult = {
  laneId: string;
  previousParentLaneId: string | null;
  newParentLaneId: string;
  previousBaseRef: string;
  newBaseRef: string;
  preHeadSha: string | null;
  postHeadSha: string | null;
};

export type UpdateLaneAppearanceArgs = {
  laneId: string;
  color?: string | null;
  icon?: LaneIcon;
  tags?: string[] | null;
};

export type ArchiveLaneArgs = {
  laneId: string;
};

export type DeleteLaneArgs = {
  laneId: string;
  deleteBranch?: boolean;
  deleteRemoteBranch?: boolean;
  remoteName?: string;
  force?: boolean;
};

export type StackChainItem = {
  laneId: string;
  laneName: string;
  branchRef: string;
  depth: number;
  parentLaneId: string | null;
  status: LaneStatus;
};

export type RebaseScope = "lane_only" | "lane_and_descendants";

export type PushMode = "none" | "review_then_push";

export type RebaseLaneStatus = "pending" | "running" | "succeeded" | "conflict" | "blocked" | "skipped";

export type RebaseRunLane = {
  laneId: string;
  laneName: string;
  parentLaneId: string | null;
  status: RebaseLaneStatus;
  preHeadSha: string | null;
  postHeadSha: string | null;
  error: string | null;
  conflictingFiles: string[];
  pushed: boolean;
};

export type RebaseRunState = "running" | "completed" | "failed" | "aborted";

export type RebaseRun = {
  runId: string;
  rootLaneId: string;
  scope: RebaseScope;
  pushMode: PushMode;
  state: RebaseRunState;
  startedAt: string;
  finishedAt: string | null;
  actor: string;
  baseBranch: string | null;
  lanes: RebaseRunLane[];
  currentLaneId: string | null;
  failedLaneId: string | null;
  error: string | null;
  pushedLaneIds: string[];
  canRollback: boolean;
  rootBaseRefBefore?: string | null;
  rootBaseRefAfter?: string | null;
};

export type RebaseStartArgs = {
  laneId: string;
  scope?: RebaseScope;
  pushMode?: PushMode;
  actor?: string;
  reason?: string;
  baseBranchOverride?: string | null;
};

export type RebaseStartResult = {
  runId: string;
  run: RebaseRun;
};

export type RebasePushArgs = {
  runId: string;
  laneIds: string[];
};

export type RebaseRollbackArgs = {
  runId: string;
};

export type RebaseAbortArgs = {
  runId: string;
};

export type RebaseSubscribeArgs = {
  runId?: string;
};

export type RebaseRunEventPayload =
  | { type: "rebase-run-updated"; run: RebaseRun; timestamp: string }
  | { type: "rebase-run-log"; runId: string; laneId: string | null; message: string; timestamp: string };

export type RebaseSuggestion = {
  laneId: string;
  parentLaneId: string;
  parentHeadSha: string;
  behindCount: number;
  baseLabel?: string | null;
  groupContext?: string | null;
  lastSuggestedAt: string;
  deferredUntil: string | null;
  dismissedAt: string | null;
  hasPr: boolean;
};

export type RebaseSuggestionsEventPayload = {
  type: "rebase-suggestions-updated";
  computedAt: string;
  suggestions: RebaseSuggestion[];
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

export type AutoRebaseEventPayload = {
  type: "auto-rebase-updated";
  computedAt: string;
  statuses: AutoRebaseLaneStatus[];
};

// --------------------------------
// Graph / Workspace layout types
// --------------------------------

export type GraphViewMode = "stack" | "risk" | "activity" | "all";

export type GraphNodePosition = {
  x: number;
  y: number;
};

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

export type GraphPersistedState = {
  lastViewMode: GraphViewMode;
};

// --- Lane Environment Init args (Phase 5 W1) ---

export type InitLaneEnvArgs = {
  laneId: string;
};

export type GetLaneEnvStatusArgs = {
  laneId: string;
};

export type GetLaneOverlayArgs = {
  laneId: string;
};
