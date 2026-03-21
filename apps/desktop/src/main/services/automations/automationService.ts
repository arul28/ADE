import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import cron from "node-cron";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  AutomationAction,
  AutomationActionResult,
  AutomationActionStatus,
  AutomationConfidenceScore,
  AutomationExecution,
  AutomationIngressEventRecord,
  AutomationIngressSource,
  AutomationIngressStatus,
  AutomationManualTriggerRequest,
  AutomationProcedureFeedback,
  AutomationRule,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunDetail,
  AutomationRunListArgs,
  AutomationRunQueueStatus,
  AutomationRunStatus,
  AutomationToolFamily,
  AutomationTrigger,
  AutomationTriggerType,
  NormalizedLinearIssue,
  PrSummary,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb, SqlValue } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createTestService } from "../tests/testService";
import type { createMissionService } from "../missions/missionService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createMemoryBriefingService } from "../memory/memoryBriefingService";
import type { createProceduralLearningService } from "../memory/proceduralLearningService";
import type { createBudgetCapService } from "../usage/budgetCapService";
import { buildClaudeReadOnlyWorkerAllowedTools } from "../orchestrator/unifiedOrchestratorAdapter";
import type { createWorkerHeartbeatService } from "../cto/workerHeartbeatService";
import { escapeRegExp, globToRegExp, isRecord, isWithinDir, matchesGlob, normalizeSet, nowIso, safeJsonParse } from "../shared/utils";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";

type CronTask = {
  stop: () => void;
};

type TriggerContext = {
  triggerType: AutomationTriggerType;
  laneId?: string;
  laneName?: string;
  sessionId?: string;
  commitSha?: string;
  reason?: string;
  scheduledAt?: string;
  reviewProfileOverride?: AutomationRule["reviewProfile"] | null;
  verboseTrace?: boolean;
  ingressEventId?: string;
  ingressSource?: AutomationIngressSource;
  ingressEventKey?: string;
  eventName?: string;
  author?: string;
  labels?: string[];
  paths?: string[];
  keywords?: string[];
  branch?: string;
  targetBranch?: string;
  project?: string;
  team?: string;
  assignee?: string;
  stateTransition?: string;
  changedFields?: string[];
  draftState?: "draft" | "ready" | "any";
  summary?: string;
};

type WatchedFileRoot = {
  key: string;
  laneId?: string;
  laneName?: string;
  rootPath: string;
  branchRef?: string;
};

const DEFAULT_AUTOMATION_CHAT_MODEL_ID =
  getDefaultModelDescriptor("unified")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? "anthropic/claude-sonnet-4-6-api";

type AutomationRunRow = {
  id: string;
  automation_id: string;
  chat_session_id: string | null;
  mission_id: string | null;
  worker_run_id: string | null;
  worker_agent_id: string | null;
  queue_item_id: string | null;
  ingress_event_id: string | null;
  trigger_type: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  execution_kind: string | null;
  queue_status: string | null;
  executor_mode: string | null;
  actions_completed: number;
  actions_total: number;
  error_message: string | null;
  verification_required: number | null;
  spend_usd: number | null;
  trigger_metadata: string | null;
  summary: string | null;
  confidence_json: string | null;
  billing_code: string | null;
  linked_procedure_ids_json: string | null;
  procedure_feedback_json: string | null;
};

type AutomationActionRow = {
  id: string;
  run_id: string;
  action_index: number;
  action_type: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  error_message: string | null;
  output: string | null;
};

type AutomationQueueItemRow = {
  id: string;
  automation_id: string;
  run_id: string | null;
  mission_id: string | null;
  position: number | null;
  title: string;
  mode: string;
  queue_status: string;
  trigger_type: string;
  summary: string | null;
  severity_summary: string | null;
  confidence_json: string | null;
  file_count: number | null;
  spend_usd: number | null;
  verification_required: number | null;
  suggested_actions_json: string | null;
  procedure_signals_json: string | null;
  created_at: string;
  updated_at: string;
};

type AutomationIngressEventRow = {
  id: string;
  source: string;
  event_key: string;
  automation_ids_json: string | null;
  trigger_type: string;
  event_name: string | null;
  status: string;
  summary: string | null;
  error_message: string | null;
  cursor: string | null;
  raw_payload_json: string | null;
  received_at: string;
};

type AutomationPendingPublishRow = {
  id: string;
  run_id: string;
  automation_id: string;
  queue_item_id: string | null;
  summary: string;
  tool_palette_json: string;
  continuation_kind: string;
  created_at: string;
  resolved_at: string | null;
};

type ProjectConfigService = ReturnType<typeof createProjectConfigService>;

const AUTOMATION_SCOPE = "automation-rule";
const AUTOMATION_TASK_KEY_PREFIX = "automation-rule";
const AUTOMATION_TOOL_BASELINE = buildClaudeReadOnlyWorkerAllowedTools("ade");
const PUBLISH_CAPABLE_TOOL_FAMILIES = new Set<AutomationToolFamily>(["github", "linear", "browser", "external-mcp"]);
const TOOL_FAMILY_ALLOWED_TOOLS: Record<AutomationToolFamily, string[]> = {
  repo: ["Read", "Glob", "Grep", "LS"],
  git: ["Bash", "bash"],
  tests: ["Bash", "bash"],
  github: ["Bash", "bash", "mcp__github__get_pull_request", "mcp__github__create_pull_request", "mcp__github__add_issue_comment"],
  linear: ["mcp__linear__get_issue", "mcp__linear__save_comment", "mcp__linear__save_issue"],
  browser: [
    "agent-browser",
    "mcp__ade__get_environment_info",
    "mcp__ade__launch_app",
    "mcp__ade__interact_gui",
    "mcp__ade__screenshot_environment",
    "mcp__ade__record_environment",
    "mcp__playwright__browser_navigate",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_fill_form",
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_take_screenshot",
  ],
  memory: ["mcp__ade__memory_search", "mcp__ade__memory_add"],
  mission: [
    "mcp__ade__get_mission",
    "mcp__ade__get_run_graph",
    "mcp__ade__stream_events",
    "mcp__ade__get_timeline",
    "mcp__ade__get_pending_messages",
    "mcp__ade__report_status",
    "mcp__ade__report_result",
    "mcp__ade__ask_user",
  ],
  "external-mcp": [],
};

function safeJsonParseRecord(raw: string | null): Record<string, unknown> | null {
  const parsed = safeJsonParse(raw, null);
  return isRecord(parsed) ? parsed : null;
}

