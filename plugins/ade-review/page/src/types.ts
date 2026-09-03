/**
 * The Review shapes, copied down from the app's own.
 *
 * `apps/desktop/src/shared/types/review.ts` is the original and stays the
 * original: the daemon's `review.*` action domain builds these, the child
 * forwards them unchanged, and the page reads them. They are copied rather than
 * imported because a plugin page is built on its own — it cannot reach into the
 * app's source tree, and a `file:` dependency on the desktop package would pull
 * Electron into a guest bundle.
 *
 * Copied EXACTLY, field for field. A field that is thinner here than there is a
 * silent parity gap, so `PARITY.md` names the two that are deliberately
 * different: `PageReviewLaunchLane` gains `path` (the lane's worktree, which the
 * child reads from `sdk.lanes.list()` and the compiled page read from the app
 * store), and `PageReviewLaunchContext` gains `message` (the one sentence a
 * degraded read carries — see `host/actions.ts`).
 */

export type ReviewTargetMode = "lane_diff" | "commit_range" | "working_tree" | "pr";
export type ReviewRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewAnchorState = "anchored" | "file_only" | "missing";
export type ReviewPublicationState = "local_only" | "published";
export type ReviewSourcePass = "single_pass" | "adjudicated";
export type ReviewPassKey =
  | "diff-risk"
  | "cross-file-impact"
  | "checks-and-tests"
  | "security-data"
  | "ui-regression";
export type ReviewReviewerRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ReviewFindingClass = "intent_drift" | "incomplete_rollout" | "late_stage_regression";
export type ReviewSelectionMode = "full_diff" | "selected_commits" | "dirty_only";
export type ReviewPublishBehavior = "local_only" | "auto_publish";
export type ReviewPublicationStatus = "published" | "failed";
export type ReviewFeedbackKind = "acknowledge" | "dismiss" | "snooze" | "suppress";
export type ReviewSuppressionScope = "repo" | "path" | "global";

export type ReviewDismissReason =
  | "not_a_bug"
  | "out_of_scope"
  | "style_only"
  | "duplicate"
  | "wont_fix"
  | "low_value_noise"
  | "other";

export type ReviewFeedbackRecord = {
  id: string;
  findingId: string;
  runId: string;
  kind: ReviewFeedbackKind;
  reason: ReviewDismissReason | null;
  note: string | null;
  snoozeUntil: string | null;
  createdAt: string;
};

export type ReviewSuppression = {
  id: string;
  scope: ReviewSuppressionScope;
  repoKey: string | null;
  pathPattern: string | null;
  title: string;
  findingClass: ReviewFindingClass | null;
  severity: ReviewSeverity | null;
  reason: ReviewDismissReason | null;
  note: string | null;
  sourceFindingId: string | null;
  hitCount: number;
  createdAt: string;
  lastMatchedAt: string | null;
};

export type ReviewFindingSuppressionMatch = {
  suppressionId: string;
  similarity: number;
  reason: ReviewDismissReason | null;
  scope: ReviewSuppressionScope;
};

