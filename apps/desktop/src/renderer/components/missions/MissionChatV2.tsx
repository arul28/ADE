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
  OrchestratorChatThread,
  OrchestratorChatMessage,
  OrchestratorWorkerState,
  OrchestratorChatTarget,
  ActiveAgentInfo,
  MissionStatus,
} from "../../../shared/types";
import { MentionInput, type MentionParticipant } from "../shared/MentionInput";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { useMissionPolling } from "./useMissionPolling";

// ── Design tokens (aliases for backward compat) ──
const MONO = MONO_FONT;
const SANS = SANS_FONT;
const BG_MAIN = COLORS.cardBg;
const BG_SIDEBAR = "#1a1625";
const BG_INPUT = COLORS.recessedBg;
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

type MessageCategory = "all" | "coordinator" | "workers" | "system" | "user";

const MESSAGE_CATEGORIES: { value: MessageCategory; label: string }[] = [
  { value: "all", label: "All Messages" },
  { value: "coordinator", label: "Coordinator" },
  { value: "workers", label: "Workers" },
  { value: "system", label: "System" },
  { value: "user", label: "User" },
];

function classifyMessage(msg: OrchestratorChatMessage): MessageCategory {
  if (msg.role === "user") return "user";
  if (msg.role === "orchestrator") return "system";
  if (msg.role === "worker") return "workers";
  // role === "agent": could be coordinator or worker depending on source
  if (msg.target?.kind === "agent") return "workers"; // inter-agent
  if (msg.stepKey) return "workers";
  return "coordinator";
}

type ChannelKind = "global" | "orchestrator" | "teammate" | "worker";

type Channel = {
  id: string;
  kind: ChannelKind;
  label: string;
  threadId: string | null;
  status: "active" | "closed";
  stepKey: string | null;
  attemptId: string | null;
  unreadCount: number;
};

type MissionChatV2Props = {
  missionId: string;
  missionStatus: MissionStatus | null;
  runId: string | null;
  jumpTarget: OrchestratorChatTarget | null;
  onJumpHandled: () => void;
};

const STATUS_DOT: Record<string, string> = {
  active: STATUS_GREEN,
  closed: STATUS_GRAY,
  failed: STATUS_RED,
};

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

