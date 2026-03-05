export type LinearIssueStateKey = "todo" | "in_progress" | "in_review" | "done" | "canceled" | "blocked";

export type LinearPriorityLabel = "urgent" | "high" | "normal" | "low" | "none";

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
  priority: number;
  priorityLabel: LinearPriorityLabel;
  labels: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  ownerId: string | null;
  blockerIssueIds: string[];
  hasOpenBlockers: boolean;
  createdAt: string;
  updatedAt: string;
  raw: Record<string, unknown>;
};

export type LinearRouteDecision = {
  action: LinearAutoDispatchAction;
  workerSlug: string | null;
  workerId: string | null;
  workerName: string | null;
  templateId: string;
  reason: string;
  confidence: number;
  matchedRuleId: string | null;
  matchedSignals: string[];
};

export type LinearConnectionStatus = {
  tokenStored: boolean;
  connected: boolean;
  viewerId: string | null;
  viewerName: string | null;
  checkedAt: string | null;
  message: string | null;
};

export type CtoSetLinearTokenArgs = {
  token: string;
};

export type CtoFlowPolicyRevision = {
  id: string;
  actor: string;
  createdAt: string;
  policy: LinearSyncConfig;
};

export type CtoSaveFlowPolicyArgs = {
  policy: LinearSyncConfig;
  actor?: string;
};

export type CtoRollbackFlowPolicyRevisionArgs = {
  revisionId: string;
  actor?: string;
};

export type CtoSimulateFlowRouteArgs = {
  issue: Partial<NormalizedLinearIssue> & { title: string; identifier?: string };
};

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
  issueId: string;
  identifier: string;
  title: string;
  status: LinearSyncQueueStatus;
  action: LinearAutoDispatchAction;
  workerId: string | null;
  workerSlug: string | null;
  missionId: string | null;
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
