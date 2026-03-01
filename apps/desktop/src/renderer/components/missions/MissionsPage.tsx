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
  CaretLeft,
  CaretRight,
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
  OrchestratorStepStatus,
  MissionMetricToggle,
  MissionMetricsConfig,
  MissionMetricSample,
  ProjectConfigSnapshot,
  StartOrchestratorRunFromMissionArgs,
  SteerMissionResult,
  PrStrategy,
  MissionModelConfig,
  SmartBudgetConfig,
  ModelConfig,
  OrchestratorDecisionTimeoutCapHours,
  PrDepth,
  MissionDashboardSnapshot,
  PhaseCard,
  PhaseProfile,
  MissionPreflightChecklistItem,
  MissionPreflightResult,
  AggregatedUsageStats
} from "../../../shared/types";
import { BUILT_IN_PROFILES, getProfileById } from "../../../shared/modelProfiles";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { MODEL_REGISTRY, MODEL_FAMILIES, getModelById, type ProviderFamily } from "../../../shared/modelRegistry";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { OrchestratorActivityFeed } from "./OrchestratorActivityFeed";
import { OrchestratorDAG } from "./OrchestratorDAG";
import { PRESET_STANDARD } from "./PolicyEditor";
import { CompletionBanner } from "./CompletionBanner";
import { PhaseProgressBar } from "./PhaseProgressBar";
import { MissionPolicyBadge } from "./MissionPolicyBadge";
import { UsageDashboard } from "./UsageDashboard";
import { AgentChannels } from "./AgentChannels";
import { MissionChatV2 } from "./MissionChatV2";
import { MissionControlPage } from "./MissionControlPage";
import { ModelProfileSelector } from "./ModelProfileSelector";
import { ModelSelector } from "./ModelSelector";
import { SmartBudgetPanel } from "./SmartBudgetPanel";
import { MissionPromptInput } from "./MissionPromptInput";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, inlineBadge, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";

/* ════════════════════ STATUS HELPERS ════════════════════ */

