import type { AgentChatIdentityKey } from "./chat";
import type { PrStrategy } from "./prs";

export type LinearIssueStateKey = "todo" | "in_progress" | "in_review" | "done" | "canceled" | "blocked";

export type LinearPriorityLabel = "urgent" | "high" | "normal" | "low" | "none";

export type LinearWorkflowSource = "repo" | "generated";

export type LinearWorkflowWorkerSelector =
  | { mode: "id"; value: string }
  | { mode: "slug"; value: string }
  | { mode: "capability"; value: string }
  | { mode: "none" };

export type LinearWorkflowTargetType =
  | "mission"
  | "employee_session"
  | "worker_run"
  | "pr_resolution"
  | "review_gate";

export type LinearWorkflowTarget = {
  type: LinearWorkflowTargetType;
  workerSelector?: LinearWorkflowWorkerSelector;
  employeeIdentityKey?: AgentChatIdentityKey;
  sessionTemplate?: string | null;
  missionTemplate?: string | null;
  executorKind?: "cto" | "employee" | "worker" | (string & {});
  runMode?: "autopilot" | "assisted" | "manual" | (string & {});
  phaseProfile?: string | null;
  prStrategy?: PrStrategy | null;
  downstreamTarget?: Omit<LinearWorkflowTarget, "downstreamTarget"> | null;
};

export type LinearWorkflowTriggerStateTransition = {
  from?: string[];
  to?: string[];
};

export type LinearWorkflowTrigger = {
  assignees?: string[];
  labels?: string[];
  projectSlugs?: string[];
  teamKeys?: string[];
  priority?: LinearPriorityLabel[];
  stateTransitions?: LinearWorkflowTriggerStateTransition[];
  owner?: string[];
  creator?: string[];
  metadataTags?: string[];
};

export type LinearWorkflowRouting = {
  metadataTags?: string[];
  watchOnly?: boolean;
};

export type LinearWorkflowCloseoutPolicy = {
  successState?: LinearIssueStateKey | string;
  failureState?: LinearIssueStateKey | string;
  successComment?: string | null;
  failureComment?: string | null;
  commentTemplate?: string | null;
  applyLabels?: string[];
  labels?: string[];
  reopenOnFailure?: boolean;
  resolveOnSuccess?: boolean;
  artifactMode?: "links" | "attachments";
};

export type LinearWorkflowHumanReview = {
  required?: boolean;
  reviewers?: string[];
  instructions?: string | null;
};

export type LinearWorkflowRetryPolicy = {
  maxAttempts?: number;
  baseDelaySec?: number;
  backoffSeconds?: number;
};

export type LinearWorkflowConcurrency = {
  maxActiveRuns?: number;
  perIssue?: number;
  dedupeByIssue?: boolean;
};

export type LinearWorkflowObservability = {
  emitNotifications?: boolean;
  captureIssueSnapshot?: boolean;
  persistTimeline?: boolean;
};

export type LinearWorkflowStepType =
  | "comment_linear"
  | "set_linear_state"
  | "set_linear_assignee"
  | "apply_linear_label"
  | "launch_target"
  | "wait_for_target_status"
  | "wait_for_pr"
  | "attach_artifacts"
  | "request_human_review"
  | "complete_issue"
  | "reopen_issue"
  | "emit_app_notification";

export type LinearWorkflowStep = {
  id: string;
  type: LinearWorkflowStepType;
  name?: string;
  body?: string;
  comment?: string;
  state?: LinearIssueStateKey | string;
  assignee?: string | null;
  assigneeId?: string | null;
  label?: string;
  message?: string;
  notificationTitle?: string;
  instructions?: string;
  summary?: string;
  reason?: string;
  required?: boolean;
  mode?: "links" | "attachments";
  targetStatus?: "completed" | "failed" | "cancelled" | "any_terminal";
};

export type LinearWorkflowDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  description?: string;
  source?: LinearWorkflowSource;
  triggers: LinearWorkflowTrigger;
  routing?: LinearWorkflowRouting;
  target: LinearWorkflowTarget;
  steps: LinearWorkflowStep[];
  closeout?: LinearWorkflowCloseoutPolicy;
  humanReview?: LinearWorkflowHumanReview;
  retry?: LinearWorkflowRetryPolicy;
  concurrency?: LinearWorkflowConcurrency;
  observability?: LinearWorkflowObservability;
};