export const MissionChatV2 = React.memo(function MissionChatV2({ missionId, missionStatus, runId, jumpTarget, onJumpHandled }: MissionChatV2Props) {
  // ── State ──
  const [threads, setThreads] = useState<OrchestratorChatThread[]>([]);
  const [globalMessages, setGlobalMessages] = useState<OrchestratorChatMessage[]>([]);
  const [threadMessages, setThreadMessages] = useState<OrchestratorChatMessage[]>([]);
  const [workerStates, setWorkerStates] = useState<OrchestratorWorkerState[]>([]);
  const [activeAgents, setActiveAgents] = useState<ActiveAgentInfo[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("global");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [completedCollapsed, setCompletedCollapsed] = useState(false);
  const [messageFilter, setMessageFilter] = useState<MessageCategory>("all");

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
      threadId: null,
      status: "active",
      stepKey: null,
      attemptId: null,
      unreadCount: 0,
    });

    // Coordinator thread
    const coordThread = threads.find((t) => t.threadType === "coordinator");
    if (coordThread) {
      result.push({
        id: `thread:${coordThread.id}`,
        kind: "orchestrator",
        label: "Coordinator",
        threadId: coordThread.id,
        status: coordThread.status,
        stepKey: null,
        attemptId: null,
        unreadCount: coordThread.unreadCount,
      });
    }

    // Teammate threads
    const teammateThreads = threads.filter((t) => t.threadType === "teammate");
    for (const t of teammateThreads) {
      result.push({
        id: `thread:${t.id}`,
        kind: "teammate",
        label: t.title || "Teammate",
        threadId: t.id,
        status: t.status,
        stepKey: t.stepKey ?? null,
        attemptId: t.attemptId ?? null,
        unreadCount: t.unreadCount,
      });
    }

    // Worker threads
    const workerThreads = threads.filter((t) => t.threadType === "worker");
    for (const t of workerThreads) {
      result.push({
        id: `thread:${t.id}`,
        kind: "worker",
        label: t.title || t.stepKey || "Worker",
        threadId: t.id,
        status: t.status,
        stepKey: t.stepKey ?? null,
        attemptId: t.attemptId ?? null,
        unreadCount: t.unreadCount,
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

  // ── Build participants for MentionInput ──
  const participants = useMemo<MentionParticipant[]>(() => {
    const result: MentionParticipant[] = [
      { id: "orchestrator", label: "orchestrator", status: "active", role: "planner" },
      { id: "all", label: "all", status: "active", role: "broadcast" },
    ];

    for (const ch of channels) {
      if (ch.kind === "teammate") {
        result.push({
          id: ch.label,
          label: ch.label,
          status: ch.status === "active" ? "active" : "completed",
          role: "teammate",
        });
      } else if (ch.kind === "worker" && ch.stepKey) {
        const agentInfo = activeAgents.find((a) => a.attemptId === ch.attemptId);
        result.push({
          id: ch.stepKey,
          label: ch.stepKey,
          status: workerStatusToParticipantStatus(agentInfo?.state),
          role: "worker",
        });
      }
    }

    return result;
  }, [channels, activeAgents]);

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
      const nextThreads = await window.ade.orchestrator.listChatThreads({ missionId });
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
      const [states, agents] = await Promise.all([
        runId
          ? window.ade.orchestrator.getWorkerStates({ runId })
          : Promise.resolve([] as OrchestratorWorkerState[]),
        window.ade.orchestrator.getActiveAgents({ missionId }),
      ]);
      setWorkerStates(states);
      setActiveAgents(agents);
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

    if (jumpTarget.kind === "worker") {
      const workerThread = threads.find(
        (t) =>
          t.threadType === "worker" &&
          ((jumpTarget.attemptId && t.attemptId === jumpTarget.attemptId) ||
            (jumpTarget.stepKey && t.stepKey === jumpTarget.stepKey))
      );
      if (workerThread) {
        setSelectedChannelId(`thread:${workerThread.id}`);
      } else {
        // Fallback to coordinator if no matching worker thread (e.g. planner step)
        const coordThread = threads.find((t) => t.threadType === "coordinator");
        if (coordThread) setSelectedChannelId(`thread:${coordThread.id}`);
      }
    } else if (jumpTarget.kind === "teammate") {
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
    } else {
      msgs = threadMessages;
    }
    if (messageFilter !== "all") {
      msgs = msgs.filter((m) => classifyMessage(m) === messageFilter);
    }
    return msgs;
  }, [selectedChannel, globalMessages, threadMessages, messageFilter]);

  // ── Attempt name map ──
  const attemptNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of threads) {
      if (t.attemptId) {
        map.set(t.attemptId, t.title || (t.threadType === "coordinator" ? "Coordinator" : "Worker"));
      }
    }
    return map;
  }, [threads]);

  // ── Send message ──
  const handleSend = useCallback(
    async (message: string, mentions: string[]) => {
      if (sending || !message.trim()) return;
      setSending(true);
      try {
        if (selectedChannel?.kind === "global" || mentions.length > 0) {
          // For global channel or messages with mentions, use sendAgentMessage if targeting agents
          // Otherwise fall back to sendThreadMessage targeting the coordinator
          const coordThread = threads.find((t) => t.threadType === "coordinator");
          if (coordThread) {
            const target: OrchestratorChatTarget = mentions.includes("all")
              ? { kind: "workers", runId: runId ?? null, includeClosed: false }
              : { kind: "coordinator", runId: runId ?? null };
            await window.ade.orchestrator.sendThreadMessage({
              missionId,
              threadId: coordThread.id,
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
    [sending, selectedChannel, threads, missionId, runId, refreshThreads, refreshGlobalMessages, refreshThreadMessages]
  );

  // ── Channel name for header ──
  const channelHeaderName = selectedChannel
    ? selectedChannel.kind === "global"
      ? "Global"
      : selectedChannel.kind === "orchestrator"
        ? "Coordinator"
        : selectedChannel.label
    : "...";

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sidebar ── */}
      <aside
        className="flex w-[200px] shrink-0 flex-col"
        style={{ background: BG_SIDEBAR, borderRight: `1px solid ${BORDER}` }}
      >
        <div className="px-3 py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ ...LABEL_STYLE, color: TEXT_PRIMARY }}>CHAT</div>
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

          {/* Coordinator section */}
          {orchestratorChannel && (
            <>
              <SectionLabel>COORDINATOR</SectionLabel>
              <ChannelButton
                icon={<Crown size={12} weight="fill" />}
                label="Coordinator"
                statusColor={STATUS_DOT[orchestratorChannel.status] ?? STATUS_GRAY}
                isSelected={selectedChannelId === orchestratorChannel.id}
                onClick={() => setSelectedChannelId(orchestratorChannel.id)}
                unreadCount={orchestratorChannel.unreadCount}
                badge="planner"
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
                  stepKey={ch.stepKey}
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
                    stepKey={ch.stepKey}
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
          className="flex items-center gap-2 px-4 py-2"
          style={{ borderBottom: `1px solid ${BORDER}` }}
        >
          <Hash size={14} weight="regular" style={{ color: TEXT_MUTED }} />
          <span className="text-xs font-semibold" style={{ color: TEXT_PRIMARY, fontFamily: MONO }}>
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
              Coordinator
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
              Worker{selectedChannel.stepKey ? `: ${selectedChannel.stepKey}` : ""}
            </span>
          )}
          {selectedChannel?.kind === "global" && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.5px]"
              style={{ background: `${ACCENT}18`, color: ACCENT, border: `1px solid ${ACCENT}30` }}
            >
              <Globe size={10} weight="fill" />
              All Messages
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <select
              value={messageFilter}
              onChange={(e) => setMessageFilter(e.target.value as MessageCategory)}
              className="h-6 px-2 text-[10px] outline-none"
              style={{
                background: BG_INPUT,
                border: `1px solid ${BORDER}`,
                color: TEXT_PRIMARY,
                fontFamily: MONO,
                fontSize: "10px",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px",
                borderRadius: 0,
              }}
            >
              {MESSAGE_CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
            {messageFilter !== "all" && (
              <button
                onClick={() => setMessageFilter("all")}
                className="text-[10px] transition-colors hover:text-white"
                style={{ color: TEXT_MUTED, fontFamily: MONO }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Pause banner */}
        {missionStatus === "intervention_required" && (
          <div
            style={{
              background: `${WARNING}12`,
              borderBottom: `1px solid ${WARNING}30`,
              padding: "8px 16px",
              fontFamily: MONO,
              fontSize: "11px",
              color: WARNING,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span style={{ fontSize: "14px" }}>{"\u26A0"}</span>
            <span>Mission paused — intervention required</span>
          </div>
        )}

        {/* Message list */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="relative flex-1 overflow-y-auto px-4 py-3 space-y-2"
        >
          {displayMessages.length === 0 && (
            <div
              className="flex h-32 items-center justify-center text-xs"
              style={{ color: TEXT_MUTED }}
            >
              {selectedChannel?.kind === "global"
                ? "No messages yet. Messages from all channels appear here."
                : "No messages yet in this channel."}
            </div>
          )}

          {displayMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              attemptNameMap={attemptNameMap}
              isGlobalView={selectedChannel?.kind === "global"}
            />
          ))}

          {/* Jump to latest */}
          {showJumpToLatest && (
            <button
              onClick={jumpToLatest}
              className="sticky bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1 font-bold shadow-lg transition-opacity hover:opacity-90"
              style={{
                background: ACCENT,
                color: BG_PAGE,
                fontFamily: MONO,
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "1px",
              }}
            >
              <CaretDown size={12} weight="regular" />
              JUMP TO LATEST
            </button>
          )}
        </div>

        {/* Input bar */}
        <div style={{ borderTop: `1px solid ${BORDER}` }}>
          <MentionInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            participants={participants}
            placeholder={
              selectedChannel?.kind === "global"
                ? "Message global (use @mention to target)..."
                : selectedChannel?.kind === "orchestrator"
                  ? "Message the coordinator..."
                  : selectedChannel?.kind === "teammate"
                    ? `Message teammate ${selectedChannel?.label ?? ""}...`
                    : `Message ${selectedChannel?.label ?? "worker"}...`
            }
            disabled={sending}
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

function ChannelButton({
  icon,
  label,
  statusColor,
  isSelected,
  onClick,
  unreadCount,
  badge,
  badgeColor,
  stepKey,
}: {
  icon: React.ReactNode;
  label: string;
  statusColor: string;
  isSelected: boolean;
  onClick: () => void;
  unreadCount: number;
  badge?: string;
  badgeColor?: string;
  stepKey?: string | null;
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
        <span className="truncate text-xs">{label}</span>
        {unreadCount > 0 && (
          <span
            className="ml-auto shrink-0 px-1 py-0.5 text-[9px] font-semibold"
            style={{ background: ACCENT, color: BG_PAGE }}
          >
            {unreadCount}
          </span>
        )}
      </div>
      {(badge || stepKey) && (
        <div className="flex items-center gap-1 pl-5">
          {badge && badgeColor && (
            <span
              className="inline-flex items-center gap-0.5 px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
              style={{ background: `${badgeColor}18`, color: badgeColor, border: `1px solid ${badgeColor}30` }}
            >
              {badge}
            </span>
          )}
          {stepKey && (
            <span
              className="inline-flex items-center px-1 py-0 text-[8px] font-bold uppercase tracking-[0.5px]"
              style={{ background: `${ACCENT}12`, color: ACCENT, border: `1px solid ${ACCENT}25` }}
            >
              {stepKey}
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
  const bubbleBorder = isBudgetWarning
    ? `1px solid ${WARNING}30`
    : isOrchestrator
      ? `1px solid ${BORDER}`
      : isWorker
        ? "1px solid #A78BFA30"
        : `1px solid ${BORDER}`;
  const bubbleBg = isBudgetWarning
    ? `${WARNING}08`
    : isOrchestrator
      ? BG_MAIN
      : isWorker
        ? "#A78BFA10"
        : BG_MAIN;

  return (
    <div className="flex justify-start">
      <div
        className="max-w-[80%] px-3 py-2 text-xs"
        style={{
          background: bubbleBg,
          border: bubbleBorder,
          borderLeft: isBudgetWarning ? `3px solid ${WARNING}` : undefined,
          color: TEXT_PRIMARY,
        }}
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
          {msg.deliveryState && (
            <span
              className="px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider"
              style={{
                color:
                  msg.deliveryState === "delivered"
                    ? STATUS_GREEN
                    : msg.deliveryState === "failed"
                      ? STATUS_RED
                      : "#F59E0B",
                background:
                  msg.deliveryState === "delivered"
                    ? `${STATUS_GREEN}18`
                    : msg.deliveryState === "failed"
                      ? `${STATUS_RED}18`
                      : "#F59E0B18",
                border: `1px solid ${
                  msg.deliveryState === "delivered"
                    ? `${STATUS_GREEN}30`
                    : msg.deliveryState === "failed"
                      ? `${STATUS_RED}30`
                      : "#F59E0B30"
                }`,
              }}
            >
              {msg.deliveryState}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
