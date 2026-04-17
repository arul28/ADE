import type { AgentChatIdentityKey } from "./chat";
import type { PrChecksStatus, PrReviewStatus, PrState, PrStrategy } from "./prs";

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

export type LinearWorkflowLaneSelection = "primary" | "fresh_issue_lane" | "operator_prompt";

export type LinearWorkflowSessionReuse = "reuse_existing" | "fresh_session";

export type LinearWorkflowPrTiming = "none" | "after_start" | "after_target_complete";

export type LinearWorkflowReviewRejectionAction = "cancel" | "reopen_issue" | "loop_back";

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
  prTiming?: LinearWorkflowPrTiming;
  laneSelection?: LinearWorkflowLaneSelection;
  sessionReuse?: LinearWorkflowSessionReuse;
  freshLaneName?: string | null;
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
  reviewReadyWhen?: "work_complete" | "pr_created" | "pr_ready";
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

export type LinearWorkflowIntake = {
  projectSlugs?: string[];
  activeStateTypes?: string[];
  terminalStateTypes?: string[];
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

export type LinearWorkflowTargetStatus =
  | "completed"
  | "explicit_completion"
  | "runtime_completed"
  | "failed"
  | "cancelled"
  | "any_terminal";

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
  targetStatus?: LinearWorkflowTargetStatus;
  notifyOn?: "delegated" | "pr_linked" | "review_ready" | "completed" | "failed";
  reviewerIdentityKey?: AgentChatIdentityKey;
  rejectAction?: LinearWorkflowReviewRejectionAction;
  loopToStepId?: string | null;
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
  intake: LinearWorkflowIntake;
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
  missingSignals?: string[];
};

export type LinearWorkflowMatchResult = {
  workflowId: string | null;
  workflowName: string | null;
  workflow: LinearWorkflowDefinition | null;
  target: LinearWorkflowTarget | null;
  reason: string;
  candidates: LinearWorkflowMatchCandidate[];
  nextStepsPreview: string[];
  simulation?: {
    matchedWorkflowId: string | null;
    explainsAndAcrossFields: boolean;
  };
};

export type LinearCatalogUser = {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  active: boolean;
};

export type LinearCatalogLabel = {
  id: string;
  name: string;
  color: string | null;
  teamId: string | null;
  teamKey: string | null;
};

export type LinearCatalogState = {
  id: string;
  name: string;
  type: string;
  teamId: string;
  teamKey: string;
};

export type LinearWorkflowCatalog = {
  users: LinearCatalogUser[];
  labels: LinearCatalogLabel[];
  states: LinearCatalogState[];
};

export type LinearWorkflowRunStatus =
  | "queued"
  | "in_progress"
  | "waiting_for_target"
  | "waiting_for_pr"
  | "awaiting_human_review"
  | "awaiting_delegation"
  | "awaiting_lane_choice"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";

export type LinearWorkflowRunTerminalOutcome = "completed" | "failed" | "cancelled" | null;

export type LinearWorkflowRouteContext = {
  reason: string;
  matchedSignals: string[];
  routeTags: string[];
  watchOnly: boolean;
  candidates?: LinearWorkflowMatchCandidate[];
};

