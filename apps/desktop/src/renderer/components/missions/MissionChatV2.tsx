import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type {
  MissionAgentRuntimeConfig,
  MissionIntervention,
  OrchestratorChatThread,
  OrchestratorChatMessage,
  OrchestratorMetadata,
  OrchestratorTeamRuntimeState,
  OrchestratorWorkerState,
  OrchestratorChatTarget,
  ActiveAgentInfo,
  MissionStatus,
  MissionRunView,
  OrchestratorRunStatus,
  TeamRuntimeConfig,
} from "../../../shared/types";
import type { MentionParticipant } from "../shared/MentionInput";
import { COLORS } from "../lanes/laneDesignTokens";
import { useMissionPolling } from "./useMissionPolling";
import { formatMissionWorkerPresentation } from "./missionHelpers";
import { buildMissionStateNarrative, prepareMissionFeedItems } from "./missionFeedPresentation";
import {
  isSignalMessage,
  readRecord,
  statusDotForWorker,
  workerStatusToParticipantStatus,
  normalizeMentionKey,
  type MentionTargetOption,
} from "./chatFilters";
import { ChatChannelList, type Channel } from "./ChatChannelList";
import { ChatMessageArea } from "./ChatMessageArea";
import { ChatInput, type QuickTarget } from "./ChatInput";

const BG_PAGE = COLORS.pageBg;

function findThreadIntervention(args: {
  interventions: MissionIntervention[];
  selectedChannel: Channel | undefined;
  runId: string | null;
}): MissionIntervention | null {
  const { interventions, selectedChannel, runId } = args;
  if (!selectedChannel || selectedChannel.kind === "global") return null;
  const openInterventions = interventions
    .filter((intervention) => intervention.status === "open")
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt));

  return openInterventions.find((intervention) => {
    const metadata = readRecord(intervention.metadata);
    const interventionRunId = typeof metadata?.runId === "string" ? metadata.runId.trim() : "";
    if (interventionRunId.length > 0 && runId && interventionRunId !== runId) return false;
    const attemptId = typeof metadata?.attemptId === "string" ? metadata.attemptId.trim() : "";
    const stepId = typeof metadata?.stepId === "string" ? metadata.stepId.trim() : "";
    const stepKey = typeof metadata?.stepKey === "string" ? metadata.stepKey.trim() : "";
    const reasonCode = typeof metadata?.reasonCode === "string" ? metadata.reasonCode.trim() : "";

    if (selectedChannel.kind === "orchestrator") {
      return reasonCode === "coordinator_unavailable"
        || reasonCode === "coordinator_recovery_failed"
        || (!attemptId && !stepId && !stepKey);
    }

    if (selectedChannel.kind === "worker") {
      return (
        (attemptId.length > 0 && attemptId === selectedChannel.attemptId)
        || (stepKey.length > 0 && stepKey === selectedChannel.stepKey)
      );
    }

    return false;
  }) ?? null;
}

type MissionChatV2Props = {
  missionId: string;
  missionStatus: MissionStatus | null;
  runId: string | null;
  runStatus: OrchestratorRunStatus | null;
  runMetadata: OrchestratorMetadata | null;
  runView?: MissionRunView | null;
  interventions: MissionIntervention[];
  jumpTarget: OrchestratorChatTarget | null;
  onJumpHandled: () => void;
  onOpenIntervention: (interventionId: string) => void;
};