const STATUS_BADGE_STYLES: Record<MissionStatus, { background: string; color: string; border: string }> = {
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

const STATUS_DOT_HEX: Record<MissionStatus, string> = {
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

const STATUS_LABELS: Record<MissionStatus, string> = {
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

const PRIORITY_STYLES: Record<MissionPriority, { background: string; color: string; border: string }> = {
  urgent: { background: "#EF444418", color: "#EF4444", border: "1px solid #EF444430" },
  high: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  normal: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  low: { background: "#71717A18", color: "#71717A", border: "1px solid #71717A30" },
};

const STEP_STATUS_HEX: Record<string, string> = {
  pending: "#3B82F6",
  running: "#A78BFA",
  succeeded: "#22C55E",
  failed: "#EF4444",
  skipped: "#71717A",
  superseded: "#F59E0B",
  blocked: "#F59E0B",
  canceled: "#71717A",
};

const EXECUTOR_BADGE_HEX: Record<string, string> = {
  unified: "#6366F1",
  claude: "#A78BFA",
  codex: "#22C55E",
  shell: "#F59E0B",
  manual: "#3B82F6",
};

type WorkspaceTab = "plan" | "work" | "dag" | "chat" | "activity" | "details";
type MissionListViewMode = "list" | "board";

const MISSION_BOARD_COLUMNS: Array<{ key: MissionStatus; label: string; hex: string }> = [
  { key: "queued", label: "QUEUED", hex: "#71717A" },
  { key: "planning", label: "PLANNING", hex: "#3B82F6" },
  { key: "plan_review", label: "REVIEW", hex: "#06B6D4" },
  { key: "in_progress", label: "RUNNING", hex: "#22C55E" },
  { key: "completed", label: "DONE", hex: "#22C55E" },
  { key: "partially_completed", label: "PARTIAL", hex: "#F59E0B" },
  { key: "failed", label: "FAILED", hex: "#EF4444" },
];
type PlannerProvider = "auto" | (string & {});
type TeammatePlanMode = "auto" | "off" | "required";

type MissionSettingsDraft = {
  defaultExecutionPolicy: MissionExecutionPolicy;
  defaultPrStrategy: PrStrategy;
  defaultPlannerProvider: PlannerProvider;
  teammatePlanMode: TeammatePlanMode;
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
  teammatePlanMode: "auto",
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
    prReview: mergePhase("prReview", defaults.prReview),
    merge: mergePhase("merge", defaults.merge),
    completion: mergePhase("completion", defaults.completion)
  };
}

function toPlannerProvider(value: string): PlannerProvider {
  // Accept "auto", legacy "claude"/"codex", or any model ID from the registry
  if (value === "auto") return "auto";
  if (getModelById(value)) return value;
  // Backward compat: map old "claude"/"codex" to model IDs
  if (value === "claude") return "anthropic/claude-sonnet-4-6";
  if (value === "codex") return "openai/gpt-5.3-codex";
  return "auto";
}

function toTeammatePlanMode(value: string): TeammatePlanMode {
  return value === "off" || value === "required" || value === "auto" ? value : "auto";
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

/** Self-ticking elapsed-time display — isolates the 1s timer from the parent tree. */
function ElapsedTime({ startedAt, endedAt }: { startedAt: string | null; endedAt?: string | null }) {
  const [, setTick] = useState(0);
  const isTerminal = !!endedAt;
  useEffect(() => {
    if (isTerminal || !startedAt) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isTerminal, startedAt]);
  return <>{formatElapsed(startedAt, endedAt)}</>;
}

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
    const missionThread = args.threads.find((thread) => thread.threadType === "coordinator");
    if (missionThread) return missionThread.id;
  }
  if (args.jumpTarget?.kind === "teammate") {
    const teammateThread = args.threads.find((thread) => thread.threadType === "teammate");
    if (teammateThread) return teammateThread.id;
    // Fallback to coordinator/mission thread
    const coordThread = args.threads.find((thread) => thread.threadType === "coordinator");
    if (coordThread) return coordThread.id;
  }
  if (args.jumpTarget?.kind === "worker") {
    const matched = findBestWorkerThread(args.threads, args.jumpTarget);
    if (matched) return matched.id;
    // If no worker thread matched (e.g. planner step), fall back to coordinator thread
    const coordThread = args.threads.find((thread) => thread.threadType === "coordinator");
    if (coordThread) return coordThread.id;
  }
  if (args.selectedThreadId && args.threads.some((thread) => thread.id === args.selectedThreadId)) {
    return args.selectedThreadId;
  }
  const missionThread = args.threads.find((thread) => thread.threadType === "coordinator");
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
      let target: OrchestratorChatTarget;
      if (thread?.threadType === "worker") {
        target = {
          kind: "worker",
          runId: thread.runId ?? graph.run.id ?? null,
          stepId: thread.stepId ?? null,
          stepKey: thread.stepKey ?? null,
          attemptId: thread.attemptId ?? null,
          sessionId: thread.sessionId ?? null,
          laneId: thread.laneId ?? null
        };
      } else if (thread?.threadType === "teammate") {
        target = {
          kind: "teammate",
          runId: thread.runId ?? graph.run.id ?? null,
          teamMemberId: (thread as OrchestratorChatThread & { teamMemberId?: string }).teamMemberId ?? null
        };
      } else {
        target = {
          kind: "coordinator",
          runId: graph.run.id ?? null
        };
      }
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
  const visibleRef = useRef(true);

  // Pause polling when tab/window is not visible
  useEffect(() => {
    const onVisChange = () => { visibleRef.current = document.visibilityState === "visible"; };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, []);

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
    const missionThread = threads.find((thread) => thread.threadType === "coordinator");
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
      if (!visibleRef.current) return; // skip poll when backgrounded
      void refreshThreads();
      void refreshWorkerRail();
    }, 12_000);
    return () => clearInterval(interval);
  }, [refreshThreads, refreshWorkerRail]);

  useEffect(() => {
    void refreshMessages(selectedThreadId);
    const interval = setInterval(() => {
      if (!visibleRef.current) return; // skip poll when backgrounded
      void refreshMessages(selectedThreadIdRef.current);
    }, 8_000);
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
    if (!selectedThread || selectedThread.threadType !== "coordinator") {
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
      let target: OrchestratorChatTarget;
      if (selectedThread.threadType === "worker") {
        target = {
          kind: "worker",
          runId: selectedThread.runId ?? runId ?? null,
          stepId: selectedThread.stepId ?? null,
          stepKey: selectedThread.stepKey ?? null,
          attemptId: selectedThread.attemptId ?? null,
          sessionId: selectedThread.sessionId ?? null,
          laneId: selectedThread.laneId ?? null
        };
      } else if (selectedThread.threadType === "teammate") {
        target = {
          kind: "teammate",
          runId: selectedThread.runId ?? runId ?? null,
          teamMemberId: (selectedThread as OrchestratorChatThread & { teamMemberId?: string }).teamMemberId ?? null
        };
      } else if (broadcastToWorkers) {
        target = {
          kind: "workers",
          runId: selectedThread.runId ?? runId ?? null,
          laneId: null,
          includeClosed: false
        };
      } else {
        target = {
          kind: "coordinator",
          runId: selectedThread.runId ?? runId ?? null
        };
      }
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

  const threadTypeBadgeHex = (type: string) =>
    type === "coordinator" ? "#3B82F6"
    : type === "teammate" ? "#06B6D4"
    : "#A78BFA";
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
                    {thread.threadType === "coordinator" ? "COORDINATOR" : thread.threadType === "teammate" ? "TEAMMATE" : "WORKER"}
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
                  : selectedThread?.threadType === "coordinator" && broadcastToWorkers
                    ? "Broadcast guidance to all worker threads in this run..."
                  : "Message the mission coordinator..."
              }
              className="h-8 flex-1 px-3 text-xs outline-none disabled:opacity-50"
              style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}
            />
            {selectedThread?.threadType === "coordinator" && (
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
  prStrategy: PrStrategy;
  /** New model configuration */
  modelConfig: MissionModelConfig;
  phaseProfileId: string | null;
  phaseOverride: PhaseCard[];
};

const DECISION_TIMEOUT_CAP_OPTIONS: OrchestratorDecisionTimeoutCapHours[] = [6, 12, 24, 48];

const DEFAULT_MODEL_CONFIG: MissionModelConfig = {
  profileId: "standard",
  orchestratorModel: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
  decisionTimeoutCapHours: 24,
  intelligenceConfig: BUILT_IN_PROFILES[0].intelligenceConfig,
  smartBudget: { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 },
};

function validatePhaseOrder(cards: PhaseCard[]): string[] {
  if (!cards.length) return ["At least one phase is required."];
  const errors: string[] = [];
  const byKey = new Map<string, number>();
  cards.forEach((card, index) => {
    if (!card.phaseKey.trim()) errors.push(`Phase ${index + 1} is missing a key.`);
    if (byKey.has(card.phaseKey)) errors.push(`Duplicate phase key: ${card.phaseKey}`);
    byKey.set(card.phaseKey, index);
    if (card.orderingConstraints.mustBeFirst && index !== 0) {
      errors.push(`${card.name} must be first.`);
    }
    if (card.orderingConstraints.mustBeLast && index !== cards.length - 1) {
      errors.push(`${card.name} must be last.`);
    }
  });
  cards.forEach((card, index) => {
    (card.orderingConstraints.mustFollow ?? []).forEach((dep) => {
      const depIndex = byKey.get(dep);
      if (depIndex == null) errors.push(`${card.name} requires missing predecessor ${dep}.`);
      if (depIndex != null && depIndex >= index) errors.push(`${card.name} must follow ${dep}.`);
    });
    (card.orderingConstraints.mustPrecede ?? []).forEach((dep) => {
      const depIndex = byKey.get(dep);
      if (depIndex == null) errors.push(`${card.name} requires missing successor ${dep}.`);
      if (depIndex != null && depIndex <= index) errors.push(`${card.name} must precede ${dep}.`);
    });
  });
  return [...new Set(errors)];
}

function preflightSeverityHex(severity: MissionPreflightChecklistItem["severity"]): string {
  if (severity === "pass") return "#22C55E";
  if (severity === "warning") return "#F59E0B";
  return "#EF4444";
}

function formatPreflightDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "n/a";
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  return `${mins}m`;
}

const DLG_INPUT_STYLE: React.CSSProperties = { background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 };
const DLG_LABEL_STYLE: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

function CreateMissionDialogInner({
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
  const [selectedProfileId, setSelectedProfileId] = useState<string>("standard");
  const [attachments, setAttachments] = useState<string[]>([]);
  // advanced options always visible (no collapsible)
  const [phaseProfiles, setPhaseProfiles] = useState<PhaseProfile[]>([]);
  const [phaseLoading, setPhaseLoading] = useState(false);
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Record<string, boolean>>({});
  const [disabledPhases, setDisabledPhases] = useState<Record<string, boolean>>({});
  const [availableModelIds, setAvailableModelIds] = useState<string[] | undefined>(undefined);
  const [aiDetectedAuth, setAiDetectedAuth] = useState<import("../../../shared/types").AiDetectedAuth[] | null>(null);
  const [currentUsage, setCurrentUsage] = useState<AggregatedUsageStats | null>(null);
  const [launchStage, setLaunchStage] = useState<"config" | "preflight">("config");
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [preflightResult, setPreflightResult] = useState<MissionPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateDraft>({
    title: "",
    prompt: "",
    laneId: "",
    priority: "normal",
    executionPolicy: defaultExecutionPolicy,
    prStrategy: { kind: "integration", targetBranch: "main", draft: true },
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    phaseProfileId: null,
    phaseOverride: [],
  });

  useEffect(() => {
    if (!open) return;
    setSelectedProfileId("standard");
    setAttachments([]);
    setPhaseError(null);
    setExpandedPhases({});
    setDisabledPhases({});
    setLaunchStage("config");
    setPreflightRunning(false);
    setPreflightResult(null);
    setPreflightError(null);
    setDraft({
      title: "",
      prompt: "",
      laneId: "",
      priority: "normal",
      executionPolicy: defaultExecutionPolicy,
      prStrategy: { kind: "integration", targetBranch: "main", draft: true },
      modelConfig: { ...DEFAULT_MODEL_CONFIG },
      phaseProfileId: null,
      phaseOverride: [],
    });

    let cancelled = false;
    setPhaseLoading(true);
    void window.ade.missions
      .listPhaseProfiles({})
      .then((profiles) => {
        if (cancelled) return;
        setPhaseProfiles(profiles);
        const defaultProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
        if (!defaultProfile) {
          setDraft((prev) => ({ ...prev, phaseProfileId: null, phaseOverride: [] }));
          return;
        }
        setDraft((prev) => ({
          ...prev,
          phaseProfileId: defaultProfile.id,
          phaseOverride: defaultProfile.phases.map((phase, index) => ({ ...phase, position: index }))
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setPhaseProfiles([]);
        setPhaseError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPhaseLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, defaultExecutionPolicy]);

  // Fetch detected auth to determine which models are actually available + current usage.
  // Deferred: load AFTER the dialog is painted so the UI doesn't freeze on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    // Use requestAnimationFrame to yield to the renderer before firing heavy IPC
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      void window.ade.ai.getStatus().then((status) => {
        if (cancelled) return;
        const ids: string[] = [];
        const auth = status.detectedAuth ?? [];
        setAiDetectedAuth(auth);
        for (const a of auth) {
          if (!a.authenticated) continue;
          if (a.type === "cli-subscription" && a.cli) {
            const familyMap: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };
            const family = familyMap[a.cli];
            if (family) {
              for (const m of MODEL_REGISTRY) {
                if (m.family === family && !m.deprecated) ids.push(m.id);
              }
            }
          }
          if (a.type === "api-key" && a.provider) {
            for (const m of MODEL_REGISTRY) {
              if (m.family === a.provider && !m.deprecated) ids.push(m.id);
            }
          }
        }
        setAvailableModelIds(ids.length > 0 ? [...new Set(ids)] : undefined);
      }).catch(() => {
        if (!cancelled) setAvailableModelIds(undefined);
      });

      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      void window.ade.orchestrator.getAggregatedUsage({ since: fiveHoursAgo }).then((stats) => {
        if (!cancelled) setCurrentUsage(stats);
      }).catch(() => {
        if (!cancelled) setCurrentUsage(null);
      });
    });

    return () => { cancelled = true; cancelAnimationFrame(rafId); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (launchStage !== "preflight") return;
    setLaunchStage("config");
    setPreflightResult(null);
    setPreflightError(null);
  }, [draft, open, launchStage]);

  // Compute active phases (exclude user-disabled ones) and reindex positions
  const activePhases = useMemo(() => {
    return draft.phaseOverride
      .filter((phase) => !disabledPhases[phase.id])
      .map((phase, index) => ({ ...phase, position: index }));
  }, [draft.phaseOverride, disabledPhases]);

  const phaseValidationErrors = useMemo(() => validatePhaseOrder(activePhases), [activePhases]);

  const billingContext = useMemo(() => {
    if (!aiDetectedAuth?.length) return undefined;
    const subProviders: string[] = [];
    const apiProviders: string[] = [];
    for (const auth of aiDetectedAuth) {
      if (!auth.authenticated) continue;
      if (auth.type === "cli-subscription" && auth.cli) {
        const familyMap: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };
        if (familyMap[auth.cli]) subProviders.push(familyMap[auth.cli]!);
      }
      if (auth.type === "api-key" && auth.provider) {
        apiProviders.push(auth.provider);
      }
    }
    return {
      hasSubscription: subProviders.length > 0,
      subscriptionProviders: [...new Set(subProviders)],
      apiProviders: [...new Set(apiProviders)],
    };
  }, [aiDetectedAuth]);

  const handleLaunch = useCallback(() => {
    if (!draft.prompt.trim()) return;
    if (validatePhaseOrder(activePhases).length > 0) return;
    if (launchStage === "preflight") {
      if (!preflightResult?.canLaunch) return;
      onLaunch({ ...draft, phaseOverride: activePhases });
      return;
    }
    setPreflightError(null);
    setPreflightRunning(true);
    void window.ade.missions.preflight({
      launch: {
        title: draft.title.trim() || undefined,
        prompt: draft.prompt.trim(),
        laneId: draft.laneId.trim() || undefined,
        priority: draft.priority,
        executionPolicy: { ...draft.executionPolicy, prStrategy: draft.prStrategy },
        modelConfig: {
          ...draft.modelConfig,
          decisionTimeoutCapHours: draft.modelConfig.decisionTimeoutCapHours ?? 24,
        },
        phaseProfileId: draft.phaseProfileId,
        phaseOverride: activePhases,
      }
    })
      .then((result) => {
        setPreflightResult(result);
        setLaunchStage("preflight");
      })
      .catch((err) => {
        setPreflightError(err instanceof Error ? err.message : String(err));
        setPreflightResult(null);
      })
      .finally(() => {
        setPreflightRunning(false);
      });
  }, [draft, activePhases, launchStage, onLaunch, preflightResult?.canLaunch]);

  if (!open) return null;

  const dlgInputStyle = DLG_INPUT_STYLE;
  const dlgLabelStyle = DLG_LABEL_STYLE;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
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
          {/* 1. Mission Prompt */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>
              <ChatCircle size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              MISSION PROMPT *
            </span>
            <MissionPromptInput
              value={draft.prompt}
              onChange={(v) => setDraft((p) => ({ ...p, prompt: v }))}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
            />
          </div>

          {/* 2. Title */}
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

          {/* 3. Base Lane */}
          <label className="block space-y-1">
            <span style={dlgLabelStyle}>
              <GitBranch size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              BASE LANE
            </span>
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

          <div style={{ borderTop: `1px solid ${COLORS.border}`, margin: "4px 0" }} />

          {/* 4. Profile */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>
              <CircleHalf size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              PROFILE
            </span>
            <ModelProfileSelector
              selectedProfileId={selectedProfileId}
              onSelect={(profile) => {
                if (profile) {
                  setSelectedProfileId(profile.id);
                  setDraft((p) => ({
                    ...p,
                    modelConfig: {
                      profileId: profile.id,
                      orchestratorModel: profile.orchestratorModel,
                      decisionTimeoutCapHours: profile.decisionTimeoutCapHours ?? 24,
                      intelligenceConfig: profile.intelligenceConfig,
                      smartBudget: profile.smartBudget ?? p.modelConfig.smartBudget,
                    },
                  }));
                } else {
                  setSelectedProfileId("custom");
                }
              }}
            />
          </div>

          {/* 5. Orchestrator Model */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>
              <Robot size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              ORCHESTRATOR MODEL
            </span>
            <ModelSelector
              value={draft.modelConfig.orchestratorModel}
              onChange={(config) => {
                setSelectedProfileId("custom");
                setDraft((p) => ({
                  ...p,
                  modelConfig: { ...p.modelConfig, profileId: undefined, orchestratorModel: config },
                }));
              }}
              showRecommendedBadge
              availableModelIds={availableModelIds}
            />
          </div>

          <div style={{ borderTop: `1px solid ${COLORS.border}`, margin: "4px 0" }} />

          {/* 6. Additional Options */}
          <div className="space-y-3">
                {/* Decision Timeout Cap */}
                <label className="block space-y-1">
                  <span style={dlgLabelStyle}>DECISION TIMEOUT CAP</span>
                  <select
                    value={draft.modelConfig.decisionTimeoutCapHours ?? 24}
                    onChange={(e) => {
                      setSelectedProfileId("custom");
                      setDraft((p) => ({
                        ...p,
                        modelConfig: {
                          ...p.modelConfig,
                          profileId: undefined,
                          decisionTimeoutCapHours: Number(e.target.value) as OrchestratorDecisionTimeoutCapHours
                        }
                      }));
                    }}
                    className="h-8 w-full px-3 text-xs outline-none"
                    style={dlgInputStyle}
                  >
                    {DECISION_TIMEOUT_CAP_OPTIONS.map((hours) => (
                      <option key={hours} value={hours}>
                        {hours}h
                      </option>
                    ))}
                  </select>
                </label>

                {/* c. PR Strategy + Depth */}
                <div className="space-y-1">
                  <span style={dlgLabelStyle}>
                    <GitBranch size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
                    PR STRATEGY
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {(["integration", "per-lane", "queue", "manual"] as const).map((kind) => {
                      const labels: Record<string, string> = {
                        integration: "INTEGRATION PR",
                        "per-lane": "PER-LANE PRS",
                        queue: "QUEUE",
                        manual: "MANUAL",
                      };
                      const strategyColors: Record<string, string> = {
                        integration: "#8B5CF6",
                        "per-lane": "#3B82F6",
                        queue: "#F59E0B",
                        manual: "#71717A",
                      };
                      const accentColor = strategyColors[kind];
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => {
                            if (kind === "manual") {
                              setDraft((p) => ({ ...p, prStrategy: { kind: "manual" as const } }));
                            } else if (kind === "queue") {
                              setDraft((p) => ({
                                ...p,
                                prStrategy: {
                                  kind: "queue" as const,
                                  targetBranch: (p.prStrategy.kind !== "manual" && "targetBranch" in p.prStrategy ? p.prStrategy.targetBranch : undefined) ?? "main",
                                  draft: p.prStrategy.kind !== "manual" && "draft" in p.prStrategy ? p.prStrategy.draft : true,
                                  autoRebase: true,
                                  ciGating: true,
                                }
                              }));
                            } else {
                              const prevTarget = (p: CreateDraft) => p.prStrategy.kind !== "manual" && "targetBranch" in p.prStrategy ? p.prStrategy.targetBranch : "main";
                              const prevDraft = (p: CreateDraft) => p.prStrategy.kind !== "manual" && "draft" in p.prStrategy ? p.prStrategy.draft : true;
                              setDraft((p) => ({
                                ...p,
                                prStrategy: { kind, targetBranch: prevTarget(p) ?? "main", draft: prevDraft(p) ?? true }
                              }));
                            }
                          }}
                          className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
                          style={draft.prStrategy.kind === kind
                            ? { background: `${accentColor}18`, color: accentColor, border: `1px solid ${accentColor}30`, fontFamily: MONO_FONT }
                            : { background: COLORS.recessedBg, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, fontFamily: MONO_FONT }
                          }
                        >
                          {labels[kind]}
                        </button>
                      );
                    })}
                  </div>
                  {draft.prStrategy.kind !== "manual" && (
                    <div className="flex items-center gap-3 mt-1">
                      <label className="flex items-center gap-1.5 text-[10px]">
                        <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Target branch</span>
                        <input
                          value={"targetBranch" in draft.prStrategy ? draft.prStrategy.targetBranch ?? "main" : "main"}
                          onChange={(e) => {
                            const branch = e.target.value;
                            setDraft((p) => ({
                              ...p,
                              prStrategy: { ...p.prStrategy, targetBranch: branch } as PrStrategy
                            }));
                          }}
                          className="h-6 w-24 px-2 text-xs outline-none"
                          style={dlgInputStyle}
                        />
                      </label>
                      {/* Draft PR checkbox: show for integration (only when depth = open-and-comment), always for per-lane, always for queue */}
                      {(draft.prStrategy.kind === "per-lane" || draft.prStrategy.kind === "queue" || (draft.prStrategy.kind === "integration" && draft.prStrategy.prDepth === "open-and-comment")) && (
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={"draft" in draft.prStrategy ? draft.prStrategy.draft ?? true : true}
                            onChange={(e) => {
                              const isDraft = e.target.checked;
                              setDraft((p) => ({
                                ...p,
                                prStrategy: { ...p.prStrategy, draft: isDraft } as PrStrategy
                              }));
                            }}
                          />
                          Draft PR
                        </label>
                      )}
                    </div>
                  )}
                  {/* Queue-specific options */}
                  {draft.prStrategy.kind === "queue" && (
                    <div className="flex items-center gap-3 mt-1">
                      <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <input
                          type="checkbox"
                          checked={draft.prStrategy.autoRebase ?? true}
                          onChange={(e) => setDraft((p) => ({
                            ...p,
                            prStrategy: { ...p.prStrategy, autoRebase: e.target.checked } as PrStrategy
                          }))}
                        />
                        Auto-rebase
                      </label>
                      <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <input
                          type="checkbox"
                          checked={draft.prStrategy.ciGating ?? true}
                          onChange={(e) => setDraft((p) => ({
                            ...p,
                            prStrategy: { ...p.prStrategy, ciGating: e.target.checked } as PrStrategy
                          }))}
                        />
                        CI gating
                      </label>
                    </div>
                  )}
                  {/* PR Depth: only show for integration strategy */}
                  {draft.prStrategy.kind === "integration" && (
                    <div className="mt-2 space-y-1">
                      <span style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted }}>
                        PR DEPTH
                      </span>
                      <div className="flex flex-col gap-0.5">
                        {([
                          { value: "propose-only" as PrDepth, label: "PROPOSE ONLY", desc: "Create draft PRs, flag conflicts" },
                          { value: "resolve-conflicts" as PrDepth, label: "RESOLVE CONFLICTS", desc: "Also resolve conflicts with AI workers" },
                          { value: "open-and-comment" as PrDepth, label: "OPEN & COMMENT", desc: "Also open PRs and add review comments" },
                        ] as const).map((opt) => {
                          const currentDepth = draft.prStrategy.kind === "integration" ? (draft.prStrategy.prDepth ?? "resolve-conflicts") : "resolve-conflicts";
                          const isSelected = currentDepth === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => {
                                if (opt.value === "open-and-comment") {
                                  setDraft((p) => ({
                                    ...p,
                                    prStrategy: { ...p.prStrategy, prDepth: opt.value } as PrStrategy,
                                    executionPolicy: { ...p.executionPolicy, prReview: { ...p.executionPolicy.prReview, mode: "auto" as const } }
                                  }));
                                } else {
                                  setDraft((p) => ({
                                    ...p,
                                    prStrategy: { ...p.prStrategy, prDepth: opt.value } as PrStrategy
                                  }));
                                }
                              }}
                              className="flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                              style={{
                                background: isSelected ? `${COLORS.accent}18` : "transparent",
                                border: isSelected ? `1px solid ${COLORS.accent}30` : `1px solid ${COLORS.border}`,
                                fontFamily: MONO_FONT,
                              }}
                            >
                              <span
                                className="font-bold uppercase tracking-[1px]"
                                style={{ fontSize: 10, color: isSelected ? COLORS.accent : COLORS.textPrimary, minWidth: 130 }}
                              >
                                {opt.label}
                              </span>
                              <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                                {opt.desc}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ fontSize: 9, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 4 }}>
                        Orchestrator never merges — always requires human approval
                      </div>
                    </div>
                  )}
                </div>

                {/* d. Phase Configuration */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span style={dlgLabelStyle}>
                      <Hash size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
                      PHASE CONFIGURATION
                    </span>
                    <select
                      value={draft.phaseProfileId ?? ""}
                      onChange={(e) => {
                        const nextProfileId = e.target.value || null;
                        const profile = phaseProfiles.find((entry) => entry.id === nextProfileId) ?? null;
                        setDraft((prev) => ({
                          ...prev,
                          phaseProfileId: nextProfileId,
                          phaseOverride: profile
                            ? profile.phases.map((phase, index) => ({ ...phase, position: index }))
                            : prev.phaseOverride
                        }));
                      }}
                      className="h-7 w-[220px] px-2 text-[10px] outline-none"
                      style={dlgInputStyle}
                      disabled={phaseLoading || phaseProfiles.length === 0}
                    >
                      <option value="">Select profile</option>
                      {phaseProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.isBuiltIn ? "\u25CF " : ""}{profile.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      style={outlineButton()}
                      onClick={() => {
                        const now = new Date().toISOString();
                        setDraft((prev) => ({
                          ...prev,
                          phaseProfileId: prev.phaseProfileId,
                          phaseOverride: [
                            ...prev.phaseOverride,
                            {
                              id: `custom:${Date.now()}`,
                              phaseKey: `custom_${prev.phaseOverride.length + 1}`,
                              name: `Custom Phase ${prev.phaseOverride.length + 1}`,
                              description: "",
                              instructions: "",
                              model: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
                              budget: {},
                              orderingConstraints: {},
                              askQuestions: { enabled: false, mode: "never" },
                              validationGate: { tier: "self", required: false },
                              isBuiltIn: false,
                              isCustom: true,
                              position: prev.phaseOverride.length,
                              createdAt: now,
                              updatedAt: now
                            }
                          ]
                        }));
                      }}
                    >
                      <Plus size={12} weight="bold" />
                      ADD CUSTOM PHASE
                    </button>
                    <button
                      type="button"
                      style={outlineButton()}
                      disabled={draft.phaseOverride.length === 0}
                      onClick={async () => {
                        const profileName = window.prompt("New phase profile name", "Custom Profile");
                        if (!profileName || !profileName.trim()) return;
                        try {
                          const saved = await window.ade.missions.savePhaseProfile({
                            profile: {
                              name: profileName.trim(),
                              description: "Saved from mission launch flow",
                              phases: draft.phaseOverride
                            }
                          });
                          setPhaseProfiles((prev) => [saved, ...prev.filter((entry) => entry.id !== saved.id)]);
                          setDraft((prev) => ({ ...prev, phaseProfileId: saved.id }));
                        } catch (err) {
                          setPhaseError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      SAVE AS PROFILE
                    </button>
                  </div>
                  {phaseLoading ? (
                    <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      Loading phase profiles...
                    </div>
                  ) : null}
                  {phaseError ? (
                    <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, color: COLORS.danger }}>
                      {phaseError}
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    {draft.phaseOverride.map((phase, index) => {
                      const expanded = expandedPhases[phase.id] === true;
                      const isDisabled = disabledPhases[phase.id] === true;
                      return (
                        <div
                          key={phase.id}
                          className="p-2"
                          style={{
                            background: isDisabled ? `${COLORS.recessedBg}80` : COLORS.recessedBg,
                            border: `1px solid ${isDisabled ? COLORS.border + "60" : COLORS.border}`,
                            opacity: isDisabled ? 0.5 : 1,
                            transition: "opacity 0.15s ease",
                          }}
                        >
                          <div className="flex items-center gap-2">
                            {/* Enable/disable toggle */}
                            <button
                              type="button"
                              onClick={() => setDisabledPhases((prev) => ({ ...prev, [phase.id]: !isDisabled }))}
                              title={isDisabled ? "Enable phase" : "Disable phase"}
                              style={{
                                width: 28,
                                height: 14,
                                background: isDisabled ? COLORS.border : "#22C55E",
                                border: "none",
                                borderRadius: 0,
                                cursor: "pointer",
                                position: "relative",
                                flexShrink: 0,
                                transition: "background 0.2s ease",
                              }}
                            >
                              <div
                                style={{
                                  position: "absolute",
                                  top: 2,
                                  left: isDisabled ? 2 : 14,
                                  width: 10,
                                  height: 10,
                                  background: isDisabled ? COLORS.textDim : COLORS.textPrimary,
                                  borderRadius: 0,
                                  transition: "left 0.2s ease",
                                }}
                              />
                            </button>
                            <span className="text-[10px] font-bold" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                              {index + 1}.
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[11px] font-semibold" style={{ color: isDisabled ? COLORS.textDim : COLORS.textPrimary }}>
                                {phase.name}
                                {isDisabled ? <span style={{ color: COLORS.textDim, fontWeight: 400 }}> (disabled)</span> : null}
                              </div>
                              <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                {phase.model.modelId} · {phase.validationGate.tier}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="px-1 text-[10px]"
                              style={{ color: COLORS.textMuted }}
                              disabled={index === 0}
                              onClick={() => {
                                if (index === 0) return;
                                setDraft((prev) => {
                                  const next = [...prev.phaseOverride];
                                  const moved = next[index];
                                  if (!moved) return prev;
                                  next.splice(index, 1);
                                  next.splice(index - 1, 0, moved);
                                  return {
                                    ...prev,
                                    phaseOverride: next.map((entry, pos) => ({ ...entry, position: pos }))
                                  };
                                });
                              }}
                              title="Move up"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="px-1 text-[10px]"
                              style={{ color: COLORS.textMuted }}
                              disabled={index === draft.phaseOverride.length - 1}
                              onClick={() => {
                                if (index >= draft.phaseOverride.length - 1) return;
                                setDraft((prev) => {
                                  const next = [...prev.phaseOverride];
                                  const moved = next[index];
                                  if (!moved) return prev;
                                  next.splice(index, 1);
                                  next.splice(index + 1, 0, moved);
                                  return {
                                    ...prev,
                                    phaseOverride: next.map((entry, pos) => ({ ...entry, position: pos }))
                                  };
                                });
                              }}
                              title="Move down"
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="px-2 text-[10px] font-bold uppercase tracking-[1px]"
                              style={outlineButton()}
                              onClick={() => setExpandedPhases((prev) => ({ ...prev, [phase.id]: !expanded }))}
                              disabled={isDisabled}
                            >
                              {expanded ? "HIDE" : "CONFIGURE"}
                            </button>
                            {/* Delete button for custom phases */}
                            {phase.isCustom ? (
                              <button
                                type="button"
                                className="px-1"
                                style={{ color: COLORS.danger, background: "none", border: "none", cursor: "pointer" }}
                                onClick={() => {
                                  setDraft((prev) => ({
                                    ...prev,
                                    phaseOverride: prev.phaseOverride
                                      .filter((entry) => entry.id !== phase.id)
                                      .map((entry, pos) => ({ ...entry, position: pos }))
                                  }));
                                  setExpandedPhases((prev) => { const n = { ...prev }; delete n[phase.id]; return n; });
                                  setDisabledPhases((prev) => { const n = { ...prev }; delete n[phase.id]; return n; });
                                }}
                                title="Remove custom phase"
                              >
                                <X size={12} weight="bold" />
                              </button>
                            ) : null}
                          </div>
                          {expanded && !isDisabled ? (
                            <div className="mt-2 space-y-2">
                              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                <label className="space-y-1 text-[10px]">
                                  <span style={dlgLabelStyle}>PHASE NAME</span>
                                  <input
                                    value={phase.name}
                                    onChange={(e) => {
                                      const value = e.target.value;
                                      setDraft((prev) => ({
                                        ...prev,
                                        phaseOverride: prev.phaseOverride.map((entry) =>
                                          entry.id === phase.id ? { ...entry, name: value } : entry
                                        )
                                      }));
                                    }}
                                    className="h-7 w-full px-2 outline-none"
                                    style={dlgInputStyle}
                                  />
                                </label>
                                <div className="space-y-1 text-[10px]">
                                  <span style={dlgLabelStyle}>WORKER MODEL</span>
                                  <ModelSelector
                                    value={phase.model}
                                    onChange={(config) => {
                                      setDraft((prev) => ({
                                        ...prev,
                                        phaseOverride: prev.phaseOverride.map((entry) =>
                                          entry.id === phase.id ? { ...entry, model: config } : entry
                                        )
                                      }));
                                    }}
                                    compact
                                    availableModelIds={availableModelIds}
                                  />
                                </div>
                              </div>
                              <label className="space-y-1 text-[10px]">
                                <span style={dlgLabelStyle}>INSTRUCTIONS</span>
                                <textarea
                                  value={phase.instructions}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setDraft((prev) => ({
                                      ...prev,
                                      phaseOverride: prev.phaseOverride.map((entry) =>
                                        entry.id === phase.id ? { ...entry, instructions: value } : entry
                                      )
                                    }));
                                  }}
                                  className="w-full px-2 py-1.5 outline-none"
                                  rows={3}
                                  style={dlgInputStyle}
                                />
                              </label>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {phaseValidationErrors.length > 0 ? (
                    <div className="space-y-1 px-2 py-1.5" style={{ background: `${COLORS.warning}15`, border: `1px solid ${COLORS.warning}30`, color: COLORS.warning }}>
                      {phaseValidationErrors.map((entry) => (
                        <div key={entry} className="text-[10px]" style={{ fontFamily: MONO_FONT }}>
                          {entry}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                {/* e. Smart Token Budget */}
                <SmartBudgetPanel
                  value={draft.modelConfig.smartBudget ?? { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 }}
                  onChange={(config) => setDraft((p) => ({
                    ...p,
                    modelConfig: { ...p.modelConfig, smartBudget: config }
                  }))}
                  currentSpend={currentUsage ? {
                    fiveHourUsd: currentUsage.summary.totalCostEstimateUsd,
                    weeklyUsd: currentUsage.summary.totalCostEstimateUsd, // 5hr window data used for both until weekly is wired
                  } : null}
                  modelUsage={currentUsage?.byModel?.length ? Object.fromEntries(
                    currentUsage.byModel.map((m) => [m.model, {
                      inputTokens: m.inputTokens,
                      outputTokens: m.outputTokens,
                      costUsd: m.costEstimateUsd,
                      sessions: m.sessions,
                    }])
                  ) : undefined}
                  billingContext={billingContext}
                />

                {/* f. Allow completion with risk */}
                <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  <input
                    type="checkbox"
                    checked={draft.executionPolicy.completion?.allowCompletionWithRisk ?? false}
                    onChange={(e) => setDraft((p) => ({
                      ...p,
                      executionPolicy: {
                        ...p.executionPolicy,
                        completion: { ...p.executionPolicy.completion, allowCompletionWithRisk: e.target.checked }
                      }
                    }))}
                  />
                  ALLOW COMPLETION WITH RISK
                </label>

                {/* g. Team Runtime */}
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <input
                      type="checkbox"
                      checked={draft.executionPolicy.teamRuntime?.enabled ?? false}
                      onChange={(e) => setDraft((p) => ({
                        ...p,
                        executionPolicy: {
                          ...p.executionPolicy,
                          teamRuntime: {
                            enabled: e.target.checked,
                            targetProvider: p.executionPolicy.teamRuntime?.targetProvider ?? "auto",
                            teammateCount: p.executionPolicy.teamRuntime?.teammateCount ?? 2,
                          }
                        }
                      }))}
                    />
                    ENABLE TEAM RUNTIME
                  </label>
                  {draft.executionPolicy.teamRuntime?.enabled && (
                    <div className="flex items-center gap-3 pl-5">
                      <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>TEAMMATES</span>
                        <input
                          type="number"
                          min={1}
                          max={8}
                          value={draft.executionPolicy.teamRuntime?.teammateCount ?? 2}
                          onChange={(e) => setDraft((p) => ({
                            ...p,
                            executionPolicy: {
                              ...p.executionPolicy,
                              teamRuntime: {
                                ...p.executionPolicy.teamRuntime!,
                                teammateCount: Math.max(1, Math.min(8, Number(e.target.value) || 2)),
                              }
                            }
                          }))}
                          className="h-6 w-12 px-1 text-xs text-center outline-none"
                          style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 }}
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>PROVIDER</span>
                        <select
                          value={draft.executionPolicy.teamRuntime?.targetProvider ?? "auto"}
                          onChange={(e) => setDraft((p) => ({
                            ...p,
                            executionPolicy: {
                              ...p.executionPolicy,
                              teamRuntime: {
                                ...p.executionPolicy.teamRuntime!,
                                targetProvider: e.target.value as "claude" | "codex" | "auto",
                              }
                            }
                          }))}
                          className="h-6 px-1 text-xs outline-none"
                          style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 }}
                        >
                          <option value="auto">Auto</option>
                          <option value="claude">Claude</option>
                          <option value="codex">Codex</option>
                        </select>
                      </label>
                    </div>
                  )}
                </div>
          </div>

          {(preflightRunning || preflightResult || preflightError) ? (
            <div className="space-y-2 p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between gap-2">
                <span style={dlgLabelStyle}>PRE-FLIGHT CHECKLIST</span>
                {preflightRunning ? (
                  <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <SpinnerGap size={12} className="animate-spin" />
                    Checking...
                  </span>
                ) : null}
              </div>

              {preflightError ? (
                <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, color: COLORS.danger }}>
                  {preflightError}
                </div>
              ) : null}

              {preflightResult ? (
                <div className="space-y-1.5">
                  {preflightResult.checklist.map((item) => {
                    const accent = preflightSeverityHex(item.severity);
                    return (
                      <div key={item.id} className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${accent}45` }}>
                        <div className="flex items-start gap-2">
                          {item.severity === "pass" ? (
                            <CheckCircle size={14} weight="fill" style={{ color: accent, marginTop: 1 }} />
                          ) : item.severity === "warning" ? (
                            <Warning size={14} weight="fill" style={{ color: accent, marginTop: 1 }} />
                          ) : (
                            <X size={14} weight="bold" style={{ color: accent, marginTop: 1 }} />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: accent, fontFamily: MONO_FONT }}>
                              {item.title}
                            </div>
                            <div className="mt-0.5 text-[11px]" style={{ color: COLORS.textPrimary }}>
                              {item.summary}
                            </div>
                            {item.details.length > 0 ? (
                              <ul className="mt-1 space-y-0.5 pl-4 text-[10px]">
                                {item.details.map((detail, idx) => (
                                  <li key={`${item.id}:${idx}`} style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    • {detail}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {item.fixHint ? (
                              <div className="mt-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                Fix: {item.fixHint}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {preflightResult.budgetEstimate ? (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-3 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>Mode: {preflightResult.budgetEstimate.mode}</span>
                        <span>Est. Cost: {preflightResult.budgetEstimate.estimatedCostUsd != null ? `$${preflightResult.budgetEstimate.estimatedCostUsd.toFixed(2)}` : "n/a"}</span>
                        <span>Est. Time: {formatPreflightDuration(preflightResult.budgetEstimate.estimatedTimeMs)}</span>
                        <span>Hard fails: {preflightResult.hardFailures}</span>
                        <span>Warnings: {preflightResult.warnings}</span>
                      </div>
                      {(() => {
                        const rows = preflightResult.budgetEstimate?.perPhase ?? [];
                        const totalCost = rows.reduce((sum, phase) => sum + (phase.estimatedCostUsd ?? 0), 0);
                        if (!rows.length || totalCost <= 0) return null;
                        return (
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                              Phase Cost Allocation
                            </div>
                            <div className="flex h-2 w-full overflow-hidden rounded-sm" style={{ border: `1px solid ${COLORS.border}` }}>
                              {rows.map((phase, index) => {
                                const cost = Math.max(0, phase.estimatedCostUsd ?? 0);
                                const pct = Math.max(0, Math.min(100, (cost / totalCost) * 100));
                                const hue = (index * 63) % 360;
                                return (
                                  <div
                                    key={`phase-budget:${phase.phaseKey}`}
                                    title={`${phase.phaseName}: $${cost.toFixed(2)} (${pct.toFixed(1)}%)`}
                                    style={{ width: `${pct}%`, background: `hsl(${hue} 75% 52%)` }}
                                  />
                                );
                              })}
                            </div>
                            <div className="grid grid-cols-1 gap-0.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                              {rows.map((phase, index) => {
                                const cost = Math.max(0, phase.estimatedCostUsd ?? 0);
                                const pct = Math.max(0, Math.min(100, (cost / totalCost) * 100));
                                const hue = (index * 63) % 360;
                                return (
                                  <div key={`phase-budget-label:${phase.phaseKey}`} className="flex items-center justify-between gap-2">
                                    <span className="inline-flex items-center gap-1 min-w-0 truncate">
                                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: `hsl(${hue} 75% 52%)` }} />
                                      <span className="truncate">{phase.phaseName}</span>
                                    </span>
                                    <span>{`$${cost.toFixed(2)} (${pct.toFixed(0)}%)`}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          {launchStage === "preflight" ? (
            <>
              <button
                style={outlineButton()}
                onClick={() => {
                  setLaunchStage("config");
                  setPreflightError(null);
                }}
                disabled={busy || preflightRunning}
              >
                <CaretLeft size={12} weight="bold" />
                BACK
              </button>
              <button
                style={outlineButton()}
                onClick={() => {
                  setLaunchStage("config");
                  setPreflightResult(null);
                  setPreflightError(null);
                }}
                disabled={busy || preflightRunning}
              >
                EDIT CONFIG
              </button>
              <button
                style={primaryButton()}
                onClick={handleLaunch}
                disabled={busy || preflightRunning || !preflightResult?.canLaunch}
              >
                {busy ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                LAUNCH MISSION
              </button>
            </>
          ) : (
            <>
              <button style={outlineButton()} onClick={onClose} disabled={busy || preflightRunning}>CANCEL</button>
              <button
                style={primaryButton()}
                onClick={handleLaunch}
                disabled={busy || preflightRunning || !draft.prompt.trim() || phaseValidationErrors.length > 0}
              >
                {preflightRunning ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
                RUN PRE-FLIGHT
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

const CreateMissionDialog = React.memo(CreateMissionDialogInner);

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
  const [phaseProfiles, setPhaseProfiles] = useState<PhaseProfile[]>([]);
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [phaseNotice, setPhaseNotice] = useState<string | null>(null);
  const [phaseError, setPhaseError] = useState<string | null>(null);

  const refreshPhaseProfiles = useCallback(async () => {
    try {
      const profiles = await window.ade.missions.listPhaseProfiles({});
      setPhaseProfiles(profiles);
      setPhaseError(null);
    } catch (err) {
      setPhaseError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setPhaseNotice(null);
    void refreshPhaseProfiles();
  }, [open, refreshPhaseProfiles]);

  if (!open) return null;

  const settingsInputStyle: React.CSSProperties = { height: 32, width: "100%", background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, padding: "0 8px", fontSize: 12, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0, outline: "none" };
  const settingsLabelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
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
            <div className="mt-3">
              <div className="px-2 py-1.5 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Execution policy is derived from your Phase Profiles below. Customize phases to control planning, testing, validation, and review behavior.
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="text-xs">
                <div style={settingsLabelStyle}>DEFAULT PLANNER MODEL</div>
                <div className="mt-1">
                  <select
                    style={settingsInputStyle}
                    value={draft.defaultPlannerProvider}
                    onChange={(e) => onDraftChange({ defaultPlannerProvider: e.target.value as PlannerProvider })}
                  >
                    <option value="auto">Auto</option>
                    {([...new Set(MODEL_REGISTRY.map((m) => m.family))] as ProviderFamily[]).map((family) => {
                      const familyModels = MODEL_REGISTRY.filter((m) => m.family === family && !m.deprecated);
                      if (!familyModels.length) return null;
                      return (
                        <optgroup key={family} label={MODEL_FAMILIES[family]?.displayName ?? family}>
                          {familyModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.displayName}</option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
              </label>
              <label className="text-xs">
                <div style={settingsLabelStyle}>TEAMMATE PLAN MODE</div>
                <select
                  style={settingsInputStyle}
                  value={draft.teammatePlanMode}
                  onChange={(e) => onDraftChange({ teammatePlanMode: toTeammatePlanMode(e.target.value) })}
                >
                  <option value="auto">Auto</option>
                  <option value="off">Off</option>
                  <option value="required">Required</option>
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

          <div className="p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                PHASE PROFILES
              </div>
              <div className="flex items-center gap-2">
                <button
                  style={outlineButton()}
                  disabled={phaseBusy}
                  onClick={async () => {
                    const name = window.prompt("New phase profile name", "Custom Profile");
                    if (!name || !name.trim()) return;
                    const fallback = phaseProfiles.find((profile) => profile.isDefault) ?? phaseProfiles[0] ?? null;
                    const phases = fallback?.phases ?? [];
                    if (!phases.length) return;
                    setPhaseBusy(true);
                    try {
                      await window.ade.missions.savePhaseProfile({
                        profile: {
                          name: name.trim(),
                          description: "Created from Mission Settings",
                          phases
                        }
                      });
                      await refreshPhaseProfiles();
                      setPhaseNotice("Phase profile created.");
                    } catch (err) {
                      setPhaseError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setPhaseBusy(false);
                    }
                  }}
                >
                  + CREATE
                </button>
                <button
                  style={outlineButton()}
                  disabled={phaseBusy}
                  onClick={async () => {
                    const filePath = window.prompt("Import profile JSON path");
                    if (!filePath || !filePath.trim()) return;
                    setPhaseBusy(true);
                    try {
                      await window.ade.missions.importPhaseProfile({ filePath: filePath.trim() });
                      await refreshPhaseProfiles();
                      setPhaseNotice("Profile imported.");
                    } catch (err) {
                      setPhaseError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setPhaseBusy(false);
                    }
                  }}
                >
                  IMPORT
                </button>
              </div>
            </div>

            {phaseNotice ? (
              <div className="mt-2 px-2 py-1.5 text-[10px]" style={{ border: `1px solid ${COLORS.success}30`, background: `${COLORS.success}15`, color: COLORS.success }}>
                {phaseNotice}
              </div>
            ) : null}
            {phaseError ? (
              <div className="mt-2 px-2 py-1.5 text-[10px]" style={{ border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}15`, color: COLORS.danger }}>
                {phaseError}
              </div>
            ) : null}

            <div className="mt-3 space-y-2">
              {phaseProfiles.map((profile) => (
                <div key={profile.id} className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold" style={{ color: COLORS.textPrimary }}>
                        {profile.isBuiltIn ? "\u25CF " : ""}{profile.name}
                      </div>
                      <div className="truncate text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        {profile.phases.map((phase) => phase.name).join(" \u2192 ")}
                      </div>
                    </div>
                    <button
                      style={outlineButton()}
                      disabled={phaseBusy}
                      onClick={async () => {
                        setPhaseBusy(true);
                        try {
                          await window.ade.missions.clonePhaseProfile({ profileId: profile.id });
                          await refreshPhaseProfiles();
                          setPhaseNotice("Profile cloned.");
                        } catch (err) {
                          setPhaseError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setPhaseBusy(false);
                        }
                      }}
                    >
                      CLONE
                    </button>
                    <button
                      style={outlineButton()}
                      disabled={phaseBusy}
                      onClick={async () => {
                        setPhaseBusy(true);
                        try {
                          const exported = await window.ade.missions.exportPhaseProfile({ profileId: profile.id });
                          setPhaseNotice(exported.savedPath ? `Exported: ${exported.savedPath}` : "Profile exported.");
                        } catch (err) {
                          setPhaseError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setPhaseBusy(false);
                        }
                      }}
                    >
                      EXPORT
                    </button>
                    {!profile.isBuiltIn ? (
                      <button
                        style={dangerButton()}
                        disabled={phaseBusy}
                        onClick={async () => {
                          if (!window.confirm(`Delete phase profile "${profile.name}"?`)) return;
                          setPhaseBusy(true);
                          try {
                            await window.ade.missions.deletePhaseProfile({ profileId: profile.id });
                            await refreshPhaseProfiles();
                            setPhaseNotice("Profile deleted.");
                          } catch (err) {
                            setPhaseError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setPhaseBusy(false);
                          }
                        }}
                      >
                        DELETE
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
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
  const mappedLanes = useMemo(() => lanes.map((l) => ({ id: l.id, name: l.name })), [lanes]);

  /* ── Core state ── */
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [selectedMission, setSelectedMission] = useState<MissionDetail | null>(null);
  const [runGraph, setRunGraph] = useState<OrchestratorRunGraph | null>(null);
  const [dashboard, setDashboard] = useState<MissionDashboardSnapshot | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const closeCreateDialog = useCallback(() => setCreateOpen(false), []);
  const [createBusy, setCreateBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [missionSettingsOpen, setMissionSettingsOpen] = useState(false);
  const [missionSettingsBusy, setMissionSettingsBusy] = useState(false);
  const [missionSettingsError, setMissionSettingsError] = useState<string | null>(null);
  const [missionSettingsNotice, setMissionSettingsNotice] = useState<string | null>(null);
  const [missionSettingsSnapshot, setMissionSettingsSnapshot] = useState<ProjectConfigSnapshot | null>(null);
  const [missionSettingsDraft, setMissionSettingsDraft] = useState<MissionSettingsDraft>(DEFAULT_MISSION_SETTINGS_DRAFT);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>("plan");
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


  /* ── Track original step count for dynamic step indicator ── */
  const [originalStepCount, setOriginalStepCount] = useState<number | null>(null);

  const hasActiveMission = selectedMission && !TERMINAL_MISSION_STATUSES.has(selectedMission.status);

  /* ── Stable array refs for memoized children ── */
  const runSteps = useMemo(() => runGraph?.steps ?? [], [runGraph?.steps]);
  const runAttempts = useMemo(() => runGraph?.attempts ?? [], [runGraph?.attempts]);
  const runClaims = useMemo(() => runGraph?.claims ?? [], [runGraph?.claims]);
  const runTimeline = useMemo(() => runGraph?.timeline ?? [], [runGraph?.timeline]);

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
    const effectivePolicySource = effectiveOrchestrator.defaultExecutionPolicy;
    const localPolicySource = localOrchestrator.defaultExecutionPolicy;
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
      teammatePlanMode: toTeammatePlanMode(
        readString(
          localOrchestrator.teammatePlanMode,
          effectiveOrchestrator.teammatePlanMode,
          "auto"
        )
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
        teammatePlanMode: toTeammatePlanMode(missionSettingsDraft.teammatePlanMode),
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
          return null;
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

  const loadDashboard = useCallback(async () => {
    try {
      const snapshot = await window.ade.missions.getDashboard();
      setDashboard(snapshot);
    } catch {
      // Best-effort dashboard hydration.
    }
  }, []);

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


  useEffect(() => {
    void refreshMissionList({ preserveSelection: true });
    void loadDashboard();
  }, [refreshMissionList, loadDashboard]);

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
      setSteeringLog([]);
      setChatJumpTarget(null);
      setOriginalStepCount(null);
      return;
    }
    setSteeringLog([]);
    setChatJumpTarget(null);
    void loadMissionDetail(selectedMissionId);
    void loadOrchestratorGraph(selectedMissionId);
  }, [selectedMissionId, loadMissionDetail, loadOrchestratorGraph]);


  // Debounced event-driven refresh: coalesce rapid-fire events into a single cycle
  const missionEventTimerRef = useRef<number | null>(null);
  const orchestratorEventTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsub = window.ade.missions.onEvent((payload) => {
      if (missionEventTimerRef.current !== null) window.clearTimeout(missionEventTimerRef.current);
      missionEventTimerRef.current = window.setTimeout(() => {
        missionEventTimerRef.current = null;
        void refreshMissionList({ preserveSelection: true, silent: true });
        void loadDashboard();
        if (payload.missionId && payload.missionId === selectedMissionId) {
          void loadMissionDetail(payload.missionId);
          scheduleOrchestratorGraphRefresh(payload.missionId, 120);
        }
      }, 300);
    });
    return () => {
      if (missionEventTimerRef.current !== null) window.clearTimeout(missionEventTimerRef.current);
      unsub();
    };
  }, [loadDashboard, loadMissionDetail, refreshMissionList, scheduleOrchestratorGraphRefresh, selectedMissionId]);

  useEffect(() => {
    const selectedRunId = runGraph?.run.id ?? null;
    const unsub = window.ade.orchestrator.onEvent((event) => {
      if (!selectedMissionId) return;
      if (selectedRunId && event.runId && event.runId !== selectedRunId) return;
      if (orchestratorEventTimerRef.current !== null) window.clearTimeout(orchestratorEventTimerRef.current);
      orchestratorEventTimerRef.current = window.setTimeout(() => {
        orchestratorEventTimerRef.current = null;
        scheduleOrchestratorGraphRefresh(selectedMissionId);
        void loadDashboard();
      }, 300);
    });
    return () => {
      if (orchestratorEventTimerRef.current !== null) window.clearTimeout(orchestratorEventTimerRef.current);
      unsub();
    };
  }, [loadDashboard, runGraph?.run.id, scheduleOrchestratorGraphRefresh, selectedMissionId]);

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
        modelConfig: {
          ...draft.modelConfig,
          decisionTimeoutCapHours: draft.modelConfig.decisionTimeoutCapHours ?? 24,
        },
        phaseProfileId: draft.phaseProfileId,
        phaseOverride: draft.phaseOverride,
        autostart: true,
        launchMode: "autopilot",
        autopilotExecutor: draft.executionPolicy.implementation?.model ?? "openai/gpt-5.3-codex"
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
        runAutopilotState.executor && runAutopilotState.executor.length > 0
          ? (runAutopilotState.executor as OrchestratorExecutorKind)
          : "unified";
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
    if (!selectedMission || !runGraph?.steps) return;
    const laneIds = [...new Set(runGraph.steps.map((s) => s.laneId).filter(Boolean))] as string[];
    if (!laneIds.length) return;
    if (!window.confirm(`Archive ${laneIds.length} lane(s) created by this mission?`)) return;
    setCleanupBusy(true);
    try {
      const result = await window.ade.orchestrator.cleanupTeamResources({
        missionId: selectedMission.id,
        runId: runGraph.run.id,
        cleanupLanes: true
      });
      await refreshLanes();
      if (result.laneErrors.length > 0) {
        setError(
          `Lane cleanup archived ${result.lanesArchived.length}/${result.laneIds.length}. `
          + `${result.laneErrors.length} lane(s) failed to archive.`
        );
      } else {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleanupBusy(false);
    }
  }, [runGraph, selectedMission, refreshLanes]);

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
    if (!selectedStepId) return null;
    if (!runGraph?.steps?.length) return null;
    return runGraph.steps.find((step) => step.id === selectedStepId) ?? null;
  }, [runGraph, selectedStepId]);

  const selectedStepAttempts = useMemo(() => {
    if (!selectedStep) return [];
    return attemptsByStep.get(selectedStep.id) ?? [];
  }, [attemptsByStep, selectedStep]);

  const missionPhaseRows = useMemo(() => {
    if (!selectedMission) return [] as Array<{ key: string; name: string; completed: number; total: number }>;
    const map = new Map<string, { key: string; name: string; completed: number; total: number }>();
    for (const step of selectedMission.steps) {
      const meta = isRecord(step.metadata) ? step.metadata : {};
      const key = typeof meta.phaseKey === "string" && meta.phaseKey.trim().length > 0 ? meta.phaseKey : "development";
      const name = typeof meta.phaseName === "string" && meta.phaseName.trim().length > 0 ? meta.phaseName : "Development";
      const row = map.get(key) ?? { key, name, completed: 0, total: 0 };
      row.total += 1;
      if (step.status === "succeeded" || step.status === "skipped" || step.status === "canceled") {
        row.completed += 1;
      }
      map.set(key, row);
    }
    return Array.from(map.values());
  }, [selectedMission]);

  // Reconcile selection only against displayed cards — no auto-reset mismatch
  useEffect(() => {
    const steps = runGraph?.steps ?? [];
    if (!steps.length) {
      if (selectedStepId !== null) setSelectedStepId(null);
      return;
    }
    // Only reset selection if the currently selected step no longer exists in the graph
    if (selectedStepId && steps.some((step) => step.id === selectedStepId)) return;
    const running = steps.find((step) => step.status === "running");
    setSelectedStepId((running ?? steps[0]).id);
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
            <MissionsHomeDashboard
              snapshot={dashboard}
              onNewMission={() => setCreateOpen(true)}
              onViewMission={(missionId) => setSelectedMissionId(missionId)}
            />
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
                    <span><Clock className="inline h-3 w-3 mr-0.5" /><ElapsedTime startedAt={selectedMission?.startedAt ?? null} endedAt={selectedMission && TERMINAL_MISSION_STATUSES.has(selectedMission.status) ? selectedMission.completedAt : null} /></span>
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
                  { key: "plan" as WorkspaceTab, num: "01", label: "PLAN", icon: SquaresFour },
                  { key: "work" as WorkspaceTab, num: "02", label: "WORK", icon: TerminalWindow },
                  { key: "dag" as WorkspaceTab, num: "03", label: "DAG", icon: Graph },
                  { key: "chat" as WorkspaceTab, num: "04", label: "CHAT", icon: ChatCircle },
                  { key: "activity" as WorkspaceTab, num: "05", label: "ACTIVITY", icon: Pulse },
                  { key: "details" as WorkspaceTab, num: "06", label: "DETAILS", icon: Lightning }
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

              {/* ── Original Mission Prompt ── */}
              {selectedMission?.prompt && (
                <div style={{
                  background: COLORS.cardBg,
                  border: `1px solid ${COLORS.border}`,
                  padding: '12px 16px',
                  margin: '12px 16px 0',
                }}>
                  <div style={{
                    ...LABEL_STYLE,
                    color: COLORS.textMuted,
                    marginBottom: 6,
                  }}>
                    MISSION PROMPT
                  </div>
                  <div style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: COLORS.textPrimary,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}>
                    {selectedMission.prompt}
                  </div>
                </div>
              )}

              {/* ── Completion Banner + Phase Progress + Execution Plan Preview ── */}
              {runGraph && (
                <div className="px-4 pt-3 space-y-2">
                  <CompletionBanner
                    status={runGraph.run.status}
                    evaluation={runGraph.completionEvaluation}
                  />
                  <PhaseProgressBar steps={runGraph.steps} />
                </div>
              )}

              {/* ── Tab Content ── */}
              <div className={cn(
                "flex-1 min-h-0",
                activeTab === "chat"
                  ? "flex flex-col overflow-hidden"
                  : activeTab === "work"
                    ? "flex flex-col overflow-hidden p-4"
                    : "overflow-auto p-4"
              )}>
                {activeTab === "plan" && (
                  <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                      <PlanTab
                        mission={selectedMission}
                        runGraph={runGraph}
                        attemptsByStep={attemptsByStep}
                        selectedStepId={selectedStepId}
                        onStepSelect={setSelectedStepId}
                      />
                    </div>
                    <StepDetailPanel
                      step={selectedStep}
                      attempts={selectedStepAttempts}
                      allSteps={runSteps}
                      claims={runClaims}
                      onOpenWorkerThread={(target) => {
                        setChatJumpTarget(target);
                        setActiveTab("chat");
                      }}
                    />
                  </div>
                )}

                {activeTab === "work" && (
                  <WorkTab runGraph={runGraph} />
                )}

                {activeTab === "dag" && (
                  <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
                    <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                    <OrchestratorDAG
                      steps={runSteps}
                      attempts={runAttempts}
                      claims={runClaims}
                      selectedStepId={selectedStepId}
                      onStepClick={setSelectedStepId}
                      runId={runGraph?.run?.id}
                    />
                    </div>
                    <StepDetailPanel
                      step={selectedStep}
                      attempts={selectedStepAttempts}
                      allSteps={runSteps}
                      claims={runClaims}
                      onOpenWorkerThread={(target) => {
                        setChatJumpTarget(target);
                        setActiveTab("chat");
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
                      initialTimeline={runTimeline}
                    />

                    {/* Run Narrative - shown when available */}
                    {Array.isArray(runGraph?.run?.metadata?.runNarrative) && (runGraph.run.metadata.runNarrative as Array<{ stepKey: string; summary: string; at: string }>).length > 0 && (
                      <div className="space-y-1.5 mt-4">
                        <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: COLORS.textMuted }}>
                          RUN NARRATIVE
                        </div>
                        <div className="space-y-1">
                          {(runGraph.run.metadata.runNarrative as Array<{ stepKey: string; summary: string; at: string }>).map((entry, i: number) => (
                            <div key={i} className="text-[11px] flex gap-2 items-start" style={{ fontFamily: MONO_FONT }}>
                              <span className="shrink-0" style={{ color: COLORS.accent }}>{entry.stepKey}</span>
                              <span style={{ color: COLORS.textSecondary }}>{entry.summary}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "chat" && selectedMissionId && (
                  <MissionChatV2
                    missionId={selectedMissionId}
                    runId={runGraph?.run.id ?? null}
                    jumpTarget={chatJumpTarget}
                    onJumpHandled={() => setChatJumpTarget(null)}
                  />
                )}

                {activeTab === "details" && selectedMission && (
                  <div className="space-y-3">
                    <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
                      <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        Phase Profile
                      </div>
                      <div className="mt-1 text-xs" style={{ color: COLORS.textPrimary }}>
                        {selectedMission.phaseConfiguration?.profile?.name ?? "Default"}
                      </div>
                      {missionPhaseRows.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {missionPhaseRows.map((row) => (
                            <div key={row.key} className="flex items-center justify-between text-[10px]" style={{ fontFamily: MONO_FONT }}>
                              <span style={{ color: COLORS.textSecondary }}>{row.name}</span>
                              <span style={{ color: COLORS.textMuted }}>{row.completed}/{row.total}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <UsageDashboard missionId={selectedMission.id} missionTitle={selectedMission.title} />
                  </div>
                )}
              </div>

              {/* ── Bottom Steering Bar (hidden on Chat tab since chat includes steering + control) ── */}
              {isActiveMission && activeTab !== "chat" && (
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
            onClose={closeCreateDialog}
            onLaunch={handleLaunchMission}
            busy={createBusy}
            lanes={mappedLanes}
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

/* ════════════════════ PLAN TAB ════════════════════ */

const PLAN_DONE_STATUSES = new Set<OrchestratorStepStatus>(["succeeded", "skipped", "superseded", "canceled"]);

function statusGlyph(status: OrchestratorStepStatus): string {
  if (status === "succeeded" || status === "skipped") return "✓";
  if (status === "running" || status === "ready") return "●";
  if (status === "failed") return "✗";
  if (status === "superseded") return "~";
  return "○";
}

function PlanTab({
  mission,
  runGraph,
  attemptsByStep,
  selectedStepId,
  onStepSelect
}: {
  mission: MissionDetail | null;
  runGraph: OrchestratorRunGraph | null;
  attemptsByStep: Map<string, OrchestratorAttempt[]>;
  selectedStepId: string | null;
  onStepSelect: (stepId: string) => void;
}) {
  const [collapsedMilestones, setCollapsedMilestones] = useState<Record<string, boolean>>({});

  const hierarchy = useMemo(() => {
    const steps = runGraph?.steps ?? [];
    const phaseMap = new Map<string, {
      key: string;
      name: string;
      position: number;
      milestones: Map<string, { key: string; name: string; steps: OrchestratorStep[] }>;
    }>();

    for (const step of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
      const meta = isRecord(step.metadata) ? step.metadata : {};
      const phaseKey = typeof meta.phaseKey === "string" && meta.phaseKey.trim().length > 0 ? meta.phaseKey : "development";
      const phaseName = typeof meta.phaseName === "string" && meta.phaseName.trim().length > 0 ? meta.phaseName : "Development";
      const phasePosition = Number.isFinite(Number(meta.phasePosition)) ? Number(meta.phasePosition) : 9999;
      const planStep = isRecord(meta.planStep) ? meta.planStep : {};
      const milestoneName =
        typeof planStep.milestone === "string" && planStep.milestone.trim().length > 0
          ? planStep.milestone.trim()
          : `Milestone ${Math.floor(step.stepIndex / 4) + 1}`;

      const phaseBucket = phaseMap.get(phaseKey) ?? {
        key: phaseKey,
        name: phaseName,
        position: phasePosition,
        milestones: new Map()
      };
      const milestoneBucket = phaseBucket.milestones.get(milestoneName) ?? {
        key: `${phaseKey}:${milestoneName}`,
        name: milestoneName,
        steps: []
      };
      milestoneBucket.steps.push(step);
      phaseBucket.milestones.set(milestoneName, milestoneBucket);
      phaseMap.set(phaseKey, phaseBucket);
    }

    return Array.from(phaseMap.values())
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((phase) => ({
        ...phase,
        milestones: Array.from(phase.milestones.values()).sort((a, b) => a.steps[0]!.stepIndex - b.steps[0]!.stepIndex)
      }));
  }, [runGraph?.steps]);

  if (!runGraph || runGraph.steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16" style={{ color: COLORS.textMuted }}>
        <SquaresFour size={32} weight="regular" style={{ opacity: 0.2 }} className="mb-2" />
        <p className="text-xs" style={{ fontFamily: MONO_FONT }}>No runtime plan yet. Start a run to populate the plan tree.</p>
        {mission?.steps?.length ? (
          <p className="mt-2 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            Mission has {mission.steps.length} seeded steps waiting for orchestration.
          </p>
        ) : null}
      </div>
    );
  }

  const currentPhase = hierarchy.find((phase) =>
    phase.milestones.some((milestone) => milestone.steps.some((step) => !PLAN_DONE_STATUSES.has(step.status)))
  ) ?? hierarchy[hierarchy.length - 1] ?? null;
  const phaseTotal = currentPhase
    ? currentPhase.milestones.reduce((sum, milestone) => sum + milestone.steps.length, 0)
    : 0;
  const phaseCompleted = currentPhase
    ? currentPhase.milestones.reduce(
        (sum, milestone) => sum + milestone.steps.filter((step) => PLAN_DONE_STATUSES.has(step.status)).length,
        0
      )
    : 0;

  return (
    <div className="space-y-3 pb-3">
      {currentPhase ? (
        <div className="px-3 py-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between text-[11px]" style={{ fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
            <span>Phase: {currentPhase.name}</span>
            <span>{phaseCompleted}/{phaseTotal} tasks</span>
          </div>
          <div className="mt-2 h-1.5 w-full" style={{ background: COLORS.recessedBg }}>
            <div
              className="h-full transition-all"
              style={{ width: `${phaseTotal > 0 ? Math.round((phaseCompleted / phaseTotal) * 100) : 0}%`, background: COLORS.accent }}
            />
          </div>
        </div>
      ) : null}

      {hierarchy.map((phase) => (
        <div key={phase.key} className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="text-[11px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
            {phase.name}
          </div>
          <div className="mt-2 space-y-2">
            {phase.milestones.map((milestone) => {
              const milestoneDone = milestone.steps.filter((step) => PLAN_DONE_STATUSES.has(step.status)).length;
              const collapsed = collapsedMilestones[milestone.key] === true;
              return (
                <div key={milestone.key} style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg }}>
                  <button
                    className="flex w-full items-center justify-between px-2 py-1.5 text-left"
                    onClick={() =>
                      setCollapsedMilestones((prev) => ({ ...prev, [milestone.key]: !collapsed }))
                    }
                  >
                    <span className="text-[11px]" style={{ color: COLORS.textPrimary }}>{milestone.name}</span>
                    <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      {milestoneDone}/{milestone.steps.length}
                    </span>
                  </button>
                  {!collapsed ? (
                    <div className="space-y-1 px-2 pb-2">
                      {milestone.steps.map((step) => {
                        const attempts = attemptsByStep.get(step.id) ?? [];
                        const activeAttempt = attempts.find((attempt) => attempt.status === "running") ?? attempts[0] ?? null;
                        const meta = isRecord(step.metadata) ? step.metadata : {};
                        const expectedSignals = Array.isArray(meta.expectedSignals)
                          ? meta.expectedSignals.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0)
                          : [];
                        return (
                          <div
                            key={step.id}
                            className="cursor-pointer px-2 py-1"
                            onClick={() => onStepSelect(step.id)}
                            style={selectedStepId === step.id
                              ? { background: `${COLORS.accent}12`, border: `1px solid ${COLORS.accent}30` }
                              : { border: `1px solid ${COLORS.border}` }
                            }
                          >
                            <div className="flex items-center gap-2 text-[11px]">
                              <span style={{ color: STEP_STATUS_HEX[step.status] ?? COLORS.textMuted, fontFamily: MONO_FONT }}>
                                {statusGlyph(step.status)}
                              </span>
                              <span className="min-w-0 flex-1 truncate" style={{ color: COLORS.textPrimary }}>{step.title}</span>
                              {activeAttempt && step.status === "running" ? (
                                <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                  {activeAttempt.executorKind}
                                </span>
                              ) : null}
                            </div>
                            {expectedSignals.length > 0 ? (
                              <div className="mt-1 space-y-0.5 pl-5">
                                {expectedSignals.slice(0, 3).map((signal) => (
                                  <div key={signal} className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    {step.status === "succeeded" ? "✓" : "○"} {signal}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ════════════════════ WORK TAB ════════════════════ */

function WorkTab({ runGraph }: { runGraph: OrchestratorRunGraph | null }) {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [transcriptTail, setTranscriptTail] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const transcriptRef = useRef<HTMLPreElement>(null);

  const activeAttempts = useMemo(() => {
    if (!runGraph) return [];
    return runGraph.attempts
      .filter((attempt) => attempt.status === "running" && typeof attempt.executorSessionId === "string" && attempt.executorSessionId.length > 0)
      .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt));
  }, [runGraph]);

  useEffect(() => {
    if (!activeAttempts.length) {
      setSelectedAttemptId(null);
      setTranscriptTail("");
      return;
    }
    setSelectedAttemptId((prev) => (prev && activeAttempts.some((attempt) => attempt.id === prev) ? prev : activeAttempts[0]!.id));
  }, [activeAttempts]);

  const selectedAttempt = useMemo(
    () => activeAttempts.find((attempt) => attempt.id === selectedAttemptId) ?? null,
    [activeAttempts, selectedAttemptId]
  );
  const selectedStep = useMemo(
    () => (runGraph && selectedAttempt ? runGraph.steps.find((step) => step.id === selectedAttempt.stepId) ?? null : null),
    [runGraph, selectedAttempt]
  );

  useEffect(() => {
    if (!selectedAttempt?.executorSessionId) return;
    let cancelled = false;
    const readTail = async () => {
      try {
        const tail = await window.ade.sessions.readTranscriptTail({
          sessionId: selectedAttempt.executorSessionId!,
          maxBytes: 16_000
        });
        if (!cancelled) setTranscriptTail(tail);
      } catch {
        if (!cancelled) setTranscriptTail("(unable to read worker transcript)");
      }
    };
    void readTail();
    const timer = window.setInterval(() => {
      void readTail();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedAttempt?.executorSessionId]);

  useEffect(() => {
    if (!autoScroll || !transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [autoScroll, transcriptTail]);

  const relatedEvents = useMemo(() => {
    if (!runGraph?.runtimeEvents || !selectedAttempt) return [];
    return [...runGraph.runtimeEvents]
      .filter((event) => event.attemptId === selectedAttempt.id || event.stepId === selectedAttempt.stepId)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .slice(-200);
  }, [runGraph?.runtimeEvents, selectedAttempt]);

  const filesTouched = useMemo(() => {
    const files = new Map<string, number>();
    for (const event of relatedEvents) {
      const payload = isRecord(event.payload) ? event.payload : {};
      const candidates = [
        typeof payload.filePath === "string" ? payload.filePath : null,
        typeof payload.path === "string" ? payload.path : null,
        typeof payload.file === "string" ? payload.file : null
      ].filter((entry): entry is string => Boolean(entry));
      for (const file of candidates) {
        files.set(file, (files.get(file) ?? 0) + 1);
      }
    }
    return [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [relatedEvents]);

  const toolsCalled = useMemo(() => {
    const tools = new Map<string, number>();
    for (const event of relatedEvents) {
      const payload = isRecord(event.payload) ? event.payload : {};
      const toolName =
        typeof payload.toolName === "string"
          ? payload.toolName
          : typeof payload.tool === "string"
            ? payload.tool
            : event.eventType.startsWith("tool_")
              ? event.eventType
              : null;
      if (!toolName) continue;
      tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
    }
    return [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [relatedEvents]);

  if (!runGraph) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        No orchestrator run yet.
      </div>
    );
  }

  if (!activeAttempts.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        No active workers right now.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2 px-3 py-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Follow</span>
        <select
          value={selectedAttemptId ?? ""}
          onChange={(event) => setSelectedAttemptId(event.target.value)}
          className="h-7 px-2 text-[10px] outline-none"
          style={{ ...outlineButton(), background: COLORS.recessedBg }}
        >
          {activeAttempts.map((attempt) => {
            const step = runGraph.steps.find((entry) => entry.id === attempt.stepId);
            return (
              <option key={attempt.id} value={attempt.id}>
                {(step?.title ?? attempt.stepId.slice(0, 8)).slice(0, 70)}
              </option>
            );
          })}
        </select>
        <span className="ml-auto text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {selectedStep ? `Phase: ${String((selectedStep.metadata as Record<string, unknown> | null)?.phaseName ?? "Development")}` : ""}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="min-h-0 min-w-0 flex-1" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
            <span className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Live Output</span>
            <button
              className="text-[10px] font-bold uppercase tracking-[1px]"
              style={{ color: autoScroll ? COLORS.accent : COLORS.textMuted, fontFamily: MONO_FONT }}
              onClick={() => setAutoScroll((prev) => !prev)}
            >
              {autoScroll ? "Auto-scroll" : "Scroll lock"}
            </button>
          </div>
          <pre
            ref={transcriptRef}
            className="h-full overflow-auto p-3 text-[10px] whitespace-pre-wrap"
            style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT, background: COLORS.recessedBg }}
          >
            {transcriptTail || "Waiting for transcript output..."}
          </pre>
        </div>

        <div className="w-full space-y-3 lg:w-[320px] lg:shrink-0">
          <div className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Files Modified</div>
            <div className="mt-2 space-y-1">
              {filesTouched.length === 0 ? (
                <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>No file events yet.</div>
              ) : filesTouched.map(([file, count]) => (
                <div key={file} className="flex items-center justify-between text-[10px]" style={{ fontFamily: MONO_FONT }}>
                  <span className="truncate pr-2" style={{ color: COLORS.textSecondary }}>{file}</span>
                  <span style={{ color: COLORS.textMuted }}>{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Tools Called</div>
            <div className="mt-2 space-y-1">
              {toolsCalled.length === 0 ? (
                <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>No tool events yet.</div>
              ) : toolsCalled.map(([tool, count]) => (
                <div key={tool} className="flex items-center justify-between text-[10px]" style={{ fontFamily: MONO_FONT }}>
                  <span className="truncate pr-2" style={{ color: COLORS.textSecondary }}>{tool}</span>
                  <span style={{ color: COLORS.textMuted }}>{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════ HOME DASHBOARD ════════════════════ */

function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "--";
  const totalSeconds = Math.floor(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function MissionsHomeDashboard({
  snapshot,
  onNewMission,
  onViewMission
}: {
  snapshot: MissionDashboardSnapshot | null;
  onNewMission: () => void;
  onViewMission: (missionId: string) => void;
}) {
  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        Loading mission dashboard...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4 gap-3 overflow-auto">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>MISSIONS</div>
        <button style={primaryButton()} onClick={onNewMission}>
          <Plus size={14} />
          NEW MISSION
        </button>
      </div>

      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Active Missions</div>
        <div className="mt-2 space-y-2">
          {snapshot.active.length === 0 ? (
            <div className="text-xs" style={{ color: COLORS.textDim }}>No active missions.</div>
          ) : snapshot.active.map((entry) => (
            <button
              key={entry.mission.id}
              className="w-full text-left p-2"
              style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
              onClick={() => onViewMission(entry.mission.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium" style={{ color: COLORS.textPrimary }}>{entry.mission.title}</span>
                <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{entry.phaseProgress.pct}%</span>
              </div>
              <div className="mt-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                {entry.phaseName ?? "Phase"} · {entry.activeWorkers} workers · {formatDurationMs(entry.elapsedMs)}
              </div>
              <div className="mt-1 h-1.5 w-full" style={{ background: COLORS.pageBg }}>
                <div className="h-full" style={{ width: `${entry.phaseProgress.pct}%`, background: COLORS.accent }} />
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Recent Missions</div>
        <div className="mt-2 space-y-1.5">
          {snapshot.recent.length === 0 ? (
            <div className="text-xs" style={{ color: COLORS.textDim }}>No recent missions.</div>
          ) : snapshot.recent.map((entry) => (
            <div key={entry.mission.id} className="flex items-center gap-2 px-2 py-1.5" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: COLORS.textPrimary }}>{entry.mission.title}</span>
              <span className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>{formatDurationMs(entry.durationMs)}</span>
              <button style={outlineButton()} onClick={() => onViewMission(entry.mission.id)}>
                {entry.action.toUpperCase()}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Stats (7d)</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Missions</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>{snapshot.weekly.missions}</div>
          </div>
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Success</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>{Math.round(snapshot.weekly.successRate * 100)}%</div>
          </div>
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Avg Duration</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>{formatDurationMs(snapshot.weekly.avgDurationMs)}</div>
          </div>
          <div className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Est. Cost</div>
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>${snapshot.weekly.totalCostUsd.toFixed(2)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Re-export for compatibility: the page was previously a named export */
export { MissionsPage };
