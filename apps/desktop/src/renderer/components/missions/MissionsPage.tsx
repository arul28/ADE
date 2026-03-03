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
  GearSix,
  List,
  Kanban,
  Trash,
} from "@phosphor-icons/react";
import { motion, AnimatePresence, LazyMotion, domAnimation } from "motion/react";
import type {
  MissionDetail,
  MissionSummary,
  OrchestratorAttempt,
  OrchestratorChatMessage,
  OrchestratorChatTarget,
  OrchestratorChatThread,
  OrchestratorWorkerDigest,
  OrchestratorWorkerState,
  OrchestratorExecutorKind,
  OrchestratorRunGraph,
  MissionMetricToggle,
  MissionMetricsConfig,
  MissionMetricSample,
  ProjectConfigSnapshot,
  StartOrchestratorRunFromMissionArgs,
  SteerMissionResult,
  PrStrategy,
  MissionDashboardSnapshot,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { OrchestratorActivityFeed } from "./OrchestratorActivityFeed";
import { OrchestratorDAG } from "./OrchestratorDAG";
import { MissionPhaseBadge } from "./MissionPhaseBadge";
import { CompletionBanner } from "./CompletionBanner";
import { PhaseProgressBar } from "./PhaseProgressBar";
import { UsageDashboard } from "./UsageDashboard";
import { MissionChatV2 } from "./MissionChatV2";
import { MissionControlPage } from "./MissionControlPage";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, inlineBadge, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";
import { relativeWhen, formatDurationMs } from "../../lib/format";

/* ── Extracted modules ── */
import {
  STATUS_BADGE_STYLES,
  STATUS_DOT_HEX,
  STATUS_LABELS,
  PRIORITY_STYLES,
  TERMINAL_MISSION_STATUSES,
  NOISY_EVENT_TYPES,
  PLANNER_STEP_KEY,
  METRIC_TOGGLE_ORDER,
  METRIC_TOGGLE_LABELS,
  WORKER_STATUS_HEX,
  MISSION_BOARD_COLUMNS,
  DEFAULT_MISSION_SETTINGS_DRAFT,
  isRecord,
  readBool,
  readString,
  toPlannerProvider,
  toTeammatePlanMode,
  toClaudePermissionMode,
  toCodexSandboxPermissions,
  toCodexApprovalMode,
  compactText,
  isPlannerStreamMessage,
  formatMetricSample,
  ElapsedTime,
  type WorkspaceTab,
  type MissionListViewMode,
  type PlannerProvider,
  type SteeringEntry,
  type MissionSettingsDraft,
} from "./missionHelpers";
import { CreateMissionDialog, type CreateDraft } from "./CreateMissionDialog";
import { MissionSettingsDialog } from "./MissionSettingsDialog";
import { PlanTab } from "./PlanTab";
import { WorkTab } from "./WorkTab";
import { StepDetailPanel } from "./StepDetailPanel";
import { ActivityNarrativeHeader } from "./ActivityNarrativeHeader";
import { MissionsHomeDashboard } from "./MissionsHomeDashboard";
import { MissionStateSummary } from "./MissionStateSummary";
import { PlanReviewInterventions } from "./PlanReviewInterventions";

/* Re-export helpers used by tests */
export { collapsePlannerStreamMessages, resolveStepHeartbeatAt } from "./missionHelpers";

/* ════════════════════ MISSION CHAT SELECTION ════════════════════ */

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

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "succeeded_with_risk", "failed", "canceled"]);

type OrchestratorCheckpointStatus = {
  savedAt: string;
  turnCount: number;
  compactionCount: number;
};

/* ════════════════════ MISSION CONTROL WRAPPER ════════════════════ */

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

