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
  Trash
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
  PrStrategy
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
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

/* ════════════════════ STATUS HELPERS ════════════════════ */

const STATUS_BADGE_CLASSES: Record<MissionStatus, string> = {
  queued: "bg-gray-500/20 text-gray-300 border-gray-500/30",
  planning: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  plan_review: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  in_progress: "bg-green-500/20 text-green-300 border-green-500/30",
  intervention_required: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  completed: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-300 border-red-500/30",
  canceled: "bg-gray-500/20 text-gray-400 border-gray-500/30"
};

const STATUS_DOT_COLORS: Record<MissionStatus, string> = {
  queued: "bg-gray-400",
  planning: "bg-blue-400",
  plan_review: "bg-cyan-400",
  in_progress: "bg-green-400",
  intervention_required: "bg-amber-400",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  canceled: "bg-gray-500"
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

const PRIORITY_CLASSES: Record<MissionPriority, string> = {
  urgent: "bg-red-500/20 text-red-300 border-red-500/30",
  high: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  normal: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  low: "bg-gray-500/20 text-gray-400 border-gray-500/30"
};

const STEP_STATUS_COLUMNS: Array<{ status: MissionStepStatus; label: string }> = [
  { status: "pending", label: "Pending" },
  { status: "running", label: "Running" },
  { status: "succeeded", label: "Succeeded" },
  { status: "failed", label: "Failed" },
  { status: "skipped", label: "Skipped" }
];

const STEP_STATUS_COLORS: Record<string, string> = {
  pending: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  running: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  succeeded: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-300 border-red-500/30",
  skipped: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  blocked: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  canceled: "bg-gray-500/20 text-gray-400 border-gray-500/30"
};

const EXECUTOR_BADGE_CLASSES: Record<string, string> = {
  claude: "bg-violet-500/20 text-violet-300",
  codex: "bg-emerald-500/20 text-emerald-300",
  shell: "bg-amber-500/20 text-amber-300",
  manual: "bg-blue-500/20 text-blue-300"
};

type WorkspaceTab = "board" | "dag" | "channels" | "activity" | "usage";
type MissionListViewMode = "list" | "board";

const MISSION_BOARD_COLUMNS: Array<{ key: MissionStatus; label: string; color: string }> = [
  { key: "queued", label: "Queued", color: "text-neutral-400" },
  { key: "planning", label: "Planning", color: "text-blue-400" },
  { key: "plan_review", label: "Review", color: "text-cyan-400" },
  { key: "in_progress", label: "Running", color: "text-green-400" },
  { key: "completed", label: "Done", color: "text-emerald-400" },
  { key: "failed", label: "Failed", color: "text-red-400" },
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

/** CSS color class for a timeline event type icon. */
function iconColorForEventType(eventType: string, reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("failed") || r.includes("error")) return "text-red-400";
  if (r.includes("succeeded") || r.includes("completed") || r.includes("success")) return "text-emerald-400";
  if (r.includes("paused") || r.includes("blocked")) return "text-amber-400";
  if (eventType.startsWith("run_")) return "text-green-400";
  if (eventType.startsWith("step_")) return "text-blue-400";
  if (eventType.startsWith("attempt_")) return "text-violet-400";
  if (eventType.startsWith("claim_")) return "text-amber-400";
  if (eventType.startsWith("autopilot")) return "text-violet-400";
  if (eventType === "user_directive") return "text-cyan-400";
  return "text-muted-fg";
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

const WORKER_STATUS_CLASSES: Record<string, string> = {
  spawned: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  initializing: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
  working: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  waiting_input: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  idle: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  completed: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-300 border-red-500/30",
  disposed: "bg-muted/30 text-muted-fg border-border/30"
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

  if (targetRunId && targetRunId === threadRunId) score += 8;

  const targetAttemptId = asNonEmptyString(target.attemptId);
  const threadAttemptId = asNonEmptyString(thread.attemptId);
  if (targetAttemptId) {
    if (threadAttemptId && targetAttemptId !== threadAttemptId) return -1;
    if (targetAttemptId === threadAttemptId) {
      score += 128;
      matchedIdentity = true;
    }
  }

  const targetSessionId = asNonEmptyString(target.sessionId);
  const threadSessionId = asNonEmptyString(thread.sessionId);
  if (targetSessionId) {
    if (threadSessionId && targetSessionId !== threadSessionId) return -1;
    if (targetSessionId === threadSessionId) {
      score += 96;
      matchedIdentity = true;
    }
  }

  const targetStepId = asNonEmptyString(target.stepId);
  const threadStepId = asNonEmptyString(thread.stepId);
  if (targetStepId) {
    if (threadStepId && targetStepId !== threadStepId) return -1;
    if (targetStepId === threadStepId) {
      score += 64;
      matchedIdentity = true;
    }
  }

  const targetStepKey = asNonEmptyString(target.stepKey);
  const threadStepKey = asNonEmptyString(thread.stepKey);
  if (targetStepKey) {
    if (threadStepKey && targetStepKey !== threadStepKey && !targetStepId) return -1;
    if (targetStepKey === threadStepKey) {
      score += 32;
      matchedIdentity = true;
    }
  }

  const targetLaneId = asNonEmptyString(target.laneId);
  const threadLaneId = asNonEmptyString(thread.laneId);
  if (targetLaneId) {
    if (threadLaneId && targetLaneId !== threadLaneId && !targetStepId && !targetStepKey) return -1;
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

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="w-full shrink-0 border-b border-border/10 bg-card/40 lg:w-[230px] lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between border-b border-border/10 px-3 py-2">
          <div className="text-[11px] font-semibold text-fg">Threads</div>
          <div className="text-[10px] text-muted-fg">{threads.length}</div>
        </div>
        <div className="max-h-[180px] overflow-y-auto p-2 lg:max-h-none lg:h-full">
          {threads.length === 0 && (
            <div className="rounded border border-border/15 bg-card/60 px-2 py-3 text-center text-[10px] text-muted-fg">
              No threads yet
            </div>
          )}
          <div className="space-y-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => setSelectedThreadId(thread.id)}
                className={cn(
                  "w-full rounded border px-2 py-2 text-left transition-colors",
                  selectedThreadId === thread.id
                    ? "border-accent/45 bg-accent/10"
                    : "border-border/15 bg-card/60 hover:bg-card/80"
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="truncate text-[11px] font-medium text-fg">{thread.title}</div>
                  {thread.unreadCount > 0 && (
                    <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] font-semibold text-accent-fg">
                      {thread.unreadCount}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[9px] text-muted-fg">
                  <span className={cn(
                    "rounded px-1 py-0.5 border",
                    thread.threadType === "mission"
                      ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
                      : "bg-violet-500/15 text-violet-300 border-violet-500/30"
                  )}>
                    {thread.threadType === "mission" ? "Mission" : "Worker"}
                  </span>
                  <span>{relativeWhen(thread.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-border/10 lg:border-b-0 lg:border-r lg:border-border/20">
        <div className="border-b border-border/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <ChatCircle size={14} weight="regular" className="text-accent" />
            <div className="text-[11px] font-semibold text-fg">
              {selectedThread?.title ?? "Select a thread"}
            </div>
            {selectedThread && (
              <span className="rounded border border-border/20 bg-card/80 px-1.5 py-0.5 text-[9px] text-muted-fg">
                {selectedThread.threadType}
              </span>
            )}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
          {!selectedThread && (
            <div className="rounded border border-border/15 bg-card/60 px-3 py-6 text-center text-[11px] text-muted-fg">
              Pick a mission or worker thread to inspect and send guidance.
            </div>
          )}
          {selectedThread && messages.length === 0 && (
            <div className="rounded border border-border/15 bg-card/60 px-3 py-6 text-center text-[11px] text-muted-fg">
              No messages yet in this thread.
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn(
                "max-w-[85%] rounded-lg border px-2.5 py-2 text-[11px]",
                msg.role === "user"
                  ? "border-accent/40 bg-accent/15 text-fg"
                  : msg.role === "worker"
                    ? "border-violet-500/35 bg-violet-500/10 text-violet-100"
                    : "border-border/20 bg-card/80 text-fg"
              )}>
                {msg.role !== "user" && (
                  <div className="mb-1 flex items-center gap-1 text-[9px] text-muted-fg">
                    {msg.role === "orchestrator" ? <Robot className="h-3 w-3" /> : <TerminalWindow className="h-3 w-3" />}
                    <span>{msg.role === "orchestrator" ? "Orchestrator" : "Worker"}</span>
                    {msg.stepKey ? <span>{"\u2022"} {msg.stepKey}</span> : null}
                  </div>
                )}
                <div className="whitespace-pre-wrap">{msg.content}</div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-muted-fg">
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                  {msg.role === "user" && selectedThread?.threadType === "worker" ? (
                    <span className={cn(
                      "rounded border px-1 py-0.5",
                      msg.deliveryState === "delivered"
                        ? "border-emerald-500/35 text-emerald-300"
                        : msg.deliveryState === "failed"
                          ? "border-red-500/35 text-red-300"
                          : "border-amber-500/35 text-amber-300"
                    )}>
                      {msg.deliveryState}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-border/10 px-3 py-2">
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
              className="h-8 flex-1 rounded border border-border/15 bg-surface-recessed px-3 text-xs text-fg outline-none focus:border-accent/40 disabled:opacity-50"
            />
            {selectedThread?.threadType === "mission" && (
              <label className="flex items-center gap-1 rounded border border-border/15 bg-card/60 px-2 py-1 text-[10px] text-muted-fg">
                <input
                  type="checkbox"
                  checked={broadcastToWorkers}
                  onChange={(event) => setBroadcastToWorkers(event.target.checked)}
                />
                Broadcast
              </label>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSend()}
              disabled={!selectedThread || !input.trim() || sending}
            >
              {sending ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <PaperPlaneTilt className="h-3 w-3" />}
              Send
            </Button>
          </div>
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 xl:flex xl:flex-col">
        <div className="border-b border-border/10 px-3 py-2">
          <div className="text-[11px] font-semibold text-fg">Worker Status</div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {workerThreadCards.length === 0 && (
            <div className="rounded border border-border/15 bg-card/60 px-2 py-3 text-center text-[10px] text-muted-fg">
              No worker threads yet.
            </div>
          )}
          {workerThreadCards.map(({ thread, state, digest }) => (
            <button
              key={thread.id}
              onClick={() => setSelectedThreadId(thread.id)}
              className={cn(
                "w-full rounded border px-2 py-2 text-left transition-colors",
                selectedThreadId === thread.id
                  ? "border-accent/45 bg-accent/10"
                  : "border-border/15 bg-card/60 hover:bg-card/80"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-[11px] font-medium text-fg">{thread.title}</div>
                <span className={cn(
                  "rounded border px-1 py-0.5 text-[9px] capitalize",
                  WORKER_STATUS_CLASSES[state?.state ?? digest?.status ?? "idle"] ?? "border-border/30 text-muted-fg"
                )}>
                  {(state?.state ?? digest?.status ?? "idle").replace("_", " ")}
                </span>
              </div>
              <div className="mt-1 text-[9px] text-muted-fg">
                heartbeat {relativeWhen(state?.lastHeartbeatAt ?? thread.updatedAt)}
              </div>
              <div className="mt-1 text-[10px] text-fg/80 leading-snug">
                {compactText(digest?.summary ?? "No worker digest yet.", 140)}
              </div>
            </button>
          ))}
        </div>

        <div className="border-t border-border/10 px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-fg">Mission Metrics</div>
            {savingMetrics ? <SpinnerGap className="h-3.5 w-3.5 animate-spin text-muted-fg" /> : null}
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
                  className={cn(
                    "rounded px-2 py-1 text-[10px] font-medium transition-colors border",
                    allEnabled
                      ? "bg-accent/20 text-accent border-accent/40"
                      : "bg-card/60 text-muted-fg border-border/15 hover:bg-card/80"
                  )}
                >
                  {group.label}
                </button>
              );
            })}
          </div>
          <div className="mt-2 rounded border border-border/15 bg-card/60 p-2">
            <div className="text-[10px] font-medium text-muted-fg">Latest Samples</div>
            <div className="mt-1 space-y-1">
              {METRIC_TOGGLE_ORDER.filter((toggle) => latestMetricByKey.has(toggle)).slice(0, 8).map((toggle) => {
                const sample = latestMetricByKey.get(toggle)!;
                return (
                  <div key={`${toggle}-${sample.id}`} className="flex items-center justify-between text-[10px]">
                    <span className="text-muted-fg">{METRIC_TOGGLE_LABELS[toggle]}</span>
                    <span className="text-fg">{formatMetricSample(sample)}</span>
                  </div>
                );
              })}
              {latestMetricByKey.size === 0 && (
                <div className="text-[10px] text-muted-fg">No samples captured yet.</div>
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
};

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
  "claude-sonnet": 16384,
  "claude-opus": 32768,
  "claude-haiku": 4096,
  "codex": 16384
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
    prDraft: true
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
      prDraft: true
    });
  }, [open, defaultExecutionPolicy]);

  const handleLaunch = useCallback(() => {
    if (!draft.prompt.trim()) return;
    onLaunch(draft);
  }, [draft, onLaunch]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl rounded-lg border border-border/30 bg-card shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b border-border/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">New Mission</h2>
          </div>
          <button onClick={onClose} className="text-muted-fg hover:text-fg transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Prompt */}
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-fg">Mission Prompt *</span>
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft((p) => ({ ...p, prompt: e.target.value }))}
              placeholder="Describe what you want to accomplish..."
              rows={4}
              className="w-full rounded-lg border border-border/15 bg-surface-recessed px-3 py-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 resize-none"
            />
          </label>

          {/* Title */}
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-fg">Title (optional, auto-generated)</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Refactor auth middleware"
              className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed px-3 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
            />
          </label>

          {/* Lane info */}
          <div className="rounded-lg border border-border/15 bg-surface-recessed/50 px-3 py-2 text-[11px] text-muted-fg">
            <GitBranch className="inline h-3 w-3 mr-1 -mt-0.5" />
            Missions automatically create dedicated lanes for each step.
          </div>

          {/* Orchestrator Model */}
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-fg">Orchestrator Model</span>
            <select
              value={draft.orchestratorModel}
              onChange={(e) => setDraft((p) => ({ ...p, orchestratorModel: e.target.value }))}
              className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none focus:border-accent/40"
            >
              <option value="sonnet">Claude Sonnet (default)</option>
              <option value="opus">Claude Opus</option>
              <option value="haiku">Claude Haiku</option>
            </select>
          </label>

          {/* Thinking Budgets */}
          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-fg">Thinking Budgets</span>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(draft.thinkingBudgets).map(([model, budget]) => (
                <label key={model} className="flex items-center gap-2 text-[10px]">
                  <span className="text-muted-fg w-[90px] shrink-0">{model.replace("claude-", "Claude ").replace("codex", "Codex")}</span>
                  <input
                    type="number"
                    step={1024}
                    value={budget}
                    onChange={(e) => setDraft((p) => ({
                      ...p,
                      thinkingBudgets: { ...p.thinkingBudgets, [model]: Number(e.target.value) || 0 }
                    }))}
                    className="h-7 w-full rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none focus:border-accent/40"
                  />
                  <span className="text-muted-fg/60 text-[9px] shrink-0">tokens</span>
                </label>
              ))}
            </div>
          </div>

          {/* PR Strategy */}
          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-fg">PR Strategy</span>
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
                  className={cn(
                    "rounded px-2.5 py-1 text-[10px] font-medium border transition-colors",
                    draft.prStrategy.kind === kind
                      ? "bg-accent/20 text-accent border-accent/40"
                      : "bg-card/60 text-muted-fg border-border/15 hover:bg-card/80"
                  )}
                >
                  {kind === "integration" ? "Integration PR" : kind === "per-lane" ? "Per-Lane PRs" : "Manual"}
                </button>
              ))}
            </div>
            {draft.prStrategy.kind !== "manual" && (
              <div className="flex items-center gap-3 mt-1">
                <label className="flex items-center gap-1.5 text-[10px]">
                  <span className="text-muted-fg">Target branch</span>
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
                    className="h-6 w-24 rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none focus:border-accent/40"
                  />
                </label>
                <label className="flex items-center gap-1 text-[10px] text-muted-fg">
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
            <span className="text-[11px] font-medium text-muted-fg">Execution Policy</span>
            <PolicyEditor
              value={draft.executionPolicy}
              onChange={(p) => setDraft((prev) => ({ ...prev, executionPolicy: p }))}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/10 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleLaunch}
            disabled={busy || !draft.prompt.trim()}
          >
            {busy ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
            Launch
          </Button>
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

  const inputClass = "h-8 w-full rounded border border-border/15 bg-surface-recessed px-2 text-xs text-fg outline-none focus:border-accent/40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl rounded-lg border border-border/30 bg-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <GearSix className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">Mission Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-fg hover:text-fg transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {notice ? <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{notice}</div> : null}
          {error ? <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div> : null}

          <div className="rounded-lg border border-border/15 bg-card/60 p-3">
            <div className="text-xs font-semibold text-fg">Mission Defaults</div>
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-[11px] text-muted-fg mb-1">Default Execution Policy</div>
                <PolicyEditor
                  value={draft.defaultExecutionPolicy}
                  onChange={(p) => onDraftChange({ defaultExecutionPolicy: p })}
                  compact
                />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-xs">
                <div className="text-muted-fg">Default planner provider</div>
                <select
                  className={inputClass}
                  value={draft.defaultPlannerProvider}
                  onChange={(e) => onDraftChange({ defaultPlannerProvider: e.target.value as PlannerProvider })}
                >
                  <option value="auto">Auto</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs pt-5">
                <input
                  type="checkbox"
                  checked={draft.requirePlanReview}
                  onChange={(e) => onDraftChange({ requirePlanReview: e.target.checked })}
                />
                Require plan review
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-border/15 bg-card/60 p-3">
            <div className="text-xs font-semibold text-fg">Worker Permissions</div>
            <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium text-fg">Claude Worker</div>
                <label className="text-xs block">
                  <div className="text-muted-fg">Permission mode</div>
                  <select
                    className={inputClass}
                    value={draft.claudePermissionMode}
                    disabled={draft.claudeDangerouslySkip}
                    onChange={(e) => onDraftChange({ claudePermissionMode: e.target.value })}
                  >
                    <option value="plan">Plan (read-only)</option>
                    <option value="acceptEdits">Accept edits</option>
                    <option value="bypassPermissions">Bypass permissions</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={draft.claudeDangerouslySkip}
                    onChange={(e) => onDraftChange({ claudeDangerouslySkip: e.target.checked })}
                  />
                  Dangerously skip permissions
                </label>
                <div className="text-[11px] text-muted-fg">
                  Claude workers read `CLAUDE.md` and `.claude/settings.json` from the lane repository root.
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-fg">Codex Worker</div>
                <label className="text-xs block">
                  <div className="text-muted-fg">Sandbox mode</div>
                  <select
                    className={inputClass}
                    value={draft.codexSandboxPermissions}
                    onChange={(e) => onDraftChange({ codexSandboxPermissions: e.target.value })}
                  >
                    <option value="read-only">Read-only</option>
                    <option value="workspace-write">Workspace write</option>
                    <option value="danger-full-access">Full access (dangerous)</option>
                  </select>
                </label>
                <label className="text-xs block">
                  <div className="text-muted-fg">Approval mode</div>
                  <select
                    className={inputClass}
                    value={draft.codexApprovalMode}
                    onChange={(e) => onDraftChange({ codexApprovalMode: e.target.value })}
                  >
                    <option value="suggest">Suggest</option>
                    <option value="auto-edit">Auto-edit</option>
                    <option value="full-auto">Full auto</option>
                  </select>
                </label>
                <label className="text-xs block">
                  <div className="text-muted-fg">Config TOML path</div>
                  <input
                    type="text"
                    className={inputClass}
                    value={draft.codexConfigPath}
                    onChange={(e) => onDraftChange({ codexConfigPath: e.target.value })}
                    placeholder="e.g. /Users/you/.config/codex/config.toml"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/10 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Close</Button>
          <Button variant="primary" size="sm" onClick={onSave} disabled={busy}>
            {busy ? "Saving..." : "Save settings"}
          </Button>
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
        defaultRetryLimit: 1
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
      await startRunForMission({
        missionId: selectedMission.id,
        laneId: selectedMission.laneId,
        executorKind: fallbackExecutor,
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
      <div className="flex h-full items-center justify-center">
        <SpinnerGap className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  /* ════════════════════ RENDER ════════════════════ */
  return (
    <LazyMotion features={domAnimation}>
      <div className="flex h-full min-h-0">
        {/* ════════════ LEFT SIDEBAR ════════════ */}
        <div className="flex w-[260px] shrink-0 flex-col border-r border-border/20 bg-card/40">
          {/* Sidebar Header */}
          <div className="flex items-center justify-between border-b border-border/10 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Rocket className="h-4 w-4 text-accent" />
              <span className="text-xs font-semibold text-fg">Missions</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => void refreshMissionList({ preserveSelection: true })}
                className="rounded p-1 text-muted-fg hover:text-fg hover:bg-muted/20 transition-colors"
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
                className="rounded p-1 text-muted-fg hover:text-fg hover:bg-muted/20 transition-colors"
                title="Mission Settings"
              >
                <GearSix className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setCreateOpen(true)}
                className="rounded p-1 text-accent hover:bg-accent/10 transition-colors"
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
                <MagnifyingGlass className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-fg/60" />
                <input
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="Search missions..."
                  className="h-7 w-full rounded border border-border/15 bg-surface-recessed pl-7 pr-2 text-xs text-fg outline-none focus:border-accent/30"
                />
              </div>
              <div className="flex gap-0.5 rounded-lg bg-card/60 border border-border/10 p-0.5">
                <button
                  className={cn("rounded px-1.5 py-1 text-xs", missionListView === "list" ? "bg-accent/20 text-fg" : "text-muted-fg hover:text-fg")}
                  onClick={() => setMissionListView("list")}
                  title="List view"
                >
                  <List size={14} weight="regular" />
                </button>
                <button
                  className={cn("rounded px-1.5 py-1 text-xs", missionListView === "board" ? "bg-accent/20 text-fg" : "text-muted-fg hover:text-fg")}
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
              <div className="px-2 py-8 text-center text-xs text-muted-fg/60">
                {missions.length === 0 ? (
                  <div className="flex flex-col items-center gap-2">
                    <Rocket size={28} weight="regular" className="text-blue-400/40" />
                    <p>No missions yet. Missions coordinate your AI agents to accomplish complex tasks.</p>
                    <button
                      onClick={() => setCreateOpen(true)}
                      className="mt-1 rounded-lg bg-blue-500/15 border border-blue-500/30 px-3 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-500/25 transition-colors"
                    >
                      Start Mission
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
                        <span className={cn("text-[10px] font-medium uppercase tracking-wider", col.color)}>{col.label}</span>
                        <span className="text-[10px] text-muted-fg/50">{colMissions.length}</span>
                      </div>
                      <div className="space-y-1">
                        {colMissions.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => setSelectedMissionId(m.id)}
                            className={cn(
                              "w-full text-left rounded-lg p-2.5 transition-colors border",
                              m.id === selectedMissionId
                                ? "border-accent/30 bg-accent/10"
                                : "border-border/10 bg-card/70 hover:bg-card/90"
                            )}
                          >
                            <div className="text-xs font-medium text-fg truncate">{m.title}</div>
                            <div className="mt-1 text-[11px] text-muted-fg truncate">{m.prompt}</div>
                            <div className="mt-1.5 flex items-center gap-2">
                              <span className="text-[10px] font-mono text-muted-fg">{relativeWhen(m.createdAt)}</span>
                              {m.totalSteps > 0 && (
                                <span className="text-[10px] text-muted-fg ml-auto">{m.completedSteps}/{m.totalSteps}</span>
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
                  return (
                    <button
                      key={m.id}
                      onClick={() => setSelectedMissionId(m.id)}
                      className={cn(
                        "w-full text-left rounded-lg px-2.5 py-2 transition-colors",
                        isSelected
                          ? "bg-accent/15 border border-accent/30"
                          : "hover:bg-card/60 border border-transparent",
                        isActive && !isSelected && "ade-glow-pulse-blue"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", STATUS_DOT_COLORS[m.status])} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-fg">{m.title}</div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className={cn("rounded px-1 py-0.5 text-[9px] font-medium border", STATUS_BADGE_CLASSES[m.status])}>
                              {STATUS_LABELS[m.status]}
                            </span>
                          </div>
                          {m.totalSteps > 0 && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1 flex-1 rounded-full bg-card">
                                <div
                                  className="h-1 rounded-full bg-accent transition-all"
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                              <span className="shrink-0 text-[9px] text-muted-fg">
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
        <div className="flex flex-1 flex-col min-w-0">
          {!selectedMissionId ? (
            /* No selection empty state */
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-fg">
              <Rocket size={40} weight="regular" className="opacity-20" />
              <p className="text-sm">Select a mission or create a new one</p>
              <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus size={14} weight="regular" />
                New Mission
              </Button>
            </div>
          ) : (
            <>
              {/* ── Header Bar ── */}
              <div className="flex items-center gap-3 border-b border-border/10 bg-card/40 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-fg">
                      {selectedMission?.title ?? "Loading..."}
                    </h2>
                    {selectedMission && (
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium border", STATUS_BADGE_CLASSES[selectedMission.status])}>
                        {STATUS_LABELS[selectedMission.status]}
                      </span>
                    )}
                    {selectedMission && (
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium border", PRIORITY_CLASSES[selectedMission.priority])}>
                        {selectedMission.priority}
                      </span>
                    )}
                    {runGraph?.run?.metadata && (
                      <MissionPolicyBadge
                        policy={(runGraph.run.metadata as Record<string, unknown>).executionPolicy as MissionExecutionPolicy | undefined}
                      />
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-fg">
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
                    <Button variant="primary" size="sm" onClick={handleStartRun} disabled={runBusy}>
                      {runBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      {runGraph ? "Rerun" : "Start"}
                    </Button>
                  )}
                  {canResumeRun && (
                    <Button variant="outline" size="sm" onClick={handleResumeRun} disabled={runBusy}>
                      <Play className="h-3 w-3" />
                      Resume
                    </Button>
                  )}
                  {canCancelRun && (
                    <Button variant="outline" size="sm" onClick={handleCancelRun} disabled={runBusy}>
                      <Stop className="h-3 w-3" />
                      Cancel
                    </Button>
                  )}
                  {selectedMission && (selectedMission.status === "failed" || selectedMission.status === "canceled") && runGraph?.steps && runGraph.steps.some(s => s.laneId) && (
                    <Button variant="ghost" size="sm" onClick={handleCleanupLanes} disabled={cleanupBusy}>
                      {cleanupBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Trash className="h-3 w-3" />}
                      Clean up lanes
                    </Button>
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
                    className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-[11px] text-red-300 flex items-center justify-between"
                  >
                    <span>{error}</span>
                    <button onClick={() => setError(null)} className="text-red-300 hover:text-red-100">
                      <X className="h-3 w-3" />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ── Tab Navigation ── */}
              <div className="flex items-center gap-0.5 border-b border-border/10 bg-card/30 px-4">
                {([
                  { key: "board" as WorkspaceTab, label: "Board", icon: SquaresFour },
                  { key: "dag" as WorkspaceTab, label: "DAG", icon: Graph },
                  { key: "channels" as WorkspaceTab, label: "Channels", icon: Hash },
                  { key: "activity" as WorkspaceTab, label: "Activity", icon: Pulse },
                  { key: "usage" as WorkspaceTab, label: "Usage", icon: Lightning }
                ]).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2",
                      activeTab === tab.key
                        ? "border-accent text-fg"
                        : "border-transparent text-muted-fg hover:text-fg"
                    )}
                  >
                    <tab.icon className="h-3.5 w-3.5" />
                    {tab.label}
                  </button>
                ))}
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
                      <div className="text-[10px] text-muted-fg flex items-center gap-2">
                        <span>{completed} of {total} steps complete ({pct}%)</span>
                        {originalStepCount !== null && originalStepCount !== total && (
                          <span className="text-amber-400/70">(plan adjusted from {originalStepCount} steps)</span>
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
                  <MissionChat
                    missionId={selectedMissionId}
                    runId={runGraph?.run.id ?? null}
                    jumpTarget={chatJumpTarget}
                    onJumpHandled={() => setChatJumpTarget(null)}
                  />
                )}

                {activeTab === "usage" && selectedMission && (
                  <UsageDashboard missionId={selectedMission.id} missionTitle={selectedMission.title} />
                )}
              </div>

              {/* ── Bottom Steering Bar (hidden on Channels tab since channels subsume steering) ── */}
              {isActiveMission && activeTab !== "channels" && (
                <div className="border-t border-border/10 bg-card/40 px-4 py-2.5">
                  {steerAck && (
                    <div className="mb-2 rounded border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-[10px] text-emerald-300 flex items-center justify-between">
                      <span>{steerAck}</span>
                      <button onClick={() => setSteerAck(null)} className="text-emerald-300 hover:text-emerald-100">
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
                      className="h-8 flex-1 rounded-lg border border-border/15 bg-surface-recessed px-3 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleSteer()}
                      disabled={steerBusy || !steerInput.trim()}
                    >
                      {steerBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <PaperPlaneTilt className="h-3 w-3" />}
                      Send
                    </Button>
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
      <div className="rounded-lg border border-border/15 bg-card/60 px-3 py-3 text-center">
        <div className="text-xs text-muted-fg">No orchestrator run yet. Start a run to see activity.</div>
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
      <div className="rounded-lg border border-border/15 bg-card/60 px-3 py-2.5">
        <div className="text-[10px] font-medium text-muted-fg uppercase tracking-wider mb-2">Mission Progress</div>

        {/* Progress bar */}
        {totalSteps > 0 && (
          <div className="mb-2">
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-card">
              {succeededCount > 0 && (
                <div
                  className="bg-emerald-500 transition-all"
                  style={{ width: `${(succeededCount / totalSteps) * 100}%` }}
                />
              )}
              {runningCount > 0 && (
                <div
                  className="bg-violet-500 transition-all"
                  style={{ width: `${(runningCount / totalSteps) * 100}%` }}
                />
              )}
              {failedCount > 0 && (
                <div
                  className="bg-red-500 transition-all"
                  style={{ width: `${(failedCount / totalSteps) * 100}%` }}
                />
              )}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-fg/90">
            <CheckCircle size={12} weight="regular" className="text-emerald-400 shrink-0" />
            <span>{progressLine}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-fg/80">
            <Robot size={12} weight="regular" className="text-violet-400 shrink-0" />
            <span>{workersLine}</span>
          </div>
          {lastActionLine && (
            <div className="flex items-center gap-1.5 text-xs text-fg/70">
              <Lightning size={12} weight="regular" className="text-amber-400 shrink-0" />
              <span className="truncate">{lastActionLine}</span>
            </div>
          )}
        </div>
      </div>

      {/* Narrative feed card */}
      {(narrativeLines.length > 0 || steeringLog.length > 0) && (
        <div className="rounded-lg border border-border/15 bg-card/60 px-3 py-2.5">
          <div className="text-[10px] font-medium text-muted-fg uppercase tracking-wider mb-1.5">Recent Activity</div>
          <div className="space-y-1">
            {/* Show steering directives first */}
            {steeringLog.map((d, i) => (
              <div key={`steer-${i}`} className="flex items-start gap-2">
                <ChatCircle size={12} weight="regular" className="text-cyan-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] text-cyan-300">User directive: {d.directive}</span>
                  <span className="ml-2 text-[10px] text-muted-fg">{relativeWhen(d.appliedAt)}</span>
                </div>
              </div>
            ))}
            {/* Show recent timeline events with icons */}
            {recentEvents.map((ev, i) => {
              const Icon = iconForEventType(ev.eventType);
              const color = iconColorForEventType(ev.eventType, ev.reason);
              return (
                <div key={`ev-${ev.id ?? i}`} className="flex items-start gap-2">
                  <Icon className={cn("h-3 w-3 shrink-0 mt-0.5", color)} />
                  <div className="flex-1 min-w-0">
                    <span className="text-[11px] text-fg/80">{narrativeForEvent(ev)}</span>
                    <span className="ml-2 text-[10px] text-muted-fg">{relativeWhen(ev.createdAt)}</span>
                  </div>
                </div>
              );
            })}
            {narrativeLines.length === 0 && steeringLog.length === 0 && (
              <div className="text-[11px] text-muted-fg">Processing events...</div>
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
      <aside className="rounded-lg border border-border/15 bg-card/60 p-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0">
        <div className="text-[11px] font-semibold text-fg">Step Details</div>
        <p className="mt-2 text-[11px] text-muted-fg">Select a card in Board or a node in DAG to inspect worker progress.</p>
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

  return (
    <aside className="rounded-lg border border-border/15 bg-card/60 p-3 lg:w-[380px] lg:max-w-[40%] lg:shrink-0 overflow-y-auto max-h-full">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-fg">Step Details</div>
        <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-medium", STEP_STATUS_COLORS[step.status] ?? "bg-muted/20 text-muted-fg")}>
          {step.status}
        </span>
      </div>

      <div className="mt-2">
        <div className="text-xs font-medium text-fg">{step.title}</div>
        <div className="mt-1 min-h-[28px] text-[10px] text-muted-fg leading-snug">{stepIntentSummary(step)}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded border border-border/15 bg-card/50 px-2 py-1">
          <div className="text-muted-fg">Key</div>
          <div className="font-medium text-fg">{step.stepKey}</div>
        </div>
        <div className="rounded border border-border/15 bg-card/50 px-2 py-1">
          <div className="text-muted-fg">Type</div>
          <div className="font-medium text-fg">{stepType}</div>
        </div>
        <div className="rounded border border-border/15 bg-card/50 px-2 py-1">
          <div className="text-muted-fg">Attempts</div>
          <div className="font-medium text-fg">{attempts.length}</div>
        </div>
        <div className="rounded border border-border/15 bg-card/50 px-2 py-1">
          <div className="text-muted-fg">Dependencies</div>
          <div className="font-medium text-fg">{step.dependencyStepIds.length}</div>
        </div>
        <div className="col-span-2 rounded border border-border/15 bg-card/50 px-2 py-1">
          <div className="text-muted-fg">Lane</div>
          <div className="font-medium text-fg">{step.laneId ?? "none"}</div>
        </div>
      </div>

      {(dependencyLabels.length > 0 || doneCriteria || expectedSignals.length > 0) && (
        <div className="mt-3 rounded border border-border/15 bg-card/50 px-2 py-2 text-[10px] space-y-1.5">
          {dependencyLabels.length > 0 && (
            <div>
              <div className="text-muted-fg">Depends on</div>
              <div className="mt-0.5 text-fg leading-snug">{dependencyLabels.join(", ")}</div>
            </div>
          )}
          {doneCriteria && (
            <div>
              <div className="text-muted-fg">Completion Criteria</div>
              <div className="mt-0.5 text-fg leading-snug">{compactText(doneCriteria, 220)}</div>
            </div>
          )}
          {expectedSignals.length > 0 && (
            <div>
              <div className="text-muted-fg">Expected Signals</div>
              <div className="mt-0.5 text-fg leading-snug">{expectedSignals.slice(0, 4).join(", ")}</div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 rounded border border-border/15 bg-card/50 px-2 py-2 text-[10px]">
        <div className="text-muted-fg">Latest Worker Attempt</div>
        {latestAttempt ? (
          <div className="mt-1 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-fg">Executor</span>
              <span className={cn(
                "rounded px-1 py-0.5 text-[9px] font-medium",
                EXECUTOR_BADGE_CLASSES[latestAttempt.executorKind] ?? "bg-muted/20 text-muted-fg"
              )}>
                {latestAttempt.executorKind}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-fg">Status</span>
              <span className="text-fg">{latestAttempt.status}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-fg">Started</span>
              <span className="text-fg">{latestAttempt.startedAt ? relativeWhen(latestAttempt.startedAt) : "--"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-fg">Heartbeat age</span>
              <span className="text-fg">{latestHeartbeatAt ? relativeWhen(latestHeartbeatAt) : "--"}</span>
            </div>
            {latestAttempt.errorMessage && (
              <div className="rounded border border-red-500/25 bg-red-500/10 px-1.5 py-1 text-red-300">
                {compactText(latestAttempt.errorMessage, 160)}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-1 text-muted-fg">No attempt has started yet.</div>
        )}
      </div>

      {resultText && (
        <div className="mt-3 rounded border border-border/15 bg-card/50 px-2 py-2 text-[10px]">
          <button
            onClick={() => setShowFullOutput(!showFullOutput)}
            className="flex items-center gap-1 text-muted-fg hover:text-fg transition-colors w-full"
          >
            <CaretDown className={cn("h-3 w-3 transition-transform", showFullOutput && "rotate-180")} />
            <span className="font-medium">View Full Output</span>
          </button>
          {showFullOutput && (
            <pre className="mt-2 max-h-[300px] overflow-auto rounded bg-card/80 p-2 text-[10px] font-mono text-fg/80 whitespace-pre-wrap break-all">
              {resultText}
            </pre>
          )}
        </div>
      )}

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
          className="mt-3 w-full rounded border border-accent/30 bg-accent/10 px-2 py-1.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"
        >
          Jump To Worker Channel
        </button>
      )}
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
      <div className="flex flex-col items-center justify-center py-16 text-muted-fg">
        <SquaresFour size={32} weight="regular" className="opacity-20 mb-2" />
        <p className="text-xs">No steps yet. Start a run to see the board.</p>
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {STEP_STATUS_COLUMNS.map((col) => {
        const steps = stepsByStatus.get(col.status) ?? [];
        return (
          <div
            key={col.status}
            className="w-[220px] shrink-0 rounded-lg border border-border/10 bg-card/70 backdrop-blur-sm"
          >
            {/* Column header */}
            <div className="flex items-center justify-between border-b border-border/15 px-3 py-2">
              <span className="text-xs font-semibold text-fg">{col.label}</span>
              <span className={cn(
                "rounded-full px-1.5 py-0.5 text-[9px] font-medium",
                steps.length > 0 ? "bg-accent/15 text-accent" : "bg-muted/10 text-muted-fg"
              )}>
                {steps.length}
              </span>
            </div>

            {/* Step cards */}
            <div className="space-y-1.5 p-2">
              {steps.length === 0 && (
                <div className="px-2 py-3 text-center text-[10px] text-muted-fg/50">Empty</div>
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
                    className={cn(
                      "rounded-lg border px-2.5 py-2 transition-colors cursor-pointer",
                      selectedStepId === step.id
                        ? "border-accent/45 bg-accent/10"
                        : "border-border/15 bg-card/50 hover:bg-card/70"
                    )}
                  >
                    <div className="text-xs font-medium text-fg truncate">{step.title}</div>
                    <div className="mt-0.5 text-[11px] text-muted-fg leading-snug h-[28px] overflow-hidden">
                      {stepIntentSummary(step)}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                      {latestAttempt && (
                        <span className={cn(
                          "rounded px-1 py-0.5 text-[9px] font-medium",
                          EXECUTOR_BADGE_CLASSES[latestAttempt.executorKind] ?? "bg-muted/20 text-muted-fg"
                        )}>
                          {latestAttempt.executorKind}
                        </span>
                      )}
                      {attempts.length > 0 && (
                        <span className="text-[9px] text-muted-fg">
                          {attempts.length} attempt{attempts.length !== 1 ? "s" : ""}
                        </span>
                      )}
                      <span className="text-[9px] text-muted-fg ml-auto">{duration}</span>
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
