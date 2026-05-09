// ---------------------------------------------------------------------------
// PR types
// ---------------------------------------------------------------------------

import type {
  ConflictFileType,
  ConflictResolverOriginSurface,
  ConflictResolverPermissionMode,
  ConflictRiskLevel,
  ExternalConflictResolverProvider,
} from "./conflicts";
import type { AgentChatPermissionMode } from "./chat";
import type { GitHubRepoRef } from "./git";
import type { RebaseTargetCommit } from "./lanes";

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
  /** "pr_target" (default): PR tracks upstream base; "lane_base": PR carries immutable lane base. */
  creationStrategy?: PrCreationStrategy | null;
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

export type PrReviewThreadComment = {
  id: string;
  author: string;
  authorAvatarUrl: string | null;
  body: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PrReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: "LEFT" | "RIGHT" | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  comments: PrReviewThreadComment[];
};

export type GitHubPrListItem = {
  id: string;
  scope: "repo" | "external";
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  githubUrl: string;
  title: string;
  state: PrState;
  isDraft: boolean;
  baseBranch: string | null;
  headBranch: string | null;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  linkedPrId: string | null;
  linkedGroupId: string | null;
  linkedLaneId: string | null;
  linkedLaneName: string | null;
  adeKind: "single" | "queue" | "integration" | null;
  workflowDisplayState: IntegrationWorkflowDisplayState | null;
  cleanupState: IntegrationCleanupState | null;
  labels: PrLabel[];
  isBot: boolean;
  commentCount: number;
};

