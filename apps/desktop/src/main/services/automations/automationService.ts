import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import cron from "node-cron";
import type {
  AutomationAction,
  AutomationActionResult,
  AutomationActionStatus,
  AutomationConfidenceScore,
  AutomationIngressEventRecord,
  AutomationIngressSource,
  AutomationIngressStatus,
  AutomationManualTriggerRequest,
  AutomationPendingPublish,
  AutomationProcedureFeedback,
  AutomationQueueActionRequest,
  AutomationQueueItem,
  AutomationQueueListArgs,
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
  NightShiftBriefing,
  NightShiftQueueMutationRequest,
  NightShiftQueueItem,
  NightShiftSettings,
  NightShiftState,
  UpdateNightShiftSettingsRequest,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb, SqlValue } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createTestService } from "../tests/testService";
import type { createMissionService } from "../missions/missionService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import type { createMemoryBriefingService } from "../memory/memoryBriefingService";
import type { createProceduralLearningService } from "../memory/proceduralLearningService";
import type { createBudgetCapService } from "../usage/budgetCapService";
import { buildClaudeReadOnlyWorkerAllowedTools } from "../orchestrator/unifiedOrchestratorAdapter";
import type { createWorkerHeartbeatService } from "../cto/workerHeartbeatService";
import { isRecord, isWithinDir, nowIso, safeJsonParse } from "../shared/utils";
import type { AutomationRoutingService } from "./automationRoutingService";

type CronTask = {
  stop: () => void;
};

type TriggerContext = {
  triggerType: AutomationTriggerType;
  laneId?: string;
  sessionId?: string;
  commitSha?: string;
  reason?: string;
  scheduledAt?: string;
  reviewProfileOverride?: AutomationRule["reviewProfile"] | null;
  queueInstead?: boolean;
  verboseTrace?: boolean;
  ingressEventId?: string;
  ingressSource?: AutomationIngressSource;
  ingressEventKey?: string;
  eventName?: string;
  author?: string;
  labels?: string[];
  paths?: string[];
  keywords?: string[];
  draftState?: "draft" | "ready" | "any";
  summary?: string;
};

