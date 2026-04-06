import type { AgentChatSessionSummary } from "./chat";

// ---------------------------------------------------------------------------
// Review types
// ---------------------------------------------------------------------------

export type ReviewTargetMode = "lane_diff" | "commit_range" | "working_tree" | "pr";
export type ReviewRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewAnchorState = "anchored" | "file_only" | "missing";
export type ReviewPublicationState = "local_only" | "published";
export type ReviewSourcePass = "single_pass" | "adjudicated";
export type ReviewSelectionMode = "full_diff" | "selected_commits" | "dirty_only";
export type ReviewPublishBehavior = "local_only" | "auto_publish";
export type ReviewPublicationStatus = "published" | "failed";
export type ReviewArtifactType =
  | "prompt"
  | "diff_bundle"
  | "review_output"
  | "untracked_snapshot"
  | "publication_request"
  | "publication_result";

export type ReviewPublicationDestination =
  | {
      kind: "github_pr_review";
      prId: string;
      repoOwner: string;
      repoName: string;
      prNumber: number;
      githubUrl: string | null;
    };

export type ReviewPublicationInlineComment = {
  findingId: string;
  path: string;
  line: number;
  position: number;
  body: string;
};

export type ReviewPublication = {
  id: string;
  runId: string;
  destination: ReviewPublicationDestination;
  reviewEvent: "COMMENT";
  status: ReviewPublicationStatus;
  reviewUrl: string | null;
  remoteReviewId: string | null;
  summaryBody: string;
  inlineComments: ReviewPublicationInlineComment[];
  summaryFindingIds: string[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ReviewCompareAgainstTarget =
  | {
      kind: "default_branch";
    }
  | {
      kind: "lane";
      laneId: string;
    };

export type ReviewResolvedCompareTarget = {
  kind: "default_branch" | "lane";
  label: string;
  ref: string | null;
  laneId: string | null;
  branchRef: string | null;
};

export type ReviewRunBudgetConfig = {
  maxFiles: number;
  maxDiffChars: number;
  maxPromptChars: number;
  maxFindings: number;
};

export type ReviewRunConfig = {
  compareAgainst: ReviewCompareAgainstTarget;
  selectionMode: ReviewSelectionMode;
  dirtyOnly: boolean;
  modelId: string;
  reasoningEffort: string | null;
  budgets: ReviewRunBudgetConfig;
  publishBehavior: ReviewPublishBehavior;
};

export type ReviewTarget =
  | {
      mode: "lane_diff";
      laneId: string;
    }
  | {
      mode: "commit_range";
      laneId: string;
      baseCommit: string;
      headCommit: string;
    }
  | {
      mode: "working_tree";
      laneId: string;
    }
  | {
      mode: "pr";
      laneId: string;
      prId: string;
    };

export type ReviewEvidence = {
  kind: "quote" | "diff_hunk" | "artifact" | "file_snapshot";
  summary: string;
  filePath: string | null;
  line: number | null;
  quote: string | null;
  artifactId: string | null;
};

export type ReviewFinding = {
  id: string;
  runId: string;
  title: string;
  severity: ReviewSeverity;
  body: string;
  confidence: number;
  evidence: ReviewEvidence[];
  filePath: string | null;
  line: number | null;
  anchorState: ReviewAnchorState;
  sourcePass: ReviewSourcePass;
  publicationState: ReviewPublicationState;
};

export type ReviewSeveritySummary = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type ReviewRun = {
  id: string;
  projectId: string;
  laneId: string;
  target: ReviewTarget;
  config: ReviewRunConfig;
  targetLabel: string;
  compareTarget: ReviewResolvedCompareTarget | null;
  status: ReviewRunStatus;
  summary: string | null;
  errorMessage: string | null;
  findingCount: number;
  severitySummary: ReviewSeveritySummary;
  chatSessionId: string | null;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
};

export type ReviewRunArtifact = {
  id: string;
  runId: string;
  artifactType: ReviewArtifactType;
  title: string;
  mimeType: string;
  contentText: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ReviewLaunchLane = {
  id: string;
  name: string;
  laneType: string;
  branchRef: string;
  baseRef: string;
  color: string | null;
};

export type ReviewLaunchCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authoredAt: string;
  pushed: boolean;
};

export type ReviewLaunchContext = {
  defaultLaneId: string | null;
  defaultBranchName: string | null;
  lanes: ReviewLaunchLane[];
  recentCommitsByLane: Record<string, ReviewLaunchCommit[]>;
  recommendedModelId: string | null;
};

export type ReviewRunDetail = ReviewRun & {
  findings: ReviewFinding[];
  artifacts: ReviewRunArtifact[];
  publications: ReviewPublication[];
  chatSession: AgentChatSessionSummary | null;
};

export type ReviewListRunsArgs = {
  laneId?: string | null;
  limit?: number;
  status?: ReviewRunStatus | "all";
};

export type ReviewStartRunArgs = {
  target: ReviewTarget;
  config?: Partial<ReviewRunConfig> | null;
};

export type ReviewEventPayload =
  | {
      type: "runs-updated";
      runId?: string;
      laneId?: string;
      status?: ReviewRunStatus;
    }
  | {
      type: "run-started";
      runId: string;
      laneId: string;
    }
  | {
      type: "run-completed";
      runId: string;
      laneId: string;
      status: ReviewRunStatus;
    };