export type GitHubPrSnapshot = {
  repo: GitHubRepoRef | null;
  viewerLogin: string | null;
  repoPullRequests: GitHubPrListItem[];
  externalPullRequests: GitHubPrListItem[];
  syncedAt: string;
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
      prTitle: string;
      repoOwner: string;
      repoName: string;
      baseBranch: string;
      headBranch: string;
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

export type PrCreationStrategy = "pr_target" | "lane_base";

export type CreatePrFromLaneArgs = {
  laneId: string;
  title: string;
  body: string;
  draft: boolean;
  baseBranch?: string;
  labels?: string[];
  reviewers?: string[];
  allowDirtyWorktree?: boolean;
  strategy?: PrCreationStrategy;
};

export type LinkPrToLaneArgs = {
  laneId: string;
  prUrlOrNumber: string;
};

export type DraftPrDescriptionArgs = {
  laneId: string;
  model?: string;
  reasoningEffort?: string | null;
  baseBranch?: string;
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

// --------------------------------
// PR Tab Enhancement (Phase 8+)
// --------------------------------

export type PrGroupType = "queue" | "integration";
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
  integrationLaneId: string | null;
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
  allowDirtyWorktree?: boolean;
};

export type CreateQueuePrsResult = {
  groupId: string;
  prs: PrSummary[];
  errors: Array<{ laneId: string; error: string }>;
};

export type CreateIntegrationPrArgs = {
  sourceLaneIds: string[];
  integrationLaneName: string;
  baseBranch: string;
  title: string;
  body?: string;
  draft?: boolean;
  allowDirtyWorktree?: boolean;
  /** When set, merges sources into this existing lane instead of creating a new child lane. */
  existingIntegrationLaneId?: string | null;
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
    conflictType?: ConflictFileType | null;
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
    conflictType?: ConflictFileType | null;
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

export type IntegrationLaneOrigin = "ade-created" | "adopted";
export type IntegrationWorkflowDisplayState = "active" | "history";
export type IntegrationCleanupState = "none" | "required" | "declined" | "completed";

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
  /** Preferred integration lane when none exists yet (merge sources here instead of a new lane). */
  preferredIntegrationLaneId?: string | null;
  /** Git HEAD of preferred merge-into lane at last simulation (for drift warnings). */
  mergeIntoHeadSha?: string | null;
  status: "proposed" | "committed";
  integrationLaneId?: string | null;
  integrationLaneOrigin?: IntegrationLaneOrigin | null;
  linkedGroupId?: string | null;
  linkedPrId?: string | null;
  workflowDisplayState?: IntegrationWorkflowDisplayState;
  cleanupState?: IntegrationCleanupState;
  closedAt?: string | null;
  mergedAt?: string | null;
  completedAt?: string | null;
  cleanupDeclinedAt?: string | null;
  cleanupCompletedAt?: string | null;
  resolutionState?: IntegrationResolutionState | null;
};

export type IntegrationLaneSnapshot = {
  headSha: string | null;
  dirty: boolean;
};

export type IntegrationLaneChangeStatus = "unchanged" | "changed" | "unknown" | "missing";

export type UpdateIntegrationProposalArgs = {
  proposalId: string;
  title?: string;
  body?: string;
  draft?: boolean;
  integrationLaneName?: string;
  preferredIntegrationLaneId?: string | null;
  /** When clearing preferred lane, also clears stored simulation HEAD (optional; omit to leave unchanged). */
  mergeIntoHeadSha?: string | null;
  /**
   * Clears integration_lane_id and resolution_state_json so the next prepare step can use a new or different lane.
   * Does not delete lanes in Git.
   */
  clearIntegrationBinding?: boolean;
};

export type ListIntegrationWorkflowsArgs = {
  view?: IntegrationWorkflowDisplayState | "all";
};

export type SimulateIntegrationArgs = {
  sourceLaneIds: string[];
  baseBranch: string;
  persist?: boolean;
  /**
   * When set, sequential merge preview starts at this lane's current HEAD and extra merge-tree checks run
   * (integration head vs each source). Child-vs-child pairwise simulation still uses `baseBranch` as the merge base.
   */
  mergeIntoLaneId?: string | null;
};

export type CommitIntegrationArgs = {
  proposalId: string;
  integrationLaneName: string;
  title: string;
  body?: string;
  draft?: boolean;
  pauseOnConflict?: boolean;
  allowDirtyWorktree?: boolean;
  /** Override stored preference; omit to use the proposal row. */
  preferredIntegrationLaneId?: string | null;
};

export type IntegrationStepResolution = "pending" | "merged-clean" | "resolving" | "resolved" | "failed";

export type IntegrationResolutionState = {
  integrationLaneId: string;
  stepResolutions: Record<string, IntegrationStepResolution>; // keyed by laneId
  activeWorkerStepId: string | null;
  activeLaneId: string | null;
  createdSnapshot?: IntegrationLaneSnapshot | null;
  currentSnapshot?: IntegrationLaneSnapshot | null;
  laneChangeStatus?: IntegrationLaneChangeStatus;
  updatedAt: string;
};

export type DeleteIntegrationProposalArgs = {
  proposalId: string;
  deleteIntegrationLane?: boolean;
};

export type DeleteIntegrationProposalResult = {
  proposalId: string;
  integrationLaneId: string | null;
  deletedIntegrationLane: boolean;
};

export type DismissIntegrationCleanupArgs = {
  proposalId: string;
};

export type CleanupIntegrationWorkflowArgs = {
  proposalId: string;
  archiveIntegrationLane?: boolean;
  archiveSourceLaneIds?: string[];
};

export type CleanupIntegrationWorkflowResult = {
  proposalId: string;
  archivedLaneIds: string[];
  skippedLaneIds: string[];
  workflowDisplayState: IntegrationWorkflowDisplayState;
  cleanupState: IntegrationCleanupState;
};

export type CreateIntegrationLaneForProposalArgs = {
  proposalId: string;
  allowDirtyWorktree?: boolean;
};

export type CreateIntegrationLaneForProposalResult = {
  integrationLaneId: string;
  mergedCleanLanes: string[];
  conflictingLanes: string[];
};

export type StartIntegrationResolutionArgs = {
  proposalId: string;
  laneId: string; // the conflicting source lane to resolve
};

export type StartIntegrationResolutionResult = {
  conflictFiles: string[];
  mergedClean: boolean;
  integrationLaneId: string;
};

export type AiPermissionMode = "read_only" | "guarded_edit" | "full_edit";
export type PrAgentPermissionMode = AiPermissionMode | AgentChatPermissionMode;

export type PrAiResolutionContext = {
  sourceTab: "rebase" | "normal" | "integration" | "queue" | "conflicts";
  sourceLaneId?: string | null;
  sourceLaneIds?: string[];
  targetLaneId?: string | null;
  proposalId?: string | null;
  integrationLaneId?: string | null;
  laneId?: string | null;
  scenario?: "single-merge" | "sequential-merge" | "integration-merge";
};

export type PrAiResolutionSessionStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export type PrAiResolutionSessionInfo = {
  contextKey: string;
  sessionId: string;
  provider: "codex" | "claude";
  model: string | null;
  modelId: string | null;
  reasoning: string | null;
  permissionMode: PrAgentPermissionMode | null;
  context: PrAiResolutionContext;
  status: PrAiResolutionSessionStatus;
};

export type PrAiResolutionStartArgs = {
  context: PrAiResolutionContext;
  model: string;
  reasoning?: string | null;
  permissionMode?: PrAgentPermissionMode;
  /** Appended to the generated resolver prompt (integration, merge conflicts, etc.). */
  additionalInstructions?: string | null;
};

export type PrAiResolutionStartResult = {
  sessionId: string;
  provider: "codex" | "claude";
  ptyId: string | null;
  status: "started" | "failed";
  error: string | null;
  context: PrAiResolutionContext;
};

export type PrAiResolutionInputArgs = {
  sessionId: string;
  text: string;
};

export type PrAiResolutionStopArgs = {
  sessionId: string;
};

export type PrAiResolutionEventPayload = {
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  message: string | null;
  timestamp: string;
};

export type PrAiResolutionGetSessionArgs = {
  context: PrAiResolutionContext;
};

export type PrAiResolutionGetSessionResult = PrAiResolutionSessionInfo | null;

export type PrIssueResolutionScope = "checks" | "comments" | "both";

export type PrIssueResolutionStartArgs = {
  prId: string;
  scope: PrIssueResolutionScope;
  modelId: string;
  reasoning?: string | null;
  permissionMode?: PrAgentPermissionMode;
  additionalInstructions?: string | null;
};

export type PrIssueResolutionStartResult = {
  sessionId: string;
  laneId: string;
  href: string;
};

export type PrIssueResolutionPromptPreviewArgs = PrIssueResolutionStartArgs;

export type PrIssueResolutionPromptPreviewResult = {
  title: string;
  prompt: string;
};

export type RebaseResolutionStartArgs = {
  laneId: string;
  modelId: string;
  reasoning?: string | null;
  permissionMode?: PrAgentPermissionMode;
  forcePushAfterRebase?: boolean;
};

export type RebaseResolutionStartResult = {
  sessionId: string;
  laneId: string;
  href: string;
};

export type ReplyToPrReviewThreadArgs = {
  prId: string;
  threadId: string;
  body: string;
};

export type ResolvePrReviewThreadArgs = {
  prId: string;
  threadId: string;
};

export function normalizePrAiResolutionContext(context: PrAiResolutionContext): PrAiResolutionContext {
  const sourceLaneId = context.sourceLaneId?.trim() || null;

  const sourceLaneIdSet = new Set(
    (context.sourceLaneIds ?? []).map((v) => v.trim()).filter(Boolean),
  );
  if (sourceLaneId) sourceLaneIdSet.add(sourceLaneId);
  const sourceLaneIds = Array.from(sourceLaneIdSet).sort((a, b) => a.localeCompare(b));

  const targetLaneId = context.targetLaneId?.trim() || null;
  const proposalId = context.proposalId?.trim() || null;
  const integrationLaneId = context.integrationLaneId?.trim() || null;
  const laneId = context.laneId?.trim() || null;

  return {
    sourceTab: context.sourceTab,
    ...(sourceLaneId ? { sourceLaneId } : {}),
    ...(sourceLaneIds.length ? { sourceLaneIds } : {}),
    ...(targetLaneId ? { targetLaneId } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(integrationLaneId ? { integrationLaneId } : {}),
    ...(laneId ? { laneId } : {}),
    ...(context.scenario ? { scenario: context.scenario } : {}),
  };
}

export function buildPrAiResolutionContextKey(context: PrAiResolutionContext): string {
  const normalized = normalizePrAiResolutionContext(context);
  return JSON.stringify({
    sourceTab: normalized.sourceTab,
    sourceLaneId: normalized.sourceLaneId ?? null,
    sourceLaneIds: normalized.sourceLaneIds ?? [],
    targetLaneId: normalized.targetLaneId ?? null,
    proposalId: normalized.proposalId ?? null,
    integrationLaneId: normalized.integrationLaneId ?? null,
    laneId: normalized.laneId ?? null,
    scenario: normalized.scenario ?? null,
  });
}

export type RecheckIntegrationStepArgs = {
  proposalId: string;
  laneId: string;
};

export type RecheckIntegrationStepResult = {
  resolution: IntegrationStepResolution;
  remainingConflictFiles: string[];
  allResolved: boolean;
  message: string | null;
};

// --------------------------------
// Rebase Types (shared with conflicts)
// --------------------------------

export type RebaseNeed = {
  laneId: string;
  laneName: string;
  kind: "lane_base" | "pr_target";
  baseBranch: string;
  behindBy: number;
  conflictPredicted: boolean;
  conflictingFiles: string[];
  prId: string | null;
  groupContext: string | null;
  dismissedAt: string | null;
  deferredUntil: string | null;
};

// --------------------------------
// Queue / Integration State Types
// --------------------------------

export type QueueEntryState = "pending" | "landing" | "rebasing" | "resolving" | "landed" | "failed" | "paused" | "skipped";
export type QueueState = "idle" | "landing" | "paused" | "completed" | "cancelled";
export type IntegrationFlowState = "proposal" | "creating" | "merging" | "conflict" | "resolving" | "completed" | "failed";
export type QueueWaitReason =
  | "ci"
  | "review"
  | "merge_conflict"
  | "resolver_failed"
  | "merge_blocked"
  | "manual"
  | "canceled";

/**
 * Stack-wide config that the new Queue applies to every PR in the stack via
 * the convergence engine.
 *
 * The legacy fields (`autoResolve`, `resolverProvider`, `resolverModel`,
 * `reasoningEffort`, `permissionMode`, `confidenceThreshold`) are retained as
 * deprecated mirrors so existing call sites (iOS sync, RPC layer, older UI)
 * keep compiling while consumers migrate. The new authoritative source is the
 * embedded {@link PipelineSettings} on `pipeline`. A queue with
 * `pipeline.conflictStrategy === "auto"` reproduces the legacy auto-resolve
 * behavior — plus the full PtM loop on each PR.
 */
export type QueueAutomationConfig = {
  method: MergeMethod;
  archiveLane: boolean;
  /** Whether to pause the stack land when CI is failing or reviews are pending. */
  ciGating: boolean;
  /** Stack-wide PtM/convergence settings applied to every queued PR. */
  pipeline: PipelineSettings;
  /** Origin surface (telemetry/attribution) for the auto-resolver agent. */
  originSurface: ConflictResolverOriginSurface;
  originMissionId: string | null;
  originRunId: string | null;
  originLabel: string | null;
  /** @deprecated Mirrors `pipeline.conflictStrategy === "auto"`. */
  autoResolve: boolean;
  /** @deprecated Mirrors `pipeline.autoAgentSettings.provider`. */
  resolverProvider: ExternalConflictResolverProvider | null;
  /** @deprecated Mirrors `pipeline.autoAgentSettings.model`. */
  resolverModel: string | null;
  /** @deprecated Mirrors `pipeline.autoAgentSettings.reasoningEffort`. */
  reasoningEffort: string | null;
  /** @deprecated Mirrors `pipeline.autoAgentSettings.permissionMode`. */
  permissionMode: ConflictResolverPermissionMode | null;
  /** @deprecated Mirrors `pipeline.autoAgentSettings.confidenceThreshold`. */
  confidenceThreshold: number | null;
};

export type StartQueueAutomationArgs = {
  groupId: string;
  method: MergeMethod;
  archiveLane?: boolean;
  ciGating?: boolean;
  pipeline?: PipelineSettings;
  originSurface?: ConflictResolverOriginSurface;
  originMissionId?: string | null;
  originRunId?: string | null;
  originLabel?: string | null;
  /** @deprecated Use `pipeline.conflictStrategy = "auto"` instead. */
  autoResolve?: boolean;
  /** @deprecated Use `pipeline.autoAgentSettings.provider`. */
  resolverProvider?: ExternalConflictResolverProvider | null;
  /** @deprecated Use `pipeline.autoAgentSettings.model`. */
  resolverModel?: string | null;
  /** @deprecated Use `pipeline.autoAgentSettings.reasoningEffort`. */
  reasoningEffort?: string | null;
  /** @deprecated Use `pipeline.autoAgentSettings.permissionMode`. */
  permissionMode?: ConflictResolverPermissionMode | null;
  /** @deprecated Use `pipeline.autoAgentSettings.confidenceThreshold`. */
  confidenceThreshold?: number | null;
};

export type ResumeQueueAutomationArgs = {
  queueId: string;
  method?: MergeMethod;
  archiveLane?: boolean;
  ciGating?: boolean;
  pipeline?: PipelineSettings;
  originSurface?: ConflictResolverOriginSurface;
  originMissionId?: string | null;
  originRunId?: string | null;
  originLabel?: string | null;
  /** @deprecated Use `pipeline.conflictStrategy = "auto"` instead. */
  autoResolve?: boolean;
  /** @deprecated Use `pipeline.autoAgentSettings.provider`. */
  resolverProvider?: ExternalConflictResolverProvider | null;
  /** @deprecated Use `pipeline.autoAgentSettings.model`. */
  resolverModel?: string | null;
  /** @deprecated Use `pipeline.autoAgentSettings.reasoningEffort`. */
  reasoningEffort?: string | null;
  /** @deprecated Use `pipeline.autoAgentSettings.permissionMode`. */
  permissionMode?: ConflictResolverPermissionMode | null;
  /** @deprecated Use `pipeline.autoAgentSettings.confidenceThreshold`. */
  confidenceThreshold?: number | null;
};

/**
 * Builds a {@link PipelineSettings} from the legacy auto-resolve fields on
 * a {@link QueueAutomationConfig} (or its Args variants). Used by the runtime
 * when an older caller hasn't supplied an explicit `pipeline`.
 */
export function pipelineFromLegacyQueueConfig(
  legacy: Partial<{
    autoResolve: boolean | null | undefined;
    resolverProvider: ExternalConflictResolverProvider | null | undefined;
    resolverModel: string | null | undefined;
    reasoningEffort: string | null | undefined;
    permissionMode: ConflictResolverPermissionMode | null | undefined;
    confidenceThreshold: number | null | undefined;
  }>,
): PipelineSettings {
  const isAuto = legacy.autoResolve === true;
  const provider = legacy.resolverProvider ?? null;
  const agentProvider: AutoConflictAgentProvider | null = provider === "claude" || provider === "codex" ? provider : null;
  return {
    ...DEFAULT_PIPELINE_SETTINGS,
    conflictStrategy: isAuto ? "auto" : "pause",
    autoAgentSettings: {
      provider: agentProvider,
      model: legacy.resolverModel ?? null,
      reasoningEffort: legacy.reasoningEffort ?? null,
      permissionMode: legacy.permissionMode ?? null,
      confidenceThreshold: legacy.confidenceThreshold ?? null,
    },
  };
}

export type PauseQueueAutomationArgs = {
  queueId: string;
};

export type CancelQueueAutomationArgs = {
  queueId: string;
};

export type LandQueueNextArgs = {
  groupId: string;
  method: MergeMethod;
  archiveLane?: boolean;
  /**
   * Optional one-shot pipeline override for the single PR being landed. When
   * omitted, the queue's stack-wide pipeline config is used.
   */
  pipeline?: PipelineSettings;
};

export type ReorderQueuePrsArgs = {
  groupId: string;
  prIds: string[];
};

export type QueueLandingEntry = {
  prId: string;
  laneId: string;
  laneName: string;
  position: number;
  state: QueueEntryState;
  prNumber?: number | null;
  githubUrl?: string | null;
  resolvedByAi?: boolean;
  resolverRunId?: string | null;
  mergeCommitSha?: string | null;
  waitingOn?: QueueWaitReason | null;
  updatedAt?: string | null;
  error?: string;
};

export type QueueLandingState = {
  queueId: string;
  groupId: string;
  groupName: string | null;
  targetBranch: string | null;
  state: QueueState;
  entries: QueueLandingEntry[];
  currentPosition: number;
  activePrId: string | null;
  activeResolverRunId: string | null;
  lastError: string | null;
  waitReason: QueueWaitReason | null;
  config: QueueAutomationConfig;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
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

/** Controls how deep the orchestrator goes with PR lifecycle management. Never merges — enforced at orchestrator level. */
export type PrDepth =
  | "propose-only"       // Create PR proposals/drafts, flag conflicts but don't resolve
  | "resolve-conflicts"  // Also resolve conflicts via orchestrator workers
  | "open-and-comment";  // Also open the PR and add review summary comments

export type PrStrategy =
  | { kind: "integration"; targetBranch?: string; draft?: boolean; prDepth?: PrDepth }
  | { kind: "per-lane"; targetBranch?: string; draft?: boolean; prDepth?: PrDepth }
  | {
      kind: "queue";
      targetBranch?: string;
      draft?: boolean;
      autoRebase?: boolean;
      ciGating?: boolean;
      prDepth?: PrDepth;
      autoLand?: boolean;
      autoResolveConflicts?: boolean;
      archiveLaneOnLand?: boolean;
      mergeMethod?: MergeMethod;
      conflictResolverModel?: string;
      reasoningEffort?: string;
      permissionMode?: ConflictResolverPermissionMode;
    }
  | { kind: "manual" };

// --------------------------------
// PR Detail Overhaul Types
// --------------------------------

/** Full PR detail fetched from GitHub API with body, labels, assignees, etc. */
export type PrDetail = {
  prId: string;
  body: string | null;
  labels: PrLabel[];
  assignees: PrUser[];
  requestedReviewers: PrUser[];
  author: PrUser;
  isDraft: boolean;
  milestone: string | null;
  linkedIssues: Array<{ number: number; title: string; state: string }>;
};

export type PrLabel = {
  name: string;
  color: string;
  description: string | null;
};

export type PrUser = {
  login: string;
  avatarUrl: string | null;
};

/** A changed file in a PR with patch/diff data. */
export type PrFile = {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied";
  additions: number;
  deletions: number;
  patch: string | null;
  previousFilename: string | null;
};

export type PrReviewSnapshot = PrSummary & {
  baseSha: string | null;
  headSha: string | null;
  files: PrFile[];
};

/** A commit on the PR head branch. `checkStatus` aggregates per-commit check runs when available. */
export type PrCommit = {
  sha: string;
  shortSha: string;
  message: string;
  author: {
    login: string | null;
    name: string;
    email: string | null;
  };
  committedDate: string;
  checkStatus?: "success" | "failure" | "pending" | "none";
};

/** GitHub Actions workflow run. */
export type PrActionRun = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  headSha: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  jobs: PrActionJob[];
};

export type PrActionJob = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: PrActionStep[];
};

export type PrActionStep = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
};

