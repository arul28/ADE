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
  MissionApiPermissionMode,
  MissionClaudePermissionMode,
  MissionCodexApprovalMode,
  MissionCodexSandboxPermissions,
  MissionPriority,
  MissionStatus,
  OrchestratorAttempt,
  OrchestratorChatMessage,
  OrchestratorClaim,
  OrchestratorStep,
  MissionMetricToggle,
  MissionMetricSample,
  OrchestratorStepStatus,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

/* ════════════════════ STATUS HELPERS ════════════════════ */

export const STATUS_BADGE_STYLES: Record<MissionStatus, { background: string; color: string; border: string }> = {
  queued: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
  planning: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  plan_review: { background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430" },
  in_progress: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" },
  intervention_required: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  completed: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" },
  partially_completed: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  failed: { background: "#EF444418", color: "#EF4444", border: "1px solid #EF444430" },
  canceled: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
};

export const STATUS_DOT_HEX: Record<MissionStatus, string> = {
  queued: "#71717A",
  planning: "#3B82F6",
  plan_review: "#06B6D4",
  in_progress: "#22C55E",
  intervention_required: "#F59E0B",
  completed: "#22C55E",
  partially_completed: "#F59E0B",
  failed: "#EF4444",
  canceled: "#71717A",
};

export const STATUS_LABELS: Record<MissionStatus, string> = {
  queued: "Queued",
  planning: "Planning",
  plan_review: "Review",
  in_progress: "Running",
  intervention_required: "Action",
  completed: "Done",
  partially_completed: "Partial",
  failed: "Failed",
  canceled: "Canceled"
};

export const PRIORITY_STYLES: Record<MissionPriority, { background: string; color: string; border: string }> = {
  urgent: { background: "#EF444418", color: "#EF4444", border: "1px solid #EF444430" },
  high: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  normal: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  low: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
};

export const STEP_STATUS_HEX: Record<string, string> = {
  pending: "#3B82F6",
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

export const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(["completed", "failed", "canceled"]);

export const NOISY_EVENT_TYPES = new Set([
  "claim_heartbeat",
  "context_pack_bootstrap",
  "autopilot_parallelism_cap_adjusted",
  "tick",
  "dynamic_cap",
]);

export const PLANNER_STEP_KEY = "planner";

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

export type WorkspaceTab = "plan" | "work" | "dag" | "chat" | "activity" | "details";
export type MissionListViewMode = "list" | "board";
export type PlannerProvider = "auto" | "claude" | "codex";
export type TeammatePlanMode = "auto" | "off" | "required";
export type SteeringEntry = { directive: string; appliedAt: string };

export const MISSION_BOARD_COLUMNS: Array<{ key: MissionStatus; label: string; hex: string }> = [
  { key: "queued", label: "QUEUED", hex: "#71717A" },
  { key: "planning", label: "PLANNING", hex: "#3B82F6" },
  { key: "plan_review", label: "REVIEW", hex: "#06B6D4" },
  { key: "in_progress", label: "RUNNING", hex: "#22C55E" },
  { key: "intervention_required", label: "ACTION", hex: "#F59E0B" },
  { key: "completed", label: "DONE", hex: "#22C55E" },
  { key: "partially_completed", label: "PARTIAL", hex: "#F59E0B" },
  { key: "failed", label: "FAILED", hex: "#EF4444" },
  { key: "canceled", label: "CANCELED", hex: "#71717A" },
];

export type MissionSettingsDraft = {
  defaultPlannerProvider: PlannerProvider;
  teammatePlanMode: TeammatePlanMode;
  requirePlanReview: boolean;
  claudePermissionMode: MissionClaudePermissionMode;
  claudeDangerouslySkip: boolean;
  codexSandboxPermissions: MissionCodexSandboxPermissions;
  codexApprovalMode: Extract<MissionCodexApprovalMode, "suggest" | "auto-edit" | "full-auto">;
  codexConfigPath: string;
  apiPermissionMode: MissionApiPermissionMode;
};

export const DEFAULT_MISSION_SETTINGS_DRAFT: MissionSettingsDraft = {
  defaultPlannerProvider: "auto",
  teammatePlanMode: "auto",
  requirePlanReview: false,
  claudePermissionMode: "bypassPermissions",
  claudeDangerouslySkip: false,
  codexSandboxPermissions: "workspace-write",
  codexApprovalMode: "full-auto",
  codexConfigPath: "",
  apiPermissionMode: "full-auto",
};

/* ════════════════════ PURE UTILITY FUNCTIONS ════════════════════ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export function toTeammatePlanMode(value: string): TeammatePlanMode {
  return value === "off" || value === "required" || value === "auto" ? value : "auto";
}

export function toClaudePermissionMode(value: string): MissionClaudePermissionMode {
  return value === "default" || value === "plan" || value === "acceptEdits" || value === "bypassPermissions" ? value : "default";
}

export function toCodexSandboxPermissions(value: string): MissionCodexSandboxPermissions {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : "workspace-write";
}

export function toCodexApprovalMode(value: string): Extract<MissionCodexApprovalMode, "suggest" | "auto-edit" | "full-auto"> {
  if (value === "suggest" || value === "auto-edit" || value === "full-auto") return value;
  if (value === "untrusted") return "suggest";
  if (value === "on-request" || value === "on-failure") return "auto-edit";
  if (value === "never") return "full-auto";
  return "full-auto";
}

export function toApiPermissionMode(value: string): MissionApiPermissionMode {
  return value === "plan" || value === "edit" || value === "full-auto" ? value : "full-auto";
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

  if (ev.eventType === "merge_conflict_detected") return `Merge conflict detected for step ${stepLabel}`;
  if (ev.eventType === "code_review_passed") return `Code review passed for step ${stepLabel}`;
  if (ev.eventType === "tests_passed") return `Tests passed for step ${stepLabel}`;
  if (ev.eventType === "integration_started") return `Integration started for step ${stepLabel}`;

  if (ev.eventType === "context_snapshot_created") return "Context snapshot saved for future reference";
  if (ev.eventType === "context_pressure_warning") return "Context window pressure detected \u2014 may need to compact";
  if (ev.eventType === "context_pack_bootstrap") return "Context pack bootstrapped for worker";
  if (ev.eventType === "integration_chain_started") return "Integration merge chain started";

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

import { useState, useEffect } from "react";

/** Self-ticking elapsed-time display — isolates the 1s timer from the parent tree. */
export function ElapsedTime({ startedAt, endedAt }: { startedAt: string | null; endedAt?: string | null }) {
  const [, setTick] = useState(0);
  const isTerminal = !!endedAt;
  useEffect(() => {
    if (isTerminal || !startedAt) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isTerminal, startedAt]);
  return React.createElement(React.Fragment, null, formatElapsed(startedAt, endedAt));
}