export type LinearWorkflowExecutionContext = {
  waitingFor?: string | null;
  stalledReason?: string | null;
  employeeOverride?: string | null;
  overrideSource?: "operator" | null;
  activeTargetType?: LinearWorkflowTargetType | null;
  activeStageIndex?: number;
  totalStages?: number;
  downstreamPending?: boolean;
  workerId?: string | null;
  workerSlug?: string | null;
  sessionLabel?: string | null;
  routeTags?: string[];
};

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
  executionLaneId: string | null;
  linkedMissionId: string | null;
  linkedSessionId: string | null;
  linkedWorkerRunId: string | null;
  linkedPrId: string | null;
  reviewState: "pending" | "approved" | "rejected" | "changes_requested" | null;
  supervisorIdentityKey: AgentChatIdentityKey | null;
  reviewReadyReason: NonNullable<LinearWorkflowCloseoutPolicy["reviewReadyWhen"]> | "supervisor_approved" | null;
  prState: PrState | null;
  prChecksStatus: PrChecksStatus | null;
  prReviewStatus: PrReviewStatus | null;
  latestReviewNote: string | null;
  retryCount: number;
  retryAfter: string | null;
  closeoutState: "pending" | "applied" | "failed";
  terminalOutcome: LinearWorkflowRunTerminalOutcome;
  lastError?: string | null;
  sourceIssueSnapshot: NormalizedLinearIssue | null;
  routeContext?: LinearWorkflowRouteContext | null;
  executionContext?: LinearWorkflowExecutionContext | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearWorkflowRunStep = {
  id: string;
  runId: string;
  workflowStepId: string;
  type: LinearWorkflowStepType;
  name?: string;
  targetStatus?: LinearWorkflowTargetStatus;
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

export type LinearWorkflowNotificationLevel = "info" | "success" | "warning" | "error";

export type LinearWorkflowEventPayload =
  | {
      type: "linear-workflow-ingress";
      projectId: string;
      source: LinearIngressSource;
      issueId: string | null;
      issueIdentifier: string | null;
      summary: string;
      createdAt: string;
    }
  | {
      type: "linear-workflow-run";
      projectId: string;
      runId: string;
      issueId: string;
      issueIdentifier: string;
      workflowId: string;
      workflowName: string;
      status: LinearWorkflowRunStatus;
      milestone: "matched" | "delegated" | "supervisor_handoff" | "pr_linked" | "review_ready" | "completed" | "failed";
      message: string;
      linkedPrId?: string | null;
      linkedSessionId?: string | null;
      createdAt: string;
    }
  | {
      type: "linear-workflow-notification";
      projectId: string;
      runId: string;
      issueIdentifier: string;
      title: string;
      message: string;
      level: LinearWorkflowNotificationLevel;
      createdAt: string;
    };

export type LinearIngressSource = "relay" | "local-webhook" | "reconciliation";

export type LinearIngressEventRecord = {
  id: string;
  source: LinearIngressSource;
  deliveryId: string;
  eventId: string;
  entityType: string;
  action: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  summary: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
};

export type LinearIngressEndpointStatus = {
  configured: boolean;
  healthy: boolean;
  status: "disabled" | "starting" | "listening" | "ready" | "error";
  url?: string | null;
  port?: number | null;
  endpointId?: string | null;
  webhookUrl?: string | null;
  lastCursor?: string | null;
  lastDeliveryAt?: string | null;
  lastError?: string | null;
  lastPolledAt?: string | null;
};

export type LinearIngressStatus = {
  localWebhook: LinearIngressEndpointStatus;
  relay: LinearIngressEndpointStatus;
  reconciliation: {
    enabled: boolean;
    intervalSec: number;
    lastRunAt: string | null;
  };
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

export type LinearAutoDispatchAction = "auto" | "escalate";

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
  projectCount?: number;
  projectPreview?: string[];
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

export type LinearSyncResolutionAction = "approve" | "reject" | "retry" | "complete" | "resume";

export type CtoResolveLinearWorkflowRunArgs = {
  runId: string;
  action: LinearSyncResolutionAction;
  note?: string;
  employeeOverride?: string;
  laneId?: string;
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
  laneId: string | null;
  workerId: string | null;
  workerSlug: string | null;
  sessionLabel?: string | null;
  missionId: string | null;
  sessionId: string | null;
  workerRunId: string | null;
  prId: string | null;
  prState: PrState | null;
  prChecksStatus: PrChecksStatus | null;
  prReviewStatus: PrReviewStatus | null;
  currentStepId: string | null;
  currentStepLabel: string | null;
  reviewState: LinearWorkflowRun["reviewState"];
  supervisorIdentityKey: AgentChatIdentityKey | null;
  reviewReadyReason: LinearWorkflowRun["reviewReadyReason"];
  latestReviewNote: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  routeReason: string | null;
  matchedSignals: string[];
  routeTags: string[];
  stalledReason: string | null;
  waitingFor: string | null;
  employeeOverride: string | null;
  activeTargetType: LinearWorkflowTargetType | null;
  createdAt: string;
  updatedAt: string;
};

export type LinearSyncEventRecord = {
  id: string;
  issueId: string | null;
  queueItemId: string | null;
  eventType: string;
  status: string | null;
  message: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
};

export type LinearWorkflowRunDetail = {
  run: LinearWorkflowRun;
  steps: LinearWorkflowRunStep[];
  events: LinearWorkflowRunEvent[];
  ingressEvents: LinearIngressEventRecord[];
  syncEvents: LinearSyncEventRecord[];
  issue: NormalizedLinearIssue | null;
  reviewContext: {
    reviewerIdentityKey: AgentChatIdentityKey | null;
    rejectAction: LinearWorkflowReviewRejectionAction | null;
    loopToStepId: string | null;
    instructions: string | null;
  } | null;
};

export type CtoGetLinearWorkflowRunDetailArgs = {
  runId: string;
};

export type CtoResolveLinearSyncQueueItemArgs = {
  queueItemId: string;
  action: LinearSyncResolutionAction;
  note?: string;
  employeeOverride?: string;
  laneId?: string;
};

export type LinearSyncDashboard = {
  enabled: boolean;
  running: boolean;
  ingressMode: "webhook-first";
  reconciliationIntervalSec: number;
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
  watchOnlyHits: number;
  recentEvents: LinearSyncEventRecord[];
};

export type CtoEnsureLinearWebhookArgs = {
  force?: boolean;
};

export type CtoListLinearIngressEventsArgs = {
  limit?: number;
};
