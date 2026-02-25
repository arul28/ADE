import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  Clock,
  SpinnerGap,
  Play,
  Plus,
  ArrowsClockwise,
  Rocket,
  MagnifyingGlass,
  PaperPlaneTilt,
  Stop,
  TerminalWindow,
  X,
  Pulse,
  GitBranch,
  SquaresFour,
  Graph,
  CheckCircle,
  Lightning,
  ChatCircle,
  Robot,
  Shield,
  CircleHalf,
  GearSix,
  Hash,
  CaretDown,
  List,
  Kanban,
  Trash,
  Warning,
  Eye
} from "@phosphor-icons/react";
import { motion, AnimatePresence, LazyMotion, domAnimation } from "motion/react";
import type {
  MissionDetail,
  MissionExecutionPolicy,
  MissionPriority,
  MissionStatus,
  MissionStepStatus,
  MissionSummary,
  OrchestratorAttempt,
  OrchestratorChatMessage,
  OrchestratorChatTarget,
  OrchestratorChatThread,
  OrchestratorClaim,
  OrchestratorWorkerDigest,
  OrchestratorWorkerState,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  OrchestratorStep,
  MissionMetricToggle,
  MissionMetricsConfig,
  MissionMetricSample,
  ProjectConfigSnapshot,
  StartOrchestratorRunFromMissionArgs,
  SteerMissionResult,
  ExecutionPlanPreview as ExecutionPlanPreviewType,
  PrStrategy,
  MissionModelConfig,
  OrchestratorIntelligenceConfig,
  SmartBudgetConfig,
  ModelConfig
} from "../../../shared/types";
import { BUILT_IN_PROFILES, getProfileById } from "../../../shared/modelProfiles";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { OrchestratorActivityFeed } from "./OrchestratorActivityFeed";
import { OrchestratorDAG } from "./OrchestratorDAG";
import { PolicyEditor, PRESET_STANDARD } from "./PolicyEditor";
import { CompletionBanner } from "./CompletionBanner";
import { PhaseProgressBar } from "./PhaseProgressBar";
import { MissionPolicyBadge } from "./MissionPolicyBadge";
import { ExecutionPlanPreview } from "./ExecutionPlanPreview";
import { UsageDashboard } from "./UsageDashboard";
import { AgentChannels } from "./AgentChannels";
import { MissionControlPage } from "./MissionControlPage";
import { ModelProfileSelector } from "./ModelProfileSelector";
import { ModelSelector } from "./ModelSelector";
import { OrchestratorIntelligencePanel } from "./OrchestratorIntelligencePanel";
import { SmartBudgetPanel } from "./SmartBudgetPanel";
import { COLORS, MONO_FONT, SANS_FONT, inlineBadge, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";

/* ════════════════════ STATUS HELPERS ════════════════════ */

const STATUS_BADGE_STYLES: Record<MissionStatus, { background: string; color: string; border: string }> = {
  queued: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
  planning: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  plan_review: { background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430" },
  in_progress: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" },
  intervention_required: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  completed: { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" },
  failed: { background: "#EF444418", color: "#EF4444", border: "1px solid #EF444430" },
  canceled: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
};

const STATUS_DOT_HEX: Record<MissionStatus, string> = {
  queued: "#71717A",
  planning: "#3B82F6",
  plan_review: "#06B6D4",
  in_progress: "#22C55E",
  intervention_required: "#F59E0B",
  completed: "#22C55E",
  failed: "#EF4444",
  canceled: "#71717A",
};

const STATUS_LABELS: Record<MissionStatus, string> = {
  queued: "Queued",
  planning: "Planning",
  plan_review: "Review",
  in_progress: "Running",
  intervention_required: "Action",
  completed: "Done",
  failed: "Failed",
  canceled: "Canceled"
};

const PRIORITY_STYLES: Record<MissionPriority, { background: string; color: string; border: string }> = {
  urgent: { background: "#EF444418", color: "#EF4444", border: "1px solid #EF444430" },
  high: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  normal: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  low: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
};

const STEP_STATUS_COLUMNS: Array<{ status: MissionStepStatus; label: string }> = [
  { status: "pending", label: "PENDING" },
  { status: "running", label: "RUNNING" },
  { status: "succeeded", label: "SUCCEEDED" },
  { status: "failed", label: "FAILED" },
  { status: "skipped", label: "SKIPPED" }
];

const STEP_STATUS_HEX: Record<string, string> = {
  pending: "#3B82F6",
  running: "#A78BFA",
  succeeded: "#22C55E",
  failed: "#EF4444",
  skipped: "#71717A",
  blocked: "#F59E0B",
  canceled: "#71717A",
};

const EXECUTOR_BADGE_HEX: Record<string, string> = {
  claude: "#A78BFA",
  codex: "#22C55E",
  shell: "#F59E0B",
  manual: "#3B82F6",
};

type WorkspaceTab = "board" | "dag" | "channels" | "activity" | "usage";
type MissionListViewMode = "list" | "board";

const MISSION_BOARD_COLUMNS: Array<{ key: MissionStatus; label: string; hex: string }> = [
  { key: "queued", label: "QUEUED", hex: "#71717A" },
  { key: "planning", label: "PLANNING", hex: "#3B82F6" },
  { key: "plan_review", label: "REVIEW", hex: "#06B6D4" },
  { key: "in_progress", label: "RUNNING", hex: "#22C55E" },
  { key: "completed", label: "DONE", hex: "#22C55E" },
  { key: "failed", label: "FAILED", hex: "#EF4444" },
];
type PlannerProvider = "auto" | "claude" | "codex";

type MissionSettingsDraft = {
  defaultExecutionPolicy: MissionExecutionPolicy;
  defaultPrStrategy: PrStrategy;
  defaultPlannerProvider: PlannerProvider;
  requirePlanReview: boolean;
  claudePermissionMode: string;
  claudeDangerouslySkip: boolean;
  codexSandboxPermissions: string;
  codexApprovalMode: string;
  codexConfigPath: string;
};

const DEFAULT_MISSION_SETTINGS_DRAFT: MissionSettingsDraft = {
  defaultExecutionPolicy: PRESET_STANDARD,
  defaultPrStrategy: { kind: "integration", targetBranch: "main", draft: true },
  defaultPlannerProvider: "auto",
  requirePlanReview: false,
  claudePermissionMode: "acceptEdits",
  claudeDangerouslySkip: false,
  codexSandboxPermissions: "workspace-write",
  codexApprovalMode: "full-auto",
  codexConfigPath: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBool(primary: unknown, fallback: unknown, defaultValue: boolean): boolean {
  if (typeof primary === "boolean") return primary;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

function readString(primary: unknown, fallback: unknown, defaultValue: string): string {
  if (typeof primary === "string" && primary.length > 0) return primary;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return defaultValue;
}

function mergeExecutionPolicyWithDefaults(source: unknown, defaults: MissionExecutionPolicy = PRESET_STANDARD): MissionExecutionPolicy {
  if (!isRecord(source)) return defaults;
  const mergePhase = <T extends Record<string, unknown>>(key: keyof MissionExecutionPolicy, phaseDefaults: T): T => {
    const candidate = source[key];
    if (!isRecord(candidate)) return { ...phaseDefaults };
    return { ...phaseDefaults, ...candidate } as T;
  };
  return {
    planning: mergePhase("planning", defaults.planning),
    implementation: mergePhase("implementation", defaults.implementation),
    testing: mergePhase("testing", defaults.testing),
    validation: mergePhase("validation", defaults.validation),
    codeReview: mergePhase("codeReview", defaults.codeReview),
    testReview: mergePhase("testReview", defaults.testReview),
    integration: mergePhase("integration", defaults.integration),
    merge: mergePhase("merge", defaults.merge),
    completion: mergePhase("completion", defaults.completion)
  };
}

function toPlannerProvider(value: string): PlannerProvider {
  return value === "claude" || value === "codex" || value === "auto" ? value : "auto";
}

function toClaudePermissionMode(value: string): "plan" | "acceptEdits" | "bypassPermissions" {
  return value === "plan" || value === "acceptEdits" || value === "bypassPermissions" ? value : "acceptEdits";
}

function toCodexSandboxPermissions(value: string): "read-only" | "workspace-write" | "danger-full-access" {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : "workspace-write";
}

function toCodexApprovalMode(value: string): "suggest" | "auto-edit" | "full-auto" {
  if (value === "suggest" || value === "auto-edit" || value === "full-auto") return value;
  if (value === "untrusted") return "suggest";
  if (value === "on-request" || value === "on-failure") return "auto-edit";
  if (value === "never") return "full-auto";
  return "full-auto";
}

function formatElapsed(startedAt: string | null, endedAt?: string | null): string {
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

const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(["completed", "failed", "canceled"]);

const NOISY_EVENT_TYPES = new Set([
  "claim_heartbeat",
  "context_pack_bootstrap",
  "autopilot_parallelism_cap_adjusted",
  "tick",
  "dynamic_cap",
]);
const PLANNER_STEP_KEY = "planner";

function relativeWhen(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const delta = Math.max(0, Date.now() - ts);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compactText(value: string, maxChars = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized.length) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}...`;
}

function isPlannerStreamMessage(msg: OrchestratorChatMessage): boolean {
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

function stepIntentSummary(step: OrchestratorStep): string {
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

/** Returns the age in minutes of a heartbeat ISO timestamp, or null if unparseable. */
function heartbeatAgeMinutes(iso: string | null): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, (Date.now() - ts) / 60_000);
}

const STALE_HEARTBEAT_THRESHOLD_MINUTES = 3;

/** Turn a raw orchestrator timeline event into a human-readable sentence. */
function narrativeForEvent(ev: { eventType: string; reason: string; stepId?: string | null }): string {
  const r = ev.reason.toLowerCase();
  const stepLabel = ev.stepId ? `'${ev.stepId.slice(0, 8)}'` : "";

  // ── Run-level events ──
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

  // ── Step-level events ──
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

  // ── Attempt-level events ──
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

  // ── Claim events ──
  if (ev.eventType === "claim_acquired" || ev.eventType === "claim_released" ||
      ev.eventType === "claim_expired" || ev.eventType === "claim_heartbeat") {
    if (r.includes("acquired") || ev.eventType === "claim_acquired") return "Agent claimed resources for execution";
    if (r.includes("released") || ev.eventType === "claim_released") return "Agent released resources";
    if (ev.eventType === "claim_expired") return "Resource claim expired";
    if (ev.eventType === "claim_heartbeat") return "Worker heartbeat received";
    return `Resource update: ${ev.reason}`;
  }

  // ── Autopilot events ──
  if (ev.eventType === "autopilot_advance") return `Autopilot advanced: ${ev.reason}`;
  if (ev.eventType === "autopilot_attempt_start_failed") return `Autopilot failed to start attempt: ${ev.reason}`;

  // ── Gate / review events ──
  if (ev.eventType === "merge_conflict_detected") return `Merge conflict detected for step ${stepLabel}`;
  if (ev.eventType === "code_review_passed") return `Code review passed for step ${stepLabel}`;
  if (ev.eventType === "tests_passed") return `Tests passed for step ${stepLabel}`;
  if (ev.eventType === "integration_started") return `Integration started for step ${stepLabel}`;

  // ── Context events ──
  if (ev.eventType === "context_snapshot_created") return "Context snapshot saved for future reference";
  if (ev.eventType === "context_pressure_warning") return "Context window pressure detected \u2014 may need to compact";
  if (ev.eventType === "context_pack_bootstrap") return "Context pack bootstrapped for worker";
  if (ev.eventType === "integration_chain_started") return "Integration merge chain started";

  // ── Fallback ──
  return ev.reason || "Event recorded";
}

/** Pick a Phosphor icon component for a timeline event type. */
function iconForEventType(eventType: string): React.ElementType {
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
function iconHexForEventType(eventType: string, reason: string): string {
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

type SteeringEntry = { directive: string; appliedAt: string };

/** Build narrative lines from timeline + locally tracked directives. */
function narrativeSummary(
  events: Array<{ eventType: string; reason: string; stepId?: string | null }>,
  directives: SteeringEntry[] = []
): string[] {
  const lines: string[] = [];

  // Merge directives into the event stream as synthetic entries for narration
  for (const d of directives) {
    lines.push(`User directive: ${d.directive}`);
  }

  for (const ev of events.slice(0, 12)) {
    lines.push(narrativeForEvent(ev));
  }
  return lines;
}

/* ════════════════════ MISSION CHAT ════════════════════ */

const METRIC_TOGGLE_ORDER: MissionMetricToggle[] = [
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

const METRIC_TOGGLE_LABELS: Record<MissionMetricToggle, string> = {
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

type MetricPresetGroup = {
  label: string;
  tooltip: string;
  toggles: MissionMetricToggle[];
};

const METRIC_PRESET_GROUPS: MetricPresetGroup[] = [
  {
    label: "Performance",
    tooltip: "Token usage, cost estimates, and context window pressure",
    toggles: ["tokens", "cost", "context_pressure"]
  },
  {
    label: "Quality",
    tooltip: "Retry counts, resource claims, and human interventions",
    toggles: ["retries", "claims", "interventions"]
  },
  {
    label: "Progress",
    tooltip: "Phase-level progress: planning through integration",
    toggles: ["planning", "implementation", "testing", "validation", "code_review", "test_review", "integration"]
  }
];

const WORKER_STATUS_HEX: Record<string, string> = {
  spawned: "#3B82F6",
  initializing: "#6366F1",
  working: "#A78BFA",
  waiting_input: "#F59E0B",
  idle: "#3B82F6",
  completed: "#22C55E",
  failed: "#EF4444",
  disposed: "#71717A",
};

function asNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function workerThreadMatchScore(thread: OrchestratorChatThread, target: OrchestratorChatTarget | null | undefined): number {
  if (thread.threadType !== "worker" || !target || target.kind !== "worker") return -1;
  const targetRunId = asNonEmptyString(target.runId);
  const threadRunId = asNonEmptyString(thread.runId);
  if (targetRunId && threadRunId && targetRunId !== threadRunId) return -1;

  let score = 0;
  let matchedIdentity = false;

  if (targetRunId && targetRunId === threadRunId) {
    score += 24;
    matchedIdentity = true;
  }

  const targetAttemptId = asNonEmptyString(target.attemptId);
  const threadAttemptId = asNonEmptyString(thread.attemptId);
  if (targetAttemptId) {
    if (targetAttemptId === threadAttemptId) {
      score += 128;
      matchedIdentity = true;
    }
  }

  const targetSessionId = asNonEmptyString(target.sessionId);
  const threadSessionId = asNonEmptyString(thread.sessionId);
  if (targetSessionId) {
    if (targetSessionId === threadSessionId) {
      score += 96;
      matchedIdentity = true;
    }
  }

  const targetStepId = asNonEmptyString(target.stepId);
  const threadStepId = asNonEmptyString(thread.stepId);
  if (targetStepId) {
    if (targetStepId === threadStepId) {
      score += 64;
      matchedIdentity = true;
    }
  }

  const targetStepKey = asNonEmptyString(target.stepKey);
  const threadStepKey = asNonEmptyString(thread.stepKey);
  if (targetStepKey) {
    if (targetStepKey === threadStepKey) {
      score += 32;
      matchedIdentity = true;
    }
  }

  const targetLaneId = asNonEmptyString(target.laneId);
  const threadLaneId = asNonEmptyString(thread.laneId);
  if (targetLaneId) {
    if (targetLaneId === threadLaneId) {
      score += 8;
      matchedIdentity = true;
    }
  }

  return matchedIdentity ? score : -1;
}

function findBestWorkerThread(threads: OrchestratorChatThread[], target: OrchestratorChatTarget): OrchestratorChatThread | null {
  let best: OrchestratorChatThread | null = null;
  let bestScore = -1;
  for (const thread of threads) {
    const score = workerThreadMatchScore(thread, target);
    if (score > bestScore) {
      bestScore = score;
      best = thread;
      continue;
    }
    if (score === bestScore && score >= 0 && best) {
      const bestUpdated = Date.parse(best.updatedAt);
      const nextUpdated = Date.parse(thread.updatedAt);
      if (nextUpdated > bestUpdated) {
        best = thread;
      }
    }
  }
  return bestScore >= 0 ? best : null;
}

export function resolveMissionChatSelection(args: {
  threads: OrchestratorChatThread[];
  selectedThreadId: string | null;
  jumpTarget?: OrchestratorChatTarget | null;
}): string | null {
  if (!args.threads.length) return null;
  if (args.jumpTarget?.kind === "coordinator") {
    const missionThread = args.threads.find((thread) => thread.threadType === "mission");
    if (missionThread) return missionThread.id;
  }
  if (args.jumpTarget?.kind === "worker") {
    const matched = findBestWorkerThread(args.threads, args.jumpTarget);
    if (matched) return matched.id;
  }
  if (args.selectedThreadId && args.threads.some((thread) => thread.id === args.selectedThreadId)) {
    return args.selectedThreadId;
  }
  const missionThread = args.threads.find((thread) => thread.threadType === "mission");
  return missionThread?.id ?? args.threads[0]?.id ?? null;
}

function formatMetricSample(sample: MissionMetricSample): string {
  const rounded = Number.isFinite(sample.value) ? sample.value.toFixed(sample.value >= 100 ? 0 : 2) : "0";
  if (sample.unit && sample.unit.trim().length) return `${rounded} ${sample.unit}`;
  return rounded;
}

function MissionControlWrapper({
  missionId,
  missionTitle,
  graph
}: {
  missionId: string;
  missionTitle: string;
  graph: OrchestratorRunGraph;
}) {
  const [threads, setThreads] = useState<OrchestratorChatThread[]>([]);

  const refreshThreads = useCallback(async () => {
    try {
      const nextThreads = await window.ade.orchestrator.listChatThreads({ missionId });
      setThreads(nextThreads);
    } catch {
      // ignore
    }
  }, [missionId]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  // Listen for thread events to refresh thread list
  useEffect(() => {
    const unsub = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.missionId !== missionId) return;
      if (event.type === "thread_updated") {
        void refreshThreads();
      }
    });
    return () => { unsub(); };
  }, [missionId, refreshThreads]);

  const handleSendMessage = useCallback(async (threadId: string, content: string) => {
    try {
      const thread = threads.find((t) => t.id === threadId);
      const target: OrchestratorChatTarget = thread?.threadType === "worker"
        ? {
            kind: "worker",
            runId: thread.runId ?? graph.run.id ?? null,
            stepId: thread.stepId ?? null,
            stepKey: thread.stepKey ?? null,
            attemptId: thread.attemptId ?? null,
            sessionId: thread.sessionId ?? null,
            laneId: thread.laneId ?? null
          }
        : {
            kind: "coordinator",
            runId: graph.run.id ?? null
          };
      await window.ade.orchestrator.sendThreadMessage({
        missionId,
        threadId,
        content,
        target
      });
    } catch {
      // ignore
    }
  }, [missionId, threads, graph.run.id]);

  const handleSteerStep = useCallback(async (stepKey: string, message: string) => {
    try {
      await window.ade.orchestrator.steerMission({
        missionId,
        directive: message,
        priority: "instruction",
        targetStepKey: stepKey
      });
    } catch {
      // ignore
    }
  }, [missionId]);

  return (
    <MissionControlPage
      missionId={missionId}
      missionTitle={missionTitle}
      runId={graph.run.id}
      graph={graph}
      threads={threads}
      onSendMessage={(threadId, content) => { void handleSendMessage(threadId, content); }}
      onSteerStep={(stepKey, message) => { void handleSteerStep(stepKey, message); }}
    />
  );
}

function MissionChat({
  missionId,
  runId,
  jumpTarget,
  onJumpHandled
}: {
  missionId: string;
  runId: string | null;
  jumpTarget: OrchestratorChatTarget | null;
  onJumpHandled: () => void;
}) {
  const [threads, setThreads] = useState<OrchestratorChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<OrchestratorChatMessage[]>([]);
  const [workerStates, setWorkerStates] = useState<OrchestratorWorkerState[]>([]);
  const [workerDigests, setWorkerDigests] = useState<OrchestratorWorkerDigest[]>([]);
  const [metricsConfig, setMetricsConfig] = useState<MissionMetricsConfig | null>(null);
  const [metricSamples, setMetricSamples] = useState<MissionMetricSample[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [savingMetrics, setSavingMetrics] = useState(false);
  const [broadcastToWorkers, setBroadcastToWorkers] = useState(false);
  const selectedThreadIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRefreshTimerRef = useRef<number | null>(null);
  const workerRailRefreshTimerRef = useRef<number | null>(null);
  const messageRefreshTimerRef = useRef<number | null>(null);
  const queuedMessageThreadRef = useRef<string | null>(null);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const refreshThreads = useCallback(async () => {
    try {
      const nextThreads = await window.ade.orchestrator.listChatThreads({ missionId });
      setThreads(nextThreads);
      const resolved = resolveMissionChatSelection({
        threads: nextThreads,
        selectedThreadId: selectedThreadIdRef.current
      });
      if (resolved !== selectedThreadIdRef.current) {
        selectedThreadIdRef.current = resolved;
        setSelectedThreadId(resolved);
      }
    } catch {
      // ignore refresh failures; next event/poll will retry
    }
  }, [missionId]);

  const scheduleThreadRefresh = useCallback((delayMs = 120) => {
    if (threadRefreshTimerRef.current !== null) {
      window.clearTimeout(threadRefreshTimerRef.current);
    }
    threadRefreshTimerRef.current = window.setTimeout(() => {
      threadRefreshTimerRef.current = null;
      void refreshThreads();
    }, delayMs);
  }, [refreshThreads]);

  useEffect(() => {
    if (!jumpTarget) return;
    if (jumpTarget.kind === "worker") {
      const matched = findBestWorkerThread(threads, jumpTarget);
      if (!matched) return;
      if (matched.id !== selectedThreadId) {
        setSelectedThreadId(matched.id);
      }
      onJumpHandled();
      return;
    }
    const missionThread = threads.find((thread) => thread.threadType === "mission");
    if (!missionThread) return;
    if (missionThread.id !== selectedThreadId) {
      setSelectedThreadId(missionThread.id);
    }
    onJumpHandled();
  }, [jumpTarget, onJumpHandled, selectedThreadId, threads]);

  const refreshMessages = useCallback(async (threadIdOverride?: string | null) => {
    const resolvedThreadId = threadIdOverride ?? selectedThreadIdRef.current;
    if (!resolvedThreadId) {
      setMessages([]);
      return;
    }
    try {
      const nextMessages = await window.ade.orchestrator.getThreadMessages({
        missionId,
        threadId: resolvedThreadId,
        limit: 200
      });
      if (selectedThreadIdRef.current === resolvedThreadId) {
        setMessages(nextMessages);
      }
    } catch {
      // ignore refresh failures; next event/poll will retry
    }
  }, [missionId]);

  const scheduleMessageRefresh = useCallback((threadIdOverride?: string | null, delayMs = 100) => {
    if (typeof threadIdOverride !== "undefined") {
      queuedMessageThreadRef.current = threadIdOverride;
    }
    if (messageRefreshTimerRef.current !== null) {
      window.clearTimeout(messageRefreshTimerRef.current);
    }
    messageRefreshTimerRef.current = window.setTimeout(() => {
      messageRefreshTimerRef.current = null;
      const nextThreadId = queuedMessageThreadRef.current;
      queuedMessageThreadRef.current = null;
      void refreshMessages(nextThreadId);
    }, delayMs);
  }, [refreshMessages]);

  const refreshWorkerRail = useCallback(async () => {
    try {
      const [metrics, states, digests] = await Promise.all([
        window.ade.orchestrator.getMissionMetrics({
          missionId,
          runId: runId ?? undefined,
          limit: 240
        }),
        runId
          ? window.ade.orchestrator.getWorkerStates({ runId })
          : Promise.resolve([] as OrchestratorWorkerState[]),
        window.ade.orchestrator.listWorkerDigests({
          missionId,
          runId: runId ?? undefined,
          limit: 120
        })
      ]);
      setMetricsConfig(metrics.config);
      setMetricSamples(metrics.samples);
      setWorkerStates(states);
      setWorkerDigests(digests);
    } catch {
      // ignore refresh failures; next event/poll will retry
    }
  }, [missionId, runId]);

  const scheduleWorkerRailRefresh = useCallback((delayMs = 160) => {
    if (workerRailRefreshTimerRef.current !== null) {
      window.clearTimeout(workerRailRefreshTimerRef.current);
    }
    workerRailRefreshTimerRef.current = window.setTimeout(() => {
      workerRailRefreshTimerRef.current = null;
      void refreshWorkerRail();
    }, delayMs);
  }, [refreshWorkerRail]);

  useEffect(() => {
    void refreshThreads();
    void refreshWorkerRail();
    const interval = setInterval(() => {
      void refreshThreads();
      void refreshWorkerRail();
    }, 12_000);
    return () => clearInterval(interval);
  }, [refreshThreads, refreshWorkerRail]);

  useEffect(() => {
    void refreshMessages(selectedThreadId);
    const interval = setInterval(() => void refreshMessages(selectedThreadIdRef.current), 8_000);
    return () => clearInterval(interval);
  }, [refreshMessages, selectedThreadId]);

  useEffect(() => {
    const unsubThreadEvents = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.missionId !== missionId) return;
      if (event.reason === "thread_read" && event.threadId === selectedThreadIdRef.current) return;
      if (event.type === "thread_updated" || event.type === "message_appended" || event.type === "message_updated" || event.type === "worker_replay") {
        scheduleThreadRefresh();
        const currentThreadId = selectedThreadIdRef.current;
        if (currentThreadId && (!event.threadId || event.threadId === currentThreadId)) {
          scheduleMessageRefresh(currentThreadId);
        }
      }
      if (event.type === "metrics_updated" || event.type === "worker_digest_updated" || event.type === "worker_replay") {
        scheduleWorkerRailRefresh();
      }
    });
    const unsubRuntimeEvents = window.ade.orchestrator.onEvent((event) => {
      if (runId && event.runId === runId) {
        scheduleWorkerRailRefresh(120);
      }
    });
    return () => {
      unsubThreadEvents();
      unsubRuntimeEvents();
    };
  }, [missionId, runId, scheduleMessageRefresh, scheduleThreadRefresh, scheduleWorkerRailRefresh]);

  useEffect(() => {
    return () => {
      if (threadRefreshTimerRef.current !== null) {
        window.clearTimeout(threadRefreshTimerRef.current);
      }
      if (workerRailRefreshTimerRef.current !== null) {
        window.clearTimeout(workerRailRefreshTimerRef.current);
      }
      if (messageRefreshTimerRef.current !== null) {
        window.clearTimeout(messageRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, selectedThreadId]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );

  useEffect(() => {
    if (!selectedThread || selectedThread.threadType !== "mission") {
      if (broadcastToWorkers) {
        setBroadcastToWorkers(false);
      }
    }
  }, [broadcastToWorkers, selectedThread]);

  const enabledMetricSet = useMemo(() => {
    const toggles = metricsConfig?.toggles?.length ? metricsConfig.toggles : METRIC_TOGGLE_ORDER;
    return new Set(toggles);
  }, [metricsConfig]);

  const latestMetricByKey = useMemo(() => {
    const latest = new Map<string, MissionMetricSample>();
    for (const sample of metricSamples) {
      if (!latest.has(sample.metric)) {
        latest.set(sample.metric, sample);
      }
    }
    return latest;
  }, [metricSamples]);

  const workerStateByAttempt = useMemo(() => {
    const map = new Map<string, OrchestratorWorkerState>();
    for (const state of workerStates) {
      map.set(state.attemptId, state);
    }
    return map;
  }, [workerStates]);

  const latestDigestByAttempt = useMemo(() => {
    const map = new Map<string, OrchestratorWorkerDigest>();
    for (const digest of workerDigests) {
      if (!map.has(digest.attemptId)) {
        map.set(digest.attemptId, digest);
      }
    }
    return map;
  }, [workerDigests]);

  const workerThreadCards = useMemo(() => {
    return threads
      .filter((thread) => thread.threadType === "worker")
      .map((thread) => {
        const digest = thread.attemptId ? latestDigestByAttempt.get(thread.attemptId) : undefined;
        const state = thread.attemptId ? workerStateByAttempt.get(thread.attemptId) : undefined;
        return {
          thread,
          digest,
          state
        };
      })
      .sort((a, b) => Date.parse(b.thread.updatedAt) - Date.parse(a.thread.updatedAt));
  }, [latestDigestByAttempt, threads, workerStateByAttempt]);

  const displayMessages = useMemo(
    () => collapsePlannerStreamMessages(messages),
    [messages]
  );

  const handleToggleMetric = useCallback(async (toggle: MissionMetricToggle) => {
    if (savingMetrics) return;
    const current = metricsConfig?.toggles?.length ? metricsConfig.toggles : METRIC_TOGGLE_ORDER;
    const exists = current.includes(toggle);
    if (exists && current.length <= 1) return;
    const next = exists ? current.filter((entry) => entry !== toggle) : [...current, toggle];
    setSavingMetrics(true);
    try {
      const updated = await window.ade.orchestrator.setMissionMetricsConfig({
        missionId,
        toggles: next
      });
      setMetricsConfig(updated);
    } finally {
      setSavingMetrics(false);
    }
  }, [metricsConfig, missionId, savingMetrics]);

  const handleSend = useCallback(async () => {
    if (!selectedThread || !input.trim() || sending) return;
    const trimmed = input.trim();
    setSending(true);
    try {
      const target: OrchestratorChatTarget = selectedThread.threadType === "worker"
        ? {
            kind: "worker",
            runId: selectedThread.runId ?? runId ?? null,
            stepId: selectedThread.stepId ?? null,
            stepKey: selectedThread.stepKey ?? null,
            attemptId: selectedThread.attemptId ?? null,
            sessionId: selectedThread.sessionId ?? null,
            laneId: selectedThread.laneId ?? null
          }
        : broadcastToWorkers
          ? {
              kind: "workers",
              runId: selectedThread.runId ?? runId ?? null,
              laneId: null,
              includeClosed: false
            }
        : {
            kind: "coordinator",
            runId: selectedThread.runId ?? runId ?? null
          };
      await window.ade.orchestrator.sendThreadMessage({
        missionId,
        threadId: selectedThread.id,
        content: trimmed,
        target
      });
      setInput("");
      const [nextMessages, nextThreads] = await Promise.all([
        window.ade.orchestrator.getThreadMessages({
          missionId,
          threadId: selectedThread.id,
          limit: 200
        }),
        window.ade.orchestrator.listChatThreads({ missionId })
      ]);
      setMessages(nextMessages);
      setThreads(nextThreads);
    } finally {
      setSending(false);
    }
  }, [broadcastToWorkers, input, missionId, runId, selectedThread, sending]);

  const threadTypeBadgeHex = (type: string) => type === "mission" ? "#3B82F6" : "#A78BFA";
  const deliveryHex = (state: string | undefined) =>
    state === "delivered" ? "#22C55E" : state === "failed" ? "#EF4444" : "#F59E0B";

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="w-full shrink-0 lg:w-[230px] lg:border-b-0" style={{ background: COLORS.cardBg, borderRight: `1px solid ${COLORS.border}`, borderBottom: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>THREADS</div>
          <div className="text-[10px]" style={{ color: COLORS.textMuted }}>{threads.length}</div>
        </div>
        <div className="max-h-[180px] overflow-y-auto p-2 lg:max-h-none lg:h-full">
          {threads.length === 0 && (
            <div className="px-2 py-3 text-center text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
              No threads yet
            </div>
          )}
          <div className="space-y-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => setSelectedThreadId(thread.id)}
                className="w-full px-2 py-2 text-left transition-colors"
                style={selectedThreadId === thread.id
                  ? { background: "#A78BFA12", borderLeft: `3px solid ${COLORS.accent}`, border: `1px solid ${COLORS.accent}30` }
                  : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
                }
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="truncate text-[11px] font-medium" style={{ color: COLORS.textPrimary }}>{thread.title}</div>
                  {thread.unreadCount > 0 && (
                    <span className="px-1.5 py-0.5 text-[9px] font-bold" style={inlineBadge(COLORS.accent)}>
                      {thread.unreadCount}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[9px]" style={{ color: COLORS.textMuted }}>
                  <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(threadTypeBadgeHex(thread.threadType))}>
                    {thread.threadType === "mission" ? "PLANNER" : "WORKER"}
                  </span>
                  {thread.threadType === "worker" && thread.stepKey && (
                    <span className="px-1 py-0.5 text-[8px] font-bold uppercase tracking-[0.5px]" style={{ background: `${COLORS.accent}12`, border: `1px solid ${COLORS.accent}25`, color: COLORS.accent }}>
                      {thread.stepKey}
                    </span>
                  )}
                  <span>{relativeWhen(thread.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:border-b-0" style={{ borderRight: `1px solid ${COLORS.border}`, background: COLORS.pageBg }}>
        <div className="px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2">
            <ChatCircle size={14} weight="regular" style={{ color: COLORS.accent }} />
            <div className="text-[11px] font-bold" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
              {selectedThread?.title ?? "Select a thread"}
            </div>
            {selectedThread && (
              <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(COLORS.textMuted)}>
                {selectedThread.threadType}
              </span>
            )}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
          {!selectedThread && (
            <div className="px-3 py-6 text-center text-[11px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
              Pick a mission or worker thread to inspect and send guidance.
            </div>
          )}
          {selectedThread && displayMessages.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
              {selectedThread.threadType === "worker" && selectedThread.status === "active" && !selectedThread.sessionId ? (
                <div className="flex flex-col items-center gap-2">
                  <SpinnerGap size={20} weight="regular" className="animate-spin" style={{ color: COLORS.accent }} />
                  <span>Initializing execution environment...</span>
                  <span className="text-[9px]" style={{ color: COLORS.textDim }}>Worker is starting up. Output will appear once the session connects.</span>
                </div>
              ) : selectedThread.threadType === "worker" && selectedThread.status === "active" && selectedThread.sessionId ? (
                <div className="flex flex-col items-center gap-2">
                  <SpinnerGap size={20} weight="regular" className="animate-spin" style={{ color: COLORS.accent }} />
                  <span>Worker connected, waiting for output...</span>
                </div>
              ) : (
                <span>No messages yet in this thread.</span>
              )}
            </div>
          )}
          {displayMessages.map((msg) => {
            const plannerMessage = msg.role === "worker" && (msg.stepKey === PLANNER_STEP_KEY || isPlannerStreamMessage(msg));
            const roleLabel = msg.role === "orchestrator"
              ? "Orchestrator"
              : plannerMessage
                ? "Planner"
                : "Worker";
            return (
            <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className="max-w-[85%] px-2.5 py-2 text-[11px]"
                style={msg.role === "user"
                  ? { border: `1px solid ${COLORS.accent}30`, background: `${COLORS.accent}12`, color: COLORS.textPrimary }
                  : plannerMessage
                    ? { border: "1px solid #22C55E30", background: "#22C55E10", color: COLORS.textPrimary }
                    : msg.role === "worker"
                    ? { border: "1px solid #A78BFA30", background: "#A78BFA10", color: COLORS.textPrimary }
                    : { border: `1px solid ${COLORS.border}`, background: COLORS.cardBg, color: COLORS.textPrimary }
                }
              >
                {msg.role !== "user" && (
                  <div className="mb-1 flex items-center gap-1 text-[9px]" style={{ color: COLORS.textMuted }}>
                    {msg.role === "orchestrator" ? <Robot className="h-3 w-3" /> : <TerminalWindow className="h-3 w-3" />}
                    <span>{roleLabel}</span>
                    {msg.stepKey ? <span>{"\u2022"} {msg.stepKey}</span> : null}
                  </div>
                )}
                <div className="whitespace-pre-wrap">{msg.content}</div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[9px]" style={{ color: COLORS.textMuted }}>
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  {msg.role === "user" && selectedThread?.threadType === "worker" ? (
                    <span
                      className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]"
                      style={inlineBadge(deliveryHex(msg.deliveryState))}
                    >
                      {msg.deliveryState}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
          })}
        </div>

        <div className="px-3 py-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={!selectedThread}
              placeholder={
                selectedThread?.threadType === "worker"
                  ? "Send guidance directly to this worker..."
                  : selectedThread?.threadType === "mission" && broadcastToWorkers
                    ? "Broadcast guidance to all worker threads in this run..."
                  : "Message the mission coordinator..."
              }
              className="h-8 flex-1 px-3 text-xs outline-none disabled:opacity-50"
              style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}
            />
            {selectedThread?.threadType === "mission" && (
              <label className="flex items-center gap-1 px-2 py-1 text-[10px]" style={{ color: COLORS.textMuted, border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.recessedBg, fontFamily: MONO_FONT }}>
                <input
                  type="checkbox"
                  checked={broadcastToWorkers}
                  onChange={(event) => setBroadcastToWorkers(event.target.checked)}
                />
                BROADCAST
              </label>
            )}
            <button
              style={primaryButton()}
              onClick={() => void handleSend()}
              disabled={!selectedThread || !input.trim() || sending}
            >
              {sending ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <PaperPlaneTilt className="h-3 w-3" />}
              SEND
            </button>
          </div>
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 xl:flex xl:flex-col" style={{ background: COLORS.cardBg }}>
        <div className="px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>WORKER STATUS</div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {workerThreadCards.length === 0 && (
            <div className="px-2 py-3 text-center text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
              No worker threads yet.
            </div>
          )}
          {workerThreadCards.map(({ thread, state, digest }) => {
            const wHex = WORKER_STATUS_HEX[state?.state ?? digest?.status ?? "idle"] ?? COLORS.textMuted;
            return (
              <button
                key={thread.id}
                onClick={() => setSelectedThreadId(thread.id)}
                className="w-full px-2 py-2 text-left transition-colors"
                style={selectedThreadId === thread.id
                  ? { background: "#A78BFA12", borderLeft: `3px solid ${COLORS.accent}`, border: `1px solid ${COLORS.accent}30` }
                  : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-[11px] font-medium" style={{ color: COLORS.textPrimary }}>{thread.title}</div>
                  <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(wHex)}>
                    {(state?.state ?? digest?.status ?? "idle").replace("_", " ")}
                  </span>
                </div>
                <div className="mt-1 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  heartbeat {relativeWhen(state?.lastHeartbeatAt ?? thread.updatedAt)}
                </div>
                <div className="mt-1 text-[10px] leading-snug" style={{ color: COLORS.textSecondary }}>
                  {compactText(digest?.summary ?? "No worker digest yet.", 140)}
                </div>
              </button>
            );
          })}
        </div>

        <div className="px-3 py-2" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>MISSION METRICS</div>
            {savingMetrics ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" style={{ color: COLORS.textMuted }} /> : null}
          </div>
        </div>
        <div className="max-h-[44%] overflow-y-auto p-2">
          <div className="flex flex-wrap gap-1">
            {METRIC_PRESET_GROUPS.map((group) => {
              const allEnabled = group.toggles.every((t) => enabledMetricSet.has(t));
              return (
                <button
                  key={group.label}
                  title={group.tooltip}
                  disabled={savingMetrics}
                  onClick={async () => {
                    if (savingMetrics) return;
                    const current = metricsConfig?.toggles?.length ? metricsConfig.toggles : METRIC_TOGGLE_ORDER;
                    const next = allEnabled
                      ? current.filter((t) => !group.toggles.includes(t))
                      : [...new Set([...current, ...group.toggles])];
                    if (next.length === 0) return;
                    setSavingMetrics(true);
                    try {
                      const updated = await window.ade.orchestrator.setMissionMetricsConfig({ missionId, toggles: next });
                      setMetricsConfig(updated);
                    } finally {
                      setSavingMetrics(false);
                    }
                  }}
                  className="px-2 py-1 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
                  style={allEnabled
                    ? { background: `${COLORS.accent}18`, color: COLORS.accent, border: `1px solid ${COLORS.accent}30`, fontFamily: MONO_FONT }
                    : { background: COLORS.recessedBg, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, fontFamily: MONO_FONT }
                  }
                >
                  {group.label}
                </button>
              );
            })}
          </div>
          <div className="mt-2 p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>LATEST SAMPLES</div>
            <div className="mt-1 space-y-1">
              {METRIC_TOGGLE_ORDER.filter((toggle) => latestMetricByKey.has(toggle)).slice(0, 8).map((toggle) => {
                const sample = latestMetricByKey.get(toggle)!;
                return (
                  <div key={`${toggle}-${sample.id}`} className="flex items-center justify-between text-[10px]">
                    <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{METRIC_TOGGLE_LABELS[toggle]}</span>
                    <span style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{formatMetricSample(sample)}</span>
                  </div>
                );
              })}
              {latestMetricByKey.size === 0 && (
                <div className="text-[10px]" style={{ color: COLORS.textMuted }}>No samples captured yet.</div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

/* ════════════════════ CREATE MISSION DIALOG ════════════════════ */

type CreateDraft = {
  title: string;
  prompt: string;
  laneId: string;
  priority: MissionPriority;
  executionPolicy: MissionExecutionPolicy;
  orchestratorModel: string;
  thinkingBudgets: Record<string, number>;
  prStrategy: PrStrategy;
  prTargetBranch: string;
  prDraft: boolean;
  /** New model configuration (takes precedence over orchestratorModel) */
  modelConfig: MissionModelConfig;
  selectedProfileId: string;
};

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  "claude-sonnet": 16384,
  "claude-opus": 32768,
  "claude-haiku": 4096,
  "codex": 16384
};

const DEFAULT_MODEL_CONFIG: MissionModelConfig = {
  profileId: "standard",
  orchestratorModel: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
  intelligenceConfig: BUILT_IN_PROFILES[0].intelligenceConfig,
  smartBudget: { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 },
};

function CreateMissionDialog({
  open,
  onClose,
  onLaunch,
  busy,
  lanes,
  defaultExecutionPolicy
}: {
  open: boolean;
  onClose: () => void;
  onLaunch: (draft: CreateDraft) => void;
  busy: boolean;
  lanes: Array<{ id: string; name: string }>;
  defaultExecutionPolicy: MissionExecutionPolicy;
}) {
  const sortedLanes = useMemo(
    () => [...lanes].sort((a, b) => a.name.localeCompare(b.name)),
    [lanes]
  );
  const [draft, setDraft] = useState<CreateDraft>({
    title: "",
    prompt: "",
    laneId: "",
    priority: "normal",
    executionPolicy: defaultExecutionPolicy,
    orchestratorModel: "sonnet",
    thinkingBudgets: { ...DEFAULT_THINKING_BUDGETS },
    prStrategy: { kind: "integration", targetBranch: "main", draft: true },
    prTargetBranch: "main",
    prDraft: true,
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    selectedProfileId: "standard"
  });

  useEffect(() => {
    if (!open) return;
    setDraft({
      title: "",
      prompt: "",
      laneId: "",
      priority: "normal",
      executionPolicy: defaultExecutionPolicy,
      orchestratorModel: "sonnet",
      thinkingBudgets: { ...DEFAULT_THINKING_BUDGETS },
      prStrategy: { kind: "integration", targetBranch: "main", draft: true },
      prTargetBranch: "main",
      prDraft: true,
      modelConfig: { ...DEFAULT_MODEL_CONFIG },
      selectedProfileId: "standard"
    });
  }, [open, defaultExecutionPolicy]);

  const handleLaunch = useCallback(() => {
    if (!draft.prompt.trim()) return;
    onLaunch(draft);
  }, [draft, onLaunch]);

  if (!open) return null;

  const dlgInputStyle: React.CSSProperties = { background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 };
  const dlgLabelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };
  const selectedLane = sortedLanes.find((lane) => lane.id === draft.laneId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
        style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
      >
        <div className="flex items-center justify-between px-5 h-14" style={{ background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4" style={{ color: COLORS.accent }} />
            <h2 className="text-sm font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>NEW MISSION</h2>
          </div>
          <button onClick={onClose} className="transition-colors" style={{ color: COLORS.textMuted }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Prompt */}
          <label className="block space-y-1">
            <span style={dlgLabelStyle}>MISSION PROMPT *</span>
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft((p) => ({ ...p, prompt: e.target.value }))}
              placeholder="Describe what you want to accomplish..."
              rows={4}
              className="w-full px-3 py-2 text-xs outline-none resize-none"
              style={dlgInputStyle}
            />
          </label>

          {/* Title */}
          <label className="block space-y-1">
            <span style={dlgLabelStyle}>TITLE (OPTIONAL)</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Refactor auth middleware"
              className="h-8 w-full px-3 text-xs outline-none"
              style={dlgInputStyle}
            />
          </label>

          {/* Base lane selector */}
          <label className="block space-y-1">
            <span style={dlgLabelStyle}>BASE LANE</span>
            <select
              value={draft.laneId}
              onChange={(e) => setDraft((p) => ({ ...p, laneId: e.target.value }))}
              className="h-8 w-full px-3 text-xs outline-none"
              style={dlgInputStyle}
            >
              <option value="">Primary lane (auto)</option>
              {sortedLanes.map((lane) => (
                <option key={lane.id} value={lane.id}>{lane.name}</option>
              ))}
            </select>
          </label>

          <div className="px-3 py-2 text-[11px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
            <GitBranch className="inline h-3 w-3 mr-1 -mt-0.5" />
            {selectedLane
              ? `Base lane: ${selectedLane.name}. Mission lanes branch from this base lane, and each step still gets a dedicated lane.`
              : "Base lane defaults to your primary lane. Mission lanes branch from this base lane, and each step still gets a dedicated lane."}
          </div>

          {/* Model Profile */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>MODEL PROFILE</span>
            <ModelProfileSelector
              selectedProfileId={draft.selectedProfileId}
              onSelect={(profile) => {
                if (profile) {
                  setDraft((p) => ({
                    ...p,
                    selectedProfileId: profile.id,
                    modelConfig: {
                      profileId: profile.id,
                      orchestratorModel: profile.orchestratorModel,
                      intelligenceConfig: profile.intelligenceConfig,
                      smartBudget: profile.smartBudget ?? p.modelConfig.smartBudget,
                    },
                    orchestratorModel: profile.orchestratorModel.modelId.includes("opus") ? "opus"
                      : profile.orchestratorModel.modelId.includes("haiku") ? "haiku" : "sonnet",
                  }));
                } else {
                  setDraft((p) => ({ ...p, selectedProfileId: "custom" }));
                }
              }}
            />
          </div>

          {/* Orchestrator Model */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>ORCHESTRATOR MODEL</span>
            <ModelSelector
              value={draft.modelConfig.orchestratorModel}
              onChange={(config) => setDraft((p) => ({
                ...p,
                selectedProfileId: "custom",
                modelConfig: { ...p.modelConfig, profileId: undefined, orchestratorModel: config },
                orchestratorModel: config.modelId.includes("opus") ? "opus"
                  : config.modelId.includes("haiku") ? "haiku" : "sonnet",
              }))}
              showRecommendedBadge
            />
          </div>

          {/* Orchestrator Intelligence (per-call-type config) */}
          <OrchestratorIntelligencePanel
            value={draft.modelConfig.intelligenceConfig ?? {}}
            onChange={(config) => setDraft((p) => ({
              ...p,
              selectedProfileId: "custom",
              modelConfig: { ...p.modelConfig, profileId: undefined, intelligenceConfig: config }
            }))}
          />

          {/* Smart Token Budget */}
          <SmartBudgetPanel
            value={draft.modelConfig.smartBudget ?? { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 }}
            onChange={(config) => setDraft((p) => ({
              ...p,
              modelConfig: { ...p.modelConfig, smartBudget: config }
            }))}
          />

          {/* PR Strategy */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>PR STRATEGY</span>
            <div className="flex gap-1">
              {(["integration", "per-lane", "manual"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    const base = kind === "manual"
                      ? { kind: "manual" as const }
                      : { kind, targetBranch: draft.prTargetBranch, draft: draft.prDraft };
                    setDraft((p) => ({ ...p, prStrategy: base }));
                  }}
                  className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
                  style={draft.prStrategy.kind === kind
                    ? { background: `${COLORS.accent}18`, color: COLORS.accent, border: `1px solid ${COLORS.accent}30`, fontFamily: MONO_FONT }
                    : { background: COLORS.recessedBg, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, fontFamily: MONO_FONT }
                  }
                >
                  {kind === "integration" ? "INTEGRATION PR" : kind === "per-lane" ? "PER-LANE PRS" : "MANUAL"}
                </button>
              ))}
            </div>
            {draft.prStrategy.kind !== "manual" && (
              <div className="flex items-center gap-3 mt-1">
                <label className="flex items-center gap-1.5 text-[10px]">
                  <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Target branch</span>
                  <input
                    value={draft.prTargetBranch}
                    onChange={(e) => {
                      const branch = e.target.value;
                      setDraft((p) => ({
                        ...p,
                        prTargetBranch: branch,
                        prStrategy: { ...p.prStrategy, targetBranch: branch } as PrStrategy
                      }));
                    }}
                    className="h-6 w-24 px-2 text-xs outline-none"
                    style={dlgInputStyle}
                  />
                </label>
                <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  <input
                    type="checkbox"
                    checked={draft.prDraft}
                    onChange={(e) => {
                      const isDraft = e.target.checked;
                      setDraft((p) => ({
                        ...p,
                        prDraft: isDraft,
                        prStrategy: { ...p.prStrategy, draft: isDraft } as PrStrategy
                      }));
                    }}
                  />
                  Draft PR
                </label>
              </div>
            )}
          </div>

          {/* Execution Policy */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>EXECUTION POLICY</span>
            <PolicyEditor
              value={draft.executionPolicy}
              onChange={(p) => setDraft((prev) => ({ ...prev, executionPolicy: p }))}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <button style={outlineButton()} onClick={onClose} disabled={busy}>CANCEL</button>
          <button
            style={primaryButton()}
            onClick={handleLaunch}
            disabled={busy || !draft.prompt.trim()}
          >
            {busy ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
            LAUNCH
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function MissionSettingsDialog({
  open,
  onClose,
  draft,
  onDraftChange,
  onSave,
  busy,
  error,
  notice
}: {
  open: boolean;
  onClose: () => void;
  draft: MissionSettingsDraft;
  onDraftChange: (update: Partial<MissionSettingsDraft>) => void;
  onSave: () => void;
  busy: boolean;
  error: string | null;
  notice: string | null;
}) {
  if (!open) return null;

  const settingsInputStyle: React.CSSProperties = { height: 32, width: "100%", background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, padding: "0 8px", fontSize: 12, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0, outline: "none" };
  const settingsLabelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl shadow-2xl"
        style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
      >
        <div className="flex items-center justify-between px-5 h-14" style={{ background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2">
            <GearSix className="h-4 w-4" style={{ color: COLORS.accent }} />
            <h2 className="text-sm font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>MISSION SETTINGS</h2>
          </div>
          <button onClick={onClose} className="transition-colors" style={{ color: COLORS.textMuted }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {notice ? <div className="px-3 py-2 text-xs" style={{ border: `1px solid ${COLORS.success}30`, background: `${COLORS.success}18`, color: COLORS.success }}>{notice}</div> : null}
          {error ? <div className="px-3 py-2 text-xs" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}18`, color: COLORS.danger }}>{error}</div> : null}

          <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>MISSION DEFAULTS</div>
            <div className="mt-3 space-y-3">
              <div>
                <div className="mb-1" style={settingsLabelStyle}>DEFAULT EXECUTION POLICY</div>
                <PolicyEditor
                  value={draft.defaultExecutionPolicy}
                  onChange={(p) => onDraftChange({ defaultExecutionPolicy: p })}
                  compact
                />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-xs">
                <div style={settingsLabelStyle}>DEFAULT PLANNER PROVIDER</div>
                <select
                  style={settingsInputStyle}
                  value={draft.defaultPlannerProvider}
                  onChange={(e) => onDraftChange({ defaultPlannerProvider: e.target.value as PlannerProvider })}
                >
                  <option value="auto">Auto</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs pt-5" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
                <input
                  type="checkbox"
                  checked={draft.requirePlanReview}
                  onChange={(e) => onDraftChange({ requirePlanReview: e.target.checked })}
                />
                Require plan review
              </label>
            </div>
          </div>

          <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>WORKER PERMISSIONS</div>
            <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>CLAUDE WORKER</div>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>PERMISSION MODE</div>
                  <select
                    style={settingsInputStyle}
                    value={draft.claudePermissionMode}
                    disabled={draft.claudeDangerouslySkip}
                    onChange={(e) => onDraftChange({ claudePermissionMode: e.target.value })}
                  >
                    <option value="plan">Plan (read-only)</option>
                    <option value="acceptEdits">Accept edits</option>
                    <option value="bypassPermissions">Bypass permissions</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs" style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
                  <input
                    type="checkbox"
                    checked={draft.claudeDangerouslySkip}
                    onChange={(e) => onDraftChange({ claudeDangerouslySkip: e.target.checked })}
                  />
                  Dangerously skip permissions
                </label>
                <div className="text-[11px]" style={{ color: COLORS.textMuted }}>
                  Claude workers read `CLAUDE.md` and `.claude/settings.json` from the lane repository root.
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>CODEX WORKER</div>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>SANDBOX MODE</div>
                  <select
                    style={settingsInputStyle}
                    value={draft.codexSandboxPermissions}
                    onChange={(e) => onDraftChange({ codexSandboxPermissions: e.target.value })}
                  >
                    <option value="read-only">Read-only</option>
                    <option value="workspace-write">Workspace write</option>
                    <option value="danger-full-access">Full access (dangerous)</option>
                  </select>
                </label>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>APPROVAL MODE</div>
                  <select
                    style={settingsInputStyle}
                    value={draft.codexApprovalMode}
                    onChange={(e) => onDraftChange({ codexApprovalMode: e.target.value })}
                  >
                    <option value="suggest">Suggest</option>
                    <option value="auto-edit">Auto-edit</option>
                    <option value="full-auto">Full auto</option>
                  </select>
                </label>
                <label className="text-xs block">
                  <div style={settingsLabelStyle}>CONFIG TOML PATH</div>
                  <input
                    type="text"
                    style={settingsInputStyle}
                    value={draft.codexConfigPath}
                    onChange={(e) => onDraftChange({ codexConfigPath: e.target.value })}
                    placeholder="e.g. /Users/you/.config/codex/config.toml"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <button style={outlineButton()} onClick={onClose} disabled={busy}>CLOSE</button>
          <button style={primaryButton()} onClick={onSave} disabled={busy}>
            {busy ? "SAVING..." : "SAVE SETTINGS"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ════════════════════ MAIN COMPONENT ════════════════════ */

export default function MissionsPage() {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);

  /* ── Core state ── */
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [selectedMission, setSelectedMission] = useState<MissionDetail | null>(null);
  const [runGraph, setRunGraph] = useState<OrchestratorRunGraph | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [missionSettingsOpen, setMissionSettingsOpen] = useState(false);
  const [missionSettingsBusy, setMissionSettingsBusy] = useState(false);
  const [missionSettingsError, setMissionSettingsError] = useState<string | null>(null);
  const [missionSettingsNotice, setMissionSettingsNotice] = useState<string | null>(null);
  const [missionSettingsSnapshot, setMissionSettingsSnapshot] = useState<ProjectConfigSnapshot | null>(null);
  const [missionSettingsDraft, setMissionSettingsDraft] = useState<MissionSettingsDraft>(DEFAULT_MISSION_SETTINGS_DRAFT);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("board");
  const [searchFilter, setSearchFilter] = useState("");
  const [missionListView, setMissionListView] = useState<MissionListViewMode>("list");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [chatJumpTarget, setChatJumpTarget] = useState<OrchestratorChatTarget | null>(null);

  /* ── Steering state ── */
  const [steerInput, setSteerInput] = useState("");
  const [steerBusy, setSteerBusy] = useState(false);
  const [steerAck, setSteerAck] = useState<string | null>(null);
  const [steeringLog, setSteeringLog] = useState<SteeringEntry[]>([]);
  const graphRefreshTimerRef = useRef<number | null>(null);

  /* ── Execution plan preview state ── */
  const [executionPlanPreview, setExecutionPlanPreview] = useState<ExecutionPlanPreviewType | null>(null);

  /* ── Track original step count for dynamic step indicator ── */
  const [originalStepCount, setOriginalStepCount] = useState<number | null>(null);

  /* ── Elapsed time ticker (only runs when a non-terminal mission is selected) ── */
  const [, setTick] = useState(0);
  const hasActiveMission = selectedMission && !TERMINAL_MISSION_STATUSES.has(selectedMission.status);
  useEffect(() => {
    if (!hasActiveMission) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveMission]);

  /* ── Derived data ── */
  const filteredMissions = useMemo(() => {
    if (!searchFilter.trim()) return missions;
    const q = searchFilter.toLowerCase();
    return missions.filter(
      (m) => m.title.toLowerCase().includes(q) || m.status.includes(q)
    );
  }, [missions, searchFilter]);

  const runAutopilotState = useMemo(() => {
    const autopilot =
      runGraph?.run.metadata && typeof runGraph.run.metadata.autopilot === "object" && !Array.isArray(runGraph.run.metadata.autopilot)
        ? (runGraph.run.metadata.autopilot as Record<string, unknown>)
        : null;
    return {
      enabled: autopilot?.enabled === true,
      executor: typeof autopilot?.executorKind === "string" ? autopilot.executorKind : null
    };
  }, [runGraph]);

  const canStartOrRerun = !runGraph || runGraph.run.status === "succeeded" || runGraph.run.status === "failed" || runGraph.run.status === "canceled";
  const canCancelRun = Boolean(
    runGraph && runGraph.run.status !== "succeeded" && runGraph.run.status !== "failed" && runGraph.run.status !== "canceled"
  );
  const canResumeRun = runGraph?.run.status === "paused";

  const isActiveMission = selectedMission && (
    selectedMission.status === "in_progress" ||
    selectedMission.status === "planning" ||
    selectedMission.status === "intervention_required"
  );

  const applyMissionSettingsSnapshot = useCallback((snapshot: ProjectConfigSnapshot) => {
    const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
    const effectiveAi = isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};

    const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
    const effectiveOrchestrator = isRecord(effectiveAi.orchestrator) ? effectiveAi.orchestrator : {};

    const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
    const effectivePermissions = isRecord(effectiveAi.permissions) ? effectiveAi.permissions : {};
    const localClaude = isRecord(localPermissions.claude) ? localPermissions.claude : {};
    const effectiveClaude = isRecord(effectivePermissions.claude) ? effectivePermissions.claude : {};
    const localCodex = isRecord(localPermissions.codex) ? localPermissions.codex : {};
    const effectiveCodex = isRecord(effectivePermissions.codex) ? effectivePermissions.codex : {};
    const effectivePolicySource = effectiveOrchestrator.defaultExecutionPolicy ?? effectiveOrchestrator.default_execution_policy;
    const localPolicySource = localOrchestrator.defaultExecutionPolicy ?? localOrchestrator.default_execution_policy;
    const effectiveDefaultExecutionPolicy = mergeExecutionPolicyWithDefaults(effectivePolicySource, PRESET_STANDARD);
    const localDefaultExecutionPolicy = mergeExecutionPolicyWithDefaults(localPolicySource, effectiveDefaultExecutionPolicy);

    const orchLocal = localOrchestrator as Record<string, unknown>;
    const orchEffective = effectiveOrchestrator as Record<string, unknown>;
    const effectivePrStrategy = (orchLocal.defaultPrStrategy ?? orchEffective.defaultPrStrategy ?? { kind: "integration", targetBranch: "main", draft: true }) as PrStrategy;

    setMissionSettingsSnapshot(snapshot);
    setMissionSettingsDraft({
      defaultExecutionPolicy: localDefaultExecutionPolicy,
      defaultPrStrategy: effectivePrStrategy,
      defaultPlannerProvider: toPlannerProvider(
        readString(localOrchestrator.defaultPlannerProvider, effectiveOrchestrator.defaultPlannerProvider, "auto")
      ),
      requirePlanReview: readBool(localOrchestrator.requirePlanReview, effectiveOrchestrator.requirePlanReview, false),
      claudePermissionMode: toClaudePermissionMode(
        readString(localClaude.permissionMode, effectiveClaude.permissionMode, "acceptEdits")
      ),
      claudeDangerouslySkip: readBool(localClaude.dangerouslySkipPermissions, effectiveClaude.dangerouslySkipPermissions, false),
      codexSandboxPermissions: toCodexSandboxPermissions(
        readString(localCodex.sandboxPermissions, effectiveCodex.sandboxPermissions, "workspace-write")
      ),
      codexApprovalMode: toCodexApprovalMode(
        readString(localCodex.approvalMode, effectiveCodex.approvalMode, "full-auto")
      ),
      codexConfigPath: readString(localCodex.configPath, effectiveCodex.configPath, "")
    });
  }, []);

  const loadMissionSettings = useCallback(async () => {
    setMissionSettingsError(null);
    try {
      const snapshot = await window.ade.projectConfig.get();
      applyMissionSettingsSnapshot(snapshot);
    } catch (err) {
      setMissionSettingsError(err instanceof Error ? err.message : String(err));
    }
  }, [applyMissionSettingsSnapshot]);

  const saveMissionSettings = useCallback(async () => {
    setMissionSettingsBusy(true);
    setMissionSettingsError(null);
    setMissionSettingsNotice(null);
    try {
      const snapshot = missionSettingsSnapshot ?? (await window.ade.projectConfig.get());
      const localAi = isRecord(snapshot.local.ai) ? snapshot.local.ai : {};
      const localOrchestrator = isRecord(localAi.orchestrator) ? localAi.orchestrator : {};
      const localPermissions = isRecord(localAi.permissions) ? localAi.permissions : {};
      const localClaude = isRecord(localPermissions.claude) ? localPermissions.claude : {};
      const localCodex = isRecord(localPermissions.codex) ? localPermissions.codex : {};

      const normalizedPlannerProvider = toPlannerProvider(missionSettingsDraft.defaultPlannerProvider);
      const normalizedClaudePermissionMode = toClaudePermissionMode(missionSettingsDraft.claudePermissionMode);
      const normalizedCodexSandbox = toCodexSandboxPermissions(missionSettingsDraft.codexSandboxPermissions);
      const normalizedCodexApproval = toCodexApprovalMode(missionSettingsDraft.codexApprovalMode);

      const nextOrchestrator: Record<string, unknown> = {
        ...localOrchestrator,
        defaultExecutionPolicy: missionSettingsDraft.defaultExecutionPolicy,
        defaultPrStrategy: missionSettingsDraft.defaultPrStrategy,
        defaultPlannerProvider: normalizedPlannerProvider,
        requirePlanReview: missionSettingsDraft.requirePlanReview
      };
      delete nextOrchestrator.defaultDepthTier;
      delete nextOrchestrator.default_depth_tier;

      const nextClaude: Record<string, unknown> = {
        ...localClaude,
        permissionMode: normalizedClaudePermissionMode
      };
      if (missionSettingsDraft.claudeDangerouslySkip) {
        nextClaude.dangerouslySkipPermissions = true;
      } else {
        delete nextClaude.dangerouslySkipPermissions;
      }

      const nextCodex: Record<string, unknown> = {
        ...localCodex,
        sandboxPermissions: normalizedCodexSandbox,
        approvalMode: normalizedCodexApproval
      };
      if (missionSettingsDraft.codexConfigPath.trim().length > 0) {
        nextCodex.configPath = missionSettingsDraft.codexConfigPath.trim();
      } else {
        delete nextCodex.configPath;
      }

      const saved = await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          ai: {
            ...localAi,
            orchestrator: nextOrchestrator,
            permissions: {
              ...localPermissions,
              claude: nextClaude,
              codex: nextCodex
            }
          }
        }
      });

      applyMissionSettingsSnapshot(saved);
      setMissionSettingsNotice("Mission settings saved to .ade/local.yaml.");
    } catch (err) {
      setMissionSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setMissionSettingsBusy(false);
    }
  }, [applyMissionSettingsSnapshot, missionSettingsDraft, missionSettingsSnapshot]);

  /* ── Data fetching ── */
  const refreshMissionList = useCallback(
    async (opts: { preserveSelection?: boolean; silent?: boolean } = {}) => {
      if (!opts.silent) setRefreshing(true);
      try {
        if (!lanes.length) await refreshLanes().catch(() => {});
        const list = await window.ade.missions.list({ limit: 300 });
        setMissions(list);
        setError(null);
        const preserve = opts.preserveSelection ?? true;
        if (!preserve) {
          setSelectedMissionId(list[0]?.id ?? null);
          return;
        }
        setSelectedMissionId((prev) => {
          if (prev && list.some((m) => m.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [lanes.length, refreshLanes]
  );

  const loadMissionDetail = useCallback(async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed) return;
    try {
      const detail = await window.ade.missions.get(trimmed);
      setSelectedMission(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadOrchestratorGraph = useCallback(async (missionId: string) => {
    const trimmed = missionId.trim();
    if (!trimmed) { setRunGraph(null); return; }
    try {
      const runs = await window.ade.orchestrator.listRuns({ missionId: trimmed, limit: 20 });
      const latestRun = runs[0];
      if (!latestRun) { setRunGraph(null); return; }
      const graph = await window.ade.orchestrator.getRunGraph({ runId: latestRun.id, timelineLimit: 120 });
      setRunGraph(graph);
      if (originalStepCount === null && graph.steps.length > 0) {
        setOriginalStepCount(graph.steps.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunGraph(null);
    }
  }, [originalStepCount]);

  const scheduleOrchestratorGraphRefresh = useCallback((missionId: string, delayMs = 180) => {
    if (graphRefreshTimerRef.current !== null) {
      window.clearTimeout(graphRefreshTimerRef.current);
    }
    graphRefreshTimerRef.current = window.setTimeout(() => {
      graphRefreshTimerRef.current = null;
      void loadOrchestratorGraph(missionId);
    }, delayMs);
  }, [loadOrchestratorGraph]);

  const loadExecutionPlanPreview = useCallback(async (runId: string) => {
    try {
      const preview = await window.ade.orchestrator.getExecutionPlanPreview({ runId });
      setExecutionPlanPreview(preview);
    } catch {
      setExecutionPlanPreview(null);
    }
  }, []);

  useEffect(() => {
    void refreshMissionList({ preserveSelection: true });
  }, [refreshMissionList]);

  useEffect(() => {
    void loadMissionSettings();
  }, [loadMissionSettings]);

  useEffect(() => {
    if (!selectedMissionId) {
      if (graphRefreshTimerRef.current !== null) {
        window.clearTimeout(graphRefreshTimerRef.current);
        graphRefreshTimerRef.current = null;
      }
      setSelectedMission(null);
      setRunGraph(null);
      setExecutionPlanPreview(null);
      setSteeringLog([]);
      setChatJumpTarget(null);
      setOriginalStepCount(null);
      return;
    }
    setSteeringLog([]);
    setChatJumpTarget(null);
    setExecutionPlanPreview(null);
    void loadMissionDetail(selectedMissionId);
    void loadOrchestratorGraph(selectedMissionId);
  }, [selectedMissionId, loadMissionDetail, loadOrchestratorGraph]);

  /* ── Load execution plan preview when run graph changes ── */
  useEffect(() => {
    const activeRunId = runGraph?.run.id ?? null;
    if (!activeRunId) {
      setExecutionPlanPreview(null);
      return;
    }
    void loadExecutionPlanPreview(activeRunId);
  }, [runGraph?.run.id, loadExecutionPlanPreview]);

  useEffect(() => {
    const unsub = window.ade.missions.onEvent((payload) => {
      void refreshMissionList({ preserveSelection: true, silent: true });
      if (payload.missionId && payload.missionId === selectedMissionId) {
        void loadMissionDetail(payload.missionId);
        scheduleOrchestratorGraphRefresh(payload.missionId, 120);
      }
    });
    return () => unsub();
  }, [loadMissionDetail, refreshMissionList, scheduleOrchestratorGraphRefresh, selectedMissionId]);

  useEffect(() => {
    const selectedRunId = runGraph?.run.id ?? null;
    const unsub = window.ade.orchestrator.onEvent((event) => {
      if (!selectedMissionId) return;
      if (selectedRunId && event.runId && event.runId !== selectedRunId) return;
      scheduleOrchestratorGraphRefresh(selectedMissionId);
    });
    return () => unsub();
  }, [runGraph?.run.id, scheduleOrchestratorGraphRefresh, selectedMissionId]);

  useEffect(() => {
    return () => {
      if (graphRefreshTimerRef.current !== null) {
        window.clearTimeout(graphRefreshTimerRef.current);
      }
    };
  }, []);

  /* ── Actions ── */
  const startRunForMission = useCallback(
    async (args: {
      missionId: string;
      laneId?: string | null;
      executorKind: OrchestratorExecutorKind;
      plannerProvider?: "claude" | "codex" | null;
      approveExistingPlan?: boolean;
    }) => {
      const missionId = args.missionId.trim();
      if (!missionId) return;
      if (args.laneId) {
        try { await window.ade.packs.refreshLanePack(args.laneId); } catch { /* non-fatal */ }
      }
      try { await window.ade.packs.refreshProjectPack({ laneId: args.laneId ?? undefined }); } catch { /* non-fatal */ }

      const startArgs = {
        missionId,
        runMode: "autopilot",
        autopilotOwnerId: "missions-autopilot",
        defaultExecutorKind: args.executorKind,
        defaultRetryLimit: 1,
        plannerProvider: args.plannerProvider ?? null
      } satisfies StartOrchestratorRunFromMissionArgs;
      return args.approveExistingPlan
        ? await window.ade.orchestrator.approveMissionPlan(startArgs)
        : await window.ade.orchestrator.startRunFromMission(startArgs);
    },
    []
  );

  const handleLaunchMission = useCallback(async (draft: CreateDraft) => {
    const prompt = draft.prompt.trim();
    if (!prompt) { setError("Mission prompt is required."); return; }
    const fallbackLaneId = lanes.find((l) => l.laneType === "primary")?.id ?? lanes[0]?.id ?? "";
    const resolvedLaneId = draft.laneId.trim() || fallbackLaneId;
    setCreateBusy(true);
    try {
      const created = await window.ade.missions.create({
        title: draft.title.trim() || undefined,
        prompt,
        laneId: resolvedLaneId || undefined,
        priority: draft.priority,
        executionPolicy: { ...draft.executionPolicy, prStrategy: draft.prStrategy },
        orchestratorModel: draft.orchestratorModel || undefined,
        thinkingBudgets: draft.thinkingBudgets,
        modelConfig: draft.modelConfig,
        autostart: true,
        launchMode: "autopilot",
        autopilotExecutor: "codex"
      });
      setSelectedMissionId(created.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      await loadMissionDetail(created.id);
      await loadOrchestratorGraph(created.id);
      setError(null);
      setCreateOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  }, [lanes, refreshMissionList, loadMissionDetail, loadOrchestratorGraph]);

  const handleStartRun = useCallback(async () => {
    if (!selectedMission) return;
    setRunBusy(true);
    try {
      const fallbackExecutor: OrchestratorExecutorKind =
        runAutopilotState.executor === "claude" || runAutopilotState.executor === "codex"
          ? (runAutopilotState.executor as OrchestratorExecutorKind)
          : "codex";
      // Derive planner provider from the executor selection — if user chose "claude" executor,
      // they likely want Claude as the planner too. Pass it through so IPC carries it to the backend.
      // The backend will also check the mission's stored modelConfig as a further fallback.
      const plannerProvider: "claude" | "codex" | null =
        runAutopilotState.executor === "claude" || runAutopilotState.executor === "codex"
          ? (runAutopilotState.executor as "claude" | "codex")
          : null;
      await startRunForMission({
        missionId: selectedMission.id,
        laneId: selectedMission.laneId,
        executorKind: fallbackExecutor,
        plannerProvider,
        approveExistingPlan: selectedMission.status === "plan_review"
      });
      await loadOrchestratorGraph(selectedMission.id);
      await loadMissionDetail(selectedMission.id);
      await refreshMissionList({ preserveSelection: true, silent: true });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  }, [selectedMission, runAutopilotState.executor, startRunForMission, loadOrchestratorGraph, loadMissionDetail, refreshMissionList]);

  const handleCancelRun = useCallback(async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.cancelRun({ runId: runGraph.run.id, reason: "Canceled from Missions UI." });
      if (selectedMission) await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  }, [runGraph, selectedMission, loadOrchestratorGraph]);

  const handleResumeRun = useCallback(async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.resumeRun({ runId: runGraph.run.id });
      if (selectedMission) await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  }, [runGraph, selectedMission, loadOrchestratorGraph]);

  /* ── Lane cleanup for failed/canceled missions ── */
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const handleCleanupLanes = useCallback(async () => {
    if (!runGraph?.steps) return;
    const laneIds = [...new Set(runGraph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
    if (!laneIds.length) return;
    if (!window.confirm(`Archive ${laneIds.length} lane(s) created by this mission?`)) return;
    setCleanupBusy(true);
    try {
      for (const laneId of laneIds) {
        try { await window.ade.lanes.archive({ laneId }); } catch { /* lane may already be archived */ }
      }
      await refreshLanes();
    } finally {
      setCleanupBusy(false);
    }
  }, [runGraph, refreshLanes]);

  const handleSteer = useCallback(async () => {
    if (!selectedMission || !steerInput.trim()) return;
    const directiveText = steerInput.trim();
    setSteerBusy(true);
    setSteerAck(null);
    try {
      const result: SteerMissionResult = await window.ade.orchestrator.steerMission({
        missionId: selectedMission.id,
        directive: directiveText,
        priority: "instruction"
      });
      setSteerAck(result.response ?? "Directive acknowledged.");
      setSteeringLog((prev) => [...prev, { directive: directiveText, appliedAt: new Date().toISOString() }]);
      setSteerInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSteerBusy(false);
    }
  }, [selectedMission, steerInput]);

  /* ── Steps grouped by status for Kanban ── */
  const stepsByStatus = useMemo(() => {
    const steps = runGraph?.steps ?? [];
    const map = new Map<MissionStepStatus, OrchestratorStep[]>();
    for (const col of STEP_STATUS_COLUMNS) {
      map.set(col.status, []);
    }
    for (const step of steps) {
      const key = step.status as MissionStepStatus;
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(step);
      } else {
        // Map orchestrator statuses to step statuses
        const fallback = map.get("pending");
        fallback?.push(step);
      }
    }
    return map;
  }, [runGraph]);

  const attemptsByStep = useMemo(() => {
    const map = new Map<string, OrchestratorAttempt[]>();
    if (!runGraph) return map;
    for (const attempt of runGraph.attempts) {
      const bucket = map.get(attempt.stepId) ?? [];
      bucket.push(attempt);
      map.set(attempt.stepId, bucket);
    }
    return map;
  }, [runGraph]);

  const selectedStep = useMemo(() => {
    if (!runGraph?.steps?.length || !selectedStepId) return null;
    return runGraph.steps.find((step) => step.id === selectedStepId) ?? null;
  }, [runGraph, selectedStepId]);

  const selectedStepAttempts = useMemo(() => {
    if (!selectedStep) return [];
    return attemptsByStep.get(selectedStep.id) ?? [];
  }, [attemptsByStep, selectedStep]);

  useEffect(() => {
    const steps = runGraph?.steps ?? [];
    if (!steps.length) {
      if (selectedStepId !== null) setSelectedStepId(null);
      return;
    }
    if (!selectedStepId || !steps.some((step) => step.id === selectedStepId)) {
      const running = steps.find((step) => step.status === "running");
      setSelectedStepId((running ?? steps[0]).id);
    }
  }, [runGraph, selectedStepId]);

  /* ── Loading screen ── */
  if (loading) {
    return (
      <div className="flex h-full min-w-0 flex-col" style={{ background: COLORS.pageBg }}>
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <div className="animate-pulse flex flex-col items-center gap-2">
            <div className="h-4 w-48" style={{ background: COLORS.border }} />
            <div className="h-3 w-32" style={{ background: `${COLORS.border}60` }} />
          </div>
          <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>LOADING MISSIONS...</div>
        </div>
      </div>
    );
  }

  /* ════════════════════ RENDER ════════════════════ */
  return (
    <LazyMotion features={domAnimation}>
      <div className="flex h-full min-h-0" style={{ background: COLORS.pageBg }}>
        {/* ════════════ LEFT SIDEBAR ════════════ */}
        <div className="flex w-[280px] shrink-0 flex-col" style={{ background: COLORS.cardBg, borderRight: `1px solid ${COLORS.border}` }}>
          {/* Sidebar Header - 64px */}
          <div className="flex items-center justify-between shrink-0 h-16 px-4" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center gap-2">
              <Rocket size={18} weight="bold" style={{ color: COLORS.accent }} />
              <span className="text-[16px] font-bold tracking-[-0.3px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                MISSIONS
              </span>
              <span className="px-2.5 py-1 text-[9px] font-bold uppercase tracking-[1px]" style={{ background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}30`, color: COLORS.accent, fontFamily: MONO_FONT }}>
                {missions.length} TOTAL
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => void refreshMissionList({ preserveSelection: true })}
                className="p-1 transition-colors"
                style={{ color: COLORS.textMuted }}
                title="Refresh"
              >
                {refreshing ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <ArrowsClockwise className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => {
                  setMissionSettingsOpen(true);
                  setMissionSettingsNotice(null);
                  setMissionSettingsError(null);
                  void loadMissionSettings();
                }}
                className="p-1 transition-colors"
                style={{ color: COLORS.textMuted }}
                title="Mission Settings"
              >
                <GearSix className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setCreateOpen(true)}
                className="p-1 transition-colors"
                style={{ color: COLORS.accent }}
                title="New Mission"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* View mode toggle + Search */}
          <div className="px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <MagnifyingGlass className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: COLORS.textDim }} />
                <input
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="Search missions..."
                  className="h-7 w-full pl-7 pr-2 text-xs outline-none"
                  style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}
                />
              </div>
              <div className="flex gap-0.5 p-0.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                <button
                  className="px-1.5 py-1 text-xs"
                  style={missionListView === "list" ? { background: `${COLORS.accent}18`, color: COLORS.textPrimary } : { color: COLORS.textMuted }}
                  onClick={() => setMissionListView("list")}
                  title="List view"
                >
                  <List size={14} weight="regular" />
                </button>
                <button
                  className="px-1.5 py-1 text-xs"
                  style={missionListView === "board" ? { background: `${COLORS.accent}18`, color: COLORS.textPrimary } : { color: COLORS.textMuted }}
                  onClick={() => setMissionListView("board")}
                  title="Board view"
                >
                  <Kanban size={14} weight="regular" />
                </button>
              </div>
            </div>
          </div>

          {/* Mission list / board */}
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {filteredMissions.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs" style={{ color: COLORS.textDim }}>
                {missions.length === 0 ? (
                  <div className="flex flex-col items-center gap-2">
                    <Rocket size={28} weight="regular" style={{ color: `${COLORS.accent}40` }} />
                    <p>No missions yet. Missions coordinate your AI agents to accomplish complex tasks.</p>
                    <button
                      onClick={() => setCreateOpen(true)}
                      style={primaryButton()}
                    >
                      START MISSION
                    </button>
                  </div>
                ) : "No matches"}
              </div>
            ) : missionListView === "board" ? (
              /* Mission Kanban Board */
              <div className="space-y-3 pt-1">
                {MISSION_BOARD_COLUMNS.map((col) => {
                  const colMissions = filteredMissions.filter((m) => m.status === col.key);
                  if (colMissions.length === 0) return null;
                  return (
                    <div key={col.key}>
                      <div className="flex items-center gap-2 mb-1.5 px-1">
                        <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: col.hex, fontFamily: MONO_FONT }}>{col.label}</span>
                        <span className="text-[10px]" style={{ color: COLORS.textDim }}>{colMissions.length}</span>
                      </div>
                      <div className="space-y-1">
                        {colMissions.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => setSelectedMissionId(m.id)}
                            className="w-full text-left p-2.5 transition-colors"
                            style={m.id === selectedMissionId
                              ? { background: "#A78BFA12", borderLeft: `3px solid ${COLORS.accent}`, border: `1px solid ${COLORS.accent}30` }
                              : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
                            }
                          >
                            <div className="text-xs font-medium truncate" style={{ color: COLORS.textPrimary }}>{m.title}</div>
                            <div className="mt-1 text-[11px] truncate" style={{ color: COLORS.textMuted }}>{m.prompt}</div>
                            <div className="mt-1.5 flex items-center gap-2">
                              <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{relativeWhen(m.createdAt)}</span>
                              {m.totalSteps > 0 && (
                                <span className="text-[10px] ml-auto" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{m.completedSteps}/{m.totalSteps}</span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Mission List View */
              <div className="space-y-1">
                {filteredMissions.map((m) => {
                  const isSelected = m.id === selectedMissionId;
                  const progress = m.totalSteps > 0 ? Math.round((m.completedSteps / m.totalSteps) * 100) : 0;
                  const isActive = m.status === "in_progress" || m.status === "planning";
                  const badgeStyle = STATUS_BADGE_STYLES[m.status];
                  return (
                    <button
                      key={m.id}
                      onClick={() => setSelectedMissionId(m.id)}
                      className={cn(
                        "w-full text-left px-2.5 py-2 transition-colors",
                        isActive && !isSelected && "ade-glow-pulse-blue"
                      )}
                      style={isSelected
                        ? { background: "#A78BFA12", borderLeft: `3px solid ${COLORS.accent}`, border: `1px solid ${COLORS.accent}30` }
                        : { border: "1px solid transparent" }
                      }
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-1 h-2 w-2 shrink-0" style={{ background: STATUS_DOT_HEX[m.status], borderRadius: 0 }} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium" style={{ color: COLORS.textPrimary }}>{m.title}</div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={{ background: badgeStyle.background, color: badgeStyle.color, border: badgeStyle.border, fontFamily: MONO_FONT }}>
                              {STATUS_LABELS[m.status]}
                            </span>
                          </div>
                          {m.totalSteps > 0 && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1 flex-1" style={{ background: COLORS.recessedBg }}>
                                <div
                                  className="h-1 transition-all"
                                  style={{ width: `${progress}%`, background: COLORS.accent }}
                                />
                              </div>
                              <span className="shrink-0 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                {m.completedSteps}/{m.totalSteps}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ════════════ MAIN WORKSPACE ════════════ */}
        <div className="flex flex-1 flex-col min-w-0" style={{ background: COLORS.pageBg }}>
          {!selectedMissionId ? (
            /* No selection empty state */
            <div className="flex h-full flex-col items-center justify-center gap-3" style={{ color: COLORS.textMuted }}>
              <Rocket size={40} weight="regular" style={{ opacity: 0.2 }} />
              <p className="text-sm" style={{ fontFamily: MONO_FONT }}>Select a mission or create a new one</p>
              <button style={primaryButton()} onClick={() => setCreateOpen(true)}>
                <Plus size={14} weight="regular" />
                NEW MISSION
              </button>
            </div>
          ) : (
            <>
              {/* ── Header Bar ── */}
              <div className="flex items-center gap-3 shrink-0 h-16 px-6" style={{ borderBottom: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-bold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                      {selectedMission?.title ?? "Loading..."}
                    </h2>
                    {selectedMission && (() => {
                      const s = STATUS_BADGE_STYLES[selectedMission.status];
                      return (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={{ background: s.background, color: s.color, border: s.border, fontFamily: MONO_FONT }}>
                          {STATUS_LABELS[selectedMission.status]}
                        </span>
                      );
                    })()}
                    {selectedMission && (() => {
                      const p = PRIORITY_STYLES[selectedMission.priority];
                      return (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={{ background: p.background, color: p.color, border: p.border, fontFamily: MONO_FONT }}>
                          {selectedMission.priority}
                        </span>
                      );
                    })()}
                    {runGraph?.run?.metadata && (
                      <MissionPolicyBadge
                        policy={(runGraph.run.metadata as Record<string, unknown>).executionPolicy as MissionExecutionPolicy | undefined}
                      />
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <span><Clock className="inline h-3 w-3 mr-0.5" />{formatElapsed(selectedMission?.startedAt ?? null, selectedMission && TERMINAL_MISSION_STATUSES.has(selectedMission.status) ? selectedMission.completedAt : null)}</span>
                    {selectedMission?.laneName && (
                      <span><GitBranch className="inline h-3 w-3 mr-0.5" />{selectedMission.laneName}</span>
                    )}
                    {runGraph && (
                      <span>Run: {runGraph.run.status}</span>
                    )}
                  </div>
                </div>

                {/* Quick actions */}
                <div className="flex items-center gap-1.5">
                  {canStartOrRerun && (
                    <button style={primaryButton()} onClick={handleStartRun} disabled={runBusy}>
                      {runBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      {runGraph ? "RERUN" : "START"}
                    </button>
                  )}
                  {canResumeRun && (
                    <button style={outlineButton()} onClick={handleResumeRun} disabled={runBusy}>
                      <Play className="h-3 w-3" />
                      RESUME
                    </button>
                  )}
                  {canCancelRun && (
                    <button style={dangerButton()} onClick={handleCancelRun} disabled={runBusy}>
                      <Stop className="h-3 w-3" />
                      CANCEL
                    </button>
                  )}
                  {selectedMission && (selectedMission.status === "failed" || selectedMission.status === "canceled") && runGraph?.steps && runGraph.steps.some(s => s.laneId) && (
                    <button style={outlineButton()} onClick={handleCleanupLanes} disabled={cleanupBusy}>
                      {cleanupBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Trash className="h-3 w-3" />}
                      CLEAN UP LANES
                    </button>
                  )}
                </div>
              </div>

              {/* ── Error Banner ── */}
              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="px-4 py-2 text-[11px] flex items-center justify-between"
                    style={{ borderBottom: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}18`, color: COLORS.danger }}
                  >
                    <span>{error}</span>
                    <button onClick={() => setError(null)} style={{ color: COLORS.danger }}>
                      <X className="h-3 w-3" />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ── Tab Navigation ── */}
              <div className="flex items-center gap-0 px-4" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                {([
                  { key: "board" as WorkspaceTab, num: "01", label: "BOARD", icon: SquaresFour },
                  { key: "dag" as WorkspaceTab, num: "02", label: "DAG", icon: Graph },
                  { key: "channels" as WorkspaceTab, num: "03", label: "CHANNELS", icon: Hash },
                  { key: "activity" as WorkspaceTab, num: "04", label: "ACTIVITY", icon: Pulse },
                  { key: "usage" as WorkspaceTab, num: "05", label: "USAGE", icon: Lightning }
                ]).map((tab) => {
                  const isActive = activeTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key)}
                      className="flex items-center gap-2 px-4 py-2.5 text-[11px] font-bold uppercase tracking-[1px] transition-colors"
                      style={isActive
                        ? { background: `${COLORS.accent}18`, borderLeft: `2px solid ${COLORS.accent}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }
                        : { background: "transparent", borderLeft: "2px solid transparent", color: COLORS.textMuted, fontFamily: MONO_FONT }
                      }
                    >
                      <span style={{ color: isActive ? COLORS.accent : COLORS.textDim }}>{tab.num}</span>
                      <tab.icon className="h-3.5 w-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* ── Completion Banner + Phase Progress + Execution Plan Preview ── */}
              {runGraph && (
                <div className="px-4 pt-3 space-y-2">
                  <CompletionBanner
                    status={runGraph.run.status}
                    evaluation={runGraph.completionEvaluation}
                  />
                  <PhaseProgressBar steps={runGraph.steps} />
                  {runGraph.steps.length > 0 && (() => {
                    const completed = runGraph.steps.filter(s => s.status === "succeeded").length;
                    const total = runGraph.steps.length;
                    const pct = Math.round((completed / total) * 100);
                    return (
                      <div className="text-[10px] flex items-center gap-2" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>{completed} of {total} steps complete ({pct}%)</span>
                        {originalStepCount !== null && originalStepCount !== total && (
                          <span style={{ color: `${COLORS.warning}70` }}>(plan adjusted from {originalStepCount} steps)</span>
                        )}
                      </div>
                    );
                  })()}
                  {isActiveMission && (
                    <ExecutionPlanPreview preview={executionPlanPreview} />
                  )}
                </div>
              )}

              {/* ── Tab Content ── */}
              <div className={cn("flex-1 min-h-0", activeTab === "channels" ? "flex flex-col overflow-hidden" : "overflow-auto p-4")}>
                {activeTab === "board" && (
                  <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                      <BoardTab
                        stepsByStatus={stepsByStatus}
                        attemptsByStep={attemptsByStep}
                        selectedStepId={selectedStepId}
                        onStepSelect={setSelectedStepId}
                      />
                    </div>
                    <StepDetailPanel
                      step={selectedStep}
                      attempts={selectedStepAttempts}
                      allSteps={runGraph?.steps ?? []}
                      claims={runGraph?.claims ?? []}
                      onOpenWorkerThread={(target) => {
                        setChatJumpTarget(target);
                        setActiveTab("channels");
                      }}
                    />
                  </div>
                )}

                {activeTab === "dag" && (
                  <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                    <OrchestratorDAG
                      steps={runGraph?.steps ?? []}
                      attempts={runGraph?.attempts ?? []}
                      claims={runGraph?.claims ?? []}
                      selectedStepId={selectedStepId}
                      onStepClick={setSelectedStepId}
                    />
                    </div>
                    <StepDetailPanel
                      step={selectedStep}
                      attempts={selectedStepAttempts}
                      allSteps={runGraph?.steps ?? []}
                      claims={runGraph?.claims ?? []}
                      onOpenWorkerThread={(target) => {
                        setChatJumpTarget(target);
                        setActiveTab("channels");
                      }}
                    />
                  </div>
                )}

                {activeTab === "activity" && (
                  <div className="space-y-3">
                    <ActivityNarrativeHeader
                      runGraph={runGraph}
                      steeringLog={steeringLog}
                    />
                    <OrchestratorActivityFeed
                      runId={runGraph?.run.id ?? ""}
                      initialTimeline={runGraph?.timeline ?? []}
                    />
                  </div>
                )}

                {activeTab === "channels" && selectedMissionId && (
                  <div className="flex h-full min-h-0 flex-col overflow-hidden">
                    <div className={cn("min-h-0", selectedMission ? "flex-1" : "h-full")}>
                      <MissionChat
                        missionId={selectedMissionId}
                        runId={runGraph?.run.id ?? null}
                        jumpTarget={chatJumpTarget}
                        onJumpHandled={() => setChatJumpTarget(null)}
                      />
                    </div>

                    {selectedMission && (
                      <div className="shrink-0" style={{ borderTop: `1px solid ${COLORS.border}` }}>
                        <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, background: COLORS.cardBg, borderBottom: `1px solid ${COLORS.border}` }}>
                          Mission Control Surface
                        </div>
                        <div className="h-[320px]">
                          {runGraph ? (
                            <MissionControlWrapper
                              missionId={selectedMission.id}
                              missionTitle={selectedMission.title}
                              graph={runGraph}
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, background: COLORS.pageBg }}>
                              No active run. Start a mission to see Mission Control.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "usage" && selectedMission && (
                  <UsageDashboard missionId={selectedMission.id} missionTitle={selectedMission.title} />
                )}
              </div>

              {/* ── Bottom Steering Bar (hidden on Channels tab since channels include steering + control) ── */}
              {isActiveMission && activeTab !== "channels" && (
                <div className="px-4 py-2.5" style={{ borderTop: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
                  {steerAck && (
                    <div className="mb-2 px-3 py-1.5 text-[10px] flex items-center justify-between" style={{ background: `${COLORS.success}18`, border: `1px solid ${COLORS.success}30`, color: COLORS.success }}>
                      <span>{steerAck}</span>
                      <button onClick={() => setSteerAck(null)} style={{ color: COLORS.success }}>
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <input
                      value={steerInput}
                      onChange={(e) => setSteerInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSteer(); } }}
                      placeholder="Type a directive to steer this mission..."
                      className="h-8 flex-1 px-3 text-xs outline-none"
                      style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}
                    />
                    <button
                      style={primaryButton()}
                      onClick={() => void handleSteer()}
                      disabled={steerBusy || !steerInput.trim()}
                    >
                      {steerBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <PaperPlaneTilt className="h-3 w-3" />}
                      SEND
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ════════════ CREATE DIALOG ════════════ */}
      <AnimatePresence>
        {createOpen && (
          <CreateMissionDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onLaunch={handleLaunchMission}
            busy={createBusy}
            lanes={lanes.map((l) => ({ id: l.id, name: l.name }))}
            defaultExecutionPolicy={missionSettingsDraft.defaultExecutionPolicy}
          />
        )}
      </AnimatePresence>

      {/* ════════════ MISSION SETTINGS DIALOG ════════════ */}
      <AnimatePresence>
        {missionSettingsOpen && (
          <MissionSettingsDialog
            open={missionSettingsOpen}
            onClose={() => {
              if (missionSettingsBusy) return;
              setMissionSettingsOpen(false);
            }}
            draft={missionSettingsDraft}
            onDraftChange={(update) => setMissionSettingsDraft((prev) => ({ ...prev, ...update }))}
            onSave={() => void saveMissionSettings()}
            busy={missionSettingsBusy}
            error={missionSettingsError}
            notice={missionSettingsNotice}
          />
        )}
      </AnimatePresence>
    </LazyMotion>
  );
}

/* ════════════════════ ACTIVITY NARRATIVE HEADER ════════════════════ */

function ActivityNarrativeHeader({
  runGraph,
  steeringLog
}: {
  runGraph: OrchestratorRunGraph | null;
  steeringLog: SteeringEntry[];
}) {
  if (!runGraph) {
    return (
      <div className="px-3 py-3 text-center" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-xs" style={{ color: COLORS.textMuted }}>No orchestrator run yet. Start a run to see activity.</div>
      </div>
    );
  }

  const steps = runGraph.steps;
  const totalSteps = steps.length;
  const succeededCount = steps.filter((s) => s.status === "succeeded").length;
  const runningCount = steps.filter((s) => s.status === "running").length;
  const pendingCount = steps.filter((s) => s.status === "pending" || s.status === "ready" || s.status === "blocked").length;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;

  // Determine active workers (unique executor kinds from running attempts)
  const runningAttempts = runGraph.attempts.filter((a) => a.status === "running");
  const activeExecutorKinds = [...new Set(runningAttempts.map((a) => a.executorKind))];
  const activeAgentCount = runningAttempts.length;

  // Build progress string: "3/5 steps done * 1 running * 1 pending"
  const progressParts: string[] = [];
  progressParts.push(`${succeededCount}/${totalSteps} steps done`);
  if (runningCount > 0) progressParts.push(`${runningCount} running`);
  if (pendingCount > 0) progressParts.push(`${pendingCount} pending`);
  if (failedCount > 0) progressParts.push(`${failedCount} failed`);
  if (skippedCount > 0) progressParts.push(`${skippedCount} skipped`);
  const progressLine = progressParts.join(" \u2022 ");

  // Active workers line
  const workersLine = activeAgentCount > 0
    ? `${activeAgentCount} agent${activeAgentCount !== 1 ? "s" : ""} active (${activeExecutorKinds.join(", ")})`
    : "No agents currently active";

  // Last meaningful action from timeline
  const timeline = runGraph.timeline;
  const latestMeaningful = timeline.find(
    (ev) => !NOISY_EVENT_TYPES.has(ev.eventType)
  );
  const lastActionLine = latestMeaningful
    ? `Last: ${narrativeForEvent(latestMeaningful)}`
    : null;

  // Recent narrative lines from the timeline (top 5 most recent non-heartbeat events)
  const recentEvents = timeline
    .filter((ev) => !NOISY_EVENT_TYPES.has(ev.eventType))
    .slice(0, 5);
  const narrativeLines = narrativeSummary(recentEvents, steeringLog);

  return (
    <div className="space-y-2">
      {/* Progress summary card */}
      <div className="px-3 py-2.5" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px] mb-2" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>MISSION PROGRESS</div>

        {/* Progress bar */}
        {totalSteps > 0 && (
          <div className="mb-2">
            <div className="flex h-1.5 w-full overflow-hidden" style={{ background: COLORS.recessedBg }}>
              {succeededCount > 0 && (
                <div
                  className="transition-all"
                  style={{ width: `${(succeededCount / totalSteps) * 100}%`, background: COLORS.success }}
                />
              )}
              {runningCount > 0 && (
                <div
                  className="transition-all"
                  style={{ width: `${(runningCount / totalSteps) * 100}%`, background: COLORS.accent }}
                />
              )}
              {failedCount > 0 && (
                <div
                  className="transition-all"
                  style={{ width: `${(failedCount / totalSteps) * 100}%`, background: COLORS.danger }}
                />
              )}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.textSecondary }}>
            <CheckCircle size={12} weight="regular" className="shrink-0" style={{ color: COLORS.success }} />
            <span>{progressLine}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.textSecondary }}>
            <Robot size={12} weight="regular" className="shrink-0" style={{ color: COLORS.accent }} />
            <span>{workersLine}</span>
          </div>
          {lastActionLine && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: COLORS.textMuted }}>
              <Lightning size={12} weight="regular" className="shrink-0" style={{ color: COLORS.warning }} />
              <span className="truncate">{lastActionLine}</span>
            </div>
          )}
        </div>
      </div>

      {/* Narrative feed card */}
      {(narrativeLines.length > 0 || steeringLog.length > 0) && (
        <div className="px-3 py-2.5" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="text-[10px] font-bold uppercase tracking-[1px] mb-1.5" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>RECENT ACTIVITY</div>
          <div className="space-y-1">
            {/* Show steering directives first */}
            {steeringLog.map((d, i) => (
              <div key={`steer-${i}`} className="flex items-start gap-2">
                <ChatCircle size={12} weight="regular" className="shrink-0 mt-0.5" style={{ color: "#06B6D4" }} />
                <div className="flex-1 min-w-0">
                  <span className="text-[11px]" style={{ color: "#06B6D4" }}>User directive: {d.directive}</span>
                  <span className="ml-2 text-[10px]" style={{ color: COLORS.textMuted }}>{relativeWhen(d.appliedAt)}</span>
                </div>
              </div>
            ))}
            {/* Show recent timeline events with icons */}
            {recentEvents.map((ev, i) => {
              const Icon = iconForEventType(ev.eventType);
              const hex = iconHexForEventType(ev.eventType, ev.reason);
              return (
                <div key={`ev-${ev.id ?? i}`} className="flex items-start gap-2">
                  <Icon className="h-3 w-3 shrink-0 mt-0.5" style={{ color: hex }} />
                  <div className="flex-1 min-w-0">
                    <span className="text-[11px]" style={{ color: COLORS.textSecondary }}>{narrativeForEvent(ev)}</span>
                    <span className="ml-2 text-[10px]" style={{ color: COLORS.textMuted }}>{relativeWhen(ev.createdAt)}</span>
                  </div>
                </div>
              );
            })}
            {narrativeLines.length === 0 && steeringLog.length === 0 && (
              <div className="text-[11px]" style={{ color: COLORS.textMuted }}>Processing events...</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════ STEP DETAIL PANEL ════════════════════ */

function StepDetailPanel({
  step,
  attempts,
  allSteps,
  claims,
  onOpenWorkerThread
}: {
  step: OrchestratorStep | null;
  attempts: OrchestratorAttempt[];
  allSteps: OrchestratorStep[];
  claims: OrchestratorClaim[];
  onOpenWorkerThread: (target: OrchestratorChatTarget) => void;
}) {
  const [showFullOutput, setShowFullOutput] = useState(false);

  if (!step) {
    return (
      <aside className="p-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>STEP DETAILS</div>
        <p className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>Select a card in Board or a node in DAG to inspect worker progress.</p>
      </aside>
    );
  }

  const latestAttempt = attempts[0] ?? null;
  const meta = isRecord(step.metadata) ? step.metadata : {};
  const stepType = typeof meta.stepType === "string" ? meta.stepType : "unknown";
  const expectedSignals = Array.isArray(meta.expectedSignals)
    ? meta.expectedSignals
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    : [];
  const doneCriteria = typeof meta.doneCriteria === "string" ? meta.doneCriteria.trim() : "";
  const dependencyLabels = step.dependencyStepIds
    .map((depId) => allSteps.find((candidate) => candidate.id === depId))
    .filter((dep): dep is OrchestratorStep => Boolean(dep))
    .map((dep) => dep.title.trim() || dep.stepKey);
  const latestHeartbeatAt = resolveStepHeartbeatAt({ step, attempts, claims });
  const resultEnvelope = latestAttempt && isRecord(latestAttempt.metadata)
    ? latestAttempt.metadata.resultEnvelope
    : undefined;
  const resultText = typeof resultEnvelope === "string"
    ? resultEnvelope
    : isRecord(resultEnvelope) ? JSON.stringify(resultEnvelope, null, 2) : null;

  const stepHex = STEP_STATUS_HEX[step.status] ?? COLORS.textMuted;
  const detailCellStyle: React.CSSProperties = { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "4px 8px" };

  // Heartbeat staleness detection
  const hbAge = heartbeatAgeMinutes(latestHeartbeatAt);
  const isHeartbeatStale = hbAge !== null && hbAge >= STALE_HEARTBEAT_THRESHOLD_MINUTES;

  // Stuck-state detection: step is running but has no attempt or attempt lacks a session
  const isRunning = step.status === "running";
  const hasRunningAttemptWithSession = latestAttempt
    && latestAttempt.status === "running"
    && latestAttempt.executorSessionId;
  const isWaitingForWorker = isRunning && (!latestAttempt || latestAttempt.status !== "running");
  const isWorkerInitializing = isRunning && latestAttempt?.status === "running" && !latestAttempt.executorSessionId;

  return (
    <aside className="p-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0 overflow-y-auto max-h-full" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>STEP DETAILS</div>
        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(stepHex)}>
          {step.status}
        </span>
      </div>

      {/* Stuck-state diagnostic banners */}
      {isWaitingForWorker && (
        <div
          className="mt-2 flex items-center gap-2 px-2 py-1.5 text-[10px]"
          style={{ background: `${COLORS.warning}12`, border: `1px solid ${COLORS.warning}30`, color: COLORS.warning }}
        >
          <SpinnerGap size={14} weight="regular" className="animate-spin shrink-0" />
          <span>Waiting for worker allocation...</span>
        </div>
      )}
      {isWorkerInitializing && (
        <div
          className="mt-2 flex items-center gap-2 px-2 py-1.5 text-[10px]"
          style={{ background: `${COLORS.accent}12`, border: `1px solid ${COLORS.accent}30`, color: COLORS.accent }}
        >
          <SpinnerGap size={14} weight="regular" className="animate-spin shrink-0" />
          <span>Initializing execution environment...</span>
        </div>
      )}

      {/* Stale heartbeat warning */}
      {isRunning && isHeartbeatStale && (
        <div
          className="mt-2 flex items-center gap-2 px-2 py-1.5 text-[10px]"
          style={{ background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}40`, color: COLORS.warning }}
        >
          <Warning size={14} weight="fill" className="shrink-0" />
          <span>Heartbeat stale ({Math.round(hbAge!)}m) — worker may be stuck</span>
        </div>
      )}

      <div className="mt-2">
        <div className="text-xs font-medium" style={{ color: COLORS.textPrimary }}>{step.title}</div>
        <div className="mt-1 min-h-[28px] text-[10px] leading-snug" style={{ color: COLORS.textMuted }}>{stepIntentSummary(step)}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>KEY</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{step.stepKey}</div>
        </div>
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>TYPE</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{stepType}</div>
        </div>
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>ATTEMPTS</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{attempts.length}</div>
        </div>
        <div style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>DEPENDENCIES</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{step.dependencyStepIds.length}</div>
        </div>
        <div className="col-span-2" style={detailCellStyle}>
          <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>LANE</div>
          <div className="font-medium" style={{ color: COLORS.textPrimary }}>{step.laneId ?? "none"}</div>
        </div>
      </div>

      {(dependencyLabels.length > 0 || doneCriteria || expectedSignals.length > 0) && (
        <div className="mt-3 px-2 py-2 text-[10px] space-y-1.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
          {dependencyLabels.length > 0 && (
            <div>
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>DEPENDS ON</div>
              <div className="mt-0.5 leading-snug" style={{ color: COLORS.textPrimary }}>{dependencyLabels.join(", ")}</div>
            </div>
          )}
          {doneCriteria && (
            <div>
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>COMPLETION CRITERIA</div>
              <div className="mt-0.5 leading-snug" style={{ color: COLORS.textPrimary }}>{compactText(doneCriteria, 220)}</div>
            </div>
          )}
          {expectedSignals.length > 0 && (
            <div>
              <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>EXPECTED SIGNALS</div>
              <div className="mt-0.5 leading-snug" style={{ color: COLORS.textPrimary }}>{expectedSignals.slice(0, 4).join(", ")}</div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 px-2 py-2 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
        <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", fontSize: 9 }}>LATEST WORKER ATTEMPT</div>
        {latestAttempt ? (
          <div className="mt-1 space-y-1">
            <div className="flex items-center justify-between">
              <span style={{ color: COLORS.textMuted }}>Executor</span>
              <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(EXECUTOR_BADGE_HEX[latestAttempt.executorKind] ?? COLORS.textMuted)}>
                {latestAttempt.executorKind}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ color: COLORS.textMuted }}>Status</span>
              <span style={{ color: COLORS.textPrimary }}>{latestAttempt.status}</span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ color: COLORS.textMuted }}>Started</span>
              <span style={{ color: COLORS.textPrimary }}>{latestAttempt.startedAt ? relativeWhen(latestAttempt.startedAt) : "--"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ color: COLORS.textMuted }}>Heartbeat age</span>
              <span
                className="flex items-center gap-1"
                style={{ color: isHeartbeatStale ? COLORS.warning : COLORS.textPrimary }}
              >
                {isHeartbeatStale && <Warning size={11} weight="fill" />}
                {latestHeartbeatAt ? relativeWhen(latestHeartbeatAt) : "--"}
              </span>
            </div>
            {latestAttempt.errorMessage && (
              <div className="px-1.5 py-1" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}18`, color: COLORS.danger }}>
                {compactText(latestAttempt.errorMessage, 160)}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-1 flex items-center gap-2" style={{ color: COLORS.textMuted }}>
            {isRunning ? (
              <>
                <SpinnerGap size={12} weight="regular" className="animate-spin" />
                <span>Waiting for worker allocation...</span>
              </>
            ) : (
              <span>No attempt has started yet.</span>
            )}
          </div>
        )}
      </div>

      {resultText && (
        <div className="mt-3 px-2 py-2 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
          <button
            onClick={() => setShowFullOutput(!showFullOutput)}
            className="flex items-center gap-1 transition-colors w-full"
            style={{ color: COLORS.textMuted }}
          >
            <CaretDown className={cn("h-3 w-3 transition-transform", showFullOutput && "rotate-180")} />
            <span className="font-bold uppercase tracking-[1px]" style={{ fontFamily: MONO_FONT }}>VIEW FULL OUTPUT</span>
          </button>
          {showFullOutput && (
            <pre className="mt-2 max-h-[300px] overflow-auto p-2 text-[10px] whitespace-pre-wrap break-all" style={{ background: COLORS.recessedBg, color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
              {resultText}
            </pre>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 space-y-1.5">
        {latestAttempt && (
          <button
            onClick={() => onOpenWorkerThread({
              kind: "worker",
              runId: step.runId,
              stepId: step.id,
              stepKey: step.stepKey,
              attemptId: latestAttempt.id,
              sessionId: latestAttempt.executorSessionId ?? null,
              laneId: step.laneId ?? null
            })}
            className="w-full px-2 py-1.5 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
            style={{ background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}30`, color: COLORS.accent, fontFamily: MONO_FONT }}
          >
            JUMP TO WORKER CHANNEL
          </button>
        )}
        {latestAttempt?.executorSessionId && (
          <button
            onClick={() => {
              window.open(`/work?sessionId=${encodeURIComponent(latestAttempt.executorSessionId!)}`, "_self");
            }}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
            style={{ background: `${COLORS.textMuted}10`, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }}
          >
            <Eye size={12} weight="regular" />
            VIEW IN WORK TAB
          </button>
        )}
      </div>
    </aside>
  );
}

/* ════════════════════ BOARD TAB ════════════════════ */

function BoardTab({
  stepsByStatus,
  attemptsByStep,
  selectedStepId,
  onStepSelect
}: {
  stepsByStatus: Map<MissionStepStatus, OrchestratorStep[]>;
  attemptsByStep: Map<string, OrchestratorAttempt[]>;
  selectedStepId: string | null;
  onStepSelect: (stepId: string) => void;
}) {
  const hasAnySteps = Array.from(stepsByStatus.values()).some((arr) => arr.length > 0);

  if (!hasAnySteps) {
    return (
      <div className="flex flex-col items-center justify-center py-16" style={{ color: COLORS.textMuted }}>
        <SquaresFour size={32} weight="regular" style={{ opacity: 0.2 }} className="mb-2" />
        <p className="text-xs" style={{ fontFamily: MONO_FONT }}>No steps yet. Start a run to see the board.</p>
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {STEP_STATUS_COLUMNS.map((col) => {
        const steps = stepsByStatus.get(col.status) ?? [];
        const colHex = STEP_STATUS_HEX[col.status] ?? COLORS.textMuted;
        return (
          <div
            key={col.status}
            className="w-[220px] shrink-0"
            style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
          >
            {/* Column header */}
            <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: colHex, fontFamily: MONO_FONT }}>{col.label}</span>
              <span className="px-1.5 py-0.5 text-[9px] font-bold" style={steps.length > 0 ? inlineBadge(COLORS.accent) : { color: COLORS.textMuted }}>
                {steps.length}
              </span>
            </div>

            {/* Step cards */}
            <div className="space-y-1.5 p-2">
              {steps.length === 0 && (
                <div className="px-2 py-3 text-center text-[10px]" style={{ color: COLORS.textDim }}>Empty</div>
              )}
              {steps.map((step) => {
                const attempts = attemptsByStep.get(step.id) ?? [];
                const latestAttempt = attempts[0];
                const duration = step.startedAt
                  ? step.completedAt
                    ? `${Math.round((Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 1000)}s`
                    : "running..."
                  : "--";

                return (
                  <div
                    key={step.id}
                    onClick={() => onStepSelect(step.id)}
                    className="px-2.5 py-2 transition-colors cursor-pointer"
                    style={selectedStepId === step.id
                      ? { background: "#A78BFA12", borderLeft: `3px solid ${COLORS.accent}`, border: `1px solid ${COLORS.accent}30` }
                      : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }
                    }
                  >
                    <div className="text-xs font-medium truncate" style={{ color: COLORS.textPrimary }}>{step.title}</div>
                    <div className="mt-0.5 text-[11px] leading-snug h-[28px] overflow-hidden" style={{ color: COLORS.textMuted }}>
                      {stepIntentSummary(step)}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                      {latestAttempt && (
                        <span className="px-1 py-0.5 text-[9px] font-bold uppercase tracking-[1px]" style={inlineBadge(EXECUTOR_BADGE_HEX[latestAttempt.executorKind] ?? COLORS.textMuted)}>
                          {latestAttempt.executorKind}
                        </span>
                      )}
                      {attempts.length > 0 && (
                        <span className="text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          {attempts.length} attempt{attempts.length !== 1 ? "s" : ""}
                        </span>
                      )}
                      <span className="text-[9px] ml-auto" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{duration}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Re-export for compatibility: the page was previously a named export */
export { MissionsPage };
