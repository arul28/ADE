// ---------------------------------------------------------------------------
// Orchestrator types
// ---------------------------------------------------------------------------

import type { ModelId } from "./core";
import type { ModelConfig } from "./models";
import type { PrDepth, QueueWaitReason } from "./prs";
import type { MissionDetail, MissionStepHandoff } from "./missions";
import type {
  OrchestratorContextProfileId,
  PackDeltaDigestV1,
} from "./packs";

// ---------------------------------------------------------------------------
// Metadata type aliases
// ---------------------------------------------------------------------------

/** Metadata stored on orchestrator run/step/attempt rows. Known keys:
 *  integrationStage, mergeMode, sourceLaneIds, targetLaneId, prId, etc. */
export type OrchestratorMetadata = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fan-out types — used by the meta-reasoner and orchestrator fan-out logic
// ---------------------------------------------------------------------------

/** Decision returned by the meta-reasoner for fan-out dispatch. */
export type FanOutDecision = {
  strategy: "inline" | "internal_parallel" | "external_parallel" | "hybrid";
  subtasks: Array<{
    title: string;
    instructions: string;
    files: string[];
    complexity: "trivial" | "simple" | "moderate" | "complex";
    estimatedTokens?: number;
  }>;
  reasoning: string;
  clusters?: Array<{
    subtaskIndices: number[];
    reason: string;
  }>;
};

/** Emitted when the coordinator mutates the mission DAG. Streamed to UI for reactive updates. */
export type DagMutationEvent = {
  runId: string;
  mutation:
    | { type: "step_added"; step: OrchestratorStep }
    | { type: "step_skipped"; stepKey: string; reason: string }
    | { type: "steps_merged"; sourceKeys: string[]; targetStep: OrchestratorStep }
    | { type: "step_split"; sourceKey: string; children: OrchestratorStep[] }
    | { type: "dependency_changed"; stepKey: string; newDeps: string[] }
    | { type: "status_changed"; stepKey: string; newStatus: string };
  timestamp: string;
  source: "coordinator" | "system" | "user";
};

export type OrchestratorRunStatus =
  | "queued"
  | "bootstrapping"
  | "active"
  | "paused"
  | "completing"
  | "succeeded"
  | "failed"
  | "canceled";

/** New task-level status for team-based claiming and tracking */
export type OrchestratorTaskStatus =
  | "pending"
  | "ready"
  | "claimed"
  | "running"
  | "blocked"
  | "done"
  | "canceled";

export type OrchestratorStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "superseded"
  | "canceled";

export type OrchestratorAttemptStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled";

export type OrchestratorJoinPolicy = "all_success" | "any_success" | "quorum" | "advisory";

// Built-in executor kinds. Third-party adapters can register any string.
export type OrchestratorExecutorKind = "unified" | "shell" | "manual" | (string & {});

export type OrchestratorErrorClass =
  | "none"
  | "transient"
  | "deterministic"
  | "policy"
  | "claim_conflict"
  | "executor_failure"
  | "canceled"
  | "resume_recovered";

export type OrchestratorClaimScope = "lane" | "file" | "env" | "task";

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
  modelId?: ModelId;
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

// ---------------------------------------------------------------------------
// Team Runtime Types — agent-team-based orchestration
// ---------------------------------------------------------------------------

export type OrchestratorTeamMemberRole = "coordinator" | "teammate" | "worker";

export type OrchestratorTeamMemberStatus =
  | "spawning"
  | "active"
  | "idle"
  | "completing"
  | "terminated"
  | "failed";

export type OrchestratorTeamMemberSource =
  | "ade-worker"
  | "ade-subagent"
  | "claude-native";

