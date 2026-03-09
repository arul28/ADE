import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Hash,
  CaretDown,
  Robot,
  TerminalWindow,
  ChatCircle,
  Crown,
  Wrench,
  UsersThree,
  SpinnerGap,
  Globe,
  CaretRight,
} from "@phosphor-icons/react";
import type {
  MissionAgentRuntimeConfig,
  OrchestratorChatThread,
  OrchestratorChatMessage,
  OrchestratorMetadata,
  OrchestratorTeamRuntimeState,
  OrchestratorWorkerState,
  OrchestratorChatTarget,
  ActiveAgentInfo,
  MissionStatus,
  OrchestratorRunStatus,
  TeamRuntimeConfig,
} from "../../../shared/types";
import { MentionInput, type MentionParticipant } from "../shared/MentionInput";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { useMissionPolling } from "./useMissionPolling";
import { MissionThreadMessageList } from "./MissionThreadMessageList";
import { formatMissionWorkerPresentation } from "./missionHelpers";

// ── Design tokens (aliases for backward compat) ──
const MONO = MONO_FONT;
const SANS = SANS_FONT;
const BG_MAIN = COLORS.cardBg;
const BG_SIDEBAR = "#1a1625";
const BG_PAGE = COLORS.pageBg;
const ACCENT = COLORS.accent;
const BORDER = "#2a2535";
const TEXT_PRIMARY = COLORS.textPrimary;
const TEXT_SECONDARY = COLORS.textSecondary;
const TEXT_MUTED = COLORS.textMuted;
const TEXT_DIM = COLORS.textDim;
const STATUS_GREEN = COLORS.success;
const STATUS_GRAY = "#6b7280";
const STATUS_RED = COLORS.danger;
const WARNING = COLORS.warning;

type ChannelKind = "global" | "orchestrator" | "teammate" | "worker";

type Channel = {
  id: string;
  kind: ChannelKind;
  label: string;
  fullLabel: string;
  threadId: string | null;
  status: "active" | "closed";
  stepKey: string | null;
  attemptId: string | null;
  unreadCount: number;
  phaseLabel: string | null;
};

type MissionChatV2Props = {
  missionId: string;
  missionStatus: MissionStatus | null;
  runId: string | null;
  runStatus: OrchestratorRunStatus | null;
  runMetadata: OrchestratorMetadata | null;
  jumpTarget: OrchestratorChatTarget | null;
  onJumpHandled: () => void;
};

const STATUS_DOT: Record<string, string> = {
  active: STATUS_GREEN,
  closed: STATUS_GRAY,
  failed: STATUS_RED,
};

const DELIVERY_STATE_COLOR: Record<string, string> = {
  delivered: STATUS_GREEN,
  failed: STATUS_RED,
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isStructuredSignalKind(kind: string | null): boolean {
  return kind === "text"
    || kind === "reasoning"
    || kind === "status"
    || kind === "done"
    || kind === "error"
    || kind === "approval_request"
    || kind === "plan"
    || kind === "user_message";
}

function looksLikeRawNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.length) return true;
  if (/^streaming(?:\.\.\.)?$/i.test(trimmed)) return true;
  if (/^usage$/i.test(trimmed)) return true;
  if (/^mcp:/i.test(trimmed)) return true;
  if (/^[\-dlcbps][rwx\-@+]{8,}/i.test(trimmed)) return true;
  if (/^[A-Z0-9 .:_()/-]{24,}$/.test(trimmed)) return true;
  // Single-token strings under 24 chars that look like identifiers or noise
  // tokens rather than prose. Allow strings with sentence-ending punctuation
  // (e.g. "Done.", "Error!") since those are genuine assistant responses.
  if (!/\s/.test(trimmed) && trimmed.length < 24 && !/[.!?]/.test(trimmed)) return true;
  if (/^[A-Za-z]+$/.test(trimmed) && trimmed.length < 24) return true;
  return false;
}

function isUsefulStructuredSignal(msg: OrchestratorChatMessage, kind: string, structured: Record<string, unknown>): boolean {
  if (kind === "plan" || kind === "approval_request" || kind === "user_message") return true;
  if (kind === "text" || kind === "reasoning") return !looksLikeRawNoise(msg.content);
  if (kind === "status") {
    const status = readString(structured.status)?.toLowerCase() ?? "";
    const message = readString(structured.message) ?? msg.content;
    if (status === "failed" || status === "interrupted") return true;
    return message.length > 0 && !looksLikeRawNoise(message);
  }
  if (kind === "error") {
    const errorMessage = readString(structured.message) ?? msg.content;
    return errorMessage.length > 0 && !looksLikeRawNoise(errorMessage);
  }
  if (kind === "done") return false;
  return isStructuredSignalKind(kind);
}

function isSignalMessage(msg: OrchestratorChatMessage): boolean {
  if (msg.visibility === "metadata_only") return false;
  if (msg.role === "user") return true;
  const metadata = readRecord(msg.metadata);
  const structured = readRecord(metadata?.structuredStream);
  const kind = readString(structured?.kind);
  if (kind) {
    return isUsefulStructuredSignal(msg, kind, structured ?? {});
  }
  const content = typeof msg.content === "string" ? msg.content : "";
  return !looksLikeRawNoise(content);
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: SANS,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: TEXT_MUTED,
};

function statusDotForWorker(state?: string): string {
  if (!state) return STATUS_GRAY;
  switch (state) {
    case "spawned":
    case "initializing":
    case "working":
    case "waiting_input":
      return STATUS_GREEN;
    case "completed":
    case "idle":
    case "disposed":
      return STATUS_GRAY;
    case "failed":
      return STATUS_RED;
    default:
      return STATUS_GRAY;
  }
}

