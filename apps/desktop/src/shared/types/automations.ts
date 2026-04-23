// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

import type {
  AutomationAction,
  AutomationActionType,
  AutomationContextSource,
  AutomationExecution,
  AutomationExecutor,
  AutomationGuardrails,
  AutomationMode,
  AutomationOutputs,
  AutomationReviewProfile,
  AutomationRule,
  AutomationToolFamily,
  AutomationTrigger,
  AutomationTriggerType,
  AutomationVerification,
  RunAdeActionConfig,
} from "./config";
import type { MissionPermissionConfig } from "./missions";
import type { MissionModelConfig } from "./models";
import type { AgentChatSessionSummary } from "./chat";

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused";

export type AutomationActionStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export type AutomationConfidenceScore = {
  value: number;
  label: "low" | "medium" | "high";
  reason: string;
};

export type AutomationProcedureFeedback = {
  procedureId: string;
  outcome: "success" | "failure" | "observation";
  reason: string;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  chatSessionId: string | null;
  missionId: string | null;
  triggerType: AutomationTriggerType;
  startedAt: string;
  endedAt: string | null;
  status: AutomationRunStatus;
  executionKind: AutomationExecution["kind"];
  actionsCompleted: number;
  actionsTotal: number;
  errorMessage: string | null;
  spendUsd: number;
  confidence: AutomationConfidenceScore | null;
  triggerMetadata: Record<string, unknown> | null;
  summary: string | null;
  billingCode: string | null;
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
  nextRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  running: boolean;
  confidence: AutomationConfidenceScore | null;
  source: "local" | "shared" | "merged";
};

export type AutomationDeleteRuleRequest = {
  id: string;
};

export type AutomationRunDetail = {
  run: AutomationRun;
  rule: AutomationRule | null;
  chatSession: AgentChatSessionSummary | null;
  actions: AutomationActionResult[];
  procedureFeedback: AutomationProcedureFeedback[];
  ingressEvent: AutomationIngressEventRecord | null;
};

export type AutomationManualTriggerRequest = {
  id: string;
  laneId?: string | null;
  reviewProfileOverride?: AutomationReviewProfile | null;
  verboseTrace?: boolean;
  dryRun?: boolean;
};

export type AutomationRunListArgs = {
  automationId?: string;
  status?: AutomationRunStatus | "all";
  limit?: number;
};

export type AutomationsEventPayload = {
  type:
    | "runs-updated"
    | "webhook-status-updated"
    | "ingress-updated";
  automationId?: string;
  runId?: string;
};

export type AutomationIngressSource =
  | "github-relay"
  | "github-polling"
  | "linear-relay"
  | "local-webhook";

export type AutomationTriggerIssueContext = {
  number: number;
  title: string;
  body?: string;
  author?: string;
  labels?: string[];
  repo?: string;
  url?: string;
};

export type AutomationTriggerPrContext = AutomationTriggerIssueContext & {
  baseBranch?: string;
  headBranch?: string;
  draft?: boolean;
  merged?: boolean;
};

export type AutomationTriggerLinearIssueContext = {
  id: string;
  title?: string;
  team?: string;
  project?: string;
  assignee?: string;
  state?: string;
  previousState?: string;
  labels?: string[];
};

export type AutomationIngressStatus = {
  githubRelay: {
    configured: boolean;
    healthy: boolean;
    status: "disabled" | "ready" | "polling" | "error";
    apiBaseUrl: string | null;
    remoteProjectId: string | null;
    lastCursor: string | null;
    lastPolledAt: string | null;
    lastDeliveryAt: string | null;
    lastError: string | null;
  };
  localWebhook: {
    configured: boolean;
    listening: boolean;
    status: "disabled" | "ready" | "listening" | "error";
    url: string | null;
    port: number | null;
    lastDeliveryAt: string | null;
    lastError: string | null;
  };
};

export type AutomationIngressEventRecord = {
  id: string;
  source: AutomationIngressSource;
  eventKey: string;
  automationIds: string[];
  triggerType: AutomationTriggerType;
  eventName: string | null;
  status: "received" | "dispatched" | "ignored" | "failed";
  summary: string | null;
  errorMessage: string | null;
  cursor: string | null;
  receivedAt: string;
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
  | (AutomationDraftActionBase & { type: "predict-conflicts" })
  | (AutomationDraftActionBase & { type: "run-tests"; suite: string })
  | (AutomationDraftActionBase & { type: "run-command"; command: string; cwd?: string })
  | (AutomationDraftActionBase & { type: "agent-session"; prompt?: string; sessionTitle?: string; targetLaneId?: string | null })
  | (AutomationDraftActionBase & { type: "ade-action"; adeAction: RunAdeActionConfig })
  | (AutomationDraftActionBase & { type: "launch-mission"; missionTitle?: string; targetLaneId?: string | null });

export type AutomationRuleDraft = {
  id?: string | null;
  name: string;
  description?: string;
  enabled: boolean;
  mode: AutomationMode;
  triggers: AutomationTrigger[];
  /** @deprecated Legacy planner/editor compatibility field. */
  trigger: AutomationTrigger;
  execution?: AutomationExecution;
  executor: AutomationExecutor;
  modelConfig?: MissionModelConfig;
  permissionConfig?: MissionPermissionConfig;
  templateId?: string;
  prompt?: string;
  reviewProfile: AutomationReviewProfile;
  toolPalette: AutomationToolFamily[];
  contextSources: AutomationContextSource[];
  memory: AutomationRule["memory"];
  guardrails: AutomationGuardrails;
  outputs: AutomationOutputs;
  verification: AutomationVerification;
  billingCode: string;
  includeProjectContext?: boolean;
  linkedRepoPaths?: string[];
  linkedDocPaths?: string[];
  rulePaths?: string[];
  /** @deprecated Legacy planner/editor compatibility field. */
  actions: AutomationDraftAction[];
  legacyActions?: AutomationDraftAction[];
};

export type AutomationRuleDraftNormalized = Omit<AutomationRule, "id" | "legacy"> & {
  id?: string | null;
  /** @deprecated Legacy planner/editor compatibility field. */
  trigger: AutomationTrigger;
  /** @deprecated Legacy planner/editor compatibility field. */
  actions: AutomationAction[];
  legacy?: {
    trigger?: AutomationTrigger;
    actions?: AutomationAction[];
  };
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
  kind: "test-suite" | "branch" | "cron" | "command" | "profile" | "tool" | "unknown";
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
  type: AutomationActionType | "mission-dispatch" | "review-summary" | "queue-result";
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

export type AdeActionRegistryEntry = {
  domain: string;
  actions: Array<{ name: string; description?: string }>;
};