/** Unified activity event for the PR timeline. */
export type PrActivityEvent = {
  id: string;
  type: "comment" | "review" | "commit" | "label" | "ci_run" | "state_change" | "review_request" | "deployment" | "force_push";
  author: string;
  avatarUrl: string | null;
  body: string | null;
  timestamp: string;
  metadata: Record<string, unknown>;
};

// Args types for new PR actions

export type AddPrCommentArgs = {
  prId: string;
  body: string;
  inReplyToCommentId?: string;
};

export type UpdatePrTitleArgs = {
  prId: string;
  title: string;
};

export type UpdatePrBodyArgs = {
  prId: string;
  body: string;
};

export type SetPrLabelsArgs = {
  prId: string;
  labels: string[];
};

export type RequestPrReviewersArgs = {
  prId: string;
  reviewers: string[];
};

export type SubmitPrReviewArgs = {
  prId: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body?: string;
  comments?: Array<{
    path: string;
    body: string;
    position: number;
  }>;
};

export type SubmitPrReviewResult = {
  id: string | null;
  nodeId: string | null;
  htmlUrl: string | null;
  state: string | null;
  submittedAt: string | null;
};

export type ClosePrArgs = {
  prId: string;
};

export type ReopenPrArgs = {
  prId: string;
};

export type RerunPrChecksArgs = {
  prId: string;
  checkRunIds?: number[];
};

