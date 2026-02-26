// ---------------------------------------------------------------------------
// Metadata type aliases
// ---------------------------------------------------------------------------
// Many domain objects carry a `metadata` bag typed as `Record<string, unknown>`.
// The shapes below document the most common patterns so consumers can narrow
// without casting to `any`. Existing callsites that write arbitrary keys remain
// compatible because each alias extends Record<string, unknown>.
// ---------------------------------------------------------------------------

/** Metadata stored on operation rows (git operations service). Known keys:
 *  path, count, amend, message, commitSha, stashRef, mode, branchName, etc. */
export type OperationMetadata = Record<string, unknown> & {
  error?: string;
};

/** Metadata stored on orchestrator run/step/attempt rows. Known keys:
 *  integrationStage, mergeMode, sourceLaneIds, targetLaneId, prId, etc. */
export type OrchestratorMetadata = Record<string, unknown>;

/** Metadata stored on mission step rows. Known keys:
 *  instructions, missionGoal, laneId, etc. */
export type MissionStepMetadata = Record<string, unknown>;

export type AppInfo = {
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
    v8: string;
  };
  env: {
    nodeEnv?: string;
    viteDevServerUrl?: string;
  };
};

export type ProjectInfo = {
  rootPath: string;
  displayName: string;
  baseRef: string;
};

export type ClearLocalAdeDataArgs = {
  packs?: boolean;
  logs?: boolean;
  transcripts?: boolean;
};

export type ClearLocalAdeDataResult = {
  deletedPaths: string[];
  clearedAt: string;
};

export type ExportConfigBundleResult =
  | { cancelled: true }
  | { cancelled: false; savedPath: string; bytesWritten: number; exportedAt: string };

export type RecentProjectSummary = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
  exists: boolean;
};

export type LaneType = "primary" | "worktree" | "attached";

export type ProviderMode = "guest" | "subscription";

export type LaneStatus = {
  dirty: boolean;
  ahead: number;
  behind: number;
  /** Commits the remote tracking branch is ahead of local (0 = in sync, -1 = no upstream) */
  remoteBehind: number;
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

export type LaneIcon = "star" | "flag" | "bolt" | "shield" | "tag" | null;

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

export type ConflictExternalResolverRunStatus = "running" | "completed" | "failed" | "blocked";

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
  insufficientContext: boolean;
  contextGaps: ConflictExternalResolverContextGap[];
  warnings: string[];
  committedAt?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  error: string | null;
};