function workerStatusToParticipantStatus(state?: string): "active" | "completed" | "failed" {
  if (!state) return "completed";
  switch (state) {
    case "spawned":
    case "initializing":
    case "working":
    case "waiting_input":
      return "active";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

type MentionTargetOption = MentionParticipant & {
  threadId: string | null;
  target: OrchestratorChatTarget | null;
  helper: string;
};

function normalizeMentionKey(value: string, fallback: string, used: Set<string>): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export const MissionChatV2 = React.memo(function MissionChatV2({
  missionId,
  missionStatus,
  runId,
  runStatus,
  runMetadata,
  jumpTarget,
  onJumpHandled,
}: MissionChatV2Props) {
  // ── State ──
  const [threads, setThreads] = useState<OrchestratorChatThread[]>([]);
  const [globalMessages, setGlobalMessages] = useState<OrchestratorChatMessage[]>([]);
  const [threadMessages, setThreadMessages] = useState<OrchestratorChatMessage[]>([]);
  const [workerStates, setWorkerStates] = useState<OrchestratorWorkerState[]>([]);
  const [activeAgents, setActiveAgents] = useState<ActiveAgentInfo[]>([]);
  const [teamRuntimeState, setTeamRuntimeState] = useState<OrchestratorTeamRuntimeState | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("global");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [globalViewMode, setGlobalViewMode] = useState<"signal" | "raw">("signal");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [completedCollapsed, setCompletedCollapsed] = useState(false);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedChannelIdRef = useRef<string>("global");
  const threadRefreshTimerRef = useRef<number | null>(null);
  const messageRefreshTimerRef = useRef<number | null>(null);
  const channelsRef = useRef<Channel[]>([]);

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
  }, [selectedChannelId]);

  // ── Build channel list from threads ──
  const channels = useMemo<Channel[]>(() => {
    const result: Channel[] = [];

    // Global channel is always first
    result.push({
      id: "global",
      kind: "global",
      label: "Global",
      fullLabel: "Global",
      threadId: null,
      status: "active",
      stepKey: null,
      attemptId: null,
      unreadCount: 0,
      phaseLabel: null,
    });

    // Coordinator thread
    const coordThread = threads.find((t) => t.threadType === "coordinator");
    if (coordThread) {
      result.push({
        id: `thread:${coordThread.id}`,
        kind: "orchestrator",
        label: "Orchestrator",
        fullLabel: "Orchestrator",
        threadId: coordThread.id,
        status: coordThread.status,
        stepKey: null,
        attemptId: null,
        unreadCount: coordThread.unreadCount,
        phaseLabel: null,
      });
    }

    // Teammate threads
    const teammateThreads = threads.filter((t) => t.threadType === "teammate");
    for (const t of teammateThreads) {
      result.push({
        id: `thread:${t.id}`,
        kind: "teammate",
        label: t.title || "Teammate",
        fullLabel: t.title || "Teammate",
        threadId: t.id,
        status: t.status,
        stepKey: t.stepKey ?? null,
        attemptId: t.attemptId ?? null,
        unreadCount: t.unreadCount,
        phaseLabel: null,
      });
    }

    // Worker threads
    const workerThreads = threads.filter((t) => t.threadType === "worker");
    for (const t of workerThreads) {
      const presentation = formatMissionWorkerPresentation({
        title: t.title,
        stepKey: t.stepKey ?? null,
      });
      result.push({
        id: `thread:${t.id}`,
        kind: "worker",
        label: presentation.label,
        fullLabel: presentation.fullLabel,
        threadId: t.id,
        status: t.status,
        stepKey: t.stepKey ?? null,
        attemptId: t.attemptId ?? null,
        unreadCount: t.unreadCount,
        phaseLabel: presentation.phaseLabel,
      });
    }

    return result;
  }, [threads]);

  const teammateChannels = useMemo(
    () => channels.filter((c) => c.kind === "teammate"),
    [channels]
  );

  const activeWorkerChannels = useMemo(
    () => channels.filter((c) => c.kind === "worker" && c.status === "active"),
    [channels]
  );

  const completedWorkerChannels = useMemo(
    () => channels.filter((c) => c.kind === "worker" && c.status !== "active"),
    [channels]
  );

  const orchestratorChannel = useMemo(
    () => channels.find((c) => c.kind === "orchestrator") ?? null,
    [channels]
  );

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) ?? channels[0],
    [channels, selectedChannelId]
  );

  // ── Build mention targets for MentionInput + quick-target chips ──
  const mentionTargets = useMemo<MentionTargetOption[]>(() => {
    const used = new Set<string>(["orchestrator", "all"]);
    const coordinatorThread = channels.find((channel) => channel.kind === "orchestrator") ?? null;
    const result: MentionTargetOption[] = [
      {
        id: "orchestrator",
        label: "orchestrator",
        status: "active",
        role: "orchestrator",
        threadId: coordinatorThread?.threadId ?? null,
        target: { kind: "coordinator", runId: runId ?? null },
        helper: "Message the coordinator",
      },
      {
        id: "all",
        label: "all",
        status: "active",
        role: "broadcast",
        threadId: coordinatorThread?.threadId ?? null,
        target: { kind: "workers", runId: runId ?? null, includeClosed: false },
        helper: "Broadcast to active workers",
      },
    ];

    for (const ch of channels) {
      if (ch.kind === "teammate") {
        const mentionId = normalizeMentionKey(ch.label, `teammate-${result.length}`, used);
        const thread = threads.find((entry) => entry.id === ch.threadId) ?? null;
        const teamMemberId = thread && typeof (thread as { teamMemberId?: unknown }).teamMemberId === "string"
          ? (thread as { teamMemberId?: string }).teamMemberId ?? null
          : null;
        result.push({
          id: mentionId,
          label: ch.label,
          status: ch.status === "active" ? "active" : "completed",
          role: "teammate",
          threadId: ch.threadId,
          target: { kind: "teammate", runId: thread?.runId ?? runId ?? null, teamMemberId, sessionId: thread?.sessionId ?? null },
          helper: "Message this teammate directly",
        });
      } else if (ch.kind === "worker") {
        const agentInfo = activeAgents.find((agent) => agent.attemptId === ch.attemptId);
        if (workerStatusToParticipantStatus(agentInfo?.state) !== "active") continue;
        const rawLabel = ch.fullLabel;
        const mentionId = normalizeMentionKey(rawLabel, `worker-${result.length}`, used);
        const thread = threads.find((entry) => entry.id === ch.threadId) ?? null;
        result.push({
          id: mentionId,
          label: rawLabel,
          status: workerStatusToParticipantStatus(agentInfo?.state),
          role: "worker",
          threadId: ch.threadId,
          target: {
            kind: "worker",
            runId: thread?.runId ?? runId ?? null,
            stepId: thread?.stepId ?? null,
            stepKey: thread?.stepKey ?? null,
            attemptId: thread?.attemptId ?? null,
            sessionId: thread?.sessionId ?? null,
            laneId: thread?.laneId ?? null,
          },
          helper: "Message this worker directly",
        });
      }
    }

    return result;
  }, [activeAgents, channels, runId, threads]);

  const participants = useMemo<MentionParticipant[]>(
    () => mentionTargets.map(({ id, label, status, role }) => ({ id, label, status, role })),
    [mentionTargets],
  );

  const mentionTargetMap = useMemo(() => {
    const map = new Map<string, MentionTargetOption>();
    for (const target of mentionTargets) map.set(target.id, target);
    return map;
  }, [mentionTargets]);

  // Keep channelsRef in sync so event handlers don't need channels as a dependency
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  // ── Worker state map ──
  const workerStateByAttempt = useMemo(() => {
    const map = new Map<string, OrchestratorWorkerState>();
    for (const s of workerStates) {
      map.set(s.attemptId, s);
    }
    return map;
  }, [workerStates]);

  // ── Data fetching ──
  const refreshThreads = useCallback(async () => {
    try {
      const nextThreads = await window.ade.orchestrator.listChatThreads({ missionId, includeClosed: true });
      setThreads(nextThreads);
    } catch {
      // ignore
    }
  }, [missionId]);

  const refreshGlobalMessages = useCallback(async () => {
    try {
      const msgs = await window.ade.orchestrator.getGlobalChat({ missionId, limit: 200 });
      setGlobalMessages(msgs);
    } catch {
      // ignore — API may not be available yet
    }
  }, [missionId]);

  const refreshThreadMessages = useCallback(
    async (threadId?: string | null) => {
      const resolvedId = threadId ?? null;
      if (!resolvedId) {
        setThreadMessages([]);
        return;
      }
      try {
        const msgs = await window.ade.orchestrator.getThreadMessages({
          missionId,
          threadId: resolvedId,
          limit: 200,
        });
        setThreadMessages(msgs);
      } catch {
        // ignore
      }
    },
    [missionId]
  );

  const refreshWorkers = useCallback(async () => {
    try {
      const [states, agents, runtimeState] = await Promise.all([
        runId
          ? window.ade.orchestrator.getWorkerStates({ runId })
          : Promise.resolve([] as OrchestratorWorkerState[]),
        window.ade.orchestrator.getActiveAgents({ missionId }),
        runId
          ? window.ade.orchestrator.getTeamRuntimeState({ runId }).catch(() => null)
          : Promise.resolve(null),
      ]);
      setWorkerStates(states);
      setActiveAgents(agents);
      setTeamRuntimeState(runtimeState);
    } catch {
      // ignore
    }
  }, [missionId, runId]);

  // ── Initial load ──
  useEffect(() => {
    void refreshThreads();
    void refreshGlobalMessages();
    void refreshWorkers();
  }, [refreshThreads, refreshGlobalMessages, refreshWorkers]);

  // ── Polling via shared coordinator (replaces per-component setInterval) ──
  const pollAll = useCallback(() => {
    void refreshThreads();
    void refreshGlobalMessages();
    void refreshWorkers();
  }, [refreshThreads, refreshGlobalMessages, refreshWorkers]);

  useMissionPolling(pollAll, 10_000);

  // ── Load messages when channel changes ──
  useEffect(() => {
    if (selectedChannel?.kind === "global") {
      void refreshGlobalMessages();
    } else if (selectedChannel?.threadId) {
      void refreshThreadMessages(selectedChannel.threadId);
    }
  }, [selectedChannel, refreshGlobalMessages, refreshThreadMessages]);

  // ── Real-time events ──
  // Use refs for callbacks to avoid tearing down the event subscription on every poll cycle.
  // Previously, `channels` in the dep array caused this effect to re-run every time threads
  // refreshed (every 10s + events), which tore down and recreated the IPC listener each time.
  const refreshThreadsRef = useRef(refreshThreads);
  const refreshGlobalMessagesRef = useRef(refreshGlobalMessages);
  const refreshThreadMessagesRef = useRef(refreshThreadMessages);
  useEffect(() => { refreshThreadsRef.current = refreshThreads; }, [refreshThreads]);
  useEffect(() => { refreshGlobalMessagesRef.current = refreshGlobalMessages; }, [refreshGlobalMessages]);
  useEffect(() => { refreshThreadMessagesRef.current = refreshThreadMessages; }, [refreshThreadMessages]);

  useEffect(() => {
    const unsubThread = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.missionId !== missionId) return;

      if (
        event.type === "thread_updated" ||
        event.type === "message_appended" ||
        event.type === "message_updated" ||
        event.type === "worker_replay"
      ) {
        // Debounce thread refresh
        if (threadRefreshTimerRef.current !== null) {
          window.clearTimeout(threadRefreshTimerRef.current);
        }
        threadRefreshTimerRef.current = window.setTimeout(() => {
          threadRefreshTimerRef.current = null;
          void refreshThreadsRef.current();
        }, 120);

        // Refresh messages for current channel
        if (messageRefreshTimerRef.current !== null) {
          window.clearTimeout(messageRefreshTimerRef.current);
        }
        messageRefreshTimerRef.current = window.setTimeout(() => {
          messageRefreshTimerRef.current = null;
          const currentCh = selectedChannelIdRef.current;
          if (currentCh === "global") {
            void refreshGlobalMessagesRef.current();
          } else {
            const ch = channelsRef.current.find((c) => c.id === currentCh);
            if (ch?.threadId && (!event.threadId || event.threadId === ch.threadId)) {
              void refreshThreadMessagesRef.current(ch.threadId);
            }
          }
        }, 100);
      }
    });

    return () => {
      unsubThread();
      if (threadRefreshTimerRef.current !== null) window.clearTimeout(threadRefreshTimerRef.current);
      if (messageRefreshTimerRef.current !== null) window.clearTimeout(messageRefreshTimerRef.current);
    };
  }, [missionId]); // Only re-subscribe when missionId changes

  // ── Jump target handling ──
  useEffect(() => {
    if (!jumpTarget) return;
    setJumpNotice(null);

    if (jumpTarget.kind === "worker") {
      if (jumpTarget.attemptId) {
        setSelectedChannelId(`thread:worker:${missionId}:${jumpTarget.attemptId}`);
        onJumpHandled();
        return;
      }
      if (threads.length === 0) return;
      const workerThread = threads.find(
        (t) =>
          t.threadType === "worker" &&
          ((jumpTarget.attemptId && t.attemptId === jumpTarget.attemptId) ||
            (jumpTarget.stepId && t.stepId === jumpTarget.stepId) ||
            (jumpTarget.sessionId && t.sessionId === jumpTarget.sessionId) ||
            (jumpTarget.stepKey && t.stepKey === jumpTarget.stepKey))
      );
      if (workerThread) {
        setSelectedChannelId(`thread:${workerThread.id}`);
      } else {
        const coordThread = threads.find((t) => t.threadType === "coordinator");
        if (coordThread) {
          setSelectedChannelId(`thread:${coordThread.id}`);
        } else {
          setSelectedChannelId("global");
        }
        setJumpNotice("ADE has not hydrated that worker thread yet, so I landed you on the coordinator instead.");
      }
    } else if (jumpTarget.kind === "teammate") {
      if (threads.length === 0) return;
      const teammateThread = threads.find((t) => t.threadType === "teammate");
      if (teammateThread) {
        setSelectedChannelId(`thread:${teammateThread.id}`);
      }
    } else {
      const coordThread = threads.find((t) => t.threadType === "coordinator");
      if (coordThread) {
        setSelectedChannelId(`thread:${coordThread.id}`);
      }
    }
    onJumpHandled();
  }, [jumpTarget, onJumpHandled, threads]);

  useEffect(() => {
    if (selectedChannel?.kind !== "worker" && selectedChannel?.kind !== "orchestrator") return;
    if (threadMessages.length > 0) {
      setJumpNotice(null);
    }
  }, [selectedChannel, threadMessages.length]);

  // ── Auto-scroll ──
  useEffect(() => {
    if (scrollRef.current && !showJumpToLatest) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [globalMessages.length, threadMessages.length, selectedChannelId, showJumpToLatest]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowJumpToLatest(scrollHeight - scrollTop - clientHeight > 100);
  }, []);

  const jumpToLatest = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
    setShowJumpToLatest(false);
  }, []);

  // ── Displayed messages ──
  const displayMessages = useMemo(() => {
    let msgs: OrchestratorChatMessage[];
    if (selectedChannel?.kind === "global") {
      msgs = [...globalMessages].sort(
        (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
      );
      msgs = msgs.filter((msg) => {
        const metadata = readRecord(msg.metadata);
        if (metadata?.missionChatMode !== "thread_only") return true;
        const target = msg.target;
        if (target?.kind === "coordinator") return true;
        return msg.threadId === `mission:${missionId}`;
      });
      if (globalViewMode === "signal") {
        msgs = msgs.filter((msg) => isSignalMessage(msg));
      }
    } else {
      msgs = threadMessages;
      if (selectedChannel?.kind === "worker" || selectedChannel?.kind === "orchestrator") {
        msgs = msgs.filter((msg) => isSignalMessage(msg));
      }
    }
    return msgs;
  }, [selectedChannel, globalMessages, threadMessages, missionId, globalViewMode]);

  // ── Attempt name map ──
  const attemptNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of threads) {
      if (t.attemptId) {
        map.set(t.attemptId, t.title || (t.threadType === "coordinator" ? "Orchestrator" : "Worker"));
      }
    }
    return map;
  }, [threads]);

  const chatBlocked = useMemo(() => {
    if (missionStatus === "completed" || missionStatus === "failed" || missionStatus === "canceled") {
      return {
        reason: "Mission run is closed.",
        action: "Start or rerun the mission to continue chat.",
      };
    }
    if (!runId || !runStatus) {
      return {
        reason: "Orchestrator runtime is offline.",
        action: "Start the mission run to send directives.",
      };
    }
    if (runStatus === "queued" || runStatus === "bootstrapping") {
      return {
        reason: "Orchestrator runtime is starting.",
        action: "Wait for readiness, then send directives.",
      };
    }
    if (selectedChannel?.kind === "worker") {
      const workerState = selectedChannel.attemptId
        ? workerStateByAttempt.get(selectedChannel.attemptId)?.state
        : undefined;
      if (
        selectedChannel.status !== "active"
        || workerState === "completed"
        || workerState === "failed"
        || workerState === "disposed"
      ) {
        return {
          reason: "This worker is no longer running.",
          action: "Read the thread for history, or message @orchestrator to redirect the mission.",
        };
      }
    }
    if (runStatus === "paused" || missionStatus === "intervention_required") {
      return {
        reason: "Mission is waiting on an intervention.",
        action: "Resolve the open intervention, then continue from the coordinator or an active worker.",
      };
    }
    if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "canceled") {
      return {
        reason: "Run is in a terminal state.",
        action: "Start a new run to continue chat.",
      };
    }
    return null;
  }, [missionStatus, runId, runStatus, selectedChannel, workerStateByAttempt]);

  const selectedThreadShowStreamingIndicator = useMemo(() => {
    if (selectedChannel?.kind !== "worker" || !selectedChannel.attemptId) return false;
    const state = workerStateByAttempt.get(selectedChannel.attemptId)?.state;
    return state === "initializing" || state === "working";
  }, [selectedChannel, workerStateByAttempt]);

  const teamRuntimeConfig = useMemo(() => {
    const metadata = readRecord(runMetadata);
    const runtime = readRecord(metadata?.teamRuntime);
    if (!runtime) return null;
    return {
      enabled: runtime.enabled === true,
      targetProvider:
        runtime.targetProvider === "claude" || runtime.targetProvider === "codex"
          ? runtime.targetProvider
          : "auto",
      teammateCount: Number.isFinite(Number(runtime.teammateCount))
        ? Math.max(0, Math.floor(Number(runtime.teammateCount)))
        : 0,
      allowParallelAgents: runtime.allowParallelAgents !== false,
      allowSubAgents: runtime.allowSubAgents !== false,
      allowClaudeAgentTeams: runtime.allowClaudeAgentTeams !== false,
    } satisfies TeamRuntimeConfig;
  }, [runMetadata]);

  const agentRuntimeConfig = useMemo(() => {
    const metadata = readRecord(runMetadata);
    const runtime = readRecord(metadata?.agentRuntime);
    if (!runtime && !teamRuntimeConfig) return null;
    return {
      allowParallelAgents:
        typeof runtime?.allowParallelAgents === "boolean"
          ? runtime.allowParallelAgents
          : teamRuntimeConfig?.allowParallelAgents !== false,
      allowSubAgents:
        typeof runtime?.allowSubAgents === "boolean"
          ? runtime.allowSubAgents
          : teamRuntimeConfig?.allowSubAgents !== false,
      allowClaudeAgentTeams:
        typeof runtime?.allowClaudeAgentTeams === "boolean"
          ? runtime.allowClaudeAgentTeams
          : teamRuntimeConfig?.allowClaudeAgentTeams !== false,
    } satisfies MissionAgentRuntimeConfig;
  }, [runMetadata, teamRuntimeConfig]);

  const quickTargets = useMemo(
    () => mentionTargets.filter((target) => target.id === "orchestrator" || target.id === "all" || target.status === "active").slice(0, 8),
    [mentionTargets],
  );

  const appendMentionTarget = useCallback((targetId: string) => {
    setInput((prev) => {
      const token = `@${targetId}`;
      if (prev.includes(token)) return prev;
      const base = prev.trimEnd();
      return `${base}${base.length ? " " : ""}${token} `;
    });
  }, []);

  const runtimeSummary = useMemo(() => {
    if (teamRuntimeConfig?.enabled) {
      const teammateCount = teamRuntimeState?.teammateIds.length ?? teamRuntimeConfig.teammateCount ?? 0;
      const providerLabel = teamRuntimeConfig.targetProvider === "auto"
        ? "auto"
        : teamRuntimeConfig.targetProvider;
      return {
        title: "Team runtime",
        detail: `${teamRuntimeState?.phase ?? "bootstrapping"} · ${teammateCount} teammate${teammateCount === 1 ? "" : "s"} · ${providerLabel}`,
      };
    }
    if (agentRuntimeConfig) {
      return {
        title: "Coordinator chat",
        detail: "Direct worker targeting is available from here.",
      };
    }
    return null;
  }, [agentRuntimeConfig, teamRuntimeConfig, teamRuntimeState]);

  // ── Send message ──
  const handleSend = useCallback(
    async (message: string, mentions: string[]) => {
      if (sending || !message.trim() || chatBlocked) return;
      setSending(true);
      try {
        if (selectedChannel?.kind === "global" || mentions.length > 0) {
          const coordThread = threads.find((t) => t.threadType === "coordinator");
          if (coordThread) {
            const mentionTarget = mentions
              .map((mention) => mentionTargetMap.get(mention))
              .find((entry) => entry?.target != null) ?? null;
            const target: OrchestratorChatTarget = mentionTarget?.target
              ?? { kind: "coordinator", runId: runId ?? null };
            await window.ade.orchestrator.sendThreadMessage({
              missionId,
              threadId: mentionTarget?.threadId ?? coordThread.id,
              content: message,
              target,
            });
          }
        } else if (selectedChannel?.threadId) {
          const thread = threads.find((t) => t.id === selectedChannel.threadId);
          let target: OrchestratorChatTarget;
          if (thread?.threadType === "worker") {
            target = {
              kind: "worker",
              runId: thread.runId ?? runId ?? null,
              stepId: thread.stepId ?? null,
              stepKey: thread.stepKey ?? null,
              attemptId: thread.attemptId ?? null,
              sessionId: thread.sessionId ?? null,
              laneId: thread.laneId ?? null,
            };
          } else if (thread?.threadType === "teammate") {
            target = {
              kind: "teammate",
              runId: thread.runId ?? runId ?? null,
              teamMemberId: (thread as OrchestratorChatThread & { teamMemberId?: string }).teamMemberId ?? null,
            };
          } else {
            target = { kind: "coordinator", runId: runId ?? null };
          }

          await window.ade.orchestrator.sendThreadMessage({
            missionId,
            threadId: selectedChannel.threadId,
            content: message,
            target,
          });
        }

        setInput("");

        // Refresh after send
        await Promise.all([refreshThreads(), refreshGlobalMessages()]);
        if (selectedChannel?.threadId) {
          await refreshThreadMessages(selectedChannel.threadId);
        }
      } catch (err) {
        console.error("[MissionChatV2] handleSend failed:", err);
      } finally {
        setSending(false);
      }
    },
    [chatBlocked, mentionTargetMap, sending, selectedChannel, threads, missionId, runId, refreshThreads, refreshGlobalMessages, refreshThreadMessages]
  );

  const handleApproval = useCallback(
    async (
      sessionId: string,
      itemId: string,
      decision: "accept" | "accept_for_session" | "decline" | "cancel",
      responseText?: string | null,
    ) => {
      try {
        await window.ade.agentChat.approve({ sessionId, itemId, decision, responseText });
        setJumpNotice(null);
        await Promise.all([refreshThreads(), refreshGlobalMessages()]);
        if (selectedChannel?.threadId) {
          await refreshThreadMessages(selectedChannel.threadId);
        }
      } catch (error) {
        setJumpNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [refreshGlobalMessages, refreshThreadMessages, refreshThreads, selectedChannel]
  );

  // ── Channel name for header ──
  const channelHeaderName = (() => {
    if (!selectedChannel) return "...";
    switch (selectedChannel.kind) {
      case "global": return "Global";
      case "orchestrator": return "Orchestrator";
      default: return selectedChannel.fullLabel;
    }
  })();

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar ── */}
      <aside
        className="flex w-[160px] shrink-0 flex-col"
        style={{ background: BG_SIDEBAR, borderRight: `1px solid ${BORDER}` }}
      >
        <div className="px-2.5 py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
          <div className="flex items-center justify-between gap-2">
            <div style={{ ...LABEL_STYLE, color: TEXT_PRIMARY }}>Conversations</div>
            {selectedChannel?.kind === "global" && (
              <div className="flex items-center gap-1">
                {(["signal", "raw"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setGlobalViewMode(mode)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
                    style={{
                      background: globalViewMode === mode ? `${ACCENT}18` : "transparent",
                      color: globalViewMode === mode ? ACCENT : TEXT_MUTED,
                      border: `1px solid ${globalViewMode === mode ? `${ACCENT}30` : BORDER}`,
                    }}
                  >
                    {mode === "signal" ? "Signal" : "Raw"}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {/* Global channel */}
          <ChannelButton
            icon={<Globe size={12} weight="regular" />}
            label="Global"
            statusColor={STATUS_GREEN}
            isSelected={selectedChannelId === "global"}
            onClick={() => setSelectedChannelId("global")}
            unreadCount={0}
          />

          {/* Orchestrator section */}
          {orchestratorChannel && (
            <>
              <SectionLabel>ORCHESTRATOR</SectionLabel>
              <ChannelButton
                icon={<Crown size={12} weight="fill" />}
                label="Orchestrator"
                statusColor={STATUS_DOT[orchestratorChannel.status] ?? STATUS_GRAY}
                isSelected={selectedChannelId === orchestratorChannel.id}
                onClick={() => setSelectedChannelId(orchestratorChannel.id)}
                unreadCount={orchestratorChannel.unreadCount}
                badge="orchestrator"
                badgeColor="#3B82F6"
              />
            </>
          )}

          {/* Teammates */}
          {teammateChannels.length > 0 && (
            <>
              <SectionLabel>TEAMMATES</SectionLabel>
              {teammateChannels.map((ch) => (
                <ChannelButton
                  key={ch.id}
                  icon={<UsersThree size={12} weight="fill" />}
                  label={ch.label}
                  statusColor={STATUS_DOT[ch.status] ?? STATUS_GRAY}
                  isSelected={selectedChannelId === ch.id}
                  onClick={() => setSelectedChannelId(ch.id)}
                  unreadCount={ch.unreadCount}
                  badge="teammate"
                  badgeColor="#06B6D4"
                />
              ))}
            </>
          )}

          {/* Active workers */}
          {activeWorkerChannels.length > 0 && (
            <>
              <SectionLabel>ACTIVE</SectionLabel>
              {activeWorkerChannels.map((ch) => (
                <ChannelButton
                  key={ch.id}
                  icon={<Wrench size={12} weight="fill" />}
                  label={ch.label}
                  statusColor={
                    ch.attemptId
                      ? statusDotForWorker(workerStateByAttempt.get(ch.attemptId)?.state)
                      : STATUS_GREEN
                  }
                  isSelected={selectedChannelId === ch.id}
                  onClick={() => setSelectedChannelId(ch.id)}
                  unreadCount={ch.unreadCount}
                  badge={ch.phaseLabel ?? undefined}
                />
              ))}
            </>
          )}

          {/* Completed workers */}
          {completedWorkerChannels.length > 0 && (
            <>
              <button
                className="flex w-full items-center gap-1 px-2 pt-2 pb-0.5"
                style={{ ...LABEL_STYLE }}
                onClick={() => setCompletedCollapsed((prev) => !prev)}
              >
                <CaretRight
                  size={10}
                  weight="bold"
                  style={{
                    transform: completedCollapsed ? "rotate(0deg)" : "rotate(90deg)",
                    transition: "transform 100ms",
                  }}
                />
                COMPLETED ({completedWorkerChannels.length})
              </button>
              {!completedCollapsed &&
                completedWorkerChannels.map((ch) => (
                  <ChannelButton
                    key={ch.id}
                    icon={<Wrench size={12} weight="regular" />}
                    label={ch.label}
                    statusColor={STATUS_GRAY}
                    isSelected={selectedChannelId === ch.id}
                    onClick={() => setSelectedChannelId(ch.id)}
                    unreadCount={ch.unreadCount}
                    badge={ch.phaseLabel ?? undefined}
                  />
                ))}
            </>
          )}

          {channels.length <= 1 && (
            <div className="px-2 py-4 text-center text-[10px]" style={{ color: TEXT_MUTED }}>
              No worker channels yet
            </div>
          )}
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: BG_PAGE }}>
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-1"
          style={{ borderBottom: `1px solid ${BORDER}` }}
        >
          <Hash size={14} weight="regular" style={{ color: TEXT_MUTED }} />
          <span className="min-w-0 truncate text-[11px] font-semibold" style={{ color: TEXT_PRIMARY, fontFamily: MONO }}>
            {channelHeaderName}
          </span>
          {selectedChannel && selectedChannel.kind !== "global" && (
            <span
              className="ml-1 inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor:
                  selectedChannel.kind === "orchestrator"
                    ? STATUS_DOT[selectedChannel.status] ?? STATUS_GRAY
                    : selectedChannel.attemptId
                      ? statusDotForWorker(workerStateByAttempt.get(selectedChannel.attemptId)?.state)
                      : STATUS_DOT[selectedChannel.status] ?? STATUS_GRAY,
              }}
            />
          )}
          {selectedChannel?.kind === "orchestrator" && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
              style={{ background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" }}
            >
              <Crown size={10} weight="fill" />
              Orchestrator
            </span>
          )}
          {selectedChannel?.kind === "teammate" && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
              style={{ background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430" }}
            >
              <UsersThree size={10} weight="fill" />
              Teammate
            </span>
          )}
          {selectedChannel?.kind === "worker" && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
              style={{ background: "#8B5CF618", color: "#8B5CF6", border: "1px solid #8B5CF630" }}
            >
              <Wrench size={10} weight="fill" />
              {selectedChannel.status === "active"
                ? (selectedChannel.phaseLabel ? `${selectedChannel.phaseLabel} worker` : "Active worker")
                : (selectedChannel.phaseLabel ? `${selectedChannel.phaseLabel} history` : "Worker history")}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {runtimeSummary && selectedChannel?.kind === "global" && (
              <span
                className="hidden items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px] lg:inline-flex"
                style={{
                  background: `${ACCENT}10`,
                  color: TEXT_SECONDARY,
                  border: `1px solid ${ACCENT}18`,
                  fontFamily: MONO,
                }}
                title={runtimeSummary.detail}
              >
                <Globe size={10} weight="fill" />
                {runtimeSummary.title}
              </span>
            )}
            {agentRuntimeConfig && selectedChannel?.kind !== "worker" && (
              <>
                <RuntimeFlagPill label="Parallel" enabled={agentRuntimeConfig.allowParallelAgents} />
                <RuntimeFlagPill label="Sub-agents" enabled={agentRuntimeConfig.allowSubAgents} />
                <RuntimeFlagPill label="Claude teams" enabled={agentRuntimeConfig.allowClaudeAgentTeams} />
              </>
            )}
          </div>
        </div>

        {jumpNotice && (
          <div
            className="px-3 py-1.5 text-[10px]"
            style={{ borderBottom: `1px solid ${WARNING}30`, background: `${WARNING}12`, color: WARNING }}
          >
            {jumpNotice}
          </div>
        )}

        {/* Runtime availability banner */}
        {chatBlocked && (
          <div
            style={{
              background: `${WARNING}12`,
              borderBottom: `1px solid ${WARNING}30`,
              padding: "6px 12px",
              fontFamily: MONO,
              fontSize: "10px",
              color: WARNING,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span style={{ fontSize: "14px" }}>{"\u26A0"}</span>
            <span>{chatBlocked.reason} {chatBlocked.action}</span>
          </div>
        )}

        {/* Message list */}
        <MissionThreadMessageList
          messages={displayMessages}
          showStreamingIndicator={selectedChannel?.kind === "global" ? false : selectedThreadShowStreamingIndicator}
          className="flex-1"
          onApproval={handleApproval}
        />

        {/* Input bar */}
        <div style={{ borderTop: `1px solid ${BORDER}` }}>
          {quickTargets.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-1 px-3 py-1.5"
              style={{ borderBottom: `1px solid ${BORDER}`, background: BG_MAIN }}
            >
              <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Targets</span>
              {quickTargets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => appendMentionTarget(target.id)}
                  disabled={sending || Boolean(chatBlocked)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-90 disabled:opacity-50"
                  style={{
                    background: `${ACCENT}10`,
                    border: `1px solid ${ACCENT}18`,
                    color: TEXT_PRIMARY,
                    fontFamily: MONO,
                  }}
                  title={target.helper}
                >
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: target.status === "failed" ? STATUS_RED : target.status === "completed" ? STATUS_GRAY : STATUS_GREEN }}
                  />
                  <span>@{target.id}</span>
                  {target.label !== target.id && (
                    <span style={{ color: TEXT_MUTED }}>{target.label}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {selectedChannel?.kind === "worker" && !chatBlocked && (
            <div
              className="px-3 py-1.5 text-[10px]"
              style={{ borderBottom: `1px solid ${BORDER}`, background: BG_MAIN, color: TEXT_MUTED, fontFamily: MONO }}
            >
              Messages here steer the active worker. If it is between turns, ADE keeps the note queued on this worker thread until the worker can pick it up.
            </div>
          )}
          <MentionInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            participants={participants}
            placeholder={(() => {
              switch (selectedChannel?.kind) {
                case "global": return "Message global (use @mention to target)...";
                case "orchestrator": return "Message the orchestrator...";
                case "teammate": return `Message teammate ${selectedChannel?.label ?? ""}...`;
                case "worker":
                  return selectedChannel.status === "active"
                    ? `Steer worker ${selectedChannel?.label ?? ""}...`
                    : `This worker thread is history-only...`;
                default: return `Message ${selectedChannel?.fullLabel ?? "worker"}...`;
              }
            })()}
            disabled={sending || Boolean(chatBlocked)}
            autoFocus
          />
          {sending && (
            <div className="flex items-center gap-1 px-3 pb-1 text-[10px]" style={{ color: TEXT_MUTED }}>
              <SpinnerGap size={10} className="animate-spin" />
              Sending...
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ── Sidebar components ──

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-2 pt-2 pb-0.5"
      style={{
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "'Space Grotesk', sans-serif",
        textTransform: "uppercase",
        letterSpacing: "1px",
        color: TEXT_DIM,
      }}
    >
      {children}
    </div>
  );
}

function RuntimeFlagPill({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
      style={{
        background: enabled ? "#22C55E18" : "#6B728018",
        color: enabled ? "#22C55E" : TEXT_MUTED,
        border: `1px solid ${enabled ? "#22C55E30" : "#6B728030"}`,
      }}
    >
      {label}
      <span>{enabled ? "on" : "off"}</span>
    </span>
  );
}

function ChannelButton({
  icon,
  label,
  statusColor,
  isSelected,
  onClick,
  unreadCount,
  badge,
  badgeColor,
}: {
  icon: React.ReactNode;
  label: string;
  statusColor: string;
  isSelected: boolean;
  onClick: () => void;
  unreadCount: number;
  badge?: string;
  badgeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left transition-colors"
      style={
        isSelected
          ? { background: `${ACCENT}12`, borderLeft: `3px solid ${ACCENT}`, color: TEXT_PRIMARY }
          : { color: TEXT_MUTED }
      }
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "#1A1720";
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <div className="flex w-full items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: statusColor }}
        />
        <span className="shrink-0" style={{ color: isSelected ? ACCENT : TEXT_MUTED }}>
          {icon}
        </span>
        <span className="truncate text-[11px]">{label}</span>
        {unreadCount > 0 && (
          <span
            className="ml-auto shrink-0 px-1 py-0.5 text-[9px] font-semibold"
            style={{ background: ACCENT, color: BG_PAGE }}
          >
            {unreadCount}
          </span>
        )}
      </div>
      {badge && (
        <div className="flex items-center gap-1 pl-5">
          {badge && badgeColor && (
            <span
              className="inline-flex items-center gap-0.5 px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
              style={{ background: `${badgeColor}18`, color: badgeColor, border: `1px solid ${badgeColor}30` }}
            >
              {badge}
            </span>
          )}
          {badge && !badgeColor && (
            <span
              className="inline-flex items-center px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
              style={{ background: `${ACCENT}12`, color: ACCENT, border: `1px solid ${ACCENT}25` }}
            >
              {badge}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ── Message rendering ──

const MessageBubble = React.memo(function MessageBubble({
  msg,
  attemptNameMap,
  isGlobalView,
}: {
  msg: OrchestratorChatMessage;
  attemptNameMap: Map<string, string>;
  isGlobalView: boolean;
}) {
  const isUser = msg.role === "user";
  const isAgent = msg.role === "agent";
  const isWorker = msg.role === "worker";
  const isOrchestrator = msg.role === "orchestrator";
  const isInterAgent = isAgent && msg.target?.kind === "agent";

  const isToolCall = msg.content.startsWith("Tool call:") || msg.content.startsWith("tool_use:");
  const isFileEdit = msg.content.includes("--- a/") || msg.content.includes("+++ b/");
  const isBudgetWarning = /MISSION PAUSED|budget|hard cap|Budget pressure/i.test(msg.content);
  const metadata = useMemo(() => (
    msg.metadata && typeof msg.metadata === "object" && !Array.isArray(msg.metadata)
      ? (msg.metadata as Record<string, unknown>)
      : {}
  ), [msg.metadata]);
  const structuredStream = useMemo(() => readRecord(metadata.structuredStream), [metadata]);
  const structuredKind = typeof structuredStream?.kind === "string" ? structuredStream.kind.trim() : "";
  const systemSignal = typeof metadata.systemSignal === "string" ? metadata.systemSignal.trim() : "";
  const isValidationSystemSignal = systemSignal.startsWith("validation_");
  const [expanded, setExpanded] = useState(false);

  const timestampStyle: React.CSSProperties = {
    color: TEXT_DIM,
    fontFamily: MONO,
    fontSize: "9px",
  };

  // Determine sender label for global view
  const senderLabel = useMemo(() => {
    if (isUser) return "You";
    if (isOrchestrator) return "Orchestrator";
    if (isAgent) {
      const srcId = msg.target && "sourceAttemptId" in msg.target ? msg.target.sourceAttemptId : null;
      return (srcId && attemptNameMap.get(srcId)) || msg.stepKey || "Agent";
    }
    return msg.stepKey || "Worker";
  }, [isUser, isOrchestrator, isAgent, msg, attemptNameMap]);

  const targetLabel = useMemo(() => {
    if (!msg.target) return null;
    if (msg.target.kind === "coordinator") return "Orchestrator";
    if (msg.target.kind === "workers") return "All Workers";
    if (msg.target.kind === "worker") return msg.target.stepKey || "Worker";
    if (msg.target.kind === "agent" && "targetAttemptId" in msg.target) {
      return attemptNameMap.get(msg.target.targetAttemptId) || "Agent";
    }
    return null;
  }, [msg.target, attemptNameMap]);

  // User messages — right-aligned
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[75%] px-3 py-2 text-xs"
          style={{ background: `${ACCENT}18`, border: `1px solid ${ACCENT}30`, color: TEXT_PRIMARY }}
        >
          {isGlobalView && targetLabel && (
            <div className="mb-1 text-[9px]" style={{ color: ACCENT }}>
              You → @{targetLabel}
            </div>
          )}
          <div className="whitespace-pre-wrap">{msg.content}</div>
          <div className="mt-1 text-right" style={timestampStyle}>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  // Inter-agent messages
  if (isInterAgent) {
    const srcId = msg.target && "sourceAttemptId" in msg.target ? msg.target.sourceAttemptId : null;
    const dstId = msg.target && "targetAttemptId" in msg.target ? msg.target.targetAttemptId : null;
    const srcName = (srcId && attemptNameMap.get(srcId)) || msg.stepKey || "Worker";
    const dstName = (dstId && attemptNameMap.get(dstId)) || "Worker";

    return (
      <div className="ml-4 flex justify-start">
        <div
          className="max-w-[75%] px-3 py-2 text-xs"
          style={{ borderLeft: `2px solid ${ACCENT}30`, background: BG_MAIN }}
        >
          <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: ACCENT }}>
            <ChatCircle size={12} weight="regular" />
            <span>
              {srcName} → {dstName}
            </span>
          </div>
          <div className="whitespace-pre-wrap" style={{ color: TEXT_SECONDARY }}>
            {msg.content}
          </div>
          <div className="mt-1" style={timestampStyle}>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  if (structuredStream) {
    const headerColorMap: Record<string, string> = {
      reasoning: "#38BDF8",
      tool: "#F59E0B",
      error: STATUS_RED,
      done: STATUS_GREEN,
    };
    const headerColor = headerColorMap[structuredKind] ?? TEXT_MUTED;
    const toolName = typeof structuredStream.tool === "string" ? structuredStream.tool : "tool";
    const detail = (() => {
      switch (structuredKind) {
        case "tool":
          return [
            structuredStream.args !== undefined ? `Args\n${formatStructuredValue(structuredStream.args)}` : null,
            structuredStream.result !== undefined ? `Result\n${formatStructuredValue(structuredStream.result)}` : null,
          ].filter(Boolean).join("\n\n");
        case "done":
          return structuredStream.usage != null ? formatStructuredValue(structuredStream.usage) : "";
        case "error":
          return typeof structuredStream.message === "string" ? structuredStream.message : msg.content;
        default:
          return msg.content;
      }
    })();
    const showExpandable =
      structuredKind === "reasoning"
      || structuredKind === "tool"
      || structuredKind === "error";
    const title = (() => {
      switch (structuredKind) {
        case "reasoning": return "Thinking";
        case "tool": return `Tool \u00B7 ${toolName}`;
        case "status": return `Turn ${typeof structuredStream.status === "string" ? structuredStream.status : "update"}`;
        case "done": return `Turn ${typeof structuredStream.status === "string" ? structuredStream.status : "done"}`;
        case "text": return senderLabel;
        default: return "Worker event";
      }
    })();

    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: TEXT_MUTED }}>
            {isWorker ? <TerminalWindow size={12} weight="regular" /> : <Robot size={12} weight="regular" />}
            <span>{senderLabel}</span>
            <span style={timestampStyle}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
          <div
            className="px-3 py-2 text-xs"
            style={{ background: BG_MAIN, border: `1px solid ${headerColor}33`, color: TEXT_PRIMARY }}
          >
            <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: headerColor }}>
              {showExpandable ? (
                <button
                  onClick={() => setExpanded((value) => !value)}
                  className="inline-flex items-center gap-1"
                  style={{ color: headerColor }}
                >
                  <CaretRight
                    size={10}
                    weight="bold"
                    style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 100ms" }}
                  />
                  {title}
                </button>
              ) : (
                <span>{title}</span>
              )}
            </div>
            {structuredKind === "text" ? (
              <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
            ) : showExpandable ? (
              expanded ? (
                <pre className="overflow-x-auto whitespace-pre-wrap text-[11px]" style={{ color: TEXT_SECONDARY, fontFamily: MONO }}>
                  {detail}
                </pre>
              ) : (
                <div className="text-[11px]" style={{ color: TEXT_SECONDARY }}>
                  {structuredKind === "tool" ? `Status: ${typeof structuredStream.status === "string" ? structuredStream.status : "running"}` : "Expand to inspect details."}
                </div>
              )
            ) : (
              <div className="whitespace-pre-wrap leading-relaxed" style={{ color: TEXT_SECONDARY }}>
                {detail}
              </div>
            )}
            <div className="mt-1" style={timestampStyle}>
              {new Date(msg.timestamp).toLocaleTimeString()}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Orchestrator broadcast in global view — system pill
  if (isValidationSystemSignal) {
    const signalLabel = systemSignal
      .replace("validation_", "")
      .replace(/_/g, " ")
      .toUpperCase();
    return (
      <div className="flex justify-center">
        <div
          className="max-w-[88%] px-3 py-2 text-center text-[11px]"
          style={{
            background: "#F59E0B12",
            border: "1px solid #F59E0B40",
            borderLeft: "3px solid #F59E0B",
            color: TEXT_SECONDARY,
          }}
        >
          <div className="mb-1 flex items-center justify-center gap-1 text-[9px]" style={{ color: "#F59E0B" }}>
            <Robot size={10} weight="regular" />
            <span className="font-bold uppercase tracking-wider">VALIDATION SYSTEM</span>
            {signalLabel.length > 0 ? <span className="opacity-70">· {signalLabel}</span> : null}
          </div>
          <div className="whitespace-pre-wrap">{msg.content}</div>
          <div className="mt-1" style={timestampStyle}>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  // Orchestrator broadcast in global view — system pill
  if (isOrchestrator && isGlobalView) {
    return (
      <div className="flex justify-center">
        <div
          className="max-w-[85%] px-3 py-1.5 text-center text-[11px]"
          style={{
            background: "#3B82F610",
            border: "1px solid #3B82F625",
            color: TEXT_SECONDARY,
          }}
        >
          <div className="mb-0.5 flex items-center justify-center gap-1 text-[9px]" style={{ color: "#3B82F6" }}>
            <Robot size={10} weight="regular" />
            <span className="font-bold uppercase tracking-wider">ORCHESTRATOR</span>
          </div>
          <div className="whitespace-pre-wrap">{msg.content}</div>
          <div className="mt-1" style={timestampStyle}>
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  // Tool calls / file edits — collapsible
  if (isToolCall || isFileEdit) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: TEXT_MUTED }}>
            {isWorker ? <TerminalWindow size={12} weight="regular" /> : <Robot size={12} weight="regular" />}
            <span>{senderLabel}</span>
            {isGlobalView && targetLabel && (
              <span style={{ color: TEXT_DIM }}> → @{targetLabel}</span>
            )}
            <span style={timestampStyle}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full px-3 py-2 text-left text-[11px] transition-colors"
            style={
              isFileEdit
                ? { border: "1px solid #22C55E30", background: "#22C55E08" }
                : { border: "1px solid #F59E0B30", background: "#F59E0B08" }
            }
          >
            <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: isFileEdit ? "#22C55E" : "#F59E0B" }}>
              <CaretRight
                size={10}
                weight="bold"
                style={{
                  transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform 100ms",
                }}
              />
              {isFileEdit ? "FILE EDIT" : "TOOL CALL"}
            </div>
            {expanded && (
              <pre
                className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10px]"
                style={{ color: TEXT_SECONDARY, fontFamily: MONO }}
              >
                {msg.content}
              </pre>
            )}
          </button>
        </div>
      </div>
    );
  }

  // Standard message bubble
  const roleIcon = isWorker ? TerminalWindow : Robot;
  const bubbleStyle: React.CSSProperties = isBudgetWarning
    ? {
        background: `${WARNING}08`,
        borderTop: `1px solid ${WARNING}30`,
        borderRight: `1px solid ${WARNING}30`,
        borderBottom: `1px solid ${WARNING}30`,
        borderLeft: `3px solid ${WARNING}`,
        color: TEXT_PRIMARY,
      }
    : {
        background: isWorker ? "#A78BFA10" : BG_MAIN,
        border: isWorker ? "1px solid #A78BFA30" : `1px solid ${BORDER}`,
        color: TEXT_PRIMARY,
      };

  return (
    <div className="flex justify-start">
      <div
        className="max-w-[80%] px-3 py-2 text-xs"
        style={bubbleStyle}
      >
        <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: isBudgetWarning ? WARNING : TEXT_MUTED }}>
          {isBudgetWarning && <span style={{ fontSize: "12px" }}>{"\u26A0"}</span>}
          {React.createElement(roleIcon, { size: 12, weight: "regular" })}
          <span className="font-medium">{senderLabel}</span>
          {isGlobalView && targetLabel && (
            <span style={{ color: TEXT_DIM }}> → @{targetLabel}</span>
          )}
        </div>
        <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
        <div className="mt-1 flex items-center justify-between gap-2" style={timestampStyle}>
          <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          {msg.deliveryState && (() => {
            const stateColor = DELIVERY_STATE_COLOR[msg.deliveryState] ?? "#F59E0B";
            return (
              <span
                className="px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider"
                style={{
                  color: stateColor,
                  background: `${stateColor}18`,
                  border: `1px solid ${stateColor}30`,
                }}
              >
                {msg.deliveryState}
              </span>
            );
          })()}
        </div>
      </div>
    </div>
  );
});