/* ════════════════════ MISSION CHAT (legacy) ════════════════════ */

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
    () => {
      // Inline planner stream collapsing to avoid importing collapsePlannerStreamMessages
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
    },
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
  const [checkpointStatus, setCheckpointStatus] = useState<OrchestratorCheckpointStatus | null>(null);
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
  const canPauseRun = Boolean(
    runGraph && (runGraph.run.status === "active" || runGraph.run.status === "bootstrapping")
  );
  const hasNonTerminalRun = Boolean(runGraph && !TERMINAL_RUN_STATUSES.has(runGraph.run.status));
  const checkpointIndicatorLabel = checkpointStatus ? relativeWhen(checkpointStatus.savedAt) : "pending";
  const checkpointIndicatorTooltip = checkpointStatus
    ? `Last checkpoint: ${relativeWhen(checkpointStatus.savedAt)} | ${checkpointStatus.turnCount} turns | ${checkpointStatus.compactionCount} compactions`
    : "Last checkpoint: pending";

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
    const orchLocal = localOrchestrator as Record<string, unknown>;
    const orchEffective = effectiveOrchestrator as Record<string, unknown>;
    const effectivePrStrategy = (orchLocal.defaultPrStrategy ?? orchEffective.defaultPrStrategy ?? { kind: "integration", targetBranch: "main", draft: true }) as PrStrategy;

    setMissionSettingsSnapshot(snapshot);
    setMissionSettingsDraft({
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

  useEffect(() => {
    if (!runGraph || TERMINAL_RUN_STATUSES.has(runGraph.run.status)) {
      setCheckpointStatus(null);
      return;
    }
    const runId = runGraph.run.id;
    let disposed = false;

    const refreshCheckpointStatus = async () => {
      try {
        const next = await window.ade.orchestrator.getCheckpointStatus({ runId });
        if (!disposed) {
          setCheckpointStatus(next);
        }
      } catch {
        if (!disposed) {
          setCheckpointStatus(null);
        }
      }
    };

    void refreshCheckpointStatus();
    const intervalId = window.setInterval(() => {
      void refreshCheckpointStatus();
    }, 10_000);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [runGraph?.run.id, runGraph?.run.status]);


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
        allowPlanningQuestions: draft.allowPlanningQuestions,
        allowCompletionWithRisk: draft.allowCompletionWithRisk,
        teamRuntime: draft.teamRuntime,
        modelConfig: {
          ...draft.modelConfig,
          decisionTimeoutCapHours: draft.modelConfig.decisionTimeoutCapHours ?? 24,
        },
        phaseProfileId: draft.phaseProfileId,
        phaseOverride: draft.phaseOverride,
        autostart: true,
        launchMode: "autopilot",
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

  const handlePauseRun = useCallback(async () => {
    if (!runGraph) return;
    setRunBusy(true);
    try {
      await window.ade.orchestrator.pauseRun({ runId: runGraph.run.id, reason: "Paused from Missions UI." });
      if (selectedMission) await loadOrchestratorGraph(selectedMission.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunBusy(false);
    }
  }, [runGraph, selectedMission, loadOrchestratorGraph]);

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
                            <div className="flex items-center gap-1.5">
                              <div className="text-xs font-medium truncate flex-1" style={{ color: COLORS.textPrimary }}>{m.title}</div>
                              {m.openInterventions > 0 && (
                                <span
                                  className="shrink-0 px-1 py-0.5 text-[9px] font-bold"
                                  style={{ color: COLORS.warning, background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}30`, fontFamily: MONO_FONT }}
                                  title="Has pending interventions"
                                >
                                  {m.status === "plan_review" ? "?" : "!"}
                                </span>
                              )}
                            </div>
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
                            {m.openInterventions > 0 && (
                              <span
                                className="px-1 py-0.5 text-[9px] font-bold"
                                style={{ color: COLORS.warning, background: `${COLORS.warning}18`, border: `1px solid ${COLORS.warning}30`, fontFamily: MONO_FONT }}
                                title="Has pending interventions"
                              >
                                {m.status === "plan_review" ? "?" : "!"}
                              </span>
                            )}
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
                      <MissionPhaseBadge
                        phases={(runGraph.run.metadata as Record<string, unknown>).phaseOverride as import("../../../shared/types").PhaseCard[] | undefined}
                        profileName={(runGraph.run.metadata as Record<string, unknown>).phaseProfileName as string | undefined}
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
                  {hasNonTerminalRun && (
                    <span
                      className="px-1 text-[9px] uppercase tracking-[0.5px]"
                      style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
                      title={checkpointIndicatorTooltip}
                    >
                      checkpoint {checkpointIndicatorLabel}
                    </span>
                  )}
                  {canStartOrRerun && (
                    <button style={primaryButton()} onClick={handleStartRun} disabled={runBusy}>
                      {runBusy ? <SpinnerGap className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                      {runGraph ? "RERUN" : "START"}
                    </button>
                  )}
                  {canPauseRun && (
                    <button
                      style={outlineButton({ color: COLORS.warning, border: `1px solid ${COLORS.warning}40`, background: `${COLORS.warning}12` })}
                      onClick={handlePauseRun}
                      disabled={runBusy}
                      title="Pause run immediately (mechanical bypass)"
                    >
                      <span className="text-[10px]" style={{ fontFamily: MONO_FONT }}>&#9208;</span>
                      PAUSE
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

              {/* ── Plan Review: Planner Clarifying Questions ── */}
              {selectedMission?.status === "plan_review" &&
                selectedMission.interventions.some(
                  (iv) =>
                    iv.interventionType === "manual_input" &&
                    iv.status === "open" &&
                    iv.metadata?.source === "planner_clarifying_question"
                ) && (
                  <PlanReviewInterventions
                    mission={selectedMission}
                    onAllResolved={() => { void handleStartRun(); }}
                  />
                )}

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
                    runId={runGraph.run.id}
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
                    missionStatus={selectedMission?.status ?? null}
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
                    <MissionStateSummary runId={runGraph?.run.id ?? null} />
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

/* Re-export for compatibility: the page was previously a named export */
export { MissionsPage };