export type LinearWorkflowSettings = {
  ctoLinearAssigneeId?: string | null;
  ctoLinearAssigneeName?: string | null;
  ctoLinearAssigneeAliases?: string[];
};

export type LinearWorkflowConfigFileMeta = {
  path: string;
  workflowId?: string | null;
  kind: "settings" | "workflow";
  hash: string;
};

export type LinearWorkflowConfig = {
  version: 1;
  source: LinearWorkflowSource;
  settings: LinearWorkflowSettings;
  workflows: LinearWorkflowDefinition[];
  files: LinearWorkflowConfigFileMeta[];
  migration?: {
    hasLegacyConfig: boolean;
    needsSave: boolean;
    compatibilitySnapshotPath?: string | null;
  };
  legacyConfig?: LinearSyncConfig | null;
};

export type LinearWorkflowValidationIssue = {
  level: "error" | "warning";
  workflowId?: string;
  path: string;
  message: string;
};

export type LinearWorkflowFileDiff = {
  path: string;
  status: "created" | "updated" | "deleted" | "unchanged";
  before: string | null;
  after: string | null;
};

export type LinearWorkflowEditorState = LinearWorkflowConfig & {
  validationIssues: LinearWorkflowValidationIssue[];
  setupState: "ready" | "needs_setup" | "migration_available";
  starterDefinitions: LinearWorkflowDefinition[];
  migratedDefinitions: LinearWorkflowDefinition[];
};

export type LinearWorkflowMatchCandidate = {
  workflowId: string;
  workflowName: string;
  priority: number;
  matched: boolean;
  reasons: string[];
  matchedSignals: string[];
};

export type LinearWorkflowMatchResult = {
  workflowId: string | null;
  workflowName: string | null;
  workflow: LinearWorkflowDefinition | null;
  target: LinearWorkflowTarget | null;
  reason: string;
  candidates: LinearWorkflowMatchCandidate[];
  nextStepsPreview: string[];
};

export type LinearWorkflowRunStatus =
  | "queued"
  | "in_progress"
  | "waiting_for_target"
  | "waiting_for_pr"
  | "awaiting_human_review"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";

export type LinearWorkflowRunTerminalOutcome = "completed" | "failed" | "cancelled" | null;

export type LinearWorkflowRun = {
  id: string;
  issueId: string;
  identifier: string;
  title: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: string;
  source: LinearWorkflowSource;
  targetType: LinearWorkflowTargetType;
  status: LinearWorkflowRunStatus;
  currentStepIndex: number;
  currentStepId: string | null;
  linkedMissionId: string | null;
  linkedSessionId: string | null;
  linkedWorkerRunId: string | null;
  linkedPrId: string | null;
  reviewState: "pending" | "approved" | "rejected" | null;
  retryCount: number;
  retryAfter: string | null;
  closeoutState: "pending" | "applied" | "failed";
  terminalOutcome: LinearWorkflowRunTerminalOutcome;
  lastError?: string | null;
  sourceIssueSnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type LinearWorkflowRunStep = {
  id: string;
  runId: string;
  workflowStepId: string;
  type: LinearWorkflowStepType;
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";
  startedAt: string | null;
  completedAt: string | null;
  payload?: Record<string, unknown> | null;
};

export type LinearWorkflowRunEvent = {
  id: string;
  runId: string;
  eventType: string;
  status?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
};

export type LinearSyncProjectConfig = {
  slug: string;
  defaultWorker?: string;
  teamKey?: string;
  stateMap?: Partial<Record<LinearIssueStateKey, string>>;
};

export type LinearRoutingConfig = {
  byLabel?: Record<string, string>;
};

export type LinearAssignmentConfig = {
  setAssigneeOnDispatch?: boolean;
};

export type LinearAutoDispatchRuleMatch = {
  labels?: string[];
  priority?: LinearPriorityLabel[];
  projectSlugs?: string[];
  owner?: string[];
};

export type LinearAutoDispatchAction = "auto" | "escalate" | "queue-night-shift";

export type LinearAutoDispatchRule = {
  id?: string;
  match?: LinearAutoDispatchRuleMatch;
  action: LinearAutoDispatchAction;
  template?: string;
};

export type LinearAutoDispatchConfig = {
  rules?: LinearAutoDispatchRule[];
  default?: LinearAutoDispatchAction;
};

export type LinearConcurrencyConfig = {
  global?: number;
  byState?: Partial<Record<LinearIssueStateKey, number>>;
};

export type LinearReconciliationConfig = {
  enabled?: boolean;
  stalledTimeoutSec?: number;
};

export type LinearClassificationMode = "heuristics" | "ai" | "hybrid";

export type LinearClassificationConfig = {
  mode?: LinearClassificationMode;
  confidenceThreshold?: number;
};

export type LinearArtifactMode = "links" | "attachments";

export type LinearArtifactsConfig = {
  mode?: LinearArtifactMode;
};

// Legacy config remains readable for migration only.
export type LinearSyncConfig = {
  enabled?: boolean;
  pollingIntervalSec?: number;
  projects?: LinearSyncProjectConfig[];
  routing?: LinearRoutingConfig;
  assignment?: LinearAssignmentConfig;
  autoDispatch?: LinearAutoDispatchConfig;
  concurrency?: LinearConcurrencyConfig;
  reconciliation?: LinearReconciliationConfig;
  classification?: LinearClassificationConfig;
  artifacts?: LinearArtifactsConfig;
};

export type NormalizedLinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string | null;
  projectId: string;
  projectSlug: string;
  teamId: string;
  teamKey: string;
  stateId: string;
  stateName: string;
  stateType: string;
  previousStateId?: string | null;
  previousStateName?: string | null;
  previousStateType?: string | null;
  priority: number;
  priorityLabel: LinearPriorityLabel;
  labels: string[];
  metadataTags?: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  ownerId: string | null;
  creatorId?: string | null;
  creatorName?: string | null;
  blockerIssueIds: string[];
  hasOpenBlockers: boolean;
  createdAt: string;
  updatedAt: string;
  raw: Record<string, unknown>;
};

