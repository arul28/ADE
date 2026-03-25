import React from "react";
import {
  Rocket,
  CircleHalf,
  Robot,
  Shield,
  Lightning,
  GitBranch,
  ChatCircle,
  Pulse,
} from "@phosphor-icons/react";
import type {
  MissionCliPermissionMode,
  MissionCliSandboxPermissions,
  MissionInProcessPermissionMode,
  MissionPermissionConfig,
  ModelConfig,
  MissionPriority,
  MissionStatus,
  OrchestratorAttempt,
  OrchestratorChatMessage,
  OrchestratorClaim,
  OrchestratorStep,
  MissionMetricToggle,
  MissionMetricSample,
  OrchestratorStepStatus,
  SmartBudgetConfig,
  MissionIntervention,
} from "../../../shared/types";
import { getDefaultModelDescriptor, getModelById } from "../../../shared/modelRegistry";
import { COLORS } from "../lanes/laneDesignTokens";

/* ════════════════════ STATUS CONFIG (VAL-UX-007) ════════════════════ */

/**
 * Single canonical status configuration — color / label / icon per MissionStatus.
 * Every component that needs status styling MUST import from here. (VAL-UX-007)
 */
export const STATUS_CONFIG: Record<MissionStatus, {
  color: string;
  label: string;
  icon: string;
  background: string;
  border: string;
}> = {
  queued:                 { color: "#71717A", label: "Queued",  icon: "⏳", background: "#71717A18", border: "1px solid #71717A30" },
  planning:              { color: "#3B82F6", label: "Planning", icon: "📋", background: "#3B82F618", border: "1px solid #3B82F630" },
  in_progress:           { color: "#22C55E", label: "Running",  icon: "▶",  background: "#22C55E18", border: "1px solid #22C55E30" },
  intervention_required: { color: "#F59E0B", label: "Action",   icon: "⚠",  background: "#F59E0B18", border: "1px solid #F59E0B30" },
  completed:             { color: "#22C55E", label: "Done",     icon: "✓",  background: "#22C55E18", border: "1px solid #22C55E30" },
  failed:                { color: "#EF4444", label: "Failed",   icon: "✗",  background: "#EF444418", border: "1px solid #EF444430" },
  canceled:              { color: "#71717A", label: "Canceled",  icon: "⊘",  background: "#71717A18", border: "1px solid #71717A30" },
};

export const PRIORITY_STYLES: Record<MissionPriority, { background: string; color: string; border: string }> = {
  urgent: { background: "#EF444418", color: "#EF4444", border: "1px solid #EF444430" },
  high: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  normal: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  low: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
};

export const STEP_STATUS_HEX: Record<string, string> = {
  pending: "#3B82F6",
  ready: "#3B82F6",
  running: "#A78BFA",
  succeeded: "#22C55E",
  failed: "#EF4444",
  skipped: "#71717A",
  superseded: "#F59E0B",
  blocked: "#F59E0B",
  canceled: "#71717A",
};

export const EXECUTOR_BADGE_HEX: Record<string, string> = {
  unified: "#6366F1",
  claude: "#A78BFA",
  codex: "#22C55E",
  shell: "#F59E0B",
  manual: "#3B82F6",
};

import { TERMINAL_MISSION_STATUSES } from "../../../shared/types";
export { TERMINAL_MISSION_STATUSES };

export const NOISY_EVENT_TYPES = new Set([
  "scheduler_tick",
  "claim_heartbeat",
  "autopilot_parallelism_cap_adjusted",
  "context_snapshot_created",
  "context_pack_v2_metrics",
  "executor_session_attached",
  "startup_verification_warning",
  "step_metadata_updated",
  "step_dependencies_resolved",
  "tick",
  "dynamic_cap",
]);

export const STALE_HEARTBEAT_THRESHOLD_MINUTES = 3;

export const METRIC_TOGGLE_ORDER: MissionMetricToggle[] = [
  "planning",
  "implementation",
  "testing",
  "validation",
  "code_review",
  "test_review",
  "integration",
  "cost",
  "tokens",
  "retries",
  "claims",
  "context_pressure",
  "interventions"
];

export const METRIC_TOGGLE_LABELS: Record<MissionMetricToggle, string> = {
  planning: "Planning",
  implementation: "Implementation",
  testing: "Testing",
  validation: "Validation",
  code_review: "Code Review",
  test_review: "Test Review",
  integration: "Integration",
  cost: "Cost",
  tokens: "Tokens",
  retries: "Retries",
  claims: "Claims",
  context_pressure: "Context Pressure",
  interventions: "Interventions"
};