export const MissionChatV2 = React.memo(function MissionChatV2({
  missionId, missionStatus, runId, runStatus, runMetadata, runView = null, interventions, jumpTarget, onJumpHandled, onOpenIntervention,
}: MissionChatV2Props) {
  // ── State ──
  const [threads, setThreads] = useState<OrchestratorChatThread[]>([]);
  const [globalMessages, setGlobalMessages] = useState<OrchestratorChatMessage[]>([]);
  const [threadMessages, setThreadMessages] = useState<OrchestratorChatMessage[]>([]);
  const [workerStates, setWorkerStates] = useState<OrchestratorWorkerState[]>([]);
  const [activeAgents, setActiveAgents] = useState<ActiveAgentInfo[]>([]);
  const [teamRuntimeState, setTeamRuntimeState] = useState<OrchestratorTeamRuntimeState | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState("global");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [globalViewMode, setGlobalViewMode] = useState<"signal" | "raw">("signal");
  const [completedCollapsed, setCompletedCollapsed] = useState(false);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);

  const selectedChannelIdRef = useRef("global");
  const threadRefreshTimerRef = useRef<number | null>(null);
  const messageRefreshTimerRef = useRef<number | null>(null);
  const channelsRef = useRef<Channel[]>([]);

  useEffect(() => { selectedChannelIdRef.current = selectedChannelId; }, [selectedChannelId]);

  // ── Build channel list from threads ──
  const channels = useMemo<Channel[]>(() => {
    const result: Channel[] = [{
      id: "global", kind: "global", label: "Mission Feed", fullLabel: "Mission Feed",
      threadId: null, sessionId: null, status: "active", stepKey: null, attemptId: null, unreadCount: 0, phaseLabel: null,
    }];
    const coordThread = threads.find((t) => t.threadType === "coordinator");
    if (coordThread) result.push({ id: `thread:${coordThread.id}`, kind: "orchestrator", label: "Orchestrator", fullLabel: "Orchestrator", threadId: coordThread.id, sessionId: coordThread.sessionId ?? null, status: coordThread.status, stepKey: null, attemptId: null, unreadCount: coordThread.unreadCount, phaseLabel: null });
    for (const t of threads.filter((t) => t.threadType === "teammate"))
      result.push({ id: `thread:${t.id}`, kind: "teammate", label: t.title || "Teammate", fullLabel: t.title || "Teammate", threadId: t.id, sessionId: t.sessionId ?? null, status: t.status, stepKey: t.stepKey ?? null, attemptId: t.attemptId ?? null, unreadCount: t.unreadCount, phaseLabel: null });
    for (const t of threads.filter((t) => t.threadType === "worker")) {
      const p = formatMissionWorkerPresentation({ title: t.title, stepKey: t.stepKey ?? null });
      result.push({ id: `thread:${t.id}`, kind: "worker", label: p.label, fullLabel: p.fullLabel, threadId: t.id, sessionId: t.sessionId ?? null, status: t.status, stepKey: t.stepKey ?? null, attemptId: t.attemptId ?? null, unreadCount: t.unreadCount, phaseLabel: p.phaseLabel });
    }
    return result;
  }, [threads]);

  const teammateChannels = useMemo(() => channels.filter((c) => c.kind === "teammate"), [channels]);
  const activeWorkerChannels = useMemo(() => channels.filter((c) => c.kind === "worker" && c.status === "active"), [channels]);
  const completedWorkerChannels = useMemo(() => channels.filter((c) => c.kind === "worker" && c.status !== "active"), [channels]);
  const orchestratorChannel = useMemo(() => channels.find((c) => c.kind === "orchestrator") ?? null, [channels]);
  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId) ?? channels[0], [channels, selectedChannelId]);
  const shouldHydrateGlobalMessages = useMemo(
    () => selectedChannel?.kind === "global" && (globalViewMode === "raw" || !(runView?.progressLog?.length)),
    [globalViewMode, runView?.progressLog, selectedChannel?.kind],
  );

  // ── Build mention targets ──
  const mentionTargets = useMemo<MentionTargetOption[]>(() => {
    const used = new Set<string>(["orchestrator", "all"]);
    const coord = channels.find((ch) => ch.kind === "orchestrator") ?? null;
    const result: MentionTargetOption[] = [
      { id: "orchestrator", label: "orchestrator", status: "active", role: "orchestrator", threadId: coord?.threadId ?? null, target: { kind: "coordinator", runId: runId ?? null }, helper: "Message the coordinator" },
      { id: "all", label: "all", status: "active", role: "broadcast", threadId: coord?.threadId ?? null, target: { kind: "workers", runId: runId ?? null, includeClosed: false }, helper: "Broadcast to active workers" },
    ];
    for (const ch of channels) {
      if (ch.kind === "teammate") {
        const mid = normalizeMentionKey(ch.label, `teammate-${result.length}`, used);
        const t = threads.find((e) => e.id === ch.threadId) ?? null;
        const tmId = t && typeof (t as { teamMemberId?: unknown }).teamMemberId === "string" ? (t as { teamMemberId?: string }).teamMemberId ?? null : null;
        result.push({ id: mid, label: ch.label, status: ch.status === "active" ? "active" : "completed", role: "teammate", threadId: ch.threadId, target: { kind: "teammate", runId: t?.runId ?? runId ?? null, teamMemberId: tmId, sessionId: t?.sessionId ?? null }, helper: "Message this teammate directly" });
      } else if (ch.kind === "worker") {
        const info = activeAgents.find((a) => a.attemptId === ch.attemptId);
        if (workerStatusToParticipantStatus(info?.state) !== "active") continue;
        const mid = normalizeMentionKey(ch.fullLabel, `worker-${result.length}`, used);
        const t = threads.find((e) => e.id === ch.threadId) ?? null;
        result.push({ id: mid, label: ch.fullLabel, status: workerStatusToParticipantStatus(info?.state), role: "worker", threadId: ch.threadId, target: { kind: "worker", runId: t?.runId ?? runId ?? null, stepId: t?.stepId ?? null, stepKey: t?.stepKey ?? null, attemptId: t?.attemptId ?? null, sessionId: t?.sessionId ?? null, laneId: t?.laneId ?? null }, helper: "Message this worker directly" });
      }
    }
    return result;
  }, [activeAgents, channels, runId, threads]);

  const participants = useMemo<MentionParticipant[]>(() => mentionTargets.map(({ id, label, status, role }) => ({ id, label, status, role })), [mentionTargets]);
  const mentionTargetMap = useMemo(() => { const m = new Map<string, MentionTargetOption>(); for (const t of mentionTargets) m.set(t.id, t); return m; }, [mentionTargets]);

  useEffect(() => { channelsRef.current = channels; }, [channels]);

  const workerStateByAttempt = useMemo(() => { const m = new Map<string, OrchestratorWorkerState>(); for (const s of workerStates) m.set(s.attemptId, s); return m; }, [workerStates]);
  const workerStatusDotFn = useCallback((attemptId: string | null) => attemptId ? statusDotForWorker(workerStateByAttempt.get(attemptId)?.state) : COLORS.success, [workerStateByAttempt]);

  // ── Data fetching ──
  const refreshThreads = useCallback(async () => { try { setThreads(await window.ade.orchestrator.listChatThreads({ missionId, includeClosed: true })); } catch { /* ignore */ } }, [missionId]);
  const refreshGlobalMessages = useCallback(async () => {
    if (!shouldHydrateGlobalMessages) return;
    try {
      setGlobalMessages(await window.ade.orchestrator.getGlobalChat({ missionId, limit: 200 }));
    } catch {
      /* ignore */
    }
  }, [missionId, shouldHydrateGlobalMessages]);
  const refreshThreadMessages = useCallback(async (threadId?: string | null) => { if (!threadId) { setThreadMessages([]); return; } try { setThreadMessages(await window.ade.orchestrator.getThreadMessages({ missionId, threadId, limit: 200 })); } catch { /* ignore */ } }, [missionId]);
  const refreshWorkers = useCallback(async () => { try { const [st, ag, rt] = await Promise.all([runId ? window.ade.orchestrator.getWorkerStates({ runId }) : Promise.resolve([] as OrchestratorWorkerState[]), window.ade.orchestrator.getActiveAgents({ missionId }), runId ? window.ade.orchestrator.getTeamRuntimeState({ runId }).catch(() => null) : Promise.resolve(null)]); setWorkerStates(st); setActiveAgents(ag); setTeamRuntimeState(rt); } catch { /* ignore */ } }, [missionId, runId]);
  const refreshSelectedMessages = useCallback(async () => {
    if (!selectedChannel) return;
    if (selectedChannel.kind === "global") {
      if (!shouldHydrateGlobalMessages) return;
      await refreshGlobalMessages();
      return;
    }
    await refreshThreadMessages(selectedChannel.threadId);
  }, [refreshGlobalMessages, refreshThreadMessages, selectedChannel, shouldHydrateGlobalMessages]);

  useEffect(() => {
    void refreshThreads();
    void refreshWorkers();
  }, [refreshThreads, refreshWorkers]);
  useEffect(() => {
    void refreshSelectedMessages();
  }, [refreshSelectedMessages]);
  useMissionPolling(
    useCallback(() => {
      void refreshThreads();
      void refreshWorkers();
    }, [refreshThreads, refreshWorkers]),
    15_000,
    true,
  );
  useMissionPolling(
    useCallback(() => {
      void refreshSelectedMessages();
    }, [refreshSelectedMessages]),
    12_000,
    Boolean(selectedChannel && (selectedChannel.kind !== "global" || shouldHydrateGlobalMessages)),
  );

  // ── Real-time events ──
  const refreshThreadsRef = useRef(refreshThreads);
  const refreshGlobalMessagesRef = useRef(refreshGlobalMessages);
  const refreshThreadMessagesRef = useRef(refreshThreadMessages);
  useEffect(() => { refreshThreadsRef.current = refreshThreads; }, [refreshThreads]);
  useEffect(() => { refreshGlobalMessagesRef.current = refreshGlobalMessages; }, [refreshGlobalMessages]);
  useEffect(() => { refreshThreadMessagesRef.current = refreshThreadMessages; }, [refreshThreadMessages]);

  useEffect(() => {
    const unsub = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.missionId !== missionId) return;
      if (event.type === "thread_updated" || event.type === "message_appended" || event.type === "message_updated" || event.type === "worker_replay") {
        if (threadRefreshTimerRef.current !== null) window.clearTimeout(threadRefreshTimerRef.current);
        threadRefreshTimerRef.current = window.setTimeout(() => { threadRefreshTimerRef.current = null; void refreshThreadsRef.current(); }, 120);
        if (messageRefreshTimerRef.current !== null) window.clearTimeout(messageRefreshTimerRef.current);
        messageRefreshTimerRef.current = window.setTimeout(() => {
          messageRefreshTimerRef.current = null;
          const cur = selectedChannelIdRef.current;
          if (cur === "global") {
            if (shouldHydrateGlobalMessages) void refreshGlobalMessagesRef.current();
            return;
          }
          const ch = channelsRef.current.find((c) => c.id === cur);
          if (ch?.threadId && (!event.threadId || event.threadId === ch.threadId)) {
            void refreshThreadMessagesRef.current(ch.threadId);
          }
        }, 100);
      }
    });
    return () => { unsub(); if (threadRefreshTimerRef.current !== null) window.clearTimeout(threadRefreshTimerRef.current); if (messageRefreshTimerRef.current !== null) window.clearTimeout(messageRefreshTimerRef.current); };
  }, [missionId, shouldHydrateGlobalMessages]);

  // ── Jump target handling ──
  useEffect(() => {
    if (!jumpTarget) return;
    setJumpNotice(null);
    if (jumpTarget.kind === "worker") {
      if (jumpTarget.attemptId) { setSelectedChannelId(`thread:worker:${missionId}:${jumpTarget.attemptId}`); onJumpHandled(); return; }
      if (!threads.length) return;
      const wt = threads.find((t) => t.threadType === "worker" && ((jumpTarget.attemptId && t.attemptId === jumpTarget.attemptId) || (jumpTarget.stepId && t.stepId === jumpTarget.stepId) || (jumpTarget.sessionId && t.sessionId === jumpTarget.sessionId) || (jumpTarget.stepKey && t.stepKey === jumpTarget.stepKey)));
      if (wt) setSelectedChannelId(`thread:${wt.id}`);
      else { const ct = threads.find((t) => t.threadType === "coordinator"); setSelectedChannelId(ct ? `thread:${ct.id}` : "global"); setJumpNotice("ADE has not hydrated that worker thread yet, so I landed you on the coordinator instead."); }
    } else if (jumpTarget.kind === "teammate") { const tt = threads.find((t) => t.threadType === "teammate"); if (tt) setSelectedChannelId(`thread:${tt.id}`); }
    else { const ct = threads.find((t) => t.threadType === "coordinator"); if (ct) setSelectedChannelId(`thread:${ct.id}`); }
    onJumpHandled();
  }, [jumpTarget, onJumpHandled, threads, missionId]);

  useEffect(() => { if (selectedChannel?.kind !== "worker" && selectedChannel?.kind !== "orchestrator") return; if (threadMessages.length > 0) setJumpNotice(null); }, [selectedChannel, threadMessages.length]);

  // ── Displayed messages ──
  const displayMessages = useMemo(() => {
    if (selectedChannel?.kind === "global") {
      if (globalViewMode === "signal" && runView?.progressLog?.length) {
        return prepareMissionFeedItems(runView.progressLog).map((item) => ({
          id: `mission-feed:${item.id}`,
          missionId,
          role: item.kind === "worker" ? "worker" : item.kind === "user" ? "user" : "orchestrator",
          content: item.detail.trim().length > 0 ? `${item.title}\n${item.detail}` : item.title,
          timestamp: item.at,
          stepKey: item.stepKey ?? null,
          attemptId: item.attemptId ?? null,
          runId: runId ?? null,
          metadata: {
            missionFeed: true,
            structuredStream: { kind: "text", itemId: item.id },
            title: item.title,
            severity: item.severity,
            feedKind: item.kind,
          },
        } satisfies OrchestratorChatMessage));
      }
      let msgs = [...globalMessages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      msgs = msgs.filter((msg) => { const md = readRecord(msg.metadata); if (md?.missionChatMode !== "thread_only") return true; return msg.target?.kind === "coordinator" || msg.threadId === `mission:${missionId}`; });
      if (globalViewMode === "signal") msgs = msgs.filter(isSignalMessage);
      return msgs;
    }
    return threadMessages;
  }, [selectedChannel, globalMessages, threadMessages, missionId, globalViewMode, runId, runView]);

  const attemptNameMap = useMemo(() => { const m = new Map<string, string>(); for (const t of threads) if (t.attemptId) m.set(t.attemptId, t.title || (t.threadType === "coordinator" ? "Orchestrator" : "Worker")); return m; }, [threads]);
  const threadIntervention = useMemo(
    () => findThreadIntervention({ interventions, selectedChannel, runId }),
    [interventions, runId, selectedChannel],
  );

  const chatNotice = useMemo(() => {
    if (runStatus === "paused") {
      return {
        reason: "Run is paused.",
        action: "You can still message the coordinator or an active worker here while you decide whether to resume.",
      };
    }
    if (missionStatus === "intervention_required") {
      return {
        reason: "Mission is waiting on an intervention.",
        action: "You can still message the coordinator or an active worker here while you decide how to recover.",
      };
    }
    return null;
  }, [missionStatus, runStatus]);

  const chatBlocked = useMemo(() => {
    if (missionStatus === "completed" || missionStatus === "failed" || missionStatus === "canceled") return { reason: "Mission run is closed.", action: "Start or rerun the mission to continue chat." };
    if (!runId || !runStatus) return { reason: "Orchestrator runtime is offline.", action: "Start the mission run to send directives." };
    if (runStatus === "queued" || runStatus === "bootstrapping") return { reason: "Orchestrator runtime is starting.", action: "Wait for readiness, then send directives." };
    if (selectedChannel?.kind === "worker") { const ws = selectedChannel.attemptId ? workerStateByAttempt.get(selectedChannel.attemptId)?.state : undefined; if (selectedChannel.status !== "active" || ws === "completed" || ws === "failed" || ws === "disposed") return { reason: "This worker is no longer running.", action: "Read the thread for history, or message @orchestrator to redirect the mission." }; }
    if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "canceled") return { reason: "Run is in a terminal state.", action: "Start a new run to continue chat." };
    return null;
  }, [missionStatus, runId, runStatus, selectedChannel, workerStateByAttempt]);

  const showStreaming = useMemo(() => { if (selectedChannel?.kind !== "worker" || !selectedChannel.attemptId) return false; const s = workerStateByAttempt.get(selectedChannel.attemptId)?.state; return s === "initializing" || s === "working"; }, [selectedChannel, workerStateByAttempt]);

  // ── Runtime config ──
  const teamRuntimeConfig = useMemo(() => { const md = readRecord(runMetadata); const rt = readRecord(md?.teamRuntime); if (!rt) return null; return { enabled: rt.enabled === true, targetProvider: rt.targetProvider === "claude" || rt.targetProvider === "codex" ? rt.targetProvider : "auto", teammateCount: Number.isFinite(Number(rt.teammateCount)) ? Math.max(0, Math.floor(Number(rt.teammateCount))) : 0, allowParallelAgents: rt.allowParallelAgents !== false, allowSubAgents: rt.allowSubAgents !== false, allowClaudeAgentTeams: rt.allowClaudeAgentTeams !== false } satisfies TeamRuntimeConfig; }, [runMetadata]);

  const agentRuntimeConfig = useMemo(() => { const md = readRecord(runMetadata); const rt = readRecord(md?.agentRuntime); if (!rt && !teamRuntimeConfig) return null; return { allowParallelAgents: typeof rt?.allowParallelAgents === "boolean" ? rt.allowParallelAgents : teamRuntimeConfig?.allowParallelAgents !== false, allowSubAgents: typeof rt?.allowSubAgents === "boolean" ? rt.allowSubAgents : teamRuntimeConfig?.allowSubAgents !== false, allowClaudeAgentTeams: typeof rt?.allowClaudeAgentTeams === "boolean" ? rt.allowClaudeAgentTeams : teamRuntimeConfig?.allowClaudeAgentTeams !== false } satisfies MissionAgentRuntimeConfig; }, [runMetadata, teamRuntimeConfig]);

  const quickTargets = useMemo<QuickTarget[]>(() => mentionTargets.filter((t) => t.id === "orchestrator" || t.id === "all" || t.status === "active").slice(0, 8).map((t) => ({ id: t.id, label: t.label, status: t.status as QuickTarget["status"], helper: t.helper })), [mentionTargets]);
  const appendMentionTarget = useCallback((targetId: string) => { setInput((prev) => { const token = `@${targetId}`; if (prev.includes(token)) return prev; const base = prev.trimEnd(); return `${base}${base.length ? " " : ""}${token} `; }); }, []);

  const runtimeSummary = useMemo(() => { if (teamRuntimeConfig?.enabled) { const c = teamRuntimeState?.teammateIds.length ?? teamRuntimeConfig.teammateCount ?? 0; return { title: "Team runtime", detail: `${teamRuntimeState?.phase ?? "bootstrapping"} · ${c} teammate${c === 1 ? "" : "s"} · ${teamRuntimeConfig.targetProvider === "auto" ? "auto" : teamRuntimeConfig.targetProvider}` }; } if (agentRuntimeConfig) return { title: "Coordinator chat", detail: "Direct worker targeting is available from here." }; return null; }, [agentRuntimeConfig, teamRuntimeConfig, teamRuntimeState]);
  const missionNarrative = useMemo(() => buildMissionStateNarrative(runView), [runView]);

  // ── Send message ──
  const handleSend = useCallback(async (message: string, mentions: string[]) => {
    if (sending || !message.trim() || chatBlocked) return;
    setSending(true);
    try {
      if (selectedChannel?.kind === "global" || mentions.length > 0) {
        const ct = threads.find((t) => t.threadType === "coordinator");
        if (ct) { const mt = mentions.map((m) => mentionTargetMap.get(m)).find((e) => e?.target != null) ?? null; const tgt: OrchestratorChatTarget = mt?.target ?? { kind: "coordinator", runId: runId ?? null }; await window.ade.orchestrator.sendThreadMessage({ missionId, threadId: mt?.threadId ?? ct.id, content: message, target: tgt }); }
      } else if (selectedChannel?.threadId) {
        const th = threads.find((t) => t.id === selectedChannel.threadId);
        let tgt: OrchestratorChatTarget;
        if (th?.threadType === "worker") tgt = { kind: "worker", runId: th.runId ?? runId ?? null, stepId: th.stepId ?? null, stepKey: th.stepKey ?? null, attemptId: th.attemptId ?? null, sessionId: th.sessionId ?? null, laneId: th.laneId ?? null };
        else if (th?.threadType === "teammate") tgt = { kind: "teammate", runId: th.runId ?? runId ?? null, teamMemberId: (th as OrchestratorChatThread & { teamMemberId?: string }).teamMemberId ?? null };
        else tgt = { kind: "coordinator", runId: runId ?? null };
        await window.ade.orchestrator.sendThreadMessage({ missionId, threadId: selectedChannel.threadId, content: message, target: tgt });
      }
      setInput("");
      await Promise.all([refreshThreads(), refreshGlobalMessages()]);
      if (selectedChannel?.threadId) await refreshThreadMessages(selectedChannel.threadId);
    } catch (err) { console.error("[MissionChatV2] handleSend failed:", err); } finally { setSending(false); }
  }, [chatBlocked, mentionTargetMap, sending, selectedChannel, threads, missionId, runId, refreshThreads, refreshGlobalMessages, refreshThreadMessages]);

  const handleApproval = useCallback(async (sessionId: string, itemId: string, decision: "accept" | "accept_for_session" | "decline" | "cancel", responseText?: string | null) => {
    try { await window.ade.agentChat.approve({ sessionId, itemId, decision, responseText }); setJumpNotice(null); await Promise.all([refreshThreads(), refreshGlobalMessages()]); if (selectedChannel?.threadId) await refreshThreadMessages(selectedChannel.threadId); } catch (error) { setJumpNotice(error instanceof Error ? error.message : String(error)); }
  }, [refreshGlobalMessages, refreshThreadMessages, refreshThreads, selectedChannel]);

  return (
    <div className="flex h-full min-h-0">
      <ChatChannelList
        channels={channels}
        orchestratorChannel={orchestratorChannel}
        teammateChannels={teammateChannels}
        activeWorkerChannels={activeWorkerChannels}
        completedWorkerChannels={completedWorkerChannels}
        selectedChannelId={selectedChannelId}
        completedCollapsed={completedCollapsed}
        globalViewMode={globalViewMode}
        workerStatusDot={workerStatusDotFn}
        onSelectChannel={setSelectedChannelId}
        onToggleCompletedCollapsed={() => setCompletedCollapsed((p) => !p)}
        onSetGlobalViewMode={setGlobalViewMode}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: BG_PAGE }}>
        <ChatMessageArea
          selectedChannel={selectedChannel}
          workerStatusDot={workerStatusDotFn}
          displayMessages={displayMessages}
          attemptNameMap={attemptNameMap}
          jumpNotice={jumpNotice}
          chatNotice={chatNotice}
          chatBlocked={chatBlocked}
          threadIntervention={threadIntervention}
          onOpenIntervention={onOpenIntervention}
          showStreamingIndicator={showStreaming}
          missionNarrative={selectedChannel?.kind === "global" ? missionNarrative : null}
          runtimeSummary={runtimeSummary}
          agentRuntimeConfig={agentRuntimeConfig}
          onApproval={handleApproval}
        />
        <ChatInput
          selectedChannel={selectedChannel}
          input={input}
          sending={sending}
          chatBlocked={Boolean(chatBlocked)}
          participants={participants}
          quickTargets={quickTargets}
          onInputChange={setInput}
          onSend={handleSend}
          onAppendMentionTarget={appendMentionTarget}
        />
      </div>
    </div>
  );
});