export type LinearConnectionStatus = {
  tokenStored: boolean;
  connected: boolean;
  viewerId: string | null;
  viewerName: string | null;
  checkedAt: string | null;
  message: string | null;
  authMode?: "manual" | "oauth" | null;
  oauthAvailable?: boolean;
  tokenExpiresAt?: string | null;
};

export type CtoSetLinearTokenArgs = {
  token: string;
};

export type CtoFlowPolicyRevision = {
  id: string;
  actor: string;
  createdAt: string;
  policy: LinearWorkflowConfig;
};

export type CtoSaveFlowPolicyArgs = {
  policy: LinearWorkflowConfig;
  actor?: string;
};

export type CtoRollbackFlowPolicyRevisionArgs = {
  revisionId: string;
  actor?: string;
};

export type CtoSimulateFlowRouteArgs = {
  issue: Partial<NormalizedLinearIssue> & { title: string; identifier?: string };
};

export type CtoPreviewLinearWorkflowDefinitionsArgs = {
  workflows: LinearWorkflowDefinition[];
  settings?: LinearWorkflowSettings;
};

export type CtoSaveLinearWorkflowDefinitionsArgs = {
  workflows: LinearWorkflowDefinition[];
  settings?: LinearWorkflowSettings;
  actor?: string;
};

export type CtoResolveLinearWorkflowRunArgs = {
  runId: string;
  action: "approve" | "reject" | "retry";
  note?: string;
};

export type CtoListLinearWorkflowRunsArgs = {
  limit?: number;
  statuses?: LinearWorkflowRunStatus[];
};

export type LinearRouteDecision = LinearWorkflowMatchResult;

export type LinearSyncQueueStatus =
  | "queued"
  | "retry_wait"
  | "escalated"
  | "dispatched"
  | "failed"
  | "resolved"
  | "cancelled";

export type LinearSyncQueueItem = {
  id: string;
  runId: string;
  issueId: string;
  identifier: string;
  title: string;
  status: LinearSyncQueueStatus;
  workflowId: string;
  workflowName: string;
  targetType: LinearWorkflowTargetType;
  workerId: string | null;
  workerSlug: string | null;
  missionId: string | null;
  sessionId: string | null;
  workerRunId: string | null;
  prId: string | null;
  currentStepId: string | null;
  currentStepLabel: string | null;
  reviewState: LinearWorkflowRun["reviewState"];
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CtoResolveLinearSyncQueueItemArgs = {
  queueItemId: string;
  action: "approve" | "reject" | "retry";
  note?: string;
};

export type LinearSyncDashboard = {
  enabled: boolean;
  running: boolean;
  pollingIntervalSec: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  queue: {
    queued: number;
    retryWaiting: number;
    escalated: number;
    dispatched: number;
    failed: number;
  };
  claimsActive: number;
};
