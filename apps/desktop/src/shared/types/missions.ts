// ---------------------------------------------------------------------------
// Mission types
// ---------------------------------------------------------------------------

import type { ModelConfig, MissionModelConfig } from "./models";
import type { PrStrategy } from "./prs";
import type { OrchestratorExecutorKind, TeamRuntimeConfig, RecoveryLoopPolicy, IntegrationPrPolicy } from "./orchestrator";
import type { AiCliPermissionMode, AiCliSandboxPermissions, AiInProcessPermissionMode } from "./config";
import type { AgentChatPermissionMode } from "./chat";

/** @deprecated Use MissionProviderPermissions instead. Kept for backward compat with stored missions. */
export type MissionCliPermissionMode = AiCliPermissionMode;
/** @deprecated Use MissionProviderPermissions instead. Kept for backward compat with stored missions. */
export type MissionCliSandboxPermissions = AiCliSandboxPermissions;
/** @deprecated Use MissionProviderPermissions instead. Kept for backward compat with stored missions. */
export type MissionInProcessPermissionMode = AiInProcessPermissionMode;

/** Per-provider permission mode — mirrors chat pane semantics (AgentChatPermissionMode). */
export type MissionProviderPermissions = {
  /** Permission mode for Claude CLI workers */
  claude?: AgentChatPermissionMode;
  /** Permission mode for Codex CLI workers */
  codex?: AgentChatPermissionMode;
  /** Permission mode for API/unified model workers */
  unified?: AgentChatPermissionMode;
  /** Codex sandbox level (only relevant for codex) */
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Additional writable paths for CLI workers */
  writablePaths?: string[];
  /** Allowed tools for Claude CLI workers */
  allowedTools?: string[];
};

