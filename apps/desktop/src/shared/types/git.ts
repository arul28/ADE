// ---------------------------------------------------------------------------
// Git types
// ---------------------------------------------------------------------------

export type GitSyncMode = "merge" | "rebase";

export type GitFileActionArgs = {
  laneId: string;
  path: string;
};

export type GitBatchFileActionArgs = {
  laneId: string;
  paths: string[];
};

export type GitCommitArgs = {
  laneId: string;
  message: string;
  amend?: boolean;
};

export type GitGenerateCommitMessageArgs = {
  laneId: string;
  amend?: boolean;
};

export type GitGenerateCommitMessageResult = {
  message: string;
  model: string | null;
};

export type GitRevertArgs = {
  laneId: string;
  commitSha: string;
};

export type GitCherryPickArgs = {
  laneId: string;
  commitSha: string;
};

export type GitStashPushArgs = {
  laneId: string;
  message?: string;
  includeUntracked?: boolean;
};

export type GitStashRefArgs = {
  laneId: string;
  stashRef: string;
};

export type GitSyncArgs = {
  laneId: string;
  mode?: GitSyncMode;
  baseRef?: string;
};

export type GitPushArgs = {
  laneId: string;
  forceWithLease?: boolean;
};

export type GitRecommendedAction = "none" | "pull" | "push" | "force_push_lease";

export type GitUpstreamSyncStatus = {
  hasUpstream: boolean;
  upstreamRef: string | null;
  ahead: number;
  behind: number;
  diverged: boolean;
  recommendedAction: GitRecommendedAction;
};

export type GitConflictKind = "merge" | "rebase" | null;

export type GitConflictState = {
  laneId: string;
  kind: GitConflictKind;
  inProgress: boolean;
  conflictedFiles: string[];
  canContinue: boolean;
  canAbort: boolean;
};

export type GitActionResult = {
  operationId: string;
  preHeadSha: string | null;
  postHeadSha: string | null;
};

export type GitCommitSummary = {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authoredAt: string;
  subject: string;
  pushed: boolean;
};

export type GitListCommitFilesArgs = {
  laneId: string;
  commitSha: string;
};

export type GitGetCommitMessageArgs = {
  laneId: string;
  commitSha: string;
};

export type GitStashSummary = {
  ref: string;
  subject: string;
  createdAt: string | null;
};

export type DiffMode = "unstaged" | "staged" | "commit";

export type FileChange = {
  path: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown";
};

export type DiffChanges = {
  unstaged: FileChange[];
  staged: FileChange[];
};

export type GetDiffChangesArgs = {
  laneId: string;
};

export type GetFileDiffArgs = {
  laneId: string;
  path: string; // repo-relative path
  mode: DiffMode;
  compareRef?: string;
  compareTo?: "worktree" | "parent";
};

export type DiffSide = {
  exists: boolean;
  text: string;
};

export type FileDiff = {
  path: string;
  mode: DiffMode;
  original: DiffSide;
  modified: DiffSide;
  isBinary?: boolean;
  language?: string;
};

export type WriteTextAtomicArgs = {
  laneId: string;
  path: string; // repo-relative path
  text: string;
};

export type GitBranchSummary = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
};

export type GitListBranchesArgs = {
  laneId: string;
};

export type GitCheckoutBranchArgs = {
  laneId: string;
  branchName: string;
};

export type GitHubRepoRef = {
  owner: string;
  name: string;
};

export type GitHubStatus = {
  tokenStored: boolean;
  tokenDecryptionFailed: boolean;
  storageScope: "app";
  repo: GitHubRepoRef | null;
  userLogin: string | null;
  scopes: string[];
  checkedAt: string | null;
};

export type ListOperationsArgs = {
  laneId?: string;
  kind?: string;
  limit?: number;
};

export type OperationRecord = {
  id: string;
  laneId: string | null;
  laneName: string | null;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "succeeded" | "failed" | "canceled";
  preHeadSha: string | null;
  postHeadSha: string | null;
  metadataJson: string | null;
};

export type ExportHistoryArgs = ListOperationsArgs & {
  status?: OperationRecord["status"] | "all";
  format: "csv" | "json";
};

export type ExportHistoryResult =
  | { cancelled: true }
  | {
      cancelled: false;
      savedPath: string;
      bytesWritten: number;
      exportedAt: string;
      rowCount: number;
      format: "csv" | "json";
    };

// ---------------------------------------------------------------------------
// Metadata type aliases
// ---------------------------------------------------------------------------

/** Metadata stored on operation rows (git operations service). Known keys:
 *  path, count, amend, message, commitSha, stashRef, mode, branchName, etc. */
export type OperationMetadata = Record<string, unknown> & {
  error?: string;
};