export type AiReviewSummaryArgs = {
  prId: string;
  model?: string;
};

export type AiReviewSummary = {
  summary: string;
  potentialIssues: string[];
  recommendations: string[];
  mergeReadiness: "ready" | "needs_work" | "blocked";
};

// --------------------------------
// Pipeline Settings (auto-converge / auto-merge)
// --------------------------------

/** Merge method for the auto-merge pipeline — extends MergeMethod with repo_default. */
export type PipelineMergeMethod = MergeMethod | "repo_default";

export type LaneWorktreeLockOwnerKind =
  | "path_to_merge"
  | "pr_issue_resolution"
  | "conflict_resolution"
  | "integration_resolution"
  | "git_mutation";

export type LaneWorktreeLockInfo = {
  worktreeKey: string;
  worktreePath: string;
  laneId: string;
  ownerKind: LaneWorktreeLockOwnerKind;
  ownerPrId: string | null;
  ownerSessionId: string | null;
  ownerProposalId: string | null;
  ownerLabel: string;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
};

export type LaneWorktreeLockBlocker = {
  message: string;
  lock: LaneWorktreeLockInfo;
};

/**
 * Legacy two-option rebase policy. Retained for back-compat reads from older
 * `pr_pipeline_settings` rows; new writes use {@link ConflictStrategy}.
 */