export const WORKER_STATUS_HEX: Record<string, string> = {
  spawned: "#3B82F6",
  initializing: "#6366F1",
  working: "#A78BFA",
  waiting_input: "#F59E0B",
  idle: "#3B82F6",
  completed: "#22C55E",
  failed: "#EF4444",
  disposed: "#71717A",
};

export type WorkspaceTab = "overview" | "plan" | "chat" | "artifacts" | "history";
export type MissionListViewMode = "list" | "board";
export type PlannerProvider = "auto" | "claude" | "codex";
export type TeammatePlanMode = "auto" | "off" | "required";
export type SteeringEntry = { directive: string; appliedAt: string };

export const MISSION_BOARD_COLUMNS: Array<{ key: MissionStatus; label: string; hex: string }> = [
  { key: "queued", label: "QUEUED", hex: "#71717A" },
  { key: "planning", label: "PLANNING", hex: "#3B82F6" },
  { key: "in_progress", label: "RUNNING", hex: "#22C55E" },
  { key: "intervention_required", label: "ACTION", hex: "#F59E0B" },
  { key: "completed", label: "DONE", hex: "#22C55E" },
  { key: "failed", label: "FAILED", hex: "#EF4444" },
  { key: "canceled", label: "CANCELED", hex: "#71717A" },
];

export type MissionSettingsDraft = {
  defaultOrchestratorModel: ModelConfig;
  teammatePlanMode: TeammatePlanMode;
  permissionConfig: MissionPermissionConfig;
  /** @deprecated kept for backward-compat read/write */
  cliMode: MissionCliPermissionMode;
  /** @deprecated kept for backward-compat read/write */
  cliSandboxPermissions: MissionCliSandboxPermissions;
  /** @deprecated kept for backward-compat read/write */
  inProcessMode: MissionInProcessPermissionMode;
  /** Smart token budget configuration (persisted as mission-level default) */
  smartBudget: SmartBudgetConfig;
};

export const DEFAULT_ORCHESTRATOR_MODEL: ModelConfig = {
  provider: "claude",
  modelId: "anthropic/claude-sonnet-4-6",
  thinkingLevel: "medium",
};

export const DEFAULT_PERMISSION_CONFIG: MissionPermissionConfig = {
  providers: {
    claude: "full-auto",
    codex: "full-auto",
    unified: "full-auto",
    codexSandbox: "workspace-write",
  },
  externalMcp: {
    enabled: false,
    selectedServers: [],
    selectedTools: [],
  },
};

export const DEFAULT_SMART_BUDGET: SmartBudgetConfig = {
  enabled: false,
  fiveHourThresholdUsd: 10,
  weeklyThresholdUsd: 50,
};

export const DEFAULT_MISSION_SETTINGS_DRAFT: MissionSettingsDraft = {
  defaultOrchestratorModel: { ...DEFAULT_ORCHESTRATOR_MODEL },
  teammatePlanMode: "auto",
  permissionConfig: { ...DEFAULT_PERMISSION_CONFIG },
  cliMode: "full-auto",
  cliSandboxPermissions: "workspace-write",
  inProcessMode: "full-auto",
  smartBudget: { ...DEFAULT_SMART_BUDGET },
};

/* ════════════════════ PURE UTILITY FUNCTIONS ════════════════════ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isDisplayOnlyTaskStep(
  step: Pick<OrchestratorStep, "metadata"> | null | undefined,
): boolean {
  void step;
  return false;
}

export function filterExecutionSteps<T extends { metadata?: unknown }>(steps: T[]): T[] {
  return steps.filter((step) => {
    const metadata = isRecord(step.metadata) ? step.metadata : null;
    return metadata?.isTask !== true && metadata?.displayOnlyTask !== true;
  });
}

export function readBool(primary: unknown, fallback: unknown, defaultValue: boolean): boolean {
  if (typeof primary === "boolean") return primary;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

export function readString(primary: unknown, fallback: unknown, defaultValue: string): string {
  if (typeof primary === "string" && primary.length > 0) return primary;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return defaultValue;
}

export function toPlannerProvider(value: string): PlannerProvider {
  if (value === "auto") return "auto";
  if (value === "claude" || value === "codex") return value;
  const model = getModelById(value);
  if (model?.family === "anthropic") return "claude";
  if (model?.family === "openai") return "codex";
  return "auto";
}

/** Convert a legacy PlannerProvider string to a full ModelConfig. */
export function plannerProviderToModelConfig(provider: PlannerProvider): ModelConfig {
  if (provider === "codex") {
    return {
      provider: "codex",
      modelId: getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex",
      thinkingLevel: "medium",
    };
  }
  // "auto" and "claude" both default to claude
  return { ...DEFAULT_ORCHESTRATOR_MODEL };
}

