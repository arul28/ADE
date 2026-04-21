import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  inferAttachmentType,
  mergeAttachments,
  type AgentChatFileRef,
  type MissionAgentRuntimeConfig,
  type MissionIntervention,
  type OrchestratorChatThread,
  type OrchestratorChatMessage,
  type OrchestratorMetadata,
  type OrchestratorTeamRuntimeState,
  type OrchestratorWorkerState,
  type OrchestratorChatTarget,
  type MissionStatus,
  type MissionRunView,
  type OrchestratorRunStatus,
  type TeamRuntimeConfig,
} from "../../../shared/types";
import type { MentionParticipant } from "../shared/MentionInput";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { useMissionPolling } from "./useMissionPolling";
import { formatMissionWorkerPresentation } from "./missionHelpers";
import { buildMissionStateNarrative, prepareMissionFeedItems } from "./missionFeedPresentation";
import {
  readRecord,
  statusDotForWorker,
} from "./chatFilters";
import { ChatChannelList, type Channel } from "./ChatChannelList";
import { ChatMessageArea } from "./ChatMessageArea";
import { ChatInput, type QuickTarget } from "./ChatInput";
import { ChatSurfaceShell } from "../chat/ChatSurfaceShell";
import { useMissionsStore } from "./useMissionsStore";

const BG_PAGE = COLORS.pageBg;
const THREAD_MESSAGE_PAGE_SIZE = 100;

function threadStatusLabel(loading: boolean, error: string | null, hasMore: boolean): string {
  if (loading) return "Loading thread messages...";
  if (error) return error;
  if (hasMore) return "Older messages are available.";
  return "Showing the full hydrated thread.";
}

function resolveMissionPhaseAccent(phaseLabel: string | null): string {
  const normalized = (phaseLabel ?? "").trim().toLowerCase();
  if (!normalized.length) return "#38BDF8";
  if (/(plan|discover|research|scop|shape|intake)/.test(normalized)) return "#38BDF8";
  if (/(build|implement|craft|develop|ship)/.test(normalized)) return "#A78BFA";
  if (/(validat|test|qa|review|check)/.test(normalized)) return "#F59E0B";
  if (/(merge|release|launch|handoff|finish|done)/.test(normalized)) return "#22C55E";
  return "#38BDF8";
}