export type MissionPermissionConfig = {
  /** @deprecated Old CLI-class shape. Kept for backward compat with stored missions. */
  cli?: {
    mode?: MissionCliPermissionMode;
    sandboxPermissions?: MissionCliSandboxPermissions;
    writablePaths?: string[];
    allowedTools?: string[];
  };
  /** @deprecated Old in-process shape. Kept for backward compat with stored missions. */
  inProcess?: {
    mode?: MissionInProcessPermissionMode;
  };
  /** New per-provider permission shape. Takes precedence over cli/inProcess when present. */
  providers?: MissionProviderPermissions;
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
  | "failed_step"
  | "orchestrator_escalation"
  | "budget_limit_reached"
  | "provider_unreachable"
  | "unrecoverable_error";

export type MissionInterventionStatus = "open" | "resolved" | "dismissed";

export type MissionPlannerEngine = "auto" | "claude_cli" | "codex_cli";


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

export type PlannerTaskType = "analysis" | "code" | "integration" | "test" | "review" | "merge" | "deploy" | "docs" | "milestone";

export type PlannerExecutorHint = "unified" | "manual" | "either";

export type PlannerPreferredScope = "lane" | "file" | "session" | "global";

export type PlannerContextProfileRequirement = "deterministic" | "deterministic_plus_narrative";

export type PlannerClaimLane = "analysis" | "backend" | "frontend" | "integration" | "conflict";

export type PlannerJoinPolicy = "all_success" | "any_success" | "quorum";

export type PlannerClarifyingQuestion = {
  question: string;
  context?: string;
  defaultAssumption?: string;
  impact?: string;
};

export type PlannerClarifyingAnswer = {
  questionIndex: number;
  question: string;
  answer: string;
  context?: string;
  defaultAssumption?: string;
  impact?: string;
  source: "user" | "default_assumption";
  answeredAt: string;
};

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
  clarifyingQuestions?: PlannerClarifyingQuestion[];
  clarifyingAnswers?: PlannerClarifyingAnswer[];
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

export type MissionPhaseValidationTier = "none" | "self" | "dedicated";

export type PhaseCardOrderingConstraints = {
  mustBeFirst?: boolean;
  mustBeLast?: boolean;
  mustFollow?: string[];
  mustPrecede?: string[];
  canLoop?: boolean;
  loopTarget?: string | null;
};

export type PhaseCardBudget = {
  maxTokens?: number;
  maxTimeMs?: number;
  maxSteps?: number;
};

export type PhaseCardAskQuestions = {
  enabled: boolean;
  mode: "always" | "auto_if_uncertain" | "never";
  maxQuestions?: number;
};

export type PhaseCardValidationGate = {
  tier: MissionPhaseValidationTier;
  required: boolean;
  criteria?: string;
};

export type PhaseCard = {
  id: string;
  phaseKey: string;
  name: string;
  description: string;
  instructions: string;
  model: ModelConfig;
  budget: PhaseCardBudget;
  orderingConstraints: PhaseCardOrderingConstraints;
  askQuestions: PhaseCardAskQuestions;
  validationGate: PhaseCardValidationGate;
  isBuiltIn: boolean;
  isCustom: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type PhaseProfile = {
  id: string;
  name: string;
  description: string;
  phases: PhaseCard[];
  isBuiltIn: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MissionPhaseOverride = {
  id: string;
  missionId: string;
  profileId: string | null;
  phases: PhaseCard[];
  createdAt: string;
  updatedAt: string;
};

export type MissionPhaseConfiguration = {
  profile: PhaseProfile | null;
  override: MissionPhaseOverride | null;
  selectedPhases: PhaseCard[];
};

export type MissionDashboardSnapshot = {
  active: Array<{
    mission: MissionSummary;
    phaseName: string | null;
    phaseProgress: {
      completed: number;
      total: number;
      pct: number;
    };
    activeWorkers: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
  }>;
  recent: Array<{
    mission: MissionSummary;
    durationMs: number;
    costEstimateUsd: number | null;
    action: "view" | "rerun" | "retry" | "resume";
  }>;
  weekly: {
    missions: number;
    successRate: number;
    avgDurationMs: number;
    totalCostUsd: number;
  };
};

export type ListPhaseProfilesArgs = {
  includeArchived?: boolean;
};

export type SavePhaseProfileArgs = {
  profile: {
    id?: string;
    name: string;
    description?: string;
    phases: PhaseCard[];
    isDefault?: boolean;
  };
};

export type DeletePhaseProfileArgs = {
  profileId: string;
};

export type ClonePhaseProfileArgs = {
  profileId: string;
  name?: string;
};

export type ExportPhaseProfileArgs = {
  profileId: string;
};

export type ExportPhaseProfileResult = {
  profile: PhaseProfile;
  savedPath: string | null;
};

export type ImportPhaseProfileArgs = {
  filePath: string;
  setAsDefault?: boolean;
};

/** Metadata stored on mission step rows. Known keys:
 *  instructions, missionGoal, laneId, etc. */
export type MissionStepMetadata = Record<string, unknown>;

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
  phaseConfiguration?: MissionPhaseConfiguration | null;
};

export type MissionAgentRuntimeConfig = {
  /** Allow coordinator/planner to use multiple workers in parallel. */
  allowParallelAgents: boolean;
  /** Allow workers to spawn nested/sub-agents where supported by provider runtime. */
  allowSubAgents: boolean;
  /** Allow Claude-native agent teams (for Claude CLI runtimes). */
  allowClaudeAgentTeams: boolean;
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
  planningTimeoutMs?: number;
  allowPlanningQuestions?: boolean;
  autostart?: boolean;
  launchMode?: "autopilot" | "manual";
  autopilotExecutor?: OrchestratorExecutorKind;
  executionPolicy?: Partial<MissionExecutionPolicy>;
  /** Mission-level recovery settings (replaces executionPolicy fields) */
  recoveryLoop?: RecoveryLoopPolicy;
  modelConfig?: MissionModelConfig;
  /** Team runtime configuration for agent-team orchestration */
  teamRuntime?: TeamRuntimeConfig;
  /** Agent runtime capabilities/preferences passed to planner + coordinator. */
  agentRuntime?: MissionAgentRuntimeConfig;
  /** Optional phase profile selection for launch */
  phaseProfileId?: string | null;
  /** Optional mission-scoped phase override sequence */
  phaseOverride?: PhaseCard[];
  /** Per-provider worker permission overrides for this mission */
  permissionConfig?: MissionPermissionConfig;
};

export type MissionPreflightCheckId =
  | "models"
  | "permissions"
  | "worktrees"
  | "phase_structural"
  | "phase_ordering"
  | "phase_semantic"
  | "budget";

export type MissionPreflightSeverity = "pass" | "warning" | "fail";

export type MissionPreflightChecklistItem = {
  id: MissionPreflightCheckId;
  severity: MissionPreflightSeverity;
  title: string;
  summary: string;
  details: string[];
  fixHint?: string;
};

export type MissionPreflightPhaseEstimate = {
  phaseKey: string;
  phaseName: string;
  estimatedTokens: number | null;
  estimatedCostUsd: number | null;
  estimatedTimeMs: number | null;
  configuredMaxTokens: number | null;
  configuredMaxTimeMs: number | null;
};

export type MissionPreflightBudgetEstimate = {
  mode: "subscription" | "api-key";
  estimatedTokens: number | null;
  estimatedCostUsd: number | null;
  estimatedTimeMs: number | null;
  perPhase: MissionPreflightPhaseEstimate[];
  note?: string;
};

export type MissionPreflightResult = {
  canLaunch: boolean;
  checkedAt: string;
  profileName: string | null;
  selectedPhaseCount: number;
  hardFailures: number;
  warnings: number;
  checklist: MissionPreflightChecklistItem[];
  budgetEstimate: MissionPreflightBudgetEstimate | null;
};

export type MissionPreflightRequest = {
  launch: CreateMissionArgs;
};

export type PlanMissionArgs = {
  missionId?: string;
  title?: string;
  prompt: string;
  laneId?: string | null;
  plannerEngine?: MissionPlannerEngine;
  planningTimeoutMs?: number;
  allowPlanningQuestions?: boolean;
  model?: string;
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
  pauseMission?: boolean;
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

export type MissionConcurrencyCheckResult = {
  allowed: boolean;
  reason?: string;
  queuePosition?: number;
};

export type MissionLaneClaimCheckResult = {
  claimed: boolean;
  byMissionId?: string;
};

export type MissionConcurrencyConfig = {
  maxConcurrentMissions: number;
  laneExclusivity: boolean;
};

export type MissionsEventPayload = {
  type: "missions-updated";
  missionId?: string;
  reason?: string;
  at: string;
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

export type PlanningPhaseMode = "off" | "auto" | "manual_review";
export type TestingPhaseMode = "none" | "post_implementation" | "tdd";
export type GatePhaseMode = "required" | "optional" | "off";
export type PhaseModelChoice = string;

export type MissionLevelSettings = {
  recoveryLoop?: RecoveryLoopPolicy;
  integrationPr?: IntegrationPrPolicy;
  prStrategy?: PrStrategy;
  teamRuntime?: TeamRuntimeConfig;
};

export type MissionExecutionPolicy = {
  planning: { mode: PlanningPhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  implementation: { model?: PhaseModelChoice; reasoningEffort?: string };
  testing: { mode: TestingPhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  validation: { mode: GatePhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  codeReview: { mode: GatePhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  testReview: { mode: GatePhaseMode; model?: PhaseModelChoice; reasoningEffort?: string };
  prReview: { mode: "off" | "auto"; model?: PhaseModelChoice; reasoningEffort?: string };
  merge: { mode: "off" };
  recoveryLoop?: RecoveryLoopPolicy;
  integrationPr?: IntegrationPrPolicy;
  prStrategy?: PrStrategy;
  /** Team runtime: spawn coordinator + teammates with shared task list and direct messaging */
  teamRuntime?: TeamRuntimeConfig;
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