/** Convert a ModelConfig back to a legacy PlannerProvider for backward compat. */
export function modelConfigToPlannerProvider(config: ModelConfig): PlannerProvider {
  const model = config.modelId ? getModelById(config.modelId) : undefined;
  if (model?.family === "openai") return "codex";
  if (model?.family === "anthropic") return "claude";
  return "auto";
}

export function toTeammatePlanMode(value: string): TeammatePlanMode {
  return value === "off" || value === "required" || value === "auto" ? value : "auto";
}

export function toCliMode(value: string): MissionCliPermissionMode {
  return value === "read-only" || value === "edit" || value === "full-auto" ? value : "full-auto";
}

export function toCliSandboxPermissions(value: string): MissionCliSandboxPermissions {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : "workspace-write";
}

export function toInProcessMode(value: string): MissionInProcessPermissionMode {
  if (value === "plan" || value === "edit" || value === "full-auto") return value;
  return "full-auto";
}

export function formatElapsed(startedAt: string | null, endedAt?: string | null): string {
  if (!startedAt) return "--";
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  const delta = Math.max(0, end - Date.parse(startedAt));
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export function compactText(value: string, maxChars = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized.length) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}...`;
}

export function looksLikeLowSignalNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.length) return true;
  if (/^streaming(?:\.\.\.)?$/i.test(trimmed)) return true;
  if (/^usage$/i.test(trimmed)) return true;
  if (/^mcp:/i.test(trimmed)) return true;
  if (/^[\-dlcbps][rwx\-@+]{8,}/i.test(trimmed)) return true;
  if (/^[A-Z0-9 .:_()/-]{24,}$/.test(trimmed)) return true;
  if (!/\s/.test(trimmed) && trimmed.length < 24 && !/[.!?]/.test(trimmed)) return true;
  if (/^[A-Za-z]+$/.test(trimmed) && trimmed.length < 24) return true;
  return false;
}

function titleCaseQuestionLabel(raw: string): string {
  return raw
    .split(/[\s_-]+/)
    .map((token) => token ? `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}` : "")
    .join(" ")
    .trim();
}

export function getQuestionOwnerLabelFromMetadata(metadata: unknown): string | null {
  const meta = isRecord(metadata) ? metadata : null;
  if (!meta) return null;
  const explicitLabel = typeof meta.questionOwnerLabel === "string" ? meta.questionOwnerLabel.trim() : "";
  if (explicitLabel.length > 0) return explicitLabel;

  const ownerKind = typeof meta.questionOwnerKind === "string" ? meta.questionOwnerKind.trim().toLowerCase() : "";
  if (ownerKind === "coordinator") return "Coordinator question";
  if (ownerKind === "planner") return "Planner question";
  if (ownerKind === "developer") return "Developer question";
  if (ownerKind === "validator") return "Validator question";
  if (ownerKind === "tester") return "Tester question";

  const phaseName = typeof meta.phaseName === "string" ? meta.phaseName.trim() : "";
  const phase = typeof meta.phase === "string" ? meta.phase.trim() : "";
  const normalizedPhase = (phase || phaseName).toLowerCase();
  if (normalizedPhase === "planning") return "Planner question";
  if (normalizedPhase === "development") return "Developer question";
  if (normalizedPhase === "validation") return "Validator question";
  if (normalizedPhase === "testing") return "Tester question";

  const source = typeof meta.source === "string" ? meta.source.trim().toLowerCase() : "";
  if (source === "request_user_input") return "Coordinator question";
  if ((source === "ask_user" || source === "manual_input") && (phaseName || phase)) {
    return `${titleCaseQuestionLabel(phaseName || phase)} question`;
  }
  return null;
}

export function getMissionInterventionOwnerLabel(
  intervention: Pick<MissionIntervention, "interventionType" | "metadata"> | null | undefined,
): string | null {
  if (!intervention || intervention.interventionType !== "manual_input") return null;
  return getQuestionOwnerLabelFromMetadata(intervention.metadata);
}

function titleizeMissionWorkerToken(value: string): string {
  if (!value.length) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function inferMissionWorkerPhase(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized.length) return null;
  if (normalized.startsWith("planner") || normalized.startsWith("plan")) return "Planning";
  if (normalized.startsWith("dev") || normalized.startsWith("implement")) return "Development";
  if (normalized.startsWith("validator") || normalized.startsWith("validate")) return "Validation";
  if (normalized.startsWith("test")) return "Testing";
  if (normalized.startsWith("review")) return "Review";
  return null;
}

function humanizeMissionWorkerText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.length) return "Worker";
  const withoutPrefix = trimmed
    .replace(/^Worker:\s*/i, "")
    .replace(/^worker[_:-]*/i, "")
    .replace(/^teammate[_:-]*/i, "");
  const withoutTimestamp = withoutPrefix.replace(/[_-]\d{10,}$/, "");
  const withColon = withoutTimestamp.replace(/__/g, ": ");
  return withColon
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatMissionWorkerPresentation(args: {
  title?: string | null;
  stepKey?: string | null;
}): {
  label: string;
  fullLabel: string;
  phaseLabel: string | null;
} {
  const raw = (args.title && args.title.trim().length ? args.title : args.stepKey) ?? "Worker";
  const human = humanizeMissionWorkerText(raw);
  const [lead, ...rest] = human.split(":");
  const inferredPhase = inferMissionWorkerPhase(lead ?? "") ?? inferMissionWorkerPhase(args.stepKey ?? "");
  if (rest.length > 0 && inferredPhase) {
    const detail = rest.join(":").trim();
    return {
      label: detail.length ? detail : inferredPhase,
      fullLabel: detail.length ? `${inferredPhase}: ${detail}` : inferredPhase,
      phaseLabel: inferredPhase,
    };
  }
  const tokens = human.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const maybePhase = inferMissionWorkerPhase(tokens[0] ?? "");
    if (maybePhase) {
      const detail = tokens.slice(1).join(" ").trim();
      return {
        label: detail.length ? detail : maybePhase,
        fullLabel: detail.length ? `${maybePhase}: ${detail}` : maybePhase,
        phaseLabel: maybePhase,
      };
    }
  }
  return {
    label: human,
    fullLabel: inferredPhase && human !== inferredPhase ? `${inferredPhase}: ${human}` : human,
    phaseLabel: inferredPhase ?? (human === "Worker" ? null : titleizeMissionWorkerToken(human.split(" ")[0] ?? "")),
  };
}

export function isPlannerStreamMessage(msg: OrchestratorChatMessage): boolean {
  if (msg.role !== "worker") return false;
  if (!isRecord(msg.metadata)) return false;
  const planner = isRecord(msg.metadata.planner) ? msg.metadata.planner : null;
  return Boolean(planner && planner.stream === true);
}

export function collapsePlannerStreamMessages(messages: OrchestratorChatMessage[]): OrchestratorChatMessage[] {
  if (messages.length < 2) return messages;
  const collapsed: OrchestratorChatMessage[] = [];
  let activePlannerMessage: OrchestratorChatMessage | null = null;

  for (const message of messages) {
    if (!isPlannerStreamMessage(message)) {
      if (activePlannerMessage) {
        collapsed.push(activePlannerMessage);
        activePlannerMessage = null;
      }
      collapsed.push(message);
      continue;
    }

    if (
      activePlannerMessage
      && isPlannerStreamMessage(activePlannerMessage)
      && activePlannerMessage.threadId === message.threadId
      && activePlannerMessage.sourceSessionId === message.sourceSessionId
    ) {
      const sep: string =
        activePlannerMessage.content.endsWith("\n") || message.content.startsWith("\n")
          ? ""
          : "\n";
      const prev: OrchestratorChatMessage = activePlannerMessage;
      activePlannerMessage = {
        ...prev,
        content: `${prev.content}${sep}${message.content}`,
        timestamp: message.timestamp
      };
      continue;
    }

    if (activePlannerMessage) collapsed.push(activePlannerMessage);
    activePlannerMessage = { ...message };
  }

  if (activePlannerMessage) collapsed.push(activePlannerMessage);
  return collapsed;
}

export function stepIntentSummary(step: OrchestratorStep): string {
  const meta = isRecord(step.metadata) ? step.metadata : {};
  const planStep = isRecord(meta.planStep) ? meta.planStep : {};
  const candidates: string[] = [];
  if (typeof planStep.description === "string" && planStep.description.trim().length) {
    candidates.push(planStep.description);
  }
  if (typeof meta.instructions === "string" && meta.instructions.trim().length) {
    candidates.push(meta.instructions);
  }
  if (typeof meta.doneCriteria === "string" && meta.doneCriteria.trim().length) {
    candidates.push(`Completion target: ${meta.doneCriteria}`);
  }
  if (typeof meta.stepType === "string" && meta.stepType.trim().length) {
    candidates.push(`Task type: ${meta.stepType}`);
  }
  const first = candidates.find((entry) => entry.trim().length > 0);
  return compactText(first ?? "No additional detail yet.");
}

export function resolveStepHeartbeatAt(args: {
  step: OrchestratorStep;
  attempts: OrchestratorAttempt[];
  claims: OrchestratorClaim[];
}): string | null {
  const toEpoch = (iso: string): number => {
    const ts = Date.parse(iso);
    return Number.isFinite(ts) ? ts : -1;
  };
  const pickMostRecent = (claims: OrchestratorClaim[]): string | null => {
    if (!claims.length) return null;
    return [...claims]
      .sort((a, b) => toEpoch(b.heartbeatAt) - toEpoch(a.heartbeatAt))[0]?.heartbeatAt ?? null;
  };

  const latestAttemptId = args.attempts[0]?.id ?? null;
  if (latestAttemptId) {
    const latestAttemptHeartbeat = pickMostRecent(
      args.claims.filter((claim) => claim.attemptId === latestAttemptId)
    );
    if (latestAttemptHeartbeat) return latestAttemptHeartbeat;
  }

  const attemptIds = new Set(args.attempts.map((attempt) => attempt.id));
  return pickMostRecent(
    args.claims.filter((claim) =>
      claim.stepId === args.step.id || (claim.attemptId ? attemptIds.has(claim.attemptId) : false)
    )
  );
}

export function heartbeatAgeMinutes(iso: string | null): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, (Date.now() - ts) / 60_000);
}

/** Turn a raw orchestrator timeline event into a human-readable sentence. */
export function narrativeForEvent(ev: { eventType: string; reason: string; stepId?: string | null }): string {
  const r = ev.reason.toLowerCase();
  const stepLabel = ev.stepId ? `'${ev.stepId.slice(0, 8)}'` : "";

  if (ev.eventType === "run_status_changed" || ev.eventType === "run_created" ||
      ev.eventType === "run_resumed" || ev.eventType === "run_canceled") {
    if (r.includes("started") || ev.eventType === "run_created") return "Mission execution started";
    if (r.includes("completed") || r.includes("succeeded")) return "All steps completed successfully";
    if (r.includes("failed")) return `Mission failed \u2014 ${ev.reason}`;
    if (r.includes("paused")) return "Execution paused \u2014 awaiting intervention";
    if (r.includes("resumed") || ev.eventType === "run_resumed") return "Execution resumed";
    if (r.includes("canceled") || ev.eventType === "run_canceled") return "Run canceled by user";
    return `Mission status updated: ${ev.reason}`;
  }

  if (ev.eventType === "step_status_changed" || ev.eventType === "step_registered" ||
      ev.eventType === "step_dependencies_resolved" || ev.eventType === "step_skipped") {
    if (ev.eventType === "step_registered") return `Step ${stepLabel} registered in the plan`;
    if (ev.eventType === "step_dependencies_resolved") return `Dependencies resolved for step ${stepLabel}`;
    if (ev.eventType === "step_skipped" || r.includes("skipped")) return `Leader decided to skip step ${stepLabel}`;
    if (r.includes("ready")) return `Step ${stepLabel} is ready for execution`;
    if (r.includes("running") || r.includes("started")) return `Worker picked up step ${stepLabel}`;
    if (r.includes("succeeded")) return `Step ${stepLabel} completed successfully`;
    if (r.includes("failed")) return `Step ${stepLabel} failed: ${ev.reason}`;
    return `Step update: ${ev.reason}`;
  }

  if (ev.eventType === "attempt_started" || ev.eventType === "attempt_completed" ||
      ev.eventType === "attempt_blocked" || ev.eventType === "attempt_retry_scheduled" ||
      ev.eventType === "attempt_recovered_after_restart") {
    if (ev.eventType === "attempt_started" || r.includes("started") || r.includes("running")) return "Agent started working on attempt";
    if (r.includes("succeeded")) return "Agent finished work \u2014 output ready for evaluation";
    if (r.includes("failed")) return `Agent encountered an error: ${ev.reason}`;
    if (ev.eventType === "attempt_blocked") return "Attempt blocked \u2014 waiting for dependencies";
    if (ev.eventType === "attempt_retry_scheduled") return "Retry scheduled for failed attempt";
    if (ev.eventType === "attempt_recovered_after_restart") return "Attempt recovered after process restart";
    return `Worker activity: ${ev.reason}`;
  }

  if (ev.eventType === "claim_acquired" || ev.eventType === "claim_released" ||
      ev.eventType === "claim_expired" || ev.eventType === "claim_heartbeat") {
    if (r.includes("acquired") || ev.eventType === "claim_acquired") return "Agent claimed resources for execution";
    if (r.includes("released") || ev.eventType === "claim_released") return "Agent released resources";
    if (ev.eventType === "claim_expired") return "Resource claim expired";
    if (ev.eventType === "claim_heartbeat") return "Worker heartbeat received";
    return `Resource update: ${ev.reason}`;
  }

  if (ev.eventType === "autopilot_advance") return `Autopilot advanced: ${ev.reason}`;
  if (ev.eventType === "autopilot_attempt_start_failed") return `Autopilot failed to start attempt: ${ev.reason}`;

  if (ev.eventType === "context_snapshot_created") return "Context snapshot saved for future reference";
  if (ev.eventType === "context_pressure_warning") return "Context window pressure detected \u2014 may need to compact";
  if (ev.eventType === "integration_chain_started") return "Integration merge chain started";

  if (ev.eventType === "validation_contract_unfulfilled") return "Validation contract unfulfilled";
  if (ev.eventType === "validation_self_check_reminder") return "Self-check reminder issued";
  if (ev.eventType === "validation_auto_spawned") return "Validator auto-spawned";
  if (ev.eventType === "validation_gate_blocked") return "Spawn blocked by validation gate";
  if (ev.eventType === "validation_reported") return "Validation result reported";
  if (ev.eventType === "validation_escalated") return "Validation escalated";

  if (ev.eventType === "intervention_opened") return "Intervention opened";
  if (ev.eventType === "intervention_resolved") return "Intervention resolved";

  if (ev.eventType === "budget_warning") return "Budget warning issued";
  if (ev.eventType === "budget_exceeded") return "Budget exceeded";
  if (ev.eventType === "budget_updated") return "Budget updated";
  if (ev.eventType === "budget_hard_cap_triggered") return "Budget hard cap triggered";

  if (ev.eventType === "recovery_loop_started") return "Recovery loop started";
  if (ev.eventType === "recovery_loop_exhausted") return "Recovery retries exhausted";

  if (ev.eventType === "fan_out_dispatched") return "Fan-out dispatched";
  if (ev.eventType === "fan_out_complete") return "Fan-out complete";

  if (ev.eventType === "phase_transition") return "Phase transitioned";
  if (ev.eventType === "coordinator_steering") return "User steering directive";
  if (ev.eventType === "coordinator_broadcast") return "Coordinator broadcast";

  return ev.reason || "Event recorded";
}

/** Pick a Phosphor icon component for a timeline event type. */
export function iconForEventType(eventType: string): React.ElementType {
  if (eventType.startsWith("run_") || eventType === "run_status_changed") return Rocket;
  if (eventType.startsWith("step_") || eventType === "step_status_changed") return CircleHalf;
  if (eventType.startsWith("attempt_")) return Robot;
  if (eventType.startsWith("claim_")) return Shield;
  if (eventType.startsWith("autopilot")) return Lightning;
  if (eventType.startsWith("context_")) return GitBranch;
  if (eventType.startsWith("validation_")) return Shield;
  if (eventType.startsWith("intervention_")) return Lightning;
  if (eventType.startsWith("budget_")) return Pulse;
  if (eventType.startsWith("recovery_")) return Robot;
  if (eventType.startsWith("phase_")) return CircleHalf;
  if (eventType.startsWith("fan_out_")) return Robot;
  if (eventType.startsWith("coordinator_")) return ChatCircle;
  if (eventType.startsWith("worker_")) return Robot;
  if (eventType.startsWith("integration_")) return GitBranch;
  if (eventType === "user_directive") return ChatCircle;
  return Pulse;
}

/** Hex color for a timeline event type icon. */
export function iconHexForEventType(eventType: string, reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("failed") || r.includes("error")) return "#EF4444";
  if (r.includes("succeeded") || r.includes("completed") || r.includes("success")) return "#22C55E";
  if (r.includes("paused") || r.includes("blocked")) return "#F59E0B";
  if (eventType.startsWith("run_")) return "#22C55E";
  if (eventType.startsWith("step_")) return "#3B82F6";
  if (eventType.startsWith("attempt_")) return "#A78BFA";
  if (eventType.startsWith("claim_")) return "#F59E0B";
  if (eventType.startsWith("autopilot")) return "#A78BFA";
  if (eventType === "user_directive") return "#06B6D4";
  return COLORS.textMuted;
}

export function narrativeSummary(
  events: Array<{ eventType: string; reason: string; stepId?: string | null }>,
  directives: SteeringEntry[] = []
): string[] {
  const lines: string[] = [];
  for (const d of directives) {
    lines.push(`User directive: ${d.directive}`);
  }
  for (const ev of events.slice(0, 12)) {
    lines.push(narrativeForEvent(ev));
  }
  return lines;
}

export function formatMetricSample(sample: MissionMetricSample): string {
  const rounded = Number.isFinite(sample.value) ? sample.value.toFixed(sample.value >= 100 ? 0 : 2) : "0";
  if (sample.unit && sample.unit.trim().length) return `${rounded} ${sample.unit}`;
  return rounded;
}

export const PLAN_DONE_STATUSES = new Set<OrchestratorStepStatus>(["succeeded", "skipped", "superseded", "canceled"]);

export function statusGlyph(status: OrchestratorStepStatus): string {
  if (status === "succeeded" || status === "skipped") return "\u2713";
  if (status === "running" || status === "ready") return "\u25CF";
  if (status === "failed") return "\u2717";
  if (status === "superseded") return "~";
  return "\u25CB";
}

/* ════════════════════ ELAPSED TIME COMPONENT ════════════════════ */

/** Self-ticking elapsed-time display — isolates the 1s timer from the parent tree. */
export function ElapsedTime({ startedAt, endedAt }: { startedAt: string | null; endedAt?: string | null }) {
  const [, setTick] = React.useState(0);
  const isTerminal = !!endedAt;
  React.useEffect(() => {
    if (isTerminal || !startedAt) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isTerminal, startedAt]);
  return React.createElement(React.Fragment, null, formatElapsed(startedAt, endedAt));
}

/* ════════════════════ ERROR CLASSIFICATION (VAL-UX-008) ════════════════════ */

export type ErrorSource = "ADE" | "Provider" | "Executor" | "Runtime";

export const ERROR_SOURCE_COLORS: Record<ErrorSource, string> = {
  ADE: "#EF4444",
  Provider: "#F59E0B",
  Executor: "#3B82F6",
  Runtime: "#71717A",
};

/**
 * Classify an error message into its source. (VAL-UX-008)
 * ADE = orchestrator / internal bugs. Provider = AI API / rate-limit / quota.
 * Executor = CLI / process spawn. Runtime = env / config / MCP / sandbox.
 */
export function classifyErrorSource(message: string): ErrorSource {
  const m = message.toLowerCase();
  // Provider errors (rate limit, quota, API, model)
  if (
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("429") ||
    m.includes("quota") ||
    m.includes("api key") ||
    m.includes("api_key") ||
    m.includes("authentication") ||
    m.includes("unauthorized") ||
    m.includes("anthropic") ||
    m.includes("openai") ||
    m.includes("model not found") ||
    m.includes("overloaded") ||
    m.includes("capacity")
  ) {
    return "Provider";
  }
  // Executor errors (CLI, spawn, process)
  if (
    m.includes("spawn") ||
    m.includes("enoent") ||
    m.includes("process exit") ||
    m.includes("exit code") ||
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("session") ||
    m.includes("executor") ||
    m.includes("worker crash") ||
    m.includes("startup_failure")
  ) {
    return "Executor";
  }
  // Runtime errors (env, MCP, config, sandbox)
  if (
    m.includes("mcp") ||
    m.includes("sandbox") ||
    m.includes("permission") ||
    m.includes("config") ||
    m.includes("gmail") ||
    m.includes("environment") ||
    m.includes("worktree") ||
    m.includes("lane")
  ) {
    return "Runtime";
  }
  // Default to ADE for internal / orchestrator errors
  return "ADE";
}

/* ════════════════════ PROGRESS COMPUTATION (VAL-UX-003) ════════════════════ */

/**
 * Compute accurate progress from execution steps, excluding superseded and
 * retry variants from both numerator and denominator. (VAL-UX-003)
 */
export function computeProgress(
  steps: Array<Pick<OrchestratorStep, "status" | "metadata">>,
): { completed: number; total: number; pct: number } {
  // Filter out display-only task steps and superseded/retry variants
  const meaningful = steps.filter((step) => {
    const metadata = isRecord(step.metadata) ? step.metadata : null;
    if (metadata?.isTask === true || metadata?.displayOnlyTask === true) return false;
    if (step.status === "superseded") return false;
    // If the step is a retry variant (has retryOf metadata), exclude it
    if (metadata?.retryOf) return false;
    return true;
  });

  const completed = meaningful.filter(
    (s) => s.status === "succeeded" || s.status === "skipped" || s.status === "canceled",
  ).length;
  const total = meaningful.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return { completed, total, pct };
}

/* ════════════════════ FEED DEDUPLICATION (VAL-UX-002) ════════════════════ */

export type CollapsedFeedMessage<T> = {
  item: T;
  count: number;
  collapsed: T[];
};

/**
 * Collapse consecutive duplicate feed events into single entries with count.
 * Groups by eventType and stepId (when present). (VAL-UX-002)
 */
export function collapseFeedMessages<T extends { eventType: string; stepId?: string | null }>(
  events: T[],
): CollapsedFeedMessage<T>[] {
  if (events.length === 0) return [];

  const result: CollapsedFeedMessage<T>[] = [];
  let current: CollapsedFeedMessage<T> = { item: events[0]!, count: 1, collapsed: [events[0]!] };

  for (let i = 1; i < events.length; i++) {
    const ev = events[i]!;
    const prev = current.item;
    if (ev.eventType === prev.eventType && ev.stepId === prev.stepId) {
      current.count++;
      current.collapsed.push(ev);
      // Keep the most recent event as the representative
      current.item = ev;
    } else {
      result.push(current);
      current = { item: ev, count: 1, collapsed: [ev] };
    }
  }
  result.push(current);
  return result;
}

/* ════════════════════ LIFECYCLE ACTIONS (VAL-UX-006) ════════════════════ */

export type LifecycleAction = "stop_run" | "cancel_mission" | "archive_mission";

export const LIFECYCLE_ACTIONS: Record<LifecycleAction, {
  label: string;
  color: string;
  confirmText: string | null;
}> = {
  stop_run: {
    label: "Stop Run",
    color: "#F59E0B",       // amber
    confirmText: null,      // no confirmation for stop
  },
  cancel_mission: {
    label: "Cancel Mission",
    color: "#EF4444",       // red
    confirmText: "This will cancel the entire mission. Are you sure?",
  },
  archive_mission: {
    label: "Archive Mission",
    color: "#71717A",       // gray
    confirmText: null,
  },
};

/**
 * Determine which lifecycle actions are available for a given mission + run state.
 * (VAL-UX-006)
 */
export function getAvailableLifecycleActions(
  missionStatus: MissionStatus,
  runStatus: string | null,
): LifecycleAction[] {
  const actions: LifecycleAction[] = [];
  const hasActiveRun = runStatus != null && !["succeeded", "failed", "canceled"].includes(runStatus);
  const isTerminal = TERMINAL_MISSION_STATUSES.has(missionStatus);

  // Stop Run: only when there's an active run
  if (hasActiveRun) {
    actions.push("stop_run");
  }

  // Cancel Mission: when mission is not terminal and there's something to cancel
  if (!isTerminal) {
    actions.push("cancel_mission");
  }

  // Archive Mission: only for terminal missions
  if (isTerminal) {
    actions.push("archive_mission");
  }

  return actions;
}

/* ════════════════════ USAGE FORMATTING ════════════════════ */

/** Format milliseconds into a human-readable reset countdown. (VAL-USAGE-004) */
export function formatResetCountdown(ms: number): string {
  if (ms <= 0) return "resets now";
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

/** Return color for a usage percentage: green < 60%, amber 60-80%, red > 80%. */
export function usagePercentColor(pct: number): string {
  if (pct > 80) return "#EF4444";
  if (pct >= 60) return "#F59E0B";
  return "#22C55E";
}