function resolveMissionSurfaceAccent(channel: Channel | undefined): string {
  switch (channel?.kind) {
    case "global":
      return "#22C55E";
    case "orchestrator":
      return "#60A5FA";
    case "teammate":
      return "#06B6D4";
    case "worker":
      return resolveMissionPhaseAccent(channel.phaseLabel);
    default:
      return "#38BDF8";
  }
}

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
  const [threadMessages, setThreadMessages] = useState<OrchestratorChatMessage[]>([]);
  const [threadMessagesLoading, setThreadMessagesLoading] = useState(false);
  const [threadMessagesLoadingMore, setThreadMessagesLoadingMore] = useState(false);
  const [threadMessagesError, setThreadMessagesError] = useState<string | null>(null);
  const [threadMessagesHasMore, setThreadMessagesHasMore] = useState(false);
  const [workerStates, setWorkerStates] = useState<OrchestratorWorkerState[]>([]);
  const [teamRuntimeState, setTeamRuntimeState] = useState<OrchestratorTeamRuntimeState | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState("global");
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AgentChatFileRef[]>([]);
  const [sending, setSending] = useState(false);
  const [runActionBusy, setRunActionBusy] = useState<"pause" | "resume" | "cancel" | null>(null);
  const [completedCollapsed, setCompletedCollapsed] = useState(true);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);

  const selectedChannelIdRef = useRef("global");
  const threadRefreshTimerRef = useRef<number | null>(null);
  const messageRefreshTimerRef = useRef<number | null>(null);
  const channelsRef = useRef<Channel[]>([]);
  const latestThreadMessagesRequestRef = useRef(0);

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
  const missionSurfaceMode = selectedChannel?.kind === "global" ? "mission-feed" : "mission-thread";
  const missionSurfaceAccent = useMemo(() => resolveMissionSurfaceAccent(selectedChannel), [selectedChannel]);

  const participants = useMemo<MentionParticipant[]>(() => [], []);
  const quickTargets = useMemo<QuickTarget[]>(() => [], []);

  useEffect(() => { channelsRef.current = channels; }, [channels]);

  const workerStateByAttempt = useMemo(() => { const m = new Map<string, OrchestratorWorkerState>(); for (const s of workerStates) m.set(s.attemptId, s); return m; }, [workerStates]);
  const workerStatusDotFn = useCallback((attemptId: string | null) => attemptId ? statusDotForWorker(workerStateByAttempt.get(attemptId)?.state) : COLORS.success, [workerStateByAttempt]);

  // ── Data fetching ──
  const refreshThreads = useCallback(async () => { try { setThreads(await window.ade.orchestrator.listChatThreads({ missionId, includeClosed: true })); } catch { /* ignore */ } }, [missionId]);
  const refreshThreadMessages = useCallback(async (
    threadId?: string | null,
    mode: "replace" | "append-older" = "replace",
  ) => {
    if (!threadId) {
      setThreadMessages([]);
      setThreadMessagesError(null);
      setThreadMessagesHasMore(false);
      setThreadMessagesLoading(false);
      setThreadMessagesLoadingMore(false);
      return;
    }
    const requestId = latestThreadMessagesRequestRef.current + 1;
    latestThreadMessagesRequestRef.current = requestId;
    const before = mode === "append-older" ? threadMessages[0]?.timestamp ?? null : null;
    if (mode === "replace") {
      setThreadMessagesLoading(true);
      setThreadMessagesError(null);
    } else {
      setThreadMessagesLoadingMore(true);
    }
    try {
      const nextMessages = await window.ade.orchestrator.getThreadMessages({
        missionId,
        threadId,
        limit: THREAD_MESSAGE_PAGE_SIZE,
        before,
      });
      if (latestThreadMessagesRequestRef.current !== requestId) return;
      setThreadMessages((current) => {
        if (mode === "append-older") {
          const seen = new Set(current.map((entry) => entry.id));
          return [...nextMessages.filter((entry) => !seen.has(entry.id)), ...current];
        }
        return nextMessages;
      });
      setThreadMessagesHasMore(nextMessages.length >= THREAD_MESSAGE_PAGE_SIZE);
    } catch (error) {
      if (latestThreadMessagesRequestRef.current !== requestId) return;
      setThreadMessagesError(error instanceof Error ? error.message : String(error));
    } finally {
      if (latestThreadMessagesRequestRef.current === requestId) {
        setThreadMessagesLoading(false);
        setThreadMessagesLoadingMore(false);
      }
    }
  }, [missionId, threadMessages]);
  const refreshWorkers = useCallback(async () => {
    try {
      const [st, rt] = await Promise.all([
        runId ? window.ade.orchestrator.getWorkerStates({ runId }) : Promise.resolve([] as OrchestratorWorkerState[]),
        runId ? window.ade.orchestrator.getTeamRuntimeState({ runId }).catch(() => null) : Promise.resolve(null),
      ]);
      setWorkerStates(st);
      setTeamRuntimeState(rt);
    } catch {
      /* ignore */
    }
  }, [runId]);
  const refreshSelectedMessages = useCallback(async () => {
    if (!selectedChannel) return;
    if (selectedChannel.kind === "global") return;
    await refreshThreadMessages(selectedChannel.threadId);
  }, [refreshThreadMessages, selectedChannel]);

  const loadOlderSelectedMessages = useCallback(() => {
    if (!selectedChannel || selectedChannel.kind === "global" || !threadMessagesHasMore || threadMessagesLoadingMore) return;
    void refreshThreadMessages(selectedChannel.threadId, "append-older");
  }, [refreshThreadMessages, selectedChannel, threadMessagesHasMore, threadMessagesLoadingMore]);

  useEffect(() => {
    latestThreadMessagesRequestRef.current += 1;
    setThreads([]);
    setThreadMessages([]);
    setThreadMessagesError(null);
    setThreadMessagesHasMore(false);
    setThreadMessagesLoading(false);
    setThreadMessagesLoadingMore(false);
    setWorkerStates([]);
    setTeamRuntimeState(null);
    setSelectedChannelId("global");
    setInput("");
    setAttachments([]);
    setSending(false);
    setRunActionBusy(null);
    setCompletedCollapsed(true);
    setJumpNotice(null);
  }, [missionId]);

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
    Boolean(selectedChannel && selectedChannel.kind !== "global"),
  );

  // ── Real-time events ──
  const refreshThreadsRef = useRef(refreshThreads);
  const refreshThreadMessagesRef = useRef(refreshThreadMessages);
  useEffect(() => { refreshThreadsRef.current = refreshThreads; }, [refreshThreads]);
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
          if (cur === "global") return;
          const ch = channelsRef.current.find((c) => c.id === cur);
          if (ch?.threadId && (!event.threadId || event.threadId === ch.threadId)) {
            void refreshThreadMessagesRef.current(ch.threadId);
          }
        }, 100);
      }
    });
    return () => { unsub(); if (threadRefreshTimerRef.current !== null) window.clearTimeout(threadRefreshTimerRef.current); if (messageRefreshTimerRef.current !== null) window.clearTimeout(messageRefreshTimerRef.current); };
  }, [missionId]);

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
      return prepareMissionFeedItems(runView?.progressLog ?? []).map((item) => ({
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
          progressAudience: item.audience ?? "mission_feed",
          progressSource: item.source ?? "mission",
        },
      } satisfies OrchestratorChatMessage));
    }
    return threadMessages;
  }, [selectedChannel, threadMessages, missionId, runId, runView]);

  const attemptNameMap = useMemo(() => { const m = new Map<string, string>(); for (const t of threads) if (t.attemptId) m.set(t.attemptId, t.title || (t.threadType === "coordinator" ? "Orchestrator" : "Worker")); return m; }, [threads]);
  const threadIntervention = useMemo(
    () => findThreadIntervention({ interventions, selectedChannel, runId }),
    [interventions, runId, selectedChannel],
  );

  const chatNotice = useMemo(() => {
    if (runStatus === "paused") {
      return {
        reason: "Run is paused.",
        action: selectedChannel?.kind === "global"
          ? "Open the orchestrator or an active worker thread if you want to send a recovery note before resuming."
          : "You can still message the coordinator or an active worker here while you decide whether to resume.",
      };
    }
    if (missionStatus === "intervention_required") {
      return {
        reason: "Mission is waiting on an intervention.",
        action: selectedChannel?.kind === "global"
          ? "Open the orchestrator or an active worker thread if you want to send a recovery note while you decide what to do."
          : "You can still message the coordinator or an active worker here while you decide how to recover.",
      };
    }
    return null;
  }, [missionStatus, runStatus, selectedChannel?.kind]);

  const chatBlocked = useMemo(() => {
    if (missionStatus === "completed" || missionStatus === "failed" || missionStatus === "canceled") return { reason: "Mission run is closed.", action: "Start or rerun the mission to continue chat." };
    if (!runId || !runStatus) return { reason: "Orchestrator runtime is offline.", action: "Start the mission run to send directives." };
    if (runStatus === "queued" || runStatus === "bootstrapping") return { reason: "Orchestrator runtime is starting.", action: "Wait for readiness, then send directives." };
    if (selectedChannel?.kind === "orchestrator" && (selectedChannel.status !== "active" || runView?.coordinator.available === false)) {
      return { reason: "The orchestrator is offline.", action: "Review the thread history, resolve the recovery action, and resume once coordinator health is restored." };
    }
    if (selectedChannel?.kind === "worker") { const ws = selectedChannel.attemptId ? workerStateByAttempt.get(selectedChannel.attemptId)?.state : undefined; if (selectedChannel.status !== "active" || ws === "completed" || ws === "failed" || ws === "disposed") return { reason: "This worker is no longer running.", action: "Read the thread for history, or message the orchestrator to redirect the mission." }; }
    if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "canceled") return { reason: "Run is in a terminal state.", action: "Start a new run to continue chat." };
    return null;
  }, [missionStatus, runId, runStatus, runView?.coordinator.available, selectedChannel, workerStateByAttempt]);

  const showStreaming = useMemo(() => { if (selectedChannel?.kind !== "worker" || !selectedChannel.attemptId) return false; const s = workerStateByAttempt.get(selectedChannel.attemptId)?.state; return s === "initializing" || s === "working"; }, [selectedChannel, workerStateByAttempt]);

  // ── Runtime config ──
  const teamRuntimeConfig = useMemo(() => { const md = readRecord(runMetadata); const rt = readRecord(md?.teamRuntime); if (!rt) return null; return { enabled: rt.enabled === true, targetProvider: rt.targetProvider === "claude" || rt.targetProvider === "codex" ? rt.targetProvider : "auto", teammateCount: Number.isFinite(Number(rt.teammateCount)) ? Math.max(0, Math.floor(Number(rt.teammateCount))) : 0, allowParallelAgents: rt.allowParallelAgents !== false, allowSubAgents: rt.allowSubAgents !== false, allowClaudeAgentTeams: rt.allowClaudeAgentTeams !== false } satisfies TeamRuntimeConfig; }, [runMetadata]);

  const agentRuntimeConfig = useMemo(() => { const md = readRecord(runMetadata); const rt = readRecord(md?.agentRuntime); if (!rt && !teamRuntimeConfig) return null; return { allowParallelAgents: typeof rt?.allowParallelAgents === "boolean" ? rt.allowParallelAgents : teamRuntimeConfig?.allowParallelAgents !== false, allowSubAgents: typeof rt?.allowSubAgents === "boolean" ? rt.allowSubAgents : teamRuntimeConfig?.allowSubAgents !== false, allowClaudeAgentTeams: typeof rt?.allowClaudeAgentTeams === "boolean" ? rt.allowClaudeAgentTeams : teamRuntimeConfig?.allowClaudeAgentTeams !== false } satisfies MissionAgentRuntimeConfig; }, [runMetadata, teamRuntimeConfig]);

  const removeAttachment = useCallback((attachmentPath: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.path !== attachmentPath));
  }, []);
  const pickAttachments = useCallback(async () => {
    try {
      const paths = await (window as any).ade?.dialog?.openFile?.({
        multiple: true,
        title: "Attach files to mission chat",
      });
      if (!Array.isArray(paths) || !paths.length) return;
      setAttachments((current) => mergeAttachments(
        current,
        paths
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((path) => ({ path, type: inferAttachmentType(path) })),
      ));
    } catch {
      // Dialog canceled or unavailable.
    }
  }, []);

  const runtimeSummary = useMemo(() => {
    if (selectedChannel?.kind === "global") {
      return {
        title: "Mission feed",
        detail: "Readable status updates from the orchestrator, workers, and recovery flow.",
      };
    }
    if (teamRuntimeConfig?.enabled) {
      const c = teamRuntimeState?.teammateIds.length ?? teamRuntimeConfig.teammateCount ?? 0;
      return {
        title: "Team runtime",
        detail: `${teamRuntimeState?.phase ?? "bootstrapping"} · ${c} teammate${c === 1 ? "" : "s"} · ${teamRuntimeConfig.targetProvider === "auto" ? "auto" : teamRuntimeConfig.targetProvider}`,
      };
    }
    if (agentRuntimeConfig) {
      return { title: "Coordinator chat", detail: "Direct conversation with the orchestrator runtime." };
    }
    return null;
  }, [agentRuntimeConfig, selectedChannel?.kind, teamRuntimeConfig, teamRuntimeState]);
  const missionNarrative = useMemo(() => buildMissionStateNarrative(runView), [runView]);

  // ── Send message ──
  const handleSend = useCallback(async (message: string) => {
    if (sending || !message.trim() || chatBlocked) return;
    const attachmentsSnapshot = attachments;
    setSending(true);
    try {
      if (selectedChannel?.threadId) {
        const th = threads.find((t) => t.id === selectedChannel.threadId);
        let tgt: OrchestratorChatTarget;
        if (th?.threadType === "worker") tgt = { kind: "worker", runId: th.runId ?? runId ?? null, stepId: th.stepId ?? null, stepKey: th.stepKey ?? null, attemptId: th.attemptId ?? null, sessionId: th.sessionId ?? null, laneId: th.laneId ?? null };
        else if (th?.threadType === "teammate") tgt = { kind: "teammate", runId: th.runId ?? runId ?? null, teamMemberId: (th as OrchestratorChatThread & { teamMemberId?: string }).teamMemberId ?? null };
        else tgt = { kind: "coordinator", runId: runId ?? null };
        await window.ade.orchestrator.sendThreadMessage({ missionId, threadId: selectedChannel.threadId, content: message, attachments: attachmentsSnapshot, target: tgt });
      }
      setInput("");
      setAttachments([]);
      await refreshThreads();
      if (selectedChannel?.threadId) await refreshThreadMessages(selectedChannel.threadId);
    } catch (err) { console.error("[MissionChatV2] handleSend failed:", err); } finally { setSending(false); }
  }, [attachments, chatBlocked, sending, selectedChannel, threads, missionId, runId, refreshThreads, refreshThreadMessages]);

  const handleApproval = useCallback(async (
    sessionId: string,
    itemId: string,
    decision: "accept" | "accept_for_session" | "decline" | "cancel",
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ) => {
    try {
      await window.ade.agentChat.respondToInput({ sessionId, itemId, decision, responseText, answers });
      setJumpNotice(null);
      await refreshThreads();
      if (selectedChannel?.threadId) await refreshThreadMessages(selectedChannel.threadId);
    } catch (error) {
      setJumpNotice(error instanceof Error ? error.message : String(error));
    }
  }, [refreshThreadMessages, refreshThreads, selectedChannel]);

  const refreshMissionWorkspace = useCallback(async () => {
    const store = useMissionsStore.getState();
    await store.refreshMissionList({ preserveSelection: true, silent: true });
    await store.loadMissionDetail(missionId);
    await store.loadOrchestratorGraph(missionId);
  }, [missionId]);

  const handleRunControl = useCallback(async (action: "pause" | "resume" | "cancel") => {
    if (!runId || runActionBusy) return;
    setRunActionBusy(action);
    setJumpNotice(null);
    try {
      if (action === "pause") {
        await window.ade.orchestrator.pauseRun({ runId, reason: "Paused from mission chat." });
      } else if (action === "resume") {
        await window.ade.orchestrator.resumeRun({ runId });
      } else {
        await window.ade.orchestrator.cancelRun({ runId, reason: "Canceled from mission chat." });
      }
      await Promise.all([
        refreshMissionWorkspace(),
        refreshThreads(),
        refreshWorkers(),
        refreshSelectedMessages(),
      ]);
    } catch (error) {
      setJumpNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRunActionBusy(null);
    }
  }, [refreshMissionWorkspace, refreshSelectedMessages, refreshThreads, refreshWorkers, runActionBusy, runId]);

  const runControls = useMemo(() => {
    if (!runId || !runStatus) return null;
    if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "canceled") return null;

    const buttons: Array<{ id: "pause" | "resume" | "cancel"; label: string; tone: "accent" | "danger" }> = [];
    if (runStatus === "paused") {
      buttons.push({ id: "resume", label: "Resume run", tone: "accent" });
    } else {
      buttons.push({ id: "pause", label: "Pause run", tone: "accent" });
    }
    buttons.push({ id: "cancel", label: "Cancel run", tone: "danger" });

    return (
      <>
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em]"
          style={{
            background: "color-mix(in srgb, var(--chat-accent) 10%, transparent)",
            color: COLORS.textSecondary,
            border: "1px solid color-mix(in srgb, var(--chat-accent) 16%, rgba(255,255,255,0.08))",
            fontFamily: MONO_FONT,
          }}
        >
          Run {runStatus.replace(/_/g, " ")}
        </span>
        {buttons.map((button) => {
          const accentColor = button.tone === "danger" ? COLORS.danger : COLORS.accent;
          const isBusy = runActionBusy === button.id;
          return (
            <button
              key={button.id}
              type="button"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] transition-opacity hover:opacity-90 disabled:opacity-55"
              style={{
                background: `${accentColor}14`,
                color: accentColor,
                border: `1px solid ${accentColor}30`,
                fontFamily: MONO_FONT,
              }}
              onClick={() => void handleRunControl(button.id)}
              disabled={runActionBusy != null}
            >
              {isBusy ? "Working..." : button.label}
            </button>
          );
        })}
      </>
    );
  }, [handleRunControl, runActionBusy, runId, runStatus]);

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
        workerStatusDot={workerStatusDotFn}
        onSelectChannel={setSelectedChannelId}
        onToggleCompletedCollapsed={() => setCompletedCollapsed((p) => !p)}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: BG_PAGE }}>
        <ChatSurfaceShell
          mode={missionSurfaceMode}
          accentColor={missionSurfaceAccent}
          className="m-2 rounded-[var(--chat-radius-shell)]"
          bodyClassName="flex min-h-0 flex-1 flex-col"
          footer={(
            selectedChannel?.kind === "global" ? (
              <div
                className="px-4 py-3 text-[11px]"
                style={{
                  borderTop: `1px solid rgba(255,255,255,0.08)`,
                  background: "linear-gradient(180deg, rgba(20,16,29,0.96) 0%, rgba(13,10,20,0.92) 100%)",
                  color: COLORS.textSecondary,
                  fontFamily: MONO_FONT,
                }}
              >
                Mission feed is read-only. Open the orchestrator or a worker thread to send a message.
              </div>
            ) : (
              <ChatInput
                selectedChannel={selectedChannel}
                input={input}
                attachments={attachments}
                sending={sending}
                chatBlocked={Boolean(chatBlocked)}
                participants={participants}
                quickTargets={quickTargets}
                onInputChange={setInput}
                onSend={(message) => handleSend(message)}
                onAppendMentionTarget={() => undefined}
                onPickAttachments={pickAttachments}
                onRemoveAttachment={removeAttachment}
              />
            )
          )}
        >
          <>
            {selectedChannel?.kind !== "global" ? (
              <div
                className="flex items-center justify-between gap-3 px-4 py-2 text-[11px]"
                style={{
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  background: "rgba(20,16,29,0.68)",
                  color: COLORS.textSecondary,
                  fontFamily: MONO_FONT,
                }}
              >
                <div>
                  {threadStatusLabel(threadMessagesLoading, threadMessagesError, threadMessagesHasMore)}
                </div>
                <div className="flex items-center gap-2">
                  {threadMessagesError ? (
                    <button
                      type="button"
                      className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]"
                      style={{ border: `1px solid ${COLORS.accent}30`, color: COLORS.accent }}
                      onClick={() => void refreshSelectedMessages()}
                    >
                      Retry
                    </button>
                  ) : null}
                  {threadMessagesHasMore ? (
                    <button
                      type="button"
                      className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] disabled:opacity-55"
                      style={{ border: `1px solid ${COLORS.accent}30`, color: COLORS.accent }}
                      onClick={loadOlderSelectedMessages}
                      disabled={threadMessagesLoadingMore}
                      aria-label={threadMessagesLoadingMore ? "Loading older mission thread messages" : "Load older mission thread messages"}
                    >
                      {threadMessagesLoadingMore ? "Loading..." : "Load older"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
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
              runControls={runControls}
              onApproval={handleApproval}
            />
          </>
        </ChatSurfaceShell>
      </div>
    </div>
  );
});