type AutomationRunRow = {
  id: string;
  automation_id: string;
  mission_id: string | null;
  worker_run_id: string | null;
  worker_agent_id: string | null;
  queue_item_id: string | null;
  ingress_event_id: string | null;
  trigger_type: string;
  started_at: string;
  ended_at: string | null;
  status: string;
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

type NightShiftSettingsRow = {
  schedule_start: string | null;
  schedule_end: string | null;
  timezone: string | null;
  utilization_preset: string | null;
  paused: number | null;
  updated_at: string | null;
};

type MorningBriefingRow = {
  id: string;
  created_at: string;
  completed_at: string | null;
  total_runs: number;
  succeeded_runs: number;
  failed_runs: number;
  total_spend_usd: number;
  cards_json: string | null;
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

const NIGHT_SHIFT_SCOPE = "night-shift-run";
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
const DEFAULT_NIGHT_SHIFT_SETTINGS: NightShiftSettings = {
  activeHours: { start: "22:00", end: "06:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
  utilizationPreset: "conservative",
  paused: false,
  updatedAt: nowIso(),
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
    case "queued-for-night-shift":
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
  return {
    ...rule,
    enabled: rule.enabled !== false,
    triggers,
    executor: rule.executor ?? { mode: "automation-bot" },
    reviewProfile: rule.reviewProfile ?? "quick",
    toolPalette: rule.toolPalette?.length ? rule.toolPalette : ["repo", "memory", "mission"],
    contextSources: rule.contextSources?.length ? rule.contextSources : [{ type: "project-memory" }, { type: "procedures" }],
    memory: rule.memory ?? { mode: "automation-plus-project", ruleScopeKey: rule.id },
    guardrails: rule.guardrails ?? {},
    outputs: rule.outputs ?? { disposition: "comment-only", createArtifact: true },
    verification: rule.verification ?? { verifyBeforePublish: false, mode: "intervention" },
    billingCode: rule.billingCode?.trim() || `auto:${rule.id}`,
    legacy: {
      ...(rule.legacy?.trigger ?? triggers[0] ? { trigger: rule.legacy?.trigger ?? triggers[0] } : {}),
      ...(legacyActions.length ? { actions: legacyActions } : {}),
    },
  };
}

function summarizeTrigger(trigger: AutomationTrigger): string {
  if (trigger.type === "schedule" && trigger.cron) return `schedule ${trigger.cron}`;
  if (trigger.type === "commit" && trigger.branch) return `commit:${trigger.branch}`;
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
  if (args.current === "queued-for-night-shift" && (args.runStatus === "queued" || args.runStatus === "running")) {
    return "queued-for-night-shift";
  }
  if (args.verificationRequired) return "verification-required";
  if (args.runStatus === "queued") return "queued-for-night-shift";
  if (args.runStatus === "running") return "pending-review";
  if (args.runStatus === "failed") return "actionable-findings";
  if (args.mode === "monitor") return "completed-clean";
  const lower = (args.summary ?? "").toLowerCase();
  if (lower.includes("no findings") || lower.includes("clean") || lower.includes("no issues")) {
    return "completed-clean";
  }
  return "actionable-findings";
}

function parseActiveHours(value: NightShiftSettings["activeHours"], now = new Date()): { startMin: number; endMin: number; currentMin: number } {
  const parsePart = (input: string): number => {
    const [hRaw, mRaw] = input.split(":");
    const h = Number(hRaw ?? 0);
    const m = Number(mRaw ?? 0);
    return Math.max(0, Math.min(23, Number.isFinite(h) ? h : 0)) * 60 + Math.max(0, Math.min(59, Number.isFinite(m) ? m : 0));
  };
  return {
    startMin: parsePart(value.start),
    endMin: parsePart(value.end),
    currentMin: now.getHours() * 60 + now.getMinutes(),
  };
}

function isWithinActiveHours(hours: NightShiftSettings["activeHours"], now = new Date()): boolean {
  const { startMin, endMin, currentMin } = parseActiveHours(hours, now);
  if (startMin === endMin) return true;
  if (startMin < endMin) return currentMin >= startMin && currentMin < endMin;
  return currentMin >= startMin || currentMin < endMin;
}

function targetLabelForRule(rule: AutomationRule): string | null {
  if (rule.executor.mode === "employee") return rule.executor.targetId?.trim() || null;
  if (rule.executor.mode === "cto-route") {
    return rule.executor.routingHints?.preferredWorkerIds?.[0]?.trim()
      || rule.executor.routingHints?.requiredCapabilities?.join(", ")
      || null;
  }
  return null;
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

function toPendingPublish(row: AutomationPendingPublishRow): AutomationPendingPublish {
  return {
    id: row.id,
    runId: row.run_id,
    automationId: row.automation_id,
    queueItemId: row.queue_item_id ?? null,
    summary: row.summary,
    toolPalette: safeJsonParseArray<AutomationToolFamily>(row.tool_palette_json),
    createdAt: row.created_at,
  };
}

function toRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    missionId: row.mission_id ?? null,
    workerRunId: row.worker_run_id ?? null,
    workerAgentId: row.worker_agent_id ?? null,
    queueItemId: row.queue_item_id ?? null,
    triggerType: (row.trigger_type as AutomationTriggerType) ?? "manual",
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    status: normalizeRunStatus(row.status, "failed"),
    queueStatus: normalizeQueueStatus(row.queue_status, "pending-review"),
    executorMode: (row.executor_mode as AutomationRule["executor"]["mode"]) ?? "automation-bot",
    actionsCompleted: row.actions_completed ?? 0,
    actionsTotal: row.actions_total ?? 0,
    errorMessage: row.error_message ?? null,
    spendUsd: Number(row.spend_usd ?? 0),
    verificationRequired: Boolean(row.verification_required ?? 0),
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

function toQueueItem(row: AutomationQueueItemRow): AutomationQueueItem {
  return {
    id: row.id,
    automationId: row.automation_id,
    runId: row.run_id ?? null,
    missionId: row.mission_id ?? null,
    title: row.title,
    mode: row.mode as AutomationRule["mode"],
    queueStatus: normalizeQueueStatus(row.queue_status, "pending-review"),
    triggerType: row.trigger_type as AutomationTriggerType,
    summary: row.summary ?? null,
    severitySummary: row.severity_summary ?? null,
    confidence: normalizeConfidence(safeJsonParse(row.confidence_json ?? "null", null)),
    fileCount: Number(row.file_count ?? 0),
    spendUsd: Number(row.spend_usd ?? 0),
    verificationRequired: Boolean(row.verification_required ?? 0),
    suggestedActions: safeJsonParseArray<AutomationRule["outputs"]["disposition"]>(row.suggested_actions_json),
    procedureSignals: safeJsonParseArray<string>(row.procedure_signals_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  missionService?: ReturnType<typeof createMissionService>;
  aiOrchestratorService?: ReturnType<typeof createAiOrchestratorService>;
  memoryBriefingService?: ReturnType<typeof createMemoryBriefingService>;
  proceduralLearningService?: ReturnType<typeof createProceduralLearningService>;
  budgetCapService?: ReturnType<typeof createBudgetCapService>;
  onEvent?: (payload: {
    type: "runs-updated" | "queue-updated" | "night-shift-updated" | "review-updated" | "webhook-status-updated" | "ingress-updated";
    automationId?: string;
    runId?: string;
    queueItemId?: string;
  }) => void;
}) {
  type AutomationIngressStatusPatch = {
    githubRelay?: Partial<AutomationIngressStatus["githubRelay"]>;
    localWebhook?: Partial<AutomationIngressStatus["localWebhook"]>;
  };
  let missionServiceRef = missionService;
  let aiOrchestratorServiceRef = aiOrchestratorService;
  let memoryBriefingServiceRef = memoryBriefingService;
  let proceduralLearningServiceRef = proceduralLearningService;
  let budgetCapServiceRef = budgetCapService;
  let workerHeartbeatServiceRef: ReturnType<typeof createWorkerHeartbeatService> | null = null;
  let automationRoutingServiceRef: AutomationRoutingService | null = null;
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
  const inFlightByAutomationId = new Set<string>();
  const scheduleTasks = new Map<string, CronTask>();
  const nightShiftTimer = setInterval(() => {
    void processNightShiftQueue().catch((error) => {
      logger.warn("automations.night_shift.process_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 60_000);

  const emit = (payload: {
    type: "runs-updated" | "queue-updated" | "night-shift-updated" | "review-updated" | "webhook-status-updated" | "ingress-updated";
    automationId?: string;
    runId?: string;
    queueItemId?: string;
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
      ["mission_id", "alter table automation_runs add column mission_id text"],
      ["worker_run_id", "alter table automation_runs add column worker_run_id text"],
      ["worker_agent_id", "alter table automation_runs add column worker_agent_id text"],
      ["queue_item_id", "alter table automation_runs add column queue_item_id text"],
      ["ingress_event_id", "alter table automation_runs add column ingress_event_id text"],
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

    const existingSettings = db.get<NightShiftSettingsRow>(
      `select schedule_start, schedule_end, timezone, utilization_preset, paused, updated_at
       from automation_night_shift_settings
       where project_id = ?
       limit 1`,
      [projectId]
    );
    if (!existingSettings) {
      db.run(
        `insert into automation_night_shift_settings(
          project_id, schedule_start, schedule_end, timezone, utilization_preset, paused, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          DEFAULT_NIGHT_SHIFT_SETTINGS.activeHours.start,
          DEFAULT_NIGHT_SHIFT_SETTINGS.activeHours.end,
          DEFAULT_NIGHT_SHIFT_SETTINGS.activeHours.timezone,
          DEFAULT_NIGHT_SHIFT_SETTINGS.utilizationPreset,
          0,
          DEFAULT_NIGHT_SHIFT_SETTINGS.updatedAt,
        ]
      );
    }
  };

  ensureSchema();

  const listRules = (): AutomationRule[] => (projectConfigService.get().effective.automations ?? []).map((rule) => normalizeRuntimeRule(rule as AutomationRule));
  const findRule = (automationId: string): AutomationRule | null => listRules().find((rule) => rule.id === automationId) ?? null;

  const readNightShiftSettings = (): NightShiftSettings => {
    const row = db.get<NightShiftSettingsRow>(
      `select schedule_start, schedule_end, timezone, utilization_preset, paused, updated_at
       from automation_night_shift_settings
       where project_id = ?
       limit 1`,
      [projectId]
    );
    if (!row) return DEFAULT_NIGHT_SHIFT_SETTINGS;
    return {
      activeHours: {
        start: row.schedule_start?.trim() || DEFAULT_NIGHT_SHIFT_SETTINGS.activeHours.start,
        end: row.schedule_end?.trim() || DEFAULT_NIGHT_SHIFT_SETTINGS.activeHours.end,
        timezone: row.timezone?.trim() || DEFAULT_NIGHT_SHIFT_SETTINGS.activeHours.timezone,
      },
      utilizationPreset: row.utilization_preset === "maximize" || row.utilization_preset === "fixed"
        ? row.utilization_preset
        : "conservative",
      paused: Boolean(row.paused ?? 0),
      updatedAt: row.updated_at ?? DEFAULT_NIGHT_SHIFT_SETTINGS.updatedAt,
    };
  };

  const writeNightShiftSettings = (next: NightShiftSettings) => {
    db.run(
      `update automation_night_shift_settings
       set schedule_start = ?, schedule_end = ?, timezone = ?, utilization_preset = ?, paused = ?, updated_at = ?
       where project_id = ?`,
      [
        next.activeHours.start,
        next.activeHours.end,
        next.activeHours.timezone,
        next.utilizationPreset,
        next.paused ? 1 : 0,
        next.updatedAt,
        projectId,
      ]
    );
  };

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

  const selectWorkerForRule = (rule: AutomationRule) => {
    if (rule.executor.mode === "employee" && rule.executor.targetId?.trim()) {
      return {
        status: "matched" as const,
        worker: { id: rule.executor.targetId.trim() },
        confidence: 1,
        reason: "Explicit employee target.",
      };
    }
    return automationRoutingServiceRef?.route(rule) ?? {
      status: "no-match" as const,
      worker: null,
      confidence: 0,
      reason: "Routing service unavailable.",
    };
  };

  const requiresPublishGate = (rule: AutomationRule): boolean =>
    Boolean(rule.verification.verifyBeforePublish)
    && rule.verification.mode !== "dry-run"
    && rule.toolPalette.some((family) => PUBLISH_CAPABLE_TOOL_FAMILIES.has(family));

  const buildTriggerMetadata = (trigger: TriggerContext): Record<string, unknown> => ({
    ...(trigger.laneId ? { laneId: trigger.laneId } : {}),
    ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
    ...(trigger.commitSha ? { commitSha: trigger.commitSha } : {}),
    ...(trigger.reason ? { reason: trigger.reason } : {}),
    ...(trigger.scheduledAt ? { scheduledAt: trigger.scheduledAt } : {}),
    ...(trigger.reviewProfileOverride ? { reviewProfileOverride: trigger.reviewProfileOverride } : {}),
    ...(trigger.queueInstead ? { queueInstead: true } : {}),
    ...(trigger.verboseTrace ? { verboseTrace: true } : {}),
    ...(trigger.ingressEventId ? { ingressEventId: trigger.ingressEventId } : {}),
    ...(trigger.ingressSource ? { ingressSource: trigger.ingressSource } : {}),
    ...(trigger.ingressEventKey ? { ingressEventKey: trigger.ingressEventKey } : {}),
    ...(trigger.eventName ? { eventName: trigger.eventName } : {}),
    ...(trigger.author ? { author: trigger.author } : {}),
    ...(trigger.labels?.length ? { labels: trigger.labels } : {}),
    ...(trigger.paths?.length ? { paths: trigger.paths } : {}),
    ...(trigger.keywords?.length ? { keywords: trigger.keywords } : {}),
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
    missionId?: string | null;
    workerRunId?: string | null;
    workerAgentId?: string | null;
    ingressEventId?: string | null;
  }): AutomationRun => {
    const runId = randomUUID();
    const startedAt = nowIso();
    const runStatus = args.status ?? "running";
    const queueStatus = args.queueStatus ?? (args.rule.executor.mode === "night-shift" ? "queued-for-night-shift" : "pending-review");
    const confidence = args.confidence ?? null;
    const triggerMetadata = buildTriggerMetadata(args.trigger);
    db.run(
      `
        insert into automation_runs(
          id,
          project_id,
          automation_id,
          mission_id,
          worker_run_id,
          worker_agent_id,
          queue_item_id,
          ingress_event_id,
          trigger_type,
          started_at,
          ended_at,
          status,
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
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, 0, ?, null, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        runId,
        projectId,
        args.rule.id,
        args.missionId ?? null,
        args.workerRunId ?? null,
        args.workerAgentId ?? null,
        args.queueItemId ?? null,
        args.ingressEventId ?? args.trigger.ingressEventId ?? null,
        args.trigger.triggerType,
        startedAt,
        runStatus,
        queueStatus,
        args.rule.executor.mode,
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
      mission_id: args.missionId ?? null,
      worker_run_id: args.workerRunId ?? null,
      worker_agent_id: args.workerAgentId ?? null,
      queue_item_id: args.queueItemId ?? null,
      ingress_event_id: args.ingressEventId ?? args.trigger.ingressEventId ?? null,
      trigger_type: args.trigger.triggerType,
      started_at: startedAt,
      ended_at: null,
      status: runStatus,
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
        id, automation_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, queue_status,
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
    emit({ type: "queue-updated", automationId: args.rule.id, queueItemId });
    return queueItemId;
  };

  const updateQueueItemStatus = (queueItemId: string, queueStatus: AutomationRunQueueStatus) => {
    db.run(
      `update automation_queue_items set queue_status = ?, updated_at = ? where id = ? and project_id = ?`,
      [queueStatus, nowIso(), queueItemId, projectId]
    );
    emit({ type: "queue-updated", queueItemId });
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
    if (action.type === "update-packs") {
      return { status: "succeeded", output: "update-packs is deprecated; unified memory lifecycle runs automatically." };
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
    const actions = rule.legacy?.actions ?? [];
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
      updateRun(run.id, {
        ended_at: nowIso(),
        status: runStatus,
        error_message: runError,
        queue_status: deriveQueueStatus({
          current: run.queueStatus,
          runStatus,
          verificationRequired: requiresPublishGate(rule),
          mode: rule.mode,
          summary: runError,
        }),
      });
      emit({ type: "runs-updated", automationId: rule.id, runId: run.id });
    }
    return toRun(loadRunRow(run.id) ?? {
      id: run.id,
      automation_id: rule.id,
      mission_id: null,
      worker_run_id: null,
      worker_agent_id: null,
      queue_item_id: null,
      ingress_event_id: trigger.ingressEventId ?? null,
      trigger_type: trigger.triggerType,
      started_at: run.startedAt,
      ended_at: nowIso(),
      status: runStatus,
      queue_status: run.queueStatus,
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
        includeAgentMemory: rule.executor.mode === "employee",
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
    const budgetScope = args.queuedFromNightShift || args.rule.executor.mode === "night-shift" ? NIGHT_SHIFT_SCOPE : AUTOMATION_SCOPE;
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
      employeeAgentId: args.rule.executor.mode === "employee" ? (args.rule.executor.targetId ?? null) : null,
      ...(args.rule.modelConfig ? { modelConfig: args.rule.modelConfig } : {}),
      permissionConfig,
    });

    missionServiceRef.patchMetadata(mission.id, {
      automation: {
        ruleId: args.rule.id,
        mode: args.rule.mode,
        reviewProfile: args.trigger.reviewProfileOverride ?? args.rule.reviewProfile,
        executorMode: args.rule.executor.mode,
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
          executorMode: args.rule.executor.mode,
          reviewProfile: args.trigger.reviewProfileOverride ?? args.rule.reviewProfile,
          verboseTrace: Boolean(args.trigger.verboseTrace),
          queueStatus: args.queuedFromNightShift ? "queued-for-night-shift" : "pending-review",
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
          queueStatus: args.queuedFromNightShift ? "queued-for-night-shift" : "pending-review",
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
        queue_status: args.queuedFromNightShift ? "queued-for-night-shift" : "pending-review",
        summary: args.rule.prompt?.trim() || `${args.rule.mode} automation dispatched`,
        confidence_json: JSON.stringify(confidence),
        linked_procedure_ids_json: JSON.stringify(linkedProcedureIds),
        verification_required: requiresPublishGate(args.rule) && !args.publishPhase ? 1 : 0,
        billing_code: args.rule.billingCode,
      });
    }

    const dispatchActionId = insertAction(run.id, 0, "run-command");
    finishAction({
      id: dispatchActionId,
      status: "succeeded",
      output: `Mission ${mission.id} queued for ${args.rule.executor.mode} automation dispatch.`,
    });
    updateRun(run.id, {
      actions_completed: 1,
      mission_id: mission.id,
      queue_item_id: args.existingQueueItemId ?? run.queueItemId,
    });

    const queueItemId = upsertQueueItem({
      id: args.existingQueueItemId ?? run.queueItemId,
      rule: args.rule,
      runId: run.id,
      missionId: mission.id,
      queueStatus: args.queuedFromNightShift ? "queued-for-night-shift" : "pending-review",
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
      autopilotOwnerId:
        args.rule.executor.mode === "employee" && args.rule.executor.targetId
          ? `automation-employee:${args.rule.executor.targetId}`
          : args.rule.executor.mode === "cto-route"
            ? "automation-cto-route"
            : "automation-bot",
    });

    emit({ type: "runs-updated", automationId: args.rule.id, runId: run.id });
    return toRun(loadRunRow(run.id) ?? {
      id: run.id,
      automation_id: args.rule.id,
      mission_id: mission.id,
      worker_run_id: null,
      worker_agent_id: null,
      queue_item_id: queueItemId,
      ingress_event_id: args.trigger.ingressEventId ?? null,
      trigger_type: args.trigger.triggerType,
      started_at: run.startedAt,
      ended_at: null,
      status: "running",
      queue_status: args.queuedFromNightShift ? "queued-for-night-shift" : "pending-review",
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

  const dispatchWorkerRun = async (args: {
    rule: AutomationRule;
    trigger: TriggerContext;
    existingRunId?: string | null;
    existingQueueItemId?: string | null;
    publishPhase?: boolean;
  }): Promise<AutomationRun> => {
    if (!workerHeartbeatServiceRef) {
      throw new Error("Worker heartbeat service is unavailable");
    }

    const target = selectWorkerForRule(args.rule);
    if (target.status !== "matched" || !target.worker?.id) {
      const confidence = computeConfidence(args.rule, 0);
      const run = insertRun({
        rule: args.rule,
        trigger: args.trigger,
        status: "needs_review",
        queueStatus: "verification-required",
        actionsTotal: 1,
        confidence,
        summary: `CTO routing requires review: ${target.reason}`,
        queueItemId: args.existingQueueItemId ?? null,
        ingressEventId: args.trigger.ingressEventId ?? null,
      });
      const queueItemId = upsertQueueItem({
        id: args.existingQueueItemId ?? run.queueItemId,
        rule: args.rule,
        runId: run.id,
        missionId: null,
        queueStatus: "verification-required",
        triggerType: args.trigger.triggerType,
        summary: `Routing review required: ${target.reason}`,
        severitySummary: "No confident worker match",
        confidence,
        verificationRequired: true,
        spendUsd: 0,
        procedureSignals: [`Route confidence ${target.confidence.toFixed(2)}`],
      });
      updateRun(run.id, { queue_item_id: queueItemId });
      return toRun(loadRunRow(run.id) ?? {
        id: run.id,
        automation_id: args.rule.id,
        mission_id: null,
        worker_run_id: null,
        worker_agent_id: null,
        queue_item_id: queueItemId,
        ingress_event_id: args.trigger.ingressEventId ?? null,
        trigger_type: args.trigger.triggerType,
        started_at: run.startedAt,
        ended_at: null,
        status: "needs_review",
        queue_status: "verification-required",
        executor_mode: args.rule.executor.mode,
        actions_completed: 0,
        actions_total: 1,
        error_message: target.reason,
        verification_required: 1,
        spend_usd: 0,
        trigger_metadata: JSON.stringify(buildTriggerMetadata(args.trigger)),
        summary: `CTO routing requires review: ${target.reason}`,
        confidence_json: JSON.stringify(confidence),
        billing_code: args.rule.billingCode,
        linked_procedure_ids_json: JSON.stringify([]),
        procedure_feedback_json: JSON.stringify([]),
      });
    }

    const confidence = computeConfidence(args.rule, 0);
    const taskKey = `${AUTOMATION_TASK_KEY_PREFIX}:${args.rule.id}`;
    const prompt = buildMissionPrompt({ rule: args.rule, trigger: args.trigger, briefing: null });
    const wake = await workerHeartbeatServiceRef.triggerWakeup({
      agentId: target.worker.id,
      reason: "api",
      taskKey,
      prompt,
      context: {
        source: "automation",
        automationId: args.rule.id,
        executorMode: args.rule.executor.mode,
        toolPalette: args.rule.toolPalette,
        billingCode: args.rule.billingCode,
        modelConfig: args.rule.modelConfig ?? null,
        permissionConfig: buildPermissionConfig(args.rule, { publishPhase: Boolean(args.publishPhase) }),
        publishPhase: Boolean(args.publishPhase),
        trigger: buildTriggerMetadata(args.trigger),
      },
    });
    const workerRun = workerHeartbeatServiceRef.listRuns({ agentId: target.worker.id, limit: 100 }).find((entry) => entry.id === wake.runId) ?? null;
    const existingRunRow = args.existingRunId ? loadRunRow(args.existingRunId) : null;
    const automationStatus = mapWorkerStatus(workerRun?.status ?? wake.status, requiresPublishGate(args.rule));
    const run = existingRunRow
      ? toRun(existingRunRow)
      : insertRun({
          rule: args.rule,
          trigger: args.trigger,
          actionsTotal: 1,
          status: automationStatus,
          queueStatus: deriveQueueStatus({
            current: "pending-review",
            runStatus: automationStatus,
            verificationRequired: requiresPublishGate(args.rule) && !args.publishPhase,
            mode: args.rule.mode,
            summary: workerRun?.errorMessage ?? null,
          }),
          confidence,
          summary: `Worker ${target.worker.id} running ${args.rule.name}`,
          workerRunId: wake.runId,
          workerAgentId: target.worker.id,
          queueItemId: args.existingQueueItemId ?? null,
          ingressEventId: args.trigger.ingressEventId ?? null,
        });

    if (args.existingRunId) {
      updateRun(args.existingRunId, {
        worker_run_id: wake.runId,
        worker_agent_id: target.worker.id,
        status: automationStatus,
        queue_status: deriveQueueStatus({
          current: existingRunRow?.queue_status as AutomationRunQueueStatus ?? "pending-review",
          runStatus: automationStatus,
          verificationRequired: requiresPublishGate(args.rule) && !args.publishPhase,
          mode: args.rule.mode,
          summary: workerRun?.errorMessage ?? null,
        }),
        summary: `Worker ${target.worker.id} running ${args.rule.name}`,
        verification_required: requiresPublishGate(args.rule) && !args.publishPhase ? 1 : 0,
        billing_code: args.rule.billingCode,
      });
    }

    const queueItemId = upsertQueueItem({
      id: args.existingQueueItemId ?? run.queueItemId,
      rule: args.rule,
      runId: run.id,
      missionId: null,
      queueStatus: deriveQueueStatus({
        current: run.queueStatus,
        runStatus: automationStatus,
        verificationRequired: requiresPublishGate(args.rule) && !args.publishPhase,
        mode: args.rule.mode,
        summary: workerRun?.errorMessage ?? null,
      }),
      triggerType: args.trigger.triggerType,
      summary: `Worker ${target.worker.id} running ${args.rule.name}`,
      severitySummary: target.reason,
      confidence,
      spendUsd: 0,
      verificationRequired: requiresPublishGate(args.rule) && !args.publishPhase,
      procedureSignals: [`Worker route: ${target.reason}`],
    });
    updateRun(run.id, {
      queue_item_id: queueItemId,
      worker_run_id: wake.runId,
      worker_agent_id: target.worker.id,
      billing_code: args.rule.billingCode,
    });

    if (requiresPublishGate(args.rule) && !args.publishPhase) {
      upsertPendingPublish({
        runId: run.id,
        automationId: args.rule.id,
        queueItemId,
        summary: `Worker ${target.worker.id} must be approved before external publishing.`,
        toolPalette: args.rule.toolPalette.filter((family) => PUBLISH_CAPABLE_TOOL_FAMILIES.has(family)),
      });
    } else if (args.publishPhase) {
      resolvePendingPublish(run.id);
    }

    emit({ type: "runs-updated", automationId: args.rule.id, runId: run.id, queueItemId });
    return toRun(loadRunRow(run.id) ?? {
      id: run.id,
      automation_id: args.rule.id,
      mission_id: null,
      worker_run_id: wake.runId,
      worker_agent_id: target.worker.id,
      queue_item_id: queueItemId,
      ingress_event_id: args.trigger.ingressEventId ?? null,
      trigger_type: args.trigger.triggerType,
      started_at: run.startedAt,
      ended_at: null,
      status: automationStatus,
      queue_status: deriveQueueStatus({
        current: "pending-review",
        runStatus: automationStatus,
        verificationRequired: requiresPublishGate(args.rule) && !args.publishPhase,
        mode: args.rule.mode,
        summary: workerRun?.errorMessage ?? null,
      }),
      executor_mode: args.rule.executor.mode,
      actions_completed: 0,
      actions_total: 1,
      error_message: workerRun?.errorMessage ?? null,
      verification_required: requiresPublishGate(args.rule) && !args.publishPhase ? 1 : 0,
      spend_usd: 0,
      trigger_metadata: JSON.stringify(buildTriggerMetadata(args.trigger)),
      summary: `Worker ${target.worker.id} running ${args.rule.name}`,
      confidence_json: JSON.stringify(confidence),
      billing_code: args.rule.billingCode,
      linked_procedure_ids_json: JSON.stringify([]),
      procedure_feedback_json: JSON.stringify([]),
    });
  };

  const queueNightShiftRun = async (rule: AutomationRule, trigger: TriggerContext): Promise<AutomationRun> => {
    const briefing = await buildBriefing(rule, trigger);
    const linkedProcedureIds = briefing?.usedProcedureIds ?? [];
    const confidence = computeConfidence(rule, linkedProcedureIds.length);
    const run = insertRun({
      rule,
      trigger,
      status: "queued",
      queueStatus: "queued-for-night-shift",
      actionsTotal: 1,
      confidence,
      linkedProcedureIds,
      summary: `${rule.name} queued for Night Shift`,
    });
    const queueItemId = upsertQueueItem({
      rule,
      runId: run.id,
      missionId: null,
      queueStatus: "queued-for-night-shift",
      triggerType: trigger.triggerType,
      summary: `${rule.name} queued for Night Shift`,
      severitySummary: "Waiting for overnight window",
      confidence,
      spendUsd: 0,
      verificationRequired: requiresPublishGate(rule),
      procedureSignals: linkedProcedureIds.map((id) => `Queued with learned procedure ${id}`),
    });
    updateRun(run.id, { queue_item_id: queueItemId });
    emit({ type: "night-shift-updated", automationId: rule.id, runId: run.id, queueItemId });
    return toRun(loadRunRow(run.id) ?? {
      id: run.id,
      automation_id: rule.id,
      mission_id: null,
      worker_run_id: null,
      worker_agent_id: null,
      queue_item_id: queueItemId,
      ingress_event_id: trigger.ingressEventId ?? null,
      trigger_type: trigger.triggerType,
      started_at: run.startedAt,
      ended_at: null,
      status: "queued",
      queue_status: "queued-for-night-shift",
      executor_mode: rule.executor.mode,
      actions_completed: 0,
      actions_total: 1,
      error_message: null,
      verification_required: requiresPublishGate(rule) ? 1 : 0,
      spend_usd: 0,
      trigger_metadata: JSON.stringify(buildTriggerMetadata(trigger)),
      summary: `${rule.name} queued for Night Shift`,
      confidence_json: JSON.stringify(confidence),
      billing_code: rule.billingCode,
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
          id, automation_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, queue_status,
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
      const queueInstead = trigger.queueInstead || rule.executor.mode === "night-shift" || rule.outputs.disposition === "queue-overnight";
      if (queueInstead) return await queueNightShiftRun(rule, trigger);
      if ((rule.legacy?.actions?.length ?? 0) > 0) return await runLegacyRule(rule, trigger);
      return await dispatchMissionRun({ rule, trigger });
    } finally {
      inFlightByAutomationId.delete(rule.id);
    }
  };

  const triggerMatches = async (ruleTrigger: AutomationTrigger, trigger: TriggerContext): Promise<boolean> => {
    if (ruleTrigger.type !== trigger.triggerType) return false;
    if (ruleTrigger.branch && trigger.laneId) {
      try {
        const lane = laneService.getLaneBaseAndBranch(trigger.laneId);
        if (lane.branchRef !== ruleTrigger.branch) return false;
      } catch {
        return false;
      }
    }
    if (ruleTrigger.event?.trim() && ruleTrigger.event.trim() !== (trigger.eventName ?? "").trim()) return false;
    if (ruleTrigger.author?.trim()) {
      const author = (trigger.author ?? "").trim().toLowerCase();
      if (!author || author !== ruleTrigger.author.trim().toLowerCase()) return false;
    }
    if (ruleTrigger.labels?.length) {
      const labels = new Set((trigger.labels ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean));
      if (!ruleTrigger.labels.some((entry) => labels.has(entry.trim().toLowerCase()))) return false;
    }
    if (ruleTrigger.paths?.length) {
      const paths = trigger.paths ?? [];
      if (!paths.some((entry) => ruleTrigger.paths?.some((expected) => entry.includes(expected)))) return false;
    }
    if (ruleTrigger.keywords?.length) {
      const haystack = `${trigger.summary ?? ""} ${(trigger.keywords ?? []).join(" ")}`.toLowerCase();
      if (!ruleTrigger.keywords.some((entry) => haystack.includes(entry.trim().toLowerCase()))) return false;
    }
    if (ruleTrigger.draftState && ruleTrigger.draftState !== "any" && trigger.draftState && ruleTrigger.draftState !== trigger.draftState) {
      return false;
    }
    if (ruleTrigger.activeHours && !isWithinActiveHours(ruleTrigger.activeHours)) return false;
    return true;
  };

  const dispatchTrigger = async (trigger: TriggerContext) => {
    const rules = listRules().filter((rule) => rule.enabled);
    for (const rule of rules) {
      const matches = await Promise.all(rule.triggers.map((candidate) => triggerMatches(candidate, trigger)));
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

  const refreshMorningBriefing = () => {
    const rows = db.all<AutomationQueueItemRow>(
      `
        select
          id, automation_id, run_id, mission_id, position, title, mode, queue_status, trigger_type, summary, severity_summary,
          confidence_json, file_count, spend_usd, verification_required, suggested_actions_json, procedure_signals_json,
          created_at, updated_at
        from automation_queue_items
        where project_id = ?
          and queue_status in ('actionable-findings', 'verification-required', 'completed-clean')
        order by updated_at desc
        limit 12
      `,
      [projectId]
    );
    if (!rows.length) return;
    const cards = rows.map((row) => {
      const item = toQueueItem(row);
      return {
        queueItemId: item.id,
        title: item.title,
        summary: item.summary ?? item.severitySummary ?? "Automation completed overnight.",
        confidence: item.confidence,
        spendUsd: item.spendUsd,
        suggestedActions: item.suggestedActions,
        procedureSignals: item.procedureSignals,
      };
    });
    const succeededRuns = rows.filter((row) => row.queue_status === "completed-clean").length;
    const failedRuns = rows.filter((row) => row.queue_status !== "completed-clean").length;
    db.run(
      `
        insert into automation_morning_briefings(
          id, project_id, created_at, completed_at, total_runs, succeeded_runs, failed_runs, total_spend_usd, cards_json, acknowledged_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null)
      `,
      [
        randomUUID(),
        projectId,
        nowIso(),
        nowIso(),
        rows.length,
        succeededRuns,
        failedRuns,
        rows.reduce((sum, row) => sum + Number(row.spend_usd ?? 0), 0),
        JSON.stringify(cards),
      ]
    );
    emit({ type: "night-shift-updated" });
  };

  const syncMissionRun = async (missionId: string) => {
    if (!missionServiceRef) return;
    const runRow = db.get<AutomationRunRow>(
      `
        select
          id, automation_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, queue_status,
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
        refreshMorningBriefing();
      }
      emit({ type: "runs-updated", automationId: runRow.automation_id, runId: runRow.id, queueItemId: runRow.queue_item_id ?? undefined });
    }
  };

  const syncWorkerRun = async (workerRunId: string) => {
    if (!workerHeartbeatServiceRef) return;
    const runRow = db.get<AutomationRunRow>(
      `
        select
          id, automation_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, queue_status,
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
      refreshMorningBriefing();
    }
    emit({ type: "runs-updated", automationId: runRow.automation_id, runId: runRow.id, queueItemId: runRow.queue_item_id ?? undefined });
  };

  const processNightShiftQueue = async () => {
    const settings = readNightShiftSettings();
    if (settings.paused || !isWithinActiveHours(settings.activeHours)) return;
    const queueRows = db.all<AutomationQueueItemRow>(
      `
        select
          id, automation_id, run_id, mission_id, position, title, mode, queue_status, trigger_type, summary, severity_summary,
          confidence_json, file_count, spend_usd, verification_required, suggested_actions_json, procedure_signals_json,
          created_at, updated_at
        from automation_queue_items
        where project_id = ?
          and queue_status = 'queued-for-night-shift'
          and mission_id is null
        order by position asc, created_at asc
        limit ?
      `,
      [projectId, settings.utilizationPreset === "maximize" ? 6 : settings.utilizationPreset === "fixed" ? 2 : 3]
    );
    for (const queueRow of queueRows) {
      const rule = findRule(queueRow.automation_id);
      if (!rule) continue;
      const runRow = queueRow.run_id ? loadRunRow(queueRow.run_id) : null;
      if (runRow && normalizeRunStatus(runRow.status, "queued") === "paused") continue;
      const triggerMetadata = runRow ? safeJsonParseRecord(runRow.trigger_metadata) : null;
      await dispatchMissionRun({
        rule,
        trigger: {
          triggerType: queueRow.trigger_type as AutomationTriggerType,
          laneId: typeof triggerMetadata?.laneId === "string" ? triggerMetadata.laneId : undefined,
          sessionId: typeof triggerMetadata?.sessionId === "string" ? triggerMetadata.sessionId : undefined,
          commitSha: typeof triggerMetadata?.commitSha === "string" ? triggerMetadata.commitSha : undefined,
          reason: typeof triggerMetadata?.reason === "string" ? triggerMetadata.reason : "night_shift",
          scheduledAt: typeof triggerMetadata?.scheduledAt === "string" ? triggerMetadata.scheduledAt : undefined,
          reviewProfileOverride:
            typeof triggerMetadata?.reviewProfileOverride === "string"
              ? (triggerMetadata.reviewProfileOverride as AutomationRule["reviewProfile"])
              : null,
        },
        existingRunId: runRow?.id ?? queueRow.run_id ?? null,
        existingQueueItemId: queueRow.id,
        queuedFromNightShift: true,
      });
    }
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
    const matched: AutomationRule[] = [];
    for (const rule of candidateRules) {
      const matches = await Promise.all(rule.triggers.map((candidate) => triggerMatches(candidate, trigger)));
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
  void processNightShiftQueue();

  return {
    syncFromConfig,

    bindMissionRuntime(args: {
      missionService?: ReturnType<typeof createMissionService>;
      aiOrchestratorService?: ReturnType<typeof createAiOrchestratorService>;
      memoryBriefingService?: ReturnType<typeof createMemoryBriefingService>;
      proceduralLearningService?: ReturnType<typeof createProceduralLearningService>;
      budgetCapService?: ReturnType<typeof createBudgetCapService>;
      workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
      automationRoutingService?: AutomationRoutingService | null;
    }) {
      missionServiceRef = args.missionService ?? missionServiceRef;
      aiOrchestratorServiceRef = args.aiOrchestratorService ?? aiOrchestratorServiceRef;
      memoryBriefingServiceRef = args.memoryBriefingService ?? memoryBriefingServiceRef;
      proceduralLearningServiceRef = args.proceduralLearningService ?? proceduralLearningServiceRef;
      budgetCapServiceRef = args.budgetCapService ?? budgetCapServiceRef;
      workerHeartbeatServiceRef = args.workerHeartbeatService ?? workerHeartbeatServiceRef;
      automationRoutingServiceRef = args.automationRoutingService ?? automationRoutingServiceRef;
    },

    list(): AutomationRuleSummary[] {
      const rules = listRules();
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
              id, automation_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, queue_status,
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
        const queueRow = db.get<{ cnt: number }>(
          `select count(*) as cnt from automation_queue_items where project_id = ? and automation_id = ? and queue_status not in ('archived')`,
          [projectId, rule.id]
        );
        const ignoredRow = db.get<{ cnt: number }>(
          `select count(*) as cnt from automation_queue_items where project_id = ? and automation_id = ? and queue_status = 'ignored'`,
          [projectId, rule.id]
        );
        return {
          ...rule,
          lastRunAt: runRow?.started_at ?? null,
          lastRunStatus: runRow ? normalizeRunStatus(runRow.status, "failed") : null,
          running: (runningRow?.cnt ?? 0) > 0,
          queueCount: queueRow?.cnt ?? 0,
          paused: rule.executor.mode === "night-shift" && readNightShiftSettings().paused,
          ignoredRunCount: ignoredRow?.cnt ?? 0,
          confidence: runRow ? normalizeConfidence(safeJsonParse(runRow.confidence_json ?? "null", null)) : null,
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
        queueInstead: Boolean(args.queueInstead),
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
            id, automation_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, queue_status,
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
      if (args.queueStatus && args.queueStatus !== "all") {
        clauses.push("queue_status = ?");
        params.push(args.queueStatus);
      }
      params.push(limit);
      const rows = db.all<AutomationRunRow>(
        `
          select
            id, automation_id, mission_id, worker_run_id, worker_agent_id, queue_item_id, ingress_event_id, trigger_type, started_at, ended_at, status, queue_status,
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

    getRunDetail(args: { runId: string }): AutomationRunDetail | null {
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
      return {
        run: toRun(refreshed),
        rule: findRule(refreshed.automation_id),
        actions: actions.map(toAction),
        queueItem: refreshed.queue_item_id ? (loadQueueItemRow(refreshed.queue_item_id) ? toQueueItem(loadQueueItemRow(refreshed.queue_item_id)!) : null) : null,
        procedureFeedback: safeJsonParseArray<AutomationProcedureFeedback>(refreshed.procedure_feedback_json),
        ingressEvent: refreshed.ingress_event_id ? (loadIngressEventRow(refreshed.ingress_event_id) ? toIngressEvent(loadIngressEventRow(refreshed.ingress_event_id)!) : null) : null,
        pendingPublish: loadPendingPublishRow(refreshed.id) ? toPendingPublish(loadPendingPublishRow(refreshed.id)!) : null,
      };
    },

    listQueueItems(args: AutomationQueueListArgs = {}): AutomationQueueItem[] {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 100;
      const clauses = ["project_id = ?"];
      const params: SqlValue[] = [projectId];
      if (args.automationId?.trim()) {
        clauses.push("automation_id = ?");
        params.push(args.automationId.trim());
      }
      if (args.status && args.status !== "all") {
        clauses.push("queue_status = ?");
        params.push(args.status);
      }
      params.push(limit);
      const rows = db.all<AutomationQueueItemRow>(
        `
          select
            id, automation_id, run_id, mission_id, position, title, mode, queue_status, trigger_type, summary, severity_summary,
            confidence_json, file_count, spend_usd, verification_required, suggested_actions_json, procedure_signals_json,
            created_at, updated_at
          from automation_queue_items
          where ${clauses.join(" and ")}
          order by updated_at desc
          limit ?
        `,
        params
      );
      return rows.map(toQueueItem);
    },

    async updateQueueItem(args: AutomationQueueActionRequest): Promise<AutomationQueueItem | null> {
      const queueItemId = args.queueItemId.trim();
      if (!queueItemId) return null;
      const row = loadQueueItemRow(queueItemId);
      if (!row) return null;
      const runRow = row.run_id ? loadRunRow(row.run_id) : null;
      const nextStatus: AutomationRunQueueStatus =
        args.action === "ignore" ? "ignored"
          : args.action === "archive" ? "archived"
            : args.action === "queue-overnight" ? "queued-for-night-shift"
              : "completed-clean";
      if (args.action === "accept" && runRow) {
        const rule = findRule(runRow.automation_id);
        const pendingPublish = loadPendingPublishRow(runRow.id);
        if (rule && pendingPublish) {
          const trigger = {
            triggerType: runRow.trigger_type as AutomationTriggerType,
            ...(safeJsonParseRecord(runRow.trigger_metadata) ?? {}),
          } as TriggerContext;
          await dispatchMissionRun({
            rule,
            trigger,
            existingRunId: runRow.id,
            existingQueueItemId: row.id,
            publishPhase: true,
          });
          updateQueueItemStatus(queueItemId, "completed-clean");
          updateRun(runRow.id, { queue_status: "completed-clean", verification_required: 0 });
          return loadQueueItemRow(queueItemId) ? toQueueItem(loadQueueItemRow(queueItemId)!) : null;
        }
      }
      updateQueueItemStatus(queueItemId, nextStatus);
      if (row.run_id) updateRun(row.run_id, { queue_status: nextStatus });
      if (args.action === "accept" && row.run_id) {
        if (runRow) {
          const feedback = safeJsonParseArray<AutomationProcedureFeedback>(runRow.procedure_feedback_json);
          try {
            proceduralLearningServiceRef?.updateProcedureOutcomes?.(feedback.map((item) => ({
              memoryId: item.procedureId,
              outcome: "success",
              reason: `Accepted from automation queue item ${queueItemId}`,
            })));
          } catch {
            // ignore
          }
        }
      }
      return loadQueueItemRow(queueItemId) ? toQueueItem(loadQueueItemRow(queueItemId)!) : null;
    },

    getNightShiftState(): NightShiftState {
      const settings = readNightShiftSettings();
      const queue = db.all<AutomationQueueItemRow>(
        `
        select
          id, automation_id, run_id, mission_id, position, title, mode, queue_status, trigger_type, summary, severity_summary,
          confidence_json, file_count, spend_usd, verification_required, suggested_actions_json, procedure_signals_json,
          created_at, updated_at
        from automation_queue_items
        where project_id = ? and queue_status = 'queued-for-night-shift'
        order by position asc, created_at asc
        `,
        [projectId]
      ).map((row): NightShiftQueueItem => {
        const item = toQueueItem(row);
        const rule = findRule(item.automationId);
        const runRow = item.runId ? loadRunRow(item.runId) : null;
        return {
          id: item.id,
          automationId: item.automationId,
          title: item.title,
          reviewProfile: rule?.reviewProfile ?? "quick",
          executorMode: rule?.executor.mode ?? "night-shift",
          targetLabel: targetLabelForRule(rule ?? {
            id: item.automationId,
            name: item.title,
            enabled: true,
            mode: "review",
            triggers: [{ type: item.triggerType }],
            trigger: { type: item.triggerType },
            executor: { mode: "night-shift" },
            reviewProfile: "quick",
            toolPalette: ["repo"],
            contextSources: [],
            memory: { mode: "project" },
            guardrails: {},
            outputs: { disposition: "comment-only" },
            verification: { verifyBeforePublish: false, mode: "intervention" },
            billingCode: `auto:${item.automationId}`,
            actions: [],
          }),
          scheduledWindow: `${settings.activeHours.start} - ${settings.activeHours.end}`,
          status: item.missionId ? "running" : runRow?.status === "paused" ? "paused" : settings.paused ? "paused" : "queued",
          position: Number(row.position ?? 0),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
      });
      const latest = db.get<MorningBriefingRow>(
        `
          select id, created_at, completed_at, total_runs, succeeded_runs, failed_runs, total_spend_usd, cards_json
          from automation_morning_briefings
          where project_id = ?
            and acknowledged_at is null
          order by created_at desc
          limit 1
        `,
        [projectId]
      );
      return {
        settings,
        queue,
        latestBriefing: latest ? {
          id: latest.id,
          createdAt: latest.created_at,
          completedAt: latest.completed_at ?? null,
          totalRuns: latest.total_runs,
          succeededRuns: latest.succeeded_runs,
          failedRuns: latest.failed_runs,
          totalSpendUsd: Number(latest.total_spend_usd ?? 0),
          cards: safeJsonParseArray<NightShiftBriefing["cards"][number]>(latest.cards_json),
        } : null,
      };
    },

    updateNightShiftSettings(args: UpdateNightShiftSettingsRequest): NightShiftState {
      const current = readNightShiftSettings();
      const next: NightShiftSettings = {
        activeHours: {
          start: args.activeHours?.start?.trim() || current.activeHours.start,
          end: args.activeHours?.end?.trim() || current.activeHours.end,
          timezone: args.activeHours?.timezone?.trim() || current.activeHours.timezone,
        },
        utilizationPreset: args.utilizationPreset ?? current.utilizationPreset,
        paused: typeof args.paused === "boolean" ? args.paused : current.paused,
        updatedAt: nowIso(),
      };
      writeNightShiftSettings(next);
      emit({ type: "night-shift-updated" });
      void processNightShiftQueue();
      return this.getNightShiftState();
    },

    getMorningBriefing(): NightShiftBriefing | null {
      return this.getNightShiftState().latestBriefing;
    },

    acknowledgeMorningBriefing(args: { id: string }): NightShiftBriefing | null {
      const id = args.id.trim();
      if (!id) return null;
      db.run(`update automation_morning_briefings set acknowledged_at = ? where id = ? and project_id = ?`, [nowIso(), id, projectId]);
      return this.getMorningBriefing();
    },

    async mutateNightShiftQueue(args: NightShiftQueueMutationRequest): Promise<NightShiftState> {
      const queueItemId = args.queueItemId.trim();
      if (!queueItemId) return this.getNightShiftState();
      const row = loadQueueItemRow(queueItemId);
      if (!row) return this.getNightShiftState();
      if (args.action === "remove") {
        updateQueueItemStatus(queueItemId, "archived");
        if (row.run_id) updateRun(row.run_id, { queue_status: "archived" });
      } else if (args.action === "pause") {
        if (row.run_id) updateRun(row.run_id, { status: "paused" });
      } else if (args.action === "resume") {
        if (row.run_id) updateRun(row.run_id, { status: "queued" });
      } else if (args.action === "move") {
        const items = db.all<{ id: string }>(
          `select id from automation_queue_items where project_id = ? and queue_status = 'queued-for-night-shift' order by position asc, created_at asc`,
          [projectId]
        ).map((entry) => entry.id);
        const current = items.filter((id) => id !== queueItemId);
        const nextIndex = Math.max(0, Math.min(current.length, Math.floor(args.position)));
        current.splice(nextIndex, 0, queueItemId);
        current.forEach((id, index) => {
          db.run(`update automation_queue_items set position = ?, updated_at = ? where id = ? and project_id = ?`, [index + 1, nowIso(), id, projectId]);
        });
      } else if (args.action === "run-now") {
        const runRow = row.run_id ? loadRunRow(row.run_id) : null;
        const rule = findRule(row.automation_id);
        if (rule) {
          await dispatchMissionRun({
            rule,
            trigger: {
              triggerType: row.trigger_type as AutomationTriggerType,
              ...(safeJsonParseRecord(runRow?.trigger_metadata ?? null) ?? {}),
            } as TriggerContext,
            existingRunId: runRow?.id ?? null,
            existingQueueItemId: row.id,
            queuedFromNightShift: true,
          });
        }
      }
      emit({ type: "night-shift-updated", queueItemId });
      return this.getNightShiftState();
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
      void dispatchTrigger({ triggerType: "session-end", laneId: args.laneId, sessionId: args.sessionId, reason: "session_end" });
    },

    onHeadChanged(args: { laneId: string; preHeadSha: string | null; postHeadSha: string | null; reason: string }) {
      if (!args.postHeadSha || args.postHeadSha === args.preHeadSha) return;
      void dispatchTrigger({ triggerType: "commit", laneId: args.laneId, commitSha: args.postHeadSha, reason: args.reason });
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
      emit({ type: "night-shift-updated" });
    },

    dispose() {
      clearInterval(nightShiftTimer);
      for (const task of scheduleTasks.values()) {
        try {
          task.stop();
        } catch {
          // ignore
        }
      }
      scheduleTasks.clear();
    }
  };
}
