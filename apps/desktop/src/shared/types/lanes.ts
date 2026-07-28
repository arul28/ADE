import type { AgentChatSessionSummary } from "./chat";
import type { LaneEnvInitProgress } from "./config";
import type { ConflictOverlap, ConflictStatus } from "./conflicts";
import type { LinearPriorityLabel } from "./linearSync";
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
  /**
   * Branch the worktree's HEAD actually points at, read live during the status
   * refresh. Absent when status was not computed; `null` on a detached HEAD.
   */
  headBranchRef?: string | null;
};

/**
 * Set when the lane worktree's live HEAD no longer matches `lanes.branch_ref`
 * (someone ran `git checkout` inside the worktree). Both refs are plain branch
 * names, `refs/heads/` and `origin/` stripped.
 */
export type LaneBranchDrift = {
  /** What ADE recorded for the lane and still advertises. */
  expectedBranchRef: string;
  /** What the worktree is actually on right now. */
  headBranchRef: string;
};

export type LaneBranchDriftResolution =
  /** Restore the worktree to `expectedBranchRef`; refuses if the tree is dirty. */
  | "switch-back"
  /** Re-point the lane at `headBranchRef` and rename it to match. */
  | "keep-head";

export type ResolveLaneBranchDriftArgs = {
  laneId: string;
  resolution: LaneBranchDriftResolution;
  /** Required for `keep-head`; guards against acting on a stale drift reading. */
  expectedHeadBranchRef?: string;
  /** `switch-back` only: proceed even though sessions/processes are running. */
  acknowledgeActiveWork?: boolean;
};

export type ResolveLaneBranchDriftResult = {
  lane: LaneSummary;
  resolution: LaneBranchDriftResolution;
  previousBranchRef: string;
  branchRef: string;
  /** Set by `keep-head` when the lane display name was re-pointed too. */
  previousLaneName: string | null;
  laneName: string;
};

export type DeviceMarker = {
  deviceId: string;
  displayName: string;
  platform: string;
};

export type LaneSummary = {
  id: string;
  name: string;
  description?: string | null;
  laneType: LaneType;
  baseRef: string;
  branchRef: string;
  worktreePath: string;
  worktreeAvailable?: boolean;
  attachedRootPath?: string | null;
  parentLaneId: string | null;
  childCount: number;
  stackDepth: number;
  parentStatus: LaneStatus | null;
  isEditProtected: boolean;
  status: LaneStatus;
  /** Non-null when the worktree HEAD has drifted off `branchRef`. */
  branchDrift?: LaneBranchDrift | null;
  color: string | null;
  icon: LaneIcon | null;
  tags: string[];
  folder?: string | null;
  createdAt: string;
  archivedAt?: string | null;
  devicesOpen?: DeviceMarker[];
  activeBranchProfile?: LaneBranchProfile | null;
  linearIssue?: LaneLinearIssue | null;
  linearIssueLinks?: LaneLinearIssueLink[];
};

export type LaneLinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string | null;
  projectId: string;
  projectSlug: string;
  projectName?: string | null;
  teamId: string;
  teamKey: string;
  teamName?: string | null;
  stateId: string;
  stateName: string;
  stateType: string;
  priority: number;
  priorityLabel: LinearPriorityLabel;
  labels: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  creatorId?: string | null;
  creatorName?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  branchName?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LaneLinearIssueLinkRole = "primary" | "worked" | "referenced" | "inferred";

export type LaneLinearIssueLinkSource =
  | "lane_create"
  | "lane_link"
  | "chat_attach"
  | "linear_open_issue"
  | "commit"
  | "pr_body"
  | "manual";