export type RebasePolicy = "pause" | "auto_rebase";

/**
 * What the convergence loop does when the PR's base branch advances or a merge
 * conflict surfaces.
 *
 * - `pause`  — stop the loop and surface the conflict to the operator
 * - `rebase` — `git rebase origin/<base>`, force-push with `--force-with-lease`
 * - `merge`  — merge `origin/<base>` into the PR branch, push the merge commit
 * - `auto`   — let the conflict-resolver agent decide rebase vs merge based on
 *              context, then resolve any resulting conflict markers itself
 */
export type ConflictStrategy = "pause" | "rebase" | "merge" | "auto";

/**
 * @deprecated Replaced by {@link AtCapPolicy}. Kept for legacy reads only.
 */
export type ForceFinalizeMode = "off" | "unconditional" | "conditional";

/**
 * What the convergence loop does when it hits {@link PipelineSettings.maxRounds}
 * without the PR being mergeable yet.
 *
 * - `stop`           — pause and wait for the user to decide.
 * - `wait_for_ci`    — stop iterating but keep polling CI for up to
 *                      {@link PipelineSettings.atCapWaitMinutes}; merge if it
 *                      goes green within that window, else pause.
 * - `ci_retry_once`  — dispatch one more fix iteration scoped to CI failures
 *                      only; merge if CI is green afterward, else pause.
 * - `ci_retry_loop`  — dispatch up to {@link PipelineSettings.atCapCiRetryMax}
 *                      additional CI-only iterations; merge as soon as CI goes
 *                      green; pause if exhausted.
 * - `force_merge`    — skip retries and run the merge ladder immediately
 *                      (rest → admin → auto), ignoring CI / review.
 *
 * Migration from the legacy {@link ForceFinalizeMode}: `off → stop`,
 * `conditional → ci_retry_once`, `unconditional → force_merge`.
 */
export type AtCapPolicy =
  | "stop"
  | "wait_for_ci"
  | "ci_retry_once"
  | "ci_retry_loop"
  | "force_merge";

export function atCapPolicyFromLegacy(mode: ForceFinalizeMode): AtCapPolicy {
  if (mode === "off") return "stop";
  if (mode === "unconditional") return "force_merge";
  return "ci_retry_once";
}

/**
 * Provider used by the {@link ConflictStrategy} `auto` agent and (legacy) by
 * the queue's standalone `autoResolve` flow. Mirrors
 * {@link ExternalConflictResolverProvider} but lives on PipelineSettings so
 * each PR's convergence can target its own provider.
 */
export type AutoConflictAgentProvider = "claude" | "codex";

export type AutoConflictAgentSettings = {
  provider: AutoConflictAgentProvider | null;
  /** Fully-qualified model id (e.g. `anthropic/claude-3-5-sonnet`). `null` = provider default. */
  model: string | null;
  /** Reasoning token budget hint (provider-specific string). */
  reasoningEffort: string | null;
  /** Permission mode the resolver chat runs under. */
  permissionMode: PrAgentPermissionMode | null;
  /** Minimum confidence (0–1) the resolver must report before its fix is accepted. `null` = accept all. */
  confidenceThreshold: number | null;
};

export const DEFAULT_AUTO_CONFLICT_AGENT_SETTINGS: AutoConflictAgentSettings = {
  provider: null,
  model: null,
  reasoningEffort: null,
  permissionMode: null,
  confidenceThreshold: null,
};