export type RunExternalConflictResolverArgs = {
  provider: ExternalConflictResolverProvider;
  targetLaneId: string;
  sourceLaneIds: string[];
  integrationLaneName?: string;
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

export type GitHubRepoRef = {
  owner: string;
  name: string;
};

export type GitHubStatus = {
  tokenStored: boolean;
  repo: GitHubRepoRef | null;
  userLogin: string | null;
  scopes: string[];
  checkedAt: string | null;
};

export type PrState = "draft" | "open" | "merged" | "closed";
export type PrChecksStatus = "pending" | "passing" | "failing" | "none";
export type PrReviewStatus = "none" | "requested" | "approved" | "changes_requested";
export type MergeMethod = "merge" | "squash" | "rebase";
export type PrNotificationKind = "checks_failing" | "review_requested" | "changes_requested" | "merge_ready";

export type PrSummary = {
  id: string;
  laneId: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  githubUrl: string;
  githubNodeId: string | null;
  title: string;
  state: PrState;
  baseBranch: string;
  headBranch: string;
  checksStatus: PrChecksStatus;
  reviewStatus: PrReviewStatus;
  additions: number;
  deletions: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrStatus = {
  prId: string;
  state: PrState;
  checksStatus: PrChecksStatus;
  reviewStatus: PrReviewStatus;
  isMergeable: boolean;
  mergeConflicts: boolean;
  behindBaseBy: number;
};

export type PrCheck = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PrReview = {
  reviewer: string;
  state: "pending" | "approved" | "changes_requested" | "commented" | "dismissed";
  body: string | null;
  submittedAt: string | null;
};

export type PrComment = {
  id: string;
  author: string;
  body: string | null;
  source: "issue" | "review";
  url: string | null;
  path: string | null;
  line: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PrEventPayload =
  | {
      type: "prs-updated";
      polledAt: string;
      prs: PrSummary[];
    }
  | {
      type: "pr-notification";
      polledAt: string;
      kind: PrNotificationKind;
      laneId: string;
      prId: string;
      prNumber: number;
      title: string;
      githubUrl: string;
      message: string;
      state: PrState;
      checksStatus: PrChecksStatus;
      reviewStatus: PrReviewStatus;
    }
  | {
      type: "queue-step";
      groupId: string;
      prId: string;
      entryState: QueueEntryState;
      position: number;
      timestamp: string;
    }
  | {
      type: "queue-state";
      groupId: string;
      state: QueueState;
      currentPosition: number;
      timestamp: string;
    }
  | {
      type: "integration-step";
      groupId: string;
      laneId: string;
      outcome: IntegrationProposalStep["outcome"];
      position: number;
      timestamp: string;
    }
  | {
      type: "integration-state";
      groupId: string;
      flowState: IntegrationFlowState;
      timestamp: string;
    }
  | {
      type: "rebase-status";
      laneId: string;
      behindBy: number;
      conflictPredicted: boolean;
      timestamp: string;
    }
  | {
      type: "resolution-progress";
      laneId: string;
      provider: "codex" | "claude";
      confidence: number;
      filesResolved: number;
      filesTotal: number;
      timestamp: string;
    }
  | {
      type: "proposal-stale";
      proposalId: string;
      reason: string;
      timestamp: string;
    };

export type LandResult = {
  prId: string;
  prNumber: number;
  success: boolean;
  mergeCommitSha: string | null;
  branchDeleted: boolean;
  laneArchived: boolean;
  error: string | null;
};

export type CreatePrFromLaneArgs = {
  laneId: string;
  title: string;
  body: string;
  draft: boolean;
  baseBranch?: string;
  labels?: string[];
  reviewers?: string[];
};

export type LinkPrToLaneArgs = {
  laneId: string;
  prUrlOrNumber: string;
};

export type UpdatePrDescriptionArgs = {
  prId: string;
  body: string;
};

export type LandPrArgs = {
  prId: string;
  method: MergeMethod;
  archiveLane?: boolean;
};

export type DeletePrArgs = {
  prId: string;
  closeOnGitHub?: boolean;
  archiveLane?: boolean;
};

export type DeletePrResult = {
  prId: string;
  laneId: string;
  removedLocal: boolean;
  githubClosed: boolean;
  githubCloseError: string | null;
  laneArchived: boolean;
  laneArchiveError: string | null;
};

export type LandStackArgs = {
  rootLaneId: string;
  method: MergeMethod;
};

export type ContextDocStatus = {
  id: "prd_ade" | "architecture_ade";
  label: string;
  preferredPath: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  fingerprint: string | null;
  staleReason: string | null;
  fallbackCount: number;
};

export type ContextDocGenerationWarning = {
  code: string;
  message: string;
  actionLabel?: string;
  actionPath?: string;
};

export type ContextStatus = {
  docs: ContextDocStatus[];
  canonicalDocsPresent: number;
  canonicalDocsScanned: number;
  canonicalDocsFingerprint: string;
  canonicalDocsUpdatedAt: string | null;
  projectExportFingerprint: string | null;
  projectExportUpdatedAt: string | null;
  contextManifestRefs: {
    project: string | null;
    packs: string | null;
    transcripts: string | null;
  };
  fallbackWrites: number;
  insufficientContextCount: number;
  warnings: ContextDocGenerationWarning[];
};

export type ContextInventoryPackEntry = {
  packKey: string;
  packType: PackType;
  laneId: string | null;
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt: string | null;
  lastHeadSha: string | null;
  versionId: string | null;
  versionNumber: number | null;
  contentHash: string | null;
};

export type ContextInventoryCheckpointEntry = {
  id: string;
  laneId: string;
  sessionId: string | null;
  createdAt: string;
  sha: string;
};

export type ContextInventorySessionDeltaEntry = {
  sessionId: string;
  laneId: string;
  startedAt: string;
  endedAt: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  computedAt: string | null;
};

export type ContextInventoryOrchestratorSummary = {
  activeRuns: number;
  runningSteps: number;
  runningAttempts: number;
  activeClaims: number;
  expiredClaims: number;
  snapshots: number;
  handoffs: number;
  timelineEvents: number;
  recentRunIds: string[];
  recentAttemptIds: string[];
};

export type ContextInventorySnapshot = {
  generatedAt: string;
  packs: {
    total: number;
    byType: Partial<Record<PackType, number>>;
    recent: ContextInventoryPackEntry[];
  };
  checkpoints: {
    total: number;
    recent: ContextInventoryCheckpointEntry[];
  };
  sessionTracking: {
    trackedSessions: number;
    untrackedSessions: number;
    runningSessions: number;
    recentDeltas: ContextInventorySessionDeltaEntry[];
  };
  missions: {
    total: number;
    byStatus: Partial<Record<MissionStatus, number>>;
    openInterventions: number;
    recentHandoffs: MissionStepHandoff[];
  };
  orchestrator: ContextInventoryOrchestratorSummary;
};

export type ContextDocProvider = "codex" | "claude";

export type ContextGenerateDocsArgs = {
  provider: ContextDocProvider;
  force?: boolean;
};

export type ContextPrepareDocGenArgs = {
  provider: ContextDocProvider;
  laneId: string;
};

export type ContextPrepareDocGenResult = {
  promptFilePath: string;
  outputPrdPath: string;
  outputArchPath: string;
  cwd: string;
  provider: ContextDocProvider;
};

export type ContextInstallGeneratedDocsArgs = {
  provider: ContextDocProvider;
  outputPrdPath: string;
  outputArchPath: string;
};

export type ContextGenerateDocsResult = {
  provider: ContextDocProvider;
  generatedAt: string;
  prdPath: string;
  architecturePath: string;
  usedFallbackPath: boolean;
  warnings: ContextDocGenerationWarning[];
  outputPreview: string;
};

export type ContextOpenDocArgs = {
  docId?: ContextDocStatus["id"];
  path?: string;
};

export type AgentChatProvider = "codex" | "claude";

export type AgentChatSessionStatus = "active" | "idle" | "ended";

export type AgentChatApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";

export type AgentChatFileRef = {
  path: string;
  type: "file" | "image";
};

export type AgentChatPlanStep = {
  text: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export type AgentChatEvent =
  | {
      type: "user_message";
      text: string;
      attachments?: AgentChatFileRef[];
      turnId?: string;
    }
  | {
      type: "text";
      text: string;
      turnId?: string;
      itemId?: string;
    }
  | {
      type: "tool_call";
      tool: string;
      args: unknown;
      itemId: string;
      turnId?: string;
    }
  | {
      type: "tool_result";
      tool: string;
      result: unknown;
      itemId: string;
      turnId?: string;
      status?: "running" | "completed" | "failed";
    }
  | {
      type: "file_change";
      path: string;
      diff: string;
      kind: "create" | "modify" | "delete";
      itemId: string;
      turnId?: string;
      status?: "running" | "completed" | "failed";
    }
  | {
      type: "command";
      command: string;
      cwd: string;
      output: string;
      itemId: string;
      turnId?: string;
      exitCode?: number | null;
      durationMs?: number | null;
      status: "running" | "completed" | "failed";
    }
  | {
      type: "plan";
      steps: AgentChatPlanStep[];
      turnId?: string;
      explanation?: string | null;
    }
  | {
      type: "reasoning";
      text: string;
      turnId?: string;
      itemId?: string;
      summaryIndex?: number;
    }
  | {
      type: "approval_request";
      itemId: string;
      kind: "command" | "file_change" | "tool_call";
      description: string;
      turnId?: string;
      detail?: unknown;
    }
  | {
      type: "status";
      turnStatus: "started" | "completed" | "interrupted" | "failed";
      turnId?: string;
      message?: string;
    }
  | {
      type: "error";
      message: string;
      turnId?: string;
      itemId?: string;
      errorInfo?: string;
    }
  | {
      type: "done";
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
      };
    }
  | {
      type: "activity";
      activity: "thinking" | "editing_file" | "running_command" | "searching" | "reading" | "tool_calling";
      detail?: string;
      turnId?: string;
    };

export type AgentChatEventEnvelope = {
  sessionId: string;
  timestamp: string;
  event: AgentChatEvent;
};

export type AgentChatSession = {
  id: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  reasoningEffort?: string | null;
  status: AgentChatSessionStatus;
  threadId?: string;
  createdAt: string;
  lastActivityAt: string;
};

export type AgentChatSessionSummary = {
  sessionId: string;
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  reasoningEffort?: string | null;
  status: AgentChatSessionStatus;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  lastOutputPreview: string | null;
  summary: string | null;
  threadId?: string;
};

export type AgentChatModelInfo = {
  id: string;
  displayName: string;
  description?: string | null;
  isDefault: boolean;
  reasoningEfforts?: Array<{ effort: string; description: string }>;
  maxThinkingTokens?: number | null;
};

export type AgentChatCreateArgs = {
  laneId: string;
  provider: AgentChatProvider;
  model: string;
  reasoningEffort?: string | null;
};

export type AgentChatListArgs = {
  laneId?: string;
};

export type AgentChatSendArgs = {
  sessionId: string;
  text: string;
  attachments?: AgentChatFileRef[];
  reasoningEffort?: string | null;
};

export type AgentChatSteerArgs = {
  sessionId: string;
  text: string;
};

export type AgentChatInterruptArgs = {
  sessionId: string;
};

export type AgentChatResumeArgs = {
  sessionId: string;
};

export type AgentChatApproveArgs = {
  sessionId: string;
  itemId: string;
  decision: AgentChatApprovalDecision;
};

export type AgentChatModelsArgs = {
  provider: AgentChatProvider;
};

export type AgentChatDisposeArgs = {
  sessionId: string;
};

export type ContextPackScope = "project" | "lane" | "conflict" | "plan" | "mission" | "feature";

export type ContextPackOption = {
  scope: ContextPackScope;
  label: string;
  description: string;
  available: boolean;
  laneId?: string;
  featureKey?: string;
  missionId?: string;
};

export type ContextPackFetchArgs = {
  scope: ContextPackScope;
  laneId?: string;
  featureKey?: string;
  missionId?: string;
  level?: "brief" | "standard" | "detailed";
};

export type ContextPackFetchResult = {
  scope: ContextPackScope;
  content: string;
  truncated: boolean;
};

export type ContextPackListArgs = {
  laneId?: string;
};

export type TerminalSessionStatus = "running" | "completed" | "failed" | "disposed";

export type TerminalToolType =
  | "shell"
  | "claude"
  | "codex"
  | "claude-orchestrated"
  | "codex-orchestrated"
  | "codex-chat"
  | "claude-chat"
  | "cursor"
  | "aider"
  | "continue"
  | "other";

export type TerminalRuntimeState = "running" | "waiting-input" | "idle" | "exited" | "killed";

export type TerminalSessionSummary = {
  id: string;
  laneId: string;
  laneName: string;
  ptyId: string | null;
  tracked: boolean;
  pinned: boolean;
  goal: string | null;
  toolType: TerminalToolType | null;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
  summary: string | null;
  runtimeState: TerminalRuntimeState;
  resumeCommand: string | null;
};

export type TerminalSessionDetail = TerminalSessionSummary & {
  // Reserved for future expansion (goal/tool templates, derived deltas, etc.)
};

export type PtyCreateArgs = {
  laneId: string;
  cwd?: string;
  cols: number;
  rows: number;
  title: string;
  tracked?: boolean;
  toolType?: TerminalToolType | null;
  startupCommand?: string;
};

export type PtyCreateResult = {
  ptyId: string;
  sessionId: string;
};

export type PtyDataEvent = {
  ptyId: string;
  sessionId: string;
  data: string;
};

export type PtyExitEvent = {
  ptyId: string;
  sessionId: string;
  exitCode: number | null;
};

export type ListSessionsArgs = {
  laneId?: string;
  status?: TerminalSessionStatus;
  limit?: number;
};

export type UpdateSessionMetaArgs = {
  sessionId: string;
  pinned?: boolean;
  goal?: string | null;
  toolType?: TerminalToolType | null;
  resumeCommand?: string | null;
};

export type TranscriptSearchMatch = {
  lineNumber: number;
  line: string;
};

export type SearchTranscriptArgs = {
  sessionId: string;
  query: string;
  limit?: number;
};

export type SearchTranscriptResult = {
  sessionId: string;
  query: string;
  matches: TranscriptSearchMatch[];
  totalMatches: number;
  truncated: boolean;
};

export type ReadTranscriptTailArgs = {
  sessionId: string;
  maxBytes?: number;
  raw?: boolean;
};

export type ListLanesArgs = {
  includeArchived?: boolean;
};

export type CreateLaneArgs = {
  name: string;
  description?: string;
  parentLaneId?: string;
};

export type CreateChildLaneArgs = {
  parentLaneId: string;
  name: string;
  description?: string;
  folder?: string;
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

export type RestackArgs = {
  laneId: string;
  recursive?: boolean;
  reason?: string;
};

export type RestackResult = {
  restackedLanes: string[];
  failedLaneId: string | null;
  error: string | null;
};

export type RestackSuggestion = {
  laneId: string;
  parentLaneId: string;
  parentHeadSha: string;
  behindCount: number;
  lastSuggestedAt: string;
  deferredUntil: string | null;
  dismissedAt: string | null;
  hasPr: boolean;
};

export type RestackSuggestionsEventPayload = {
  type: "restack-suggestions-updated";
  computedAt: string;
  suggestions: RestackSuggestion[];
};

export type AutoRebaseLaneState = "autoRebased" | "rebasePending" | "rebaseConflict";

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

export type OpenLaneFolderArgs = {
  laneId: string;
};

export type ProjectOpenRepoResult = ProjectInfo;

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

export type FilesWorkspaceKind = "primary" | "worktree" | "attached";

export type FilesWorkspace = {
  id: string;
  kind: FilesWorkspaceKind;
  laneId: string | null;
  name: string;
  rootPath: string;
  isReadOnlyByDefault: boolean;
};

export type FilesListWorkspacesArgs = {
  includeArchived?: boolean;
};

export type FileTreeChangeStatus = "M" | "A" | "D" | null;

export type FileTreeNode = {
  name: string;
  path: string; // relative to workspace root
  type: "file" | "directory";
  hasChildren?: boolean;
  children?: FileTreeNode[];
  changeStatus?: FileTreeChangeStatus;
  size?: number;
};

export type FilesListTreeArgs = {
  workspaceId: string;
  parentPath?: string;
  depth?: number;
  includeIgnored?: boolean;
};

export type FileContent = {
  content: string;
  encoding: string;
  size: number;
  languageId: string;
  isBinary: boolean;
};

export type FilesReadFileArgs = {
  workspaceId: string;
  path: string; // relative to workspace root
};

export type FilesWriteTextArgs = {
  workspaceId: string;
  path: string; // relative to workspace root
  text: string;
};

export type FilesCreateFileArgs = {
  workspaceId: string;
  path: string; // relative path
  content?: string;
};

export type FilesCreateDirectoryArgs = {
  workspaceId: string;
  path: string; // relative path
};

export type FilesRenameArgs = {
  workspaceId: string;
  oldPath: string;
  newPath: string;
};

export type FilesDeleteArgs = {
  workspaceId: string;
  path: string;
};

export type FilesWatchArgs = {
  workspaceId: string;
};

export type FileChangeEvent = {
  workspaceId: string;
  type: "created" | "modified" | "deleted" | "renamed";
  path: string;
  oldPath?: string;
  ts: string;
};

export type FilesQuickOpenArgs = {
  workspaceId: string;
  query: string;
  limit?: number;
};

export type FilesQuickOpenItem = {
  path: string;
  score: number;
};

export type FilesSearchTextArgs = {
  workspaceId: string;
  query: string;
  limit?: number;
};

export type FilesSearchTextMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

// react-resizable-panels uses a map of panel id -> percentage (0..100)
export type DockLayout = Record<string, number>;

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

export type GraphLayoutPreset = {
  name: string;
  byViewMode: Record<GraphViewMode, GraphLayoutSnapshot>;
  updatedAt: string;
};

export type GraphPersistedState = {
  presets: GraphLayoutPreset[];
  activePreset: string;
};

// Backward compatible with earlier configs that used `on_crash`.
export type ProcessRestartPolicy = "never" | "on-failure" | "always" | "on_crash";
export type StackStartOrder = "parallel" | "dependency";
export type ProcessReadinessType = "none" | "port" | "logRegex";
export type ProcessRuntimeStatus = "stopped" | "starting" | "running" | "degraded" | "stopping" | "exited" | "crashed";
export type ProcessReadinessState = "unknown" | "ready" | "not_ready";
export type StackAggregateStatus = "running" | "partial" | "stopped" | "error";
export type TestRunStatus = "running" | "passed" | "failed" | "canceled" | "timed_out";
export type TestSuiteTag = "unit" | "lint" | "integration" | "e2e" | "custom";

export type ProcessReadinessConfig =
  | { type: "none" }
  | { type: "port"; port: number }
  | { type: "logRegex"; pattern: string };

export type ConfigProcessReadiness =
  | { type?: "none" }
  | { type: "port"; port?: number }
  | { type: "logRegex"; pattern?: string };

export type ProcessDefinition = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  autostart: boolean;
  restart: ProcessRestartPolicy;
  gracefulShutdownMs: number;
  dependsOn: string[];
  readiness: ProcessReadinessConfig;
};

export type StackButtonDefinition = {
  id: string;
  name: string;
  processIds: string[];
  startOrder: StackStartOrder;
};

export type TestSuiteDefinition = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number | null;
  tags: TestSuiteTag[];
};

export type ConfigProcessDefinition = {
  id: string;
  name?: string;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  autostart?: boolean;
  restart?: ProcessRestartPolicy;
  gracefulShutdownMs?: number;
  dependsOn?: string[];
  readiness?: ConfigProcessReadiness;
};

export type ConfigStackButtonDefinition = {
  id: string;
  name?: string;
  processIds?: string[];
  startOrder?: StackStartOrder;
};

export type ConfigTestSuiteDefinition = {
  id: string;
  name?: string;
  command?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  tags?: TestSuiteTag[];
};

export type LaneOverlayMatch = {
  laneIds?: string[];
  laneTypes?: LaneType[];
  namePattern?: string;
  branchPattern?: string;
  tags?: string[];
};

export type LaneOverlayOverrides = {
  env?: Record<string, string>;
  cwd?: string;
  processIds?: string[];
  testSuiteIds?: string[];
};

export type LaneOverlayPolicy = {
  id: string;
  name: string;
  enabled: boolean;
  match: LaneOverlayMatch;
  overrides: LaneOverlayOverrides;
};

export type ConfigLaneOverlayPolicy = {
  id: string;
  name?: string;
  enabled?: boolean;
  match?: LaneOverlayMatch;
  overrides?: LaneOverlayOverrides;
};

export type AutomationTriggerType = "session-end" | "commit" | "schedule" | "manual";
export type AutomationActionType =
  | "update-packs"
  | "predict-conflicts"
  | "run-tests"
  | "run-command";

export type AutomationTrigger = {
  type: AutomationTriggerType;
  cron?: string;
  branch?: string;
};

export type AutomationAction = {
  type: AutomationActionType;
  suiteId?: string;
  command?: string;
  cwd?: string;
  condition?: string;
  continueOnFailure?: boolean;
  timeoutMs?: number;
  retry?: number;
};

export type AutomationRule = {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  enabled: boolean;
};

export type ConfigAutomationRule = {
  id: string;
  name?: string;
  trigger?: AutomationTrigger;
  actions?: AutomationAction[];
  enabled?: boolean;
};

export type EnvironmentMapping = {
  // Branch pattern (supports simple glob "*" matching, e.g. "release/*").
  branch: string;
  // Environment label, e.g. "production", "staging".
  env: string;
  // Optional hex color used for graph badges/borders.
  color?: string;
};

export type AiTaskRoutingKey =
  | "planning"
  | "implementation"
  | "review"
  | "conflict_resolution"
  | "narrative"
  | "pr_description"
  | "terminal_summary"
  | "mission_planning"
  | "initial_context";

export type AiTaskProvider = "auto" | "claude" | "codex";

// TODO(config-naming): AiTaskRoutingRule and all AI config types below accept both camelCase
// and snake_case variants for backwards compatibility with YAML/JSON config files authored in
// either convention. New fields MUST use camelCase only. Once a migration pass normalizes
// persisted configs to camelCase, remove the snake_case aliases and update the config loader.
export type AiTaskRoutingRule = {
  provider?: AiTaskProvider;
  model?: string;
  timeoutMs?: number;
  /** @deprecated Use timeoutMs */
  timeout_ms?: number;
  maxOutputTokens?: number;
  /** @deprecated Use maxOutputTokens */
  max_output_tokens?: number;
  temperature?: number;
};

export type AiFeatureKey =
  | "narratives"
  | "conflict_proposals"
  | "pr_descriptions"
  | "terminal_summaries"
  | "mission_planning"
  | "orchestrator"
  | "initial_context";

export type AiModelDescriptor = {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  default?: boolean;
};

export type AiFeatureUsageRow = {
  feature: AiFeatureKey;
  enabled: boolean;
  dailyUsage: number;
  dailyLimit: number | null;
};

export type AiSettingsStatus = {
  mode: "guest" | "subscription";
  availableProviders: {
    claude: boolean;
    codex: boolean;
  };
  models: {
    claude: AiModelDescriptor[];
    codex: AiModelDescriptor[];
  };
  features: AiFeatureUsageRow[];
};
export type AiFeatureToggles = Partial<Record<AiFeatureKey, boolean>>;

export type AiBudgetLimit = {
  dailyLimit?: number;
  /** @deprecated Use dailyLimit */
  daily_limit?: number;
};

export type AiBudgets = Partial<Record<AiFeatureKey, AiBudgetLimit>>;

export type AiClaudePermissionSettings = {
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** @deprecated Use permissionMode */
  permission_mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  settingsSources?: Array<"user" | "project" | "local">;
  /** @deprecated Use settingsSources */
  settings_sources?: Array<"user" | "project" | "local">;
  maxBudgetUsd?: number;
  /** @deprecated Use maxBudgetUsd */
  max_budget_usd?: number;
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  /** @deprecated Use dangerouslySkipPermissions */
  dangerously_skip_permissions?: boolean;
  allowedTools?: string[];
  /** @deprecated Use allowedTools */
  allowed_tools?: string[];
};

export type AiCodexPermissionSettings = {
  sandboxPermissions?: "read-only" | "workspace-write" | "danger-full-access";
  /** @deprecated Use sandboxPermissions */
  sandbox_permissions?: "read-only" | "workspace-write" | "danger-full-access";
  approvalMode?: "untrusted" | "on-request" | "on-failure" | "never" | "suggest" | "auto-edit" | "full-auto";
  /** @deprecated Use approvalMode */
  approval_mode?: "untrusted" | "on-request" | "on-failure" | "never" | "suggest" | "auto-edit" | "full-auto";
  writablePaths?: string[];
  /** @deprecated Use writablePaths */
  writable_paths?: string[];
  commandAllowlist?: string[];
  /** @deprecated Use commandAllowlist */
  command_allowlist?: string[];
  configPath?: string;
  /** @deprecated Use configPath */
  config_path?: string;
};

export type AiPermissionSettings = {
  claude?: AiClaudePermissionSettings;
  codex?: AiCodexPermissionSettings;
};

export type AiConflictResolutionConfig = {
  changeTarget?: "target" | "source" | "ai_decides";
  /** @deprecated Use changeTarget */
  change_target?: "target" | "source" | "ai_decides";
  postResolution?: "unstaged" | "staged" | "commit";
  /** @deprecated Use postResolution */
  post_resolution?: "unstaged" | "staged" | "commit";
  prBehavior?: "do_nothing" | "open_pr" | "add_to_existing";
  /** @deprecated Use prBehavior */
  pr_behavior?: "do_nothing" | "open_pr" | "add_to_existing";
  autonomy?: "propose_only" | "auto_apply";
  autoApplyThreshold?: number;
  /** @deprecated Use autoApplyThreshold */
  auto_apply_threshold?: number;
};

export type AiOrchestratorHookEvent = "TeammateIdle" | "TaskCompleted";

export type AiOrchestratorHookConfig = {
  command: string;
  timeoutMs?: number;
  /** @deprecated Use timeoutMs */
  timeout_ms?: number;
};

export type AiOrchestratorConfig = {
  teammatePlanMode?: "off" | "auto" | "required";
  /** @deprecated Use teammatePlanMode */
  teammate_plan_mode?: "off" | "auto" | "required";
  requirePlanReview?: boolean;
  /** @deprecated Use requirePlanReview */
  require_plan_review?: boolean;
  maxParallelWorkers?: number;
  /** @deprecated Use maxParallelWorkers */
  max_parallel_workers?: number;
  defaultMergePolicy?: "sequential" | "batch-at-end" | "per-step";
  /** @deprecated Use defaultMergePolicy */
  default_merge_policy?: "sequential" | "batch-at-end" | "per-step";
  defaultConflictHandoff?: "auto-resolve" | "ask-user" | "orchestrator-decides";
  /** @deprecated Use defaultConflictHandoff */
  default_conflict_handoff?: "auto-resolve" | "ask-user" | "orchestrator-decides";
  workerHeartbeatIntervalMs?: number;
  /** @deprecated Use workerHeartbeatIntervalMs */
  worker_heartbeat_interval_ms?: number;
  workerHeartbeatTimeoutMs?: number;
  /** @deprecated Use workerHeartbeatTimeoutMs */
  worker_heartbeat_timeout_ms?: number;
  workerIdleTimeoutMs?: number;
  /** @deprecated Use workerIdleTimeoutMs */
  worker_idle_timeout_ms?: number;
  stepTimeoutDefaultMs?: number;
  /** @deprecated Use stepTimeoutDefaultMs */
  step_timeout_default_ms?: number;
  maxRetriesPerStep?: number;
  /** @deprecated Use maxRetriesPerStep */
  max_retries_per_step?: number;
  contextPressureThreshold?: number;
  /** @deprecated Use contextPressureThreshold */
  context_pressure_threshold?: number;
  progressiveLoading?: boolean;
  /** @deprecated Use progressiveLoading */
  progressive_loading?: boolean;
  maxTotalTokenBudget?: number;
  /** @deprecated Use maxTotalTokenBudget */
  max_total_token_budget?: number;
  maxPerStepTokenBudget?: number;
  /** @deprecated Use maxPerStepTokenBudget */
  max_per_step_token_budget?: number;
  defaultExecutionPolicy?: Partial<MissionExecutionPolicy>;
  /** @deprecated Use defaultExecutionPolicy */
  default_execution_policy?: Partial<MissionExecutionPolicy>;
  defaultDepthTier?: MissionDepthTier;
  /** @deprecated Use defaultDepthTier */
  default_depth_tier?: MissionDepthTier;
  defaultPlannerProvider?: AiTaskProvider;
  /** @deprecated Use defaultPlannerProvider */
  default_planner_provider?: AiTaskProvider;
  autoResolveInterventions?: boolean;
  /** @deprecated Use autoResolveInterventions */
  auto_resolve_interventions?: boolean;
  interventionConfidenceThreshold?: number;
  /** @deprecated Use interventionConfidenceThreshold */
  intervention_confidence_threshold?: number;
  hooks?: Partial<Record<AiOrchestratorHookEvent, AiOrchestratorHookConfig>>;
};

export type AiChatConfig = {
  defaultProvider?: "codex" | "claude" | "last_used";
  /** @deprecated Use defaultProvider */
  default_provider?: "codex" | "claude" | "last_used";
  defaultApprovalPolicy?: "auto" | "approve_mutations" | "approve_all";
  /** @deprecated Use defaultApprovalPolicy */
  default_approval_policy?: "auto" | "approve_mutations" | "approve_all";
  sendOnEnter?: boolean;
  /** @deprecated Use sendOnEnter */
  send_on_enter?: boolean;
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** @deprecated Use codexSandbox */
  codex_sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  claudePermissionMode?: "plan" | "acceptEdits" | "bypassPermissions";
  /** @deprecated Use claudePermissionMode */
  claude_permission_mode?: "plan" | "acceptEdits" | "bypassPermissions";
  sessionBudgetUsd?: number;
  /** @deprecated Use sessionBudgetUsd */
  session_budget_usd?: number;
};
export type AiConfig = {
  mode?: ProviderMode;
  defaultProvider?: AiTaskProvider;
  /** @deprecated Use defaultProvider */
  default_provider?: AiTaskProvider;
  taskRouting?: Partial<Record<AiTaskRoutingKey, AiTaskRoutingRule>>;
  /** @deprecated Use taskRouting */
  task_routing?: Partial<Record<AiTaskRoutingKey, AiTaskRoutingRule>>;
  features?: AiFeatureToggles;
  budgets?: AiBudgets;
  permissions?: AiPermissionSettings;
  conflictResolution?: AiConflictResolutionConfig;
  /** @deprecated Use conflictResolution */
  conflict_resolution?: AiConflictResolutionConfig;
  orchestrator?: AiOrchestratorConfig;
  chat?: AiChatConfig;
};

export type ProjectConfigFile = {
  version?: number;
  processes?: ConfigProcessDefinition[];
  stackButtons?: ConfigStackButtonDefinition[];
  testSuites?: ConfigTestSuiteDefinition[];
  laneOverlayPolicies?: ConfigLaneOverlayPolicy[];
  automations?: ConfigAutomationRule[];
  environments?: EnvironmentMapping[];
  github?: {
    prPollingIntervalSeconds?: number;
  };
  git?: {
    autoRebaseOnHeadChange?: boolean;
  };
  ai?: AiConfig;
  providers?: Record<string, unknown>;
};

export type ProjectConfigCandidate = {
  shared: ProjectConfigFile;
  local: ProjectConfigFile;
};

export type EffectiveProjectConfig = {
  version: number;
  processes: ProcessDefinition[];
  stackButtons: StackButtonDefinition[];
  testSuites: TestSuiteDefinition[];
  laneOverlayPolicies: LaneOverlayPolicy[];
  automations: AutomationRule[];
  environments?: EnvironmentMapping[];
  github?: {
    prPollingIntervalSeconds?: number;
  };
  git: {
    autoRebaseOnHeadChange: boolean;
  };
  ai?: AiConfig;
  providerMode?: ProviderMode;
  providers?: Record<string, unknown>;
};

export type ProjectConfigValidationIssue = {
  path: string;
  message: string;
};

export type ProjectConfigValidationResult = {
  ok: boolean;
  issues: ProjectConfigValidationIssue[];
};

export type ProjectConfigTrust = {
  sharedHash: string;
  localHash: string;
  approvedSharedHash: string | null;
  requiresSharedTrust: boolean;
};

export type ProjectConfigSnapshot = {
  shared: ProjectConfigFile;
  local: ProjectConfigFile;
  effective: EffectiveProjectConfig;
  validation: ProjectConfigValidationResult;
  trust: ProjectConfigTrust;
  paths: {
    sharedPath: string;
    localPath: string;
  };
};

export type ProjectConfigDiff = {
  sharedChanged: boolean;
  localChanged: boolean;
  sharedHash: string;
  localHash: string;
  approvedSharedHash: string | null;
  requiresSharedTrust: boolean;
};

export type ProcessRuntime = {
  laneId: string;
  processId: string;
  status: ProcessRuntimeStatus;
  readiness: ProcessReadinessState;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  lastExitCode: number | null;
  lastEndedAt: string | null;
  uptimeMs: number | null;
  ports: number[];
  logPath: string | null;
  updatedAt: string;
};

export type ProcessListItem = {
  definition: ProcessDefinition;
  runtime: ProcessRuntime;
};

export type StackButtonStatus = StackButtonDefinition & {
  status: StackAggregateStatus;
};

export type ProcessLogEvent = {
  type: "log";
  laneId: string;
  processId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
};

export type ProcessRuntimeEvent = {
  type: "runtime";
  runtime: ProcessRuntime;
};

export type ProcessEvent = ProcessLogEvent | ProcessRuntimeEvent;

export type TestRunSummary = {
  id: string;
  suiteId: string;
  suiteName: string;
  laneId: string | null;
  status: TestRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
  logPath: string;
};

export type TestRunEvent = {
  type: "run";
  run: TestRunSummary;
};

export type TestLogEvent = {
  type: "log";
  runId: string;
  suiteId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
};

export type TestEvent = TestRunEvent | TestLogEvent;

export type ProcessActionArgs = {
  laneId: string;
  processId: string;
};

export type ProcessStackArgs = {
  laneId: string;
  stackId: string;
};

export type GetProcessLogTailArgs = {
  laneId: string;
  processId: string;
  maxBytes?: number;
};

export type RunTestSuiteArgs = {
  laneId: string;
  suiteId: string;
};

export type StopTestRunArgs = {
  runId: string;
};

export type ListTestRunsArgs = {
  laneId?: string;
  suiteId?: string;
  limit?: number;
};

export type GetTestLogTailArgs = {
  runId: string;
  maxBytes?: number;
};

export type ProjectConfigValidateArgs = {
  candidate: ProjectConfigCandidate;
};

export type ProjectConfigSaveArgs = {
  candidate: ProjectConfigCandidate;
};

export type ProjectConfigConfirmTrustArgs = {
  sharedHash?: string;
};

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

export type PackType = "project" | "lane" | "feature" | "conflict" | "plan" | "mission";

export type ContextExportLevel = "lite" | "standard" | "deep";

export type OrchestratorContextProfileId = "orchestrator_deterministic_v1" | "orchestrator_narrative_opt_in_v1";

export type OrchestratorContextDocsMode = "digest_refs" | "full_docs";

// Event metadata (standardized keys embedded into PackEvent.payload for selection/digests).
export type PackEventImportance = "low" | "medium" | "high";
export type PackEventCategory = "session" | "narrative" | "conflict" | "branch" | "pack";
export type PackEventEntityRef = { kind: string; id: string };

export type PackEventMetaV1 = {
  importance?: PackEventImportance;
  importanceScore?: number;
  category?: PackEventCategory;
  entityIds?: string[];
  entityRefs?: PackEventEntityRef[];
  actionType?: string;
  rationale?: string;
};

export type PackMergeReadiness = "ready" | "blocked" | "needs_sync" | "unknown";

export type PackDependencyStateV1 = {
  requiredMerges?: string[];
  blockedByLanes?: string[];
  mergeReadiness?: PackMergeReadiness;
};

export type PackConflictStateV1 = {
  status?: ConflictStatusValue;
  lastPredictedAt?: string | null;
  overlappingFileCount?: number;
  peerConflictCount?: number;
  unresolvedPairCount?: number;
  truncated?: boolean;
  strategy?: string;
  pairwisePairsComputed?: number;
  pairwisePairsTotal?: number;
  lastRecomputedAt?: string | null;
  predictionStale?: boolean | null;
  predictionAgeMs?: number | null;
  stalePolicy?: { ttlMs: number } | null;
  staleReason?: string | null;
  unresolvedResolutionState?: GitConflictState | null;
};

export type ContextHeaderV1 = {
  schema: "ade.context.v1";

  // Identity
  packKey: string;
  packType: PackType;
  exportLevel?: ContextExportLevel;

  // Contract diagnostics (optional; do not gate parsing on these).
  contractVersion?: number;
  projectId?: string | null;

  // Dependency graph + state (optional; consumers must be null-safe).
  graph?: import("./contextContract").PackGraphEnvelopeV1 | null;
  dependencyState?: PackDependencyStateV1 | null;
  conflictState?: PackConflictStateV1 | null;

  // Export-only omission hints for downstream consumers.
  omissions?: import("./contextContract").ExportOmissionV1[] | null;

  // Pack metadata (nullable for older packs / unknown state)
  laneId?: string | null;
  peerKey?: string | null;
  baseRef?: string | null;
  headSha?: string | null;

  deterministicUpdatedAt?: string | null;
  narrativeUpdatedAt?: string | null;

  versionId?: string | null;
  versionNumber?: number | null;
  contentHash?: string | null;

  providerMode?: ProviderMode;

  // Export-only metadata
  exportedAt?: string;
  approxTokens?: number;
  maxTokens?: number;

  // Gateway metadata (safe: never secrets)
  apiBaseUrl?: string | null;
  remoteProjectId?: string | null;
};

export type BranchStateSnapshotV1 = {
  baseRef: string | null;
  headRef: string | null;
  headSha: string | null;
  lastPackRefreshAt: string | null;
  isEditProtected: boolean | null;
  packStale: boolean | null;
  packStaleReason?: string | null;
};

export type LaneLineageV1 = {
  laneId: string;
  parentLaneId: string | null;
  baseLaneId: string | null;
  stackDepth: number;
};

export type LaneExportManifestV1 = {
  schema: "ade.manifest.lane.v1";
  projectId: string;
  laneId: string;
  laneName: string;
  laneType: LaneType;
  worktreePath: string;
  branchRef: string;
  baseRef: string;
  contextFingerprint?: string | null;
  contextVersion?: number | null;
  lastDocsRefreshAt?: string | null;
  docsStaleReason?: string | null;
  lineage: LaneLineageV1;
  mergeConstraints: {
    requiredMerges: string[];
    blockedByLanes: string[];
    mergeReadiness: PackMergeReadiness;
  };
  branchState: BranchStateSnapshotV1;
  conflicts: {
    activeConflictPackKeys: string[];
    unresolvedPairCount: number;
    lastConflictRefreshAt: string | null;
    lastConflictRefreshAgeMs: number | null;
    truncated?: boolean;
    strategy?: string;
    pairwisePairsComputed?: number;
    pairwisePairsTotal?: number;
    predictionStale?: boolean | null;
    predictionStalenessMs?: number | null;
    stalePolicy?: { ttlMs: number } | null;
    staleReason?: string | null;
    unresolvedResolutionState?: GitConflictState | null;
  };
  orchestratorSummary?: OrchestratorLaneSummaryV1 | null;
};

export type LaneCompletionSignal = "not-started" | "in-progress" | "review-ready" | "blocked";

export type OrchestratorLaneSummaryV1 = {
  laneId: string;
  completionSignal: LaneCompletionSignal;
  touchedFiles: string[];
  peerOverlaps: { peerId: string; files: string[]; risk: ConflictRiskLevel }[];
  suggestedMergeOrder: number | null;
  blockers: string[];
};

export type ProjectManifestLaneEntryV1 = {
  laneId: string;
  laneName: string;
  laneType: LaneType;
  branchRef: string;
  baseRef: string;
  worktreePath: string;
  isEditProtected: boolean;
  status: LaneStatus;
  lineage: LaneLineageV1;
  mergeConstraints: {
    requiredMerges: string[];
    blockedByLanes: string[];
    mergeReadiness: PackMergeReadiness;
  };
  branchState: BranchStateSnapshotV1;
  conflictState?: PackConflictStateV1 | null;
};

export type ProjectExportManifestV1 = {
  schema: "ade.manifest.project.v1";
  projectId: string;
  generatedAt: string;
  contextFingerprint?: string | null;
  contextVersion?: number | null;
  lastDocsRefreshAt?: string | null;
  docsStaleReason?: string | null;
  lanesTotal: number;
  lanesIncluded: number;
  lanesOmitted: number;
  lanes: ProjectManifestLaneEntryV1[];
  laneGraph?: {
    schema: "ade.laneGraph.v1";
    relations: import("./contextContract").PackRelation[];
  };
};

export type ConflictLineageV1 = {
  schema: "ade.conflictLineage.v1";
  laneId: string;
  peerKey: string;
  predictionAt: string | null;
  predictionAgeMs?: number | null;
  predictionStale?: boolean | null;
  staleReason?: string | null;
  lastRecomputedAt: string | null;
  truncated: boolean | null;
  strategy: string | null;
  pairwisePairsComputed: number | null;
  pairwisePairsTotal: number | null;
  stalePolicy: { ttlMs: number };
  openConflictSummaries: Array<{
    peerId: string | null;
    peerLabel: string;
    riskLevel: ConflictRiskLevel;
    fileCount: number;
    lastSeenAt: string | null;
    lastSeenAgeMs: number | null;
    riskSignals: string[];
  }>;
  unresolvedResolutionState?: GitConflictState | null;
};

export type PackExport = {
  packKey: string;
  packType: PackType;
  level: ContextExportLevel;
  header: ContextHeaderV1;
  content: string;
  approxTokens: number;
  maxTokens: number;
  truncated: boolean;
  warnings: string[];
  clipReason?: string | null;
  omittedSections?: string[] | null;
};

export type GetLaneExportArgs = { laneId: string; level: ContextExportLevel };
export type GetProjectExportArgs = { level: ContextExportLevel };
export type GetConflictExportArgs = { laneId: string; peerLaneId?: string | null; level: ContextExportLevel };
export type GetFeatureExportArgs = { featureKey: string; level: ContextExportLevel };
export type GetPlanExportArgs = { laneId: string; level: ContextExportLevel };
export type GetMissionExportArgs = { missionId: string; level: ContextExportLevel };

export type GetMissionPackArgs = { missionId: string };

export type RefreshMissionPackArgs = {
  missionId: string;
  reason: string;
  runId?: string | null;
};

export type OrchestratorContextPolicyProfile = {
  id: OrchestratorContextProfileId;
  includeNarrative: boolean;
  docsMode: OrchestratorContextDocsMode;
  laneExportLevel: ContextExportLevel;
  projectExportLevel: ContextExportLevel;
  maxDocBytes: number;
};

export type ListPackEventsSinceArgs = { packKey: string; sinceIso: string; limit?: number };

export type PackDeltaDigestArgs = {
  packKey: string;
  sinceVersionId?: string | null;
  sinceTimestamp?: string | null;
  minimumImportance?: PackEventImportance;
  limit?: number;
};

export type PackSectionChangeV1 = {
  sectionId: string;
  changeType: "added" | "removed" | "modified";
};

export type PackDeltaDigestV1 = {
  packKey: string;
  packType: PackType;
  since: {
    sinceVersionId: string | null;
    sinceTimestamp: string;
    baselineVersionId: string | null;
    baselineVersionNumber: number | null;
    baselineCreatedAt: string | null;
  };
  newVersion: PackHeadVersion;
  changedSections: PackSectionChangeV1[];
  highImpactEvents: PackEvent[];
  blockers: Array<{ kind: string; summary: string; entityIds?: string[] }>;
  conflicts: PackConflictStateV1 | null;
  decisionState: {
    recommendedExportLevel: ContextExportLevel;
    reasons: string[];
  };
  handoffSummary: string;
  clipReason?: string | null;
  omittedSections?: string[] | null;
};

export type PackHeadVersion = {
  packKey: string;
  packType: PackType;
  versionId: string | null;
  versionNumber: number | null;
  contentHash: string | null;
  updatedAt: string | null;
};

export type PackSummary = {
  packKey: string;
  packType: PackType;
  path: string;
  exists: boolean;
  deterministicUpdatedAt: string | null;
  narrativeUpdatedAt: string | null;
  lastHeadSha: string | null;
  versionId?: string | null;
  versionNumber?: number | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown> | null;
  body: string;
};

export type PackVersionSummary = {
  id: string;
  packKey: string;
  packType: PackType;
  versionNumber: number;
  contentHash: string;
  createdAt: string;
};

export type PackVersion = PackVersionSummary & {
  renderedPath: string;
  body: string;
};

export type PackEvent = {
  id: string;
  packKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type Checkpoint = {
  id: string;
  laneId: string;
  sessionId: string | null;
  sha: string;
  diffStat: {
    insertions: number;
    deletions: number;
    filesChanged: number;
    files: string[];
  };
  packEventIds: string[];
  createdAt: string;
};

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type AutomationActionStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type AutomationRun = {
  id: string;
  automationId: string;
  triggerType: AutomationTriggerType;
  startedAt: string;
  endedAt: string | null;
  status: AutomationRunStatus;
  actionsCompleted: number;
  actionsTotal: number;
  errorMessage: string | null;
  /** Trigger-specific context. Shape depends on triggerType (session-end, commit, schedule, manual). */
  triggerMetadata: Record<string, unknown> | null;
};

export type AutomationActionResult = {
  id: string;
  runId: string;
  actionIndex: number;
  actionType: AutomationActionType;
  startedAt: string;
  endedAt: string | null;
  status: AutomationActionStatus;
  errorMessage: string | null;
  output: string | null;
};

export type AutomationRuleSummary = AutomationRule & {
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  running: boolean;
};

export type AutomationRunDetail = {
  run: AutomationRun;
  rule: AutomationRule | null;
  actions: AutomationActionResult[];
};

export type AutomationsEventPayload = {
  type: "runs-updated";
  automationId?: string;
  runId?: string;
};

export type MissionStatus =
  | "queued"
  | "planning"
  | "plan_review"
  | "in_progress"
  | "intervention_required"
  | "completed"
  | "failed"
  | "canceled";

export type MissionPriority = "urgent" | "high" | "normal" | "low";

export type MissionExecutionMode = "local" | "relay";

export type MissionStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked"
  | "canceled";

export type MissionArtifactType = "summary" | "pr" | "link" | "note" | "patch";

export type MissionInterventionType =
  | "approval_required"
  | "manual_input"
  | "conflict"
  | "policy_block"
  | "failed_step";

export type MissionInterventionStatus = "open" | "resolved" | "dismissed";

export type MissionPlannerEngine = "auto" | "claude_cli" | "codex_cli";

export type MissionExecutorPolicy = "codex" | "claude" | "both";

export type MissionPlannerResolvedEngine =
  | "claude_cli"
  | "codex_cli";

export type MissionPlannerReasonCode =
  | "planner_unavailable"
  | "planner_timeout"
  | "planner_parse_error"
  | "planner_schema_error"
  | "planner_validation_error"
  | "planner_execution_error";

export type PlannerMissionDomain = "backend" | "frontend" | "infra" | "testing" | "docs" | "release" | "mixed";

export type PlannerMissionComplexity = "low" | "medium" | "high";

export type PlannerMissionStrategy = "sequential" | "parallel-lite" | "parallel-first";

export type PlannerTaskType = "analysis" | "code" | "integration" | "test" | "review" | "merge" | "deploy" | "docs";

export type PlannerExecutorHint = "claude" | "codex" | "either";

export type PlannerPreferredScope = "lane" | "file" | "session" | "global";

export type PlannerContextProfileRequirement = "deterministic" | "deterministic_plus_narrative";

export type PlannerClaimLane = "analysis" | "backend" | "frontend" | "integration" | "conflict";

export type PlannerJoinPolicy = "all_success" | "any_success" | "quorum";

export type PlannerStepPlan = {
  stepId: string;
  name: string;
  description: string;
  taskType: PlannerTaskType;
  executorHint: PlannerExecutorHint;
  preferredScope: PlannerPreferredScope;
  requiresContextProfiles: PlannerContextProfileRequirement[];
  dependencies: string[];
  joinPolicy?: PlannerJoinPolicy;
  joinQuorum?: number;
  artifactHints: string[];
  claimPolicy: {
    lanes: PlannerClaimLane[];
    filePatterns?: string[];
    envKeys?: string[];
    exclusive?: boolean;
  };
  timeoutMs?: number;
  maxAttempts: number;
  retryPolicy: {
    baseMs: number;
    maxMs: number;
    multiplier: number;
    maxRetries: number;
  };
  outputContract: {
    expectedSignals: string[];
    handoffTo?: string[];
    completionCriteria: string;
  };
};

export type PlannerPlan = {
  schemaVersion: "1.0";
  missionSummary: {
    title: string;
    objective: string;
    domain: PlannerMissionDomain;
    complexity: PlannerMissionComplexity;
    strategy: PlannerMissionStrategy;
    parallelismCap: number;
    parallelismRationale?: string;
  };
  assumptions: string[];
  risks: string[];
  steps: PlannerStepPlan[];
  handoffPolicy: {
    externalConflictDefault: "intervention" | "auto_internal_retry" | "manual_merge_step";
  };
};

export type MissionPlannerAttemptStatus = "succeeded" | "failed";

export type MissionPlannerAttempt = {
  id: string;
  engine: MissionPlannerResolvedEngine;
  status: MissionPlannerAttemptStatus;
  reasonCode: MissionPlannerReasonCode | null;
  detail: string | null;
  commandPreview: string | null;
  rawResponse: string | null;
  validationErrors: string[];
  createdAt: string;
};

export type MissionPlannerRun = {
  id: string;
  missionId: string;
  requestedEngine: MissionPlannerEngine;
  resolvedEngine: MissionPlannerResolvedEngine | null;
  status: "succeeded" | "skipped";
  degraded: boolean;
  reasonCode: MissionPlannerReasonCode | null;
  reasonDetail: string | null;
  planHash: string;
  normalizedPlanHash: string;
  commandPreview: string | null;
  rawResponse: string | null;
  createdAt: string;
  durationMs: number;
  validationErrors: string[];
  attempts: MissionPlannerAttempt[];
};

export type MissionSummary = {
  id: string;
  title: string;
  prompt: string;
  laneId: string | null;
  laneName: string | null;
  status: MissionStatus;
  priority: MissionPriority;
  executionMode: MissionExecutionMode;
  targetMachineId: string | null;
  outcomeSummary: string | null;
  lastError: string | null;
  artifactCount: number;
  openInterventions: number;
  totalSteps: number;
  completedSteps: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type MissionStep = {
  id: string;
  missionId: string;
  index: number;
  title: string;
  detail: string | null;
  kind: string;
  laneId: string | null;
  status: MissionStepStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  metadata: MissionStepMetadata | null;
};

export type MissionEvent = {
  id: string;
  missionId: string;
  eventType: string;
  actor: string;
  summary: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type MissionArtifact = {
  id: string;
  missionId: string;
  artifactType: MissionArtifactType;
  title: string;
  description: string | null;
  uri: string | null;
  laneId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
};

export type MissionIntervention = {
  id: string;
  missionId: string;
  interventionType: MissionInterventionType;
  status: MissionInterventionStatus;
  title: string;
  body: string;
  requestedAction: string | null;
  resolutionNote: string | null;
  laneId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  metadata: Record<string, unknown> | null;
};

export type MissionDetail = MissionSummary & {
  steps: MissionStep[];
  events: MissionEvent[];
  artifacts: MissionArtifact[];
  interventions: MissionIntervention[];
};

export type ListMissionsArgs = {
  status?: MissionStatus | "active";
  laneId?: string;
  limit?: number;
};

export type CreateMissionArgs = {
  prompt: string;
  title?: string;
  laneId?: string | null;
  priority?: MissionPriority;
  executionMode?: MissionExecutionMode;
  targetMachineId?: string | null;
  plannerEngine?: MissionPlannerEngine;
  executorPolicy?: MissionExecutorPolicy;
  planningTimeoutMs?: number;
  allowPlanningQuestions?: boolean;
  autostart?: boolean;
  launchMode?: "autopilot" | "manual";
  autopilotExecutor?: OrchestratorExecutorKind;
  missionDepth?: MissionDepthTier;
  executionPolicy?: Partial<MissionExecutionPolicy>;
  orchestratorModel?: string;
  thinkingBudgets?: Record<string, number>;
  /** New granular model configuration (takes precedence over orchestratorModel) */
  modelConfig?: MissionModelConfig;
};

export type PlanMissionArgs = {
  missionId?: string;
  title?: string;
  prompt: string;
  laneId?: string | null;
  plannerEngine?: MissionPlannerEngine;
  executorPolicy?: MissionExecutorPolicy;
  planningTimeoutMs?: number;
  allowPlanningQuestions?: boolean;
};

export type PlanMissionResult = {
  plan: PlannerPlan;
  run: MissionPlannerRun;
  plannedSteps: Array<{
    index: number;
    title: string;
    detail: string;
    kind: string;
    metadata: Record<string, unknown>;
  }>;
};

export type ListPlannerRunsArgs = {
  missionId?: string;
  limit?: number;
};

export type GetPlannerAttemptArgs = {
  plannerRunId: string;
  attemptId: string;
};

export type UpdateMissionArgs = {
  missionId: string;
  title?: string;
  prompt?: string;
  laneId?: string | null;
  status?: MissionStatus;
  priority?: MissionPriority;
  executionMode?: MissionExecutionMode;
  targetMachineId?: string | null;
  outcomeSummary?: string | null;
  lastError?: string | null;
};

export type UpdateMissionStepArgs = {
  missionId: string;
  stepId: string;
  status: MissionStepStatus;
  note?: string | null;
};

export type AddMissionArtifactArgs = {
  missionId: string;
  artifactType: MissionArtifactType;
  title: string;
  description?: string | null;
  uri?: string | null;
  laneId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AddMissionInterventionArgs = {
  missionId: string;
  interventionType: MissionInterventionType;
  title: string;
  body: string;
  requestedAction?: string | null;
  laneId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ResolveMissionInterventionArgs = {
  missionId: string;
  interventionId: string;
  status: Exclude<MissionInterventionStatus, "open">;
  note?: string | null;
};

export type DeleteMissionArgs = {
  missionId: string;
};

export type MissionsEventPayload = {
  type: "missions-updated";
  missionId?: string;
  reason?: string;
  at: string;
};

export type OrchestratorRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "succeeded_with_risk"
  | "failed"
  | "canceled";

export type OrchestratorStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "canceled";

export type OrchestratorAttemptStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled";

export type OrchestratorJoinPolicy = "all_success" | "any_success" | "quorum" | "advisory";

export type OrchestratorExecutorKind = "claude" | "codex" | "shell" | "manual";

export type OrchestratorErrorClass =
  | "none"
  | "transient"
  | "deterministic"
  | "policy"
  | "claim_conflict"
  | "executor_failure"
  | "canceled"
  | "resume_recovered";

export type OrchestratorClaimScope = "lane" | "file" | "env";

export type OrchestratorClaimState = "active" | "released" | "expired";

export type OrchestratorDocsRef = {
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  mode: "digest_ref" | "full_body";
};

export type OrchestratorMemoryHierarchy = {
  schema: "ade.contextMemoryHierarchy.v1";
  l0: {
    budgetBytes: number;
    consumedBytes: number;
    truncated: boolean;
    frontier: {
      pending: number;
      ready: number;
      running: number;
      blocked: number;
      terminal: number;
    };
    openQuestions: number;
    activeClaims: number;
    activeClaimConflicts: number;
    gateState: "pass" | "warn" | "fail" | "unknown";
    recentDecisions: string[];
  };
  l1: {
    budgetBytes: number;
    consumedBytes: number;
    truncated: boolean;
    stepKey: string;
    stepTitle: string;
    dependencies: Array<{ stepId: string; status: OrchestratorStepStatus }>;
    handoffIds: string[];
    handoffDigest: {
      summarizedCount: number;
      byType: Record<string, number>;
      oldestCreatedAt: string | null;
      newestCreatedAt: string | null;
    } | null;
    recentWorkerDigests: Array<{ stepKey: string | null; status: string; summary: string; createdAt: string }>;
    recentCheckpoints: Array<{ id: string; trigger: string; summary: string; createdAt: string }>;
  };
  l2: {
    budgetBytes: number;
    consumedBytes: number;
    truncated: boolean;
    docsMode: "digest_ref" | "full_body";
    docsCount: number;
    fullDocsIncluded: number;
    docsRefsOnly: number;
    packRefs: Array<{ packKey: string; level: string; approxTokens: number | null }>;
  };
};

export type OrchestratorContextSnapshotCursor = {
  lanePackKey: string | null;
  lanePackVersionId: string | null;
  lanePackVersionNumber: number | null;
  projectPackKey: string | null;
  projectPackVersionId: string | null;
  projectPackVersionNumber: number | null;
  packDeltaSince: string | null;
  docs: OrchestratorDocsRef[];
  packDeltaDigest?: PackDeltaDigestV1 | null;
  missionHandoffIds?: string[];
  missionHandoffDigest?: {
    summarizedCount: number;
    byType: Record<string, number>;
    oldestCreatedAt: string | null;
    newestCreatedAt: string | null;
  } | null;
  contextSources?: string[];
  docsMode?: "digest_ref" | "full_body";
  docsBudgetBytes?: number;
  docsConsumedBytes?: number;
  docsTruncatedCount?: number;
  controlPackV2?: {
    budgetBytes: number;
    consumedBytes: number;
    truncated: boolean;
    frontier: {
      pending: number;
      ready: number;
      running: number;
      blocked: number;
      terminal: number;
    };
    openQuestions: number;
    activeClaims: number;
    activeClaimConflicts: number;
    gateState: "pass" | "warn" | "fail" | "unknown";
    recentDecisions: string[];
    laneStatusMap: Array<{ laneId: string | null; stepKey: string; status: OrchestratorStepStatus }>;
  };
  executionPackV2?: {
    budgetBytes: number;
    consumedBytes: number;
    truncated: boolean;
    stepKey: string;
    stepTitle: string;
    dependencies: Array<{ stepId: string; status: OrchestratorStepStatus }>;
    handoffIds: string[];
    handoffDigest: OrchestratorContextSnapshotCursor["missionHandoffDigest"];
  };
  deepPackV2?: {
    budgetBytes: number;
    consumedBytes: number;
    truncated: boolean;
    docsMode: "digest_ref" | "full_body";
    docsCount: number;
    fullDocsIncluded: number;
    docsRefsOnly: number;
  };
  memoryHierarchy?: OrchestratorMemoryHierarchy;
};

export type OrchestratorRun = {
  id: string;
  missionId: string;
  projectId: string;
  status: OrchestratorRunStatus;
  contextProfile: OrchestratorContextProfileId;
  schedulerState: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  metadata: OrchestratorMetadata | null;
  completionDiagnostics?: CompletionDiagnostic[];
};

export type OrchestratorStep = {
  id: string;
  runId: string;
  missionStepId: string | null;
  stepKey: string;
  stepIndex: number;
  title: string;
  laneId: string | null;
  status: OrchestratorStepStatus;
  joinPolicy: OrchestratorJoinPolicy;
  quorumCount: number | null;
  dependencyStepIds: string[];
  retryLimit: number;
  retryCount: number;
  lastAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  metadata: OrchestratorMetadata | null;
};

export type OrchestratorAttemptResultEnvelope = {
  schema: "ade.orchestratorAttempt.v1";
  success: boolean;
  summary: string;
  outputs: Record<string, unknown> | null;
  warnings: string[];
  sessionId: string | null;
  trackedSession: boolean;
};

export type OrchestratorAttempt = {
  id: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
  status: OrchestratorAttemptStatus;
  executorKind: OrchestratorExecutorKind;
  executorSessionId: string | null;
  trackedSessionEnforced: boolean;
  contextProfile: OrchestratorContextProfileId;
  contextSnapshotId: string | null;
  errorClass: OrchestratorErrorClass;
  errorMessage: string | null;
  retryBackoffMs: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  resultEnvelope: OrchestratorAttemptResultEnvelope | null;
  metadata: OrchestratorMetadata | null;
};

export type OrchestratorClaim = {
  id: string;
  runId: string;
  stepId: string | null;
  attemptId: string | null;
  ownerId: string;
  scopeKind: OrchestratorClaimScope;
  scopeValue: string;
  state: OrchestratorClaimState;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  policy: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

export type OrchestratorContextSnapshot = {
  id: string;
  runId: string;
  stepId: string | null;
  attemptId: string | null;
  snapshotType: "run" | "step" | "attempt";
  contextProfile: OrchestratorContextProfileId;
  cursor: OrchestratorContextSnapshotCursor;
  createdAt: string;
};

export type MissionStepHandoff = {
  id: string;
  missionId: string;
  missionStepId: string | null;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  handoffType: string;
  producer: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type OrchestratorTimelineEvent = {
  id: string;
  runId: string;
  stepId: string | null;
  attemptId: string | null;
  claimId: string | null;
  eventType: string;
  reason: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export type OrchestratorRuntimeEventType =
  | "progress"
  | "heartbeat"
  | "question"
  | "blocked"
  | "done"
  | "retry_scheduled"
  | "retry_exhausted"
  | "claim_conflict"
  | "session_ended"
  | "intervention_opened"
  | "intervention_resolved";

export type OrchestratorRuntimeQuestionLink = {
  threadId: string;
  messageId: string;
  replyTo: string | null;
};

export type OrchestratorRuntimeBusEvent = {
  id: string;
  runId: string;
  stepId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  eventType: OrchestratorRuntimeEventType;
  eventKey: string;
  occurredAt: string;
  payload: Record<string, unknown> | null;
  questionLink?: OrchestratorRuntimeQuestionLink | null;
  createdAt: string;
};

export type OrchestratorRuntimeEvent = {
  type:
    | "orchestrator-run-updated"
    | "orchestrator-step-updated"
    | "orchestrator-attempt-updated"
    | "orchestrator-claim-updated";
  runId?: string;
  stepId?: string;
  attemptId?: string;
  claimId?: string;
  at: string;
  reason: string;
};

export type OrchestratorRunGraph = {
  run: OrchestratorRun;
  steps: OrchestratorStep[];
  attempts: OrchestratorAttempt[];
  claims: OrchestratorClaim[];
  contextSnapshots: OrchestratorContextSnapshot[];
  handoffs: MissionStepHandoff[];
  timeline: OrchestratorTimelineEvent[];
  runtimeEvents?: OrchestratorRuntimeBusEvent[];
  completionEvaluation?: RunCompletionEvaluation;
};

export type OrchestratorGateStatus = "pass" | "warn" | "fail";

export type OrchestratorGateEntry = {
  key:
    | "session_delta_checkpoint_pack_latency"
    | "pack_freshness_by_type"
    | "context_completeness_rate"
    | "blocked_run_rate_insufficient_context";
  label: string;
  status: OrchestratorGateStatus;
  measuredValue: number;
  threshold: number;
  comparator: "<=" | ">=";
  samples: number;
  reasons: string[];
  metadata?: Record<string, unknown> | null;
};

export type OrchestratorGateReport = {
  id: string;
  generatedAt: string;
  generatedBy: "deterministic_kernel";
  overallStatus: OrchestratorGateStatus;
  gates: OrchestratorGateEntry[];
  notes: string[];
};

export type StartOrchestratorRunStepPolicy = {
  includeNarrative?: boolean;
  includeFullDocs?: boolean;
  docsMaxBytes?: number;
  claimScopes?: Array<{
    scopeKind: OrchestratorClaimScope;
    scopeValue: string;
    ttlMs?: number;
  }>;
};

export type StartOrchestratorRunStepInput = {
  missionStepId?: string | null;
  stepKey: string;
  title: string;
  stepIndex: number;
  laneId?: string | null;
  dependencyStepKeys?: string[];
  joinPolicy?: OrchestratorJoinPolicy;
  quorumCount?: number;
  retryLimit?: number;
  executorKind?: OrchestratorExecutorKind;
  metadata?: Record<string, unknown> | null;
  policy?: StartOrchestratorRunStepPolicy;
};

export type StartOrchestratorRunArgs = {
  missionId: string;
  runId?: string;
  contextProfile?: OrchestratorContextProfileId;
  schedulerState?: string;
  metadata?: Record<string, unknown> | null;
  steps: StartOrchestratorRunStepInput[];
};

export type ListOrchestratorRunsArgs = {
  status?: OrchestratorRunStatus;
  missionId?: string;
  limit?: number;
};

export type GetOrchestratorRunGraphArgs = {
  runId: string;
  timelineLimit?: number;
};

export type StartOrchestratorRunFromMissionArgs = {
  missionId: string;
  runId?: string;
  contextProfile?: OrchestratorContextProfileId;
  schedulerState?: string;
  metadata?: Record<string, unknown> | null;
  runMode?: "autopilot" | "manual";
  autopilotOwnerId?: string;
  defaultExecutorKind?: OrchestratorExecutorKind;
  defaultRetryLimit?: number;
  plannerProvider?: "claude" | "codex" | null;
};

export type StartOrchestratorAttemptArgs = {
  runId: string;
  stepId: string;
  ownerId: string;
  executorKind?: OrchestratorExecutorKind;
};

export type CompleteOrchestratorAttemptArgs = {
  attemptId: string;
  status: Extract<OrchestratorAttemptStatus, "succeeded" | "failed" | "blocked" | "canceled">;
  result?: OrchestratorAttemptResultEnvelope;
  errorClass?: OrchestratorErrorClass;
  errorMessage?: string | null;
  retryBackoffMs?: number;
  metadata?: Record<string, unknown> | null;
};

export type TickOrchestratorRunArgs = {
  runId: string;
};

export type ResumeOrchestratorRunArgs = {
  runId: string;
};

export type CancelOrchestratorRunArgs = {
  runId: string;
  reason?: string;
};

export type CleanupOrchestratorTeamResourcesArgs = {
  missionId: string;
  runId?: string;
  cleanupLanes?: boolean;
};

export type CleanupOrchestratorTeamResourcesResult = {
  missionId: string;
  runId: string | null;
  laneIds: string[];
  lanesArchived: string[];
  lanesSkipped: string[];
  laneErrors: Array<{
    laneId: string;
    error: string;
  }>;
};

export type HeartbeatOrchestratorClaimsArgs = {
  attemptId: string;
  ownerId: string;
};

export type ListOrchestratorTimelineArgs = {
  runId: string;
  limit?: number;
};

export type GetOrchestratorGateReportArgs = {
  refresh?: boolean;
};

export type AutomationPlannerProvider = "codex" | "claude";

export type AutomationPlannerCodexCliConfig = {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  askForApproval: "untrusted" | "on-failure" | "on-request" | "never";
  webSearch: boolean;
  additionalWritableDirs: string[];
};

export type AutomationPlannerClaudeCliConfig = {
  permissionMode: "default" | "plan" | "acceptEdits" | "dontAsk" | "delegate" | "bypassPermissions";
  dangerouslySkipPermissions: boolean;
  allowedTools: string[];
  additionalAllowedDirs: string[];
};

export type AutomationPlannerConfig =
  | { provider: "codex"; codex: AutomationPlannerCodexCliConfig }
  | { provider: "claude"; claude: AutomationPlannerClaudeCliConfig };

export type AutomationDraftActionBase = {
  type: AutomationActionType;
  condition?: string;
  continueOnFailure?: boolean;
  timeoutMs?: number;
  retry?: number;
};

export type AutomationDraftAction =
  | (AutomationDraftActionBase & { type: "update-packs" })
  | (AutomationDraftActionBase & { type: "predict-conflicts" })
  | (AutomationDraftActionBase & { type: "run-tests"; suite: string })
  | (AutomationDraftActionBase & { type: "run-command"; command: string; cwd?: string });

export type AutomationRuleDraft = {
  // If provided, saveDraft will update existing rule; otherwise it will create a new one.
  id?: string | null;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  actions: AutomationDraftAction[];
};

export type AutomationRuleDraftNormalized = {
  id?: string | null;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
};

export type AutomationDraftResolutionCandidate = {
  value: string;
  label?: string;
  score: number;
};

export type AutomationDraftResolution = {
  path: string;
  input: string;
  resolved: string;
  confidence: number;
  reason: string;
  candidates: AutomationDraftResolutionCandidate[];
};

export type AutomationDraftAmbiguity = {
  path: string;
  kind: "test-suite" | "branch" | "cron" | "command" | "unknown";
  message: string;
  candidates: AutomationDraftResolutionCandidate[];
};

export type AutomationDraftIssue = {
  level: "error" | "warning";
  path: string;
  message: string;
};

export type AutomationDraftConfirmationRequirement = {
  key: string;
  severity: "warning" | "danger";
  title: string;
  message: string;
};

export type AutomationParseNaturalLanguageRequest = {
  intent: string;
  planner: AutomationPlannerConfig;
};

export type AutomationParseNaturalLanguageResult = {
  draft: AutomationRuleDraft;
  normalized: AutomationRuleDraftNormalized | null;
  confidence: number;
  ambiguities: AutomationDraftAmbiguity[];
  resolutions: AutomationDraftResolution[];
  issues: AutomationDraftIssue[];
  plannerCommandPreview: string;
};

export type AutomationValidateDraftRequest = {
  draft: AutomationRuleDraft;
  // Confirmation keys accepted by the user (e.g., running unsafe commands).
  confirmations?: string[];
};

export type AutomationValidateDraftResult = {
  ok: boolean;
  normalized: AutomationRuleDraftNormalized | null;
  issues: AutomationDraftIssue[];
  requiredConfirmations: AutomationDraftConfirmationRequirement[];
};

export type AutomationSaveDraftRequest = {
  draft: AutomationRuleDraft;
  confirmations?: string[];
};

export type AutomationSaveDraftResult = {
  rule: AutomationRule;
  rules: AutomationRuleSummary[];
};

export type AutomationSimulationAction = {
  index: number;
  type: AutomationActionType;
  summary: string;
  commandPreview?: string;
  cwdPreview?: string;
  warnings: string[];
};

export type AutomationSimulateRequest = {
  draft: AutomationRuleDraft;
};

export type AutomationSimulateResult = {
  normalized: AutomationRuleDraftNormalized | null;
  actions: AutomationSimulationAction[];
  notes: string[];
  issues: AutomationDraftIssue[];
};

export type OnboardingStatus = {
  completedAt: string | null;
};

export type OnboardingDetectionIndicator = {
  file: string;
  type: string;
  confidence: number;
};

export type OnboardingDetectionResult = {
  projectTypes: string[];
  indicators: OnboardingDetectionIndicator[];
  suggestedConfig: ProjectConfigFile;
  suggestedWorkflows: Array<{ path: string; kind: "github-actions" | "gitlab-ci" | "other" }>;
};

export type OnboardingExistingLaneCandidate = {
  branchRef: string;
  isCurrent: boolean;
  hasRemote: boolean;
  ahead: number;
  behind: number;
};

export type CiProvider = "github-actions" | "gitlab-ci" | "circleci" | "jenkins";
export type CiJobSafety = "local-safe" | "ci-only" | "unknown";

export type CiJobCandidate = {
  id: string;
  provider: CiProvider;
  filePath: string; // repo-relative
  jobName: string;
  commands: string[];
  suggestedCommandLine: string | null;
  suggestedCommand: string[] | null;
  safety: CiJobSafety;
  warnings: string[];
};

export type CiScanDiff = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
};

export type CiImportMode = "import" | "sync";

export type CiImportSelection = {
  jobId: string;
  kind: "process" | "testSuite";
};

export type CiImportState = {
  fingerprint: string;
  jobDigests: Record<string, string>;
  importedAt: string;
  importedJobs: Array<{
    jobId: string;
    kind: "process" | "testSuite";
    targetId: string;
  }>;
};

export type CiScanResult = {
  providers: CiProvider[];
  jobs: CiJobCandidate[];
  fingerprint: string;
  scannedAt: string;
  lastImport: CiImportState | null;
  diff: CiScanDiff | null;
};

export type CiImportRequest = {
  selections: CiImportSelection[];
  mode?: CiImportMode;
};

export type CiImportResult = {
  snapshot: ProjectConfigSnapshot;
  importState: CiImportState;
};

export type KeybindingOverride = {
  id: string;
  binding: string;
};

export type KeybindingDefinition = {
  id: string;
  description: string;
  defaultBinding: string;
  scope: "global" | "lanes" | "files" | "run" | "graph" | "conflicts" | "history";
};

export type KeybindingsSnapshot = {
  definitions: KeybindingDefinition[];
  overrides: KeybindingOverride[];
};

export type AgentTool = {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  detectedPath: string | null;
  detectedVersion: string | null;
};

export type TerminalLaunchProfile = {
  id: string;
  name: string;
  command: string;
  tracked: boolean;
  description?: string | null;
  color?: string | null;
};

export type TerminalProfilesSnapshot = {
  profiles: TerminalLaunchProfile[];
  defaultProfileId: string | null;
};

export type SessionDeltaSummary = {
  sessionId: string;
  laneId: string;
  startedAt: string;
  endedAt: string | null;
  headShaStart: string | null;
  headShaEnd: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  touchedFiles: string[];
  failureLines: string[];
  computedAt: string | null;
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
  scenario?: ResolverSessionScenario;
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
// PR Tab Enhancement (Phase 8+)
// --------------------------------

export type PrGroupType = "queue" | "integration";
/** @deprecated Use PrGroupType "queue" instead */
export type PrGroupTypeLegacy = "stacked" | "integration";
export type PrGroupMemberRole = "source" | "integration" | "target";

export type PrGroup = {
  id: string;
  projectId: string;
  groupType: PrGroupType;
  createdAt: string;
};

export type PrGroupMember = {
  groupId: string;
  prId: string;
  laneId: string;
  position: number;
  role: PrGroupMemberRole;
};

export type PrGroupContextMember = {
  prId: string;
  laneId: string;
  laneName: string;
  prNumber: number | null;
  position: number;
  role: PrGroupMemberRole;
};

export type PrMergeContext = {
  prId: string;
  groupId: string | null;
  groupType: PrGroupType | null;
  sourceLaneIds: string[];
  targetLaneId: string | null;
  members: PrGroupContextMember[];
};

export type CreateQueuePrsArgs = {
  laneIds: string[];
  targetBranch: string;
  titles?: Record<string, string>;
  draft?: boolean;
  autoRebase?: boolean;
  ciGating?: boolean;
  queueName?: string;
};

/** @deprecated Use CreateQueuePrsArgs */
export type CreateStackedPrsArgs = CreateQueuePrsArgs;

export type CreateQueuePrsResult = {
  groupId: string;
  prs: PrSummary[];
  errors: Array<{ laneId: string; error: string }>;
};

/** @deprecated Use CreateQueuePrsResult */
export type CreateStackedPrsResult = CreateQueuePrsResult;

export type CreateIntegrationPrArgs = {
  sourceLaneIds: string[];
  integrationLaneName: string;
  baseBranch: string;
  title: string;
  body?: string;
  draft?: boolean;
};

export type CreateIntegrationPrResult = {
  groupId: string;
  integrationLaneId: string;
  pr: PrSummary;
  mergeResults: Array<{ laneId: string; success: boolean; error?: string }>;
};

export type LandStackEnhancedArgs = {
  rootLaneId: string;
  method: MergeMethod;
  mode: "sequential" | "all-at-once";
};

// --------------------------------
// Integration Proposal Types
// --------------------------------

export type IntegrationProposalStep = {
  laneId: string;
  laneName: string;
  position: number;
  outcome: "clean" | "conflict" | "blocked" | "pending";
  conflictingFiles: Array<{
    path: string;
    conflictMarkers: string;
    oursExcerpt: string | null;
    theirsExcerpt: string | null;
    diffHunk: string | null;
  }>;
  diffStat: { insertions: number; deletions: number; filesChanged: number };
};

export type IntegrationPairwiseResult = {
  laneAId: string;
  laneAName: string;
  laneBId: string;
  laneBName: string;
  outcome: "clean" | "conflict";
  conflictingFiles: Array<{
    path: string;
    conflictMarkers: string;
    oursExcerpt: string | null;
    theirsExcerpt: string | null;
    diffHunk: string | null;
  }>;
};

export type IntegrationLaneSummary = {
  laneId: string;
  laneName: string;
  outcome: "clean" | "conflict" | "blocked";
  commitHash: string;
  commitCount: number;
  conflictsWith: string[];
  diffStat: { insertions: number; deletions: number; filesChanged: number };
};

export type IntegrationProposal = {
  proposalId: string;
  sourceLaneIds: string[];
  baseBranch: string;
  pairwiseResults: IntegrationPairwiseResult[];
  laneSummaries: IntegrationLaneSummary[];
  // Kept for backward compatibility with existing consumers.
  steps: IntegrationProposalStep[];
  overallOutcome: "clean" | "conflict" | "blocked";
  createdAt: string;
  title?: string;
  body?: string;
  draft?: boolean;
  integrationLaneName?: string;
  status: "proposed" | "committed";
  integrationLaneId?: string | null;
  resolutionState?: IntegrationResolutionState | null;
};

export type UpdateIntegrationProposalArgs = {
  proposalId: string;
  title?: string;
  body?: string;
  draft?: boolean;
  integrationLaneName?: string;
};

export type SimulateIntegrationArgs = {
  sourceLaneIds: string[];
  baseBranch: string;
};

export type CommitIntegrationArgs = {
  proposalId: string;
  integrationLaneName: string;
  title: string;
  body?: string;
  draft?: boolean;
  pauseOnConflict?: boolean;
};

export type IntegrationStepResolution = "pending" | "merged-clean" | "resolving" | "resolved" | "failed";

export type IntegrationResolutionState = {
  integrationLaneId: string;
  stepResolutions: Record<string, IntegrationStepResolution>; // keyed by laneId
  activeChatSessionId: string | null;
  activeLaneId: string | null;
  updatedAt: string;
};

export type CreateIntegrationLaneForProposalArgs = {
  proposalId: string;
};

export type CreateIntegrationLaneForProposalResult = {
  integrationLaneId: string;
  mergedCleanLanes: string[];
  conflictingLanes: string[];
};

export type StartIntegrationResolutionArgs = {
  proposalId: string;
  laneId: string; // the conflicting source lane to resolve
  provider: AgentChatProvider;
  model: string;
  reasoningEffort?: string;
  autoApprove?: boolean;
};

export type StartIntegrationResolutionResult = {
  chatSessionId: string;
  integrationLaneId: string;
};

export type RecheckIntegrationStepArgs = {
  proposalId: string;
  laneId: string;
};

export type RecheckIntegrationStepResult = {
  resolution: IntegrationStepResolution;
  remainingConflictFiles: string[];
  allResolved: boolean;
};

// --------------------------------
// Rebase Types
// --------------------------------

export type RebaseNeed = {
  laneId: string;
  laneName: string;
  baseBranch: string;
  behindBy: number;
  conflictPredicted: boolean;
  conflictingFiles: string[];
  prId: string | null;
  groupContext: string | null;
  dismissedAt: string | null;
  deferredUntil: string | null;
};

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
// Queue / Integration State Types
// --------------------------------

export type QueueEntryState = "pending" | "landing" | "rebasing" | "resolving" | "landed" | "failed" | "paused" | "skipped";
export type QueueState = "idle" | "landing" | "paused" | "completed" | "cancelled";
export type IntegrationFlowState = "proposal" | "creating" | "merging" | "conflict" | "resolving" | "completed" | "failed";

export type LandQueueNextArgs = {
  groupId: string;
  method: MergeMethod;
  archiveLane?: boolean;
  autoResolve?: boolean;
  confidenceThreshold?: number;
};

export type QueueLandingEntry = {
  prId: string;
  laneId: string;
  laneName: string;
  position: number;
  state: QueueEntryState;
  error?: string;
};

export type QueueLandingState = {
  queueId: string;
  groupId: string;
  state: QueueState;
  entries: QueueLandingEntry[];
  currentPosition: number;
  startedAt: string;
  completedAt: string | null;
};

// --------------------------------
// PrHealth Unified Type
// --------------------------------

export type PrHealth = {
  prId: string;
  laneId: string;
  state: PrState;
  checksStatus: PrChecksStatus;
  reviewStatus: PrReviewStatus;
  conflictAnalysis: PrConflictAnalysis | null;
  rebaseNeeded: boolean;
  behindBy: number;
  mergeContext: PrMergeContext | null;
};

export type PrConflictAnalysis = {
  prId: string;
  laneId: string;
  riskLevel: ConflictRiskLevel;
  overlapCount: number;
  conflictPredicted: boolean;
  peerConflicts: Array<{
    peerId: string;
    peerName: string;
    riskLevel: ConflictRiskLevel;
    overlapFiles: string[];
  }>;
  analyzedAt: string;
};

export type PrWithConflicts = PrSummary & {
  conflictAnalysis: PrConflictAnalysis | null;
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

// ─────────────────────────────────────────────────────
// Phase 3: AI Orchestrator — Worker Lifecycle & Budget
// ─────────────────────────────────────────────────────

export type OrchestratorWorkerStatus =
  | "spawned"
  | "initializing"
  | "working"
  | "waiting_input"
  | "idle"
  | "completed"
  | "failed"
  | "disposed";

export type OrchestratorWorkerState = {
  attemptId: string;
  stepId: string;
  runId: string;
  sessionId: string | null;
  executorKind: OrchestratorExecutorKind;
  state: OrchestratorWorkerStatus;
  lastHeartbeatAt: string;
  spawnedAt: string;
  completedAt: string | null;
  outcomeTags: string[];
};

export type GetOrchestratorWorkerStatesArgs = {
  runId: string;
};

export type OrchestratorPlannerProvider = "claude" | "codex" | "deterministic";

export type StartMissionRunWithAIArgs = {
  missionId: string;
  runMode?: "autopilot" | "manual";
  autopilotOwnerId?: string;
  defaultExecutorKind?: OrchestratorExecutorKind;
  defaultRetryLimit?: number;
  metadata?: Record<string, unknown> | null;
  forcePlanReviewBypass?: boolean;
  plannerProvider?: OrchestratorPlannerProvider;
};

export type StartMissionRunWithAIResult = {
  blockedByPlanReview: boolean;
  started: { run: OrchestratorRun; steps: OrchestratorStep[] } | null;
  mission: MissionDetail | null;
};

// ─────────────────────────────────────────────────────
// Phase 3+: Mission Depth Tiers, Model Capabilities,
// PM Intelligence, and User Steering
// ─────────────────────────────────────────────────────

/** @deprecated Use MissionExecutionPolicy instead */
export type MissionDepthTier = "light" | "standard" | "deep";

/** @deprecated Use MissionExecutionPolicy instead */
export type MissionDepthConfig = {
  tier: MissionDepthTier;
  planning: {
    useAiPlanner: boolean;
    plannerModel?: string;
    maxPlanningTimeMs: number;
    requirePlanReview: boolean;
  };
  execution: {
    maxParallelWorkers: number;
    defaultRetryLimit: number;
    stepTimeoutMs: number;
    maxTotalTokenBudget: number;
    maxPerStepTokenBudget: number;
  };
  evaluation: {
    evaluateEveryStep: boolean;
    evaluationModel?: string;
    autoAdjustPlan: boolean;
    autoResolveInterventions: boolean;
    interventionConfidenceThreshold: number;
  };
  context: {
    contextProfile: OrchestratorContextProfileId;
    includeNarrative: boolean;
    docsMode: OrchestratorContextDocsMode;
  };
};

// ─────────────────────────────────────────────────────
// Mission Execution Policy (replaces MissionDepthTier)
// ─────────────────────────────────────────────────────

export type PlanningPhaseMode = "off" | "auto" | "manual_review";
export type TestingPhaseMode = "none" | "post_implementation" | "tdd";
export type GatePhaseMode = "required" | "optional" | "off";
export type IntegrationPhaseMode = "off" | "auto";
export type MergePhaseMode = "off";
export type PhaseModelChoice = "claude" | "codex";

// ─────────────────────────────────────────────────────
// Model Configuration (granular model selection)
// ─────────────────────────────────────────────────────

export type ModelProvider = "claude" | "codex";

export type ThinkingLevel = "none" | "low" | "medium" | "high" | "max";

export type ModelConfig = {
  provider: ModelProvider;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

/** The types of AI calls the orchestrator makes internally */
export type OrchestratorCallType =
  | "coordinator"
  | "worker_evaluation"
  | "quality_gate"
  | "failure_diagnosis"
  | "plan_adjustment"
  | "intervention_handling"
  | "chat_response"
  | "lane_strategy"
  | "step_transition"
  | "retry_decision"
  | "timeout_estimation"
  | "step_priority"
  | "parallelism_decision"
  | "stagnation_evaluation"
  | "recovery_decision";

/** Mission-level timeout cap for orchestrator internal AI decision calls. */
export type OrchestratorDecisionTimeoutCapHours = 6 | 12 | 24 | 48;

/** Per-call-type model configuration for orchestrator intelligence */
export type OrchestratorIntelligenceConfig = {
  [K in OrchestratorCallType]?: ModelConfig;
};

/** Smart token budget configuration */
export type SmartBudgetConfig = {
  enabled: boolean;
  /** Cost threshold (USD) for 5-hour window before steering kicks in */
  fiveHourThresholdUsd: number;
  /** Cost threshold (USD) for weekly window before steering kicks in */
  weeklyThresholdUsd: number;
  /** Current 5-hour spend (populated at runtime, not persisted) */
  currentFiveHourSpendUsd?: number;
  /** Current weekly spend (populated at runtime, not persisted) */
  currentWeeklySpendUsd?: number;
};

export type BudgetSteeringAction =
  | "downgrade_models"
  | "inject_conciseness"
  | "skip_optional_phases"
  | "reduce_parallelism"
  | "warn_workers"
  | "switch_provider";

export type BudgetPressureLevel = "none" | "approaching" | "exceeded";

export type BudgetPressureSnapshot = {
  level: BudgetPressureLevel;
  fiveHourSpendUsd: number;
  weeklySpendUsd: number;
  fiveHourThresholdUsd: number;
  weeklyThresholdUsd: number;
  fiveHourPct: number;
  weeklyPct: number;
  activeActions: BudgetSteeringAction[];
  message: string;
};

/** Named model profile for quick mission configuration */
export type MissionModelProfile = {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  orchestratorModel: ModelConfig;
  decisionTimeoutCapHours?: OrchestratorDecisionTimeoutCapHours;
  phaseDefaults: {
    planning: ModelConfig;
    implementation: ModelConfig;
    testing: ModelConfig;
    validation: ModelConfig;
    codeReview: ModelConfig;
    testReview: ModelConfig;
    integration: ModelConfig;
  };
  intelligenceConfig: OrchestratorIntelligenceConfig;
  smartBudget?: SmartBudgetConfig;
};

/** The full mission model configuration stored in launch metadata */
export type MissionModelConfig = {
  profileId?: string;
  orchestratorModel: ModelConfig;
  decisionTimeoutCapHours?: OrchestratorDecisionTimeoutCapHours;
  intelligenceConfig?: OrchestratorIntelligenceConfig;
  smartBudget?: SmartBudgetConfig;
};

export type PrStrategy =
  | { kind: "integration"; targetBranch?: string; draft?: boolean }
  | { kind: "per-lane"; targetBranch?: string; draft?: boolean }
  | { kind: "queue"; targetBranch?: string; draft?: boolean; autoRebase?: boolean; ciGating?: boolean }
  | { kind: "manual" };

export type MissionExecutionPolicy = {
  planning: { mode: PlanningPhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  implementation: { model?: PhaseModelChoice; reasoningEffort?: string };
  testing: { mode: TestingPhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  validation: { mode: GatePhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  codeReview: { mode: GatePhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  testReview: { mode: GatePhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  integration: { mode: IntegrationPhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  merge: { mode: "off" };
  completion: { allowCompletionWithRisk: boolean };
  recoveryLoop?: RecoveryLoopPolicy;
  integrationPr?: IntegrationPrPolicy;
  prStrategy?: PrStrategy;
  useAgentTeams?: boolean;
};

export type CompletionDiagnostic = {
  phase: string;
  code:
    | "phase_required_missing"
    | "phase_skipped_by_policy"
    | "phase_in_progress"
    | "phase_failed"
    | "phase_succeeded";
  message: string;
  blocking: boolean;
};

export type RunCompletionEvaluation = {
  status: OrchestratorRunStatus;
  diagnostics: CompletionDiagnostic[];
  riskFactors: string[];
  completionReady: boolean;
};

export type ModelCapabilityProfile = {
  provider: "claude" | "codex";
  modelId: string;
  displayName: string;
  strengths: string[];
  weaknesses: string[];
  costTier: "low" | "medium" | "high" | "very_high";
  bestFor: AiTaskRoutingKey[];
  parallelCapable: boolean;
  reasoningTiers?: string[];
};

export type UserSteeringDirective = {
  missionId: string;
  directive: string;
  priority: "suggestion" | "instruction" | "override";
  targetStepKey?: string | null;
};

export type SteerMissionArgs = UserSteeringDirective;

export type SteerMissionResult = {
  acknowledged: boolean;
  appliedAt: string;
  response?: string;
};

/** @deprecated Use MissionExecutionPolicy instead */
export type GetMissionDepthConfigArgs = {
  tier: MissionDepthTier;
};

export type GetModelCapabilitiesResult = {
  profiles: ModelCapabilityProfile[];
};

export type OrchestratorChatMessage = {
  id: string;
  missionId: string;
  role: "user" | "orchestrator" | "worker" | "agent";
  content: string;
  timestamp: string;
  stepKey?: string | null;
  threadId?: string | null;
  target?: OrchestratorChatTarget | null;
  visibility?: OrchestratorChatVisibilityMode;
  deliveryState?: OrchestratorChatDeliveryState;
  sourceSessionId?: string | null;
  attemptId?: string | null;
  laneId?: string | null;
  runId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type OrchestratorChatThreadType = "mission" | "worker";

export type OrchestratorChatVisibilityMode = "full" | "digest_only" | "metadata_only";

export type OrchestratorChatDeliveryState = "queued" | "delivered" | "failed";

export type OrchestratorChatTarget =
  | {
      kind: "coordinator";
      runId?: string | null;
    }
  | {
      kind: "workers";
      runId?: string | null;
      laneId?: string | null;
      includeClosed?: boolean;
    }
  | {
      kind: "worker";
      runId?: string | null;
      stepId?: string | null;
      stepKey?: string | null;
      attemptId?: string | null;
      sessionId?: string | null;
      laneId?: string | null;
    }
  | {
      kind: "agent";
      sourceAttemptId: string;
      targetAttemptId: string;
      runId?: string | null;
      laneId?: string | null;
    };

export type OrchestratorChatThread = {
  id: string;
  missionId: string;
  threadType: OrchestratorChatThreadType;
  title: string;
  runId?: string | null;
  stepId?: string | null;
  stepKey?: string | null;
  attemptId?: string | null;
  sessionId?: string | null;
  laneId?: string | null;
  status: "active" | "closed";
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | null;
};

export type OrchestratorThreadEventType =
  | "thread_updated"
  | "message_appended"
  | "message_updated"
  | "metrics_updated"
  | "worker_digest_updated"
  | "worker_replay";

export type OrchestratorThreadEvent = {
  type: OrchestratorThreadEventType;
  missionId: string;
  at: string;
  threadId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ListOrchestratorChatThreadsArgs = {
  missionId: string;
  includeClosed?: boolean;
};

export type GetOrchestratorThreadMessagesArgs = {
  missionId: string;
  threadId: string;
  limit?: number;
  before?: string | null;
};

export type SendOrchestratorThreadMessageArgs = {
  missionId: string;
  content: string;
  threadId?: string | null;
  target?: OrchestratorChatTarget;
  visibilityMode?: OrchestratorChatVisibilityMode;
  metadata?: Record<string, unknown> | null;
};

export type SendAgentMessageArgs = {
  missionId: string;
  fromAttemptId: string;
  toAttemptId: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

export type SendOrchestratorChatArgs = {
  missionId: string;
  content: string;
  threadId?: string | null;
  target?: OrchestratorChatTarget;
  visibilityMode?: OrchestratorChatVisibilityMode;
  metadata?: Record<string, unknown> | null;
};

export type GetOrchestratorChatArgs = {
  missionId: string;
};

export type OrchestratorWorkerDigest = {
  id: string;
  missionId: string;
  runId: string;
  stepId: string;
  stepKey: string | null;
  attemptId: string;
  laneId: string | null;
  sessionId: string | null;
  status: "succeeded" | "failed" | "blocked" | "running" | "queued";
  summary: string;
  filesChanged: string[];
  testsRun: {
    passed: number;
    failed: number;
    skipped: number;
    summary?: string | null;
  };
  warnings: string[];
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
  } | null;
  costUsd?: number | null;
  suggestedNextActions?: string[];
  createdAt: string;
};

export type ListOrchestratorWorkerDigestsArgs = {
  missionId: string;
  runId?: string | null;
  stepId?: string | null;
  attemptId?: string | null;
  laneId?: string | null;
  limit?: number;
};

export type GetOrchestratorWorkerDigestArgs = {
  missionId: string;
  digestId: string;
};

export type OrchestratorContextCheckpoint = {
  id: string;
  missionId: string;
  runId: string | null;
  trigger: "step_threshold" | "pressure_soft" | "pressure_hard" | "status_request" | "manual";
  summary: string;
  source: {
    digestCount: number;
    chatMessageCount: number;
    compressedMessageCount: number;
  };
  createdAt: string;
};

export type GetOrchestratorContextCheckpointArgs = {
  missionId: string;
  checkpointId?: string;
};

export type OrchestratorLaneDecision = {
  id: string;
  missionId: string;
  runId: string | null;
  stepId: string | null;
  stepKey: string | null;
  laneId: string | null;
  decisionType: "proposal" | "validated" | "override" | "replan";
  validatorOutcome: "pass" | "fail" | "warn";
  ruleHits: string[];
  rationale: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

export type ListOrchestratorLaneDecisionsArgs = {
  missionId: string;
  runId?: string | null;
  stepId?: string | null;
  limit?: number;
};

export type MissionMetricToggle =
  | "planning"
  | "implementation"
  | "testing"
  | "validation"
  | "code_review"
  | "test_review"
  | "integration"
  | "cost"
  | "tokens"
  | "retries"
  | "claims"
  | "context_pressure"
  | "interventions";

export type MissionMetricsConfig = {
  missionId: string;
  toggles: MissionMetricToggle[];
  updatedAt: string;
};

export type MissionMetricSample = {
  id: string;
  missionId: string;
  runId: string | null;
  attemptId: string | null;
  metric: MissionMetricToggle | string;
  value: number;
  unit: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

export type GetMissionMetricsArgs = {
  missionId: string;
  runId?: string | null;
  limit?: number;
};

export type SetMissionMetricsConfigArgs = {
  missionId: string;
  toggles: MissionMetricToggle[];
};

// ─────────────────────────────────────────────────────
// Phase 3: Orchestrator Capability Types
// Role Isolation, Team Synthesis, Recovery Loops,
// Context Brokerage, Execution Plan Preview
// ─────────────────────────────────────────────────────

/**
 * Worker roles enforced across planner/scheduler/executor.
 * Implementation and review/test-review MUST NOT run in the
 * same worker identity/session for the same mission run.
 */
export type OrchestratorWorkerRole =
  | "planning"
  | "implementation"
  | "testing"
  | "code_review"
  | "test_review"
  | "integration"
  | "merge";

/**
 * Defines which roles are mutually exclusive within a single
 * worker session. Used by the role-isolation validator.
 */
export type RoleIsolationRule = {
  /** Roles that cannot coexist in the same worker session */
  mutuallyExclusive: [OrchestratorWorkerRole, OrchestratorWorkerRole];
  /** Whether to auto-correct (split) or hard-reject invalid plans */
  enforcement: "auto_correct" | "reject";
  /** Human-readable reason for the isolation rule */
  reason: string;
};

/**
 * The default set of role isolation rules.
 * Source: Anthropic sub-agent docs recommend strict role boundaries
 * to prevent context contamination between implementers and reviewers.
 */
export const DEFAULT_ROLE_ISOLATION_RULES: RoleIsolationRule[] = [
  {
    mutuallyExclusive: ["implementation", "code_review"],
    enforcement: "auto_correct",
    reason: "Implementers must not review their own code."
  },
  {
    mutuallyExclusive: ["implementation", "test_review"],
    enforcement: "auto_correct",
    reason: "Implementers must not review their own test results."
  },
  {
    mutuallyExclusive: ["testing", "test_review"],
    enforcement: "auto_correct",
    reason: "Test authors must not review their own test results."
  },
  {
    mutuallyExclusive: ["code_review", "implementation"],
    enforcement: "auto_correct",
    reason: "Reviewers must not implement code they reviewed."
  }
];

/**
 * Result of validating a plan against role isolation rules.
 */
export type RoleIsolationValidation = {
  valid: boolean;
  violations: Array<{
    rule: RoleIsolationRule;
    affectedStepIds: string[];
    correctionApplied: boolean;
    correctionDetail?: string;
  }>;
  correctedPlan?: boolean;
};

/**
 * Run-level team manifest produced by the team synthesis pass.
 * Machine-readable record of who does what in this run.
 */
export type TeamManifest = {
  runId: string;
  missionId: string;
  synthesizedAt: string;
  /** Why these roles were chosen */
  rationale: string;
  /** Mission complexity assessment driving team decisions */
  complexity: TeamComplexityAssessment;
  /** Individual worker role assignments */
  workers: TeamWorkerAssignment[];
  /** Max concurrent workers for this run */
  parallelismCap: number;
  /** Whether any workers can safely run in parallel */
  parallelLanes: string[][];
  /** Telemetry: why N workers, why these roles */
  decisionLog: TeamDecisionEntry[];
};

export type TeamComplexityAssessment = {
  domain: "frontend" | "backend" | "fullstack" | "infra" | "mixed";
  estimatedScope: "small" | "medium" | "large" | "very_large";
  parallelizable: boolean;
  requiresIntegration: boolean;
  /** Number of distinct file-ownership zones detected */
  fileZoneCount: number;
  /** Whether prompt explicitly requests thoroughness */
  thoroughnessRequested: boolean;
};

export type TeamWorkerAssignment = {
  workerId: string;
  role: OrchestratorWorkerRole;
  /** Which steps this worker handles */
  assignedStepKeys: string[];
  /** Lane this worker operates in */
  laneId: string | null;
  /** Executor to use */
  executorKind: OrchestratorExecutorKind;
  /** Model override for this worker */
  model?: string;
};

export type TeamDecisionEntry = {
  timestamp: string;
  decision: string;
  reason: string;
  source: "policy" | "complexity" | "prompt" | "dag_shape" | "override";
};

/**
 * Recovery loop policy for quality gates.
 * When review/test fails, orchestrator spawns fix steps,
 * then mandatory re-review/re-test, capped by maxIterations.
 */
export type RecoveryLoopPolicy = {
  /** Enable automatic recovery loops */
  enabled: boolean;
  /** Max fix-review-test cycles before stopping */
  maxIterations: number;
  /** What to do when max iterations reached */
  onExhaustion: "fail" | "intervention" | "complete_with_risk";
  /** Anti-thrash: minimum confidence delta required between iterations */
  minConfidenceDelta?: number;
  /** Anti-thrash: escalate after N consecutive failures with no progress */
  escalateAfterStagnant?: number;
};

export const DEFAULT_RECOVERY_LOOP_POLICY: RecoveryLoopPolicy = {
  enabled: true,
  maxIterations: 3,
  onExhaustion: "intervention",
  minConfidenceDelta: 0.1,
  escalateAfterStagnant: 2
};

/**
 * Tracks a single recovery loop iteration.
 */
export type RecoveryLoopIteration = {
  iteration: number;
  triggerStepId: string;
  triggerPhase: string;
  failureReason: string;
  fixStepId: string | null;
  reReviewStepId: string | null;
  reTestStepId: string | null;
  outcome: "fixed" | "still_failing" | "escalated" | "max_iterations";
  confidence?: number;
  startedAt: string;
  completedAt: string | null;
  diagnosis?: RecoveryDiagnosis | null;
};

/**
 * Tiered failure classification for smart agent recovery.
 * - transient: timeouts, rate limits — retry with backoff, no AI needed
 * - semantic: logic/code errors — AI diagnoses and adjusts retry prompt
 * - blocker: persistent failures or policy violations — AI diagnoses + notifies peer agents
 */
export type RecoveryDiagnosisTier = "transient" | "semantic" | "blocker";

/**
 * AI-generated failure diagnosis guiding smart retry behavior.
 */
export type RecoveryDiagnosis = {
  tier: RecoveryDiagnosisTier;
  classification: string;
  adjustedHint: string | null;
  peerNotification: string | null;
  suggestedModel: string | null;
  diagnosedAt: string;
};

/**
 * Full recovery loop state for a run.
 */
export type RecoveryLoopState = {
  runId: string;
  iterations: RecoveryLoopIteration[];
  currentIteration: number;
  exhausted: boolean;
  stopReason: string | null;
};

/**
 * Context view defines what context a worker role receives.
 * Reviewers get immutable artifacts, not implementer scratch state.
 */
export type OrchestratorContextView = "implementation" | "review" | "test_review";

/**
 * Context view policy controlling what context is assembled for each role.
 */
export type ContextViewPolicy = {
  view: OrchestratorContextView;
  /** Whether the context is read-only (no write claims allowed) */
  readOnly: boolean;
  /** Include mutable implementer scratch context */
  includeScratchContext: boolean;
  /** Include immutable artifacts/handoffs */
  includeArtifacts: boolean;
  /** Include test/check results */
  includeCheckResults: boolean;
  /** Include upstream handoff summaries */
  includeHandoffSummaries: boolean;
  /** Include full file diffs or just summaries */
  diffMode: "full" | "summary" | "none";
};

export const DEFAULT_CONTEXT_VIEW_POLICIES: Record<OrchestratorContextView, ContextViewPolicy> = {
  implementation: {
    view: "implementation",
    readOnly: false,
    includeScratchContext: true,
    includeArtifacts: true,
    includeCheckResults: true,
    includeHandoffSummaries: true,
    diffMode: "full"
  },
  review: {
    view: "review",
    readOnly: true,
    includeScratchContext: false,
    includeArtifacts: true,
    includeCheckResults: true,
    includeHandoffSummaries: true,
    diffMode: "full"
  },
  test_review: {
    view: "test_review",
    readOnly: true,
    includeScratchContext: false,
    includeArtifacts: true,
    includeCheckResults: true,
    includeHandoffSummaries: true,
    diffMode: "summary"
  }
};

/**
 * Integration PR policy: controls whether and how
 * the orchestrator creates integration PRs at run completion.
 */
export type IntegrationPrPolicy = {
  /** Whether to create integration PRs */
  enabled: boolean;
  /** Create integration lane to merge parallel lanes */
  createIntegrationLane: boolean;
  /** Resolve merge conflicts before opening PR */
  autoResolveConflicts: boolean;
  /** Open PR as draft */
  draft: boolean;
  /** Base branch for integration PR */
  baseBranch?: string;
};

export const DEFAULT_INTEGRATION_PR_POLICY: IntegrationPrPolicy = {
  enabled: false,
  createIntegrationLane: true,
  autoResolveConflicts: true,
  draft: true
};

/**
 * Execution plan preview shown to users before/during run.
 * Simple view into orchestration decisions without advanced settings.
 */
export type ExecutionPlanPreview = {
  runId: string;
  missionId: string;
  generatedAt: string;
  /** High-level strategy chosen */
  strategy: string;
  /** Inferred phases with details */
  phases: ExecutionPlanPhase[];
  /** Team manifest summary */
  teamSummary: {
    workerCount: number;
    parallelLanes: number;
    roles: OrchestratorWorkerRole[];
  };
  /** Recovery policy in effect */
  recoveryPolicy: RecoveryLoopPolicy;
  /** Integration PR plan */
  integrationPrPlan: IntegrationPrPolicy;
  /** Whether the preview matches the actual running plan */
  aligned: boolean;
  /** Drift details if re-planning occurred */
  driftNotes: string[];
};

export type ExecutionPlanPhase = {
  phase: string;
  enabled: boolean;
  stepCount: number;
  steps: ExecutionPlanStepPreview[];
  model: string;
  executorKind: OrchestratorExecutorKind;
  gatePolicy: string;
  recoveryEnabled: boolean;
};

export type ExecutionPlanStepPreview = {
  stepKey: string;
  title: string;
  role: OrchestratorWorkerRole;
  executorKind: OrchestratorExecutorKind;
  model: string;
  laneId: string | null;
  dependencies: string[];
  gateType: string | null;
  recoveryOnFailure: boolean;
};

/**
 * Slash command metadata for proper invocation.
 * Slash commands are translated to full prompts rather than
 * being passed raw via -p flag.
 */
export type SlashCommandStep = {
  command: string;
  /** Full prompt translation for the slash command */
  translatedPrompt: string;
  /** Whether this runs in interactive mode */
  interactive: boolean;
  /** Original raw command text */
  rawCommand: string;
};

/**
 * Maps known slash commands to their prompt translations.
 * This ensures slash commands work correctly when invoked
 * by the orchestrator via Claude CLI -p flag.
 */
// ── Usage Dashboard Types ────────────────────────────
export type UsageModelBreakdown = {
  provider: string;
  model: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costEstimateUsd: number;
};

export type UsageRecentSession = {
  id: string;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
  timestamp: string;
};

export type UsageActiveSession = {
  id: string;
  feature: string;
  provider: string;
  model: string;
  startedAt: string;
  elapsedMs: number;
};

export type UsageMissionBreakdown = {
  missionId: string;
  missionTitle: string;
  totalTokens: number;
  costEstimateUsd: number;
};

export type AggregatedUsageStats = {
  summary: {
    totalSessions: number;
    activeSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    totalCostEstimateUsd: number;
  };
  byModel: UsageModelBreakdown[];
  recentSessions: UsageRecentSession[];
  activeSessions: UsageActiveSession[];
  missionBreakdown: UsageMissionBreakdown[];
};

export type GetAggregatedUsageArgs = {
  since?: string | null;
  limit?: number;
  missionId?: string | null;
};

export const SLASH_COMMAND_TRANSLATIONS: Record<string, { prompt: string; interactive: boolean }> = {
  "/automate": {
    prompt: "Run the /automate skill. This means: analyze the current project state, identify work that needs to be done based on the mission context, and execute it autonomously using agent teams. Use the Skill tool to invoke the 'automate' skill if available, otherwise carry out the automation workflow directly.",
    interactive: false
  },
  "/finalize": {
    prompt: "Run the /finalize skill. This means: perform end-of-cycle documentation audit - scan the codebase, verify docs are up to date, update the implementation plan, and run local checks. Use the Skill tool to invoke the 'finalize' skill if available, otherwise carry out the finalization workflow directly.",
    interactive: false
  }
};