export type ReviewPublicationDestination = {
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
  | { kind: "default_branch" }
  | { kind: "lane"; laneId: string };

export type ReviewResolvedCompareTarget = {
  kind: "default_branch" | "lane";
  label: string;
  ref: string | null;
  laneId: string | null;
  branchRef: string | null;
};

export type ReviewRunConfig = {
  compareAgainst: ReviewCompareAgainstTarget;
  selectionMode: ReviewSelectionMode;
  dirtyOnly: boolean;
  modelId: string;
  reasoningEffort: string | null;
  fastMode?: boolean;
  /** @deprecated Use fastMode. Carried because old runs stored it. */
  codexFastMode?: boolean;
  publishBehavior: ReviewPublishBehavior;
};

export type ReviewTarget =
  | { mode: "lane_diff"; laneId: string }
  | { mode: "commit_range"; laneId: string; baseCommit: string; headCommit: string }
  | { mode: "working_tree"; laneId: string }
  | { mode: "pr"; laneId: string; prId: string };

export type ReviewEvidenceKind = "quote" | "diff_hunk" | "artifact" | "file_snapshot" | "tool_signal";

export type ReviewToolSignalKind =
  | "typecheck"
  | "test"
  | "lint"
  | "build"
  | "ci_check"
  | "validation";

export type ReviewEvidence = {
  kind: ReviewEvidenceKind;
  summary: string;
  filePath: string | null;
  line: number | null;
  quote: string | null;
  artifactId: string | null;
  toolSignal?: {
    kind: ReviewToolSignalKind;
    source: string;
    status: "pass" | "fail" | "warn" | "info";
    detail: string | null;
  } | null;
};

export type ReviewFindingAdjudication = {
  score: number;
  candidateCount: number;
  mergedFindingIds: string[];
  rationale: string;
  publicationEligible: boolean;
};

export type ReviewDiffContext = {
  filePath: string;
  startLine: number;
  endLine: number;
  anchoredLine: number | null;
  lines: Array<{
    line: number | null;
    kind: "context" | "add" | "del" | "meta";
    text: string;
    highlighted: boolean;
  }>;
};

export type ReviewFinding = {
  id: string;
  runId: string;
  title: string;
  severity: ReviewSeverity;
  findingClass?: ReviewFindingClass | null;
  body: string;
  confidence: number;
  evidence: ReviewEvidence[];
  filePath: string | null;
  line: number | null;
  anchorState: ReviewAnchorState;
  sourcePass: ReviewSourcePass;
  publicationState: ReviewPublicationState;
  originatingPasses?: ReviewPassKey[];
  adjudication?: ReviewFindingAdjudication | null;
  feedback?: ReviewFeedbackRecord | null;
  suppressionMatch?: ReviewFindingSuppressionMatch | null;
  diffContext?: ReviewDiffContext | null;
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

export type ReviewArtifactType =
  | "prompt"
  | "pass_prompt"
  | "pass_output"
  | "pass_findings"
  | "adjudication_result"
  | "merged_findings"
  | "changed_file_manifest"
  | "risk_map"
  | "provenance_brief"
  | "rule_overlays"
  | "validation_signals"
  | "tool_evidence"
  | "diff_bundle"
  | "review_output"
  | "untracked_snapshot"
  | "publication_request"
  | "publication_result";

export type ReviewArtifact = {
  id: string;
  runId: string;
  artifactType: ReviewArtifactType;
  title: string;
  mimeType: string;
  contentText: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ReviewReviewerRun = {
  id: string;
  runId: string;
  reviewerKey: ReviewPassKey;
  label: string;
  focus: string;
  status: ReviewReviewerRunStatus;
  chatSessionId: string | null;
  promptArtifactId: string | null;
  outputArtifactId: string | null;
  findingsArtifactId: string | null;
  candidateCount: number;
  keptCount: number;
  summary: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReviewCandidateFinding = {
  id: string;
  runId: string;
  reviewerRunId: string;
  reviewerKey: ReviewPassKey;
  title: string;
  severity: ReviewSeverity;
  findingClass: ReviewFindingClass | null;
  body: string;
  confidence: number;
  evidence: ReviewEvidence[];
  filePath: string | null;
  line: number | null;
  anchorState: ReviewAnchorState;
  evidenceScore: number;
  lowSignal: boolean;
  score: number;
  createdAt: string;
};

/**
 * The chat session a run's transcript lives in.
 *
 * Thinner than the app's `AgentChatSessionSummary` on purpose: the page draws
 * one button from it, so it takes the two fields that button needs and nothing
 * about the transcript's contents.
 */
export type ReviewChatSessionRef = {
  sessionId: string;
  laneId: string | null;
};

export type ReviewRunDetail = ReviewRun & {
  findings: ReviewFinding[];
  artifacts: ReviewArtifact[];
  reviewerRuns: ReviewReviewerRun[];
  candidateFindings: ReviewCandidateFinding[];
  publications: ReviewPublication[];
  chatSession: ReviewChatSessionRef | null;
};

export type ReviewLaunchCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authoredAt: string;
  pushed: boolean;
};

/**
 * A lane the launch form may target.
 *
 * `path` is the addition over the app's `ReviewLaunchLane`: the compiled page
 * read the lane's worktree from the app store, which a guest has no access to,
 * so the child joins `sdk.lanes.list()` onto the launch context. It is the
 * `rootPath` half of `ui.openPathInEditor`, and `null` means the host has no
 * local checkout for the lane.
 */
export type PageReviewLaunchLane = {
  id: string;
  name: string;
  laneType: string;
  branchRef: string;
  baseRef: string;
  color: string | null;
  path: string | null;
};

export type PageReviewLaunchContext = {
  defaultLaneId: string | null;
  defaultBranchName: string | null;
  lanes: PageReviewLaunchLane[];
  recentCommitsByLane: Record<string, ReviewLaunchCommit[]>;
  recommendedModelId: string | null;
  /**
   * Why this context is thinner than it should be, when it is.
   *
   * A launch-context read that failed degrades to an empty one carrying this
   * sentence rather than rejecting, because the form has somewhere honest to
   * print it — beside the lane field the reader is about to use. See the
   * header of `host/actions.ts`.
   */
  message?: string | null;
};

export type ReviewQualityReport = {
  projectId: string;
  totalRuns: number;
  totalFindings: number;
  addressedCount: number;
  dismissedCount: number;
  snoozedCount: number;
  suppressedCount: number;
  publishedCount: number;
  noiseRate: number;
  recentFeedback: ReviewFeedbackRecord[];
  byClass: Array<{
    findingClass: ReviewFindingClass | "uncategorized";
    total: number;
    addressed: number;
  }>;
};

/** The launch draft the form edits, and the shape `pageStartRun` reads. */
export type ReviewLaunchDraft = {
  laneId: string;
  targetMode: ReviewTargetMode;
  compareKind: "default_branch" | "lane";
  compareLaneId: string;
  baseCommit: string;
  headCommit: string;
  prId: string;
  modelId: string;
  provider: string | null;
  reasoningEffort: string;
  fastMode: boolean;
  publishBehavior: ReviewPublishBehavior;
};
