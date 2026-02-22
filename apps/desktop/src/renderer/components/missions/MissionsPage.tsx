import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  Clock3,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  Square,
  Terminal,
  X,
  Activity,
  GitBranch,
  LayoutGrid,
  Network,
  CheckCircle2,
  Zap,
  MessageSquare,
  Bot,
  Shield,
  CircleDot,
  Settings
} from "lucide-react";
import { motion, AnimatePresence, LazyMotion, domAnimation } from "motion/react";
import type {
  MissionDepthTier,
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
  SteerMissionResult
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { OrchestratorActivityFeed } from "./OrchestratorActivityFeed";
import { OrchestratorDAG } from "./OrchestratorDAG";
import { WorkerTranscriptPane } from "./WorkerTranscriptPane";
import { PolicyEditor, PRESET_STANDARD } from "./PolicyEditor";
import { CompletionBanner } from "./CompletionBanner";
import { PhaseProgressBar } from "./PhaseProgressBar";
import { MissionPolicyBadge } from "./MissionPolicyBadge";

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

const DEPTH_TIER_COLORS: Record<MissionDepthTier, string> = {
  light: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  standard: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  deep: "bg-orange-500/20 text-orange-300 border-orange-500/30"
};

const DEPTH_DESCRIPTIONS: Record<MissionDepthTier, { label: string; desc: string; budget: string }> = {
  light: { label: "Light", desc: "Quick task, minimal AI planning, single agent", budget: "~$0.50" },
  standard: { label: "Standard", desc: "Balanced, AI planning, up to 3 agents, evaluation", budget: "~$5" },
  deep: { label: "Deep", desc: "Comprehensive, extensive AI planning, up to 6 agents, continuous evaluation", budget: "~$25" }
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

type WorkspaceTab = "board" | "dag" | "activity" | "transcript" | "chat";
type PlannerProvider = "auto" | "claude" | "codex";

type MissionSettingsDraft = {
  defaultDepthTier: MissionDepthTier;
  defaultExecutionPolicy: MissionExecutionPolicy;
  defaultPlannerProvider: PlannerProvider;
  requirePlanReview: boolean;
  claudePermissionMode: string;
  claudeDangerouslySkip: boolean;
  codexSandboxPermissions: string;
  codexApprovalMode: string;
  codexConfigPath: string;
};

const DEFAULT_MISSION_SETTINGS_DRAFT: MissionSettingsDraft = {
  defaultDepthTier: "standard",
  defaultExecutionPolicy: PRESET_STANDARD,
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

function toDepthTier(value: string, fallback: MissionDepthTier = "standard"): MissionDepthTier {
  return value === "light" || value === "standard" || value === "deep" ? value : fallback;
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

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "--";
  const delta = Math.max(0, Date.now() - Date.parse(startedAt));
  const secs = Math.floor(delta / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

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

  // ── Context events ──
  if (ev.eventType === "context_snapshot_created") return "Context snapshot saved for future reference";
  if (ev.eventType === "context_pressure_warning") return "Context window pressure detected \u2014 may need to compact";
  if (ev.eventType === "context_pack_bootstrap") return "Context pack bootstrapped for worker";
  if (ev.eventType === "integration_chain_started") return "Integration merge chain started";

  // ── Fallback ──
  return ev.reason || "Event recorded";
}

/** Pick a lucide icon component for a timeline event type. */
function iconForEventType(eventType: string): React.ComponentType<{ className?: string }> {
  if (eventType.startsWith("run_") || eventType === "run_status_changed") return Rocket;
  if (eventType.startsWith("step_") || eventType === "step_status_changed") return CircleDot;
  if (eventType.startsWith("attempt_")) return Bot;
  if (eventType.startsWith("claim_")) return Shield;
  if (eventType.startsWith("autopilot")) return Zap;
  if (eventType.startsWith("context_")) return GitBranch;
  if (eventType === "user_directive") return MessageSquare;
  return Activity;
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
  "merge",
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
  merge: "Merge",
  cost: "Cost",
  tokens: "Tokens",
  retries: "Retries",
  claims: "Claims",
  context_pressure: "Context Pressure",
  interventions: "Interventions"
};

const WORKER_STATUS_CLASSES: Record<string, string> = {
  spawned: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  initializing: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
  working: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  waiting_input: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  idle: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  completed: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-300 border-red-500/30",
  disposed: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30"
};

function workerThreadMatchesTarget(thread: OrchestratorChatThread, target: OrchestratorChatTarget | null | undefined): boolean {
  if (thread.threadType !== "worker" || !target || target.kind !== "worker") return false;
  if (target.runId && thread.runId !== target.runId) return false;
  const candidates = [
    [target.attemptId, thread.attemptId],
    [target.sessionId, thread.sessionId],
    [target.stepId, thread.stepId],
    [target.stepKey, thread.stepKey],
    [target.laneId, thread.laneId]
  ];
  return candidates.some(([left, right]) => typeof left === "string" && left.length > 0 && left === right);
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
    const matched = args.threads.find((thread) => workerThreadMatchesTarget(thread, args.jumpTarget));
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
  const selectedThreadIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!jumpTarget) return;
    if (jumpTarget.kind === "worker") {
      const matched = threads.find((thread) => workerThreadMatchesTarget(thread, jumpTarget));
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
        void refreshThreads();
        const currentThreadId = selectedThreadIdRef.current;
        if (currentThreadId && (!event.threadId || event.threadId === currentThreadId)) {
          void refreshMessages(currentThreadId);
        }
      }
      if (event.type === "metrics_updated" || event.type === "worker_digest_updated" || event.type === "worker_replay") {
        void refreshWorkerRail();
      }
    });
    const unsubRuntimeEvents = window.ade.orchestrator.onEvent((event) => {
      if (runId && event.runId === runId) {
        void refreshWorkerRail();
      }
    });
    return () => {
      unsubThreadEvents();
      unsubRuntimeEvents();
    };
  }, [missionId, refreshMessages, refreshThreads, refreshWorkerRail, runId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, selectedThreadId]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId]
  );

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
  }, [input, missionId, runId, selectedThread, sending]);

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="w-full shrink-0 border-b border-border/20 bg-zinc-900/45 lg:w-[230px] lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between border-b border-border/20 px-3 py-2">
          <div className="text-[11px] font-semibold text-fg">Threads</div>
          <div className="text-[10px] text-muted-fg">{threads.length}</div>
        </div>
        <div className="max-h-[180px] overflow-y-auto p-2 lg:max-h-none lg:h-full">
          {threads.length === 0 && (
            <div className="rounded border border-border/20 bg-zinc-800/35 px-2 py-3 text-center text-[10px] text-muted-fg">
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
                    : "border-border/20 bg-zinc-800/35 hover:bg-zinc-800/60"
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-border/20 lg:border-b-0 lg:border-r lg:border-border/20">
        <div className="border-b border-border/20 px-3 py-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5 text-accent" />
            <div className="text-[11px] font-semibold text-fg">
              {selectedThread?.title ?? "Select a thread"}
            </div>
            {selectedThread && (
              <span className="rounded border border-border/30 bg-zinc-800/60 px-1.5 py-0.5 text-[9px] text-muted-fg">
                {selectedThread.threadType}
              </span>
            )}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
          {!selectedThread && (
            <div className="rounded border border-border/20 bg-zinc-800/35 px-3 py-6 text-center text-[11px] text-muted-fg">
              Pick a mission or worker thread to inspect and send guidance.
            </div>
          )}
          {selectedThread && messages.length === 0 && (
            <div className="rounded border border-border/20 bg-zinc-800/35 px-3 py-6 text-center text-[11px] text-muted-fg">
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
                    : "border-border/30 bg-zinc-800/70 text-zinc-100"
              )}>
                {msg.role !== "user" && (
                  <div className="mb-1 flex items-center gap-1 text-[9px] text-muted-fg">
                    {msg.role === "orchestrator" ? <Bot className="h-3 w-3" /> : <Terminal className="h-3 w-3" />}
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

        <div className="border-t border-border/20 px-3 py-2">
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
                  : "Message the mission coordinator..."
              }
              className="h-8 flex-1 rounded border border-border/30 bg-zinc-800 px-3 text-xs text-fg outline-none focus:border-accent/40 disabled:opacity-50"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSend()}
              disabled={!selectedThread || !input.trim() || sending}
            >
              {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              Send
            </Button>
          </div>
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 xl:flex xl:flex-col">
        <div className="border-b border-border/20 px-3 py-2">
          <div className="text-[11px] font-semibold text-fg">Worker Status</div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {workerThreadCards.length === 0 && (
            <div className="rounded border border-border/20 bg-zinc-800/35 px-2 py-3 text-center text-[10px] text-muted-fg">
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
                  : "border-border/20 bg-zinc-800/35 hover:bg-zinc-800/55"
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

        <div className="border-t border-border/20 px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold text-fg">Mission Metrics</div>
            {savingMetrics ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-fg" /> : null}
          </div>
        </div>
        <div className="max-h-[44%] overflow-y-auto p-2">
          <div className="space-y-1.5">
            {METRIC_TOGGLE_ORDER.map((toggle) => (
              <label key={toggle} className="flex items-center justify-between rounded border border-border/20 bg-zinc-800/35 px-2 py-1.5 text-[10px]">
                <span className="text-fg">{METRIC_TOGGLE_LABELS[toggle]}</span>
                <input
                  type="checkbox"
                  checked={enabledMetricSet.has(toggle)}
                  onChange={() => void handleToggleMetric(toggle)}
                  disabled={savingMetrics}
                />
              </label>
            ))}
          </div>
          <div className="mt-2 rounded border border-border/20 bg-zinc-900/55 p-2">
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
  depthTier: MissionDepthTier;
  executionPolicy: MissionExecutionPolicy;
};

function CreateMissionDialog({
  open,
  onClose,
  onLaunch,
  busy,
  lanes,
  defaultDepthTier
}: {
  open: boolean;
  onClose: () => void;
  onLaunch: (draft: CreateDraft) => void;
  busy: boolean;
  lanes: Array<{ id: string; name: string }>;
  defaultDepthTier: MissionDepthTier;
}) {
  const [draft, setDraft] = useState<CreateDraft>({
    title: "",
    prompt: "",
    laneId: "",
    priority: "normal",
    depthTier: defaultDepthTier,
    executionPolicy: PRESET_STANDARD
  });

  useEffect(() => {
    if (!open) return;
    setDraft({
      title: "",
      prompt: "",
      laneId: "",
      priority: "normal",
      depthTier: defaultDepthTier,
      executionPolicy: PRESET_STANDARD
    });
  }, [open, defaultDepthTier]);

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
        className="w-full max-w-lg rounded-lg border border-border/40 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border/20 px-5 py-3">
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
              className="w-full rounded-lg border border-border/30 bg-zinc-800 px-3 py-2 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 resize-none"
            />
          </label>

          {/* Title */}
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-fg">Title (optional, auto-generated)</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Refactor auth middleware"
              className="h-8 w-full rounded-lg border border-border/30 bg-zinc-800 px-3 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
            />
          </label>

          <div className="grid grid-cols-3 gap-3">
            {/* Lane */}
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-fg">Lane</span>
              <select
                value={draft.laneId}
                onChange={(e) => setDraft((p) => ({ ...p, laneId: e.target.value }))}
                className="h-8 w-full rounded-lg border border-border/30 bg-zinc-800 px-2 text-xs text-fg outline-none focus:border-accent/40"
              >
                <option value="">Auto</option>
                {lanes.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </label>

            {/* Priority */}
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-muted-fg">Priority</span>
              <select
                value={draft.priority}
                onChange={(e) => setDraft((p) => ({ ...p, priority: e.target.value as MissionPriority }))}
                className="h-8 w-full rounded-lg border border-border/30 bg-zinc-800 px-2 text-xs text-fg outline-none focus:border-accent/40"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>

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

        <div className="flex items-center justify-end gap-2 border-t border-border/20 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleLaunch}
            disabled={busy || !draft.prompt.trim()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
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

  const inputClass = "h-8 w-full rounded border border-border/30 bg-zinc-800 px-2 text-xs text-fg outline-none focus:border-accent/40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-2xl rounded-lg border border-border/40 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border/20 px-5 py-3">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">Mission Settings</h2>
          </div>
          <button onClick={onClose} className="text-muted-fg hover:text-fg transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {notice ? <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">{notice}</div> : null}
          {error ? <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div> : null}

          <div className="rounded-lg border border-border/20 bg-zinc-800/30 p-3">
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

          <div className="rounded-lg border border-border/20 bg-zinc-800/30 p-3">
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

        <div className="flex items-center justify-end gap-2 border-t border-border/20 px-5 py-3">
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
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [chatJumpTarget, setChatJumpTarget] = useState<OrchestratorChatTarget | null>(null);

  /* ── Steering state ── */
  const [steerInput, setSteerInput] = useState("");
  const [steerBusy, setSteerBusy] = useState(false);
  const [steerAck, setSteerAck] = useState<string | null>(null);
  const [steeringLog, setSteeringLog] = useState<SteeringEntry[]>([]);

  /* ── Elapsed time ticker ── */
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

    setMissionSettingsSnapshot(snapshot);
    setMissionSettingsDraft({
      defaultDepthTier: toDepthTier(
        readString(localOrchestrator.defaultDepthTier, effectiveOrchestrator.defaultDepthTier, "standard"),
        "standard"
      ),
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
      codexConfigPath: readString(localCodex.configPath, effectiveCodex.configPath, ""),
      defaultExecutionPolicy: PRESET_STANDARD
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

      const normalizedDepthTier = toDepthTier(missionSettingsDraft.defaultDepthTier, "standard");
      const normalizedPlannerProvider = toPlannerProvider(missionSettingsDraft.defaultPlannerProvider);
      const normalizedClaudePermissionMode = toClaudePermissionMode(missionSettingsDraft.claudePermissionMode);
      const normalizedCodexSandbox = toCodexSandboxPermissions(missionSettingsDraft.codexSandboxPermissions);
      const normalizedCodexApproval = toCodexApprovalMode(missionSettingsDraft.codexApprovalMode);

      const nextOrchestrator: Record<string, unknown> = {
        ...localOrchestrator,
        defaultDepthTier: normalizedDepthTier,
        defaultPlannerProvider: normalizedPlannerProvider,
        requirePlanReview: missionSettingsDraft.requirePlanReview
      };

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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunGraph(null);
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
      setSelectedMission(null);
      setRunGraph(null);
      setSteeringLog([]);
      setChatJumpTarget(null);
      return;
    }
    setSteeringLog([]);
    setChatJumpTarget(null);
    void loadMissionDetail(selectedMissionId);
    void loadOrchestratorGraph(selectedMissionId);
  }, [selectedMissionId, loadMissionDetail, loadOrchestratorGraph]);

  useEffect(() => {
    const unsub = window.ade.missions.onEvent((payload) => {
      void refreshMissionList({ preserveSelection: true, silent: true });
      if (payload.missionId && payload.missionId === selectedMissionId) {
        void loadMissionDetail(payload.missionId);
        void loadOrchestratorGraph(payload.missionId);
      }
    });
    return () => unsub();
  }, [loadMissionDetail, loadOrchestratorGraph, refreshMissionList, selectedMissionId]);

  useEffect(() => {
    const unsub = window.ade.orchestrator.onEvent(() => {
      if (!selectedMissionId) return;
      void loadOrchestratorGraph(selectedMissionId);
    });
    return () => unsub();
  }, [loadOrchestratorGraph, selectedMissionId]);

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
        executionPolicy: draft.executionPolicy,
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
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  /* ════════════════════ RENDER ════════════════════ */
  return (
    <LazyMotion features={domAnimation}>
      <div className="flex h-full min-h-0">
        {/* ════════════ LEFT SIDEBAR ════════════ */}
        <div className="flex w-[260px] shrink-0 flex-col border-r border-border/20 bg-zinc-900/60">
          {/* Sidebar Header */}
          <div className="flex items-center justify-between border-b border-border/20 px-3 py-2.5">
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
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
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
                <Settings className="h-3.5 w-3.5" />
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

          {/* Search */}
          <div className="px-3 py-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-fg/60" />
              <input
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Search missions..."
                className="h-7 w-full rounded border border-border/20 bg-zinc-800/60 pl-7 pr-2 text-[11px] text-fg outline-none focus:border-accent/30"
              />
            </div>
          </div>

          {/* Mission list */}
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {filteredMissions.length === 0 ? (
              <div className="px-2 py-8 text-center text-[11px] text-muted-fg/60">
                {missions.length === 0 ? "No missions yet" : "No matches"}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredMissions.map((m) => {
                  const isSelected = m.id === selectedMissionId;
                  const progress = m.totalSteps > 0 ? Math.round((m.completedSteps / m.totalSteps) * 100) : 0;
                  return (
                    <button
                      key={m.id}
                      onClick={() => setSelectedMissionId(m.id)}
                      className={cn(
                        "w-full text-left rounded-lg px-2.5 py-2 transition-colors",
                        isSelected
                          ? "bg-accent/15 border border-accent/30"
                          : "hover:bg-zinc-800/60 border border-transparent"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", STATUS_DOT_COLORS[m.status])} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-medium text-fg">{m.title}</div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className={cn("rounded px-1 py-0.5 text-[9px] font-medium border", STATUS_BADGE_CLASSES[m.status])}>
                              {STATUS_LABELS[m.status]}
                            </span>
                          </div>
                          {m.totalSteps > 0 && (
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1 flex-1 rounded-full bg-zinc-700">
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
              <Rocket className="h-10 w-10 opacity-20" />
              <p className="text-sm">Select a mission or create a new one</p>
              <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                New Mission
              </Button>
            </div>
          ) : (
            <>
              {/* ── Header Bar ── */}
              <div className="flex items-center gap-3 border-b border-border/20 bg-zinc-900/40 px-4 py-2.5">
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
                        depthTier={(runGraph.run.metadata as Record<string, unknown>).depthTier as string | undefined}
                      />
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-fg">
                    <span><Clock3 className="inline h-3 w-3 mr-0.5" />{formatElapsed(selectedMission?.startedAt ?? null)}</span>
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
                      {runBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
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
                      <Square className="h-3 w-3" />
                      Cancel
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
              <div className="flex items-center gap-0.5 border-b border-border/20 bg-zinc-900/30 px-4">
                {([
                  { key: "board" as WorkspaceTab, label: "Board", icon: LayoutGrid },
                  { key: "dag" as WorkspaceTab, label: "DAG", icon: Network },
                  { key: "activity" as WorkspaceTab, label: "Activity", icon: Activity },
                  { key: "transcript" as WorkspaceTab, label: "Transcript", icon: Terminal },
                  { key: "chat" as WorkspaceTab, label: "Chat", icon: MessageSquare }
                ]).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium transition-colors border-b-2",
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

              {/* ── Completion Banner + Phase Progress ── */}
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
              <div className={cn("flex-1 min-h-0", activeTab === "chat" ? "flex flex-col overflow-hidden" : "overflow-auto p-4")}>
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
                      onOpenTranscript={() => setActiveTab("transcript")}
                      onOpenWorkerThread={(target) => {
                        setChatJumpTarget(target);
                        setActiveTab("chat");
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
                      onOpenTranscript={() => setActiveTab("transcript")}
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
                      initialTimeline={runGraph?.timeline ?? []}
                    />
                  </div>
                )}

                {activeTab === "transcript" && (
                  <WorkerTranscriptPane
                    attempts={runGraph?.attempts ?? []}
                    steps={runGraph?.steps}
                  />
                )}

                {activeTab === "chat" && selectedMissionId && (
                  <MissionChat
                    missionId={selectedMissionId}
                    runId={runGraph?.run.id ?? null}
                    jumpTarget={chatJumpTarget}
                    onJumpHandled={() => setChatJumpTarget(null)}
                  />
                )}
              </div>

              {/* ── Bottom Steering Bar (hidden on Chat tab since chat subsumes steering) ── */}
              {isActiveMission && activeTab !== "chat" && (
                <div className="border-t border-border/20 bg-zinc-900/60 px-4 py-2.5">
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
                      className="h-8 flex-1 rounded-lg border border-border/30 bg-zinc-800 px-3 text-xs text-fg outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void handleSteer()}
                      disabled={steerBusy || !steerInput.trim()}
                    >
                      {steerBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
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
            defaultDepthTier={missionSettingsDraft.defaultDepthTier}
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
      <div className="rounded-lg border border-border/20 bg-zinc-800/40 px-3 py-3 text-center">
        <div className="text-[11px] text-muted-fg">No orchestrator run yet. Start a run to see activity.</div>
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
    (ev) => ev.eventType !== "claim_heartbeat" && ev.eventType !== "context_pack_bootstrap"
  );
  const lastActionLine = latestMeaningful
    ? `Last: ${narrativeForEvent(latestMeaningful)}`
    : null;

  // Recent narrative lines from the timeline (top 5 most recent non-heartbeat events)
  const recentEvents = timeline
    .filter((ev) => ev.eventType !== "claim_heartbeat")
    .slice(0, 5);
  const narrativeLines = narrativeSummary(recentEvents, steeringLog);

  return (
    <div className="space-y-2">
      {/* Progress summary card */}
      <div className="rounded-lg border border-border/20 bg-zinc-800/40 px-3 py-2.5">
        <div className="text-[10px] font-medium text-muted-fg uppercase tracking-wider mb-2">Mission Progress</div>

        {/* Progress bar */}
        {totalSteps > 0 && (
          <div className="mb-2">
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-700">
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
          <div className="flex items-center gap-1.5 text-[11px] text-fg/90">
            <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
            <span>{progressLine}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-fg/80">
            <Bot className="h-3 w-3 text-violet-400 shrink-0" />
            <span>{workersLine}</span>
          </div>
          {lastActionLine && (
            <div className="flex items-center gap-1.5 text-[11px] text-fg/70">
              <Zap className="h-3 w-3 text-amber-400 shrink-0" />
              <span className="truncate">{lastActionLine}</span>
            </div>
          )}
        </div>
      </div>

      {/* Narrative feed card */}
      {(narrativeLines.length > 0 || steeringLog.length > 0) && (
        <div className="rounded-lg border border-border/20 bg-zinc-800/40 px-3 py-2.5">
          <div className="text-[10px] font-medium text-muted-fg uppercase tracking-wider mb-1.5">Recent Activity</div>
          <div className="space-y-1">
            {/* Show steering directives first */}
            {steeringLog.map((d, i) => (
              <div key={`steer-${i}`} className="flex items-start gap-2">
                <MessageSquare className="h-3 w-3 text-cyan-400 shrink-0 mt-0.5" />
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
  onOpenTranscript,
  onOpenWorkerThread
}: {
  step: OrchestratorStep | null;
  attempts: OrchestratorAttempt[];
  allSteps: OrchestratorStep[];
  claims: OrchestratorClaim[];
  onOpenTranscript: () => void;
  onOpenWorkerThread: (target: OrchestratorChatTarget) => void;
}) {
  if (!step) {
    return (
      <aside className="rounded-lg border border-border/20 bg-zinc-800/35 p-3 lg:w-[300px] lg:shrink-0">
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

  return (
    <aside className="rounded-lg border border-border/20 bg-zinc-800/35 p-3 lg:w-[300px] lg:shrink-0">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-fg">Step Details</div>
        <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-medium", STEP_STATUS_COLORS[step.status] ?? "bg-muted/20 text-muted-fg")}>
          {step.status}
        </span>
      </div>

      <div className="mt-2">
        <div className="text-xs font-medium text-fg">{step.title}</div>
        <div className="mt-1 text-[10px] text-muted-fg leading-snug">{stepIntentSummary(step)}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded border border-border/20 bg-zinc-900/50 px-2 py-1">
          <div className="text-muted-fg">Key</div>
          <div className="font-medium text-fg">{step.stepKey}</div>
        </div>
        <div className="rounded border border-border/20 bg-zinc-900/50 px-2 py-1">
          <div className="text-muted-fg">Type</div>
          <div className="font-medium text-fg">{stepType}</div>
        </div>
        <div className="rounded border border-border/20 bg-zinc-900/50 px-2 py-1">
          <div className="text-muted-fg">Attempts</div>
          <div className="font-medium text-fg">{attempts.length}</div>
        </div>
        <div className="rounded border border-border/20 bg-zinc-900/50 px-2 py-1">
          <div className="text-muted-fg">Dependencies</div>
          <div className="font-medium text-fg">{step.dependencyStepIds.length}</div>
        </div>
        <div className="col-span-2 rounded border border-border/20 bg-zinc-900/50 px-2 py-1">
          <div className="text-muted-fg">Lane</div>
          <div className="font-medium text-fg">{step.laneId ?? "none"}</div>
        </div>
      </div>

      {(dependencyLabels.length > 0 || doneCriteria || expectedSignals.length > 0) && (
        <div className="mt-3 rounded border border-border/20 bg-zinc-900/50 px-2 py-2 text-[10px] space-y-1.5">
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

      <div className="mt-3 rounded border border-border/20 bg-zinc-900/50 px-2 py-2 text-[10px]">
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

      <button
        onClick={onOpenTranscript}
        className="mt-3 w-full rounded border border-border/30 bg-zinc-900/60 px-2 py-1.5 text-[10px] font-medium text-fg transition-colors hover:bg-zinc-800/80"
      >
        Open Worker Transcript
      </button>
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
          className="mt-2 w-full rounded border border-accent/30 bg-accent/10 px-2 py-1.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/20"
        >
          Jump To Worker Thread
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
        <LayoutGrid className="h-8 w-8 opacity-20 mb-2" />
        <p className="text-[11px]">No steps yet. Start a run to see the board.</p>
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
            className="w-[220px] shrink-0 rounded-lg border border-border/20 bg-zinc-800/30"
          >
            {/* Column header */}
            <div className="flex items-center justify-between border-b border-border/15 px-3 py-2">
              <span className="text-[11px] font-semibold text-fg">{col.label}</span>
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
                        : "border-border/20 bg-zinc-900/60 hover:bg-zinc-800/60"
                    )}
                  >
                    <div className="text-[11px] font-medium text-fg truncate">{step.title}</div>
                    <div className="mt-0.5 text-[10px] text-muted-fg leading-snug h-[28px] overflow-hidden">
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