export type OrchestratorTeamMember = {
  id: string;
  runId: string;
  missionId: string;
  provider: string;
  model: string;
  role: OrchestratorTeamMemberRole;
  source: OrchestratorTeamMemberSource;
  parentWorkerId?: string | null;
  sessionId: string | null;
  status: OrchestratorTeamMemberStatus;
  claimedTaskIds: string[];
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type OrchestratorTeamRuntimePhase =
  | "bootstrapping"
  | "planning"
  | "executing"
  | "completing"
  | "done"
  | "failed";

export type OrchestratorTeamRuntimeState = {
  runId: string;
  phase: OrchestratorTeamRuntimePhase;
  completionRequested: boolean;
  completionValidated: boolean;
  lastValidationError: string | null;
  coordinatorSessionId: string | null;
  teammateIds: string[];
  createdAt: string;
  updatedAt: string;
};

/** Team runtime config for mission launch */
export type TeamRuntimeConfig = {
  enabled: boolean;
  targetProvider: "claude" | "codex" | "auto";
  teammateCount: number;
  /** Coordinator may use parallel workers/teammates when true. */
  allowParallelAgents?: boolean;
  /** Coordinator/workers may delegate to nested sub-agents when true. */
  allowSubAgents?: boolean;
  /** Enable Claude-native agent teams bridge when running Claude CLI workers. */
  allowClaudeAgentTeams?: boolean;
  template?: TeamTemplate;
  toolProfiles?: Record<string, RoleToolProfile>;
  mcpServerAllowlist?: string[];
  policyOverrides?: MissionPolicyFlags;
};

export type MissionPolicyFlags = {
  clarificationMode?: "always" | "auto_if_uncertain" | "off";
  maxClarificationQuestions?: number;
  strictTdd?: boolean;
  requireValidatorPass?: boolean;
  maxParallelWorkers?: number;
  riskApprovalMode?: "auto" | "confirm_high_risk" | "confirm_all";
};

export type RoleToolProfile = {
  allowedTools: string[];
  blockedTools?: string[];
  mcpServers?: string[];
  notes?: string;
};

export type RoleDefinition = {
  name: string;
  description: string;
  capabilities: string[];
  maxInstances?: number;
  toolProfile?: RoleToolProfile;
};

export type TeamTemplate = {
  id: string;
  name: string;
  roles: RoleDefinition[];
  policyDefaults: MissionPolicyFlags;
  constraints: {
    maxWorkers: number;
    requiredRoles: string[];
  };
};

export type ValidationContract = {
  level: "step" | "milestone" | "mission";
  tier: "self" | "dedicated";
  required: boolean;
  criteria: string;
  evidence: string[];
  maxRetries: number;
};

export type ValidationFinding = {
  code: string;
  severity: "low" | "medium" | "high";
  message: string;
  remediation?: string;
  references?: string[];
};

export type ValidationResultReport = {
  validationId: string;
  scope: {
    runId: string;
    stepId?: string | null;
    stepKey?: string | null;
    missionId: string;
    laneId?: string | null;
  };
  contract: ValidationContract;
  verdict: "pass" | "fail";
  summary: string;
  findings: ValidationFinding[];
  remediationInstructions: string[];
  retriesUsed: number;
  createdAt: string;
  validatorWorkerId?: string | null;
};

export type WorkerStatusReport = {
  workerId: string;
  stepId?: string | null;
  stepKey?: string | null;
  runId: string;
  missionId: string;
  progressPct: number;
  blockers: string[];
  confidence: number | null;
  nextAction: string;
  laneId?: string | null;
  details?: string | null;
  reportedAt: string;
};

export type WorkerResultReport = {
  workerId: string;
  stepId?: string | null;
  stepKey?: string | null;
  runId: string;
  missionId: string;
  outcome: "succeeded" | "failed" | "partial";
  summary: string;
  artifacts: Array<{ type: string; title: string; uri?: string | null; metadata?: Record<string, unknown> }>;
  filesChanged: string[];
  testsRun: {
    command?: string;
    passed?: number;
    failed?: number;
    skipped?: number;
    raw?: string | null;
  } | null;
  laneId?: string | null;
  reportedAt: string;
};

export type MissionStateProgress = {
  currentPhase: string;
  completedSteps: number;
  totalSteps: number;
  activeWorkers: string[];
  blockedSteps: string[];
  failedSteps: string[];
};

export type MissionStateStepOutcome = {
  stepKey: string;
  stepName: string;
  phase: string;
  status: "succeeded" | "failed" | "skipped" | "in_progress";
  summary: string;
  filesChanged: string[];
  testsRun?: { passed: number; failed: number; skipped: number };
  validation?: {
    verdict: "pass" | "fail" | null;
    findings: string[];
  };
  warnings: string[];
  completedAt: string | null;
};

export type MissionStateStepOutcomePartial = Partial<Omit<MissionStateStepOutcome, "stepKey">> & {
  testsRun?: Partial<NonNullable<MissionStateStepOutcome["testsRun"]>>;
  validation?: {
    verdict?: "pass" | "fail" | null;
    findings?: string[];
  };
};

export type MissionStateDecision = {
  timestamp: string;
  decision: string;
  rationale: string;
  context: string;
};

export type MissionStateIssue = {
  id: string;
  severity: "low" | "medium" | "high";
  description: string;
  affectedSteps: string[];
  status: "open" | "mitigated" | "resolved";
};

export type MissionStatePendingIntervention = {
  id: string;
  type: string;
  title: string;
  createdAt: string;
};

export type ReflectionSignalType = "wish" | "frustration" | "idea" | "pattern" | "limitation";

export type OrchestratorReflectionEntry = {
  id: string;
  projectId: string;
  missionId: string;
  runId: string;
  stepId: string | null;
  attemptId: string | null;
  agentRole: string;
  phase: string;
  signalType: ReflectionSignalType;
  observation: string;
  recommendation: string;
  context: string;
  occurredAt: string;
  createdAt: string;
  schemaVersion: 1;
};

export type MissionRetrospective = {
  id: string;
  missionId: string;
  runId: string;
  generatedAt: string;
  schemaVersion: 1;
  finalStatus: OrchestratorRunStatus;
  wins: string[];
  failures: string[];
  unresolvedRisks: string[];
  followUpActions: string[];
  topPainPoints: string[];
  topImprovements: string[];
  patternsToCapture: string[];
  estimatedImpact: string;
  changelog: Array<{
    previousPainPoint: string;
    status: "resolved" | "still_open" | "worsened";
    currentState: string;
    fixApplied?: string;
    sourceRetrospectiveId?: string;
    sourceMissionId?: string;
    sourceRunId?: string;
    previousPainScore?: number;
    currentPainScore?: number;
  }>;
};

export type OrchestratorRetrospectiveTrend = {
  id: string;
  projectId: string;
  missionId: string;
  runId: string;
  retrospectiveId: string;
  sourceMissionId: string;
  sourceRunId: string;
  sourceRetrospectiveId: string;
  painPointKey: string;
  painPointLabel: string;
  status: "resolved" | "still_open" | "worsened";
  previousPainScore: number;
  currentPainScore: number;
  createdAt: string;
};

export type OrchestratorRetrospectivePatternStat = {
  id: string;
  projectId: string;
  patternKey: string;
  patternLabel: string;
  occurrenceCount: number;
  firstSeenRetrospectiveId: string;
  firstSeenRunId: string;
  lastSeenRetrospectiveId: string;
  lastSeenRunId: string;
  promotedMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MissionCloseoutRequirementKey =
  | "planning_document"
  | "research_summary"
  | "changed_files_summary"
  | "test_report"
  | "implementation_summary"
  | "validation_verdict"
  | "screenshot"
  | "browser_verification"
  | "browser_trace"
  | "video_recording"
  | "console_logs"
  | "risk_notes"
  | "pr_url"
  | "proposal_url"
  | "review_summary"
  | "final_outcome_summary";

export type MissionCloseoutRequirementStatus =
  | "present"
  | "missing"
  | "incomplete"
  | "waived"
  | "blocked_by_capability";

export type MissionCloseoutRequirement = {
  key: MissionCloseoutRequirementKey;
  label: string;
  required: boolean;
  status: MissionCloseoutRequirementStatus;
  detail: string | null;
  artifactId: string | null;
  uri: string | null;
  source: "declared" | "discovered" | "runtime" | "waiver";
};

export type MissionFinalizationPolicyKind = "disabled" | "manual" | "integration" | "per-lane" | "queue";

export type MissionFinalizationStatus =
  | "idle"
  | "finalizing"
  | "creating_pr"
  | "rehearsing_queue"
  | "landing_queue"
  | "resolving_integration_conflicts"
  | "resolving_queue_conflicts"
  | "waiting_for_green"
  | "awaiting_operator_review"
  | "posting_review_comment"
  | "finalization_failed"
  | "completed";

export type MissionFinalizationPolicy = {
  kind: MissionFinalizationPolicyKind;
  targetBranch: string | null;
  draft: boolean | null;
  prDepth: PrDepth | null;
  autoRebase: boolean | null;
  ciGating: boolean | null;
  autoLand: boolean | null;
  rehearseQueue: boolean | null;
  autoResolveConflicts: boolean | null;
  archiveLaneOnLand: boolean | null;
  mergeMethod: "merge" | "squash" | "rebase" | null;
  conflictResolverModel: string | null;
  reasoningEffort: string | null;
  description: string | null;
};

export type MissionFinalizationState = {
  policy: MissionFinalizationPolicy;
  status: MissionFinalizationStatus;
  executionComplete: boolean;
  contractSatisfied: boolean;
  blocked: boolean;
  blockedReason: string | null;
  summary: string | null;
  detail: string | null;
  resolverJobId: string | null;
  integrationLaneId: string | null;
  queueGroupId: string | null;
  queueId: string | null;
  queueRehearsalId: string | null;
  scratchLaneId: string | null;
  activePrId: string | null;
  waitReason: QueueWaitReason | null;
  proposalUrl: string | null;
  prUrls: string[];
  reviewStatus: string | null;
  mergeReadiness: string | null;
  requirements: MissionCloseoutRequirement[];
  warnings: string[];
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type MissionCoordinatorAvailability = {
  available: boolean;
  mode: "offline" | "consult_only" | "continuation_required";
  summary: string;
  detail: string | null;
  updatedAt: string;
};

export type MissionStateDocument = {
  schemaVersion: 1;
  missionId: string;
  runId: string;
  goal: string;
  updatedAt: string;
  progress: MissionStateProgress;
  stepOutcomes: MissionStateStepOutcome[];
  decisions: MissionStateDecision[];
  activeIssues: MissionStateIssue[];
  modifiedFiles: string[];
  pendingInterventions: MissionStatePendingIntervention[];
  finalization?: MissionFinalizationState | null;
  coordinatorAvailability?: MissionCoordinatorAvailability | null;
  reflections?: OrchestratorReflectionEntry[];
  latestRetrospective?: MissionRetrospective | null;
};

export type MissionStateDocumentPatch = {
  addStepOutcome?: MissionStateStepOutcome;
  updateStepOutcome?: {
    stepKey: string;
    updates: MissionStateStepOutcomePartial;
  };
  addDecision?: MissionStateDecision;
  addIssue?: MissionStateIssue;
  resolveIssue?: { id: string; resolution: string };
  updateProgress?: Partial<MissionStateProgress>;
  pendingInterventions?: MissionStatePendingIntervention[];
  finalization?: MissionFinalizationState | null;
  coordinatorAvailability?: MissionCoordinatorAvailability | null;
  reflections?: OrchestratorReflectionEntry[];
  latestRetrospective?: MissionRetrospective | null;
};

export type GetMissionStateDocumentArgs = {
  runId: string;
};

export type ListOrchestratorArtifactsArgs = {
  missionId?: string;
  runId?: string | null;
  stepId?: string | null;
};

export type ListOrchestratorWorkerCheckpointsArgs = {
  missionId?: string;
  runId?: string | null;
  stepId?: string | null;
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
  | "intervention_resolved"
  | "coordinator_steering"
  | "coordinator_broadcast"
  | "coordinator_skip"
  | "coordinator_add_step"
  | "coordinator_pause"
  | "coordinator_parallelize"
  | "coordinator_consolidate"
  | "coordinator_shutdown"
  | "step_dependencies_updated"
  | "step_metadata_updated"
  | "fan_out_dispatched"
  | "fan_out_complete"
  | "worker_status_report"
  | "worker_result_report"
  | "worker_message"
  | "plan_revised"
  | "lane_transfer"
  | "validation_report"
  | "validation_contract_unfulfilled"
  | "validation_self_check_reminder"
  | "validation_auto_spawned"
  | "validation_gate_blocked"
  | "reflection_added"
  | "retrospective_generated"
  | "tool_profiles_updated";

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

export type PauseOrchestratorRunArgs = {
  runId: string;
  reason?: string;
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

// ─────────────────────────────────────────────────────
// Worker Lifecycle & Budget
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

export type GetTeamMembersArgs = {
  runId: string;
};

export type GetTeamRuntimeStateArgs = {
  runId: string;
};

export type FinalizeRunArgs = {
  runId: string;
  force?: boolean;
};

export type FinalizeRunResult = {
  finalized: boolean;
  blockers: string[];
  finalStatus: OrchestratorRunStatus;
};

export type OrchestratorPlannerProvider = "claude" | "codex" | "deterministic" | (string & {});

export type StartMissionRunWithAIArgs = {
  missionId: string;
  runMode?: "autopilot" | "manual";
  autopilotOwnerId?: string;
  defaultExecutorKind?: OrchestratorExecutorKind;
  defaultRetryLimit?: number;
  metadata?: Record<string, unknown> | null;
  plannerProvider?: OrchestratorPlannerProvider;
  defaultModelId?: ModelId;
  /** Team runtime configuration */
  teamRuntime?: TeamRuntimeConfig;
};

export type StartMissionRunWithAIResult = {
  started: { run: OrchestratorRun; steps: OrchestratorStep[] } | null;
  mission: MissionDetail | null;
};

// ─────────────────────────────────────────────────────
// Completion Diagnostics
// ─────────────────────────────────────────────────────

export type CompletionDiagnostic = {
  phase: string;
  code:
    | "phase_required_missing"
    | "phase_skipped_by_policy"
    | "phase_in_progress"
    | "phase_failed"
    | "phase_completed_without_success"
    | "phase_terminal_without_success"
    | "phase_succeeded"
    | "required_validation_missing";
  message: string;
  blocking: boolean;
  details?: Record<string, unknown>;
};

export type RunCompletionBlocker = {
  code: "running_attempts" | "claimed_tasks" | "unresolved_interventions" | "completion_not_requested" | "validation_failed";
  message: string;
  detail?: Record<string, unknown>;
};

export type RunCompletionValidation = {
  canComplete: boolean;
  blockers: RunCompletionBlocker[];
  validatedAt: string;
};

export type RunCompletionEvaluation = {
  status: OrchestratorRunStatus;
  diagnostics: CompletionDiagnostic[];
  riskFactors: string[];
  completionReady: boolean;
  validation?: RunCompletionValidation;
};

// ─────────────────────────────────────────────────────
// Role Isolation, Team Synthesis, Recovery Loops,
// Context Brokerage, Execution Plan Preview
// ─────────────────────────────────────────────────────

export type OrchestratorWorkerRole =
  | "planning"
  | "implementation"
  | "testing"
  | "code_review"
  | "test_review"
  | "integration";

export type RoleIsolationRule = {
  /** Roles that cannot coexist in the same worker session */
  mutuallyExclusive: [OrchestratorWorkerRole, OrchestratorWorkerRole];
  /** Whether to auto-correct (split) or hard-reject invalid plans */
  enforcement: "auto_correct" | "reject";
  /** Human-readable reason for the isolation rule */
  reason: string;
};

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

export type TeamManifest = {
  runId: string;
  missionId: string;
  synthesizedAt: string;
  rationale: string;
  complexity: TeamComplexityAssessment;
  workers: Array<{
    workerId: string;
    role: OrchestratorWorkerRole;
    assignedStepKeys: string[];
    laneId: string | null;
    executorKind: OrchestratorExecutorKind;
    model?: string;
  }>;
  parallelismCap: number;
  parallelLanes: string[][];
  decisionLog: Array<{
    timestamp: string;
    decision: string;
    reason: string;
    source: "policy" | "complexity" | "prompt" | "dag_shape" | "override";
  }>;
};

export type TeamComplexityAssessment = {
  domain: "frontend" | "backend" | "fullstack" | "infra" | "mixed";
  estimatedScope: "small" | "medium" | "large" | "very_large";
  parallelizable: boolean;
  requiresIntegration: boolean;
  fileZoneCount: number;
  thoroughnessRequested: boolean;
};

export type RecoveryLoopPolicy = {
  enabled: boolean;
  maxIterations: number;
  onExhaustion: "fail" | "intervention" | "complete_with_risk";
  minConfidenceDelta?: number;
  escalateAfterStagnant?: number;
};

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

export type RecoveryDiagnosisTier = "transient" | "semantic" | "blocker";

export type RecoveryDiagnosis = {
  tier: RecoveryDiagnosisTier;
  classification: string;
  adjustedHint: string | null;
  peerNotification: string | null;
  suggestedModel: string | null;
  diagnosedAt: string;
};

export type RecoveryLoopState = {
  runId: string;
  iterations: RecoveryLoopIteration[];
  currentIteration: number;
  exhausted: boolean;
  stopReason: string | null;
};

export type OrchestratorContextView = "implementation" | "review" | "test_review";

export type ContextViewPolicy = {
  view: OrchestratorContextView;
  readOnly: boolean;
  includeScratchContext: boolean;
  includeArtifacts: boolean;
  includeCheckResults: boolean;
  includeHandoffSummaries: boolean;
  diffMode: "full" | "summary" | "none";
};

export type IntegrationPrPolicy = {
  enabled: boolean;
  createIntegrationLane: boolean;
  prDepth: PrDepth;
  draft: boolean;
  baseBranch?: string;
  conflictResolverModel?: string;
};

export type ExecutionPlanPreview = {
  runId: string;
  missionId: string;
  generatedAt: string;
  strategy: string;
  phases: ExecutionPlanPhase[];
  teamSummary: {
    workerCount: number;
    parallelLanes: number;
    roles: OrchestratorWorkerRole[];
  };
  recoveryPolicy: RecoveryLoopPolicy;
  integrationPrPlan: IntegrationPrPolicy;
  aligned: boolean;
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

// ─────────────────────────────────────────────────────
// Orchestrator Chat / Messaging
// ─────────────────────────────────────────────────────

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

export type OrchestratorChatThreadType = "coordinator" | "teammate" | "worker";

export type OrchestratorChatVisibilityMode = "full" | "digest_only" | "metadata_only";

export type OrchestratorChatDeliveryState = "queued" | "delivered" | "failed";

export type OrchestratorChatTarget =
  | {
      kind: "coordinator";
      runId?: string | null;
    }
  | {
      kind: "teammate";
      runId?: string | null;
      teamMemberId?: string | null;
      sessionId?: string | null;
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
  visibilityMode?: OrchestratorChatVisibilityMode;
  metadata?: Record<string, unknown> | null;
} & (
  | {
      threadId: string;
      target?: OrchestratorChatTarget | null;
    }
  | {
      threadId?: string | null;
      target: OrchestratorChatTarget;
    }
);

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

export type CoordinatorCheckpoint = {
  version: number;
  runId: string;
  missionId: string;
  conversationSummary: string;
  lastEventTimestamp: string | null;
  turnCount: number;
  compactionCount: number;
  savedAt: string;
};

export type GetOrchestratorContextCheckpointArgs = {
  missionId: string;
  checkpointId?: string;
};

/** A worker recovery checkpoint persisted to DB from `.ade-checkpoint-{stepKey}.md` files. */
export type OrchestratorWorkerCheckpoint = {
  id: string;
  missionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  stepKey: string;
  content: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
};

export type OrchestratorPromptLayerSource =
  | "system_owned"
  | "mission_goal"
  | "phase_snapshot"
  | "step_runtime"
  | "runtime_overlay"
  | "user_steering"
  | "runtime_context";

export type OrchestratorPromptSourceKind =
  | "default_template"
  | "mission_override"
  | "run_snapshot"
  | "live_effective_prompt"
  | "system_owned";

export type OrchestratorPromptLayer = {
  id: string;
  label: string;
  source: OrchestratorPromptLayerSource;
  sourceKind: OrchestratorPromptSourceKind;
  editable: boolean;
  text: string;
  description?: string | null;
};

export type GetOrchestratorPromptInspectorArgs = {
  runId: string;
  target: "coordinator" | "worker";
  stepId?: string | null;
};

export type OrchestratorPromptInspector = {
  target: "coordinator" | "worker";
  runId: string;
  missionId: string;
  stepId: string | null;
  phaseKey: string | null;
  phaseName: string | null;
  title: string;
  notes: string[];
  layers: OrchestratorPromptLayer[];
  fullPrompt: string;
};

export type OrchestratorArtifactKind = "file" | "branch" | "pr" | "test_report" | "checkpoint" | "custom";

export type OrchestratorArtifact = {
  id: string;
  missionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  artifactKey: string;
  kind: OrchestratorArtifactKind;
  value: string;
  metadata: Record<string, unknown>;
  declared: boolean;
  createdAt: string;
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

// ── Inter-agent messaging types ──

export type GetGlobalChatArgs = {
  missionId: string;
  since?: string | null;
  limit?: number;
};

export type DeliverMessageArgs = {
  missionId: string;
  targetAttemptId: string;
  content: string;
  priority?: "normal" | "urgent";
  fromAttemptId?: string | null;
};

export type GetActiveAgentsArgs = {
  missionId: string;
};

export type ActiveAgentInfo = {
  attemptId: string;
  stepId: string;
  stepKey: string | null;
  runId: string;
  sessionId: string | null;
  state: OrchestratorWorkerStatus;
  executorKind: OrchestratorExecutorKind;
};