export type LaneLinearIssueLink = {
  id: string;
  laneId: string;
  issue: LaneLinearIssue;
  role: LaneLinearIssueLinkRole;
  source: LaneLinearIssueLinkSource;
  includeInPr: boolean;
  closeOnMerge: boolean;
  evidence?: {
    chatSessionId?: string | null;
    commitSha?: string | null;
    prId?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Session-scoped Linear issue link. Lets a chat (`claude_sessions`) or CLI
 * session (`terminal_sessions`) attach a Linear issue even when it has no lane
 * (standalone chats, `ade chat` sessions). When the session belongs to a lane,
 * `laneId` mirrors it and the link is also written into `lane_linear_issue_links`
 * (source `chat_attach`) so PR-open closeout can fan out from session → lane.
 * Reuses `LaneLinearIssueLinkRole` / `LaneLinearIssueLinkSource` so chat, CLI,
 * and lane links share the same role/source vocabulary.
 */
export type SessionLinearIssueLink = {
  id: string;
  sessionId: string;
  laneId: string | null;
  issue: LaneLinearIssue;
  role: LaneLinearIssueLinkRole;
  source: LaneLinearIssueLinkSource;
  includeInPr: boolean;
  closeOnMerge: boolean;
  evidence?: {
    chatSessionId?: string | null;
    commitSha?: string | null;
    prId?: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type LaneBranchProfile = {
  id: string;
  laneId: string;
  branchRef: string;
  baseRef: string;
  parentLaneId: string | null;
  sourceBranchRef: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedOutAt: string | null;
};

export type LaneRuntimeBucket = "running" | "awaiting-input" | "ended" | "none";

export type LaneRuntimeSummary = {
  bucket: LaneRuntimeBucket;
  runningCount: number;
  awaitingInputCount: number;
  /** Exact pending input requests from chat sessions; excludes idle CLI heuristics. */
  pendingInputCount?: number;
  endedCount: number;
  sessionCount: number;
};

export type LaneStateSnapshotSummary = {
  laneId: string;
  agentSummary: Record<string, unknown> | null;
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
  signature?: string;
  notModified?: boolean;
};

export type LaneIcon = "star" | "flag" | "bolt" | "shield" | "tag" | null;

export type ListLanesArgs = {
  includeArchived?: boolean;
  includeStatus?: boolean;
  includeConflictStatus?: boolean;
  includeRebaseSuggestions?: boolean;
  includeAutoRebaseStatus?: boolean;
};

export type CreateLaneArgs = {
  name: string;
  description?: string;
  parentLaneId?: string;
  baseBranch?: string;
  branchName?: string;
  startPoint?: string;
  linearIssue?: LaneLinearIssue | null;
};

export type CreateChildLaneArgs = {
  parentLaneId: string;
  name: string;
  description?: string;
  folder?: string;
  baseBranchRef?: string;
  branchName?: string;
  linearIssue?: LaneLinearIssue | null;
};

export type CreateLaneFromUnstagedArgs = {
  sourceLaneId: string;
  name: string;
};

export type ImportBranchLaneArgs = {
  branchRef: string;
  name?: string;
  description?: string;
  baseBranch?: string;
};

export type LaneBranchSwitchMode = "existing" | "create";

export type LaneBranchActiveWorkItem = {
  id: string;
  kind: "terminal";
  title: string;
  status: string;
};

export type LaneBranchSwitchArgs = {
  laneId: string;
  branchName: string;
  mode?: LaneBranchSwitchMode;
  startPoint?: string;
  baseRef?: string;
  acknowledgeActiveWork?: boolean;
};

export type LaneBranchSwitchPreview = {
  laneId: string;
  currentBranchRef: string;
  targetBranchRef: string;
  mode: LaneBranchSwitchMode;
  dirty: boolean;
  duplicateLaneId: string | null;
  duplicateLaneName: string | null;
  activeWork: LaneBranchActiveWorkItem[];
  targetProfile: LaneBranchProfile | null;
};

export type LaneBranchSwitchResult = {
  lane: LaneSummary;
  previousBranchRef: string;
  activeWork: LaneBranchActiveWorkItem[];
};

export type AttachLaneArgs = {
  name: string;
  attachedPath: string;
  description?: string;
};

export type UnregisteredLaneCandidate = {
  path: string;
  branch: string;
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
  /**
   * Git branch name to stack onto (resolved in the project repo, prefers `origin/<branch>`).
   * When omitted, uses the new parent lane's current branch, or for the primary lane the same
   * upstream / origin resolution as graph reparent.
   */
  stackBaseBranchRef?: string | null;
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

export type LaneReclaimBlockReason =
  | "primary_lane"
  | "attached_lane"
  | "worktree_outside_managed_root"
  | "worktree_not_registered"
  | "symlink_path"
  | "active_work"
  | "dirty_worktree"
  | "unmerged_work";

export type LaneReclaimRisk = LaneDeleteRisk & {
  laneName: string;
  worktreePath: string;
  worktreeBytes: number;
  generatedBytes: number;
  reclaimableBytes: number;
  worktreeAvailable: boolean;
  blockedReasons: Array<{
    code: LaneReclaimBlockReason;
    message: string;
    disposition: "blocked" | "confirmation_required";
  }>;
  lastFailure: string | null;
  retryCount: number;
};

export type ArchiveAndReclaimLaneArgs = {
  laneId: string;
  /** Required for every reclaim so a stale or accidental action cannot remove files. */
  confirmation: "RECLAIM";
  /** Allows confirmed removal of uncommitted files. Never used by scheduled cleanup. */
  forceDirty?: boolean;
};

export type ArchiveAndReclaimLaneResult = {
  laneId: string;
  reclaimedBytes: number;
  worktreeRemoved: boolean;
  generatedDataRemoved: boolean;
  warnings: string[];
};

export type RestoreLaneResult = {
  lane: LaneSummary;
  worktreeRecreated: boolean;
  setupWarning?: string | null;
};

export type DeleteLaneArgs = {
  laneId: string;
  deleteBranch?: boolean;
  deleteRemoteBranch?: boolean;
  requireRemoteBranchDelete?: boolean;
  remoteName?: string;
  force?: boolean;
};

export type LaneDeleteStepName =
  | "stop_chats"
  | "stop_ptys"
  | "stop_watchers"
  | "cancel_auto_rebase"
  | "cleanup_env"
  | "git_status"
  | "git_worktree_remove"
  | "git_branch_delete"
  | "git_remote_branch_delete"
  | "pack_dir_remove"
  | "database_cleanup";

export type LaneDeleteStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "warning"
  | "failed"
  | "skipped";

export type LaneDeleteStep = {
  name: LaneDeleteStepName;
  status: LaneDeleteStepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: string;
  errorMessage?: string;
};

export type LaneDeleteOverallStatus = "running" | "completed" | "completed_with_warnings" | "failed" | "cancelled";

export type LaneDeleteProgress = {
  laneId: string;
  steps: LaneDeleteStep[];
  startedAt: string;
  completedAt?: string;
  overallStatus: LaneDeleteOverallStatus;
  cancellable: boolean;
};

export type LaneDeleteEvent = {
  type: "lane-delete";
  progress: LaneDeleteProgress;
};

/**
 * Fired once when a lane reaches a terminal lifecycle transition, so the
 * renderer can surface a toast without polling. Distinct from
 * {@link LaneDeleteEvent}, which streams per-step delete progress; this fires a
 * single time on successful completion. `lane` carries the full summary for
 * created lanes (the create paths already have it); archive/delete/rename only
 * need enough metadata for notices and renderer list invalidation.
 */
export type LaneLifecycleEvent = {
  type:
    | "lane-created"
    | "lane-renamed"
    | "lane-archived"
    | "lane-unarchived"
    | "lane-reclaimed"
    | "lane-restored"
    | "lane-deleted";
  laneId: string;
  laneName: string;
  previousLaneName?: string | null;
  color?: string | null;
  lane?: LaneSummary;
};

export type LaneDeleteRisk = {
  laneId: string;
  branchRef: string | null;
  dirty: boolean;
  hasUnpushedCommits: boolean;
  unpushedCommitCount: number;
  remoteBranchExists: boolean;
  activeChatCount: number;
  activePtyCount: number;
  activeWatcherCount: number;
  envInitialized: boolean;
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

export type RebaseTargetCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  committedAt: string;
};

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
  /** Commits that would be pulled in by a rebase against this target head. Capped at 20 entries; may be undefined for legacy suggestions. */
  targetCommits?: RebaseTargetCommit[];
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
