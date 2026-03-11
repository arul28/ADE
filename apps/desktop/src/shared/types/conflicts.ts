// ---------------------------------------------------------------------------
// Conflict types
// ---------------------------------------------------------------------------

import type { GitConflictState } from "./git";
import type { RebaseNeed } from "./prs";

export type ConflictStatusValue =
  | "merge-ready"
  | "behind-base"
  | "conflict-predicted"
  | "conflict-active"
  | "unknown";

export type ConflictRiskLevel = "none" | "low" | "medium" | "high";

export type ConflictFileType = "content" | "rename" | "delete" | "add";

export type ConflictStatus = {
  laneId: string;
  status: ConflictStatusValue;
  overlappingFileCount: number;
  peerConflictCount: number;
  lastPredictedAt: string | null;
};

export type ConflictOverlap = {
  peerId: string | null;
  peerName: string;
  files: Array<{
    path: string;
    conflictType: ConflictFileType;
  }>;
  riskLevel: ConflictRiskLevel;
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

export type MergeSimulationArgs = {
  laneAId: string;
  laneBId?: string;
};

export type MergeSimulationResult = {
  outcome: "clean" | "conflict" | "error";
  mergedFiles: string[];
  conflictingFiles: Array<{
    path: string;
    conflictMarkers: string;
  }>;
  diffStat: {
    insertions: number;
    deletions: number;
    filesChanged: number;
  };
  error?: string;
};

export type ConflictPrediction = {
  id: string;
  laneAId: string;
  laneBId: string | null;
  status: "clean" | "conflict" | "unknown";
  conflictingFiles: Array<{ path: string; conflictType: string }>;
  overlapFiles: string[];
  laneASha: string;
  laneBSha: string | null;
  predictedAt: string;
};

export type BatchAssessmentResult = {
  lanes: ConflictStatus[];
  matrix: RiskMatrixEntry[];
  overlaps: BatchOverlapEntry[];
  computedAt: string;
  progress?: {
    completedPairs: number;
    totalPairs: number;
  };
  truncated?: boolean;
  // Deprecated: previous hard-stop lane cap. Kept for backwards compatibility.
  maxAutoLanes?: number;
  totalLanes?: number;
  comparedLaneIds?: string[];
  strategy?: string;
  pairwisePairsComputed?: number;
  pairwisePairsTotal?: number;
};

export type GetLaneConflictStatusArgs = { laneId: string };
export type ListOverlapsArgs = { laneId: string };
export type RunConflictPredictionArgs = { laneId?: string; laneIds?: string[] };

export type ConflictChipKind = "new-overlap" | "high-risk";

export type ConflictChip = {
  laneId: string;
  peerId: string | null;
  kind: ConflictChipKind;
  overlapCount: number;
};

export type ConflictEventPayload =
  | {
      type: "prediction-progress";
      computedAt: string;
      laneIds: string[];
      completedPairs: number;
      totalPairs: number;
      pair?: { laneAId: string; laneBId: string };
    }
  | {
      type: "prediction-complete";
      computedAt: string;
      laneIds: string[];
      chips: ConflictChip[];
      completedPairs: number;
      totalPairs: number;
    }
  | { type: "rebase-started"; laneId: string; timestamp: string }
  | { type: "rebase-completed"; laneId: string; success: boolean; timestamp: string }
  | { type: "rebase-needs-updated"; needs: RebaseNeed[]; timestamp: string };

export type ConflictProposalSource = "subscription" | "local";
export type ConflictProposalStatus = "pending" | "applied" | "rejected";

export type ConflictProposal = {
  id: string;
  laneId: string;
  peerLaneId: string | null;
  predictionId: string | null;
  source: ConflictProposalSource;
  confidence: number | null;
  explanation: string;
  diffPatch: string;
  status: ConflictProposalStatus;
  jobId: string | null;
  artifactId: string | null;
  appliedOperationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConflictProposalProvider = "subscription";

export type ExternalConflictResolverProvider = "codex" | "claude";

export type ConflictResolverOriginSurface = "mission" | "integration" | "rebase" | "queue" | "graph" | "manual";

export type ConflictResolverPermissionMode = "read_only" | "guarded_edit" | "full_edit";

export type ConflictResolverPostActionState = {
  autoCommit: boolean;
  autoPush: boolean;
  commitMessage: string | null;
  committedAt: string | null;
  commitSha: string | null;
  pushAt: string | null;
  pushSucceeded: boolean | null;
  error: string | null;
};

export type ConflictExternalResolverRunStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "canceled";

export type ConflictExternalResolverContextGap = {
  code: string;
  message: string;
};

export type ConflictExternalResolverRunSummary = {
  runId: string;
  provider: ExternalConflictResolverProvider;
  status: ConflictExternalResolverRunStatus;
  startedAt: string;
  completedAt: string | null;
  targetLaneId: string;
  sourceLaneIds: string[];
  cwdLaneId: string;
  integrationLaneId: string | null;
  summary: string | null;
  patchPath: string | null;
  logPath: string | null;
  changedFiles: string[];
  insufficientContext: boolean;
  contextGaps: ConflictExternalResolverContextGap[];
  warnings: string[];
  scenario: ResolverSessionScenario;
  model: string | null;
  reasoningEffort: string | null;
  permissionMode: ConflictResolverPermissionMode | null;
  command: string[];
  originSurface: ConflictResolverOriginSurface;
  originMissionId: string | null;
  originRunId: string | null;
  originLabel: string | null;
  ptyId: string | null;
  sessionId: string | null;
  committedAt?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  postActions?: ConflictResolverPostActionState | null;
  error: string | null;
};

export type RunExternalConflictResolverArgs = {
  provider: ExternalConflictResolverProvider;
  targetLaneId: string;
  sourceLaneIds: string[];
  cwdLaneId?: string;
  integrationLaneName?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: ConflictResolverPermissionMode | null;
  originSurface?: ConflictResolverOriginSurface;
  originMissionId?: string | null;
  originRunId?: string | null;
  originLabel?: string | null;
};

export type ListExternalConflictResolverRunsArgs = {
  laneId?: string;
  limit?: number;
};

export type CommitExternalConflictResolverRunArgs = {
  runId: string;
  message?: string;
};

export type CommitExternalConflictResolverRunResult = {
  runId: string;
  laneId: string;
  commitSha: string;
  message: string;
  committedPaths: string[];
};

export type ConflictProposalPreviewFile = {
  path: string;
  includeReason: "conflicted" | "overlap";
  markerPreview: string | null;
  laneDiff: string;
  peerDiff: string | null;
};

export type ConflictProposalPreviewStats = {
  approxChars: number;
  laneExportChars: number;
  peerLaneExportChars: number;
  conflictExportChars: number;
  fileCount: number;
};

export type ConflictProposalPreview = {
  laneId: string;
  peerLaneId: string | null;
  provider: ConflictProposalProvider;
  preparedAt: string;
  contextDigest: string;
  activeConflict: GitConflictState;
  laneExportLite: string | null;
  peerLaneExportLite: string | null;
  conflictExportStandard: string | null;
  files: ConflictProposalPreviewFile[];
  stats: ConflictProposalPreviewStats;
  warnings: string[];
  existingProposalId: string | null;
};

// -----------------------------
// Conflict Job Context
// -----------------------------

export type ConflictRelevantFileV1 = {
  path: string;
  includeReason: "conflicted" | "overlap" | "touched" | "predicted";
  selectedBecause: string;
};

export type ConflictFileHunkV1 = {
  kind: "base_left" | "base_right";
  header: string;
  baseStart: number;
  baseCount: number;
  otherStart: number;
  otherCount: number;
};

export type ConflictFileContextSideV1 = {
  side: "base" | "left" | "right";
  ref: string | null;
  blobSha: string | null;
  excerpt: string;
  excerptFormat: "diff_hunks" | "marker_preview" | "unavailable";
  truncated: boolean;
  omittedReasonTags?: string[] | null;
};

export type ConflictFileContextV1 = {
  path: string;
  selectedBecause: string;
  hunks: ConflictFileHunkV1[];
  base: ConflictFileContextSideV1 | null;
  left: ConflictFileContextSideV1 | null;
  right: ConflictFileContextSideV1 | null;
  markerPreview: string | null;
  omittedReasonTags?: string[] | null;
};

export type ConflictJobContextV1 = {
  schema: "ade.conflictJobContext.v1";
  relevantFilesForConflict?: ConflictRelevantFileV1[] | null;
  fileContexts?: ConflictFileContextV1[] | null;
  stalePolicy?: { ttlMs: number } | null;
  predictionAgeMs?: number | null;
  predictionStalenessMs?: number | null;
  pairwisePairsComputed?: number | null;
  pairwisePairsTotal?: number | null;
  insufficientContext?: boolean | null;
  insufficientReasons?: string[] | null;
};

export type PrepareConflictProposalArgs = {
  laneId: string;
  peerLaneId?: string | null;
};

export type RequestConflictProposalArgs = PrepareConflictProposalArgs & {
  contextDigest: string;
};

export type ApplyConflictProposalArgs = {
  laneId: string;
  proposalId: string;
  applyMode?: "unstaged" | "staged" | "commit";
  commitMessage?: string;
};

export type UndoConflictProposalArgs = {
  laneId: string;
  proposalId: string;
};

// --------------------------------
// Conflicts Tab Redesign (Phase 8+)
// --------------------------------

export type ResolverSessionScenario = "single-merge" | "sequential-merge" | "integration-merge";

export type PrepareResolverSessionArgs = {
  provider: ExternalConflictResolverProvider;
  targetLaneId: string;
  sourceLaneIds: string[];
  cwdLaneId?: string;
  integrationLaneName?: string;
  proposalId?: string | null;
  scenario?: ResolverSessionScenario;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: ConflictResolverPermissionMode | null;
  originSurface?: ConflictResolverOriginSurface;
  originMissionId?: string | null;
  originRunId?: string | null;
  originLabel?: string | null;
};

export type PrepareResolverSessionResult = {
  runId: string;
  promptFilePath: string;
  cwdWorktreePath: string;
  cwdLaneId: string;
  integrationLaneId: string | null;
  warnings: string[];
  contextGaps: ConflictExternalResolverContextGap[];
  status: "ready" | "blocked";
};

export type FinalizeResolverSessionArgs = {
  runId: string;
  exitCode: number;
  postActions?: Partial<ConflictResolverPostActionState> | null;
};

export type AttachResolverSessionArgs = {
  runId: string;
  ptyId: string;
  sessionId: string;
  command?: string[];
};

export type CancelResolverSessionArgs = {
  runId: string;
  reason?: string | null;
};

export type SuggestResolverTargetArgs = {
  sourceLaneId: string;
  targetLaneId: string;
};

export type SuggestResolverTargetResult = {
  suggestion: "source" | "target";
  reason: string;
};

// --------------------------------
// Resolution Config Types
// --------------------------------

export type ResolutionMode = "automatic" | "manual";
export type ResolutionConfig = {
  mode: ResolutionMode;
  confidenceThreshold: number;
  postResolution: "stage-only" | "auto-commit" | "auto-commit-push";
  provider: "codex" | "claude";
};

// --------------------------------
// Conflicts Tab Multi-Merge State
// --------------------------------

export type MultiMergeMode = "queue" | "integration";

export type MultiMergeLaneEntry = {
  laneId: string;
  laneName: string;
  position: number;
  predictedConflict: boolean;
  overlapFileCount: number;
};

// --------------------------------
// Rebase Types
// --------------------------------

export type RebaseLaneArgs = {
  laneId: string;
  aiAssisted?: boolean;
  provider?: "codex" | "claude";
  autoApplyThreshold?: number;
};

export type RebaseResult = {
  laneId: string;
  success: boolean;
  conflictingFiles: string[];
  error?: string;
  resolvedByAi?: boolean;
  agentSessionId?: string;
};

export type RebaseEventPayload =
  | { type: "rebase-needs-updated"; needs: RebaseNeed[]; timestamp: string }
  | { type: "rebase-started"; laneId: string; timestamp: string }
  | { type: "rebase-completed"; laneId: string; success: boolean; timestamp: string };
