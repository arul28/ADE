// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

import type {
  AutomationTriggerType,
  AutomationActionType,
  AutomationTrigger,
  AutomationAction,
  AutomationRule,
} from "./config";

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
