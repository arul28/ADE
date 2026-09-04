/**
 * ADE's own shapes, copied down from `apps/desktop/src/shared/types/**`.
 *
 * A guest cannot import the app's types: the page is built separately from the
 * binary it runs inside, and nothing crosses the bridge but JSON. So the shapes
 * the History page actually reads live here, verbatim from the source of truth,
 * with everything the page never touches left behind.
 */

export type LaneType = "primary" | "worktree" | "attached";

export type HistoryLane = {
  id: string;
  name: string;
  color?: string | null;
  worktreePath?: string | null;
  laneType?: LaneType;
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

export type GitBranchSummary = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  lastCommitSha?: string;
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

export type GitStashSummary = {
  oid: string;
  ref: string;
  subject: string;
  createdAt: string | null;
};

export type GitOriginRemote = {
  remoteUrl: string | null;
  branch: string | null;
};

export type GitOpenPrForBranch = {
  prUrl: string | null;
  prNumber: number | null;
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

export type AgentChatSessionSummary = {
  sessionId: string;
  laneId: string | null;
  provider: string;
  model: string;
  title: string | null;
  goal?: string | null;
  status: "active" | "idle" | "ended" | string;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  lastOutputPreview: string | null;
  summary: string | null;
  sessionProfile?: string | null;
  awaitingInput?: boolean;
  automationId?: string | null;
  automationRunId?: string | null;
};

export type CtoRecentSession = {
  id: string;
  sessionId: string;
  summary: string;
  startedAt: string | null;
  endedAt: string | null;
  provider: string | null;
  modelId: string | null;
  capabilityMode: string | null;
  createdAt: string | null;
};

export type CtoSnapshot = {
  identity?: {
    name: string;
    version: number;
    persona: string;
    modelPreferences?: { provider?: string; model?: string };
    updatedAt: string;
  };
  recentSessions: CtoRecentSession[];
};

export type PageActionResult = {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
};