function safeJsonParseArray<T>(raw: string | null): T[] {
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function clampText(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}\n...(truncated)...\n`;
}

function summarizeMemoryContent(content: string, fallback: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? fallback;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed.length || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}


function normalizeTriggerType(type: AutomationTriggerType): AutomationTriggerType {
  if (type === "commit") return "git.commit";
  return type;
}

function triggerTypesMatch(ruleType: AutomationTriggerType, runtimeType: AutomationTriggerType): boolean {
  return normalizeTriggerType(ruleType) === normalizeTriggerType(runtimeType);
}


function listMatches(expected: string[] | undefined, actual: string[] | undefined): boolean {
  if (!expected?.length) return true;
  const actualSet = normalizeSet(actual);
  return expected.some((entry) => actualSet.has(entry.trim().toLowerCase()));
}

function parseCronPart(field: string, value: number, min: number, max: number): boolean {
  const trimmed = field.trim();
  if (!trimmed.length) return false;
  const segments = trimmed.split(",");
  return segments.some((segment) => {
    const part = segment.trim();
    if (!part) return false;
    const [baseRaw, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step <= 0) return false;
    const base = baseRaw.trim();
    if (base === "*") {
      return (value - min) % step === 0;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || value < start || value > end) return false;
      return (value - start) % step === 0;
    }
    const exact = Number(base);
    if (!Number.isFinite(exact)) return false;
    if (max === 7 && exact === 7) {
      return value === 0;
    }
    return value === exact;
  });
}

function computeNextScheduleAt(cronExpr: string, from = new Date()): string | null {
  const expr = cronExpr.trim();
  if (!expr || !cron.validate(expr)) return null;
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i += 1) {
    const matches =
      parseCronPart(minute, cursor.getMinutes(), 0, 59) &&
      parseCronPart(hour, cursor.getHours(), 0, 23) &&
      parseCronPart(dayOfMonth, cursor.getDate(), 1, 31) &&
      parseCronPart(month, cursor.getMonth() + 1, 1, 12) &&
      parseCronPart(dayOfWeek, cursor.getDay(), 0, 7);
    if (matches) return cursor.toISOString();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function normalizeRunStatus(value: string, fallback: AutomationRunStatus): AutomationRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "paused" ||
    value === "needs_review"
  ) return value;
  return fallback;
}

function normalizeActionStatus(value: string, fallback: AutomationActionStatus): AutomationActionStatus {
  if (value === "running" || value === "succeeded" || value === "failed" || value === "skipped" || value === "cancelled") return value;
  return fallback;
}

function normalizeQueueStatus(value: string | null | undefined, fallback: AutomationRunQueueStatus): AutomationRunQueueStatus {
  switch (value) {
    case "pending-review":
    case "actionable-findings":
    case "verification-required":
    case "completed-clean":
    case "ignored":
    case "archived":
      return value;
    default:
      return fallback;
  }
}

function normalizeConfidence(value: unknown): AutomationConfidenceScore | null {
  if (!isRecord(value)) return null;
  const rawValue = Number(value.value ?? Number.NaN);
  const label = typeof value.label === "string" ? value.label : null;
  const reason = typeof value.reason === "string" ? value.reason : "";
  if (!Number.isFinite(rawValue) || rawValue < 0 || rawValue > 1) return null;
  if (label !== "low" && label !== "medium" && label !== "high") return null;
  return { value: rawValue, label, reason };
}

function labelForConfidence(value: number): "low" | "medium" | "high" {
  if (value >= 0.78) return "high";
  if (value >= 0.52) return "medium";
  return "low";
}

function computeConfidence(rule: AutomationRule, procedureCount: number): AutomationConfidenceScore {
  const baseByProfile: Record<AutomationRule["reviewProfile"], number> = {
    quick: 0.58,
    incremental: 0.64,
    full: 0.73,
    security: 0.79,
    "release-risk": 0.75,
    "cross-repo-contract": 0.68,
  };
  const contextBoost = Math.min(0.12, rule.contextSources.length * 0.015);
  const procedureBoost = Math.min(0.1, procedureCount * 0.03);
  const thresholdPenalty = typeof rule.guardrails.confidenceThreshold === "number"
    ? Math.max(0, rule.guardrails.confidenceThreshold - 0.65) * 0.25
    : 0;
  const value = Math.max(0.2, Math.min(0.95, baseByProfile[rule.reviewProfile] + contextBoost + procedureBoost - thresholdPenalty));
  return {
    value,
    label: labelForConfidence(value),
    reason: procedureCount > 0
      ? `Confidence boosted by ${procedureCount} retrieved procedures and ${rule.contextSources.length} context sources.`
      : `Based on ${rule.reviewProfile} review profile with ${rule.contextSources.length} context sources.`
  };
}

function primaryTrigger(rule: AutomationRule): AutomationTrigger {
  return normalizedRuleTriggers(rule)[0] ?? { type: "manual" };
}

function normalizedRuleTriggers(rule: AutomationRule): AutomationTrigger[] {
  if (Array.isArray(rule.triggers) && rule.triggers.length > 0) return rule.triggers;
  const legacyTrigger = (rule as AutomationRule & { trigger?: AutomationTrigger }).trigger;
  if (legacyTrigger) return [legacyTrigger];
  if (rule.legacy?.trigger) return [rule.legacy.trigger];
  return [{ type: "manual" }];
}

function normalizeRuntimeRule(rule: AutomationRule): AutomationRule {
  const triggers = normalizedRuleTriggers(rule);
  const legacyActions = Array.isArray(rule.legacy?.actions)
    ? rule.legacy.actions
    : Array.isArray((rule as AutomationRule & { actions?: AutomationAction[] }).actions)
      ? (rule as AutomationRule & { actions?: AutomationAction[] }).actions ?? []
      : [];
  const primary = triggers[0] ?? { type: "manual" as const };
  const rawExecution = rule.execution ?? (legacyActions.length > 0
    ? { kind: "built-in" as const, builtIn: { actions: legacyActions } }
    : { kind: "mission" as const });
  const normalizedExecution: AutomationExecution = rawExecution.kind === "built-in"
    ? {
        kind: "built-in",
        ...(rawExecution.targetLaneId ? { targetLaneId: rawExecution.targetLaneId } : {}),
        builtIn: {
          actions: rawExecution.builtIn?.actions?.length ? rawExecution.builtIn.actions : legacyActions,
        },
      }
    : rawExecution.kind === "agent-session"
      ? {
          kind: "agent-session",
          ...(rawExecution.targetLaneId ? { targetLaneId: rawExecution.targetLaneId } : {}),
          ...(rawExecution.session ? { session: rawExecution.session } : {}),
        }
      : {
          kind: "mission",
          ...(rawExecution.targetLaneId ? { targetLaneId: rawExecution.targetLaneId } : {}),
          ...(rawExecution.mission ? { mission: rawExecution.mission } : {}),
        };
  const outputDisposition = rule.outputs?.disposition ?? "comment-only";
  return {
    ...rule,
    enabled: rule.enabled !== false,
    triggers: [primary],
    trigger: primary,
    executor: { mode: "automation-bot" },
    reviewProfile: rule.reviewProfile ?? "quick",
    toolPalette: rule.toolPalette?.length ? rule.toolPalette : ["repo", "memory", "mission"],
    contextSources: rule.contextSources?.length ? rule.contextSources : [{ type: "project-memory" }, { type: "procedures" }],
    memory: rule.memory ?? { mode: "automation-plus-project", ruleScopeKey: rule.id },
    guardrails: rule.guardrails ?? {},
    outputs: {
      disposition: outputDisposition,
      createArtifact: rule.outputs?.createArtifact ?? true,
      ...(rule.outputs?.notificationChannel ? { notificationChannel: rule.outputs.notificationChannel } : {}),
    },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: rule.billingCode?.trim() || `auto:${rule.id}`,
    execution: normalizedExecution,
    legacy: {
      trigger: primary,
      ...(legacyActions.length ? { actions: legacyActions } : {}),
    },
  };
}

function resolveExecutionKind(rule: AutomationRule): AutomationExecution["kind"] {
  return rule.execution?.kind ?? ((rule.legacy?.actions?.length ?? 0) > 0 ? "built-in" : "mission");
}

function summarizeTrigger(trigger: AutomationTrigger): string {
  if (trigger.type === "schedule" && trigger.cron) return `schedule ${trigger.cron}`;
  if ((trigger.type === "commit" || trigger.type === "git.commit" || trigger.type === "git.push") && trigger.branch) {
    return `${normalizeTriggerType(trigger.type)}:${trigger.branch}`;
  }
  if ((trigger.type === "git.pr_opened" || trigger.type === "git.pr_updated" || trigger.type === "git.pr_closed") && trigger.branch) {
    return `${trigger.type}:${trigger.branch}`;
  }
  if (trigger.type === "git.pr_merged" && (trigger.targetBranch || trigger.branch)) {
    return `git.pr_merged:${trigger.targetBranch ?? trigger.branch}`;
  }
  if ((trigger.type === "lane.created" || trigger.type === "lane.archived") && trigger.namePattern) {
    return `${trigger.type}:${trigger.namePattern}`;
  }
  if (trigger.type === "file.change" && trigger.paths?.length) {
    return `file.change:${trigger.paths.join(",")}`;
  }
  if (trigger.type.startsWith("linear.") && (trigger.project || trigger.team || trigger.assignee)) {
    return `${trigger.type}:${[trigger.project, trigger.team, trigger.assignee].filter(Boolean).join("/")}`;
  }
  if (trigger.type === "github-webhook" && trigger.event) return `github:${trigger.event}`;
  if (trigger.type === "webhook" && trigger.event) return `webhook:${trigger.event}`;
  return trigger.type;
}

function summarizeLegacyActions(actions: AutomationAction[]): string {
  if (!actions.length) return "mission dispatch";
  return actions.map((action) => action.type).join(", ");
}

function mapMissionStatus(status: string, verificationRequired: boolean): AutomationRunStatus {
  switch (status) {
    case "queued":
    case "planning":
      return "queued";
    case "in_progress":
      return "running";
    case "intervention_required":
      return verificationRequired ? "needs_review" : "paused";
    case "completed":
      return verificationRequired ? "needs_review" : "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "cancelled";
    default:
      return verificationRequired ? "needs_review" : "running";
  }
}

function mapWorkerStatus(status: string, verificationRequired: boolean): AutomationRunStatus {
  switch (status) {
    case "queued":
    case "deferred":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return verificationRequired ? "needs_review" : "succeeded";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return verificationRequired ? "needs_review" : "paused";
    case "failed":
    default:
      return "failed";
  }
}

function deriveQueueStatus(args: {
  current: AutomationRunQueueStatus;
  runStatus: AutomationRunStatus;
  verificationRequired: boolean;
  mode: AutomationRule["mode"];
  summary: string | null;
}): AutomationRunQueueStatus {
  if (args.current === "ignored" || args.current === "archived") return args.current;
  if (args.verificationRequired) return "verification-required";
  if (args.runStatus === "queued") return "pending-review";
  if (args.runStatus === "running") return "pending-review";
  if (args.runStatus === "failed") return "actionable-findings";
  if (args.mode === "monitor") return "completed-clean";
  const lower = (args.summary ?? "").toLowerCase();
  if (lower.includes("no findings") || lower.includes("clean") || lower.includes("no issues")) {
    return "completed-clean";
  }
  return "actionable-findings";
}

function parseActiveHours(value: NonNullable<AutomationTrigger["activeHours"]>, now = new Date()): { startMin: number; endMin: number; currentMin: number } {
  const parseClock = (raw: string, fallback: number): number => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
    if (!match) return fallback;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
    return Math.max(0, Math.min(23, hour)) * 60 + Math.max(0, Math.min(59, minute));
  };
  return {
    startMin: parseClock(value.start, 22 * 60),
    endMin: parseClock(value.end, 6 * 60),
    currentMin: now.getHours() * 60 + now.getMinutes(),
  };
}

function isWithinActiveHours(hours: NonNullable<AutomationTrigger["activeHours"]>, now = new Date()): boolean {
  const { startMin, endMin, currentMin } = parseActiveHours(hours, now);
  if (startMin === endMin) return true;
  if (startMin < endMin) return currentMin >= startMin && currentMin < endMin;
  return currentMin >= startMin || currentMin < endMin;
}

function toIngressEvent(row: AutomationIngressEventRow): AutomationIngressEventRecord {
  return {
    id: row.id,
    source: row.source as AutomationIngressSource,
    eventKey: row.event_key,
    automationIds: safeJsonParseArray<string>(row.automation_ids_json),
    triggerType: row.trigger_type as AutomationTriggerType,
    eventName: row.event_name ?? null,
    status: row.status as AutomationIngressEventRecord["status"],
    summary: row.summary ?? null,
    errorMessage: row.error_message ?? null,
    cursor: row.cursor ?? null,
    receivedAt: row.received_at,
  };
}

function toRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    chatSessionId: row.chat_session_id ?? null,
    missionId: row.mission_id ?? null,
    triggerType: (row.trigger_type as AutomationTriggerType) ?? "manual",
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    status: normalizeRunStatus(row.status, "failed"),
    executionKind: (row.execution_kind as AutomationExecution["kind"]) ?? "mission",
    actionsCompleted: row.actions_completed ?? 0,
    actionsTotal: row.actions_total ?? 0,
    errorMessage: row.error_message ?? null,
    spendUsd: Number(row.spend_usd ?? 0),
    confidence: normalizeConfidence(safeJsonParse(row.confidence_json ?? "null", null)),
    triggerMetadata: safeJsonParseRecord(row.trigger_metadata),
    summary: row.summary ?? null,
    billingCode: row.billing_code ?? null,
  };
}

function toAction(row: AutomationActionRow): AutomationActionResult {
  return {
    id: row.id,
    runId: row.run_id,
    actionIndex: row.action_index,
    actionType: row.action_type as AutomationAction["type"],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    status: normalizeActionStatus(row.status, "failed"),
    errorMessage: row.error_message ?? null,
    output: row.output ?? null,
  };
}

export function createAutomationService({
  db,
  logger,
  projectId,
  projectRoot,
  laneService,
  projectConfigService,
  conflictService,
  testService,
  agentChatService,
  missionService,
  aiOrchestratorService,
  memoryBriefingService,
  proceduralLearningService,
  budgetCapService,
  onEvent
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ProjectConfigService;
  conflictService?: ReturnType<typeof createConflictService>;
  testService?: ReturnType<typeof createTestService>;
  agentChatService?: ReturnType<typeof createAgentChatService>;
  missionService?: ReturnType<typeof createMissionService>;
  aiOrchestratorService?: ReturnType<typeof createAiOrchestratorService>;
  memoryBriefingService?: ReturnType<typeof createMemoryBriefingService>;
  proceduralLearningService?: ReturnType<typeof createProceduralLearningService>;
  budgetCapService?: ReturnType<typeof createBudgetCapService>;
  onEvent?: (payload: {
    type: "runs-updated" | "webhook-status-updated" | "ingress-updated";
    automationId?: string;
    runId?: string;
  }) => void;
}) {
  type AutomationIngressStatusPatch = {
    githubRelay?: Partial<AutomationIngressStatus["githubRelay"]>;
    localWebhook?: Partial<AutomationIngressStatus["localWebhook"]>;
  };
  let missionServiceRef = missionService;
  let aiOrchestratorServiceRef = aiOrchestratorService;
  let agentChatServiceRef = agentChatService;
  let memoryBriefingServiceRef = memoryBriefingService;
  let proceduralLearningServiceRef = proceduralLearningService;
  let budgetCapServiceRef = budgetCapService;
  let workerHeartbeatServiceRef: ReturnType<typeof createWorkerHeartbeatService> | null = null;
  let ingressStatusRef: AutomationIngressStatus = {
    githubRelay: {
      configured: false,
      healthy: false,
      status: "disabled",
      apiBaseUrl: null,
      remoteProjectId: null,
      lastCursor: null,
      lastPolledAt: null,
      lastDeliveryAt: null,
      lastError: null,
    },
    localWebhook: {
      configured: false,
      listening: false,
      status: "disabled",
      url: null,
      port: null,
      lastDeliveryAt: null,
      lastError: null,
    },
  };
  const resolveLaneBranch = (laneId: string): string | undefined => {
    try { return laneService.getLaneBaseAndBranch(laneId).branchRef; }
    catch { return undefined; }
  };

  const inFlightByAutomationId = new Set<string>();
  const scheduleTasks = new Map<string, CronTask>();
  const fileWatchers = new Map<string, FSWatcher>();

  const emit = (payload: {
    type: "runs-updated" | "webhook-status-updated" | "ingress-updated";
    automationId?: string;
    runId?: string;
  }) => {
    try {
      onEvent?.(payload);
    } catch {
      // ignore
    }
  };

  const columnExists = (table: string, column: string): boolean => {
    const rows = db.all<{ name: string }>(`pragma table_info(${table})`);
    return rows.some((row) => row.name === column);
  };

  const safeAlter = (sql: string) => {
    try {
      db.run(sql);
    } catch {
      // ignore duplicate column errors
    }
  };

  const ensureSchema = () => {
    const runColumns = [
      ["chat_session_id", "alter table automation_runs add column chat_session_id text"],
      ["mission_id", "alter table automation_runs add column mission_id text"],
      ["worker_run_id", "alter table automation_runs add column worker_run_id text"],
      ["worker_agent_id", "alter table automation_runs add column worker_agent_id text"],
      ["queue_item_id", "alter table automation_runs add column queue_item_id text"],
      ["ingress_event_id", "alter table automation_runs add column ingress_event_id text"],
      ["execution_kind", "alter table automation_runs add column execution_kind text"],
      ["queue_status", "alter table automation_runs add column queue_status text"],
      ["executor_mode", "alter table automation_runs add column executor_mode text"],
      ["review_profile", "alter table automation_runs add column review_profile text"],
      ["verification_required", "alter table automation_runs add column verification_required integer not null default 0"],
      ["spend_usd", "alter table automation_runs add column spend_usd real not null default 0"],
      ["summary", "alter table automation_runs add column summary text"],
      ["confidence_json", "alter table automation_runs add column confidence_json text"],
      ["billing_code", "alter table automation_runs add column billing_code text"],
      ["linked_procedure_ids_json", "alter table automation_runs add column linked_procedure_ids_json text"],
      ["procedure_feedback_json", "alter table automation_runs add column procedure_feedback_json text"],
    ] as const;
    for (const [column, sql] of runColumns) {
      if (!columnExists("automation_runs", column)) safeAlter(sql);
    }

    db.run(`
      create table if not exists automation_queue_items (
        id text primary key,
        project_id text not null,
        automation_id text not null,
        run_id text,
        mission_id text,
        position integer not null default 0,
        title text not null,
        mode text not null,
        queue_status text not null,
        trigger_type text not null,
        summary text,
        severity_summary text,
        confidence_json text,
        file_count integer not null default 0,
        spend_usd real not null default 0,
        verification_required integer not null default 0,
        suggested_actions_json text,
        procedure_signals_json text,
        created_at text not null,
        updated_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(run_id) references automation_runs(id)
      )
    `);
    db.run("create index if not exists idx_automation_queue_items_project_status on automation_queue_items(project_id, queue_status, created_at)");
    db.run("create index if not exists idx_automation_queue_items_project_automation on automation_queue_items(project_id, automation_id, created_at)");
    if (!columnExists("automation_queue_items", "position")) safeAlter("alter table automation_queue_items add column position integer not null default 0");

    db.run(`
      create table if not exists automation_night_shift_settings (
        project_id text primary key,
        schedule_start text not null,
        schedule_end text not null,
        timezone text not null,
        utilization_preset text not null,
        paused integer not null default 0,
        updated_at text not null,
        foreign key(project_id) references projects(id)
      )
    `);

    db.run(`
      create table if not exists automation_morning_briefings (
        id text primary key,
        project_id text not null,
        created_at text not null,
        completed_at text,
        total_runs integer not null default 0,
        succeeded_runs integer not null default 0,
        failed_runs integer not null default 0,
        total_spend_usd real not null default 0,
        cards_json text,
        acknowledged_at text,
        foreign key(project_id) references projects(id)
      )
    `);
    db.run("create index if not exists idx_automation_morning_briefings_project_created on automation_morning_briefings(project_id, created_at)");

    db.run(`
      create table if not exists automation_ingress_events (
        id text primary key,
        project_id text not null,
        source text not null,
        event_key text not null,
        automation_ids_json text,
        trigger_type text not null,
        event_name text,
        status text not null,
        summary text,
        error_message text,
        cursor text,
        raw_payload_json text,
        received_at text not null,
        foreign key(project_id) references projects(id)
      )
    `);
    db.run("create unique index if not exists idx_automation_ingress_events_project_key on automation_ingress_events(project_id, source, event_key)");
    db.run("create index if not exists idx_automation_ingress_events_project_received on automation_ingress_events(project_id, received_at desc)");

    db.run(`
      create table if not exists automation_ingress_cursors (
        project_id text not null,
        source text not null,
        cursor text,
        updated_at text not null,
        primary key(project_id, source),
        foreign key(project_id) references projects(id)
      )
    `);

    db.run(`
      create table if not exists automation_pending_publish (
        id text primary key,
        project_id text not null,
        run_id text not null,
        automation_id text not null,
        queue_item_id text,
        summary text not null,
        tool_palette_json text not null,
        continuation_kind text not null default 'publish',
        created_at text not null,
        resolved_at text,
        foreign key(project_id) references projects(id),
        foreign key(run_id) references automation_runs(id)
      )
    `);
    db.run("create index if not exists idx_automation_pending_publish_project_run on automation_pending_publish(project_id, run_id)");

  };

  ensureSchema();

  const listRules = (): AutomationRule[] => (projectConfigService.get().effective.automations ?? []).map((rule) => normalizeRuntimeRule(rule as AutomationRule));
  const findRule = (automationId: string): AutomationRule | null => listRules().find((rule) => rule.id === automationId) ?? null;

  const updateIngressStatus = (patch: AutomationIngressStatusPatch) => {
    ingressStatusRef = {
      githubRelay: { ...ingressStatusRef.githubRelay, ...(patch.githubRelay ?? {}) },
      localWebhook: { ...ingressStatusRef.localWebhook, ...(patch.localWebhook ?? {}) },
    };
    emit({ type: "ingress-updated" });
  };

  const getNextNightShiftPosition = (): number => {
    const row = db.get<{ max_position: number | null }>(
      `select max(position) as max_position from automation_queue_items where project_id = ?`,
      [projectId]
    );
    return Math.max(0, Number(row?.max_position ?? 0)) + 1;
  };

  const computeAllowedToolList = (rule: AutomationRule, options: { publishPhase: boolean }): string[] => {
    const families = rule.toolPalette.filter((family) => options.publishPhase || !PUBLISH_CAPABLE_TOOL_FAMILIES.has(family));
    const explicit = dedupeStrings([
      ...(rule.permissionConfig?.cli?.allowedTools ?? []),
      ...(rule.permissionConfig?.providers?.allowedTools ?? []),
    ]);
    return dedupeStrings([
      ...AUTOMATION_TOOL_BASELINE,
      ...families.flatMap((family) => TOOL_FAMILY_ALLOWED_TOOLS[family] ?? []),
      ...explicit,
    ]);
  };

  const buildPermissionConfig = (rule: AutomationRule, options: { publishPhase: boolean }) => {
    const allowedTools = computeAllowedToolList(rule, options);
    const cli = rule.permissionConfig?.cli;
    const providers = rule.permissionConfig?.providers;
    return {
      ...(cli
        ? {
            cli: {
              ...cli,
              allowedTools,
            },
          }
        : {
            cli: {
              mode: "edit" as const,
              sandboxPermissions: "workspace-write" as const,
              allowedTools,
            },
          }),
      ...(rule.permissionConfig?.inProcess ? { inProcess: rule.permissionConfig.inProcess } : {}),
      ...(rule.permissionConfig?.externalMcp ? { externalMcp: rule.permissionConfig.externalMcp } : {}),
      providers: {
        claude: providers?.claude ?? "edit",
        codex: providers?.codex ?? "edit",
        unified: rule.verification.mode === "dry-run" ? "plan" : (providers?.unified ?? "edit"),
        codexSandbox: providers?.codexSandbox ?? "workspace-write",
        ...(providers?.writablePaths?.length ? { writablePaths: providers.writablePaths } : {}),
        allowedTools,
      },
    };
  };

  const requiresPublishGate = (rule: AutomationRule): boolean =>
    Boolean(rule.verification.verifyBeforePublish)
    && rule.verification.mode !== "dry-run"
    && rule.toolPalette.some((family) => PUBLISH_CAPABLE_TOOL_FAMILIES.has(family));

  const buildTriggerMetadata = (trigger: TriggerContext): Record<string, unknown> => ({
    ...(trigger.laneId ? { laneId: trigger.laneId } : {}),
    ...(trigger.laneName ? { laneName: trigger.laneName } : {}),
    ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
    ...(trigger.commitSha ? { commitSha: trigger.commitSha } : {}),
    ...(trigger.reason ? { reason: trigger.reason } : {}),
    ...(trigger.scheduledAt ? { scheduledAt: trigger.scheduledAt } : {}),
    ...(trigger.reviewProfileOverride ? { reviewProfileOverride: trigger.reviewProfileOverride } : {}),
    ...(trigger.verboseTrace ? { verboseTrace: true } : {}),
    ...(trigger.ingressEventId ? { ingressEventId: trigger.ingressEventId } : {}),
    ...(trigger.ingressSource ? { ingressSource: trigger.ingressSource } : {}),
    ...(trigger.ingressEventKey ? { ingressEventKey: trigger.ingressEventKey } : {}),
    ...(trigger.eventName ? { eventName: trigger.eventName } : {}),
    ...(trigger.author ? { author: trigger.author } : {}),
    ...(trigger.labels?.length ? { labels: trigger.labels } : {}),
    ...(trigger.paths?.length ? { paths: trigger.paths } : {}),
    ...(trigger.keywords?.length ? { keywords: trigger.keywords } : {}),
    ...(trigger.branch ? { branch: trigger.branch } : {}),
    ...(trigger.targetBranch ? { targetBranch: trigger.targetBranch } : {}),
    ...(trigger.project ? { project: trigger.project } : {}),
    ...(trigger.team ? { team: trigger.team } : {}),
    ...(trigger.assignee ? { assignee: trigger.assignee } : {}),
    ...(trigger.stateTransition ? { stateTransition: trigger.stateTransition } : {}),
    ...(trigger.changedFields?.length ? { changedFields: trigger.changedFields } : {}),
    ...(trigger.draftState ? { draftState: trigger.draftState } : {}),
    ...(trigger.summary ? { summary: trigger.summary } : {}),
  });

  const insertRun = (args: {
    rule: AutomationRule;
    trigger: TriggerContext;
    status?: AutomationRunStatus;
    queueStatus?: AutomationRunQueueStatus;
    actionsTotal?: number;
    confidence?: AutomationConfidenceScore | null;
    linkedProcedureIds?: string[];
    summary?: string | null;
    queueItemId?: string | null;
    chatSessionId?: string | null;
    missionId?: string | null;
    workerRunId?: string | null;
    workerAgentId?: string | null;
    ingressEventId?: string | null;
  }): AutomationRun => {
    const runId = randomUUID();
    const startedAt = nowIso();
    const runStatus = args.status ?? "running";
    const queueStatus = args.queueStatus ?? "pending-review";
    const confidence = args.confidence ?? null;
    const executionKind = resolveExecutionKind(args.rule);
    const triggerMetadata = buildTriggerMetadata(args.trigger);
    db.run(
      `
        insert into automation_runs(
          id,
          project_id,
          automation_id,
          chat_session_id,
          mission_id,
          worker_run_id,
          worker_agent_id,
          queue_item_id,
          ingress_event_id,
          trigger_type,
          started_at,
          ended_at,
          status,
          execution_kind,
          queue_status,
          executor_mode,
          actions_completed,
          actions_total,
          error_message,
          verification_required,
          spend_usd,
          trigger_metadata,
          summary,
          confidence_json,
          billing_code,
          linked_procedure_ids_json,
          procedure_feedback_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        runId,
        projectId,
        args.rule.id,
        args.chatSessionId ?? null,
        args.missionId ?? null,
        args.workerRunId ?? null,
        args.workerAgentId ?? null,
        args.queueItemId ?? null,
        args.ingressEventId ?? args.trigger.ingressEventId ?? null,
        args.trigger.triggerType,
        startedAt,
        runStatus,
        executionKind,
        queueStatus,
        args.rule.executor.mode,
        0,
        Math.max(1, args.actionsTotal ?? 1),
        requiresPublishGate(args.rule) ? 1 : 0,
        0,
        JSON.stringify(triggerMetadata),
        args.summary ?? null,
        confidence ? JSON.stringify(confidence) : null,
        args.rule.billingCode,
        JSON.stringify(args.linkedProcedureIds ?? []),
        JSON.stringify([]),
      ]
    );
    return toRun({
      id: runId,
      automation_id: args.rule.id,
      chat_session_id: args.chatSessionId ?? null,
      mission_id: args.missionId ?? null,
      worker_run_id: args.workerRunId ?? null,
      worker_agent_id: args.workerAgentId ?? null,
      queue_item_id: args.queueItemId ?? null,
      ingress_event_id: args.ingressEventId ?? args.trigger.ingressEventId ?? null,
      trigger_type: args.trigger.triggerType,
      started_at: startedAt,
      ended_at: null,
      status: runStatus,
      execution_kind: executionKind,
      queue_status: queueStatus,
      executor_mode: args.rule.executor.mode,
      actions_completed: 0,
      actions_total: Math.max(1, args.actionsTotal ?? 1),
      error_message: null,
      verification_required: requiresPublishGate(args.rule) ? 1 : 0,
      spend_usd: 0,
      trigger_metadata: JSON.stringify(triggerMetadata),
      summary: args.summary ?? null,
      confidence_json: confidence ? JSON.stringify(confidence) : null,
      billing_code: args.rule.billingCode,
      linked_procedure_ids_json: JSON.stringify(args.linkedProcedureIds ?? []),
      procedure_feedback_json: JSON.stringify([]),
    });
  };

  const updateRun = (runId: string, patch: Record<string, SqlValue>) => {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const values = keys.map((key) => patch[key] ?? null);
    const clauses = keys.map((key) => `${key} = ?`).join(", ");
    db.run(`update automation_runs set ${clauses} where id = ? and project_id = ?`, [...values, runId, projectId]);
  };

  const insertAction = (runId: string, actionIndex: number, actionType: string): string => {
    const id = randomUUID();
    db.run(
      `
        insert into automation_action_results(
          id,
          project_id,
          run_id,
          action_index,
          action_type,
          started_at,
          ended_at,
          status,
          error_message,
          output
        ) values (?, ?, ?, ?, ?, ?, null, 'running', null, null)
      `,
      [id, projectId, runId, actionIndex, actionType, nowIso()]
    );
    return id;
  };

  const finishAction = (args: { id: string; status: AutomationActionStatus; errorMessage?: string | null; output?: string | null }) => {
    db.run(
      `
        update automation_action_results
        set ended_at = ?, status = ?, error_message = ?, output = ?
        where id = ? and project_id = ?
      `,
      [nowIso(), args.status, args.errorMessage ?? null, args.output ?? null, args.id, projectId]
    );
  };

  const loadRunRow = (runId: string): AutomationRunRow | null => db.get<AutomationRunRow>(
    `
      select
        id, automation_id, chat_session_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, execution_kind, queue_status,
        executor_mode, actions_completed, actions_total, error_message, verification_required, spend_usd,
        trigger_metadata, summary, confidence_json, billing_code, linked_procedure_ids_json, procedure_feedback_json
      from automation_runs
      where project_id = ? and id = ?
      limit 1
    `,
    [projectId, runId]
  );

  const loadQueueItemRow = (queueItemId: string): AutomationQueueItemRow | null => db.get<AutomationQueueItemRow>(
    `
      select
        id, automation_id, run_id, mission_id, position, title, mode, queue_status, trigger_type, summary, severity_summary,
        confidence_json, file_count, spend_usd, verification_required, suggested_actions_json, procedure_signals_json,
        created_at, updated_at
      from automation_queue_items
      where project_id = ? and id = ?
      limit 1
    `,
    [projectId, queueItemId]
  );

  const loadIngressEventRow = (eventId: string): AutomationIngressEventRow | null => db.get<AutomationIngressEventRow>(
    `
      select
        id, source, event_key, automation_ids_json, trigger_type, event_name, status, summary, error_message,
        cursor, raw_payload_json, received_at
      from automation_ingress_events
      where project_id = ? and id = ?
      limit 1
    `,
    [projectId, eventId]
  );

  const loadPendingPublishRow = (runId: string): AutomationPendingPublishRow | null => db.get<AutomationPendingPublishRow>(
    `
      select
        id, run_id, automation_id, queue_item_id, summary, tool_palette_json, continuation_kind, created_at, resolved_at
      from automation_pending_publish
      where project_id = ? and run_id = ? and resolved_at is null
      limit 1
    `,
    [projectId, runId]
  );

  const listRecentIngressEvents = (limit = 20): AutomationIngressEventRecord[] => {
    const rows = db.all<AutomationIngressEventRow>(
      `
        select
          id, source, event_key, automation_ids_json, trigger_type, event_name, status, summary, error_message,
          cursor, raw_payload_json, received_at
        from automation_ingress_events
        where project_id = ?
        order by received_at desc
        limit ?
      `,
      [projectId, Math.max(1, Math.min(100, Math.floor(limit)))]
    );
    return rows.map(toIngressEvent);
  };

  const updateIngressEvent = (eventId: string, patch: Record<string, SqlValue>) => {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    db.run(
      `update automation_ingress_events set ${keys.map((key) => `${key} = ?`).join(", ")} where id = ? and project_id = ?`,
      [...keys.map((key) => patch[key] ?? null), eventId, projectId]
    );
    emit({ type: "ingress-updated" });
  };

  const upsertPendingPublish = (args: { runId: string; automationId: string; queueItemId: string | null; summary: string; toolPalette: AutomationToolFamily[] }) => {
    const existing = loadPendingPublishRow(args.runId);
    if (existing) return existing.id;
    const id = randomUUID();
    db.run(
      `
        insert into automation_pending_publish(
          id, project_id, run_id, automation_id, queue_item_id, summary, tool_palette_json, continuation_kind, created_at, resolved_at
        ) values (?, ?, ?, ?, ?, ?, ?, 'publish', ?, null)
      `,
      [id, projectId, args.runId, args.automationId, args.queueItemId, args.summary, JSON.stringify(args.toolPalette), nowIso()]
    );
    return id;
  };

  const resolvePendingPublish = (runId: string) => {
    db.run(`update automation_pending_publish set resolved_at = ? where project_id = ? and run_id = ? and resolved_at is null`, [nowIso(), projectId, runId]);
  };

  const upsertQueueItem = (args: {
    id?: string | null;
    rule: AutomationRule;
    runId: string | null;
    missionId: string | null;
    queueStatus: AutomationRunQueueStatus;
    triggerType: AutomationTriggerType;
    summary: string | null;
    severitySummary?: string | null;
    confidence: AutomationConfidenceScore | null;
    spendUsd?: number;
    verificationRequired?: boolean;
    procedureSignals?: string[];
  }): string => {
    const queueItemId = args.id?.trim() || randomUUID();
    const timestamp = nowIso();
    const existing = args.id ? loadQueueItemRow(queueItemId) : null;
    const title = `${args.rule.name} · ${args.rule.mode}`;
    if (existing) {
      db.run(
        `
          update automation_queue_items
          set run_id = ?, mission_id = ?, queue_status = ?, summary = ?, severity_summary = ?, confidence_json = ?,
              spend_usd = ?, verification_required = ?, procedure_signals_json = ?, updated_at = ?
          where id = ? and project_id = ?
        `,
        [
          args.runId,
          args.missionId,
          args.queueStatus,
          args.summary,
          args.severitySummary ?? null,
          args.confidence ? JSON.stringify(args.confidence) : null,
          args.spendUsd ?? existing.spend_usd ?? 0,
          args.verificationRequired ? 1 : 0,
          JSON.stringify(args.procedureSignals ?? safeJsonParseArray<string>(existing.procedure_signals_json)),
          timestamp,
          queueItemId,
          projectId,
        ]
      );
    } else {
      db.run(
        `
          insert into automation_queue_items(
            id, project_id, automation_id, run_id, mission_id, position, title, mode, queue_status, trigger_type, summary,
            severity_summary, confidence_json, file_count, spend_usd, verification_required, suggested_actions_json,
            procedure_signals_json, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
        `,
        [
          queueItemId,
          projectId,
          args.rule.id,
          args.runId,
          args.missionId,
          getNextNightShiftPosition(),
          title,
          args.rule.mode,
          args.queueStatus,
          args.triggerType,
          args.summary,
          args.severitySummary ?? null,
          args.confidence ? JSON.stringify(args.confidence) : null,
          args.spendUsd ?? 0,
          args.verificationRequired ? 1 : 0,
          JSON.stringify([args.rule.outputs.disposition]),
          JSON.stringify(args.procedureSignals ?? []),
          timestamp,
          timestamp,
        ]
      );
    }
    return queueItemId;
  };

  const updateQueueItemStatus = (queueItemId: string, queueStatus: AutomationRunQueueStatus) => {
    db.run(
      `update automation_queue_items set queue_status = ?, updated_at = ? where id = ? and project_id = ?`,
      [queueStatus, nowIso(), queueItemId, projectId]
    );
  };

  const buildMissionPrompt = (args: {
    rule: AutomationRule;
    trigger: TriggerContext;
    briefing: Awaited<ReturnType<NonNullable<typeof memoryBriefingServiceRef>["buildBriefing"]>> | null;
  }): string => {
    const lines: string[] = [
      `Automation rule: ${args.rule.name}`,
      `Mode: ${args.rule.mode}`,
      `Review profile: ${args.trigger.reviewProfileOverride ?? args.rule.reviewProfile}`,
      `Executor: ${args.rule.executor.mode}`,
      `Trigger: ${args.trigger.triggerType}`,
    ];
    if (args.trigger.commitSha) lines.push(`Commit SHA: ${args.trigger.commitSha}`);
    if (args.trigger.laneId) lines.push(`Lane ID: ${args.trigger.laneId}`);
    if (args.trigger.eventName) lines.push(`Event: ${args.trigger.eventName}`);
    if (args.trigger.summary) lines.push(`Ingress summary: ${args.trigger.summary}`);
    if (args.rule.prompt?.trim()) {
      lines.push("", args.rule.prompt.trim());
    } else if (args.rule.mode === "review") {
      lines.push("", "Review the latest relevant changes, surface only high-signal findings, and summarize merge readiness.");
    } else if (args.rule.mode === "fix") {
      lines.push("", "Investigate the triggered issue, prepare a fix plan, implement when safe, and leave a concise artifact trail.");
    } else {
      lines.push("", "Monitor the triggered state, summarize notable deltas, and report only meaningful deviations.");
    }
    lines.push("", `Output mode: ${args.rule.outputs.disposition}`);
    if (requiresPublishGate(args.rule)) {
      lines.push("Publish-capable tools are intentionally withheld for this phase. Produce a proposed outcome and wait for queue acceptance before any external side effects.");
    } else if (args.rule.verification.verifyBeforePublish) {
      lines.push("Do not publish external side effects. This rule is running in dry-run verification mode.");
    }
    if (args.briefing) {
      const l0 = args.briefing.l0.entries
        .slice(0, 3)
        .map((memory) => `- ${summarizeMemoryContent(memory.content, memory.category)}`);
      const procedures = args.briefing.l1.entries
        .slice(0, 4)
        .map((memory) => `- ${summarizeMemoryContent(memory.content, memory.category)}`);
      if (l0.length) lines.push("", "Pinned context:", ...l0);
      if (procedures.length) lines.push("", "Relevant procedures:", ...procedures);
    }
    return lines.join("\n");
  };

  const runCommand = async (args: { command: string; cwd: string; timeoutMs: number }): Promise<{ output: string; exitCode: number | null }> => {
    const startedAt = Date.now();
    const child = spawn(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/c", args.command] : ["-lc", args.command], {
      cwd: args.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const MAX = 80_000;
    const onChunk = (chunk: unknown, target: "stdout" | "stderr") => {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (!text) return;
      if (target === "stdout") stdout = clampText(stdout + text, MAX);
      else stderr = clampText(stderr + text, MAX);
    };
    child.stdout?.on("data", (chunk) => onChunk(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => onChunk(chunk, "stderr"));
    const timeoutMs = Math.max(1000, args.timeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const durationMs = Date.now() - startedAt;
    const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
    return {
      output: clampText(`${output}\n\n(duration ${durationMs}ms)`, MAX),
      exitCode
    };
  };

  const runLegacyAction = async (action: AutomationAction, trigger: TriggerContext): Promise<{ status: AutomationActionStatus; output?: string }> => {
    const raw = (action.condition ?? "").trim();
    if (raw === "false") return { status: "skipped", output: "Condition evaluated false." };
    if (raw === "provider-enabled" && (projectConfigService.get().effective.providerMode ?? "guest") === "guest") {
      return { status: "skipped", output: "Provider mode disabled." };
    }
    if (action.type === "predict-conflicts") {
      if (!conflictService) throw new Error("Conflict service unavailable");
      await conflictService.runPrediction(trigger.laneId ? { laneId: trigger.laneId } : {});
      return { status: "succeeded" };
    }
    if (action.type === "run-tests") {
      const suiteId = (action.suiteId ?? "").trim();
      if (!suiteId) throw new Error("run-tests requires suiteId");
      if (!testService) throw new Error("Test service unavailable");
      const activeLanes = await laneService.list({ includeArchived: false });
      const laneId = trigger.laneId
        ? trigger.laneId
        : activeLanes.find((lane) => lane.laneType === "primary")?.id ?? activeLanes[0]?.id ?? null;
      if (!laneId) throw new Error("No lane available to run tests");
      await testService.run({ laneId, suiteId });
      return { status: "succeeded" };
    }
    if (action.type === "run-command") {
      const command = (action.command ?? "").trim();
      if (!command) throw new Error("run-command requires command");
      const laneId = trigger.laneId ?? null;
      const baseCwd = laneId ? laneService.getLaneWorktreePath(laneId) : projectRoot;
      const configuredCwd = (action.cwd ?? "").trim();
      const cwd = configuredCwd.length
        ? path.isAbsolute(configuredCwd)
          ? configuredCwd
          : path.resolve(baseCwd, configuredCwd)
        : baseCwd;
      if (!isWithinDir(baseCwd, cwd)) {
        throw new Error("Unsafe cwd: must stay inside the lane worktree or project root.");
      }
      const { output, exitCode } = await runCommand({ command, cwd, timeoutMs: action.timeoutMs ?? 5 * 60_000 });
      if (exitCode !== 0) return { status: "failed", output: output.length ? output : `Command exited with code ${exitCode}` };
      return { status: "succeeded", output };
    }
    return { status: "skipped", output: `Unknown action type '${action.type}'` };
  };

  const runLegacyRule = async (rule: AutomationRule, trigger: TriggerContext): Promise<AutomationRun> => {
    const actions = rule.execution?.kind === "built-in"
      ? rule.execution.builtIn?.actions ?? []
      : rule.legacy?.actions ?? [];
    const confidence = computeConfidence(rule, 0);
    const run = insertRun({
      rule,
      trigger,
      actionsTotal: actions.length,
      queueStatus: "pending-review",
      confidence,
      summary: summarizeLegacyActions(actions),
    });
    let completed = 0;
    let runStatus: AutomationRunStatus = "succeeded";
    let runError: string | null = null;
    let finalQueueStatus: AutomationRunQueueStatus = "pending-review";
    try {
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index]!;
        const actionId = insertAction(run.id, index, action.type);
        let lastOutput: string | null = null;
        try {
          const maxRetry = Number.isFinite(action.retry) ? Math.max(0, Math.min(5, Math.floor(action.retry ?? 0))) : 0;
          for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
            try {
              const result = await runLegacyAction(action, trigger);
              lastOutput = result.output ?? null;
              if (result.status === "failed") throw new Error(result.output ?? "Action failed");
              finishAction({ id: actionId, status: result.status, output: result.output ?? null });
              break;
            } catch (error) {
              if (attempt >= maxRetry) throw error;
              await new Promise((resolve) => setTimeout(resolve, 400 * Math.pow(2, attempt)));
            }
          }
          completed += 1;
          updateRun(run.id, { actions_completed: completed });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          finishAction({ id: actionId, status: "failed", errorMessage: message, output: lastOutput });
          completed += 1;
          updateRun(run.id, { actions_completed: completed });
          runStatus = "failed";
          runError = message;
          if (!action.continueOnFailure) break;
        }
      }
    } finally {
      finalQueueStatus = deriveQueueStatus({
        current: "pending-review",
        runStatus,
        verificationRequired: requiresPublishGate(rule),
        mode: rule.mode,
        summary: runError,
      });
      updateRun(run.id, {
        ended_at: nowIso(),
        status: runStatus,
        error_message: runError,
        queue_status: finalQueueStatus,
      });
      emit({ type: "runs-updated", automationId: rule.id, runId: run.id });
    }
    return toRun(loadRunRow(run.id) ?? {
      id: run.id,
      automation_id: rule.id,
      chat_session_id: null,
      mission_id: null,
      worker_run_id: null,
      worker_agent_id: null,
      queue_item_id: null,
      ingress_event_id: trigger.ingressEventId ?? null,
      trigger_type: trigger.triggerType,
      started_at: run.startedAt,
      ended_at: nowIso(),
      status: runStatus,
      execution_kind: resolveExecutionKind(rule),
      queue_status: finalQueueStatus,
      executor_mode: rule.executor.mode,
      actions_completed: completed,
      actions_total: actions.length,
      error_message: runError,
      verification_required: requiresPublishGate(rule) ? 1 : 0,
      spend_usd: 0,
      trigger_metadata: JSON.stringify(buildTriggerMetadata(trigger)),
      summary: summarizeLegacyActions(actions),
      confidence_json: JSON.stringify(confidence),
      billing_code: rule.billingCode,
      linked_procedure_ids_json: JSON.stringify([]),
      procedure_feedback_json: JSON.stringify([]),
    });
  };

  const buildBriefing = async (rule: AutomationRule, trigger: TriggerContext) => {
    if (!memoryBriefingServiceRef) return null;
    try {
      return await memoryBriefingServiceRef.buildBriefing({
        projectId,
        laneId: trigger.laneId,
        includeAgentMemory: false,
        taskDescription: `${rule.mode}:${rule.name}`,
        phaseContext: `automation:${rule.reviewProfile}`,
        filePatterns: rule.contextSources
          .filter((source) => source.type === "path-rules" && typeof source.path === "string")
          .map((source) => source.path!)
      } as never);
    } catch (error) {
      logger.warn("automations.briefing_failed", {
        automationId: rule.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const resolveExecutionLaneId = async (rule: AutomationRule, trigger: TriggerContext): Promise<string | null> => {
    const triggerLaneId = typeof trigger.laneId === "string" && trigger.laneId.trim().length
      ? trigger.laneId.trim()
      : null;
    if (triggerLaneId) return triggerLaneId;

    const configuredLaneId = typeof rule.execution?.targetLaneId === "string" && rule.execution.targetLaneId.trim().length
      ? rule.execution.targetLaneId.trim()
      : null;
    if (configuredLaneId) return configuredLaneId;

    try {
      const lanes = await laneService.list({ includeArchived: false });
      const primaryLane = lanes.find((lane) => lane.laneType === "primary");
      return primaryLane?.id ?? lanes[0]?.id ?? null;
    } catch {
      return null;
    }
  };

  const dispatchAgentSessionRun = async (args: {
    rule: AutomationRule;
    trigger: TriggerContext;
    existingRunId?: string | null;
  }): Promise<AutomationRun> => {
    if (!agentChatServiceRef) {
      throw new Error("Agent chat service is unavailable");
    }

    const laneId = await resolveExecutionLaneId(args.rule, args.trigger);
    if (!laneId) {
      throw new Error("No lane is available for this automation run.");
    }

    const briefing = await buildBriefing(args.rule, args.trigger);
    const linkedProcedureIds = briefing?.usedProcedureIds ?? [];
    const confidence = computeConfidence(args.rule, linkedProcedureIds.length);
    const prompt = buildMissionPrompt({ rule: args.rule, trigger: args.trigger, briefing });
    const existingRunRow = args.existingRunId ? loadRunRow(args.existingRunId) : null;
    const run = existingRunRow
      ? toRun(existingRunRow)
      : insertRun({
          rule: args.rule,
          trigger: args.trigger,
          actionsTotal: 1,
          confidence,
          linkedProcedureIds,
          summary: args.rule.prompt?.trim() || `${args.rule.name} agent session dispatched`,
          ingressEventId: args.trigger.ingressEventId ?? null,
        });

    const actionId = insertAction(run.id, 0, "agent-session");
    const modelId = args.rule.modelConfig?.orchestratorModel?.modelId ?? DEFAULT_AUTOMATION_CHAT_MODEL_ID;
    const reasoningEffort = args.rule.execution?.session?.reasoningEffort ?? args.rule.modelConfig?.orchestratorModel?.thinkingLevel ?? null;
    const timeoutMs = Math.max(
      15_000,
      Math.floor((args.rule.guardrails.maxDurationMin ?? 10) * 60_000),
    );

    let sessionId: string | null = null;

    try {
      const session = await agentChatServiceRef.createSession({
        laneId,
        provider: "unified",
        model: modelId,
        modelId,
        sessionProfile: "workflow",
        reasoningEffort,
        permissionMode: "full-auto",
        surface: "automation",
        automationId: args.rule.id,
        automationRunId: run.id,
      });
      sessionId = session.id;
      updateRun(run.id, {
        chat_session_id: session.id,
        status: "running",
        summary: args.rule.execution?.session?.title?.trim() || args.rule.prompt?.trim() || `${args.rule.name} automation chat started`,
        confidence_json: JSON.stringify(confidence),
        linked_procedure_ids_json: JSON.stringify(linkedProcedureIds),
      });

      const result = await agentChatServiceRef.runSessionTurn({
        sessionId: session.id,
        text: prompt,
        displayText: args.rule.prompt?.trim() || args.rule.name,
        reasoningEffort,
        timeoutMs,
      });

      finishAction({
        id: actionId,
        status: "succeeded",
        output: result.outputText || `Automation chat session ${session.id} completed.`,
      });
      updateRun(run.id, {
        ended_at: nowIso(),
        status: "succeeded",
        queue_status: deriveQueueStatus({
          current: "pending-review",
          runStatus: "succeeded",
          verificationRequired: false,
          mode: args.rule.mode,
          summary: result.outputText,
        }),
        actions_completed: 1,
        error_message: null,
        chat_session_id: session.id,
        summary: result.outputText?.trim() || args.rule.prompt?.trim() || `${args.rule.name} completed`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishAction({
        id: actionId,
        status: "failed",
        errorMessage: message,
        output: sessionId ? `Automation chat session ${sessionId} failed.` : null,
      });
      updateRun(run.id, {
        ended_at: nowIso(),
        status: "failed",
        queue_status: deriveQueueStatus({
          current: "pending-review",
          runStatus: "failed",
          verificationRequired: false,
          mode: args.rule.mode,
          summary: message,
        }),
        actions_completed: 1,
        error_message: message,
        ...(sessionId ? { chat_session_id: sessionId } : {}),
      });
      emit({ type: "runs-updated", automationId: args.rule.id, runId: run.id });
      throw error;
    }

    emit({ type: "runs-updated", automationId: args.rule.id, runId: run.id });
    return toRun(loadRunRow(run.id) ?? {
      id: run.id,
      automation_id: args.rule.id,
      chat_session_id: sessionId,
      mission_id: null,
      worker_run_id: null,
      worker_agent_id: null,
      queue_item_id: null,
      ingress_event_id: args.trigger.ingressEventId ?? null,
      trigger_type: args.trigger.triggerType,
      started_at: run.startedAt,
      ended_at: nowIso(),
      status: "succeeded",
      execution_kind: "agent-session",
      queue_status: "completed-clean",
      executor_mode: args.rule.executor.mode,
      actions_completed: 1,
      actions_total: 1,
      error_message: null,
      verification_required: 0,
      spend_usd: 0,
      trigger_metadata: JSON.stringify(buildTriggerMetadata(args.trigger)),
      summary: args.rule.prompt?.trim() || `${args.rule.name} completed`,
      confidence_json: JSON.stringify(confidence),
      billing_code: args.rule.billingCode,
      linked_procedure_ids_json: JSON.stringify(linkedProcedureIds),
      procedure_feedback_json: JSON.stringify([]),
    });
  };

  const dispatchMissionRun = async (args: {
    rule: AutomationRule;
    trigger: TriggerContext;
    existingRunId?: string | null;
    existingQueueItemId?: string | null;
    queuedFromNightShift?: boolean;
    publishPhase?: boolean;
  }): Promise<AutomationRun> => {
    if (!missionServiceRef || !aiOrchestratorServiceRef) {
      throw new Error("Mission automation services are unavailable");
    }
    const briefing = await buildBriefing(args.rule, args.trigger);
    const linkedProcedureIds = briefing?.usedProcedureIds ?? [];
    const confidence = computeConfidence(args.rule, linkedProcedureIds.length);
    const permissionConfig = buildPermissionConfig(args.rule, { publishPhase: Boolean(args.publishPhase) });
    const budgetScope = AUTOMATION_SCOPE;
    const budgetCheck = budgetCapServiceRef?.checkBudget(budgetScope as Parameters<NonNullable<typeof budgetCapServiceRef>["checkBudget"]>[0], args.rule.id, "any");
    if (budgetCheck && !budgetCheck.allowed) {
      throw new Error(budgetCheck.reason ?? "Budget cap blocked automation run.");
    }

    const prompt = buildMissionPrompt({ rule: args.rule, trigger: args.trigger, briefing });
    const mission = missionServiceRef.create({
      title: `${args.rule.name} · ${args.rule.mode}`,
      prompt,
      laneId: args.trigger.laneId ?? null,
      autostart: false,
      launchMode: "autopilot",
      autopilotExecutor: "unified",
      priority: args.rule.mode === "fix" ? "high" : "normal",
      employeeAgentId: null,
      ...(args.rule.modelConfig ? { modelConfig: args.rule.modelConfig } : {}),
      permissionConfig,
    });

    missionServiceRef.patchMetadata(mission.id, {
      automation: {
        ruleId: args.rule.id,
        mode: args.rule.mode,
        reviewProfile: args.trigger.reviewProfileOverride ?? args.rule.reviewProfile,
        executorMode: "automation-bot",
        billingCode: args.rule.billingCode,
        trigger: buildTriggerMetadata(args.trigger),
        outputs: args.rule.outputs,
        verification: args.rule.verification,
        toolPalette: args.rule.toolPalette,
        allowedTools: computeAllowedToolList(args.rule, { publishPhase: Boolean(args.publishPhase) }),
        contextSources: args.rule.contextSources,
        memory: args.rule.memory,
        usedProcedureIds: linkedProcedureIds,
        confidence,
        publishPhase: Boolean(args.publishPhase),
      },
      launch: {
        automation: {
          ruleId: args.rule.id,
          executorMode: "automation-bot",
          reviewProfile: args.trigger.reviewProfileOverride ?? args.rule.reviewProfile,
          verboseTrace: Boolean(args.trigger.verboseTrace),
          queueStatus: "pending-review",
        }
      }
    });

    const existingRunRow = args.existingRunId ? loadRunRow(args.existingRunId) : null;
    const run = existingRunRow
      ? toRun(existingRunRow)
      : insertRun({
          rule: args.rule,
          trigger: args.trigger,
          actionsTotal: 1,
          queueStatus: "pending-review",
          confidence,
          linkedProcedureIds,
          summary: args.rule.prompt?.trim() || `${args.rule.mode} automation dispatched`,
          missionId: mission.id,
          queueItemId: args.existingQueueItemId ?? null,
          ingressEventId: args.trigger.ingressEventId ?? null,
        });

    if (args.existingRunId) {
      updateRun(args.existingRunId, {
        mission_id: mission.id,
        status: "running",
        queue_status: "pending-review",
        summary: args.rule.prompt?.trim() || `${args.rule.mode} automation dispatched`,
        confidence_json: JSON.stringify(confidence),
        linked_procedure_ids_json: JSON.stringify(linkedProcedureIds),
        verification_required: requiresPublishGate(args.rule) && !args.publishPhase ? 1 : 0,
        billing_code: args.rule.billingCode,
      });
    }

    const dispatchActionId = insertAction(run.id, 0, "launch-mission");
    finishAction({
      id: dispatchActionId,
      status: "succeeded",
      output: `Mission ${mission.id} started for automation dispatch.`,
    });
    updateRun(run.id, {
      actions_completed: 1,
      mission_id: mission.id,
      queue_item_id: args.existingQueueItemId ?? null,
    });

    const queueItemId = upsertQueueItem({
      id: args.existingQueueItemId ?? null,
      rule: args.rule,
      runId: run.id,
      missionId: mission.id,
      queueStatus: "pending-review",
      triggerType: args.trigger.triggerType,
      summary: args.rule.prompt?.trim() || `${args.rule.mode} automation dispatched`,
      severitySummary: args.rule.mode === "review" ? "Awaiting review output" : "Awaiting mission completion",
      confidence,
      spendUsd: 0,
      verificationRequired: requiresPublishGate(args.rule) && !args.publishPhase,
      procedureSignals: linkedProcedureIds.map((id) => `Using learned procedure ${id}`),
    });
    updateRun(run.id, { queue_item_id: queueItemId });

    if (requiresPublishGate(args.rule) && !args.publishPhase) {
      upsertPendingPublish({
        runId: run.id,
        automationId: args.rule.id,
        queueItemId,
        summary: args.trigger.summary?.trim() || `Review ${args.rule.name} before enabling publish-capable tools.`,
        toolPalette: args.rule.toolPalette.filter((family) => PUBLISH_CAPABLE_TOOL_FAMILIES.has(family)),
      });
      updateQueueItemStatus(queueItemId, "verification-required");
      updateRun(run.id, { queue_status: "verification-required" });
    } else if (args.publishPhase) {
      resolvePendingPublish(run.id);
    }

    await aiOrchestratorServiceRef.startMissionRun({
      missionId: mission.id,
      runMode: "autopilot",
      defaultExecutorKind: "unified",
      autopilotOwnerId: "automation-bot",
    });

    emit({ type: "runs-updated", automationId: args.rule.id, runId: run.id });
    return toRun(loadRunRow(run.id) ?? {
      id: run.id,
      automation_id: args.rule.id,
      chat_session_id: null,
      mission_id: mission.id,
      worker_run_id: null,
      worker_agent_id: null,
      queue_item_id: queueItemId,
      ingress_event_id: args.trigger.ingressEventId ?? null,
      trigger_type: args.trigger.triggerType,
      started_at: run.startedAt,
      ended_at: null,
      status: "running",
      execution_kind: resolveExecutionKind(args.rule),
      queue_status: "pending-review",
      executor_mode: args.rule.executor.mode,
      actions_completed: 1,
      actions_total: 1,
      error_message: null,
      verification_required: requiresPublishGate(args.rule) && !args.publishPhase ? 1 : 0,
      spend_usd: 0,
      trigger_metadata: JSON.stringify(buildTriggerMetadata(args.trigger)),
      summary: args.rule.prompt?.trim() || `${args.rule.mode} automation dispatched`,
      confidence_json: JSON.stringify(confidence),
      billing_code: args.rule.billingCode,
      linked_procedure_ids_json: JSON.stringify(linkedProcedureIds),
      procedure_feedback_json: JSON.stringify([]),
    });
  };

  const runRule = async (rule: AutomationRule, trigger: TriggerContext): Promise<AutomationRun> => {
    if (projectConfigService.get().trust.requiresSharedTrust) {
      throw new Error("Shared config is untrusted. Confirm trust to run automations.");
    }
    if (inFlightByAutomationId.has(rule.id)) {
      const existing = db.get<AutomationRunRow>(
        `select
          id, automation_id, chat_session_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, execution_kind, queue_status,
          executor_mode, actions_completed, actions_total, error_message, verification_required, spend_usd,
          trigger_metadata, summary, confidence_json, billing_code, linked_procedure_ids_json, procedure_feedback_json
         from automation_runs
         where project_id = ? and automation_id = ?
         order by started_at desc
         limit 1`,
        [projectId, rule.id]
      );
      if (existing) return toRun(existing);
    }
    inFlightByAutomationId.add(rule.id);
    try {
      const executionKind = resolveExecutionKind(rule);
      if (executionKind === "agent-session") return await dispatchAgentSessionRun({ rule, trigger });
      if (executionKind === "built-in") return await runLegacyRule(rule, trigger);
      return await dispatchMissionRun({ rule, trigger });
    } finally {
      inFlightByAutomationId.delete(rule.id);
    }
  };

  const resolveTriggerLaneInfo = async (trigger: TriggerContext): Promise<{ laneBranch: string | undefined; laneName: string | undefined }> => {
    let laneBranch = trigger.branch;
    let laneName = trigger.laneName;
    if (trigger.laneId && (!laneBranch || !laneName)) {
      try {
        const lane = laneService.getLaneBaseAndBranch(trigger.laneId);
        laneBranch = laneBranch ?? lane.branchRef;
      } catch {
        // ignore
      }
      if (!laneName) {
        try {
          const lanes = await laneService.list({ includeArchived: true, includeStatus: false });
          const found = lanes.find((entry) => entry.id === trigger.laneId);
          laneName = found?.name ?? undefined;
        } catch {
          // ignore
        }
      }
    }
    return { laneBranch, laneName };
  };

  const triggerMatches = (ruleTrigger: AutomationTrigger, trigger: TriggerContext, laneBranch: string | undefined, laneName: string | undefined): boolean => {
    if (!triggerTypesMatch(ruleTrigger.type, trigger.triggerType)) return false;

    const canonicalType = normalizeTriggerType(ruleTrigger.type);
    if (canonicalType === "git.pr_merged") {
      const expectedTarget = (ruleTrigger.targetBranch ?? ruleTrigger.branch ?? "").trim();
      if (expectedTarget && !matchesGlob(expectedTarget, trigger.targetBranch)) return false;
    } else if (ruleTrigger.branch?.trim()) {
      const branchToMatch =
        canonicalType === "git.pr_opened" || canonicalType === "git.pr_updated" || canonicalType === "git.pr_closed"
          ? trigger.branch
          : laneBranch;
      if (!matchesGlob(ruleTrigger.branch, branchToMatch)) return false;
    }
    if (ruleTrigger.event?.trim() && ruleTrigger.event.trim() !== (trigger.eventName ?? "").trim()) return false;
    if (ruleTrigger.author?.trim()) {
      const author = (trigger.author ?? "").trim().toLowerCase();
      if (!author || author !== ruleTrigger.author.trim().toLowerCase()) return false;
    }
    if (!listMatches(ruleTrigger.labels, trigger.labels)) return false;
    if (ruleTrigger.paths?.length) {
      const paths = trigger.paths ?? [];
      if (!paths.some((entry) => ruleTrigger.paths?.some((expected) => matchesGlob(expected, entry)))) return false;
    }
    if (ruleTrigger.keywords?.length) {
      const haystack = `${trigger.summary ?? ""} ${(trigger.keywords ?? []).join(" ")}`.toLowerCase();
      if (!ruleTrigger.keywords.some((entry) => haystack.includes(entry.trim().toLowerCase()))) return false;
    }
    if (ruleTrigger.namePattern?.trim() && !matchesGlob(ruleTrigger.namePattern, laneName)) return false;
    if (ruleTrigger.project?.trim() && !matchesGlob(ruleTrigger.project, trigger.project)) return false;
    if (ruleTrigger.team?.trim() && !matchesGlob(ruleTrigger.team, trigger.team)) return false;
    if (ruleTrigger.assignee?.trim() && !matchesGlob(ruleTrigger.assignee, trigger.assignee)) return false;
    if (ruleTrigger.stateTransition?.trim() && (trigger.stateTransition ?? "").trim() !== ruleTrigger.stateTransition.trim()) return false;
    if (!listMatches(ruleTrigger.changedFields, trigger.changedFields)) return false;
    if (ruleTrigger.draftState && ruleTrigger.draftState !== "any" && trigger.draftState && ruleTrigger.draftState !== trigger.draftState) {
      return false;
    }
    if (ruleTrigger.activeHours && !isWithinActiveHours(ruleTrigger.activeHours)) return false;
    return true;
  };

  const dispatchTrigger = async (trigger: TriggerContext) => {
    const rules = listRules().filter((rule) => rule.enabled);
    const { laneBranch, laneName } = await resolveTriggerLaneInfo(trigger);
    for (const rule of rules) {
      const matches = rule.triggers.map((candidate) => triggerMatches(candidate, trigger, laneBranch, laneName));
      if (!matches.some(Boolean)) continue;
      void runRule(rule, trigger).catch((error) => {
        logger.warn("automations.run.failed", {
          automationId: rule.id,
          triggerType: trigger.triggerType,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  };

  const listWatchedFileRoots = async (): Promise<WatchedFileRoot[]> => {
    const normalizedProjectRoot = path.resolve(projectRoot);
    const lanes = await laneService.list({ includeArchived: false, includeStatus: false }).catch(() => []);
    const seen = new Set<string>();
    const roots: WatchedFileRoot[] = [];
    for (const lane of lanes) {
      const rootPath = path.resolve(lane.worktreePath);
      if (!rootPath || seen.has(rootPath)) continue;
      seen.add(rootPath);
      roots.push({
        key: lane.id,
        laneId: lane.id,
        laneName: lane.name,
        rootPath,
        branchRef: lane.branchRef,
      });
    }
    if (!seen.has(normalizedProjectRoot)) {
      roots.push({ key: "project-root", rootPath: normalizedProjectRoot });
    }
    return roots;
  };

  const syncFileWatchers = async () => {
    const hasFileTriggers = listRules().some((rule) =>
      rule.enabled && rule.triggers.some((trigger) => normalizeTriggerType(trigger.type) === "file.change")
    );
    if (!hasFileTriggers) {
      for (const [key, watcher] of fileWatchers.entries()) {
        void watcher.close().catch(() => {});
        fileWatchers.delete(key);
      }
      return;
    }

    const desired = await listWatchedFileRoots();
    const desiredKeys = new Set(desired.map((entry) => entry.key));
    for (const [key, watcher] of fileWatchers.entries()) {
      if (desiredKeys.has(key)) continue;
      void watcher.close().catch(() => {});
      fileWatchers.delete(key);
    }

    for (const root of desired) {
      if (fileWatchers.has(root.key)) continue;
      const watcher = chokidar.watch(root.rootPath, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 120,
          pollInterval: 50,
        },
        ignored: [
          /(^|[/\\])\.git($|[/\\])/,
          /(^|[/\\])node_modules($|[/\\])/,
          /(^|[/\\])\.ade($|[/\\])/,
        ],
      });
      const onFileEvent = (kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir", absPath: string) => {
        const relPath = path.relative(root.rootPath, absPath).split(path.sep).join("/");
        if (!relPath || relPath.startsWith(".git/") || relPath.startsWith("node_modules/") || relPath.startsWith(".ade/")) return;
        void dispatchTrigger({
          triggerType: "file.change",
          laneId: root.laneId,
          laneName: root.laneName,
          branch: root.branchRef,
          paths: [relPath],
          keywords: [kind],
          summary: `${kind} ${relPath}`,
          reason: kind,
          scheduledAt: nowIso(),
        });
      };
      watcher.on("error", () => {
        // EMFILE or other watcher error — close gracefully
        fileWatchers.delete(root.key);
        void watcher.close().catch(() => {});
      });
      watcher.on("add", (absPath) => onFileEvent("add", absPath));
      watcher.on("change", (absPath) => onFileEvent("change", absPath));
      watcher.on("unlink", (absPath) => onFileEvent("unlink", absPath));
      watcher.on("addDir", (absPath) => onFileEvent("addDir", absPath));
      watcher.on("unlinkDir", (absPath) => onFileEvent("unlinkDir", absPath));
      fileWatchers.set(root.key, watcher);
    }
  };

  const syncFromConfig = () => {
    const rules = listRules();
    const desired = new Set<string>();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      rule.triggers.forEach((trigger, index) => {
        if (trigger.type !== "schedule") return;
        const cronExpr = (trigger.cron ?? "").trim();
        if (!cronExpr || !cron.validate(cronExpr)) {
          if (cronExpr) logger.warn("automations.schedule.invalid_cron", { automationId: rule.id, cron: cronExpr });
          return;
        }
        const key = `${rule.id}:${index}`;
        desired.add(key);
        if (scheduleTasks.has(key)) return;
        const task = cron.schedule(cronExpr, () => {
          void runRule(rule, { triggerType: "schedule", scheduledAt: nowIso(), reason: rule.id }).catch(() => {});
        });
        scheduleTasks.set(key, { stop: () => task.stop() });
      });
    }
    for (const [key, task] of scheduleTasks.entries()) {
      if (desired.has(key)) continue;
      try {
        task.stop();
      } catch {
        // ignore
      }
      scheduleTasks.delete(key);
    }
    void syncFileWatchers().catch((error) => {
      logger.warn("automations.file_watch.sync_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const persistProcedureFeedback = async (runRow: AutomationRunRow, missionStatus: string, summary: string | null) => {
    const existing = safeJsonParseArray<AutomationProcedureFeedback>(runRow.procedure_feedback_json);
    if (existing.length > 0) return existing;
    const linkedProcedureIds = safeJsonParseArray<string>(runRow.linked_procedure_ids_json);
    if (!linkedProcedureIds.length) return [];
    const outcome = missionStatus === "completed" ? "success" : missionStatus === "failed" ? "failure" : "observation";
    const reason = summary?.trim() || (missionStatus === "completed" ? "Automation mission completed." : "Automation mission ended.");
    const feedback = linkedProcedureIds.map((procedureId) => ({ procedureId, outcome, reason }));
    const normalizedFeedback = feedback.map((item) => ({
      memoryId: item.procedureId,
      outcome: item.outcome === "failure" ? "failure" as const : "success" as const,
      reason: item.reason,
    }));
    try {
      proceduralLearningServiceRef?.updateProcedureOutcomes?.(normalizedFeedback);
    } catch {
      // ignore
    }
    updateRun(runRow.id, { procedure_feedback_json: JSON.stringify(feedback) });
    return feedback;
  };

  const syncMissionRun = async (missionId: string) => {
    if (!missionServiceRef) return;
    const runRow = db.get<AutomationRunRow>(
      `
        select
          id, automation_id, chat_session_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, execution_kind, queue_status,
          executor_mode, actions_completed, actions_total, error_message, verification_required, spend_usd,
          trigger_metadata, summary, confidence_json, billing_code, linked_procedure_ids_json, procedure_feedback_json
        from automation_runs
        where project_id = ? and mission_id = ?
        order by started_at desc
        limit 1
      `,
      [projectId, missionId]
    );
    if (!runRow) return;
    const mission = missionServiceRef.get(missionId);
    if (!mission) return;
    const verificationRequired = Boolean(runRow.verification_required ?? 0);
    const nextStatus = mapMissionStatus(mission.status, verificationRequired);
    const nextSummary = mission.outcomeSummary?.trim() || runRow.summary || null;
    const rule = findRule(runRow.automation_id);
    const nextQueueStatus = deriveQueueStatus({
      current: normalizeQueueStatus(runRow.queue_status, "pending-review"),
      runStatus: nextStatus,
      verificationRequired,
      mode: rule?.mode ?? "review",
      summary: nextSummary,
    });
    if (
      nextStatus !== normalizeRunStatus(runRow.status, "running") ||
      nextQueueStatus !== normalizeQueueStatus(runRow.queue_status, "pending-review") ||
      nextSummary !== (runRow.summary ?? null)
    ) {
      updateRun(runRow.id, {
        status: nextStatus,
        queue_status: nextQueueStatus,
        summary: nextSummary,
        ended_at: nextStatus === "running" || nextStatus === "queued" ? null : (mission.completedAt ?? nowIso()),
        error_message: mission.lastError ?? runRow.error_message,
      });
      if (runRow.queue_item_id) {
        upsertQueueItem({
          id: runRow.queue_item_id,
          rule: rule ?? {
            id: runRow.automation_id,
            name: runRow.automation_id,
            enabled: true,
            mode: "review",
            triggers: [{ type: runRow.trigger_type as AutomationTriggerType }],
            trigger: { type: runRow.trigger_type as AutomationTriggerType },
            executor: { mode: "automation-bot" },
            reviewProfile: "quick",
            toolPalette: ["repo", "memory", "mission"],
            contextSources: [],
            memory: { mode: "automation-plus-project", ruleScopeKey: runRow.automation_id },
            guardrails: {},
            outputs: { disposition: "comment-only", createArtifact: true },
            verification: { verifyBeforePublish: verificationRequired, mode: "intervention" },
            billingCode: `auto:${runRow.automation_id}`,
            actions: [],
          },
          runId: runRow.id,
          missionId,
          queueStatus: nextQueueStatus,
          triggerType: runRow.trigger_type as AutomationTriggerType,
          summary: nextSummary,
          severitySummary: mission.lastError ? mission.lastError : nextStatus === "succeeded" ? "Mission completed" : "Mission paused",
          confidence: normalizeConfidence(safeJsonParse(runRow.confidence_json ?? "null", null)),
          spendUsd: Number(runRow.spend_usd ?? 0),
          verificationRequired,
          procedureSignals: safeJsonParseArray<string>(runRow.linked_procedure_ids_json).map((id) => `Procedure ${id} used`),
        });
      }
      if (mission.status === "completed" || mission.status === "failed" || mission.status === "canceled") {
        await persistProcedureFeedback(runRow, mission.status, nextSummary);
      }
      emit({ type: "runs-updated", automationId: runRow.automation_id, runId: runRow.id });
    }
  };

  const syncWorkerRun = async (workerRunId: string) => {
    if (!workerHeartbeatServiceRef) return;
    const runRow = db.get<AutomationRunRow>(
      `
        select
          id, automation_id, chat_session_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, execution_kind, queue_status,
          executor_mode, actions_completed, actions_total, error_message, verification_required, spend_usd,
          trigger_metadata, summary, confidence_json, billing_code, linked_procedure_ids_json, procedure_feedback_json
        from automation_runs
        where project_id = ? and worker_run_id = ?
        order by started_at desc
        limit 1
      `,
      [projectId, workerRunId]
    );
    if (!runRow) return;
    const workerRun = workerHeartbeatServiceRef
      .listRuns({ agentId: runRow.worker_agent_id ?? undefined, limit: 500 })
      .find((entry) => entry.id === workerRunId);
    if (!workerRun) return;
    const rule = findRule(runRow.automation_id);
    const verificationRequired = Boolean(runRow.verification_required ?? 0);
    const nextStatus = mapWorkerStatus(workerRun.status, verificationRequired);
    const nextSummary = typeof workerRun.result?.summary === "string"
      ? workerRun.result.summary
      : typeof workerRun.result?.output === "string"
        ? workerRun.result.output
        : runRow.summary ?? null;
    const nextQueueStatus = deriveQueueStatus({
      current: normalizeQueueStatus(runRow.queue_status, "pending-review"),
      runStatus: nextStatus,
      verificationRequired,
      mode: rule?.mode ?? "review",
      summary: nextSummary,
    });
    updateRun(runRow.id, {
      status: nextStatus,
      queue_status: nextQueueStatus,
      summary: nextSummary,
      ended_at: nextStatus === "running" || nextStatus === "queued" ? null : (workerRun.finishedAt ?? nowIso()),
      error_message: workerRun.errorMessage ?? null,
    });
    if (runRow.queue_item_id) {
      upsertQueueItem({
        id: runRow.queue_item_id,
        rule: rule ?? {
          id: runRow.automation_id,
          name: runRow.automation_id,
          enabled: true,
          mode: "review",
          triggers: [{ type: runRow.trigger_type as AutomationTriggerType }],
          trigger: { type: runRow.trigger_type as AutomationTriggerType },
          executor: { mode: "automation-bot" },
          reviewProfile: "quick",
          toolPalette: ["repo", "memory", "mission"],
          contextSources: [],
          memory: { mode: "automation-plus-project", ruleScopeKey: runRow.automation_id },
          guardrails: {},
          outputs: { disposition: "comment-only", createArtifact: true },
          verification: { verifyBeforePublish: verificationRequired, mode: "intervention" },
          billingCode: runRow.billing_code ?? `auto:${runRow.automation_id}`,
          actions: [],
        },
        runId: runRow.id,
        missionId: null,
        queueStatus: nextQueueStatus,
        triggerType: runRow.trigger_type as AutomationTriggerType,
        summary: nextSummary,
        severitySummary: workerRun.errorMessage ?? (nextStatus === "succeeded" ? "Worker completed" : "Worker active"),
        confidence: normalizeConfidence(safeJsonParse(runRow.confidence_json ?? "null", null)),
        spendUsd: Number(runRow.spend_usd ?? 0),
        verificationRequired,
        procedureSignals: safeJsonParseArray<string>(runRow.linked_procedure_ids_json),
      });
    }
    if (workerRun.status === "completed" || workerRun.status === "failed" || workerRun.status === "cancelled") {
      await persistProcedureFeedback(runRow, workerRun.status === "completed" ? "completed" : "failed", nextSummary);
    }
    emit({ type: "runs-updated", automationId: runRow.automation_id, runId: runRow.id });
  };

  const upsertIngressCursor = (source: AutomationIngressSource, cursor: string | null) => {
    db.run(
      `
        insert into automation_ingress_cursors(project_id, source, cursor, updated_at)
        values (?, ?, ?, ?)
        on conflict(project_id, source) do update set cursor = excluded.cursor, updated_at = excluded.updated_at
      `,
      [projectId, source, cursor, nowIso()]
    );
  };

  const getIngressCursor = (source: AutomationIngressSource): string | null => {
    const row = db.get<{ cursor: string | null }>(
      `select cursor from automation_ingress_cursors where project_id = ? and source = ? limit 1`,
      [projectId, source]
    );
    return row?.cursor ?? null;
  };

  const dispatchIngressTrigger = async (args: {
    source: AutomationIngressSource;
    eventKey: string;
    triggerType: AutomationTriggerType;
    eventName?: string | null;
    summary?: string | null;
    author?: string | null;
    labels?: string[];
    paths?: string[];
    keywords?: string[];
    draftState?: "draft" | "ready" | "any";
    cursor?: string | null;
    rawPayload?: Record<string, unknown> | null;
    automationId?: string | null;
  }): Promise<AutomationIngressEventRecord | null> => {
    const eventKey = args.eventKey.trim();
    if (!eventKey.length) return null;
    const existing = db.get<AutomationIngressEventRow>(
      `
        select
          id, source, event_key, automation_ids_json, trigger_type, event_name, status, summary, error_message,
          cursor, raw_payload_json, received_at
        from automation_ingress_events
        where project_id = ? and source = ? and event_key = ?
        limit 1
      `,
      [projectId, args.source, eventKey]
    );
    if (existing) return toIngressEvent(existing);

    const eventId = randomUUID();
    const receivedAt = nowIso();
    db.run(
      `
        insert into automation_ingress_events(
          id, project_id, source, event_key, automation_ids_json, trigger_type, event_name, status, summary, error_message, cursor, raw_payload_json, received_at
        ) values (?, ?, ?, ?, '[]', ?, ?, 'received', ?, null, ?, ?, ?)
      `,
      [
        eventId,
        projectId,
        args.source,
        eventKey,
        args.triggerType,
        args.eventName ?? null,
        args.summary ?? null,
        args.cursor ?? null,
        args.rawPayload ? JSON.stringify(args.rawPayload) : null,
        receivedAt,
      ]
    );
    if (args.cursor) upsertIngressCursor(args.source, args.cursor);

    const trigger: TriggerContext = {
      triggerType: args.triggerType,
      ingressEventId: eventId,
      ingressSource: args.source,
      ingressEventKey: eventKey,
      eventName: args.eventName ?? undefined,
      summary: args.summary ?? undefined,
      author: args.author ?? undefined,
      labels: args.labels,
      paths: args.paths,
      keywords: args.keywords,
      draftState: args.draftState,
      reason: args.eventName ?? eventKey,
      scheduledAt: receivedAt,
    };

    const candidateRules = listRules()
      .filter((rule) => rule.enabled)
      .filter((rule) => !args.automationId || rule.id === args.automationId);
    const { laneBranch: ingressLaneBranch, laneName: ingressLaneName } = await resolveTriggerLaneInfo(trigger);
    const matched: AutomationRule[] = [];
    for (const rule of candidateRules) {
      const matches = rule.triggers.map((candidate) => triggerMatches(candidate, trigger, ingressLaneBranch, ingressLaneName));
      if (matches.some(Boolean)) matched.push(rule);
    }
    if (!matched.length) {
      updateIngressEvent(eventId, {
        automation_ids_json: JSON.stringify([]),
        status: "ignored",
        summary: args.summary ?? "Ingress delivery did not match any enabled automation rules.",
        cursor: args.cursor ?? null,
      });
      return loadIngressEventRow(eventId) ? toIngressEvent(loadIngressEventRow(eventId)!) : null;
    }

    updateIngressEvent(eventId, {
      automation_ids_json: JSON.stringify(matched.map((rule) => rule.id)),
      status: "dispatched",
      cursor: args.cursor ?? null,
    });

    let firstError: string | null = null;
    for (const rule of matched) {
      try {
        await runRule(rule, trigger);
      } catch (error) {
        firstError = firstError ?? (error instanceof Error ? error.message : String(error));
      }
    }
    if (firstError) {
      updateIngressEvent(eventId, {
        status: "failed",
        error_message: firstError,
      });
    }
    return loadIngressEventRow(eventId) ? toIngressEvent(loadIngressEventRow(eventId)!) : null;
  };

  syncFromConfig();

  return {
    syncFromConfig,

    bindMissionRuntime(args: {
      missionService?: ReturnType<typeof createMissionService>;
      aiOrchestratorService?: ReturnType<typeof createAiOrchestratorService>;
      memoryBriefingService?: ReturnType<typeof createMemoryBriefingService>;
      proceduralLearningService?: ReturnType<typeof createProceduralLearningService>;
      budgetCapService?: ReturnType<typeof createBudgetCapService>;
      workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
    }) {
      missionServiceRef = args.missionService ?? missionServiceRef;
      aiOrchestratorServiceRef = args.aiOrchestratorService ?? aiOrchestratorServiceRef;
      memoryBriefingServiceRef = args.memoryBriefingService ?? memoryBriefingServiceRef;
      proceduralLearningServiceRef = args.proceduralLearningService ?? proceduralLearningServiceRef;
      budgetCapServiceRef = args.budgetCapService ?? budgetCapServiceRef;
      workerHeartbeatServiceRef = args.workerHeartbeatService ?? workerHeartbeatServiceRef;
    },

    list(): AutomationRuleSummary[] {
      const rules = listRules();
      const snapshot = projectConfigService.get();
      const localRuleIds = new Set((snapshot.local?.automations ?? []).map((rule) => rule?.id).filter((id): id is string => typeof id === "string" && id.trim().length > 0));
      const sharedRuleIds = new Set((snapshot.shared?.automations ?? []).map((rule) => rule?.id).filter((id): id is string => typeof id === "string" && id.trim().length > 0));
      for (const row of db.all<{ mission_id: string | null }>(
        `select distinct mission_id from automation_runs where project_id = ? and mission_id is not null`,
        [projectId]
      )) {
        if (row.mission_id) void syncMissionRun(row.mission_id);
      }
      for (const row of db.all<{ worker_run_id: string | null }>(
        `select distinct worker_run_id from automation_runs where project_id = ? and worker_run_id is not null`,
        [projectId]
      )) {
        if (row.worker_run_id) void syncWorkerRun(row.worker_run_id);
      }
      return rules.map((rule) => {
        const runRow = db.get<AutomationRunRow>(
          `
            select
              id, automation_id, chat_session_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, execution_kind, queue_status,
              executor_mode, actions_completed, actions_total, error_message, verification_required, spend_usd,
              trigger_metadata, summary, confidence_json, billing_code, linked_procedure_ids_json, procedure_feedback_json
            from automation_runs
            where project_id = ? and automation_id = ?
            order by started_at desc
            limit 1
          `,
          [projectId, rule.id]
        );
        const runningRow = db.get<{ cnt: number }>(
          `select count(*) as cnt from automation_runs where project_id = ? and automation_id = ? and status in ('queued', 'running')`,
          [projectId, rule.id]
        );
        return {
          ...rule,
          lastRunAt: runRow?.started_at ?? null,
          nextRunAt: (() => {
            const scheduleTrigger = rule.triggers.find((trigger) => trigger.type === "schedule" && trigger.cron);
            return scheduleTrigger?.cron ? computeNextScheduleAt(scheduleTrigger.cron) : null;
          })(),
          lastRunStatus: runRow ? normalizeRunStatus(runRow.status, "failed") : null,
          running: (runningRow?.cnt ?? 0) > 0,
          queueCount: db.get<{ cnt: number }>(
            `select count(*) as cnt from automation_queue_items where project_id = ? and automation_id = ? and queue_status not in ('archived', 'ignored')`,
            [projectId, rule.id]
          )?.cnt ?? 0,
          paused: false,
          ignoredRunCount: db.get<{ cnt: number }>(
            `select count(*) as cnt from automation_queue_items where project_id = ? and automation_id = ? and queue_status = 'ignored'`,
            [projectId, rule.id]
          )?.cnt ?? 0,
          confidence: runRow ? normalizeConfidence(safeJsonParse(runRow.confidence_json ?? "null", null)) : null,
          source: localRuleIds.has(rule.id) && sharedRuleIds.has(rule.id)
            ? "merged"
            : localRuleIds.has(rule.id)
              ? "local"
              : "shared",
        };
      });
    },

    toggle(args: { id: string; enabled: boolean }): AutomationRuleSummary[] {
      const id = args.id.trim();
      if (!id) return this.list();
      const snapshot = projectConfigService.get();
      const local = { ...(snapshot.local ?? {}) };
      const automations = Array.isArray(local.automations) ? [...local.automations] : [];
      const index = automations.findIndex((rule) => rule?.id === id);
      if (index >= 0) automations[index] = { ...automations[index], id, enabled: Boolean(args.enabled) };
      else automations.push({ id, enabled: Boolean(args.enabled) });
      local.automations = automations;
      projectConfigService.save({ shared: snapshot.shared, local });
      syncFromConfig();
      emit({ type: "runs-updated", automationId: id });
      return this.list();
    },

    deleteRule(args: { id: string }): AutomationRuleSummary[] {
      const id = args.id.trim();
      if (!id) return this.list();
      const snapshot = projectConfigService.get();
      const local = { ...(snapshot.local ?? {}) };
      const localAutomations = Array.isArray(local.automations) ? [...local.automations] : [];
      const sharedAutomations = Array.isArray(snapshot.shared?.automations) ? snapshot.shared.automations : [];
      if (sharedAutomations.some((rule) => rule?.id === id)) {
        throw new Error("Shared automations must be removed from the shared project config.");
      }
      const nextAutomations = localAutomations.filter((rule) => rule?.id !== id);
      if (nextAutomations.length === localAutomations.length) {
        throw new Error(`Automation not found in local config: ${id}`);
      }
      local.automations = nextAutomations;
      projectConfigService.save({ shared: snapshot.shared, local });
      syncFromConfig();
      emit({ type: "runs-updated", automationId: id });
      return this.list();
    },

    async triggerManually(args: AutomationManualTriggerRequest): Promise<AutomationRun> {
      const id = args.id.trim();
      if (!id) throw new Error("Automation id is required");
      const rule = findRule(id);
      if (!rule) throw new Error(`Automation not found: ${id}`);
      return await runRule(rule, {
        triggerType: "manual",
        laneId: typeof args.laneId === "string" && args.laneId.trim().length ? args.laneId.trim() : undefined,
        reason: id,
        scheduledAt: nowIso(),
        reviewProfileOverride: args.reviewProfileOverride ?? null,
        verboseTrace: Boolean(args.verboseTrace),
      });
    },

    getHistory(args: { id: string; limit?: number }): AutomationRun[] {
      const id = args.id.trim();
      if (!id) return [];
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 80;
      const rows = db.all<AutomationRunRow>(
        `
          select
            id, automation_id, chat_session_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, execution_kind, queue_status,
            executor_mode, actions_completed, actions_total, error_message, verification_required, spend_usd,
            trigger_metadata, summary, confidence_json, billing_code, linked_procedure_ids_json, procedure_feedback_json
          from automation_runs
          where project_id = ? and automation_id = ?
          order by started_at desc
          limit ?
        `,
        [projectId, id, limit]
      );
      for (const row of rows) {
        if (row.mission_id) void syncMissionRun(row.mission_id);
        if (row.worker_run_id) void syncWorkerRun(row.worker_run_id);
      }
      return rows.map((row) => toRun(loadRunRow(row.id) ?? row));
    },

    listRuns(args: AutomationRunListArgs = {}): AutomationRun[] {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 100;
      const clauses = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.automationId?.trim()) {
        clauses.push("automation_id = ?");
        params.push(args.automationId.trim());
      }
      if (args.status && args.status !== "all") {
        clauses.push("status = ?");
        params.push(args.status);
      }
      params.push(limit);
      const rows = db.all<AutomationRunRow>(
        `
          select
            id, automation_id, chat_session_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, execution_kind, queue_status,
            executor_mode, actions_completed, actions_total, error_message, verification_required, spend_usd,
            trigger_metadata, summary, confidence_json, billing_code, linked_procedure_ids_json, procedure_feedback_json
          from automation_runs
          where ${clauses.join(" and ")}
          order by started_at desc
          limit ?
        `,
        params
      );
      return rows.map((row) => toRun(row));
    },

    async getRunDetail(args: { runId: string }): Promise<AutomationRunDetail | null> {
      const runId = args.runId.trim();
      if (!runId) return null;
      const runRow = loadRunRow(runId);
      if (!runRow) return null;
      if (runRow.mission_id) void syncMissionRun(runRow.mission_id);
      if (runRow.worker_run_id) void syncWorkerRun(runRow.worker_run_id);
      const refreshed = loadRunRow(runId) ?? runRow;
      const actions = db.all<AutomationActionRow>(
        `
          select id, run_id, action_index, action_type, started_at, ended_at, status, error_message, output
          from automation_action_results
          where project_id = ? and run_id = ?
          order by action_index asc
        `,
        [projectId, runId]
      );
      const chatSession = refreshed.chat_session_id && agentChatServiceRef
        ? await agentChatServiceRef.getSessionSummary(refreshed.chat_session_id)
        : null;
      return {
        run: toRun(refreshed),
        rule: findRule(refreshed.automation_id),
        chatSession,
        actions: actions.map(toAction),
        procedureFeedback: safeJsonParseArray<AutomationProcedureFeedback>(refreshed.procedure_feedback_json),
        ingressEvent: (() => { const row = refreshed.ingress_event_id ? loadIngressEventRow(refreshed.ingress_event_id) : null; return row ? toIngressEvent(row) : null; })(),
      };
    },

    getIngressStatus(): AutomationIngressStatus {
      return {
        ...ingressStatusRef,
      };
    },

    listIngressEvents(limit = 20): AutomationIngressEventRecord[] {
      return listRecentIngressEvents(limit);
    },

    updateIngressStatus,

    getIngressCursor(source: AutomationIngressSource): string | null {
      return getIngressCursor(source);
    },

    setIngressCursor(args: { source: AutomationIngressSource; cursor: string | null }) {
      upsertIngressCursor(args.source, args.cursor);
      updateIngressStatus({
        githubRelay: args.source === "github-relay" ? { lastCursor: args.cursor } : undefined,
      });
    },

    async dispatchIngressTrigger(args: {
      source: AutomationIngressSource;
      eventKey: string;
      triggerType: AutomationTriggerType;
      eventName?: string | null;
      summary?: string | null;
      author?: string | null;
      labels?: string[];
      paths?: string[];
      keywords?: string[];
      draftState?: "draft" | "ready" | "any";
      cursor?: string | null;
      rawPayload?: Record<string, unknown> | null;
      automationId?: string | null;
    }): Promise<AutomationIngressEventRecord | null> {
      return await dispatchIngressTrigger(args);
    },

    onSessionEnded(args: { laneId: string; sessionId: string }) {
      void dispatchTrigger({
        triggerType: "session-end",
        laneId: args.laneId,
        sessionId: args.sessionId,
        branch: resolveLaneBranch(args.laneId),
        reason: "session_end",
      });
    },

    onHeadChanged(args: { laneId: string; preHeadSha: string | null; postHeadSha: string | null; reason: string }) {
      if (!args.postHeadSha || args.postHeadSha === args.preHeadSha) return;
      void dispatchTrigger({
        triggerType: "git.commit",
        laneId: args.laneId,
        commitSha: args.postHeadSha,
        branch: resolveLaneBranch(args.laneId),
        reason: args.reason,
      });
    },

    onGitPushed(args: { laneId: string; branchRef?: string | null; summary?: string | null }) {
      const branch = (args.branchRef ?? "").trim() || resolveLaneBranch(args.laneId) || "";
      void dispatchTrigger({
        triggerType: "git.push",
        laneId: args.laneId,
        branch: branch || undefined,
        reason: "git_push",
        scheduledAt: nowIso(),
        summary: args.summary ?? undefined,
      });
    },

    onLaneCreated(args: { laneId: string; laneName: string; branchRef?: string | null; folder?: string | null }) {
      const keywords = dedupeStrings([args.folder]);
      void dispatchTrigger({
        triggerType: "lane.created",
        laneId: args.laneId,
        laneName: args.laneName,
        branch: args.branchRef ?? undefined,
        keywords,
        summary: `Lane created: ${args.laneName}`,
        reason: "lane_created",
        scheduledAt: nowIso(),
      });
    },

    onLaneArchived(args: { laneId: string; laneName: string; branchRef?: string | null; folder?: string | null }) {
      const keywords = dedupeStrings([args.folder, "archived"]);
      void dispatchTrigger({
        triggerType: "lane.archived",
        laneId: args.laneId,
        laneName: args.laneName,
        branch: args.branchRef ?? undefined,
        keywords,
        summary: `Lane archived: ${args.laneName}`,
        reason: "lane_archived",
        scheduledAt: nowIso(),
      });
    },

    onPullRequestChanged(args: {
      pr: PrSummary;
      previousState?: PrSummary["state"] | null;
      previousChecksStatus?: PrSummary["checksStatus"] | null;
      previousReviewStatus?: PrSummary["reviewStatus"] | null;
    }) {
      const stateTransition =
        args.previousState && args.previousState !== args.pr.state
          ? `${args.previousState}->${args.pr.state}`
          : undefined;
      const changedFields = dedupeStrings([
        args.previousState !== args.pr.state ? "state" : null,
        args.previousChecksStatus !== args.pr.checksStatus ? "checksStatus" : null,
        args.previousReviewStatus !== args.pr.reviewStatus ? "reviewStatus" : null,
      ]);
      const baseContext = {
        laneId: args.pr.laneId,
        branch: args.pr.headBranch,
        targetBranch: args.pr.baseBranch,
        labels: [args.pr.state, args.pr.reviewStatus, args.pr.checksStatus],
        summary: args.pr.title,
        keywords: dedupeStrings([
          args.pr.title,
          args.pr.state,
          args.pr.reviewStatus,
          args.pr.checksStatus,
          args.pr.githubPrNumber ? `#${args.pr.githubPrNumber}` : null,
        ]),
        draftState: args.pr.state === "draft" ? "draft" as const : "ready" as const,
        reason: args.pr.id,
        scheduledAt: nowIso(),
      };
      if (!args.previousState) {
        void dispatchTrigger({ triggerType: "git.pr_opened", ...baseContext });
        return;
      }
      if (args.pr.state === "merged" && args.previousState !== "merged") {
        void dispatchTrigger({
          triggerType: "git.pr_merged",
          ...baseContext,
          stateTransition,
        });
        return;
      }
      if (args.pr.state === "closed" && args.previousState !== "closed") {
        void dispatchTrigger({
          triggerType: "git.pr_closed",
          ...baseContext,
          stateTransition,
        });
        return;
      }
      void dispatchTrigger({
        triggerType: "git.pr_updated",
        ...baseContext,
        stateTransition,
        changedFields,
      });
    },

    onLinearIssueChanged(args: {
      issue: NormalizedLinearIssue;
      previousAssigneeId?: string | null;
      previousAssigneeName?: string | null;
    }) {
      const issue = args.issue;
      const changedFields: string[] = [];
      if (!issue.previousStateId) changedFields.push("created");
      if ((issue.previousStateId ?? null) !== issue.stateId) changedFields.push("state");
      if ((args.previousAssigneeId ?? null) !== issue.assigneeId) changedFields.push("assignee");
      const stateTransition =
        issue.previousStateName && issue.previousStateName !== issue.stateName
          ? `${issue.previousStateName}->${issue.stateName}`
          : undefined;
      const common = {
        project: issue.projectSlug,
        team: issue.teamKey,
        assignee: issue.assigneeName ?? undefined,
        labels: issue.labels,
        keywords: dedupeStrings([
          issue.identifier,
          issue.title,
          issue.priorityLabel,
          issue.stateName,
          issue.assigneeName,
          args.previousAssigneeName,
        ]),
        summary: `${issue.identifier}: ${issue.title}`,
        stateTransition,
        changedFields,
        scheduledAt: nowIso(),
        reason: issue.identifier,
      };
      if (!issue.previousStateId) {
        void dispatchTrigger({ triggerType: "linear.issue_created", ...common });
      }
      if ((args.previousAssigneeId ?? null) !== issue.assigneeId && issue.assigneeId) {
        void dispatchTrigger({ triggerType: "linear.issue_assigned", ...common });
      }
      if (changedFields.includes("state")) {
        void dispatchTrigger({ triggerType: "linear.issue_status_changed", ...common });
      }
      if (changedFields.length > 0) {
        void dispatchTrigger({ triggerType: "linear.issue_updated", ...common });
      }
    },

    onMissionUpdated(args: { missionId: string }) {
      if (!args.missionId.trim()) return;
      void syncMissionRun(args.missionId.trim());
    },

    onWorkerRunUpdated(args: { workerRunId: string }) {
      if (!args.workerRunId.trim()) return;
      void syncWorkerRun(args.workerRunId.trim());
    },

    reloadFromConfig() {
      syncFromConfig();
      emit({ type: "runs-updated" });
    },

    dispose() {
      for (const task of scheduleTasks.values()) {
        try {
          task.stop();
        } catch {
          // ignore
        }
      }
      scheduleTasks.clear();
      for (const watcher of fileWatchers.values()) {
        void watcher.close().catch(() => {});
      }
      fileWatchers.clear();
    }
  };
}