export type PipelineSettings = {
  /** When true, PtM merges the PR as soon as it converges (or hits the early-green gate). */
  autoMerge: boolean;
  mergeMethod: PipelineMergeMethod;
  /**
   * Hard cap on normal iterations before the loop either gives up or runs the
   * force-finalize bonus iteration (per {@link forceFinalizeMode}). Same as the
   * legacy `maxRounds` semantically — kept under that name for back-compat.
   */
  maxRounds: number;
  /** @deprecated Read-only mirror of the legacy two-option rebase policy. New code reads `conflictStrategy`. */
  onRebaseNeeded: RebasePolicy;
  /** Strategy for both base-advance sync (between iterations) and merge-time conflicts. */
  conflictStrategy: ConflictStrategy;
  /** Tunables used when {@link conflictStrategy} is `auto`. */
  autoAgentSettings: AutoConflictAgentSettings;
  /** @deprecated Mirror of {@link atCapPolicy} for legacy callers. New code reads `atCapPolicy`. */
  forceFinalizeMode: ForceFinalizeMode;
  /** @deprecated Folded into the `ci_retry_once` semantics of {@link atCapPolicy}. */
  forceFinalizeRequireNoCiFailures: boolean;
  /** What the loop does when it hits {@link maxRounds} without converging. */
  atCapPolicy: AtCapPolicy;
  /**
   * When {@link atCapPolicy} is `wait_for_ci`, how long (in minutes) to keep
   * polling CI before pausing. Default 30. Ignored for other policies.
   */
  atCapWaitMinutes: number;
  /**
   * When {@link atCapPolicy} is `ci_retry_loop`, the maximum number of bonus
   * CI-only iterations the loop will dispatch. Default 3. Ignored for other
   * policies.
   */
  atCapCiRetryMax: number;
  /**
   * If true, switching {@link atCapPolicy} to `force_merge` requires explicit
   * UI confirmation each time it's enabled. Default true.
   */
  forceMergeRequiresConfirmation: boolean;
  /**
   * If true (default), every iteration first checks whether checks are green
   * and reviews are clean — if so, the merge ladder runs immediately instead
   * of dispatching another fix round.
   */
  earlyMergeOnGreen: boolean;
};

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  autoMerge: true,
  mergeMethod: "repo_default",
  maxRounds: 5,
  onRebaseNeeded: "pause",
  conflictStrategy: "pause",
  autoAgentSettings: { ...DEFAULT_AUTO_CONFLICT_AGENT_SETTINGS },
  forceFinalizeMode: "conditional",
  forceFinalizeRequireNoCiFailures: true,
  atCapPolicy: "ci_retry_once",
  atCapWaitMinutes: 30,
  atCapCiRetryMax: 3,
  forceMergeRequiresConfirmation: true,
  earlyMergeOnGreen: true,
};

/**
 * Maps the legacy {@link RebasePolicy} (`pause` | `auto_rebase`) to the new
 * 4-option {@link ConflictStrategy}. Used when reading older settings rows.
 */
export function conflictStrategyFromLegacyRebasePolicy(policy: RebasePolicy): ConflictStrategy {
  return policy === "auto_rebase" ? "rebase" : "pause";
}

/**
 * Inverse of {@link conflictStrategyFromLegacyRebasePolicy}: lossy projection
 * of the new strategy onto the legacy two-option field, so old code paths that
 * still read `onRebaseNeeded` keep working. `merge` and `auto` both project to
 * `auto_rebase` because they imply automatic conflict handling.
 */
export function legacyRebasePolicyFromConflictStrategy(strategy: ConflictStrategy): RebasePolicy {
  return strategy === "pause" ? "pause" : "auto_rebase";
}

// --------------------------------
// PR Convergence Runtime State
// --------------------------------

export type ConvergenceRuntimeStatus =
  | "idle"
  | "launching"
  | "running"
  | "polling"
  | "paused"
  | "converged"
  | "merged"
  | "failed"
  | "cancelled"
  | "stopped";

export type ConvergencePollerStatus =
  | "idle"
  | "scheduled"
  | "polling"
  | "waiting_for_checks"
  | "waiting_for_comments"
  | "paused"
  | "stopped";

