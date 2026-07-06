export type LinearIssueStateKey = "todo" | "in_progress" | "in_review" | "done" | "canceled" | "blocked";

export type LinearPriorityLabel = "urgent" | "high" | "normal" | "low" | "none";

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

export type LinearIngressSource = "relay" | "local-webhook" | "reconciliation";

export type LinearIngressEventRecord = {
  id: string;
  source: LinearIngressSource;
  deliveryId: string;
  eventId: string;
  kind?: string | null;
  entityType?: string | null;
  action?: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  summary: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
};

function normalizeLinearIngressString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeLinearIngressAction(value: unknown): string | null {
  const action = normalizeLinearIngressString(value);
  if (!action) return null;
  switch (action) {
    case "created":
      return "create";
    case "updated":
      return "update";
    case "deleted":
    case "removed":
      return "remove";
    default:
      return action;
  }
}

export function linearIngressKindFromParts(entityType: unknown, action: unknown): string {
  const entity = normalizeLinearIngressString(entityType) ?? "issue";
  const normalizedAction = normalizeLinearIngressAction(action);
  return normalizedAction ? `${entity}.${normalizedAction}` : entity;
}

export function normalizeLinearIngressEventKind(
  event: Pick<LinearIngressEventRecord, "kind" | "entityType" | "action">
): { kind: string; entityType: string; action: string | null } {
  const explicitEntityType = normalizeLinearIngressString(event.entityType);
  const explicitAction = normalizeLinearIngressAction(event.action);
  if (explicitEntityType) {
    return {
      entityType: explicitEntityType,
      action: explicitAction,
      kind: normalizeLinearIngressString(event.kind) ?? linearIngressKindFromParts(explicitEntityType, explicitAction),
    };
  }

  const kind = normalizeLinearIngressString(event.kind);
  if (!kind) {
    return { kind: "issue", entityType: "issue", action: null };
  }
  const [entityType, ...actionParts] = kind.split(".");
  const derivedEntityType = normalizeLinearIngressString(entityType) ?? "issue";
  const derivedAction = normalizeLinearIngressAction(actionParts.join("."));
  return {
    kind,
    entityType: derivedEntityType,
    action: explicitAction ?? derivedAction,
  };
}

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
  projectName?: string | null;
  teamId: string;
  teamKey: string;
  teamName?: string | null;
  stateId: string;
  stateName: string;
  stateType: string;
  previousStateId?: string | null;
  previousStateName?: string | null;
  previousStateType?: string | null;
  priority: number;
  priorityLabel: LinearPriorityLabel;
  labels: string[];
  labelColors?: Array<{ name: string; color: string | null }>;
  cycleId?: string | null;
  cycleName?: string | null;
  cycleStartsAt?: string | null;
  cycleEndsAt?: string | null;
  childIssues?: Array<{
    id: string;
    identifier: string;
    title: string;
    stateId: string;
    stateName: string;
    stateType: string;
  }>;
  metadataTags?: string[];
  assigneeId: string | null;
  assigneeName: string | null;
  ownerId: string | null;
  creatorId?: string | null;
  creatorName?: string | null;
  blockerIssueIds: string[];
  hasOpenBlockers: boolean;
  dueDate?: string | null;
  estimate?: number | null;
  archivedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  startedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  raw: Record<string, unknown>;
};

export type LinearConnectionStatus = {
  tokenStored: boolean;
  connected: boolean;
  viewerId: string | null;
  viewerName: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
  organizationUrlKey?: string | null;
  organizationLogoUrl?: string | null;
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
