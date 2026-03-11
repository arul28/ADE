// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

import type {
  AutomationAction,
  AutomationActionType,
  AutomationContextSource,
  AutomationExecutor,
  AutomationGuardrails,
  AutomationMode,
  AutomationOutputDisposition,
  AutomationOutputs,
  AutomationReviewProfile,
  AutomationRule,
  AutomationRunQueueStatus,
  AutomationToolFamily,
  AutomationTrigger,
  AutomationTriggerType,
  AutomationVerification,
} from "./config";

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused"
  | "needs_review";

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
  missionId: string | null;
  queueItemId: string | null;
  triggerType: AutomationTriggerType;
  startedAt: string;
  endedAt: string | null;
  status: AutomationRunStatus;
  queueStatus: AutomationRunQueueStatus;
  executorMode: AutomationExecutor["mode"];
  actionsCompleted: number;
  actionsTotal: number;
  errorMessage: string | null;
  spendUsd: number;
  verificationRequired: boolean;
  confidence: AutomationConfidenceScore | null;
  triggerMetadata: Record<string, unknown> | null;
  summary: string | null;
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
  queueCount: number;
  paused: boolean;
  ignoredRunCount: number;
  confidence: AutomationConfidenceScore | null;
};

export type AutomationQueueItem = {
  id: string;
  automationId: string;
  runId: string | null;
  missionId: string | null;
  title: string;
  mode: AutomationMode;
  queueStatus: AutomationRunQueueStatus;
  triggerType: AutomationTriggerType;
  summary: string | null;
  severitySummary: string | null;
  confidence: AutomationConfidenceScore | null;
  fileCount: number;
  spendUsd: number;
  verificationRequired: boolean;
  suggestedActions: AutomationOutputDisposition[];
  procedureSignals: string[];
  createdAt: string;
  updatedAt: string;
};

export type NightShiftQueueItem = {
  id: string;
  automationId: string;
  title: string;
  reviewProfile: AutomationReviewProfile;
  scheduledWindow: string | null;
  status: "queued" | "running" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type NightShiftBriefingCard = {
  queueItemId: string;
  title: string;
  summary: string;
  confidence: AutomationConfidenceScore | null;
  spendUsd: number;
  suggestedActions: string[];
  procedureSignals: string[];
};

export type NightShiftBriefing = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  totalSpendUsd: number;
  cards: NightShiftBriefingCard[];
};

export type NightShiftSettings = {
  activeHours: {
    start: string;
    end: string;
    timezone: string;
  };
  utilizationPreset: "conservative" | "maximize" | "fixed";
  paused: boolean;
  updatedAt: string;
};

export type NightShiftState = {
  settings: NightShiftSettings;
  queue: NightShiftQueueItem[];
  latestBriefing: NightShiftBriefing | null;
};

export type AutomationRunDetail = {
  run: AutomationRun;
  rule: AutomationRule | null;
  actions: AutomationActionResult[];
  queueItem: AutomationQueueItem | null;
  procedureFeedback: AutomationProcedureFeedback[];
};

export type AutomationQueueListArgs = {
  automationId?: string;
  status?: AutomationRunQueueStatus | "all";
  limit?: number;
};

export type AutomationQueueActionRequest = {
  queueItemId: string;
  action: "ignore" | "archive" | "accept" | "queue-overnight" | "resolve";
};

export type AutomationManualTriggerRequest = {
  id: string;
  laneId?: string | null;
  reviewProfileOverride?: AutomationReviewProfile | null;
  queueInstead?: boolean;
  verboseTrace?: boolean;
};

export type AutomationRunListArgs = {
  automationId?: string;
  status?: AutomationRunStatus | "all";
  queueStatus?: AutomationRunQueueStatus | "all";
  limit?: number;
};

export type UpdateNightShiftSettingsRequest = {
  activeHours?: Partial<NightShiftSettings["activeHours"]>;
  utilizationPreset?: NightShiftSettings["utilizationPreset"];
  paused?: boolean;
};

export type AutomationsEventPayload = {
  type:
    | "runs-updated"
    | "queue-updated"
    | "night-shift-updated"
    | "review-updated"
    | "webhook-status-updated";
  automationId?: string;
  runId?: string;
  queueItemId?: string;
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
  id?: string | null;
  name: string;
  description?: string;
  enabled: boolean;
  mode: AutomationMode;
  triggers: AutomationTrigger[];
  /** @deprecated Legacy planner/editor compatibility field. */
  trigger: AutomationTrigger;
  executor: AutomationExecutor;
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
  queueStatus?: AutomationRunQueueStatus;
  linkedRepoPaths?: string[];
  linkedDocPaths?: string[];
  rulePaths?: string[];
  /** @deprecated Legacy planner/editor compatibility field. */
  actions: AutomationDraftAction[];
  legacyActions?: AutomationDraftAction[];
};

export type AutomationRuleDraftNormalized = Omit<AutomationRule, "legacy"> & {
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