export type ConvergenceRuntimeState = {
  prId: string;
  autoConvergeEnabled: boolean;
  /** True when the native Path to Merge orchestrator owns this runtime. */
  pathToMergeActive: boolean;
  status: ConvergenceRuntimeStatus;
  pollerStatus: ConvergencePollerStatus;
  currentRound: number;
  activeSessionId: string | null;
  activeLaneId: string | null;
  activeHref: string | null;
  pauseReason: string | null;
  errorMessage: string | null;
  forceFinalizeUsed: boolean;
  ciRetryAttemptsUsed: number;
  waitForCiStartedAt: string | null;
  lastDispatchHeadSha: string | null;
  pauseRepeatCount: number;
  lastPauseReasonHash: string | null;
  lastStartedAt: string | null;
  lastPolledAt: string | null;
  lastPausedAt: string | null;
  lastStoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrConvergenceState = ConvergenceRuntimeState;
export type PrConvergenceStatePatch = Partial<Omit<ConvergenceRuntimeState, "prId" | "pathToMergeActive" | "createdAt" | "updatedAt">>;

export type PathToMergeStartResult = {
  prId: string;
  scheduled: boolean;
  runtime: ConvergenceRuntimeState;
  blockedBy?: LaneWorktreeLockBlocker | null;
};

export type PathToMergeStopResult = {
  prId: string;
  stopped: boolean;
  runtime: ConvergenceRuntimeState | null;
};

// --------------------------------
// Issue Inventory (PR Convergence Loop)
// --------------------------------

export type IssueInventoryState = "new" | "sent_to_agent" | "fixed" | "dismissed" | "escalated";

// Well-known sources kept for backwards-compat; any other string is also valid
// (e.g. "greptile", "seer", "sonarqube") — detectSource() auto-extracts bot names.
export type IssueSource = "coderabbit" | "codex" | "copilot" | "human" | "ade" | "greptile" | "seer" | "bot" | "unknown" | (string & {});

export type IssueInventoryItem = {
  id: string;
  prId: string;
  source: IssueSource;
  type: "review_thread" | "check_failure" | "issue_comment";
  externalId: string;
  state: IssueInventoryState;
  round: number;
  filePath: string | null;
  line: number | null;
  severity: "critical" | "major" | "minor" | null;
  headline: string;
  body: string | null;
  author: string | null;
  url: string | null;
  dismissReason: string | null;
  agentSessionId: string | null;
  threadCommentCount?: number | null;
  threadLatestCommentId?: string | null;
  threadLatestCommentAuthor?: string | null;
  threadLatestCommentAt?: string | null;
  threadLatestCommentSource?: IssueSource | null;
  createdAt: string;
  updatedAt: string;
};

export type ConvergenceRoundStat = {
  round: number;
  newCount: number;
  fixedCount: number;
  dismissedCount: number;
};

export type ConvergenceStatus = {
  currentRound: number;
  maxRounds: number;
  issuesPerRound: ConvergenceRoundStat[];
  totalNew: number;
  totalFixed: number;
  totalDismissed: number;
  totalEscalated: number;
  totalSentToAgent: number;
  isConverging: boolean;
  canAutoAdvance: boolean;
};

export const DEFAULT_CONVERGENCE_RUNTIME_STATE: Omit<ConvergenceRuntimeState, "prId"> = {
  autoConvergeEnabled: false,
  pathToMergeActive: false,
  status: "idle",
  pollerStatus: "idle",
  currentRound: 0,
  activeSessionId: null,
  activeLaneId: null,
  activeHref: null,
  pauseReason: null,
  errorMessage: null,
  forceFinalizeUsed: false,
  ciRetryAttemptsUsed: 0,
  waitForCiStartedAt: null,
  lastDispatchHeadSha: null,
  pauseRepeatCount: 0,
  lastPauseReasonHash: null,
  lastStartedAt: null,
  lastPolledAt: null,
  lastPausedAt: null,
  lastStoppedAt: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

export type IssueInventorySnapshot = {
  prId: string;
  items: IssueInventoryItem[];
  convergence: ConvergenceStatus;
  runtime: ConvergenceRuntimeState;
};

// ---------------------------------------------------------------------------
// PRs Tab — Timeline + Rails redesign (new)
// ---------------------------------------------------------------------------

export type PrDeploymentState =
  | "pending"
  | "in_progress"
  | "queued"
  | "success"
  | "failure"
  | "error"
  | "inactive"
  | "unknown";

export type PrDeployment = {
  id: string;
  environment: string;
  state: PrDeploymentState;
  description: string | null;
  /** The environment URL exposed by GitHub (public preview link, when available). */
  environmentUrl: string | null;
  /** GitHub log URL for the latest status update. */
  logUrl: string | null;
  sha: string | null;
  ref: string | null;
  creator: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PrTimelineEventBase = {
  id: string;
  timestamp: string;
  author: string | null;
  avatarUrl: string | null;
};

export type PrTimelineEvent =
  | (PrTimelineEventBase & {
      type: "description";
      body: string | null;
    })
  | (PrTimelineEventBase & {
      type: "commit_push";
      sha: string;
      shortSha: string;
      subject: string;
      commitCount: number;
      forcePushed: boolean;
    })
  | (PrTimelineEventBase & {
      type: "review";
      reviewId: string;
      state: "pending" | "approved" | "changes_requested" | "commented" | "dismissed";
      body: string | null;
      isBot: boolean;
    })
  | (PrTimelineEventBase & {
      type: "review_thread";
      threadId: string;
      path: string | null;
      line: number | null;
      startLine: number | null;
      isResolved: boolean;
      isOutdated: boolean;
      commentCount: number;
      firstCommentBody: string | null;
    })
  | (PrTimelineEventBase & {
      type: "issue_comment";
      commentId: string;
      body: string | null;
      isBot: boolean;
    })
  | (PrTimelineEventBase & {
      type: "check_update";
      checkName: string;
      status: "queued" | "in_progress" | "completed";
      conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
      detailsUrl: string | null;
    })
  | (PrTimelineEventBase & {
      type: "deployment";
      deploymentId: string;
      environment: string;
      state: PrDeploymentState;
      environmentUrl: string | null;
    })
  | (PrTimelineEventBase & {
      type: "label_change";
      action: "added" | "removed";
      label: string;
      color: string | null;
    })
  | (PrTimelineEventBase & {
      type: "merge";
      mergeCommitSha: string | null;
      method: MergeMethod | null;
    });

export type PrTimelineEventType = PrTimelineEvent["type"];

/** AI-generated summary of a PR. Cached per (prId, headSha). */
export type PrAiSummary = {
  prId: string;
  summary: string;
  riskAreas: string[];
  reviewerHotspots: string[];
  unresolvedConcerns: string[];
  generatedAt: string;
  headSha: string;
};

export type PrReviewThreadReaction = {
  id: string;
  content: PrReactionContent;
  user: string;
};

export type PrReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export type PostPrReviewCommentArgs = {
  prId: string;
  threadId: string;
  body: string;
};

export type SetPrReviewThreadResolvedArgs = {
  prId: string;
  threadId: string;
  resolved: boolean;
};

export type SetPrReviewThreadResolvedResult = {
  threadId: string;
  isResolved: boolean;
};

export type ReactToPrCommentArgs = {
  prId: string;
  commentId: string;
  content: PrReactionContent;
};

export type LaunchPrIssueResolutionFromThreadArgs = {
  prId: string;
  threadId: string;
  commentId?: string | null;
  modelId?: string | null;
  reasoning?: string | null;
  permissionMode?: PrAgentPermissionMode;
  additionalInstructions?: string | null;
  fileContext?: {
    path: string | null;
    line?: number | null;
    startLine?: number | null;
  } | null;
};

export type LaunchPrIssueResolutionFromThreadResult = PrIssueResolutionStartResult;

// ---------------------------------------------------------------------------
// Mobile PR snapshot (additive — consumed by iOS PRs tab)
//
// All mobile-focused fields are collected into a single snapshot so the
// iOS PRs surface can render stack visibility, create-PR eligibility,
// workflow cards (queue/integration/rebase), and per-PR action gates
// from one command. Desktop consumers are not affected; existing PR
// contracts remain the source of truth.
// ---------------------------------------------------------------------------

/** Role of a PR member inside a stack (lane chain). */
export type PrStackMemberRole = "root" | "middle" | "leaf";

/** Single lane/PR inside a PR stack. */
export type PrStackMember = {
  laneId: string;
  laneName: string;
  parentLaneId: string | null;
  depth: number;
  role: PrStackMemberRole;
  dirty: boolean;
  /** Null when the lane has no PR yet. */
  prId: string | null;
  prNumber: number | null;
  prState: PrState | null;
  prTitle: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  checksStatus: PrChecksStatus | null;
  reviewStatus: PrReviewStatus | null;
};

/** An ordered lane chain that contains at least one PR. */
export type PrStackInfo = {
  stackId: string;
  rootLaneId: string;
  members: PrStackMember[];
  size: number;
  prCount: number;
};

/** Per-PR action availability. Actions are live-only unless otherwise noted. */
export type PrActionCapabilities = {
  prId: string;
  canOpenInGithub: boolean;
  canMerge: boolean;
  canClose: boolean;
  canReopen: boolean;
  canRequestReviewers: boolean;
  canRerunChecks: boolean;
  canComment: boolean;
  canUpdateDescription: boolean;
  canDelete: boolean;
  /** Reason the PR cannot be merged right now. Null when merge is allowed. */
  mergeBlockedReason: string | null;
  /** True when any live-only action is offered — lets mobile gate in offline mode. */
  requiresLive: boolean;
};

export type CleanupPrBranchArgs = {
  prId: string;
  deleteLocalBranch?: boolean;
  deleteRemoteBranch?: boolean;
  remoteName?: string;
};

export type CleanupPrBranchResult = {
  prId: string;
  branchName: string;
  localDeleted: boolean;
  remoteDeleted: boolean;
  localError: string | null;
  remoteError: string | null;
};

/** A single lane eligible for PR creation from the mobile "Create PR" surface. */
export type PrCreateLaneEligibility = {
  laneId: string;
  laneName: string;
  parentLaneId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  defaultBaseBranch: string;
  defaultTitle: string;
  dirty: boolean;
  /**
   * Commits on this lane branch not present on `defaultBaseBranch` (merge-base diff).
   * Lets mobile show "already pushed, open PR" when the worktree is clean but ahead.
   */
  commitsAheadOfBase: number;
  hasExistingPr: boolean;
  canCreate: boolean;
  /** Why creation is not allowed. Null when canCreate is true. */
  blockedReason: string | null;
};

/** Mobile create-PR capabilities for the whole project. */
export type PrCreateCapabilities = {
  /** True when at least one lane is eligible right now. */
  canCreateAny: boolean;
  defaultBaseBranch: string | null;
  lanes: PrCreateLaneEligibility[];
};

/** Workflow card rendered on the mobile PRs surface. */
export type PrWorkflowCardKind = "queue" | "integration" | "rebase";

export type PrQueueWorkflowCard = {
  kind: "queue";
  id: string;
  queueId: string;
  groupId: string;
  groupName: string | null;
  targetBranch: string | null;
  state: QueueState;
  activePrId: string | null;
  currentPosition: number;
  totalEntries: number;
  entries: QueueLandingEntry[];
  waitReason: QueueWaitReason | null;
  lastError: string | null;
  updatedAt: string;
};

export type PrIntegrationWorkflowCard = {
  kind: "integration";
  id: string;
  proposalId: string;
  title: string | null;
  baseBranch: string;
  overallOutcome: "clean" | "conflict" | "blocked";
  status: "proposed" | "committed";
  laneCount: number;
  conflictLaneCount: number;
  lanes: Array<{
    laneId: string;
    laneName: string;
    outcome: "clean" | "conflict" | "blocked";
  }>;
  workflowDisplayState: IntegrationWorkflowDisplayState;
  cleanupState: IntegrationCleanupState;
  linkedPrId: string | null;
  integrationLaneId: string | null;
  preferredIntegrationLaneId?: string | null;
  mergeIntoHeadSha?: string | null;
  integrationLaneOrigin?: IntegrationLaneOrigin | null;
  createdAt: string;
};

export type PrRebaseWorkflowCard = {
  kind: "rebase";
  id: string;
  laneId: string;
  laneName: string;
  baseBranch: string;
  behindBy: number;
  conflictPredicted: boolean;
  prId: string | null;
  prNumber: number | null;
  /** Null when the suggestion has not been dismissed. */
  dismissedAt: string | null;
  /** Null when the suggestion has not been deferred. */
  deferredUntil: string | null;
  /** Commits the rebase would pull in. Undefined when unavailable or computed by an older host. */
  targetCommits?: RebaseTargetCommit[];
  /**
   * Rebase mode for the lane's most-recent open/draft PR. "auto" means drift
   * can be fixed by auto-rebase (`pr_target` strategy or no linked PR);
   * "manual" means the PR carries an immutable base (`lane_base` strategy) so
   * drift must be surfaced and rebased manually. Undefined on older hosts
   * (treat as "auto").
   */
  rebaseMode?: "auto" | "manual";
  /**
   * The stored `creation_strategy` for the lane's most-recent open/draft PR,
   * or null when no PR is linked. Lets the client render strategy-specific
   * copy without re-deriving the mode.
   */
  creationStrategy?: PrCreationStrategy | null;
};

export type PrWorkflowCard =
  | PrQueueWorkflowCard
  | PrIntegrationWorkflowCard
  | PrRebaseWorkflowCard;

/**
 * One-shot mobile snapshot that aggregates the data the iOS PRs tab
 * needs to render list, detail, workflow cards, stack visibility, and
 * per-PR capability gates in a single payload.
 */
export type PrMobileSnapshot = {
  generatedAt: string;
  prs: PrSummary[];
  stacks: PrStackInfo[];
  capabilities: Record<string, PrActionCapabilities>;
  createCapabilities: PrCreateCapabilities;
  workflowCards: PrWorkflowCard[];
  /** Mobile clients should surface a "host offline" banner when this is false. */
  live: boolean;
};
